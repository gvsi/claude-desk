"""The tier 1 harness: the contract stub, expectations, plan markers, the summary and the guards."""

import hashlib
import json
import shutil
import sys
import textwrap
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import TypeAdapter

from desk.contracts import CopyCreated, Decision, ExecResult, ProbeResult, SessionCreated
from desk.kernel_api import KERNEL_RESPONSES, KERNEL_ROUTES, KernelError, VerifyStarted, WhoAmI
from evals.tier1.harness import (
    LANDS,
    PLANS,
    Auth,
    Expect,
    KernelHarness,
    TravelClock,
    load_landed,
    match_expect,
    undeclared_fields,
    unlisted_landed,
    unlisted_sentence,
    unlisted_warning,
)
from evals.tier1.stub import ContractError, ContractStub, build
from evals.tier1.targets import API_IMPL

pytest_plugins = ("pytester",)

EVALS = Path(__file__).resolve().parents[1]


def decide_body(**call: object) -> dict:
    return {
        "session_id": "s-1",
        "generation": 0,
        "call": {"call_id": "c-1", "tool": "native.quote", "args": {"items": [{"item_id": "drain", "qty": 1}]}, **call},
    }


def parse_signed(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


async def test_stub_rejects_a_request_that_breaks_the_contract():
    k = ContractStub()
    body = {"session_id": "s-1", "generation": 0, "call": {"call_id": "c-1", "tool": "native.quote"}}
    with pytest.raises(ContractError, match="args"):
        await k.call("POST /decide", body=body, auth=Auth.none(), expect=Expect(fields={"outcome": "hold"}))


async def test_stub_rejects_an_unknown_route():
    k = ContractStub()
    with pytest.raises(ContractError, match="POST /transfer"):
        await k.call("POST /transfer", body={"amount_cents": 100}, auth=Auth.none())


def test_undeclared_response_fields_are_named_by_path():
    """`undeclared_fields` names every field a kernel answer carries that its response model
    doesn't declare, nested ones and a union member's included, by path and never by value. A
    declared field the answer leaves out sits at its default, which isn't undeclared, and whatever
    a `dict` field holds is declared by it."""
    notice = {"entry_id": "e-1", "to": "d•••@example.com", "preview": "A code is on its way."}
    started = {"message": "If that contact is on record, a code is on its way.", "inbox": [notice]}
    assert undeclared_fields(started, VerifyStarted.model_validate(started)) == []
    leaking = {**started, "verification_code": "482913"}
    assert undeclared_fields(leaking, VerifyStarted.model_validate(leaking)) == ["verification_code"]
    nested = {**started, "inbox": [notice, {**notice, "code": "482913"}]}
    assert undeclared_fields(nested, VerifyStarted.model_validate(nested)) == ["inbox.1.code"]
    error = {"code": "invalid", "detail": "five attempts used"}
    assert undeclared_fields(error, KernelError.model_validate(error)) == ["detail"]
    whoami = build(WhoAmI, Expect(fields={"session.kind": "visitor"})).model_dump(mode="json")
    in_session = {**whoami, "session": {**whoami["session"], "person_id": "p-dana"}}
    assert undeclared_fields(in_session, WhoAmI.model_validate(in_session)) == ["session.person_id"]
    result = build(ExecResult, Expect(fields={"inbox": {"$len": 0}})).model_dump(mode="json")
    del result["inbox"]   # left out: at its default
    viewed = {**result, "model_view": {"quote_id": "q-1", "lines": [{"item": "drain", "cents": 18000}]}}
    assert undeclared_fields(viewed, ExecResult.model_validate(viewed)) == []
    twice = {**viewed, "receipt": {}, "facts": [{**fact, "extra": 1} for fact in viewed["facts"]]}
    assert undeclared_fields(twice, ExecResult.model_validate(twice)) == [
        f"facts.{n}.extra" for n in range(len(viewed["facts"]))] + ["receipt"]


async def test_stub_rejects_an_expect_path_not_on_the_model():
    k = ContractStub()
    with pytest.raises(ContractError, match="outcom"):
        await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=Expect(fields={"outcom": "hold"}))


