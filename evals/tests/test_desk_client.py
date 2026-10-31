"""`ROUTES` and `DeskClient`: the API's paths by operation, and a client that holds its cookies.

Until Plan 02a lands, tier 1's API cases are pending, so these tests are what runs the client: a
stand-in API on loopback sets cookies the way the API does (`Secure`, path-scoped) and streams
events, and the client is checked to send each cookie on its paths of that origin only.
"""

import json
import secrets
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from evals.client import ApiCallFailed, DeskClient, LoopbackJar, origin_of
from evals.fakes import LoopbackServer
from evals.routes import ROUTES

PASSCODE = "a demo passcode"
SLUG = "rivera"

# The operations Plan 05a names, by the plan id that lands each.
NAMED = {
    "02a": {"enter", "open_chat", "send", "events", "owner_session", "owner_decision", "owner_ledger"},
    "02": {"verify_start", "verify_check", "my_demo_inbox", "fetch_document", "a2a", "owner_take_over"},
}


def test_routes_name_each_operation_with_the_plan_that_lands_it():
    for plan, names in NAMED.items():
        assert {name: ROUTES[name].plan for name in names} == dict.fromkeys(names, plan)
    for name, route in ROUTES.items():
        assert route.plan in ("02a", "02"), name
        assert route.method in ("GET", "POST", "PUT", "DELETE"), name
        assert route.path.startswith("/api/"), name
    assert (ROUTES["owner_decision"].method, ROUTES["owner_decision"].path) == (
        "GET", "/api/owner/decisions/{decision_id}")
    assert (ROUTES["a2a"].method, ROUTES["a2a"].path) == ("POST", "/api/a2a/{desk_slug}")
    assert (ROUTES["owner_ledger"].path, ROUTES["owner_ledger"].query) == (
        "/api/owner/desks/{desk_id}/ledger", {"verify": "true"})


def test_a_route_fills_and_encodes_its_parameters():
    assert ROUTES["owner_take_over"].url(session_id="s/1 ?x") == "/api/owner/conversations/s%2F1%20%3Fx/takeover"
    assert ROUTES["send"].url(desk_slug="rivera") == "/api/public/desks/rivera/messages"
    for params in ({}, {"desk_slug": "rivera", "session_id": "s-1"}):
        with pytest.raises(ValueError, match="desk_slug"):
            ROUTES["send"].url(**params)
    assert ROUTES["owner_take_over"].operation == ("post", "/api/owner/conversations/{}/takeover")


# A stand-in API: the cookies and the stream as Plan 02a states them

