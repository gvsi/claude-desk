"""The typed kernel client: one credential per view, bodies typed by route, errors by KernelError code."""

import asyncio
import contextlib
import dataclasses
from collections.abc import Callable

import httpx
import pytest

from desk.api.kernel_client import KernelFailed, KernelHttp, KernelUnavailable, assert_production_safe
from desk.api.settings import Settings
from desk.contracts import AgentAuth, LedgerPage, PolicyVersion, SessionCreated, SessionState
from desk.kernel_api import (
    CreateCopyRequest,
    CreateSessionRequest,
    DeskCharterRequest,
    DeskAnsweringRequest,
    DeskUpdated,
    Health,
    ModeRequest,
    PolicyDraftRequest,
    PolicyProbeRequest,
    VerifyCheckRequest,
    WhoAmI,
)

BASE_URL = "http://127.0.0.1:8701"
STATE = SessionState(session_id="s1", kind="visitor", verified=False, assurance="none", mode="ai", generation=0)
WHOAMI = WhoAmI(kind="visitor", copy_id="c1", desk_id="d1", desk_ids=["d1"], session=STATE)
HEALTH = Health(version="0.1.0", proof_mode="symcc", dev_signing_key=True, public_key_hex="ab" * 32, key_id="k1",
                unproved_seeds=[])
# What the scripted kernel answers on each path, unless a test scripts another answer.
ANSWERS: dict[str, object] = {
    "/whoami": WHOAMI.model_dump(mode="json"),
    "/health": HEALTH.model_dump(mode="json"),
    "/verify/check": STATE.model_dump(mode="json"),
    "/desks/d%2F1/answering": DeskUpdated(desk_id="d/1",
                                          updated_at="2026-10-30T17:04:05Z").model_dump(mode="json"),
    "/sessions": SessionCreated(state=STATE.model_copy(update={"kind": "agent"}), session_token=None).model_dump(mode="json"),
    "/policy/draft": PolicyVersion(desk_id="d1", version=3, parent_version=2, cards=[], cedar_sha256="1" * 64,
                                   schema_sha256="2" * 64, baseline_sha256="3" * 64, profiles_sha256="4" * 64,
                                   invariants_sha256="5" * 64, review_thresholds_version=1,
                                   status="proved").model_dump(mode="json"),
    "/policy/3/probe": [],
    "/ledger/d1": LedgerPage(entries=[], head="0" * 64, chain_ok=True, first_bad_seq=None, public_key_hex="ab" * 32,
                             key_id="k1").model_dump(mode="json"),
}
CREDENTIAL_HEADERS = ("x-session-token", "x-owner-session", "x-agent-key-id", "x-agent-ts", "x-agent-nonce",
                      "x-agent-sig", "x-agent-body-sha256", "cookie", "authorization")


class ScriptedKernel:
    """A kernel behind httpx.MockTransport: records every request and answers from ANSWERS or a script.

    Every answer also tries to set a cookie, which the client must never store or send back.
    """

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.script: Callable[[httpx.Request], httpx.Response] | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.script is not None:
            return self.script(request)
        path = request.url.raw_path.decode().partition("?")[0]
        return httpx.Response(200, json=ANSWERS[path], headers={"set-cookie": "kernel=1; Path=/"})

    def fail(self, answer: httpx.Response | Exception | Callable) -> None:
        """Answer every request with `answer`: a response, an exception to raise, or a coroutine function."""
        def script(request: httpx.Request):
            if isinstance(answer, Exception):
                raise answer
            return answer(request) if callable(answer) else answer
        self.script = script

    def client(self, **kwargs) -> KernelHttp:
        return KernelHttp(BASE_URL, transport=httpx.MockTransport(self.handler), **kwargs)


def credentials(request: httpx.Request) -> dict[str, str]:
    return {name: request.headers[name] for name in CREDENTIAL_HEADERS if name in request.headers}


async def test_session_client_sends_only_the_session_token():
    kernel = ScriptedKernel()
    async with kernel.client() as http:
        session = http.session("session-token-1")
        http.owner("owner-token-1")                       # a view made alongside never lends its credential
        assert await session.whoami() == WHOAMI
        assert await session.call("POST /verify/check", VerifyCheckRequest(session_id="s1", code="123456")) == STATE
    assert [request.url.path for request in kernel.requests] == ["/whoami", "/verify/check"]
    for request in kernel.requests:
        assert credentials(request) == {"x-session-token": "session-token-1"}


