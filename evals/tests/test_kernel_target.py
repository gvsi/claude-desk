"""`KernelTarget`'s plumbing, run against a stand-in for Plan 01a's `create_app`.

Until Plan 01a lands, tier 1's kernel cases are pending, so these tests are what runs the target:
the environment it gives the kernel, the clock, the server's lifecycle and restarts, the bounded
mode refusal, the contract checks on every call and the unscripted-call check at stop. The
stand-in is a few routes, not a kernel; tier 1's own cases need the real one.
"""

import json
import os
import re
import secrets
import sys
import types
from contextlib import asynccontextmanager

import anthropic
import httpx
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from desk.kernel_api import KernelError, WhoAmI
from evals.fakes import LoopbackServer
from evals.tier1 import targets
from evals.tier1.harness import Auth, ContractError, Expect, KernelHarness, load_landed
from evals.tier1.targets import DUMMY_KEY, SYMCC_REQUIRED, KernelTarget, MockpayClient, TargetError

WATCHED = ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "DESK_ENV", "DESK_DECISIONS", "DESK_SIGNING_SEED", "TYPESAFE_API_KEY")
LEAKED_CODE = "482913"   # the code the stand-in leaks: in a field, as a key, or in a preview
BROKEN_CONTACT = "broken@example.com"   # the stand-in's /verify/start breaks VerifyStarted for this contact
SENT_CONTACT = "sent@example.com"   # the stand-in's /verify/start sends this contact, unmasked, a code
# Keys a stand-in answer chooses that a token could have: one spelled like a field name, and one in
# hexadecimal that starts with a letter. Made fresh each run, so no token-like text is in the source.
TOKEN_KEY = "tok_" + secrets.token_hex(16)
HEX_KEY = "e" + secrets.token_hex(19)
# A token the stand-in's Demo inbox gives as an entry id: shaped like a field name and short enough
# to be shown, were it one the contract declares. Made fresh each run.
NAMED_TOKEN = "tok_" + secrets.token_hex(8)