class StandInApi:
    """The API's cookies (`HttpOnly; Secure; SameSite=Strict`, `desk_owner` on `/api/owner`,
    `desk_visitor` on its Desk's `/api/public/desks/{slug}`), a visitor's session and its event
    stream, take-over and A2A. It records each request's path, cookies and body for the tests."""

    def __init__(self) -> None:
        self.owner_token = secrets.token_urlsafe(32)
        self.sessions: dict[str, dict] = {}     # visitor token -> {slug, state}
        self.events: dict[str, list[dict]] = {}   # session id -> its events, seq = index + 1
        self.seen: list[tuple[str, str, dict[str, str]]] = []   # (method, path, cookies sent)
        self.bodies: list[tuple[str, bytes, dict[str, str]]] = []   # (path, raw body, headers)

    def app(self) -> Starlette:
        chat = "/api/public/desks/{slug}"
        return Starlette(routes=[
            Route("/api/owner/copies", self.copies, methods=["POST"]),
            Route("/api/owner/conversations/{session_id}", self.owner_session, methods=["GET"]),
            Route("/api/owner/conversations/{session_id}/takeover", self.take_over, methods=["POST"]),
            Route(f"{chat}/sessions", self.open_session, methods=["POST"]),
            Route(f"{chat}/session", self.chat_session, methods=["GET"]),
            Route(f"{chat}/messages", self.message, methods=["POST"]),
            Route(f"{chat}/events", self.stream, methods=["GET"]),
            Route("/api/a2a/{slug}", self.a2a, methods=["POST"]),
            Route("/{path:path}", self.elsewhere, methods=["GET", "POST"]),
        ])

    def sent(self, path: str) -> set[str]:
        """The cookie names each request to `path` carried, together."""
        return {name for _, seen_path, cookies in self.seen if seen_path == path for name in cookies}

    async def _record(self, request: Request) -> None:
        self.seen.append((request.method, request.url.path, dict(request.cookies)))
        self.bodies.append((request.url.path, await request.body(), dict(request.headers)))

    def _visitor(self, request: Request) -> dict | None:
        found = self.sessions.get(request.cookies.get("desk_visitor", ""))
        return found if found and found["slug"] == request.path_params["slug"] else None

    def _owner(self, request: Request) -> bool:
        return request.cookies.get("desk_owner") == self.owner_token

    async def copies(self, request: Request) -> Response:
        await self._record(request)
        if (await request.json()).get("passcode") != PASSCODE:
            return JSONResponse({"error": "passcode"}, status_code=401)
        response = JSONResponse({"copy_id": "c-1", "desks": [{"desk_id": "d-1", "slug": SLUG}]}, status_code=201)
        response.headers.append("set-cookie", f"desk_owner={self.owner_token}; HttpOnly; Secure; SameSite=Strict; "
                                              "Path=/api/owner; Max-Age=604800")
        return response

    async def owner_session(self, request: Request) -> Response:
        await self._record(request)
        state = self._state(request.path_params["session_id"])
        if not self._owner(request) or state is None:
            return JSONResponse({"error": "not_found"}, status_code=404 if self._owner(request) else 401)
        return JSONResponse({"state": state, "items": []})

    async def take_over(self, request: Request) -> Response:
        await self._record(request)
        state = self._state(request.path_params["session_id"])
        if not self._owner(request) or state is None:
            return JSONResponse({"error": "not_found"}, status_code=404)
        if (await request.json()).get("generation") != state["generation"]:
            return JSONResponse({"error": "kernel", "code": "stale_generation"}, status_code=409)
        state.update(mode="owner", generation=state["generation"] + 1)
        return JSONResponse(state)

    def _state(self, session_id: str) -> dict | None:
        return next((s["state"] for s in self.sessions.values() if s["state"]["session_id"] == session_id), None)

    async def open_session(self, request: Request) -> Response:
        await self._record(request)
        if (found := self._visitor(request)) is not None:
            return JSONResponse({"state": found["state"], "resumed": True})
        token, session_id = secrets.token_urlsafe(32), f"s-{len(self.sessions) + 1}"
        state = {"session_id": session_id, "kind": "visitor", "verified": False, "assurance": "none", "mode": "ai",
                 "generation": 0}
        self.sessions[token] = {"slug": request.path_params["slug"], "state": state}
        self.events[session_id] = []
        response = JSONResponse({"state": state, "resumed": False})
        response.headers.append("set-cookie", f"desk_visitor={token}; HttpOnly; Secure; SameSite=Strict; "
                                              f"Path=/api/public/desks/{request.path_params['slug']}; Max-Age=86400")
        return response

    async def chat_session(self, request: Request) -> Response:
        await self._record(request)
        if (found := self._visitor(request)) is None:
            return JSONResponse({"error": "no_visitor_session"}, status_code=401)
        events = self.events[found["state"]["session_id"]]
        return JSONResponse({"state": found["state"], "items": [], "last_seq": len(events)})

    async def message(self, request: Request) -> Response:
        await self._record(request)
        if (found := self._visitor(request)) is None:
            return JSONResponse({"error": "no_visitor_session"}, status_code=401)
        text = (await request.json())["text"]
        self.events[found["state"]["session_id"]] += [
            {"type": "writing"},
            {"type": "message", "author": "claude", "blocks": [{"kind": "prose", "text": f"You said: {text}"}]},
            {"type": "turn_end"},
        ]
        return JSONResponse({"message_id": f"m-{secrets.token_hex(4)}"}, status_code=202)

    async def stream(self, request: Request) -> Response:
        await self._record(request)
        if (found := self._visitor(request)) is None:
            return JSONResponse({"error": "no_visitor_session"}, status_code=401)
        after = int(request.headers.get("last-event-id", "0"))
        events = self.events[found["state"]["session_id"]]

        async def body() -> AsyncIterator[str]:
            yield ": keep-alive\n\n"
            for seq, event in enumerate(events[after:], start=after + 1):
                yield f"id: {seq}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"

        return StreamingResponse(body(), media_type="text/event-stream")

    async def a2a(self, request: Request) -> Response:
        await self._record(request)
        return JSONResponse({"session_id": "a-1", "disclosure": "ai", "blocks": [], "receipts": []})

    async def elsewhere(self, request: Request) -> Response:
        await self._record(request)
        return JSONResponse({"error": "not_found"}, status_code=404)


