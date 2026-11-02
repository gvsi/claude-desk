"""Demo copies behind the passcode: the owner cookie, copy scoping from /whoami, the per-IP limits, production's
refusals and the health check."""

import dataclasses
import hashlib
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import APIRouter, Depends, FastAPI, Request, Response
from procrastinate.testing import InMemoryConnector

from desk.api.agents import a2a_client
from desk.api.cookies import clear_visitor_cookie, set_owner_cookie, set_visitor_cookie
from desk.api.deps import SHARED_BUCKET, ApiProblem, OwnerCtx, client_ip, owner_ctx, public_origin, require_model_budget
from desk.api.main import app_factory, create_app
from desk.api.metrics import DAILY_MODEL_BUDGET_CENTS, record_model_call
from desk.api.passcode import check_passcode
from desk.api.ro import KernelRO
from desk.api.schemas import CopyOut, DeskSummary
from desk.api.settings import Settings
from desk.kernel_api import Health
from tests.api.conftest import BACKEND, PASSCODE
from tests.kernel_contract.fake_kernel import fake_kernel_app
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA


async def test_health_reports_the_kernel(api, browser, fake):
    client = browser(api)
    response = await client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert Health.model_validate(body["kernel"]) == Health(version="fake", proof_mode="symcc", dev_signing_key=True,
                                                            public_key_hex=body["kernel"]["public_key_hex"],
                                                            key_id=body["kernel"]["key_id"], unproved_seeds=[])
    assert "set-cookie" not in response.headers
    assert [set(call.headers) & {"x-owner-session", "x-session-token"} for call in fake.called("/health")] == [set()]

    for failure in ("connect", "timeout", "500"):          # the kernel down or failing: 503, and no kernel field
        fake.fail("/health", failure, times=1)
        response = await client.get("/api/health")
        assert (response.status_code, response.json()) == (503, {"ok": False, "kernel": None})
    assert (await client.get("/api/health")).status_code == 200


async def test_wrong_passcode_is_401_and_creates_nothing(api, browser, fake):
    client = browser(api)
    for body in ({"passcode": "rivera-demo-passcod"}, {"passcode": PASSCODE + " "}, {"passcode": "x" * 200}):
        response = await client.post("/api/owner/copies", json=body)
        assert (response.status_code, response.json()) == (401, {"error": "wrong_passcode"})
        assert "set-cookie" not in response.headers
    for body in ({}, {"passcode": ""}, {"passcode": 7}, {"passcode": "x" * 201}, {"passcode": PASSCODE, "copy_id": "c"}):
        response = await client.post("/api/owner/copies", json=body)
        assert (response.status_code, response.json()) == (422, {"error": "invalid"})   # nothing sent is echoed
    assert fake.called("POST /copies") == [] and fake.copies == {}
    assert client.cookies.jar.__len__() == 0


async def test_no_passcode_hash_admits_no_one(fake, browser, api_settings, db):
    app = create_app(dataclasses.replace(api_settings, passcode_hash=None),
                     kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)),
                     jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        response = await browser(app).post("/api/owner/copies", json={"passcode": PASSCODE})
    assert (response.status_code, response.json()) == (401, {"error": "wrong_passcode"})
    assert fake.copies == {}


def owner_session_of(fake, token: str) -> str | None:
    """The owner session `token` names in FakeKernel, if any."""
    session_id = fake._token_hashes.get(hashlib.sha256(token.encode()).hexdigest())
    return session_id if session_id and fake.sessions[session_id].kind == "owner" else None