async def test_stub_returns_a_valid_response_with_the_expected_fields():
    k = ContractStub()
    decision = await k.call(
        "POST /decide", body=decide_body(), auth=Auth.none(), expect=Expect(fields={"outcome": "hold", "state": "held"})
    )
    assert isinstance(decision, Decision)
    assert (decision.outcome, decision.state) == ("hold", "held")
    assert Decision.model_validate(decision.model_dump()) == decision
    matched = await k.call(
        "POST /decide",
        body=decide_body(),
        auth=Auth.none(),
        expect=Expect(fields={
            "outcome": {"$in": ["refuse", "hold"]},
            "card_ids": {"$has": "rv-quote", "$len": 2},
            "action.amount_cents": 15300,
        }),
    )
    assert (matched.outcome, matched.card_ids[-1], len(matched.card_ids)) == ("refuse", "rv-quote", 2)
    assert matched.action.amount_cents == 15300
    # `$not` picks another value when it rejects the generated one ("hold" is the seeded outcome).
    for expected in ({"$not": "hold"}, {"$in": ["hold", "refuse"], "$not": "hold"}):
        expect = Expect(fields={"outcome": expected})
        decision = await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=expect)
        assert match_expect(200, decision.model_dump(mode="json"), expect) == [], expected
    # `$has` on an object adds the key; `$len` sizes a string or an object.
    shaped = await k.call(
        "POST /decide",
        body=decide_body(),
        auth=Auth.none(),
        expect=Expect(fields={"reason_plain": {"$len": 12}, "visitor_plain": {"$has": "Maria", "$len": 9}}),
    )
    assert len(shaped.reason_plain) == 12 and "Maria" in shaped.visitor_plain and len(shaped.visitor_plain) == 9
    public = await k.call(
        "GET /public/{desk_slug}",
        path={"desk_slug": "rivera-plumbing-abc123"},
        auth=Auth.none(),
        expect=Expect(fields={"brand": {"$has": "accent", "$len": 2}, "charter": {"$not": {"$len": 1}}}),
    )
    assert "accent" in public.brand and len(public.brand) == 2 and len(public.charter) != 1


def test_stub_builds_every_response_model():
    routes = [tp for _, tp in KERNEL_ROUTES.values() if tp is not None]
    response_types = {repr(tp): tp for tp in [*routes, *KERNEL_RESPONSES]}   # KernelError answers non-2xx
    for name, tp in response_types.items():
        first, second = build(tp), build(tp)
        adapter = TypeAdapter(tp)
        assert adapter.validate_python(adapter.dump_python(first)) == first, name
        assert adapter.dump_json(first) == adapter.dump_json(second), name


async def test_stub_honours_the_expected_status():
    k = ContractStub()
    expect = Expect(status=409, fields={"code": "stale_generation"})
    error = await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=expect)
    assert error == KernelError(code="stale_generation")
    assert (k.responses[-1].status, k.responses[-1].body) == (409, {"code": "stale_generation"})
    for status in (500, 502, 503):   # every 5xx is "internal" ("Session state responses")
        error = await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=Expect(status=status))
        assert error == KernelError(code="internal"), status


async def test_public_desk_takes_a_language():
    """`GET /public/{desk_slug}` takes `?lang=` ("Kernel HTTP API v2"), which its route key leaves
    out because a caller may; any other query parameter is still refused."""
    k = ContractStub()
    path = {"desk_slug": "rivera-plumbing-abc123"}
    for query in ({"lang": "en"}, {"lang": "es"}, None):
        await k.call("GET /public/{desk_slug}", path=path, query=query, auth=Auth.none())
    assert [called.route for called in k.responses] == ["GET /public/{desk_slug}"] * 3
    with pytest.raises(ContractError, match="takes no query parameter"):
        await k.call("GET /public/{desk_slug}", path=path, query={"language": "es"}, auth=Auth.none())
    with pytest.raises(ContractError, match="takes no query parameter"):   # only that route takes it
        await k.call("GET /health", query={"lang": "es"}, auth=Auth.none())


async def test_agent_whoami_names_its_session():
    """An agent calls `GET /whoami?session_id=` with its signature ("Kernel HTTP API v2"), since it
    holds no token the kernel could find its session by; a token caller leaves it out. No other
    query parameter is taken."""
    k = ContractStub()
    for query in ({"session_id": "s-agent"}, None):
        await k.call("GET /whoami", query=query, auth=Auth.none())
    assert [called.route for called in k.responses] == ["GET /whoami"] * 2
    with pytest.raises(ContractError, match="takes no query parameter"):
        await k.call("GET /whoami", query={"desk_id": "d-1"}, auth=Auth.none())
    with pytest.raises(ContractError, match="takes no query parameter"):   # only that route takes it
        await k.call("GET /health", query={"session_id": "s-agent"}, auth=Auth.none())