@pytest.fixture
def stand_in() -> Iterator[tuple[StandInApi, LoopbackServer]]:
    api = StandInApi()
    server = LoopbackServer(api.app(), name="stand-in API")
    server.start()
    try:
        yield api, server
    finally:
        server.stop()


async def test_loopback_client_keeps_secure_cookies_by_path(stand_in):
    """Over plain loopback HTTP the client sends each `Secure` cookie the API set, on that
    cookie's paths only, where a standard cookie jar would send none."""
    api, server = stand_in
    async with DeskClient(server.url, PASSCODE) as client:
        copy = await client.enter()
        assert copy["desks"][0]["slug"] == SLUG
        assert client.cookies() == [("desk_owner", "/api/owner")]
        state = await client.open_chat(SLUG)
        assert sorted(client.cookies()) == [("desk_owner", "/api/owner"), ("desk_visitor", f"/api/public/desks/{SLUG}")]
        owner_view = await client.owner_session(state["session_id"])
        assert owner_view["state"]["session_id"] == state["session_id"]
        for path in ("/api/public/desks/rivera-2/session", "/api/public/desks", "/api/ownerx", "/api/health"):
            await client.http.get(path)
    assert api.sent(f"/api/owner/conversations/{state['session_id']}") == {"desk_owner"}
    assert api.sent(f"/api/public/desks/{SLUG}/session") == {"desk_visitor"}
    for path in ("/api/public/desks/rivera-2/session", "/api/public/desks", "/api/ownerx", "/api/health"):
        assert api.sent(path) == set(), path
    # A standard jar keeps the same cookies but sends none of them over plain HTTP.
    async with httpx.AsyncClient(base_url=server.url, trust_env=False) as plain:
        await plain.post("/api/owner/copies", json={"passcode": PASSCODE})
        assert (await plain.get(f"/api/owner/conversations/{state['session_id']}")).status_code == 401


async def test_no_cookie_goes_to_another_origin(stand_in):
    """The cookies the API set go to the API's origin only, never to another port on the same host."""
    api, server = stand_in
    other = StandInApi()
    other_server = LoopbackServer(other.app(), name="another origin")
    other_server.start()
    try:
        async with DeskClient(server.url, PASSCODE) as client:
            await client.enter()
            state = await client.open_chat(SLUG)
            for path in (f"/api/owner/conversations/{state['session_id']}", f"/api/public/desks/{SLUG}/session"):
                assert (await client.http.get(other_server.url + path)).status_code == 401
                assert other.sent(path) == set(), path
            assert len(other.seen) == 2
    finally:
        other_server.stop()