async def test_copy_sets_the_scoped_owner_cookie(api, browser, fake):
    client = browser(api)
    response = await client.post("/api/owner/copies", json={"passcode": PASSCODE})
    assert response.status_code == 201

    (header,) = response.headers.get_list("set-cookie")              # one cookie: the owner token, alone
    name_value, *attributes = [part.strip() for part in header.split(";")]
    name, _, token = name_value.partition("=")
    assert name == "desk_owner"
    assert sorted(attributes) == sorted(["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/owner", "Max-Age=604800"])
    (copy,) = fake.copies.values()
    assert owner_session_of(fake, token) == copy.owner_session_id     # the kernel's owner token, unchanged

    body = response.json()
    assert token not in response.text
    desk = fake.desks[copy.desk_ids[0]]
    assert CopyOut.model_validate(body) == CopyOut(copy_id=copy.copy_id, desks=[DeskSummary(
        desk_id=desk.desk_id, slug=desk.slug, name="Main line", business_name="Turner Plumbing", hours=desk.hours,
        answering=True, setup=None, business_type="rivera")])
    assert [call.headers.get("x-owner-session") for call in fake.called("GET /whoami")] == [token]
    assert all("x-owner-session" not in call.headers for call in fake.called("POST /copies"))

    # The browser sends the cookie back on owner paths only.
    me = await client.get("/api/owner/me")
    assert (me.status_code, me.json()) == (200, body)
    assert me.request.headers["cookie"] == f"desk_owner={token}"
    assert fake.called("GET /whoami")[-1].headers["x-owner-session"] == token
    for path in ("/api/health", "/api/ownerx/me", "/api/public/desks/x/session", "/"):
        assert "cookie" not in (await client.get(path)).request.headers, path


