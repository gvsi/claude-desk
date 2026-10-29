"""The public page and the visitor's chat API (Plan 02a, Task 7): the kernel's public Desk passed through, the Agent
Card from `PUBLIC_ORIGIN`, sessions held only by the Desk-scoped cookie, messages that start turns, a replayable
event stream, control rows handled with the visitor's own credential, the message limit, cancelling a hold and the
session work stopping with the process.

The app runs on FakeKernel and a scripted model. An event stream is run the way a browser runs it (`Stream`): its
ASGI response in a task, until the test hangs up, since httpx's in-process transport waits for a whole body.
"""

import asyncio
import dataclasses
import hashlib
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from pydantic import TypeAdapter
from sqlalchemy import text
from sse_starlette import EventSourceResponse

from desk.api import runner as runner_module
from desk.api.main import create_app
from desk.api.ratelimit import LIMITS, Limit, StreamSlots
from desk.api.routes.public import _released
from desk.api.sse import append_control, emit
from desk.api.store import Ids, append_message
from desk.contracts import ToolCall
from desk.events import EvError, EvTurnEnd, EvWriting, SseEvent
from desk.kernel_api import CreateCopyRequest, DecideRequest, ExecuteRequest, PublicDesk
from tests.api.conftest import CLIENT_IP, PASSCODE
from tests.api.fakes import ScriptedModel, gated, response, tool_use
from tests.api.fakes import text as text_block
from tests.kernel_contract.fake_kernel import fake_kernel_app

EVENT = TypeAdapter(SseEvent)
CREDENTIALS = {"x-session-token", "x-owner-session"}


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    """The API on FakeKernel and the scripted model, its lifespan running."""
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


def slug_of(fake) -> str:
    """The slug of the first Desk FakeKernel made."""
    return next(iter(fake.desks.values())).slug


async def new_slug(kernel_http, fake) -> str:
    """A fresh Rivera copy's Desk slug, made straight on the kernel."""

    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    return fake.desks[copy.desk_ids[0]].slug


# Event streams ---------------------------------------------------------------------------------------------


@dataclass
class Frame:
    event: str | None = None
    id: str | None = None
    data: str | None = None
    comment: str | None = None


def parse_frames(text: str) -> list[Frame]:
    frames = []
    for chunk in text.replace("\r\n", "\n").split("\n\n"):
        if not chunk.strip():
            continue
        frame = Frame()
        for line in chunk.split("\n"):
            name, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if name == "":
                frame.comment = value
            elif name in ("event", "id", "data"):
                setattr(frame, name, value)
        frames.append(frame)
    return frames


@dataclass
class Stream:
    """A request to the app run as a browser runs an event stream: in a task, until `close()` hangs up."""

    app: FastAPI
    path: str
    headers: list[tuple[str, str]] = field(default_factory=list)
    ip: str = CLIENT_IP
    status: int | None = None
    response_headers: list[tuple[str, str]] = field(default_factory=list)
    body: str = ""
    _started: asyncio.Event = field(default_factory=asyncio.Event)
    _changed: asyncio.Event = field(default_factory=asyncio.Event)
    _hung_up: asyncio.Event = field(default_factory=asyncio.Event)
    _task: asyncio.Task | None = None

    async def open(self) -> "Stream":
        path, _, query = self.path.partition("?")
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
                 "scheme": "https", "path": path, "raw_path": path.encode(), "query_string": query.encode(),
                 "root_path": "", "server": ("desk.test", 443), "client": (self.ip, 50000),
                 "headers": [(b"host", b"desk.test"), *((name.lower().encode(), value.encode())
                                                         for name, value in self.headers)]}
        sent_request = False

        async def receive() -> dict:
            nonlocal sent_request
            if not sent_request:
                sent_request = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await self._hung_up.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.start":
                self.status = message["status"]
                self.response_headers = [(name.decode(), value.decode()) for name, value in message["headers"]]
                self._started.set()
            elif message["type"] == "http.response.body":
                self.body += message.get("body", b"").decode()
                self._changed.set()

        self._task = asyncio.create_task(self.app(scope, receive, send))
        await asyncio.wait_for(self._started.wait(), 5)
        return self

    @property
    def frames(self) -> list[Frame]:
        return parse_frames(self.body)

    @property
    def events(self) -> list[tuple[int, object]]:
        """The stream's events so far, as (SSE id, event)."""
        return [(int(frame.id), EVENT.validate_json(frame.data)) for frame in self.frames if frame.data is not None]

    def json(self) -> dict:
        return json.loads(self.body)

    async def until(self, done: Callable[[list[tuple[int, object]]], bool], timeout: float = 10.0) -> list:
        """Wait until `done(events)` holds; returns the events."""
        async def wait() -> None:
            while not done(self.events):
                self._changed.clear()
                if done(self.events):
                    return
                await self._changed.wait()

        await asyncio.wait_for(wait(), timeout)
        return self.events

    async def close(self) -> None:
        self._hung_up.set()
        if self._task is not None:
            await asyncio.wait_for(self._task, 5)

    async def __aenter__(self) -> "Stream":
        return await self.open()

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()


def types(events: list[tuple[int, object]]) -> list[str]:
    return [event.type for _, event in events]


# The public Desk and the Agent Card -------------------------------------------------------------------------