def test_jar_follows_path_max_age_expires_and_domain():
    copies = httpx.URL("http://127.0.0.1:8700/api/owner/copies")
    jar = LoopbackJar(origin_of(copies))
    jar.keep(copies, ["a=1; Path=/api/owner", "b=2", "c=3; Max-Age=60; Path=/api/owner",
                      "d=4; Domain=example.com; Path=/", "no-value", "=5"])
    assert sorted(jar.held()) == [("a", "/api/owner"), ("b", "/api/owner"), ("c", "/api/owner")]   # b: the default path
    jar.keep(copies, ["a=; Path=/api/owner; Max-Age=0",
                      "c=3; Path=/api/owner; Expires=Thu, 01 Jan 1970 00:00:00 GMT"])
    assert jar.held() == [("b", "/api/owner")]
    assert jar.header(httpx.URL("http://127.0.0.1:8700/api/owner/me?x=1")) == "b=2"
    assert jar.header(httpx.URL("http://127.0.0.1:8701/api/owner/me")) is None   # another port: another origin
    assert jar.header(httpx.URL("http://127.0.0.1:8700/api/public/desks/rivera/session")) is None
    jar.keep(httpx.URL("http://127.0.0.1:8701/api/owner/copies"), ["e=6; Path=/"])   # set by another origin
    assert ("e", "/") not in jar.held()


def test_jar_sends_longer_paths_first():
    url = httpx.URL("http://127.0.0.1:8700/api/public/desks/rivera/sessions")
    jar = LoopbackJar(origin_of(url))
    jar.keep(url, ["outer=1; Path=/api", "inner=2; Path=/api/public/desks/rivera", "root=3; Path=/"])
    assert jar.header(url) == "inner=2; outer=1; root=3"


async def test_a_plain_cookie_is_sent_once():
    """On loopback only the client's own jar keeps cookies, so one that isn't `Secure` isn't sent twice."""
    sent: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers.get("cookie"))
        return httpx.Response(200, json={}, headers={"set-cookie": "plain=1; Path=/"})

    async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=httpx.MockTransport(handler)) as client:
        await client.http.get("/api/health")
        await client.http.get("/api/health")
        assert list(client.http.cookies.jar) == []   # httpx's own jar keeps nothing on loopback
    assert sent == [None, "plain=1"]


async def test_https_uses_the_standard_jar():
    """On an `https` origin the standard jar keeps and sends `Secure` cookies by path itself."""
    sent: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers.get("cookie"))
        return httpx.Response(200, json={}, headers={
            "set-cookie": "desk_owner=t0ken; HttpOnly; Secure; SameSite=Strict; Path=/api/owner"})

    async with DeskClient("https://desk.example", PASSCODE, transport=httpx.MockTransport(handler)) as client:
        await client.http.post("/api/owner/copies")
        await client.http.get("/api/owner/me")
        await client.http.get(f"/api/public/desks/{SLUG}/session")
        assert client.cookies() == [("desk_owner", "/api/owner")]
    assert sent == [None, "desk_owner=t0ken", None]


async def test_events_replay_the_chat_after_the_last_event_id(stand_in):
    api, server = stand_in
    async with DeskClient(server.url, PASSCODE) as client:
        state = await client.open_chat(SLUG)
        assert (client.desk_slug, client.session_id) == (SLUG, state["session_id"])
        assert (await client.transcript())["last_seq"] == 0
        await client.send("first")
        await client.send("second")
        everything = [event async for event in client.events()]
        assert [(event.id, event.event, event.type) for event in everything] == [
            (str(seq), kind, kind) for seq, kind in enumerate(["writing", "message", "turn_end"] * 2, start=1)]
        later = [event async for event in client.events(last_event_id=3)]
        assert [event.id for event in later] == ["4", "5", "6"]
        assert later[1].data["blocks"][0]["text"] == "You said: second"
    assert [body for path, body, _ in api.bodies if path.endswith("/messages")] == [
        b'{"text":"first"}', b'{"text":"second"}']