def desk_probe(app: FastAPI) -> None:
    """A route shaped like the owner's Desk routes (Task 9's `desks/{desk_id}/…`), reading through `OwnerCtx` the way
    they do, so copy scoping is tested before those routes exist."""
    probe = APIRouter()

    @probe.get("/api/owner/desks/{desk_id}/probe")
    async def read_desk(desk_id: str, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> dict:
        return {"desks": [row["name"] for row in await ctx.ro.rows("desks", desk_id=ctx.desk(desk_id))]}

    app.include_router(probe)


async def test_copy_comes_only_from_whoami(api, browser, fake, engine):
    desk_probe(api)
    owner_a, owner_b = browser(api), browser(api)
    copy_a = (await owner_a.post("/api/owner/copies", json={"passcode": PASSCODE})).json()
    copy_b = (await owner_b.post("/api/owner/copies", json={"passcode": PASSCODE})).json()
    desk_a, desk_b = copy_a["desks"][0]["desk_id"], copy_b["desks"][0]["desk_id"]

    own = await owner_a.get(f"/api/owner/desks/{desk_a}/probe")
    assert (own.status_code, own.json()) == (200, {"desks": ["Main line"]})
    for path in (f"/api/owner/desks/{desk_b}/probe", f"/api/owner/desks/{desk_b}/probe?copy_id={copy_b['copy_id']}",
                 "/api/owner/desks/no-such-desk/probe"):
        response = await owner_a.get(path)
        assert (response.status_code, response.json()) == (404, {"error": "not_found"}), path

    # IDs in the query are never read: copy A's cookie reads copy A, whatever the browser names.
    for query in (f"?copy_id={copy_b['copy_id']}", f"?desk_id={desk_b}", f"?session_id={fake.copies[copy_b['copy_id']].owner_session_id}"):
        response = await owner_a.get("/api/owner/me" + query)
        assert (response.status_code, response.json()) == (200, copy_a), query
    assert desk_b not in str([call.query for call in fake.called("GET /whoami")])

    # And below OwnerCtx.desk, the copy's reads find nothing of another copy's.
    async with engine.connect() as conn:
        assert await KernelRO(conn, copy_a["copy_id"], FAKE_RO_SCHEMA).rows("desks", desk_id=desk_b) == []


class EndedOwnerSessions(httpx.AsyncBaseTransport):
    """FakeKernel, except that `/whoami` answers the given kernel code for the tokens in `ended` (the fake's owner
    sessions never close, while the real kernel's can)."""

    def __init__(self, fake, ended: dict[str, tuple[int, str]]):
        self._inner = httpx.ASGITransport(app=fake_kernel_app(fake))
        self.ended = ended

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        answer = self.ended.get(request.headers.get("x-owner-session", ""))
        if request.url.path == "/whoami" and answer is not None:
            return httpx.Response(answer[0], json={"code": answer[1]})
        return await self._inner.handle_async_request(request)


async def test_closed_or_unknown_token_is_401(fake, browser, api_settings, clock, db):
    transport = EndedOwnerSessions(fake, {})
    app = create_app(api_settings, kernel_transport=transport, clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        client = browser(app)
        no_session = (401, {"error": "no_owner_session"})

        response = await client.get("/api/owner/me")                                 # no cookie: no kernel call
        assert (response.status_code, response.json()) == no_session
        assert fake.called("GET /whoami") == []

        unknown = "A" * 43                                                           # shaped like a token, known to no one
        for token in (unknown, "not a token", "x"):
            response = await client.get("/api/owner/me", headers={"cookie": f"desk_owner={token}"})
            assert (response.status_code, response.json()) == no_session, token

        created = await client.post("/api/owner/copies", json={"passcode": PASSCODE})
        token = client.cookies["desk_owner"]
        assert (await client.get("/api/owner/me")).json() == created.json()
        for status, code in ((409, "closed"), (404, "not_found"), (401, "auth")):    # every code that ends a session
            transport.ended[token] = (status, code)
            response = await client.get("/api/owner/me")
            assert (response.status_code, response.json()) == no_session, code

        transport.ended[token] = (503, "internal")                                   # the kernel failing isn't an ended session
        response = await client.get("/api/owner/me")
        assert (response.status_code, response.json()) == (503, {"error": "kernel", "code": "internal"})
        fake.fail("/whoami", "connect")
        transport.ended.clear()
        response = await client.get("/api/owner/me")
        assert (response.status_code, response.json()) == (503, {"error": "kernel", "code": "kernel_unavailable"})


async def test_start_over_issues_a_new_copy(api, browser, fake):
    client = browser(api)
    response = await client.post("/api/owner/start_over")                         # no copy yet: no passcode bypass
    assert (response.status_code, response.json()) == (401, {"error": "no_owner_session"})
    assert fake.copies == {}

    first = (await client.post("/api/owner/copies", json={"passcode": PASSCODE})).json()
    first_token = client.cookies["desk_owner"]
    response = await client.post("/api/owner/start_over")
    assert response.status_code == 200
    second = response.json()
    assert second["copy_id"] != first["copy_id"] and set(fake.copies) == {first["copy_id"], second["copy_id"]}
    assert second["desks"][0]["desk_id"] not in {desk["desk_id"] for desk in first["desks"]}
    assert second["desks"][0]["business_name"] == "Turner Plumbing"

    (header,) = response.headers.get_list("set-cookie")
    assert header.startswith("desk_owner=") and "Path=/api/owner;" in header
    second_token = client.cookies["desk_owner"]
    assert second_token != first_token and second_token not in response.text
    assert owner_session_of(fake, second_token) == fake.copies[second["copy_id"]].owner_session_id
    assert (await client.get("/api/owner/me")).json() == second                  # the cookie now names the new copy

    # The old copy is left behind, not reachable from the new cookie.
    old = browser(api)
    old.cookies.set("desk_owner", first_token, domain="desk.test", path="/api/owner")
    assert (await old.get("/api/owner/me")).json() == first


async def test_passcode_attempts_are_limited(api, browser, fake, clock):
    client = browser(api)
    wrong = {"passcode": "guess"}
    for _ in range(29):
        assert (await client.post("/api/owner/copies", json=wrong)).status_code == 401
    assert (await client.post("/api/owner/copies", json={"passcode": PASSCODE})).status_code == 201
    assert (await client.post("/api/owner/copies", json=wrong)).status_code == 401   # a right one counted no failure

    clock.advance(60)
    response = await client.post("/api/owner/copies", json=wrong)                   # the 31st failed attempt
    assert (response.status_code, response.json()) == (429, {"error": "rate_limited", "retry_after": 540})
    assert response.headers["retry-after"] == "540"
    response = await client.post("/api/owner/copies", json={"passcode": PASSCODE})  # locked out: no oracle
    assert response.status_code == 429 and "set-cookie" not in response.headers
    assert len(fake.copies) == 1 and fake.desks[next(iter(fake.desks))].ledger[-1].event.kind != "rate_limit"

    assert (await browser(api, ip="198.51.100.4").post("/api/owner/copies", json=wrong)).status_code == 401
    clock.advance(540)                                                               # the first failures leave the window
    assert (await client.post("/api/owner/copies", json={"passcode": PASSCODE})).status_code == 201


async def test_a_team_behind_one_address_can_each_start(api, browser, fake, clock):
    """Thirty copies an hour from one address (a team behind one office address, each starting the demo); the 31st
    is refused, a backstop against a leaked passcode in a loop, since copies spend no model tokens."""
    for _ in range(30):
        member = browser(api)
        response = await member.post("/api/owner/copies", json={"passcode": PASSCODE})
        assert response.status_code == 201
        assert (await member.get("/api/owner/me")).json() == response.json()
        clock.advance(60)
    refused = await browser(api).post("/api/owner/copies", json={"passcode": PASSCODE})
    assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 1800})
    assert "set-cookie" not in refused.headers and len(fake.copies) == 30
    elsewhere = await browser(api, ip="198.51.100.4").post("/api/owner/copies", json={"passcode": PASSCODE})
    assert elsewhere.status_code == 201