async def test_public_policy_refusal_detail_reaches_the_caller():
    kernel = ScriptedKernel()
    fields = {"policy:pricing": ["digit", "percent_sign"], "policy:about": ["lex.en.promise"]}
    kernel.fail(httpx.Response(422, json={"code": "invalid", "detail": fields}))
    async with kernel.client() as http:
        with pytest.raises(KernelFailed) as refused:
            await http.owner("owner-token").call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[]),
                                                path={"id": "d1"})
    assert (refused.value.status, refused.value.code, refused.value.detail) == (422, "invalid", fields)
    assert str(refused.value) == "kernel answered 422 invalid"


@pytest.mark.parametrize("body", [{"code": "invalid"}, {"code": "invalid", "detail": None}],
                         ids=["no-detail", "null-detail"])
async def test_a_refusal_without_detail_reaches_the_caller_with_an_empty_detail(body):
    kernel = ScriptedKernel()
    kernel.fail(httpx.Response(422, json=body))
    async with kernel.client() as http:
        with pytest.raises(KernelFailed) as refused:
            await http.owner("owner-token").call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[]),
                                                path={"id": "d1"})
    assert (refused.value.status, refused.value.code, refused.value.detail) == (422, "invalid", {})


def test_kernel_failed_takes_detail_by_keyword_and_never_holds_none():
    assert KernelFailed(409, "conflict").detail == {}
    assert KernelFailed(422, "invalid", detail=None).detail == {}
    detail = {"contact": ["contact_format"]}
    assert KernelFailed(422, "invalid", detail=detail).detail == detail
    with pytest.raises(TypeError):
        KernelFailed(422, "invalid", {"contact": ["contact_format"]})


async def test_owner_client_sends_only_the_owner_token():
    kernel = ScriptedKernel()
    async with kernel.client() as http:
        owner = http.owner("owner-token-1")
        http.session("session-token-1")
        assert await owner.whoami() == WHOAMI
        updated = await owner.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True), path={"id": "d/1"})
        assert updated.desk_id == "d/1"
        # The route's fixed query value always goes; a None value means the parameter is absent.
        page = await owner.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": "d1"},
                                query={"verify": "false", "after": None})
        assert page.chain_ok is True
    answering, ledger = kernel.requests[1:]
    assert (answering.method, answering.url.raw_path) == ("PUT", b"/desks/d%2F1/answering")
    assert answering.content == b'{"on":true}'
    assert answering.headers["content-type"] == "application/json"
    assert (ledger.method, ledger.url.raw_path) == ("GET", b"/ledger/d1?verify=true")
    for request in kernel.requests:
        assert credentials(request) == {"x-owner-session": "owner-token-1"}


async def test_agent_client_forwards_the_signature_and_no_token():
    kernel = ScriptedKernel()
    auth = AgentAuth(agent_key_id="key-1", ts="2026-10-30T17:04:05.123000Z", nonce="nonce-1", sig="cd" * 64)
    body_sha256 = "0f" * 32
    async with kernel.client() as http:
        agent = http.agent(auth, body_sha256)
        assert await agent.whoami(session_id="s1") == WHOAMI
        created = await agent.call("POST /sessions",
                                   CreateSessionRequest(desk_slug="rivera-plumbing-abc123", kind="agent"))
        assert created.session_token is None
        with pytest.raises(ValueError):
            http.agent(auth, body_sha256.upper())               # lowercase hex sha256 only
        with pytest.raises(ValueError):
            http.agent(auth.model_copy(update={"nonce": "n\r\nx-owner-session: t"}), body_sha256)
        with pytest.raises(TypeError):
            http.agent(auth.model_dump(), body_sha256)          # an AgentAuth, never loose headers
    assert kernel.requests[0].url.raw_path == b"/whoami?session_id=s1"
    for request in kernel.requests:
        assert credentials(request) == {
            "x-agent-key-id": "key-1", "x-agent-ts": "2026-10-30T17:04:05.123000Z", "x-agent-nonce": "nonce-1",
            "x-agent-sig": "cd" * 64, "x-agent-body-sha256": body_sha256,
        }


class LooseVerifyCheck(VerifyCheckRequest):
    """A subclass could carry fields the route's model doesn't have."""


async def test_body_must_be_the_routes_model():
    kernel = ScriptedKernel()
    check = VerifyCheckRequest(session_id="s1", code="123456")
    async with kernel.client() as http:
        session = http.session("session-token-1")
        for body in (ModeRequest(mode="ai", generation=0), check.model_dump(), None,
                     LooseVerifyCheck(session_id="s1", code="123456")):
            with pytest.raises(TypeError):
                await session.call("POST /verify/check", body)
        with pytest.raises(TypeError):
            await session.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True))     # no path
        with pytest.raises(TypeError):
            await session.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True), path={"desk": "d1"})
        with pytest.raises(ValueError):
            await session.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True), path={"id": ".."})
        with pytest.raises(ValueError):
            await session.call("POST /principal", CreateCopyRequest())                       # not a kernel route
    assert kernel.requests == []


