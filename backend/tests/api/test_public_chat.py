"""The public page and the visitor's chat API (Plan 02a, Task 7): the kernel's public Desk passed through, the Agent
Card from `PUBLIC_ORIGIN`, sessions held only by the Desk-scoped cookie, messages that start turns, a replayable
event stream, control rows handled with the visitor's own credential, the message limit, cancelling a hold and the
session work stopping with the process.

The app runs on FakeKernel and a scripted model. An event stream is run the way a browser runs it (`Stream`): its
ASGI response in a task, until the test hangs up, since httpx's in-process transport waits for a whole body.
"""

import asyncio
import contextlib
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

from desk.api import runner as runner_module
from desk.api import sse
from desk.api.main import create_app
from desk.api.ratelimit import StreamSlots
from desk.api.sse import EventStream, Wakeup, append_control, emit
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
    """A fresh Turner copy's Desk slug, made straight on the kernel."""

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
    """A request to the app run as a browser runs an event stream: in a task, until `close()` hangs up. A client that
    stops reading (`reading` False, or `stop_reading()`) leaves each body send waiting until it hangs up; `blocked` is
    set once one waits."""

    app: FastAPI
    path: str
    headers: list[tuple[str, str]] = field(default_factory=list)
    ip: str = CLIENT_IP
    reading: bool = True
    status: int | None = None
    response_headers: list[tuple[str, str]] = field(default_factory=list)
    body: str = ""
    blocked: asyncio.Event = field(default_factory=asyncio.Event)
    _started: asyncio.Event = field(default_factory=asyncio.Event)
    _changed: asyncio.Event = field(default_factory=asyncio.Event)
    _hung_up: asyncio.Event = field(default_factory=asyncio.Event)
    _task: asyncio.Task | None = None

    def stop_reading(self) -> None:
        self.reading = False

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
                if not self.reading:                    # the send waits for a client that never reads
                    self.blocked.set()
                    await self._hung_up.wait()
                    return
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
    assert response.json()["starters"] == [
        "¿Cuánto cuesta destapar un desagüe?", "¿Puede venir alguien el martes?", "¿Trabajan en Alameda?"]
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
    """A returning visitor resumes their session. Loading or resuming a chat creates nothing and spends no model
    tokens, so it is never limited, however often a visitor reloads; a new chat counts toward 180 an hour from one
    address, counted only when one is created."""
    slug, other = await new_slug(kernel_http, fake), await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)                      # the address's first new chat
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

    # Reloads: the page resumes the session, reads the transcript and opens the stream, never answered 429.
    for _ in range(200):
        resumed = await client.post(f"/api/public/desks/{slug}/sessions")
        assert (resumed.status_code, resumed.json()["resumed"]) == (200, True)
        assert (await client.get(f"/api/public/desks/{slug}/session")).status_code == 200
    for _ in range(50):
        async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
            assert stream.status == 200
    assert fake.called("POST /sessions") == []

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

    # Three new chats from this address so far (the first, the forged cookie's and the day-old one's): 177 more fit
    # in the hour, and the 181st is refused, while an open chat still resumes and another address still starts one.
    for _ in range(177):
        assert (await browser(app).post(f"/api/public/desks/{slug}/sessions")).status_code == 200
    refused = await browser(app).post(f"/api/public/desks/{slug}/sessions")
    assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 3600})
    assert "set-cookie" not in refused.headers
    assert len(fake.called("POST /sessions")) == 179                   # since the first, which came before the clear
    assert (await client.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True
    assert (await browser(app, ip="198.51.100.4").post(f"/api/public/desks/{slug}/sessions")).status_code == 200


def resume_entries(desk) -> list[str]:
    """The sessions of a Desk's `session` ledger entries for a resume (the API's), in order."""
    return [entry.event.session_id for entry in desk.ledger
            if (entry.event.kind, entry.event.origin, entry.event.summary) == ("session", "api", {"resumed": True})]


def opened_entries(desk, session_id: str) -> list[tuple]:
    """The Desk's ledger entries for `session_id`, as (kind, origin, summary): for a new visitor session, only the
    kernel's entry for opening it."""
    return [(entry.event.kind, entry.event.origin, entry.event.summary) for entry in desk.ledger
            if entry.event.session_id == session_id]


def opened_by_kernel(session_id: str) -> list[tuple]:
    """What `opened_entries` holds for a visitor session the kernel just opened."""
    return [("session", "kernel", {"session_id": session_id, "kind": "visitor", "preview": False})]


def desk_of(fake, slug: str):
    """FakeKernel's Desk for `slug`."""
    return next(desk for desk in fake.desks.values() if desk.slug == slug)


async def test_a_resume_is_ledgered_at_most_once_every_ten_minutes(app, browser, fake, kernel_http, clock):
    """Resuming is never limited, and each ledger append takes the Desk's ledger lock, so a resume's `session` entry
    is written at most once per session every ten minutes: a loop of resumes answers 200 each time without a ledger
    write each time, while the kernel's `/whoami` still checks the session on every one. Each session keeps its own
    ten minutes, and a new session is ledgered as before."""
    slug = await new_slug(kernel_http, fake)
    client, _, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    desk = fake.desks[fake.sessions[session_id].desk_id]

    # 200 resumes within ten minutes, three seconds apart: each answers 200 after its own `/whoami`, and one is
    # ledgered.
    checked = len(fake.called("GET /whoami"))
    for n in range(200):
        if n:
            clock.advance(3)
        resumed = await client.post(f"/api/public/desks/{slug}/sessions")
        assert (resumed.status_code, resumed.json()["resumed"]) == (200, True)
    assert len(fake.called("GET /whoami")) - checked == 200
    assert resume_entries(desk) == [session_id]
    assert len(fake.called("POST /ledger/append")) == 1

    # Ten minutes after the ledgered one, the next resume is ledgered again, and starts the next ten minutes.
    clock.advance(3)
    assert (await client.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True
    assert resume_entries(desk) == [session_id] * 2
    assert (await client.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True
    assert resume_entries(desk) == [session_id] * 2

    # A new session within those ten minutes: the kernel ledgers it as it is opened, and its own first resume is
    # ledgered too.
    other, _, created = await open_session(app, browser, slug)
    other_id = created["state"]["session_id"]
    assert opened_entries(desk, other_id) == opened_by_kernel(other_id)
    assert (await other.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True
    assert resume_entries(desk) == [session_id, session_id, other_id]
    assert (await client.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True
    assert resume_entries(desk) == [session_id, session_id, other_id]


@pytest.mark.parametrize("mode", ["owner", "paused"])
async def test_a_taken_over_or_paused_session_reloads_as_itself_inside_the_ledger_window(app, browser, fake,
                                                                                        kernel_http, mode):
    """A session the owner took over, or the breaker paused, is still open for its Desk, so a reload within its ten
    minutes reuses it, never replaces it: `resumed` with the mode the kernel's `/whoami` gives on that request, never
    one kept from an earlier resume. Its reloads share the session's ten minutes, so they open no session and write no
    second `session` entry."""
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    desk = fake.desks[fake.sessions[session_id].desk_id]
    first = await client.post(f"/api/public/desks/{slug}/sessions")             # ledgered: its ten minutes start
    assert (first.json()["resumed"], first.json()["state"]["mode"]) == (True, "ai")
    assert resume_entries(desk) == [session_id]
    created, checked = len(fake.called("POST /sessions")), len(fake.called("GET /whoami"))
    appended = len(fake.called("POST /ledger/append"))

    fake.set_mode(session_id, mode)
    reloaded = await client.post(f"/api/public/desks/{slug}/sessions")
    assert reloaded.status_code == 200
    assert reloaded.json() == {"state": fake.sessions[session_id].state().model_dump(mode="json"), "resumed": True}
    assert (reloaded.json()["state"]["session_id"], reloaded.json()["state"]["mode"]) == (session_id, mode)
    assert visitor_cookie(reloaded)[0] == token                                  # the same session, its cookie renewed

    fake.set_mode(session_id, "ai")                     # handed back, or the breaker lifted: the next reload says so
    back = await client.post(f"/api/public/desks/{slug}/sessions")
    assert (back.json()["resumed"], back.json()["state"]["session_id"], back.json()["state"]["mode"]) == (
        True, session_id, "ai")

    assert len(fake.called("POST /sessions")) == created
    assert len(fake.called("GET /whoami")) - checked == 2
    assert len(fake.called("POST /ledger/append")) == appended
    assert resume_entries(desk) == [session_id]


async def test_a_closed_session_s_cookie_inside_the_ledger_window_gets_a_new_ledgered_session(app, browser, fake,
                                                                                             kernel_http):
    """Once the kernel has closed a session, its cookie is no resume, even within that session's ten minutes:
    `POST /sessions` opens a new session, which the kernel ledgers as it opens it, and the dead cookie on another
    visitor route answers 401 `no_session` and is cleared, never a 200 kept from the earlier resume. The new session's
    ten minutes are its own."""
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    desk = fake.desks[fake.sessions[session_id].desk_id]
    assert (await client.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True   # ten minutes start
    assert resume_entries(desk) == [session_id]
    fake.now += timedelta(hours=24, seconds=1)          # the kernel closes it after a day idle; the API's clock stays

    stale = browser(app)
    stale.cookies.set("desk_visitor", token, domain="desk.test", path=f"/api/public/desks/{slug}")
    read = await stale.get(f"/api/public/desks/{slug}/session")
    assert (read.status_code, read.json()) == (401, {"error": "no_session"})
    assert visitor_cookie(read)[0] == ""

    created = len(fake.called("POST /sessions"))
    fresh = await client.post(f"/api/public/desks/{slug}/sessions")
    assert (fresh.status_code, fresh.json()["resumed"]) == (200, False)
    new_id = fresh.json()["state"]["session_id"]
    assert new_id != session_id and session_of(fake, visitor_cookie(fresh)[0]) == new_id
    assert len(fake.called("POST /sessions")) == created + 1
    assert opened_entries(desk, new_id) == opened_by_kernel(new_id)

    assert (await client.post(f"/api/public/desks/{slug}/sessions")).json()["resumed"] is True
    assert resume_entries(desk) == [session_id, new_id]


async def test_a_foreign_or_unknown_cookie_inside_the_ledger_window_gets_a_new_ledgered_session(app, browser, fake,
                                                                                               kernel_http):
    """Only a session `/whoami` says is open for this Desk is throttled as a resume. A cookie naming another Desk's
    session, its ten minutes running there, or a token the kernel doesn't know gets a new session here, ledgered by
    the kernel every time, and the other Desk's session is left alone."""
    slug, other = await new_slug(kernel_http, fake), await new_slug(kernel_http, fake)
    there, token, opened = await open_session(app, browser, other)
    other_id = opened["state"]["session_id"]
    other_desk, here = desk_of(fake, other), desk_of(fake, slug)
    assert (await there.post(f"/api/public/desks/{other}/sessions")).json()["resumed"] is True  # ten minutes start
    assert resume_entries(other_desk) == [other_id]
    created = len(fake.called("POST /sessions"))

    opened_here = []
    for sent in (token, token, "not-a-session-token"):
        visitor = browser(app)
        visitor.cookies.set("desk_visitor", sent, domain="desk.test", path=f"/api/public/desks/{slug}")
        moved = await visitor.post(f"/api/public/desks/{slug}/sessions")
        assert (moved.status_code, moved.json()["resumed"]) == (200, False)
        new_id = moved.json()["state"]["session_id"]
        assert visitor_cookie(moved)[0] != sent and fake.sessions[new_id].desk_id == here.desk_id
        assert opened_entries(here, new_id) == opened_by_kernel(new_id)
        opened_here.append(new_id)
    assert len(set(opened_here)) == 3 and other_id not in opened_here
    assert len(fake.called("POST /sessions")) == created + 3
    assert resume_entries(here) == []

    again = await there.post(f"/api/public/desks/{other}/sessions")
    assert (again.json()["resumed"], again.json()["state"]["session_id"]) == (True, other_id)
    assert resume_entries(other_desk) == [other_id]


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
                       tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike.")))
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
                                                                                 "I've asked Mike.")
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
    """Three streams per session and thirty per address may be open at once. A session's fourth closes its oldest
    rather than answering 429, so a reload never fails while the old page's stream is still counted; the address's
    31st is refused, unless it replaces one of its own session's."""
    slug = await new_slug(kernel_http, fake)
    _, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    slots = app.state.runtime.stream_slots

    def open_stream(token: str) -> Stream:
        return Stream(app, events_path(slug), headers=[cookie(token)])

    streams = [await open_stream(token).open() for _ in range(3)]
    assert [stream.status for stream in streams] == [200, 200, 200]
    fourth = await open_stream(token).open()
    assert fourth.status == 200
    await asyncio.wait_for(streams[0]._task, 5)              # the oldest ended by the server, its client still there
    assert not streams[0]._hung_up.is_set() and not any(stream._task.done() for stream in [*streams[1:], fourth])
    assert slots.open_counts() == ({session_id: 3}, {CLIENT_IP: 3})
    streams = [*streams[1:], fourth]

    # A hang-up frees its place for the next stream.
    await streams[0].close()
    assert slots.open_counts() == ({session_id: 2}, {CLIENT_IP: 2})
    streams = [*streams[1:], await open_stream(token).open()]
    assert slots.open_counts() == ({session_id: 3}, {CLIENT_IP: 3})

    # Nine more sessions from the same address fill its thirty; another session's stream is refused and takes no
    # place, while one of these sessions may still replace its own oldest stream.
    for _ in range(9):
        _, other, _ = await open_session(app, browser, slug)
        streams += [await open_stream(other).open() for _ in range(3)]
    assert all(stream.status == 200 for stream in streams) and slots.open_counts()[1] == {CLIENT_IP: 30}
    _, eleventh, _ = await open_session(app, browser, slug)
    async with open_stream(eleventh) as refused:
        pass
    assert (refused.status, refused.json()) == (429, {"error": "rate_limited", "retry_after": 5})
    assert dict(refused.response_headers)["retry-after"] == "5" and slots.open_counts()[1] == {CLIENT_IP: 30}
    reload = await open_stream(token).open()
    assert reload.status == 200
    await asyncio.wait_for(streams[0]._task, 5)              # the first session's oldest made way for it
    assert slots.open_counts()[1] == {CLIENT_IP: 30}

    for stream in [*streams[1:], reload]:
        await stream.close()
    assert slots.open_counts() == ({}, {})


async def test_a_client_that_stops_reading_never_keeps_more_than_the_cap_open(app, browser, fake, kernel_http,
                                                                              engine):
    """A client that stops reading leaves its stream's send waiting. Closing that stream for a newer one of its session
    still ends it at once, its waiting send included: however many streams the session opens, no more than its three
    stay open, with their listener subscriptions, and a closed stream's place is counted until it has ended."""
    slug = await new_slug(kernel_http, fake)
    _, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    async with engine.begin() as conn:                    # an event to replay, so each stream's first send waits
        await emit(conn, ids_of(fake, session_id), EvTurnEnd(type="turn_end"))
    runtime = app.state.runtime
    streams: list[Stream] = []

    def alive() -> int:
        return sum(not stream._task.done() for stream in streams)

    def subscribed() -> int:
        return len(runtime.listener._streams.get(session_id, ()))

    for _ in range(8):
        stream = Stream(app, events_path(slug), headers=[cookie(token)], reading=False)
        streams.append(await stream.open())
        await asyncio.wait_for(stream.blocked.wait(), 5)  # its first send waits for the client
        assert subscribed() <= runtime.stream_slots.open_counts()[0][session_id]     # never counted below what is open
    with contextlib.suppress(TimeoutError):
        await until(lambda: alive() <= 3, timeout=2)

    assert (alive(), subscribed()) == (3, 3)
    assert runtime.stream_slots.open_counts() == ({session_id: 3}, {CLIENT_IP: 3})
    for stream in streams:
        await stream.close()
    assert runtime.stream_slots.open_counts() == ({}, {})


async def test_a_closed_stream_whose_client_stops_reading_after_the_close_still_ends(app, browser, fake, kernel_http,
                                                                                      monkeypatch):
    """A stream closed while no send waits is woken to end at its next look. Should its client stop reading just then,
    its last send waits, and the stream is ended within `CLOSE_GRACE_S` all the same."""
    monkeypatch.setattr(sse, "CLOSE_GRACE_S", 0.05)
    slug = await new_slug(kernel_http, fake)
    _, token, opened = await open_session(app, browser, slug)
    slots = app.state.runtime.stream_slots
    streams = [await Stream(app, events_path(slug), headers=[cookie(token)]).open() for _ in range(3)]
    streams[0].stop_reading()                             # idle, with no send waiting: its next one will
    fourth = await Stream(app, events_path(slug), headers=[cookie(token)]).open()

    await asyncio.wait_for(streams[0]._task, 5)
    assert streams[0].blocked.is_set()                    # its last send waited, and the stream ended all the same
    assert slots.open_counts() == ({opened["state"]["session_id"]: 3}, {CLIENT_IP: 3})
    for stream in [*streams[1:], fourth]:
        await stream.close()
    assert slots.open_counts() == ({}, {})


async def test_a_stream_that_fails_mid_send_closes_its_frames_and_frees_its_place():
    closed = []

    async def frames() -> AsyncIterator[str]:
        try:
            yield "first"
            yield "second"
        finally:
            closed.append(True)                          # the listener subscription is let go here

    async def send(message: dict) -> None:
        if message["type"] == "http.response.body" and message["more_body"]:
            raise OSError("the connection dropped")

    async def receive() -> dict:
        await asyncio.Event().wait()

    slots = StreamSlots()
    response = EventStream(frames(), wakeup=Wakeup(), on_end=slots.acquire("session-1", CLIENT_IP).release)
    with pytest.raises(OSError):
        await response({"type": "http", "method": "GET"}, receive, send)

    assert closed == [True]                               # at once, not when the generator is collected
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
    model.add(response(reply("That request has run out of time, so I can ask Mike again.")))
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


async def test_message_limit(app, browser, fake, kernel_http, model, engine, clock):
    """The money guard is on model turns: a message that starts one (mode `ai`) counts toward 90 an hour from one
    address and 30 in one conversation, which has no window. Past either, 429 `rate_limited` before any row is stored
    or Claude is called, and the limit's first refusal is ledgered with the visitor's own credential. Messages while
    the owner has the chat, or while it is paused, count toward neither."""
    slug = await new_slug(kernel_http, fake)
    path = f"/api/public/desks/{slug}/messages"
    runner = app.state.runtime.runner
    model.add(*[lambda request: response(reply("Thanks, noted."))] * 200)

    async def asked(texts: list[str]) -> set[str]:
        """Which of `texts` any model call was sent."""
        sent = json.dumps([request.messages for request in model.requests])
        return {words for words in texts if words in sent}

    async def refused_cleanly(client: httpx.AsyncClient, session_id: str, words: str) -> dict:
        """Post `words`, which must be refused before anything is stored or Claude is called; the 429's body."""
        calls = len(model.requests)
        refused = await client.post(path, json={"text": words})
        await runner.drain()
        assert refused.status_code == 429 and refused.headers["retry-after"] == str(refused.json()["retry_after"])
        assert (words,) not in await rows(engine, session_id, "visitor_text", "text")
        assert len(model.requests) == calls and not await asked([words])
        return refused.json()

    def appended() -> list[tuple[str | None, str, dict]]:
        return [(call.headers.get("x-session-token"), call.body["event"]["kind"], call.body["event"]["summary"])
                for call in fake.called("POST /ledger/append")]

    # Thirty turns in one conversation; the 31st is refused, and stays refused once the hour has passed.
    first, first_token, opened = await open_session(app, browser, slug)
    first_id = opened["state"]["session_id"]
    for n in range(30):
        assert (await first.post(path, json={"text": f"Question {n}"})).status_code == 202
    await runner.drain()
    assert len(await rows(engine, first_id, "visitor_text", "text")) == 30
    fake.calls.clear()
    assert await refused_cleanly(first, first_id, "One too many") == {"error": "rate_limited", "retry_after": 86400}
    clock.advance(7200)
    assert (await refused_cleanly(first, first_id, "Still too many"))["error"] == "rate_limited"
    assert appended() == [(first_token, "rate_limit", {"limit": "visitor_turn_conversation"})]   # once

    # Ninety turns an hour from one address, over three conversations; the 91st is refused wherever it comes from.
    for _ in range(3):
        client, _, opened = await open_session(app, browser, slug)
        for n in range(30):
            assert (await client.post(path, json={"text": f"Another question {n}"})).status_code == 202
    await runner.drain()
    fourth, fourth_token, opened = await open_session(app, browser, slug)
    fourth_id = opened["state"]["session_id"]
    fake.calls.clear()
    assert await refused_cleanly(fourth, fourth_id, "Hello?") == {"error": "rate_limited", "retry_after": 3600}
    assert (await refused_cleanly(fourth, fourth_id, "Hello again?"))["retry_after"] == 3600
    assert appended() == [(fourth_token, "rate_limit", {"limit": "visitor_turn"})]

    # While the owner has the chat, or it is paused, messages start no model turn and count toward neither limit.
    fake.set_mode(fourth_id, "owner")
    for n in range(35):
        assert (await fourth.post(path, json={"text": f"For the owner {n}"})).status_code == 202
    paused, _, opened = await open_session(app, browser, slug)
    fake.set_mode(opened["state"]["session_id"], "paused")
    for n in range(2):
        assert (await paused.post(path, json={"text": f"Anyone there {n}"})).status_code == 202
    await runner.drain()
    assert not await asked([f"For the owner {n}" for n in range(35)] + ["Anyone there 0", "Anyone there 1"])
    assert len(await rows(engine, fourth_id, "visitor_text", "text")) == 35
    fake.set_mode(fourth_id, "ai")                                   # handed back: its messages count again
    assert (await refused_cleanly(fourth, fourth_id, "Back to Claude"))["error"] == "rate_limited"

    clock.advance(3600)                                              # the address's hour has passed
    assert (await fourth.post(path, json={"text": "Back to Claude"})).status_code == 202
    await runner.drain()
    assert (await refused_cleanly(first, first_id, "And now?"))["error"] == "rate_limited"     # no window here


@pytest.mark.parametrize("mode", ["paused", "owner"])
async def test_posts_are_limited_in_every_mode(app, browser, fake, kernel_http, engine, clock, mode):
    """Whatever the mode, one chat takes 120 messages every ten minutes, a backstop on what each one costs even when it
    starts no model turn: a stored row and, in a paused chat, a handoff the kernel checks and ledgers. The 121st is 429
    `rate_limited` before anything is stored, checked or woken, and the limit's first refusal is ledgered with the
    visitor's own credential."""
    slug = await new_slug(kernel_http, fake)
    path = f"/api/public/desks/{slug}/messages"
    runner = app.state.runtime.runner
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    fake.set_mode(session_id, mode)
    for n in range(120):
        assert (await client.post(path, json={"text": f"Anyone there {n}"})).status_code == 202
    await runner.drain()
    fake.calls.clear()

    refused = await client.post(path, json={"text": "One too many"})
    await runner.drain()
    assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 600})
    assert ("One too many",) not in await rows(engine, session_id, "visitor_text", "text")
    assert len(await rows(engine, session_id, "visitor_text", "text")) == 120
    assert fake.called("POST /check_reply") == []
    assert [(call.headers.get("x-session-token"), call.body["event"]["kind"], call.body["event"]["summary"])
            for call in fake.called("POST /ledger/append")] == [(token, "rate_limit", {"limit": "visitor_post"})]

    clock.advance(600)                                               # the ten minutes have passed
    assert (await client.post(path, json={"text": "Ten minutes on"})).status_code == 202
    await runner.drain()


async def test_cancel_held_decision(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Mike.")))
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