async def test_copies_limit_counts_start_over_and_ledgers_it(api, browser, fake):
    client = browser(api)
    assert (await client.post("/api/owner/copies", json={"passcode": PASSCODE})).status_code == 201
    for _ in range(29):
        assert (await client.post("/api/owner/start_over")).status_code == 200
    copy = (await client.get("/api/owner/me")).json()
    owner_session = fake.copies[copy["copy_id"]].owner_session_id

    for _ in range(2):
        response = await client.post("/api/owner/start_over")                       # the 31st copy in an hour
        assert (response.status_code, response.json()["error"]) == (429, "rate_limited")
    response = await browser(api).post("/api/owner/copies", json={"passcode": PASSCODE})
    assert response.status_code == 429 and len(fake.copies) == 30                  # the same address, no credential

    entries = [entry.event for entry in fake.desks[copy["desks"][0]["desk_id"]].ledger if entry.event.kind == "rate_limit"]
    assert [(event.origin, event.session_id, event.summary) for event in entries] == [
        ("api", owner_session, {"limit": "copies"})]                               # once per window, by the owner


def production_settings(passcode_hash: str, **changes) -> Settings:
    return Settings(**{"desk_env": "production", "api_database_url": "postgresql+psycopg://desk_api@127.0.0.1:5433/desk",
                       "anthropic_api_key": "key-for-tests", "passcode_hash": passcode_hash,
                       "public_origin": "https://desk.example.com", "trusted_proxy_hops": 2, **changes})


def request_to(app: FastAPI, peer: str, headers: dict[str, str | list[str]] | None = None) -> Request:
    raw = [(name.lower().encode(), value.encode()) for name, values in (headers or {}).items()
           for value in ([values] if isinstance(values, str) else values)]
    return Request({"type": "http", "method": "GET", "path": "/", "query_string": b"", "headers": raw,
                    "client": (peer, 443), "app": app})