def event_stream(text: str) -> httpx.MockTransport:
    """A transport whose every answer is `text` as a chat's event stream."""
    return httpx.MockTransport(lambda request: httpx.Response(
        200, headers={"content-type": "text/event-stream; charset=utf-8"}, text=text))


async def test_events_skip_a_keep_alive_after_an_event_with_an_id():
    """The API's keep-alive comment, sent as its SSE library frames it, reaches httpx-sse as an event with
    no data once an event has set an id, since the last event id carries over. The SSE spec never
    dispatches an event without data, and nor does the client."""
    stream = ('id: 1\r\nevent: writing\r\ndata: {"type": "writing"}\r\n\r\n'
              ": keep-alive\r\n\r\n"
              'id: 2\r\nevent: turn_end\r\ndata: {"type": "turn_end"}\r\n\r\n')
    async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=event_stream(stream)) as client:
        client.desk_slug = SLUG
        events = [event async for event in client.events()]
    assert [(event.id, event.event, event.data) for event in events] == [
        ("1", "writing", {"type": "writing"}), ("2", "turn_end", {"type": "turn_end"})]


# A page something in front of the API might send in its place: more than 80 characters, its tail past them.
NOT_JSON = "<html><body>" + "a gateway's page, not the API's answer. " * 3 + "the tail</body></html>"


def request_headers(client: DeskClient) -> tuple[str, ...]:
    """Header values every request of `client` carries from now on, made at run time: what an error must never show."""
    values = tuple(secrets.token_urlsafe(12) for _ in range(3))
    client.http.headers.update({"Authorization": f"Bearer {values[0]}", "X-Mockpay-Key": values[1],
                                "X-Desk-Copy": values[2]})
    return values


async def test_an_answer_that_isnt_json_raises_naming_the_call_status_and_content_type():
    """A 2xx answer an operation reads as JSON, with a body that isn't JSON, fails the call as an `ApiCallFailed`
    whose message names the operation, the status, the content type and the body's first 80 characters, and
    never a header or cookie the request carried, nor what the request sent."""
    cookie, said = secrets.token_urlsafe(12), secrets.token_urlsafe(12)

    def handler(request: httpx.Request) -> httpx.Response:
        set_cookie = {"set-cookie": f"desk_visitor={cookie}; Secure; Path=/api/public/desks/{SLUG}"}
        if request.url.path.endswith("/sessions"):
            return httpx.Response(200, json={"state": {}, "resumed": False}, headers=set_cookie)
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8", **set_cookie}, text=NOT_JSON)

    refusals = []
    async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=httpx.MockTransport(handler)) as client:
        held = request_headers(client)
        for call in (client.enter, lambda: client.open_chat(SLUG), lambda: client.send(said)):
            with pytest.raises(ApiCallFailed) as refused:
                await call()
            refusals.append(refused.value)
    assert [(refused.op, refused.status) for refused in refusals] == [
        ("enter", 200), ("chat_session", 200), ("send", 200)]   # open_chat reads its session: that answer failed
    for refused in refusals:
        assert str(refused) == (f"{refused.op} answered 200 (text/html; charset=utf-8) with a body that isn't JSON: "
                                f"{NOT_JSON[:80]!r}")
        for value in (*held, cookie, said, PASSCODE, "the tail"):
            assert value not in str(refused), refused.op


async def test_an_owner_write_whose_answer_isnt_json_raises_the_same_way():
    """An owner write that may prove reads its answer as JSON, whether a 202 to re-send or its final one."""
    for status in (202, 201):
        transport = httpx.MockTransport(lambda request: httpx.Response(status, text=NOT_JSON))
        async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=transport) as owner:
            held = request_headers(owner)
            with pytest.raises(ApiCallFailed) as refused:
                await owner.owner_whisper("s-1", "Say the deposit is waived.")
        assert str(refused.value) == (f"owner_whisper answered {status} (text/plain; charset=utf-8) with a body that "
                                      f"isn't JSON: {NOT_JSON[:80]!r}"), status
        for value in (*held, "Say the deposit", "the tail"):
            assert value not in str(refused.value), status