async def test_public_desk_passes_the_kernels_fields_through(app, browser, fake, kernel_http, visitor):
    slug = visitor.slug
    expected = await kernel_http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug},
                                               query={"lang": "es"})
    fake.calls.clear()

    client = browser(app)
    client.cookies.set("desk_visitor", visitor.token, domain="desk.test", path="/api/public")
    client.cookies.set("desk_owner", visitor.token, domain="desk.test", path="/api/public")
    response = await client.get(f"/api/public/{slug}", params={"lang": "es"})

    assert response.status_code == 200
    assert PublicDesk.model_validate(response.json()) == expected
    assert response.json() == expected.model_dump(mode="json")                    # unchanged, field for field
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    (call,) = fake.calls                                                            # no cookie read: one public call
    assert call.route == "GET /public/{desk_slug}" and call.query == {"lang": "es"}
    assert not CREDENTIALS & set(call.headers)


async def test_agent_card_uses_the_public_origin(fake, browser, api_settings, clock, visitor):
    settings = dataclasses.replace(api_settings, public_origin="https://desk.example.com")
    app = create_app(settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), clock=clock,
                     jobs_connector=InMemoryConnector())
    slug = visitor.slug
    fake.calls.clear()
    async with app.router.lifespan_context(app):
        forged = {"host": "evil.example", "x-forwarded-host": "evil.example", "x-desk-public-host": "evil.example",
                  "x-forwarded-proto": "http", "forwarded": "host=evil.example;proto=http"}
        response = await browser(app).get(f"/api/public/desks/{slug}/agent_card", headers=forged)

    assert response.status_code == 200
    card = response.json()
    endpoint = f"https://desk.example.com/api/a2a/{slug}"
    assert card["endpoint"] == endpoint                                   # PUBLIC_ORIGIN, whatever the request says
    assert card["signing"] == {
        "headers": ["X-Agent-Key-Id", "X-Agent-Ts", "X-Agent-Nonce", "X-Agent-Sig"],
        "payload_fields": ["desk_slug", "ts", "nonce", "body_sha256"], "canonical": "RFC 8785",
        "algorithm": "Ed25519", "encoding": "lowercase hex", "ts_window_s": 300}
    example = card["example_request"]
    assert example.startswith(f"POST {endpoint}\n")
    assert all(f"\n{header}: " in example for header in card["signing"]["headers"])
    body = json.loads(example.split("\n\n", 1)[1])
    assert body["desk_slug"] == slug and body["session_id"] is None
    assert "evil" not in response.text
    assert "set-cookie" not in response.headers
    assert [set(call.headers) & CREDENTIALS for call in fake.calls] == [set()]   # the slug is checked, no credential


# Sessions ------------------------------------------------------------------------------------------------------


def visitor_cookie(response: httpx.Response) -> tuple[str, list[str]]:
    """The one cookie a response sets: the visitor token and the cookie's attributes."""
    (header,) = response.headers.get_list("set-cookie")
    name_value, *attributes = [part.strip() for part in header.split(";")]
    name, _, token = name_value.partition("=")
    assert name == "desk_visitor"
    return token, sorted(attributes)


def session_of(fake, token: str) -> str:
    """The visitor session `token` names in FakeKernel."""
    return fake._token_hashes[hashlib.sha256(token.encode()).hexdigest()]


async def open_session(app, browser, slug: str, **options) -> tuple[httpx.AsyncClient, str, dict]:
    """A browser with a new visitor session on the slug's Desk: the client, its token and the `VisitorSession`."""
    client = browser(app, **options)
    response = await client.post(f"/api/public/desks/{slug}/sessions")
    assert response.status_code == 200, response.text
    token, _ = visitor_cookie(response)
    return client, token, response.json()


async def test_session_cookie_is_scoped_to_the_desk_path(app, browser, fake, kernel_http):
    slug, other = await new_slug(kernel_http, fake), await new_slug(kernel_http, fake)
    client = browser(app)
    response = await client.post(f"/api/public/desks/{slug}/sessions")

    assert response.status_code == 200
    token, attributes = visitor_cookie(response)
    assert attributes == sorted(["HttpOnly", "Secure", "SameSite=Strict", f"Path=/api/public/desks/{slug}",
                                 "Max-Age=86400"])
    session = fake.sessions[session_of(fake, token)]                     # the kernel's token, alone and unchanged
    assert (session.kind, session.desk_id) == ("visitor", fake.desks[session.desk_id].desk_id)
    assert fake.desks[session.desk_id].slug == slug
    assert response.json() == {"state": session.state().model_dump(mode="json"), "resumed": False}
    assert token not in response.text

    # The browser sends it back to this Desk's routes only, and each answer renews it (the 24-hour idle close).
    read = await client.get(f"/api/public/desks/{slug}/session")
    assert read.status_code == 200
    assert read.request.headers["cookie"] == f"desk_visitor={token}"
    assert visitor_cookie(read) == (token, attributes)
    for path in (f"/api/public/{slug}", f"/api/public/desks/{other}/session", f"/api/public/desks/{slug}x/session",
                 "/api/owner/me", "/api/health"):
        assert "cookie" not in (await client.get(path)).request.headers, path