class StandInKernel:
    """`create_app(settings, clock)` as Plan 01a gives it, serving a handful of routes."""

    def __init__(self) -> None:
        self.proof_mode = "symcc"
        self.model = "claude-sonnet-5-5"   # the model `GET /whoami` calls, as a reply check would
        self.schema = "SoftPromiseVerdict"
        self.apps: list[tuple[object, dict[str, str | None]]] = []   # each app's clock and environment
        self.lifespan: list[str] = []
        self.requests = 0

    def create_app(self, settings: object = None, clock: object = None) -> Starlette:
        self.apps.append((clock, {name: os.environ.get(name) for name in WATCHED}))

        @asynccontextmanager
        async def lifespan(app: Starlette):
            self.lifespan.append("startup")
            yield
            self.lifespan.append("shutdown")

        async def health(request: Request) -> JSONResponse:
            return JSONResponse({"version": "stand-in", "proof_mode": self.proof_mode, "dev_signing_key": True,
                                 "public_key_hex": "ab" * 32, "key_id": "ab" * 8, "unproved_seeds": []})

        async def whoami(request: Request) -> JSONResponse:
            self.requests += 1
            client = anthropic.AsyncAnthropic(max_retries=0)   # reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
            try:
                await client.messages.create(
                    model=self.model, max_tokens=16, messages=[{"role": "user", "content": "Hi"}],
                    output_config={"format": {"type": "json_schema", "schema": {
                        "title": self.schema, "type": "object"}}}
                )
            except anthropic.APIStatusError:
                pass   # an unscripted call: the kernel fails closed, and the target's stop() fails the case
            return JSONResponse({"kind": "visitor", "copy_id": "c-1", "desk_id": "d-1", "desk_ids": ["d-1"],
                                 "session": None})

        async def copies(request: Request) -> JSONResponse:
            self.requests += 1
            return JSONResponse({"copy_id": "c-1", "desk_ids": ["d-1"]})   # no owner session or token: off contract

        async def decision(request: Request) -> JSONResponse:
            self.requests += 1
            body = {"code": "stale_generation"}
            if request.path_params["id"] == "d-detail":
                body["diagnostic"] = "generation 3 is current"   # a field KernelError doesn't declare
            if request.path_params["id"] == "d-keyed":
                body[LEAKED_CODE] = True   # one whose key is a code
            if request.path_params["id"] == "d-token":
                body |= {TOKEN_KEY: True, HEX_KEY: True}   # keys a token could have
            return JSONResponse(body, status_code=409)

        async def verify_start(request: Request) -> JSONResponse:
            self.requests += 1
            if (await request.json())["contact"] == BROKEN_CONTACT:   # no message, a mistyped id, and the leak
                notice = {"entry_id": 314159, "to": "d•••@example.com",
                          "preview": f"Your code {LEAKED_CODE} is here."}
                return JSONResponse({"inbox": [notice], "verification_code": LEAKED_CODE})
            if (await request.json())["contact"] == SENT_CONTACT:   # on contract, but a code to the raw contact
                notice = {"entry_id": "e-1", "to": SENT_CONTACT, "preview": f"Your code is {LEAKED_CODE}"}
                return JSONResponse({"message": "If that contact is on record, a code is on its way.",
                                     "inbox": [notice]})
            notice = {"entry_id": "e-1", "to": "d•••@example.com", "preview": "A code is on its way."}
            if (await request.json())["contact"] == "keyed@example.com":   # token-shaped keys, one nested
                return JSONResponse({"message": "If that contact is on record, a code is on its way.",
                                     "inbox": [{**notice, HEX_KEY: 1}], TOKEN_KEY: True})
            return JSONResponse({"message": "If that contact is on record, a code is on its way.", "inbox": [notice],
                                 "verification_code": LEAKED_CODE})   # a valid VerifyStarted, plus a leak

        async def demo_inbox(request: Request) -> JSONResponse:
            self.requests += 1   # on contract, but a code to the raw contact, under a token for an id
            return JSONResponse([{"entry_id": NAMED_TOKEN, "to": SENT_CONTACT, "kind": "verification_code",
                                  "body": f"Your code is {LEAKED_CODE}", "created_at": "2026-11-03T18:00:00Z"}])

        async def public(request: Request) -> JSONResponse:
            self.requests += 1
            return JSONResponse({"business_name": "Turner Plumbing", "brand": {LEAKED_CODE: 7}})   # a key it chose

        async def not_found(request: Request) -> JSONResponse:
            self.requests += 1
            return JSONResponse({"code": "not_found"}, status_code=404)   # any other route, on contract

        return Starlette(lifespan=lifespan, routes=[
            Route("/health", health), Route("/whoami", whoami), Route("/copies", copies, methods=["POST"]),
            Route("/decisions/{id}", decision), Route("/verify/start", verify_start, methods=["POST"]),
            Route("/demo_inbox", demo_inbox), Route("/public/{slug}", public),
            Route("/{rest:path}", not_found, methods=["GET", "POST", "PUT", "DELETE"]),
        ])


@pytest.fixture
def kernel(monkeypatch: pytest.MonkeyPatch) -> StandInKernel:
    stand_in = StandInKernel()
    package = types.ModuleType("desk.kernel_service")
    package.__path__ = []
    module = types.ModuleType("desk.kernel_service.app")
    module.create_app = stand_in.create_app
    monkeypatch.setitem(sys.modules, "desk.kernel_service", package)
    monkeypatch.setitem(sys.modules, "desk.kernel_service.app", module)
    # Records connects only when read, and these tests read none.
    monkeypatch.setenv("API_DATABASE_URL", "postgresql+psycopg://desk_api:unused@127.0.0.1:1/desk")
    monkeypatch.setenv("KERNEL_DATABASE_URL", "postgresql+psycopg://desk_kernel:unused@127.0.0.1:1/desk")
    # What a developer's shell might hold; the target replaces it for the kernel, then puts it back.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-the-shell")
    monkeypatch.setenv("TYPESAFE_API_KEY", "fake-typesafe-from-the-shell")
    monkeypatch.setenv("DESK_SIGNING_SEED", "5" * 64)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    return stand_in