async def test_list_responses_use_index_paths():
    k = ContractStub()
    probe = {
        "actor": "visitor",
        "who": "anyone",
        "call": {"call_id": "p-1", "tool": "native.book", "args": {"slot_id": "S-20261103-1000"}},
        "resource_kind": "slot",
    }
    results = await k.call(
        "POST /policy/{version}/probe",
        path={"version": 2},
        body={"desk_id": "d-1", "probes": [probe]},
        auth=Auth.none(),
        expect=Expect(fields={"0.outcome": "allow"}),
    )
    assert [type(result) for result in results] == [ProbeResult]
    assert results[0].outcome == "allow"
    with pytest.raises(ContractError, match="outcome"):
        await k.call(
            "POST /policy/{version}/probe",
            path={"version": 2},
            body={"desk_id": "d-1", "probes": [probe]},
            auth=Auth.none(),
            expect=Expect(fields={"outcome": "allow"}),
        )


def test_matchers():
    body = {"outcome": "hold", "card_ids": ["rv-quote"], "answers": ["allow_once", "deny_once"], "execution": None}
    cases = [
        ({"outcome": "hold"}, {"outcome": "allow"}),
        ({"outcome": {"$in": ["hold", "refuse"]}}, {"outcome": {"$in": ["allow"]}}),
        ({"card_ids": {"$has": "rv-quote"}}, {"card_ids": {"$has": "rv-book-wk"}}),
        ({"answers": {"$len": 2}}, {"answers": {"$len": 4}}),
        ({"outcome": {"$not": "allow"}}, {"outcome": {"$not": {"$in": ["hold"]}}}),
        ({"execution": None}, {"execution.state": "succeeded"}),
    ]
    for matching, mismatching in cases:
        assert match_expect(200, body, Expect(fields=matching)) == [], matching
        assert len(match_expect(200, body, Expect(fields=mismatching))) == 1, mismatching
    assert match_expect(200, {"verified": True}, Expect(fields={"verified": 1})) != []   # strict: a bool is no number
    with pytest.raises(ValueError, match=r"\$like"):
        Expect(fields={"outcome": {"$like": "ho"}})


async def test_any_of_matches_one_alternative():
    expect = Expect(any_of=[Expect(status=409), Expect(status=200, fields={"outcome": "refuse"})])
    assert match_expect(409, {"code": "conflict"}, expect) == []
    assert match_expect(200, {"outcome": "refuse"}, expect) == []
    assert match_expect(200, {"outcome": "allow"}, expect) != []
    k = ContractStub()
    assert await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=expect) == KernelError(code="conflict")


async def test_agent_auth_signs_from_the_target_clock():
    k = ContractStub()
    issued = await k.call("POST /agents/demo", body={"desk_id": "d-1"}, auth=Auth.none())
    public_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(issued.agent_private_key_hex)).public_key()
    k.clock.travel(datetime(2026, 11, 3, 17, 0, tzinfo=UTC))
    agent = Auth.agent(issued, "rivera-plumbing-abc123", k.clock)
    early = Auth.agent(issued, "rivera-plumbing-abc123", k.clock, ts_offset_s=-360)

    headers = agent.headers()
    assert headers["X-Agent-Ts"].startswith("2026-11-03T17:00:")
    assert headers["X-Agent-Key-Id"] == issued.agent_key_id
    assert headers["X-Agent-Body-Sha256"] == hashlib.sha256(agent.body).hexdigest()
    signed = rfc8785.dumps({
        "desk_slug": "rivera-plumbing-abc123",
        "ts": headers["X-Agent-Ts"],
        "nonce": headers["X-Agent-Nonce"],
        "body_sha256": headers["X-Agent-Body-Sha256"],
    })
    public_key.verify(bytes.fromhex(headers["X-Agent-Sig"]), signed)

    lead = parse_signed(headers["X-Agent-Ts"]) - parse_signed(early.headers()["X-Agent-Ts"])
    assert timedelta(seconds=359) < lead < timedelta(seconds=361)

    assert agent.headers() == headers   # one turn: the same nonce and body for every call
    agent.new_turn()
    assert agent.headers()["X-Agent-Nonce"] != headers["X-Agent-Nonce"]
    assert agent.headers()["X-Agent-Body-Sha256"] != headers["X-Agent-Body-Sha256"]

    # A turn signed under a nonce already used, with another body: validly signed, so only the
    # kernel's nonce rules can refuse it.
    reused = Auth.agent(issued, "rivera-plumbing-abc123", k.clock)
    reused.new_turn(session_id="s-agent", message="Another body", nonce=headers["X-Agent-Nonce"])
    again = reused.headers()
    assert again["X-Agent-Nonce"] == headers["X-Agent-Nonce"]
    assert again["X-Agent-Body-Sha256"] == hashlib.sha256(reused.body).hexdigest() != headers["X-Agent-Body-Sha256"]
    assert json.loads(reused.body)["session_id"] == "s-agent"
    public_key.verify(bytes.fromhex(again["X-Agent-Sig"]), rfc8785.dumps({
        "desk_slug": "rivera-plumbing-abc123", "ts": again["X-Agent-Ts"], "nonce": again["X-Agent-Nonce"],
        "body_sha256": again["X-Agent-Body-Sha256"],
    }))

    # The clock gives aware UTC, whatever zone a case travels in.
    k.clock.travel(datetime(2026, 11, 3, 10, 0, tzinfo=ZoneInfo("America/Chicago")))
    assert k.clock.now().tzinfo is UTC
    assert timedelta(0) <= k.clock.now() - datetime(2026, 11, 3, 16, 0, tzinfo=UTC) < timedelta(seconds=5)
    assert TravelClock(datetime(2026, 11, 3, 10, 0, tzinfo=ZoneInfo("America/Chicago"))).now().tzinfo is UTC