async def test_an_event_that_isnt_json_raises_naming_the_stream_status_and_content_type():
    """An event with data that isn't JSON fails the read as an `ApiCallFailed` naming the stream, its status and
    content type and the data's first 80 characters; what the request carried, Last-Event-ID included, never
    shows."""
    stream = ('id: 1\r\nevent: writing\r\ndata: {"type": "writing"}\r\n\r\n'
              f"id: 2\r\nevent: message\r\ndata: {NOT_JSON}\r\n\r\n")
    last_event_id = secrets.token_urlsafe(12)
    seen = []
    async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=event_stream(stream)) as client:
        held = request_headers(client)
        client.desk_slug = SLUG
        with pytest.raises(ApiCallFailed) as refused:
            async for event in client.events(last_event_id):
                seen.append(event.data)
    assert seen == [{"type": "writing"}]
    assert (refused.value.op, refused.value.status) == ("events", 200)
    assert str(refused.value) == (f"events answered 200 (text/event-stream; charset=utf-8) with an event that isn't "
                                  f"JSON: {NOT_JSON[:80]!r}")
    for value in (*held, last_event_id, "the tail"):
        assert value not in str(refused.value)


async def test_a_refusal_whose_body_isnt_json_names_its_content_type_and_shows_80_characters():
    """A refusal keeps its status, so every caller judges it as before. A JSON body is kept and shown as it came,
    since callers read its error code; one that isn't JSON is named by its content type with at most its first
    80 characters shown, and never a header or anything the request carried."""
    error = {"error": "kernel", "code": "invalid", "detail": "That code isn't the one sent to the contact on record."}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/verify/check"):
            return httpx.Response(422, json=error)
        return httpx.Response(502, headers={"content-type": "text/html; charset=utf-8"}, text=NOT_JSON)

    said = secrets.token_urlsafe(12)
    refusals = {}
    async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=httpx.MockTransport(handler)) as client:
        held = request_headers(client)
        client.desk_slug = SLUG

        async def read_events() -> None:
            async for _ in client.events():
                pass

        for op, call in (("send", lambda: client.send(said)), ("events", read_events),
                         ("owner_whisper", lambda: client.owner_whisper("s-1", said)),
                         ("verify_check", lambda: client.verify_check("482913"))):
            with pytest.raises(ApiCallFailed) as refused:
                await call()
            refusals[op] = refused.value
    for op in ("send", "events", "owner_whisper"):
        refused = refusals[op]
        assert (type(refused), refused.op, refused.status, refused.body) == (ApiCallFailed, op, 502, NOT_JSON[:80])
        assert str(refused) == (f"{op} answered 502 (text/html; charset=utf-8) with a body that isn't JSON: "
                                f"{NOT_JSON[:80]!r}")
        for value in (*held, said, "the tail"):
            assert value not in str(refused), op
    refused = refusals["verify_check"]
    assert (type(refused), refused.status, refused.body) == (ApiCallFailed, 422, error)
    assert str(refused) == f"verify_check answered 422: {json.dumps(error)}"
    assert "482913" not in str(refused)


async def test_a_refused_call_raises_with_its_status_and_body(stand_in):
    """An operation that needs success fails with the API's status and body, and never shows a cookie."""
    api, server = stand_in
    async with DeskClient(server.url, PASSCODE) as visitor, DeskClient(server.url, "a wrong passcode") as stranger:
        await visitor.open_chat(SLUG)
        token = next(iter(api.sessions))
        stranger.desk_slug = SLUG   # a chat it never opened: it holds no cookie for it
        with pytest.raises(ApiCallFailed, match="events answered 401") as refused:
            async for _ in stranger.events():
                pass
        assert (refused.value.status, refused.value.body) == (401, {"error": "no_visitor_session"})
        with pytest.raises(ApiCallFailed, match="enter answered 401"):
            await stranger.enter()
        with pytest.raises(ApiCallFailed, match="owner_session answered 401") as refused:
            await visitor.owner_session(visitor.session_id)
        assert token not in str(refused.value)
    async with DeskClient(server.url, PASSCODE) as nobody:
        with pytest.raises(RuntimeError, match="open_chat"):
            await nobody.send("hello")