async def test_returning_visitor_resumes_the_session(app, browser, fake, kernel_http):
    slug, other = await new_slug(kernel_http, fake), await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    desk = fake.desks[fake.sessions[session_id].desk_id]
    fake.calls.clear()

    again = await client.post(f"/api/public/desks/{slug}/sessions")
    assert (again.status_code, again.json()) == (200, {"state": opened["state"], "resumed": True})
    assert visitor_cookie(again)[0] == token                             # the same session, its cookie renewed
    assert fake.called("POST /sessions") == []
    (append,) = fake.called("POST /ledger/append")                      # ledgered with the visitor's own credential
    assert append.headers["x-session-token"] == token and "x-owner-session" not in append.headers
    event = desk.ledger[-1].event
    assert (event.kind, event.origin, event.session_id, event.summary) == ("session", "api", session_id,
                                                                          {"resumed": True})

    # The cookie names a session of another Desk (forged: browsers send it only to its own Desk's paths): a new
    # session here, and the other Desk's is left alone.
    elsewhere = browser(app)
    elsewhere.cookies.set("desk_visitor", token, domain="desk.test", path=f"/api/public/desks/{other}")
    moved = await elsewhere.post(f"/api/public/desks/{other}/sessions")
    assert moved.json()["resumed"] is False and moved.json()["state"]["session_id"] != session_id
    assert visitor_cookie(moved)[0] != token

    # A day idle, and the kernel has closed the session: a new one, and the cookie moves on to it.
    fake.now += timedelta(hours=24, seconds=1)
    fresh = await client.post(f"/api/public/desks/{slug}/sessions")
    assert fresh.status_code == 200 and fresh.json()["resumed"] is False
    new_id, new_token = fresh.json()["state"]["session_id"], visitor_cookie(fresh)[0]
    assert new_id != session_id and session_of(fake, new_token) == new_id
    read = await client.get(f"/api/public/desks/{slug}/session")
    assert read.json()["state"]["session_id"] == new_id


async def test_a_session_the_kernel_closed_clears_its_cookie(app, browser, fake, kernel_http):
    """Once the cookie's session is gone (closed after a day idle, unknown, or another Desk's), a visitor route answers
    401 `no_session` and clears the cookie on its Desk's path, so the browser stops sending a dead token."""
    slug = await new_slug(kernel_http, fake)
    client, token, _ = await open_session(app, browser, slug)
    cleared = ["HttpOnly", "Max-Age=0", f"Path=/api/public/desks/{slug}", "SameSite=Strict", "Secure"]
    fake.now += timedelta(hours=24, seconds=1)                           # the kernel closes it after a day idle

    sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Still there?"})
    assert (sent.status_code, sent.json()) == (401, {"error": "no_session"})
    assert visitor_cookie(sent) == ("", cleared)
    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        pass
    assert (stream.status, stream.json()) == (401, {"error": "no_session"})
    (header,) = [value for name, value in stream.response_headers if name == "set-cookie"]
    name_value, *attributes = [part.strip() for part in header.split(";")]
    assert (name_value, sorted(attributes)) == ("desk_visitor=", cleared)

    # with no cookie there is nothing to clear
    bare = await browser(app).post(f"/api/public/desks/{slug}/messages", json={"text": "Hello?"})
    assert bare.status_code == 401 and "set-cookie" not in bare.headers


# Messages and the event stream -------------------------------------------------------------------------------

HOURS = {"template": "hours", "fact_id": "charter:hours"}


def reply(prose: str, *clauses: dict) -> dict:
    return tool_use("send_reply", {"prose": prose, "clauses": list(clauses)})


def events_path(slug: str, query: str = "") -> str:
    return f"/api/public/desks/{slug}/events" + (f"?{query}" if query else "")


def cookie(token: str) -> tuple[str, str]:
    return ("cookie", f"desk_visitor={token}")


async def rows(engine, session_id: str, kind: str, *columns: str) -> list[tuple]:
    async with engine.connect() as conn:
        found = await conn.execute(text(f"SELECT {', '.join(columns)} FROM app.messages WHERE session_id = :s"
                                        " AND kind = :k ORDER BY n"), {"s": session_id, "k": kind})
        return [tuple(row) for row in found]


def credentials(fake) -> set[tuple[str, str]]:
    """Every credential header the kernel was sent, as (header, value)."""
    return {(name, call.headers[name]) for call in fake.calls for name in CREDENTIALS if name in call.headers}


async def test_message_runs_a_turn_and_streams_it(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    runner = app.state.runtime.runner
    release = asyncio.Event()
    first = gated(response(reply("We're open on weekdays and Saturday mornings.", HOURS)), release)
    model.add(first, response(reply("Happy to help.")))
    fake.calls.clear()

    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        assert stream.status == 200
        assert visitor_cookie(httpx.Response(200, headers=stream.response_headers))[0] == token   # renewed here too
        sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "When are you open?"})
        assert sent.status_code == 202
        await asyncio.wait_for(first.entered.wait(), 5)                # Claude is answering the first message
        # A second message while that turn runs: stored at once, and answered by the same session's task after it.
        again = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Thanks, that's all."})
        assert again.status_code == 202 and runner.running(session_id)
        release.set()
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await runner.drain()

    assert types(events) == ["writing", "message", "turn_end", "writing", "message", "turn_end"]
    assert [seq for seq, _ in events] == [1, 2, 3, 4, 5, 6]               # the SSE id is the event's seq
    hours, thanks = events[1][1], events[4][1]
    assert (hours.author, hours.handoff, [block.template for block in hours.blocks]) == ("claude", False,
                                                                                         [None, "hours"])
    assert thanks.blocks[0].text == "Happy to help."
    assert [(message_id,) for message_id in (sent.json()["message_id"], again.json()["message_id"])] == await rows(
        engine, session_id, "visitor_text", "message_id")
    assert "<visitor_message>When are you open?</visitor_message>" in json.dumps(model.requests[0].messages)
    assert "Thanks, that's all." not in json.dumps(model.requests[0].messages)
    assert "Thanks, that's all." in json.dumps(model.requests[1].messages)
    # Every kernel call, the turns' included, carried the visitor's token and nothing else.
    assert credentials(fake) == {("x-session-token", token)}