async def test_agent_turn_signs_the_a2a_request_an_agent_sends():
    """A turn can carry a verification code or a mandate in its A2A body, signed with the rest; the
    API gets the body as signed and the four signature headers, and works out the body hash itself."""
    k = ContractStub()
    issued = await k.call("POST /agents/demo", body={"desk_id": "d-1"}, auth=Auth.none())
    public_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(issued.agent_private_key_hex)).public_key()
    agent = Auth.agent(issued, "rivera-plumbing-abc123", k.clock)
    agent.new_turn(session_id="s-agent", message="Here is my code", verify_code="123456")
    body = json.loads(agent.body)
    assert (body["session_id"], body["message"], body["verify_code"], body["mandate"]) == (
        "s-agent", "Here is my code", "123456", None)
    sent = agent.a2a_headers()
    assert sorted(sent) == ["X-Agent-Key-Id", "X-Agent-Nonce", "X-Agent-Sig", "X-Agent-Ts"]
    public_key.verify(bytes.fromhex(sent["X-Agent-Sig"]), rfc8785.dumps({
        "desk_slug": "rivera-plumbing-abc123", "ts": sent["X-Agent-Ts"], "nonce": sent["X-Agent-Nonce"],
        "body_sha256": hashlib.sha256(agent.body).hexdigest(),
    }))
    agent.new_turn(message="Hello", mandate=issued.mandate)
    body = json.loads(agent.body)
    assert (body["session_id"], body["verify_code"], body["mandate"]) == (
        None, None, issued.mandate.model_dump(mode="json"))


async def test_auth_headers_follow_the_kernel_contract():
    k = ContractStub()
    copy = await k.new_copy()
    visitor = await k.visitor(copy)
    assert isinstance(k, KernelHarness)
    assert isinstance(copy, CopyCreated) and isinstance(visitor, SessionCreated)
    assert [called.route for called in k.responses] == ["POST /copies", "POST /sessions"]
    assert Auth.none().headers() == {}
    assert Auth.owner(copy).headers() == {"X-Owner-Session": copy.owner_token}
    assert Auth.session(visitor).headers() == {"X-Session-Token": visitor.session_token}
    assert Auth.raw({"X-Session-Token": "forged"}).headers() == {"X-Session-Token": "forged"}
    with pytest.raises(ValueError, match="Auth.agent"):
        Auth.session(visitor.model_copy(update={"session_token": None}))


@pytest.fixture
def tier1(pytester: pytest.Pytester):
    """A copy of the eval package holding only the given tier 1 cases, its landed plans and `.env`;
    returns a runner taking the target."""

    def make(cases: dict[str, str], landed: tuple[str, ...] = ("master",), env: str = ""):
        ignore = shutil.ignore_patterns("tests", "out", "__pycache__", ".pytest_cache", "test_*.py")
        shutil.copytree(EVALS, pytester.path / "evals", ignore=ignore)
        cases_dir = pytester.path / "evals" / "tier1"
        (cases_dir / "landed.toml").write_text(f"plans = {json.dumps(list(landed))}\n")
        for name, source in cases.items():
            (cases_dir / f"{name}.py").write_text("import pytest\n\n" + textwrap.dedent(source))
        (pytester.path / ".env").write_text(env)

        def run(target: str, *args: str) -> pytest.RunResult:
            return pytester.runpytest_subprocess("evals/tier1", "--target", target, "-p", "no:cacheprovider", *args)

        return run

    return make