async def test_bodyless_routes_take_no_body():
    kernel = ScriptedKernel()
    async with kernel.client() as http:
        assert await http.public().call("GET /health") == HEALTH
        assert await http.session("session-token-1").whoami() == WHOAMI
        sent = len(kernel.requests)
        with pytest.raises(TypeError):
            await http.session("session-token-1").call("GET /whoami", CreateCopyRequest())
        with pytest.raises(TypeError):
            await http.public().call("GET /health", CreateCopyRequest())
        with pytest.raises(TypeError):     # document bytes are single use: only stream() may fetch them
            await http.public().call("GET /document_links/{token}", path={"token": "link-token-1"})
        with pytest.raises(TypeError):
            async with http.public().stream("GET /health", {}):
                pass
        assert len(kernel.requests) == sent == 2
        kernel.script = lambda request: httpx.Response(200, content=b"%PDF-1.7 invoice",
                                                       headers={"content-type": "application/pdf"})
        async with http.public().stream("GET /document_links/{token}", {"token": "link-token-1"}) as document:
            assert document.headers["content-type"] == "application/pdf"
            assert b"".join([chunk async for chunk in document.aiter_bytes()]) == b"%PDF-1.7 invoice"
    assert kernel.requests[-1].url.raw_path == b"/document_links/link-token-1"
    assert all(request.content == b"" and "content-type" not in request.headers for request in kernel.requests)


def kernel_error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, json={"code": code})


async def slow(request: httpx.Request) -> httpx.Response:
    await asyncio.sleep(1)
    return httpx.Response(200, json=ANSWERS["/whoami"])


async def test_errors_carry_kernel_error_codes():
    unavailable = [   # (answer, status, code) of the KernelUnavailable each raises
        (httpx.ReadTimeout("timed out"), None, None),
        (httpx.ConnectError("connection refused"), None, None),
        (slow, None, None),                                    # past the client's deadline
        (kernel_error(500, "internal"), 500, "internal"),
        (httpx.Response(503), 503, None),
        (kernel_error(502, "auth"), 502, None),                # a 5xx keeps only a 5xx code
        (kernel_error(422, "internal"), 422, "internal"),      # a 4xx naming a kernel fault is a kernel fault
        (httpx.Response(401, content=b"<html>proxy</html>"), 401, None),
        (kernel_error(409, "no_such_code"), 409, None),
        (httpx.Response(200, json={"kind": "visitor"}), 200, None),   # a body the route's model refuses
        (httpx.Response(302, headers={"location": "http://169.254.170.2/"}), 302, None),
    ]
    failed = [   # (status, code, the one property it sets)
        (401, "auth", "ends_session"), (404, "not_found", "ends_session"), (409, "closed", "ends_session"),
        (409, "stale_generation", "silent"), (409, "mode_owner", "silent"), (409, "mode_paused", "silent"),
        (409, "conflict", "refuses_call"), (400, "invalid", "refuses_call"), (422, "invalid", "refuses_call"),
        (429, "rate_limited", "refuses_call"), (409, "replayed", "turn_over"),
    ]
    kernel = ScriptedKernel()
    async with kernel.client(timeout_s=0.05) as http:
        session = http.session("session-token-1")
        for answer, status, code in unavailable:
            kernel.fail(answer)
            with pytest.raises(KernelUnavailable) as caught:
                await session.whoami()
            assert (caught.value.route, caught.value.status, caught.value.code) == ("GET /whoami", status, code), answer
        for status, code, kind in failed:
            kernel.fail(kernel_error(status, code))
            for attempt in (session.whoami(), http.public().stream("GET /document_links/{token}", {"token": "t"})):
                with pytest.raises(KernelFailed) as caught:
                    if isinstance(attempt, contextlib.AbstractAsyncContextManager):
                        async with attempt:
                            pass
                    else:
                        await attempt
                assert (caught.value.status, caught.value.code) == (status, code)
                kinds = {name for name in ("ends_session", "silent", "refuses_call", "turn_over")
                         if getattr(caught.value, name)}
                assert kinds == {kind}, code
        kernel.fail(httpx.ConnectError("connection refused"))
        with pytest.raises(KernelUnavailable) as caught:
            async with http.public().stream("GET /document_links/{token}", {"token": "t"}):
                pass
        assert (caught.value.route, caught.value.status) == ("GET /document_links/{token}", None)