def test_client_ip_and_origin_follow_the_deploy_seam(passcode_hash):
    app = create_app(production_settings(passcode_hash))                  # two hops: CloudFront, then the load balancer
    alb = "10.0.3.7"
    seen = lambda peer, forwarded: client_ip(request_to(app, peer, {"x-forwarded-for": forwarded}))   # noqa: E731

    assert seen(alb, "6.6.6.6, 1.2.3.4, 130.176.0.1") == "1.2.3.4"        # the viewer CloudFront appended; the lead is forged
    assert seen(alb, "1.2.3.4, 130.176.0.1") == "1.2.3.4"
    assert seen(alb, ["6.6.6.6", "1.2.3.4, 130.176.0.1"]) == "1.2.3.4"    # repeated headers read as one list
    assert seen(alb, "2001:db8::1, 130.176.0.1") == "2001:db8::1"
    assert seen(alb, "130.176.0.1") == SHARED_BUCKET                      # one entry: one shared bucket
    assert seen(alb, "") == SHARED_BUCKET
    assert seen(alb, "6.6.6.6, not-an-address, 130.176.0.1") == SHARED_BUCKET
    assert client_ip(request_to(app, alb)) == SHARED_BUCKET              # no header at all
    assert client_ip(request_to(app, "127.0.0.1")) is None               # a bare loopback peer: the built-in agent
    assert client_ip(request_to(app, "::1")) is None
    assert seen("127.0.0.1", "1.2.3.4, 130.176.0.1") == "1.2.3.4"        # a loopback peer that forwards is counted

    direct = create_app(production_settings(passcode_hash, trusted_proxy_hops=0))
    assert client_ip(request_to(direct, "198.51.100.4", {"x-forwarded-for": "1.2.3.4"})) == "198.51.100.4"
    assert client_ip(request_to(direct, "127.0.0.1", {"x-forwarded-for": "1.2.3.4"})) == "127.0.0.1"

    local = create_app(Settings(api_database_url="postgresql+psycopg://desk_api@127.0.0.1:5433/desk"))
    assert client_ip(request_to(local, "127.0.0.1", {"x-forwarded-for": "1.2.3.4"})) is None   # tier 2 runs locally
    assert client_ip(request_to(local, "198.51.100.4")) == "198.51.100.4"

    forged = {"host": "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http",
              "x-desk-public-host": "evil.example", "forwarded": "host=evil.example"}
    assert public_origin(request_to(app, alb, forged)) == "https://desk.example.com"
    assert public_origin(request_to(local, "127.0.0.1", forged)) == "http://localhost:5173"