def ids_of(fake, session_id: str) -> Ids:
    session = fake.sessions[session_id]
    return Ids(copy_id=session.copy_id, desk_id=session.desk_id, session_id=session_id)


DISCOUNTED_QUOTE = {"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500}


async def test_visitor_transcript_shows_only_delivered_items_and_own_text(app, browser, fake, kernel_http, model,
                                                                         engine, db):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    _, _, other = await open_session(app, browser, slug)
    # Claude's response: text beside its calls (kept only in the model's history), a held quote and a reply.
    model.add(response(text_block("That comes to $89 before the discount."),
                       tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Maria.")))
    sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Can I get 15% off a drain?"})
    assert sent.status_code == 202
    await app.state.runtime.runner.drain()

    ids = ids_of(fake, session_id)
    async with engine.begin() as conn:
        await append_message(conn, ids, "whisper", text="Whisper: offer the deposit credit.")
        await append_message(conn, ids, "note", text="A note only Claude reads.")
        await append_message(conn, ids, "triage", text="Triage: a price question.", ref_id=sent.json()["message_id"])
        await append_message(conn, ids_of(fake, other["state"]["session_id"]), "visitor_text",
                             text="Another visitor's private words.")
    db.execute("UPDATE app.messages SET owner_translation = 'Translated for the owner.' WHERE session_id = %s"
               " AND kind = 'visitor_text'", (session_id,))

    read = await client.get(f"/api/public/desks/{slug}/session")
    assert read.status_code == 200
    body = read.json()
    assert body["state"] == opened["state"]
    assert [(item["kind"], item["text"]) for item in body["items"]] == [
        ("visitor_text", "Can I get 15% off a drain?"), ("status", None), ("delivered", None)]
    held, message = body["items"][1]["event"], body["items"][2]["event"]
    assert (held["type"], held["state"]) == ("held", "held")
    assert (message["type"], message["author"], message["blocks"][0]["text"]) == ("message", "claude",
                                                                                 "I've asked Maria.")
    for hidden in ("$89", "Whisper", "A note only Claude reads", "Triage", "Translated for the owner",
                   "Another visitor", "owner_translation", "triage"):
        assert hidden not in read.text, hidden
    async with engine.connect() as conn:
        last = (await conn.execute(text("SELECT max(seq) FROM app.run_events WHERE session_id = :s AND kind = 'sse'"),
                                   {"s": session_id})).scalar_one()
    assert body["last_seq"] == last == 4                                  # writing, held, message, turn_end


async def visitor_routes(app, client: httpx.AsyncClient, slug: str, cookies: str) -> dict[str, tuple[int, dict]]:
    """Each cookie-bound visitor route's answer to `client` (the stream's to the same cookies)."""
    base = f"/api/public/desks/{slug}"
    answers = {}
    for name, (method, path, body) in {
            "session": ("GET", "/session", None), "message": ("POST", "/messages", {"text": "Hello"}),
            "cancel": ("POST", "/decisions/dec-1/cancel", None)}.items():
        response = await client.request(method, base + path, json=body)
        answers[name] = (response.status_code, response.json())
    async with Stream(app, events_path(slug), headers=[("cookie", cookies)]) as stream:
        pass
    answers["events"] = (stream.status, stream.json())
    return answers


async def test_owner_cookie_on_visitor_route_never_reaches_the_kernel(app, browser, fake):
    owner = browser(app)
    created = await owner.post("/api/owner/copies", json={"passcode": PASSCODE})
    owner_token = created.headers["set-cookie"].split(";")[0].partition("=")[2]
    slug = created.json()["desks"][0]["slug"]
    no_session = (401, {"error": "no_session"})
    fake.calls.clear()

    # The owner cookie is scoped to /api/owner, so a browser never sends it here. Forged onto the visitor routes it
    # is never read: nothing reaches the kernel.
    forged = browser(app)
    forged.cookies.set("desk_owner", owner_token, domain="desk.test", path="/api/public")
    answers = await visitor_routes(app, forged, slug, f"desk_owner={owner_token}")
    assert answers == dict.fromkeys(("session", "message", "cancel", "events"), no_session)
    assert fake.calls == []

    # Forged as the visitor cookie, it reaches the kernel only as a session token, which names no visitor session.
    forged.cookies.set("desk_visitor", owner_token, domain="desk.test", path="/api/public")
    cookies = f"desk_owner={owner_token}; desk_visitor={owner_token}"
    assert await visitor_routes(app, forged, slug, cookies) == dict.fromkeys(
        ("session", "message", "cancel", "events"), no_session)
    opened = await forged.post(f"/api/public/desks/{slug}/sessions")        # a new visitor session, not the owner's
    assert opened.status_code == 200 and opened.json()["state"]["kind"] == "visitor"
    assert opened.json()["state"]["session_id"] != fake.copies[created.json()["copy_id"]].owner_session_id

    assert fake.calls and all("x-owner-session" not in call.headers for call in fake.calls)
    assert {call.route for call in fake.calls if owner_token in call.headers.values()} == {"GET /whoami"}


async def hold(fake, kernel_http, token: str, call_id: str) -> str:
    """A held quote in the token's session, decided by the kernel as Claude's call would be; returns its ID."""
    session_id = session_of(fake, token)
    decision = await kernel_http.session(token).call("POST /decide", DecideRequest(
        session_id=session_id, generation=fake.sessions[session_id].generation,
        call=ToolCall(call_id=call_id, tool="native.quote", args=DISCOUNTED_QUOTE)))
    assert decision.state == "held"
    return decision.decision_id


async def test_visitor_reads_use_only_the_whoami_session(app, browser, fake, kernel_http, engine):
    slug = await new_slug(kernel_http, fake)
    a, a_token, a_opened = await open_session(app, browser, slug)
    b, b_token, b_opened = await open_session(app, browser, slug)
    a_id, b_id = a_opened["state"]["session_id"], b_opened["state"]["session_id"]
    b_held = await hold(fake, kernel_http, b_token, "b-quote")
    for session_id in (a_id, b_id):
        fake.set_mode(session_id, "owner")                  # the owner has both chats, so no turn runs
        async with engine.begin() as conn:
            await emit(conn, ids_of(fake, session_id), EvWriting(type="writing"))
    assert (await b.post(f"/api/public/desks/{slug}/messages", json={"text": "B's own words."})).status_code == 202
    fake.calls.clear()

    # A names B's session in the query: whatever it names, A's cookie is what the kernel answers for.
    read = await a.get(f"/api/public/desks/{slug}/session", params={"session_id": b_id})
    assert read.status_code == 200 and read.json()["state"]["session_id"] == a_id
    assert "B's own words" not in read.text
    sent = await a.post(f"/api/public/desks/{slug}/messages", params={"session_id": b_id}, json={"text": "A's words."})
    assert sent.status_code == 202
    assert await rows(engine, a_id, "visitor_text", "text") == [("A's words.",)]
    assert await rows(engine, b_id, "visitor_text", "text") == [("B's own words.",)]
    await app.state.runtime.runner.drain()
    async with Stream(app, events_path(slug, f"session_id={b_id}&after=0"), headers=[cookie(a_token)]) as stream:
        events = await stream.until(lambda events: len(events) >= 1)
    assert [(seq, event.type) for seq, event in events] == [(1, "writing")]    # A's one event; B's is never sent

    # Named in a body, it isn't even accepted; and B's held request is B's to cancel.
    named = await a.post(f"/api/public/desks/{slug}/messages", json={"text": "Hi", "session_id": b_id})
    assert (named.status_code, named.json()) == (422, {"error": "invalid"})
    cancel = await a.post(f"/api/public/desks/{slug}/decisions/{b_held}/cancel", json={"session_id": b_id})
    assert (cancel.status_code, cancel.json()) == (404, {"error": "kernel", "code": "not_found"})
    assert fake.decisions[b_held].decision.state == "held"
    assert await rows(engine, b_id, "visitor_text", "text") == [("B's own words.",)]

    whoami = fake.called("GET /whoami")
    assert whoami and {(call.headers["x-session-token"], tuple(call.query)) for call in whoami} == {(a_token, ())}
    assert {(call.route, call.body.get("session_id")) for call in fake.calls if isinstance(call.body, dict)} == {
        ("POST /decisions/{decision_id}/cancel", a_id)}
    assert credentials(fake) == {("x-session-token", a_token)}


async def test_stream_resumes_from_last_event_id(app, browser, fake, kernel_http, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    ids = ids_of(fake, opened["state"]["session_id"])
    async with engine.begin() as conn:
        for event in (EvWriting(type="writing"), EvError(type="error", code="internal"), EvTurnEnd(type="turn_end")):
            await emit(conn, ids, event)

    # A browser reconnecting sends the last id it saw, which wins over the ?after= its first open used.
    async with Stream(app, events_path(slug, "after=0"), headers=[cookie(token), ("last-event-id", "1")]) as stream:
        await stream.until(lambda events: len(events) >= 2)
        async with engine.begin() as conn:
            await emit(conn, ids, EvWriting(type="writing"))               # live, after the replay
        events = await stream.until(lambda events: len(events) >= 3)
    assert [(seq, event.type) for seq, event in events] == [(2, "error"), (3, "turn_end"), (4, "writing")]

    # A first open continues after the transcript it read (its last_seq).
    last_seq = (await client.get(f"/api/public/desks/{slug}/session")).json()["last_seq"]
    assert last_seq == 4
    async with engine.begin() as conn:
        await emit(conn, ids, EvTurnEnd(type="turn_end"))
    async with Stream(app, events_path(slug, f"after={last_seq}"), headers=[cookie(token)]) as stream:
        events = await stream.until(lambda events: len(events) >= 1)
    assert [(seq, event.type) for seq, event in events] == [(5, "turn_end")]

    for cursor in (events_path(slug, "after=-1"), events_path(slug, "after=x")):
        async with Stream(app, cursor, headers=[cookie(token)]) as stream:
            pass
        assert (stream.status, stream.json()) == (422, {"error": "invalid"}), cursor
    async with Stream(app, events_path(slug), headers=[cookie(token), ("last-event-id", "2; 1")]) as stream:
        pass
    assert (stream.status, stream.json()) == (422, {"error": "invalid"})


async def test_open_streams_are_capped(app, browser, fake, kernel_http):
    slug = await new_slug(kernel_http, fake)
    _, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    slots = app.state.runtime.stream_slots

    streams = [await Stream(app, events_path(slug), headers=[cookie(token)]).open() for _ in range(3)]
    assert [stream.status for stream in streams] == [200, 200, 200]
    async with Stream(app, events_path(slug), headers=[cookie(token)]) as fourth:
        pass
    assert (fourth.status, fourth.json()) == (429, {"error": "rate_limited", "retry_after": 5})
    assert dict(fourth.response_headers)["retry-after"] == "5"
    assert slots.open_counts() == ({session_id: 3}, {CLIENT_IP: 3})        # the refused one took no place

    # A hang-up frees its place for the next stream.
    await streams[0].close()
    assert slots.open_counts() == ({session_id: 2}, {CLIENT_IP: 2})
    async with Stream(app, events_path(slug), headers=[cookie(token)]) as again:
        assert again.status == 200
    for stream in streams[1:]:
        await stream.close()
    assert slots.open_counts() == ({}, {})


async def test_a_stream_closed_mid_send_closes_its_frames_and_frees_its_place():
    closed = []

    async def frames() -> AsyncIterator[str]:
        try:
            yield "first"
            yield "second"
        finally:
            closed.append(True)                          # the listener subscription is let go here

    slots = StreamSlots()
    inner = frames()
    body = _released(EventSourceResponse(inner), slots.acquire("session-1", CLIENT_IP)).body_iterator
    assert await anext(body) == "first"
    await body.aclose()                                   # as sse-starlette closes the body after an interrupted send

    assert closed == [True]                               # at once, not when the inner generator is collected
    assert slots.open_counts() == ({}, {})


async def until(condition: Callable[[], object], timeout: float = 5.0) -> None:
    """Wait until `condition()` holds."""
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


def shown_as(type: str, decision) -> dict:
    """The event a decision is shown as: its type and the fields the kernel signed, unchanged."""
    return {"type": type, **decision.model_dump(include={"decision_id", "state", "visitor_plain", "ledger_seq",
                                                         "signature"})}


async def control_rows(engine, session_id: str) -> dict[int, bool]:
    """The session's control rows: id → handled."""
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT id, handled_at IS NOT NULL FROM app.run_events WHERE session_id = :s"
                                        " AND kind = 'control'"), {"s": session_id})
        return dict(tuple(row) for row in found)


async def test_due_decision_is_surfaced_with_the_visitor_credential(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    ids = ids_of(fake, session_id)
    expiring = await hold(fake, kernel_http, token, "quote-1")
    fake.now += timedelta(hours=23)
    waiting = await hold(fake, kernel_http, token, "quote-2")         # the visitor was back an hour before the end
    fake.now += timedelta(hours=2)                                      # the first hold's day is over, not the second's
    async with engine.begin() as conn:                                  # as Task 8's job leaves them, IDs only
        due = await append_control(conn, ids, "decision_due", {"decision_id": expiring})
        not_yet = await append_control(conn, ids, "decision_due", {"decision_id": waiting})
    model.add(response(reply("That request has run out of time, so I can ask Maria again.")))
    fake.calls.clear()

    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        events = await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()

    # The expiry shows as the kernel signed it, then Claude reads it and answers.
    assert types(events) == ["resolved", "writing", "message", "turn_end"]
    resolved, expired = events[0][1], fake.decisions[expiring].decision
    assert expired.state == "expired"
    assert resolved.model_dump() == shown_as("resolved", expired)
    sent = json.dumps(model.requests[0].messages)
    assert f'<action_update decision_id=\\"{expiring}\\" state=\\"expired\\">' in sent
    # The hold still waiting stays the next request's to look at; the expired one is claimed once.
    assert await control_rows(engine, session_id) == {due: True, not_yet: False}
    assert fake.decisions[waiting].decision.state == "held"
    read = [call.path for call in fake.called("GET /decisions/{id}")]
    assert sorted(read) == sorted([f"/decisions/{expiring}", f"/decisions/{waiting}"])
    assert credentials(fake) == {("x-session-token", token)}           # the visitor's credential, and nothing else

    # The next stream looks at the waiting hold again, and shows nothing twice. Rows that appear while it is open
    # (allows whose outcome their turn didn't learn) are handled as they come: a receipt once the allow ran, and
    # nothing yet for one whose outcome the kernel doesn't know either (`unknown`, reconciled later).
    async def ran(call_id: str) -> str:
        visitor = kernel_http.session(token)
        decision = await visitor.call("POST /decide", DecideRequest(
            session_id=session_id, generation=fake.sessions[session_id].generation,
            call=ToolCall(call_id=call_id, tool="native.quote", args={"items": [{"item_id": "drain", "qty": 1}]})))
        await visitor.call("POST /execute", ExecuteRequest(
            decision_id=decision.decision_id, session_id=session_id, generation=fake.sessions[session_id].generation))
        return decision.decision_id

    allowed = await ran("quote-3")
    fake.script("native.quote", exec_state="unknown")
    unknown = await ran("quote-4")
    model.add(response(reply("Your quote is ready.")))
    fake.calls.clear()
    async with Stream(app, events_path(slug, "after=4"), headers=[cookie(token)]) as stream:
        await until(lambda: fake.called("GET /decisions/{id}"))          # on opening: the waiting hold, still held
        async with engine.begin() as conn:
            pending = await append_control(conn, ids, "decision_pending", {"decision_id": allowed})
            not_known = await append_control(conn, ids, "decision_pending", {"decision_id": unknown})
        events = await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()

    assert types(events) == ["receipt", "writing", "message", "turn_end"]
    assert (events[0][1].decision_id, events[0][1].state) == (allowed, "executed")
    assert fake.decisions[unknown].decision.state == "unknown"
    assert await control_rows(engine, session_id) == {due: True, not_yet: False, pending: True, not_known: False}
    assert [call.path for call in fake.called("GET /decisions/{id}")][0] == f"/decisions/{waiting}"
    assert credentials(fake) == {("x-session-token", token)}

    # The other hold runs out too, and the visitor's next message comes after its outcome: one turn answers both.
    fake.now += timedelta(hours=23)
    model.add(response(reply("That one ran out of time too. What else can I do for you?")))
    calls = len(model.requests)
    sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Any news on the other one?"})
    assert sent.status_code == 202
    await app.state.runtime.runner.drain()
    assert len(model.requests) == calls + 1
    seen = json.dumps(model.requests[-1].messages)
    assert seen.index(f'decision_id=\\"{waiting}\\" state=\\"expired\\"') < seen.index("Any news on the other one?")
    items = (await client.get(f"/api/public/desks/{slug}/session")).json()["items"]
    assert [(item["kind"], (item["event"] or {}).get("decision_id")) for item in items][-3:] == [
        ("status", waiting), ("visitor_text", None), ("delivered", None)]
    assert await control_rows(engine, session_id) == {due: True, not_yet: True, pending: True, not_known: False}


async def stored_events(engine, session_id: str) -> list:
    """The session's events as stored, in order."""
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT payload FROM app.run_events WHERE session_id = :s AND kind = 'sse'"
                                        " ORDER BY seq"), {"s": session_id})
        return [EVENT.validate_python(payload) for (payload,) in found]


async def test_paused_session_answers_each_message_with_one_handoff(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    ids = ids_of(fake, session_id)
    expiring = await hold(fake, kernel_http, token, "quote-1")
    fake.now += timedelta(hours=23)
    assert (await client.get(f"/api/public/desks/{slug}/session")).status_code == 200    # the visitor is back
    fake.now += timedelta(hours=2)                                      # the hold's day is over, not the session's
    async with engine.begin() as conn:                                  # an outcome and a whisper wait for a turn
        due = await append_control(conn, ids, "decision_due", {"decision_id": expiring})
        await append_message(conn, ids, "whisper", text="Whisper: offer the deposit credit.")
    fake.set_mode(session_id, "paused")                                 # the breaker's third strike
    fake.calls.clear()

    sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Hello? Is anyone there?"})
    assert sent.status_code == 202
    await app.state.runtime.runner.drain()

    # The expiry shows as the kernel signed it, then the kernel's handoff answers it all once, with no model call.
    events = await stored_events(engine, session_id)
    assert [event.type for event in events] == ["resolved", "message", "turn_end"]
    assert events[0].model_dump() == shown_as("resolved", fake.decisions[expiring].decision)
    assert events[1].handoff is True and [block.template for block in events[1].blocks] == ["handoff"]
    assert model.requests == [] and len(fake.called("/check_reply")) == 1
    assert await control_rows(engine, session_id) == {due: True}
    # What waited stays for Claude to read once the owner resumes the session, and starts no more turns.
    for kind in ("action_update", "whisper", "visitor_text"):
        assert await rows(engine, session_id, kind, "model_seq", "wake") == [(None, False)], kind

    # Each later message gets one handoff of its own.
    again = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Hello again?"})
    assert again.status_code == 202
    await app.state.runtime.runner.drain()
    events = await stored_events(engine, session_id)
    assert [event.type for event in events] == ["resolved", "message", "turn_end", "message", "turn_end"]
    assert events[3].handoff is True
    assert model.requests == [] and len(fake.called("/check_reply")) == 2
    assert credentials(fake) == {("x-session-token", token)}


async def test_message_limit(app, browser, fake, kernel_http, engine, clock, monkeypatch):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    fake.set_mode(session_id, "owner")                       # the owner has the chat: messages are stored, no turns
    path = f"/api/public/desks/{slug}/messages"
    fake.calls.clear()

    accepted = [(await client.post(path, json={"text": f"Message {n}"})).status_code for n in range(20)]
    assert accepted == [202] * 20
    refused = await client.post(path, json={"text": "One too many"})
    assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 300})
    assert refused.headers["retry-after"] == "300"
    clock.advance(10)
    again = await client.post(path, json={"text": "Still too many"})
    assert (again.status_code, again.json()["retry_after"]) == (429, 290)
    # The window's first refusal is ledgered once, with the visitor's own credential, naming only the limit.
    (append,) = fake.called("POST /ledger/append")
    assert append.headers["x-session-token"] == token and "x-owner-session" not in append.headers
    event = append.body["event"]
    assert (event["kind"], event["origin"], event["session_id"], event["summary"]) == (
        "rate_limit", "api", session_id, {"limit": "visitor_message"})
    stored = await rows(engine, session_id, "visitor_text", "text")
    assert len(stored) == 20 and ("One too many",) not in stored and ("Still too many",) not in stored

    clock.advance(291)                                       # the first message has left the five-minute window
    assert (await client.post(path, json={"text": "Back again"})).status_code == 202

    # A copy's visitors share a daily limit too (300 in production; 23 here), whichever session sends.
    monkeypatch.setitem(LIMITS, "visitor_message_copy", Limit(23, 86400, "copy"))
    other, _, other_opened = await open_session(app, browser, slug)
    fake.set_mode(other_opened["state"]["session_id"], "owner")
    assert (await other.post(path, json={"text": "Hello"})).status_code == 202          # the copy's 22nd and 23rd
    assert (await other.post(path, json={"text": "Hello again"})).status_code == 202
    over = await other.post(path, json={"text": "And again"})
    assert (over.status_code, over.json()["error"]) == (429, "rate_limited")
    assert [call.body["event"]["summary"] for call in fake.called("POST /ledger/append")][-1] == {
        "limit": "visitor_message_copy"}