@pytest.mark.parametrize("plans", [None, ["master", "01a"]], ids=["landed.toml", "01a landed"])
async def test_target_runs_the_kernel_app_on_its_clock_and_fake(
    kernel: StandInKernel, plans: list[str] | None, tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """Run with the committed landed.toml, and with a temporary one listing 01a as the kernel core's
    PR will: `landed` follows whichever file the target's loader read, so the test holds either way."""
    if plans is not None:
        landed_file = tmp_path / "landed.toml"
        landed_file.write_text(f"plans = {json.dumps(plans)}\n")
        monkeypatch.setattr(targets, "load_landed", lambda: load_landed(landed_file))
    target = await KernelTarget(models="fake").start()
    try:
        assert re.fullmatch(r"http://127\.0\.0\.1:\d+", target.url)
        assert isinstance(target, KernelHarness) and target.is_real
        assert target.landed("01a") == ("01a" in targets.load_landed())
        assert target.health is not None and target.health.proof_mode == "symcc"
        [(clock, env)] = kernel.apps
        assert clock is target.clock
        assert env == {"ANTHROPIC_BASE_URL": target.fake.url, "ANTHROPIC_API_KEY": DUMMY_KEY, "DESK_ENV": "test",
                       "DESK_DECISIONS": "anthropic", "DESK_SIGNING_SEED": None, "TYPESAFE_API_KEY": None}

        # The kernel's model call reaches the fake's Sonnet default for the verdict schema.
        whoami = await target.call("GET /whoami", auth=Auth.raw({"X-Session-Token": "secret-token"}),
                                   expect=Expect(fields={"kind": "visitor"}))
        assert isinstance(whoami, WhoAmI)
        assert len(target.fake.calls("claude-sonnet-5-5", schema="SoftPromiseVerdict")) == 1
        assert [(called.route, called.status) for called in target.responses] == [("GET /whoami", 200)]
        assert "secret-token" not in repr(target.responses)
    finally:
        await target.stop()
    assert kernel.lifespan == ["startup", "shutdown"]
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-ant-from-the-shell"
    assert os.environ["TYPESAFE_API_KEY"] == "fake-typesafe-from-the-shell"
    assert os.environ["DESK_SIGNING_SEED"] == "5" * 64
    assert "ANTHROPIC_BASE_URL" not in os.environ and "DESK_DECISIONS" not in os.environ


async def test_restart_serves_a_fresh_app_on_the_same_port_and_clock(kernel: StandInKernel):
    target = await KernelTarget(models="fake").start()
    try:
        url = target.url
        await target.restart()
        assert target.url == url
        assert [clock for clock, _ in kernel.apps] == [target.clock, target.clock]
        assert kernel.lifespan == ["startup", "shutdown", "startup"]
        await target.call("GET /whoami", auth=Auth.none(), expect=Expect(fields={"kind": "visitor"}))
        target.advance(3600)
        target.travel(target.clock.now())
    finally:
        await target.stop()
    assert kernel.lifespan == ["startup", "shutdown", "startup", "shutdown"]


async def test_bounded_kernel_stops_the_target(kernel: StandInKernel):
    kernel.proof_mode = "bounded"
    with pytest.raises(TargetError, match=re.escape(SYMCC_REQUIRED)):
        await KernelTarget(models="fake").start()
    assert kernel.lifespan == ["startup", "shutdown"]   # nothing left running
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-ant-from-the-shell"

    target = await KernelTarget(models="fake", allow_bounded=True).start()
    await target.stop()
    assert target.health is not None and target.health.proof_mode == "bounded"


async def test_calls_are_checked_against_the_contract_both_ways(kernel: StandInKernel):
    target = await KernelTarget(models="fake").start()
    try:
        with pytest.raises(ContractError, match="args"):   # a request off contract is never sent
            await target.call("POST /decide", body={"session_id": "s-1", "generation": 0,
                                                    "call": {"call_id": "c-1", "tool": "native.quote"}},
                              auth=Auth.none())
        assert kernel.requests == 0
        with pytest.raises(ContractError, match="breaks CopyCreated"):   # an answer off contract fails
            await target.new_copy()
        with pytest.raises(AssertionError, match=r"answered 409 \(code 'stale_generation'\): status: expected 200"):
            await target.call("GET /decisions/{id}", path={"id": "d 1"}, auth=Auth.none())
        error = await target.call("GET /decisions/{id}", path={"id": "d-1"}, auth=Auth.none(),
                                  expect=Expect(status=409, fields={"code": "stale_generation"}))
        assert error == KernelError(code="stale_generation")
        assert [(called.route, called.status) for called in target.responses] == [
            ("GET /decisions/{id}", 409), ("GET /decisions/{id}", 409)
        ]
    finally:
        await target.stop()


async def test_an_undeclared_response_field_fails_the_call(kernel: StandInKernel):
    """A valid `VerifyStarted` with an extra `verification_code` field fails the call as a contract
    break showing where the field is, never its name or value, and records nothing: the response
    models drop what they don't declare, so a code or a canary there would otherwise vanish before
    any scan saw it. The same for a `KernelError` with a `diagnostic` beside its code, and with a code
    as a key: a key the contract doesn't declare is the answer's own choice, so the failure shows
    it as `*`. What the kernel did send is kept on each recorded call as `raw`, beside the
    contract's reading of it."""
    target = await KernelTarget(models="fake").start()
    try:
        with pytest.raises(ContractError, match=r"VerifyStarted doesn't declare: \['\*'\]") as failure:
            await target.call("POST /verify/start", body={"session_id": "s-1", "contact": "dana@example.com"},
                              auth=Auth.none())
        assert LEAKED_CODE not in str(failure.value)
        with pytest.raises(ContractError, match=r"KernelError doesn't declare: \['\*'\]") as failure:
            await target.call("GET /decisions/{id}", path={"id": "d-detail"}, auth=Auth.none(),
                              expect=Expect(status=409, fields={"code": "stale_generation"}))
        assert "generation 3" not in str(failure.value) and "diagnostic" not in str(failure.value)
        with pytest.raises(ContractError, match=r"doesn't declare: \['\*'\]") as failure:
            await target.call("GET /decisions/{id}", path={"id": "d-keyed"}, auth=Auth.none(),
                              expect=Expect(status=409, fields={"code": "stale_generation"}))
        assert LEAKED_CODE not in str(failure.value)
        assert target.responses == []
        await target.call("GET /whoami", auth=Auth.none(), expect=Expect(fields={"kind": "visitor"}))
        [called] = target.responses
        assert called.raw == {"kind": "visitor", "copy_id": "c-1", "desk_id": "d-1", "desk_ids": ["d-1"],
                              "session": None}
        assert called.body == called.raw
    finally:
        await target.stop()


async def test_an_undeclared_key_is_never_printed_whatever_its_spelling(kernel: StandInKernel):
    """A key the contract doesn't declare may be a token, and a token can be spelled like a field
    name or be hexadecimal starting with a letter: the call fails showing only where such keys are
    (`*`, beside the contract's own field names and list indexes), never the keys."""
    target = await KernelTarget(models="fake").start()
    try:
        with pytest.raises(ContractError, match=r"KernelError doesn't declare: \['\*', '\*'\]") as failure:
            await target.call("GET /decisions/{id}", path={"id": "d-token"}, auth=Auth.none(),
                              expect=Expect(status=409, fields={"code": "stale_generation"}))
        assert TOKEN_KEY not in str(failure.value) and HEX_KEY not in str(failure.value), str(failure.value)
        with pytest.raises(ContractError, match=r"VerifyStarted doesn't declare: \['inbox.0.\*', '\*'\]") as failure:
            await target.call("POST /verify/start", body={"session_id": "s-1", "contact": "keyed@example.com"},
                              auth=Auth.none())
        assert TOKEN_KEY not in str(failure.value) and HEX_KEY not in str(failure.value), str(failure.value)
        assert target.responses == []
    finally:
        await target.stop()


async def test_an_expectation_mismatch_never_prints_what_the_answer_held(kernel: StandInKernel):
    """An on-contract answer that doesn't match its expectation fails the call by type and size
    alone: a start that should send nothing (`{"inbox": []}`) but sent a code fails showing neither
    the Demo inbox entry nor its contact nor the code, and so does one whose code went to the raw
    contact where the masked one was expected."""
    target = await KernelTarget(models="fake").start()
    try:
        expectations = {
            "inbox: expected [], got a list of 1 item": {"inbox": []},
            "inbox.0.to: expected 's•••@example.com', got a string of 16 characters": {
                "inbox.0.to": "s\u2022\u2022\u2022@example.com"},
        }
        for mismatch, fields in expectations.items():
            failed = re.escape(f"POST /verify/start answered 200: {mismatch}")
            with pytest.raises(AssertionError, match=failed) as failure:
                await target.call("POST /verify/start", body={"session_id": "s-1", "contact": SENT_CONTACT},
                                  auth=Auth.none(), expect=Expect(fields=fields))
            shown = str(failure.value)
            held = [value for value in (LEAKED_CODE, SENT_CONTACT, "Your code", "e-1") if value in shown]
            assert held == [], f"the failure shows {held}"
        assert [called.raw["inbox"][0]["to"] for called in target.responses] == [SENT_CONTACT, SENT_CONTACT]
    finally:
        await target.stop()


async def test_a_kernel_mismatch_names_the_contracts_words_and_hides_what_the_answer_chose(kernel: StandInKernel):
    """On the kernel target a mismatch also shows a string the route's response contract declares
    (a field name or an enum value: fixed public words), so a wrong enum reads "expected 'alert',
    got 'verification_code'", and a wrong error code names both codes. A code, a contact and a
    token in the same answer are still told by their size, a token shaped like a field name too:
    only an exact member of the contract's words is shown."""
    target = await KernelTarget(models="fake").start()
    try:
        expect = Expect(fields={"0.kind": "alert", "0.to": "s\u2022\u2022\u2022@example.com", "0.body": "",
                                "0.entry_id": "e-1"})
        with pytest.raises(AssertionError) as failure:
            await target.call("GET /demo_inbox?session_id=", query={"session_id": "s-1"}, auth=Auth.none(),
                              expect=expect)
        shown = str(failure.value)
        assert shown == (
            "GET /demo_inbox?session_id= answered 200: 0.kind: expected 'alert', got 'verification_code'; "
            "0.to: expected 's\u2022\u2022\u2022@example.com', got a string of 16 characters; "
            "0.body: expected '', got a string of 19 characters; "
            f"0.entry_id: expected 'e-1', got a string of {len(NAMED_TOKEN)} characters"), shown
        held = [value for value in (LEAKED_CODE, SENT_CONTACT, "Your code", NAMED_TOKEN) if value in shown]
        assert held == [], f"the failure shows {held}"
        with pytest.raises(AssertionError) as failure:
            await target.call("GET /decisions/{id}", path={"id": "d-1"}, auth=Auth.none(),
                              expect=Expect(status=409, fields={"code": "conflict"}))
        assert str(failure.value) == ("GET /decisions/{id} answered 409 (code 'stale_generation'): "
                                      "code: expected 'conflict', got 'stale_generation'"), str(failure.value)
        assert [called.raw[0]["entry_id"] for called in target.responses[:1]] == [NAMED_TOKEN]   # recorded raw
    finally:
        await target.stop()


async def test_a_malformed_response_fails_without_printing_what_it_held(kernel: StandInKernel):
    """A response that breaks its model fails the call as a contract break naming the fields and
    the kinds of error only: a `/verify/start` answer missing `message`, with a mistyped id and a
    code in a field the contract doesn't declare, shows neither the code nor any other value it
    held; nor does a `PublicDesk` whose `brand` holds a value under a key the answer chose."""
    target = await KernelTarget(models="fake").start()
    try:
        with pytest.raises(ContractError, match=r"breaks VerifyStarted: .*message: missing") as failure:
            await target.call("POST /verify/start", body={"session_id": "s-1", "contact": BROKEN_CONTACT},
                              auth=Auth.none())
        shown = str(failure.value)
        assert "inbox.0.entry_id: string_type" in shown, shown
        held = [value for value in (LEAKED_CODE, "314159", "d•••@example.com", "is here") if value in shown]
        assert held == [], f"the failure shows {held}"
        with pytest.raises(ContractError, match="breaks PublicDesk") as failure:
            await target.call("GET /public/{desk_slug}", path={"desk_slug": "rivera"}, auth=Auth.none())
        shown = str(failure.value)
        assert "desk_name: missing" in shown and "brand.*: string_type" in shown, shown
        assert LEAKED_CODE not in shown and "Turner" not in shown, shown
        assert target.responses == []
    finally:
        await target.stop()


async def test_proving_routes_get_the_longer_client_timeout(kernel: StandInKernel, monkeypatch: pytest.MonkeyPatch):
    """`POST /policy/draft`, `POST /policy/{version}/probe` and `POST /tools/confirm` wait 60 s for
    the kernel, the client timeout the master plan gives proving calls (the kernel proves within
    45 s); every other route keeps the 30 s timeout."""
    seen: list[tuple[str, float | None]] = []
    original = httpx.AsyncClient.send

    async def send(self: httpx.AsyncClient, request: httpx.Request, **kwargs: object) -> httpx.Response:
        seen.append((str(request.url), request.extensions.get("timeout", {}).get("read")))
        return await original(self, request, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    target = await KernelTarget(models="fake").start()
    try:
        not_found = Expect(status=404, fields={"code": "not_found"})
        await target.call("POST /policy/draft", body={"desk_id": "d-1", "cards": [], "expected_parent": 1},
                          auth=Auth.none(), expect=not_found)
        await target.call("POST /policy/{version}/probe", path={"version": 1}, body={"desk_id": "d-1", "probes": []},
                          auth=Auth.none(), expect=not_found)
        await target.call("POST /tools/confirm", auth=Auth.none(), expect=not_found, body={
            "desk_id": "d-1", "tools": [{"tool": "native.quote", "definition_sha256": "0" * 64}], "enable": True})
        await target.call("GET /whoami", auth=Auth.none(), expect=Expect(fields={"kind": "visitor"}))
    finally:
        await target.stop()
    to_kernel = [(url.removeprefix(target.url), read) for url, read in seen if url.startswith(target.url)]
    assert to_kernel == [("/health", 30.0), ("/policy/draft", 60.0), ("/policy/1/probe", 60.0),
                         ("/tools/confirm", 60.0), ("/whoami", 30.0)]


async def test_stop_fails_on_an_unscripted_model_call(kernel: StandInKernel):
    kernel.schema = "Review"   # the same Sonnet model, but a reviewer call no case scripted
    target = await KernelTarget(models="fake").start()
    await target.call("GET /whoami", auth=Auth.none(), expect=Expect(fields={"kind": "visitor"}))
    with pytest.raises(AssertionError, match="1 unscripted model calls.*claude-sonnet-5-5"):
        await target.stop()
    assert kernel.lifespan == ["startup", "shutdown"]
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-ant-from-the-shell"


async def test_real_models_are_refused_where_tier1_refuses_them(kernel: StandInKernel, monkeypatch):
    monkeypatch.setattr(targets, "_real_models_refused", True)
    with pytest.raises(TargetError, match="tier 1 makes no model calls"):
        await KernelTarget(models="real").start()
    assert kernel.apps == []
    with pytest.raises(TargetError, match="Plan 01c"):   # no mock payments server before 01c lands
        KernelTarget().mockpay


async def test_mockpay_client_names_the_copy_and_carries_the_key():
    seen: list[tuple[str, str | None, str | None, dict]] = []

    async def provider(request: Request) -> JSONResponse:
        body = await request.json()
        seen.append((request.url.path, request.headers.get("x-mockpay-key"), request.headers.get("x-desk-copy"), body))
        return JSONResponse({"charge_ids": ["ch-1", "ch-2"]} if request.url.path.endswith("seed") else {})

    server = LoopbackServer(Starlette(routes=[Route("/provider/{op:path}", provider, methods=["POST"])]))
    server.start()
    try:
        client = MockpayClient(server.url, "k" * 32)
        charge = {"owner_person_id": "p-dana", "amount_cents": 18000, "description": "Drain clearing",
                  "created_at": "2026-11-02T17:00:00.000000Z"}
        assert await client.seed("copy-a", [charge, {**charge, "amount_cents": 25000}]) == ["ch-1", "ch-2"]
        await client.delay("copy-a", "complete", 3)
    finally:
        server.stop()
    assert [(path, key, copy) for path, key, copy, _ in seen] == [
        ("/provider/seed", "k" * 32, "copy-a"), ("/provider/test/delay", "k" * 32, "copy-a")
    ]
    assert seen[0][3]["charges"][1]["amount_cents"] == 25000
    assert seen[1][3] == {"op": "complete", "seconds": 3}


async def test_mockpay_client_reads_a_charge_as_the_copy():
    """`charge` reads one charge from the copy's store (`GET /provider/charges/{id}`, Plan 01c), and
    a charge the copy's store doesn't hold fails instead of reading as unrefunded."""
    seen: list[tuple[str, str | None, str | None]] = []

    async def provider(request: Request) -> JSONResponse:
        charge_id = request.path_params["charge_id"]
        seen.append((charge_id, request.headers.get("x-mockpay-key"), request.headers.get("x-desk-copy")))
        if charge_id != "ch-1":
            return JSONResponse({"detail": "not found"}, status_code=404)
        return JSONResponse({"charge_id": "ch-1", "owner_person_id": "p-bob", "amount_cents": 15000,
                             "refunded_cents": 0})

    server = LoopbackServer(Starlette(routes=[Route("/provider/charges/{charge_id}", provider, methods=["GET"])]))
    server.start()
    try:
        client = MockpayClient(server.url, "k" * 32)
        assert await client.charge("copy-a", "ch-1") == {
            "charge_id": "ch-1", "owner_person_id": "p-bob", "amount_cents": 15000, "refunded_cents": 0}
        with pytest.raises(httpx.HTTPStatusError):
            await client.charge("copy-b", "ch-2")
    finally:
        server.stop()
    assert seen == [("ch-1", "k" * 32, "copy-a"), ("ch-2", "k" * 32, "copy-b")]


async def test_mockpay_client_reads_what_the_server_lists():
    """`listed_tools` asks the mock payments server's MCP endpoint for `tools/list` as the copy,
    the way any MCP client would (Plan 01c: stateless, JSON answers), following `nextCursor` to
    the last page; it reads an answer framed as server-sent events too. A JSON-RPC error raises."""
    seen: list[tuple[str | None, str | None, str | None, dict]] = []
    pages = {None: ({"name": "list_charges"}, "page-2"), "page-2": ({"name": "transfer_funds"}, None)}

    async def mcp(request: Request) -> Response:
        message = await request.json()
        seen.append((request.headers.get("x-mockpay-key"), request.headers.get("x-desk-copy"),
                     request.headers.get("accept"), message))
        if request.headers.get("x-desk-copy") == "copy-error":
            return JSONResponse({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "no"}})
        tool, cursor = pages[message["params"].get("cursor")]
        result = {"tools": [tool], **({"nextCursor": cursor} if cursor else {})}
        answer = {"jsonrpc": "2.0", "id": message["id"], "result": result}
        if request.headers.get("x-desk-copy") == "copy-sse":
            return Response(f"event: message\ndata: {json.dumps(answer)}\n\n", media_type="text/event-stream")
        return JSONResponse(answer)

    server = LoopbackServer(Starlette(routes=[Route("/mcp", mcp, methods=["POST"])]))
    server.start()
    try:
        client = MockpayClient(server.url, "k" * 32)
        assert await client.listed_tools("copy-a") == {"list_charges": {"name": "list_charges"},
                                                       "transfer_funds": {"name": "transfer_funds"}}
        assert list(await client.listed_tools("copy-sse")) == ["list_charges", "transfer_funds"]
        with pytest.raises(TargetError, match="tools/list"):
            await client.listed_tools("copy-error")
    finally:
        server.stop()
    assert [(key, copy) for key, copy, _, _ in seen] == [("k" * 32, "copy-a")] * 2 + [("k" * 32, "copy-sse")] * 2 + [
        ("k" * 32, "copy-error")]
    assert all("application/json" in accept and "text/event-stream" in accept for _, _, accept, _ in seen)
    assert [message["method"] for *_, message in seen] == ["tools/list"] * 5
    assert [message["params"] for *_, message in seen][:2] == [{}, {"cursor": "page-2"}]