async def test_production_requires_secrets(monkeypatch, passcode_hash, clock):
    production = {"DESK_ENV": "production", "API_DATABASE_URL": "postgresql+psycopg://desk_api@127.0.0.1:5433/desk",
                  "ANTHROPIC_API_KEY": "key-for-tests", "PASSCODE_HASH": passcode_hash,
                  "PUBLIC_ORIGIN": "https://desk.example.com", "TRUSTED_PROXY_HOPS": "2"}
    for name in (*production, "KERNEL_URL", "ANTHROPIC_BASE_URL",
                 # the provider's variables, which a developer's shell may export
                 "MODEL_PROVIDER", "BEDROCK_BEARER_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_AWS_API_KEY",
                 "ANTHROPIC_CUSTOM_HEADERS"):
        monkeypatch.delenv(name, raising=False)
    for name, value in production.items():
        monkeypatch.setenv(name, value)
    assert app_factory().state.runtime.settings.production is True        # all set: the app builds

    for missing in ("PASSCODE_HASH", "ANTHROPIC_API_KEY", "PUBLIC_ORIGIN"):  # each of the three refuses to start
        monkeypatch.delenv(missing)
        with pytest.raises(RuntimeError, match=missing):
            app_factory()
        monkeypatch.setenv(missing, production[missing])
    for broken in ("not-a-hash", "scrypt$16384$8$1$c2FsdA==$aGFzaA==", passcode_hash.replace("16384", "1048576")):
        monkeypatch.setenv("PASSCODE_HASH", broken)
        with pytest.raises(RuntimeError, match="PASSCODE_HASH") as refused:
            app_factory()
        assert broken not in str(refused.value)
    monkeypatch.setenv("PASSCODE_HASH", passcode_hash)

    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9999")     # the model test hook
    with pytest.raises(RuntimeError, match="ANTHROPIC_BASE_URL"):
        app_factory()
    monkeypatch.delenv("ANTHROPIC_BASE_URL")

    settings = production_settings(passcode_hash)
    with pytest.raises(RuntimeError, match="clock"):                       # the clock test hook
        create_app(settings, clock=clock)
    with pytest.raises(RuntimeError, match="model"):
        create_app(settings, model=object())
    with pytest.raises(RuntimeError, match="kernel transport"):
        create_app(settings, kernel_transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    with pytest.raises(RuntimeError, match="job queue connector"):         # production's jobs live in Postgres
        create_app(settings, jobs_connector=InMemoryConnector())
    with pytest.raises(RuntimeError, match="A2A transport"):    # the built-in agent reaches the endpoint over HTTP
        a2a_client(settings, httpx.MockTransport(lambda request: httpx.Response(200)))

    # The lifespan reaches the kernel only over HTTP on 127.0.0.1, before it opens anything else.
    app = create_app(production_settings(passcode_hash, kernel_url="http://localhost:8701"))
    with pytest.raises(RuntimeError, match="127.0.0.1"):
        async with app.router.lifespan_context(app):
            pass


def usage_row(output_tokens: int, finished_at: datetime) -> SimpleNamespace:
    usage = SimpleNamespace(input_tokens=0, cache_read_input_tokens=0, cache_creation_input_tokens=0,
                            output_tokens=output_tokens)
    return SimpleNamespace(model="claude-opus-5-5", usage=usage, stop_reason="end_turn", latency_ms=900,
                           finished_at=finished_at)


async def test_model_routes_stop_past_the_daily_budget(passcode_hash, engine):
    production = create_app(production_settings(passcode_hash))
    production.state.runtime.engine = engine           # its lifespan would refuse FakeKernel; only the database is needed
    local = create_app(Settings(api_database_url="postgresql+psycopg://desk_api@127.0.0.1:5433/desk"))
    local.state.runtime.engine = engine
    now = datetime.now(UTC)

    async def spend(output_tokens: int, at: datetime) -> None:
        async with engine.begin() as conn:             # Opus output at $20 per million tokens
            await record_model_call(conn, "copy-budget", None, "setup", usage_row(output_tokens, at))

    await spend(7_499_000, now)                        # $149.98 today
    await spend(4_000_000, now - timedelta(days=1))    # yesterday's spend doesn't count
    await require_model_budget(request_to(production, "203.0.113.7"))
    await spend(1_000, now)                            # $150.00: the budget is reached
    with pytest.raises(ApiProblem) as refused:
        await require_model_budget(request_to(production, "203.0.113.7"))
    assert (refused.value.status, refused.value.error) == (503, "demo_budget")
    assert DAILY_MODEL_BUDGET_CENTS == 15000
    await require_model_budget(request_to(local, "127.0.0.1"))   # only production spends the shared monthly limit


def test_hash_passcode_script_reads_stdin_and_prints_only_the_hash():
    script = [sys.executable, "scripts/hash_passcode.py"]
    made = subprocess.run(script, input="a team passcode\n", capture_output=True, text=True, cwd=BACKEND, check=True)
    (line,) = made.stdout.splitlines()
    assert line.startswith("scrypt$16384$8$1$") and "a team passcode" not in made.stdout + made.stderr
    assert check_passcode("a team passcode", line) and not check_passcode("a team passcode ", line)
    assert subprocess.run(script, input="a team passcode\n", capture_output=True, text=True, cwd=BACKEND).stdout != made.stdout

    empty = subprocess.run(script, input="\n", capture_output=True, text=True, cwd=BACKEND)
    assert empty.returncode != 0 and empty.stdout == ""


def test_visitor_cookie_is_scoped_to_its_desk():
    token = "T" * 43
    response = Response()
    set_visitor_cookie(response, "turner-plumbing-a1b2c3", token)
    clear_visitor_cookie(response, "turner-plumbing-a1b2c3")
    set_visitor_cookie(response, "a/b", token)                       # a slug can't widen the path
    assert response.headers.getlist("set-cookie") == [
        f"desk_visitor={token}; HttpOnly; Secure; SameSite=Strict; Path=/api/public/desks/turner-plumbing-a1b2c3; Max-Age=86400",
        "desk_visitor=; HttpOnly; Secure; SameSite=Strict; Path=/api/public/desks/turner-plumbing-a1b2c3; Max-Age=0",
        f"desk_visitor={token}; HttpOnly; Secure; SameSite=Strict; Path=/api/public/desks/a%2Fb; Max-Age=86400"]
    for bad in ("short", "x" * 40 + ";Path=/", "x" * 40 + " y", ""):
        with pytest.raises(ValueError) as refused:
            set_owner_cookie(Response(), bad)
        assert bad not in str(refused.value) or bad == ""
    with pytest.raises(ValueError):
        set_visitor_cookie(Response(), "", token)