async def test_owner_take_over_sends_the_current_generation(stand_in):
    api, server = stand_in
    async with DeskClient(server.url, PASSCODE) as owner, DeskClient(server.url, PASSCODE) as visitor:
        await owner.enter()
        state = await visitor.open_chat(SLUG)
        taken = await owner.owner_take_over(state["session_id"])
        assert (taken["mode"], taken["generation"]) == ("owner", 1)
        assert (await owner.owner_take_over(state["session_id"]))["generation"] == 2
        with pytest.raises(ApiCallFailed, match="owner_take_over answered 409"):
            await owner.owner_take_over(state["session_id"], generation=0)
    sent = [json.loads(body) for path, body, _ in api.bodies if path.endswith("/takeover")]
    assert sent == [{"generation": 0}, {"generation": 1}, {"generation": 0}]


async def test_a2a_posts_the_signed_body_as_is(stand_in):
    """An agent's request goes out byte for byte as signed, with its signature headers and no cookie."""
    api, server = stand_in
    body = b'{"desk_slug": "rivera", "session_id": null, "message": "Hello"}'
    signed = {"X-Agent-Key-Id": "key-1", "X-Agent-Ts": "2026-11-03T18:00:00.000000Z", "X-Agent-Nonce": "n-1",
              "X-Agent-Sig": "ab" * 64}
    async with DeskClient(server.url, PASSCODE) as client:
        await client.enter()
        response = await client.a2a(SLUG, body, signed)
    assert response.status_code == 200
    [(sent, headers)] = [(sent, headers) for path, sent, headers in api.bodies if path == f"/api/a2a/{SLUG}"]
    assert sent == body
    assert {name: headers[name.lower()] for name in signed} == signed
    assert headers["content-type"] == "application/json"
    assert "cookie" not in headers


async def test_fetch_document_takes_only_a_document_link(stand_in):
    api, server = stand_in
    async with DeskClient(server.url, PASSCODE) as client:
        response = await client.fetch_document("/api/d/AbC-12_x")
        assert response.status_code == 404   # the stand-in has no documents: the answer is the caller's to judge
        for href in ("", "/api/d/", "/pay/AbC", "https://desk.example/api/d/AbC", "/api/d/AbC/more", "/api/d/AbC?x=1",
                     None):
            with pytest.raises(ValueError, match="href") as refused:
                await client.fetch_document(href)
            assert "AbC" not in str(refused.value)
    assert [path for _, path, _ in api.seen] == ["/api/d/AbC-12_x"]


async def test_request_adds_the_routes_fixed_query():
    """`owner_ledger` asks for the verified ledger, and a case's own query goes with it."""
    asked: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(request.url)
        return httpx.Response(200, json={"entries": [], "head": "0" * 64, "chain_ok": True})

    async with DeskClient("http://127.0.0.1:8700", PASSCODE, transport=httpx.MockTransport(handler)) as client:
        await client.owner_ledger("d 1")
        await client.request("owner_ledger", params={"desk_id": "d-1"}, query={"session_id": "s-2"})
    assert [(url.raw_path, dict(url.params)) for url in asked] == [
        (b"/api/owner/desks/d%201/ledger?verify=true", {"verify": "true"}),
        (b"/api/owner/desks/d-1/ledger?verify=true&session_id=s-2", {"verify": "true", "session_id": "s-2"}),
    ]