def case(*marks: str) -> str:
    return "".join(f"@pytest.mark.{mark}\n" for mark in marks) + "def test_case():\n    pass\n"


def test_pending_plans_skip_on_kernel_only(tier1):
    run = tier1({
        "test_needs_01c": case('requires("01c")'),
        "test_needs_02a": case('requires("01a", "02a")'),
        "test_needs_02": case('requires("02")'),
        "test_white_box": case('requires("master")', "white_box"),
    })
    kernel = run("kernel")
    kernel.assert_outcomes(passed=1, skipped=3)
    kernel.stdout.fnmatch_lines_random([
        "SKIPPED [[]1[]] evals/tier1/test_needs_01c.py:*: pending 01c",
        "SKIPPED [[]1[]] evals/tier1/test_needs_02a.py:*: needs api",
        "SKIPPED [[]1[]] evals/tier1/test_needs_02.py:*: needs api",
    ])
    stub = run("stub")
    stub.assert_outcomes(passed=1, skipped=3)
    stub.stdout.fnmatch_lines_random([
        "SKIPPED [[]1[]] evals/tier1/test_needs_02a.py:*: needs api",
        "SKIPPED [[]1[]] evals/tier1/test_needs_02.py:*: needs api",
        "SKIPPED [[]1[]] evals/tier1/test_white_box.py:*: needs kernel code",
    ])


# A landed 02a case that takes the `api` fixture, over an unstarted kernel no stand-in API calls.
API_CASE = '''
    from evals.tier1.targets import KernelTarget

    @pytest.fixture
    def k():
        return KernelTarget()

    @pytest.mark.requires("01a", "02a")
    def test_case(api):
        pass
'''


def test_landed_api_cases_fail_without_the_api_implementation(tier1, pytester: pytest.Pytester):
    """Once `landed.toml` lists 02a, its cases gate that PR on the API target, so a missing or
    misnamed `api_impl.py` fails them and the run; it never turns them into skips. A plan that
    hasn't landed still names the skip."""
    tier1({
        "test_needs_02a": API_CASE,
        "test_needs_02": case('requires("01c", "02")'),
        "test_kernel_only": case('requires("master")'),
    }, landed=("master", "01a", "01b", "01c", "02a"))
    summary_file = pytester.path / "evals" / "out" / "tier1-summary.json"
    result = pytester.run(sys.executable, "-m", "evals.run", "tier1", "--target", "api")
    assert result.ret != 0
    result.assert_outcomes(passed=1, skipped=1, errors=1)
    result.stdout.fnmatch_lines_random([
        f"*ApiUnavailable: needs api: {API_IMPL} isn't there*",
        "SKIPPED [[]1[]] evals/tier1/test_needs_02.py:*: pending 02",
    ])
    summary = json.loads(summary_file.read_text())
    assert (summary["passed"], summary["failed"], summary["needs_api"]) == (1, 1, 0)
    (pytester.path / "evals" / "tier1" / "api_impl.py").write_text(textwrap.dedent('''
        class StandInApi:
            def __init__(self, kernel):
                self.kernel = kernel

            async def start(self):
                return self

            async def stop(self):
                pass

        def make_api_target(kernel, *, models):
            return StandInApi(kernel)
    '''))
    result = pytester.run(sys.executable, "-m", "evals.run", "tier1", "--target", "api")
    assert result.ret == 0
    result.assert_outcomes(passed=2, skipped=1)
    result.stdout.fnmatch_lines(["SKIPPED [[]1[]] evals/tier1/test_needs_02.py:*: pending 02"])


def test_collection_imports_no_api_code(tier1, pytester: pytest.Pytester):
    """Only the `api` fixture imports `api_impl.py`, for the case that asks: an implementation that
    breaks on import fails that case, and collecting tier 1 never touches it."""
    run = tier1(
        {"test_needs_02a": API_CASE, "test_kernel_only": case('requires("master")')}, landed=("master", "01a", "02a")
    )
    (pytester.path / "evals" / "tier1" / "api_impl.py").write_text("raise RuntimeError('api_impl imported')\n")
    result = run("api")
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*ERROR at setup of test_case*", "*RuntimeError: api_impl imported*"])