async def test_kernel_unavailable_keeps_the_kernels_code():
    kernel = ScriptedKernel()
    kernel.fail(kernel_error(503, "seed_unproved"))
    async with kernel.client() as http:
        with pytest.raises(KernelUnavailable) as caught:
            await http.owner("owner-token-1").whoami()
    assert (caught.value.route, caught.value.status, caught.value.code) == ("GET /whoami", 503, "seed_unproved")


async def test_proving_routes_get_60_s():
    kernel = ScriptedKernel()
    async with kernel.client() as http:
        owner = http.owner("owner-token-1")
        await owner.call("POST /policy/draft", PolicyDraftRequest(desk_id="d1", cards=[], expected_parent=2))
        await owner.call("POST /policy/{version}/probe", PolicyProbeRequest(desk_id="d1", probes=[]),
                         path={"version": 3})
        await owner.whoami()
    timeouts = [request.extensions["timeout"] for request in kernel.requests]
    assert timeouts == [dict.fromkeys(("connect", "read", "write", "pool"), seconds) for seconds in (60.0, 60.0, 6.0)]

    async with kernel.client(timeout_s=0.05) as http:      # the overall deadline moves with the route's timeout too
        kernel.fail(lambda request: asyncio.sleep(0.2, httpx.Response(200, json=[])))
        assert await http.owner("owner-token-1").call(
            "POST /policy/{version}/probe", PolicyProbeRequest(desk_id="d1", probes=[]), path={"version": 3}) == []


async def test_reply_check_gets_10_s_without_changing_other_routes(monkeypatch):
    from desk.api import kernel_client
    from desk.contracts import ReplyDraft
    from desk.kernel_api import CheckReplyRequest

    assert kernel_client.REPLY_CHECK_TIMEOUT_S == 12.0
    kernel = ScriptedKernel()
    # An unusable answer still records the request's transport timeout.
    kernel.fail(httpx.Response(503))
    async with kernel.client() as http:
        for route, body in [("POST /check_reply", CheckReplyRequest(
                draft=ReplyDraft(session_id="s1", generation=0, prose="Hello.", clauses=[]))),
                            ("GET /whoami", None)]:
            with pytest.raises(KernelUnavailable):
                await http.session("session-token-1").call(route, body)
    assert [request.extensions["timeout"]["read"] for request in kernel.requests] == [12.0, 6.0]

    # Exercise the outer deadline over an in-process transport too, without a ten-second sleep.
    monkeypatch.setattr(kernel_client, "REPLY_CHECK_TIMEOUT_S", 0.02)
    kernel.fail(lambda request: asyncio.sleep(0.1, httpx.Response(503)))
    async with kernel.client(timeout_s=1) as http:
        with pytest.raises(KernelUnavailable) as caught:
            await http.session("session-token-1").call("POST /check_reply", CheckReplyRequest(
                draft=ReplyDraft(session_id="s1", generation=0, prose="Hello.", clauses=[])))
    assert caught.value.status is None


async def asgi_kernel(scope, receive, send):
    """An in-process kernel, as FakeKernel will be: fine for tests, refused in production."""
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": b"{}"})


async def test_production_refuses_a_non_http_kernel_client():
    development = Settings(api_database_url="postgresql+psycopg://desk_api@localhost/desk")
    production = dataclasses.replace(development, desk_env="production", anthropic_api_key="k", passcode_hash="h",
                                     public_origin="https://desk.example.com")
    in_process = KernelHttp(BASE_URL, transport=httpx.ASGITransport(app=asgi_kernel))
    network = KernelHttp(BASE_URL)
    assert_production_safe(development, in_process)                  # tests and local runs may use the fake
    assert_production_safe(production, network)                      # the kernel process on loopback

    refused = [
        (production, in_process),
        (production, KernelHttp(BASE_URL, transport=httpx.MockTransport(ScriptedKernel().handler))),
        (production, KernelHttp(BASE_URL, transport=httpx.AsyncHTTPTransport())),   # not the client's own
        (production, KernelHttp("http://localhost:8701")),
        (production, KernelHttp("http://10.0.0.5:8701")),
        (production, KernelHttp("https://127.0.0.1:8701")),
        (dataclasses.replace(production, kernel_ro_schema="fake_kernel_ro"), network),
        (production, object()),                                      # anything shaped like a client
    ]
    for settings, http in refused:
        with pytest.raises(RuntimeError):
            assert_production_safe(settings, http)
    for http in {http for _, http in refused if isinstance(http, KernelHttp)} | {in_process, network}:
        await http.aclose()