async def test_cancel_held_decision(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Maria.")))
    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Can I get 15% off a drain?"})
        events = await stream.until(lambda events: "turn_end" in types(events))
        await app.state.runtime.runner.drain()
        held = next(event for _, event in events if event.type == "held")
        fake.calls.clear()

        cancel = await client.post(f"/api/public/desks/{slug}/decisions/{held.decision_id}/cancel")
        assert (cancel.status_code, cancel.json()) == (202, {"decision_id": held.decision_id})
        events = await stream.until(lambda events: "resolved" in types(events))
    await app.state.runtime.runner.drain()

    # The kernel cancelled it for the cookie's session, and its signed outcome is shown once.
    (call,) = fake.called("POST /decisions/{decision_id}/cancel")
    assert call.headers["x-session-token"] == token and call.body == {"session_id": session_id}
    cancelled = fake.decisions[held.decision_id].decision
    assert cancelled.state == "cancelled"
    assert types(events)[-1] == "resolved" and events[-1][1].model_dump() == shown_as("resolved", cancelled)
    # Claude learns of it at its next turn; the cancel itself starts none (the visitor already sees what happened).
    assert len(model.requests) == 1
    assert await rows(engine, session_id, "action_update", "ref_id", "wake") == [(held.decision_id, False)]

    # Withdrawn once: a second cancel is the kernel's 409, and nothing more is shown.
    again = await client.post(f"/api/public/desks/{slug}/decisions/{held.decision_id}/cancel")
    assert (again.status_code, again.json()) == (409, {"error": "kernel", "code": "conflict"})
    model.add(response(reply("Understood, I've withdrawn that request.")))
    await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Thanks."})
    await app.state.runtime.runner.drain()
    sent = json.dumps(model.requests[1].messages)
    assert f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"cancelled\\">' in sent
    async with engine.connect() as conn:
        shown = (await conn.execute(text("SELECT count(*) FROM app.run_events WHERE session_id = :s AND type ="
                                         " 'resolved'"), {"s": session_id})).scalar_one()
    assert shown == 1


async def test_unknown_slug_is_404(app, browser, fake, kernel_http):
    slug = await new_slug(kernel_http, fake)
    _, token, _ = await open_session(app, browser, slug)
    sessions = set(fake.sessions)
    client = browser(app)
    for unknown in ("no-such-desk", "no such desk", f"{slug}-x"):
        name = quote(unknown, safe="")
        # The public Desk, the Agent Card and opening a session ask the kernel, which knows no such Desk.
        for method, path in (("GET", f"/api/public/{name}"), ("GET", f"/api/public/desks/{name}/agent_card"),
                             ("POST", f"/api/public/desks/{name}/sessions")):
            response = await client.request(method, path)
            assert (response.status_code, response.json()) == (404, {"error": "kernel", "code": "not_found"}), path
            assert "set-cookie" not in response.headers, path
        # A real session's cookie, forged onto the unknown Desk's paths, names no session there.
        client.cookies.set("desk_visitor", token, domain="desk.test", path=f"/api/public/desks/{name}")
        read = await client.get(f"/api/public/desks/{name}/session")
        assert (read.status_code, read.json()) == (401, {"error": "no_session"}), unknown
        client.cookies.clear()
    assert set(fake.sessions) == sessions                     # no session was opened anywhere


async def test_stopping_ends_a_sessions_work_even_when_a_read_reports_it_as_an_error(app, browser, fake, kernel_http,
                                                                                    monkeypatch):
    slug = await new_slug(kernel_http, fake)
    _, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    reading, turns = asyncio.Event(), []

    async def slow_read(conn, ids):
        reading.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:          # as SQLAlchemy's pool ping reports a cancellation that lands in it
            raise RuntimeError("can't change 'autocommit' now: connection in transaction status ACTIVE") from None

    async def run_pending(*args, **kwargs):
        turns.append(args)

    monkeypatch.setattr(runner_module, "unhandled_controls", slow_read)
    monkeypatch.setattr(runner_module, "run_pending", run_pending)
    runner = app.state.runtime.runner
    async with Stream(app, events_path(slug), headers=[cookie(token)]):      # opening it starts the session's work
        await asyncio.wait_for(reading.wait(), 5)
        await asyncio.wait_for(runner.close(), 5)           # the process is stopping

    assert turns == [] and not runner.running(session_id)    # no turn ran after the cancellation