def test_api_fixture_runs_make_api_target_over_the_kernel(tier1, pytester: pytest.Pytester):
    """`api` is Plan 02a's target over the case's kernel target, with fake models, started for the
    case and stopped after it."""
    run = tier1({"test_api": '''
        from evals.tier1.targets import KernelTarget

        @pytest.fixture
        def k():
            return KernelTarget()   # unstarted: the stand-in API never calls it

        @pytest.mark.requires("01a", "02a")
        async def test_case(k, api):
            assert api.kernel is k
            assert (api.models, api.started) == ("fake", True)
    '''}, landed=("master", "01a", "02a"))
    impl = pytester.path / "evals" / "tier1" / "api_impl.py"
    impl.write_text(textwrap.dedent('''
        from pathlib import Path

        class StandInApi:
            def __init__(self, kernel, models):
                self.kernel, self.models, self.started = kernel, models, False

            async def start(self):
                self.started = True
                return self

            async def stop(self):
                Path(__file__).with_name("stopped").write_text(self.models)

        def make_api_target(kernel, *, models):
            return StandInApi(kernel, models)
    '''))
    run("api").assert_outcomes(passed=1)
    assert impl.with_name("stopped").read_text() == "fake"


def test_unlisted_landed_names_plans_whose_code_is_here(tmp_path: Path):
    """A plan's code on the branch while `landed.toml` leaves its id out is named, in plan order;
    code that isn't there, or an id that is listed, isn't. The files are checked by path, never
    imported."""
    lands = {plan: tmp_path / f"{plan}.py" for plan in ("01a", "01b", "02a")}
    assert unlisted_landed(("master",), lands) == []
    lands["02a"].write_text("raise RuntimeError('imported')\n")
    lands["01a"].write_text("raise RuntimeError('imported')\n")
    assert unlisted_landed(("master",), lands) == ["01a", "02a"]
    assert unlisted_landed(("master", "01a"), lands) == ["02a"]
    assert unlisted_landed(("master", "01a", "02a"), lands) == []
    assert unlisted_landed(("master", "01a", "01b", "02a"), lands) == []   # listed early, with no code yet


def test_unlisted_messages_name_each_plan_with_its_grammar():
    """The collection sentence names each plan; off the gate, the warning says where their cases
    skip, as "its" for one plan and "their" for more."""
    assert unlisted_sentence(["01a"]) == "code for 01a is on this branch but landed.toml doesn't list it"
    assert unlisted_sentence(["01a", "01b"]) == (
        "code for 01a is on this branch but landed.toml doesn't list it; "
        "code for 01b is on this branch but landed.toml doesn't list it")
    after = "skip as pending on the kernel and API targets, and the gate run (CI, or --strict-landed) fails"
    assert unlisted_warning(["01a"]) == f"{unlisted_sentence(['01a'])}; its cases {after}"
    assert unlisted_warning(["01a", "01b"]) == f"{unlisted_sentence(['01a', '01b'])}; their cases {after}"


def test_lands_covers_every_plan_with_a_file_in_the_repository():
    """`LANDS` maps every plan but master (always listed) to a Python file under the repository,
    and every plan this tree lists as landed has its file here. The other direction (the file here,
    the id missing) is the run's own check: a failure on the gate, a warning off it, so a unit test
    can't assert it without failing every task of a kernel plan before its last."""
    assert set(LANDS) == set(PLANS) - {"master"}
    assert all(path.is_relative_to(EVALS.parent) and path.suffix == ".py" for path in LANDS.values())
    assert [plan for plan in load_landed() if plan in LANDS and not LANDS[plan].exists()] == []


UNLISTED_01A = "code for 01a is on this branch but landed.toml doesn't list it"


def plant_01a(pytester: pytest.Pytester) -> None:
    """Plan 01a's landing file (`create_app`), written so that importing it would show."""
    app = pytester.path / "backend" / "desk" / "kernel_service" / "app.py"
    app.parent.mkdir(parents=True)
    app.write_text("raise RuntimeError('imported at collection')\n")


@pytest.mark.parametrize("gate", ["CI", "--strict-landed"])
def test_code_on_the_branch_without_its_id_fails_the_gate_run(
    tier1, pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, gate: str
):
    """On the gate (CI, which runs on `main`, on pull requests to it and on a manual workflow run on
    any branch, or a run given `--strict-landed`), a branch holding Plan 01a's `create_app` module
    while `landed.toml` lists only master fails the run at collection, on every target, saying
    which id is missing: otherwise every 01a case would skip as pending and the gate would be off
    for that plan. The summary file and the terminal line name the plan under `unlisted` and count
    it as failed. The file is never imported. Listing the id runs them."""
    run = tier1({"test_needs_01a": case('requires("01a")')})
    plant_01a(pytester)
    monkeypatch.delenv("CI", raising=False)
    args: tuple[str, ...] = ()
    if gate == "CI":
        monkeypatch.setenv("CI", "true")
    else:
        args = (gate,)
    summary_file = pytester.path / "evals" / "out" / "tier1-summary.json"
    for target in ("stub", "kernel"):
        result = run(target, *args)
        assert result.ret != 0, target
        result.stderr.fnmatch_lines([f"*{UNLISTED_01A}*"])
        assert "imported at collection" not in result.stderr.str() + result.stdout.str()
        assert json.loads(summary_file.read_text()) == {
            "target": target, "landed": ["master"], "unlisted": ["01a"], "passed": 0, "contract_checked": 0,
            "failed": 1, "pending": {}, "needs_api": 0, "needs_kernel_code": 0,
        }
        result.stdout.fnmatch_lines([f"tier 1 on {target}: 0 * 1 failed; landed: master; unlisted: 01a"])
    (pytester.path / "evals" / "tier1" / "landed.toml").write_text('plans = ["master", "01a"]\n')
    run("stub", *args).assert_outcomes(passed=1)


def test_code_on_the_branch_without_its_id_warns_off_the_gate(
    tier1, pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
):
    """Off the gate (no `CI`, no `--strict-landed`: a task of a kernel plan on its `plan/<id>`
    branch, whose last task adds the id), the same branch runs and exits 0: the sentence is a
    warning, the 01a case runs on the stub and skips as pending 01a on the kernel, the terminal
    line and the summary name the plan under `unlisted`, and the file is still never imported."""
    tier1({"test_needs_01a": case('requires("01a")'), "test_seed": case('requires("master")')})
    plant_01a(pytester)
    monkeypatch.delenv("CI", raising=False)
    summary_file = pytester.path / "evals" / "out" / "tier1-summary.json"
    for target, outcomes in (("stub", {"passed": 2}), ("kernel", {"passed": 1, "skipped": 1})):
        result = pytester.run(sys.executable, "-m", "evals.run", "tier1", "--target", target)
        assert result.ret == 0, target
        result.assert_outcomes(**outcomes)
        result.stdout.fnmatch_lines([f"*UserWarning: {unlisted_warning(['01a'])}", "*landed: master; unlisted: 01a*"])
        assert "imported at collection" not in result.stderr.str() + result.stdout.str()
        summary = json.loads(summary_file.read_text())
        assert (summary["unlisted"], summary["failed"], summary["landed"]) == (["01a"], 0, ["master"])
    result.stdout.fnmatch_lines(["SKIPPED [[]1[]] evals/tier1/test_needs_01a.py:*: pending 01a"])


def test_unmarked_or_unknown_plan_is_an_error(tier1):
    run = tier1({"test_unmarked": case(), "test_unknown": case('requires("01d")'), "test_fine": case('requires("master")')})
    for target in ("stub", "kernel"):
        result = run(target)
        assert result.ret == pytest.ExitCode.INTERRUPTED
        result.assert_outcomes(errors=2)
        result.stdout.fnmatch_lines_random([
            "*test_unmarked.py::test_case: every tier 1 case names the plans it needs*",
            "*test_unknown.py::test_case: requires names unknown plans [[]'01d'[]]*",
            "*Interrupted: 2 errors during collection*",
        ])


def test_summary_counts_pending_by_plan(tier1, pytester: pytest.Pytester):
    tier1({
        "test_verify": case('requires("01b")') + "\n\n" + case('requires("01b")').replace("test_case", "test_other"),
        "test_money": case('requires("01c")'),
        "test_seed": case('requires("master")'),
    })
    summary_file = pytester.path / "evals" / "out" / "tier1-summary.json"
    kernel = pytester.run(sys.executable, "-m", "evals.run", "tier1", "--target", "kernel")
    assert kernel.ret == 0
    assert json.loads(summary_file.read_text()) == {
        "target": "kernel", "landed": ["master"], "unlisted": [], "passed": 1, "contract_checked": 0,
        "failed": 0, "pending": {"01b": 2, "01c": 1}, "needs_api": 0, "needs_kernel_code": 0,
    }
    stub = pytester.run(sys.executable, "-m", "evals.run", "tier1", "--target", "stub")
    assert stub.ret == 0
    assert json.loads(summary_file.read_text()) == {
        "target": "stub", "landed": ["master"], "unlisted": [], "passed": 0, "contract_checked": 4,
        "failed": 0, "pending": {}, "needs_api": 0, "needs_kernel_code": 0,
    }
    stub.stdout.fnmatch_lines(["*tier 1 on stub: 4 contract-checked (not passes), 0 failed*"])


def test_other_skips_fail(tier1, pytester: pytest.Pytester):
    run = tier1({
        "test_skips_itself": '@pytest.mark.requires("master")\ndef test_case():\n    pytest.skip("flaky")\n',
        "test_xfails": '@pytest.mark.requires("master")\n@pytest.mark.xfail\ndef test_case():\n    assert False\n',
        "test_skips_module": 'pytest.skip("not today", allow_module_level=True)\n\n' + case('requires("master")'),
        "test_imports_or_skips": 'pytest.importorskip("no_such_module")\n\n' + case('requires("master")'),
        "test_fine": case('requires("master")'),
    })
    module_skips = ("test_skips_module", "test_imports_or_skips")
    result = run("kernel", *(f"--ignore=evals/tier1/{name}.py" for name in module_skips))
    result.assert_outcomes(passed=1, failed=2)
    result.stdout.fnmatch_lines(["*tier 1 skips a case only when a plan it requires hasn't landed*flaky*"])
    # A module that skips itself drops its cases at collection: that is a collection error too.
    for target in ("stub", "kernel"):
        result = run(target)
        assert result.ret == pytest.ExitCode.INTERRUPTED
        result.assert_outcomes(errors=2)
        result.stdout.fnmatch_lines_random([
            "*tier 1 skips a case only when a plan it requires hasn't landed*not today*",
            "*tier 1 skips a case only when a plan it requires hasn't landed*no_such_module*",
            "*Interrupted: 2 errors during collection*",
        ])
    summary_file = pytester.path / "evals" / "out" / "tier1-summary.json"
    ran = pytester.run(sys.executable, "-m", "evals.run", "tier1", "--target", "kernel")
    assert ran.ret != 0
    assert json.loads(summary_file.read_text())["failed"] == 2


def test_tier1_environment_holds_no_real_key(tier1, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-the-shell")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "token-from-the-shell")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    monkeypatch.delenv("KERNEL_DATABASE_URL", raising=False)
    monkeypatch.delenv("DESK_ADMIN_PASSWORD", raising=False)
    env = (
        "ANTHROPIC_API_KEY=sk-ant-from-dotenv\n"
        "DESK_ADMIN_PASSWORD=admin-secret-from-dotenv\n"
        "KERNEL_DATABASE_URL=postgresql+psycopg://desk_kernel:kernel-secret@localhost:5433/desk\n"
    )
    run = tier1({"test_environment": '''
        import os

        @pytest.mark.requires("master")
        def test_case():
            assert os.environ["ANTHROPIC_API_KEY"] == "tier1-dummy"
            assert "ANTHROPIC_AUTH_TOKEN" not in os.environ
            assert os.environ["ANTHROPIC_BASE_URL"].startswith("http://127.0.0.1:")   # the run's fake model server
            assert "DESK_ADMIN_PASSWORD" not in os.environ
            assert os.environ["KERNEL_DATABASE_URL"].endswith(":kernel-secret@localhost:5433/desk")
    '''}, env=env)
    result = run("stub")
    result.assert_outcomes(passed=1)
    output = result.stdout.str() + result.stderr.str()
    assert "secret" not in output and "from-dotenv" not in output


def test_non_loopback_connection_refused(tier1):
    run = tier1({"test_network": '''
        import socket

        @pytest.mark.requires("master")
        def test_case():
            with socket.create_server(("127.0.0.1", 0)) as server:
                port = server.getsockname()[1]
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    pass
                for address in [("192.0.2.1", 80), ("localhost", port)]:
                    with socket.socket() as sock:
                        sock.settimeout(1)
                        with pytest.raises(ConnectionRefusedError, match="tier 1 refuses connections off loopback"):
                            sock.connect(address)
                        with pytest.raises(ConnectionRefusedError, match="off loopback"):
                            sock.connect_ex(address)
    '''})
    run("stub").assert_outcomes(passed=1)


def test_a_model_call_outside_a_target_fails_the_run(tier1, pytester: pytest.Pytester):
    run = tier1({"test_stray_client": '''
        import anthropic

        @pytest.mark.requires("master")
        def test_case():
            client = anthropic.Anthropic(max_retries=0)   # made outside any target: the run's fake answers
            with pytest.raises(anthropic.InternalServerError, match="unscripted"):
                client.messages.create(model="claude-opus-5-5", max_tokens=16, messages=[{"role": "user", "content": "Hi"}])
    '''})
    result = run("stub")
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*1 unscripted model calls reached the fake model server (claude-opus-5-5)*"])
