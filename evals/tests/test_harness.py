"""The tier 1 harness: the contract stub, expectations, plan markers, the summary and the guards."""

import hashlib
import importlib
import json
import secrets
import shutil
import sys
import textwrap
from collections import deque
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
import pytest
import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import (
    AwareDatetime,
    BaseModel,
    FutureDate,
    FutureDatetime,
    NaiveDatetime,
    PastDate,
    PastDatetime,
    TypeAdapter,
    create_model,
)

from desk.contracts import CopyCreated, Decision, ExecResult, ProbeResult, SessionCreated
from desk.db.session import database_url, libpq_url
from desk.db.tables import APP_TABLES, KERNEL_TABLES, MOCKPAY_TABLES
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
from evals.tier1.targets import API_IMPL, CASE_SCHEMAS, empty_database

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


def test_undeclared_response_fields_are_found_by_path():
    """`undeclared_fields` finds every field a kernel answer carries that its response model
    doesn't declare, nested ones and a union member's included, by where it sits and never by its
    name or value: the path shows the contract's field names and list indexes, and `*` for the key
    the answer chose. A declared field the answer leaves out sits at its default, which isn't
    undeclared, and whatever a `dict` field holds is declared by it."""
    notice = {"entry_id": "e-1", "to": "d•••@example.com", "preview": "A code is on its way."}
    started = {"message": "If that contact is on record, a code is on its way.", "inbox": [notice]}
    assert undeclared_fields(started, VerifyStarted.model_validate(started)) == []
    leaking = {**started, "verification_code": "482913"}
    assert undeclared_fields(leaking, VerifyStarted.model_validate(leaking)) == ["*"]
    nested = {**started, "inbox": [notice, {**notice, "code": "482913"}]}
    assert undeclared_fields(nested, VerifyStarted.model_validate(nested)) == ["inbox.1.*"]
    error = {"code": "invalid", "diagnostic": "five attempts used"}
    assert undeclared_fields(error, KernelError.model_validate(error)) == ["*"]
    whoami = build(WhoAmI, Expect(fields={"session.kind": "visitor"})).model_dump(mode="json")
    in_session = {**whoami, "session": {**whoami["session"], "person_id": "p-dana"}}
    assert undeclared_fields(in_session, WhoAmI.model_validate(in_session)) == ["session.*"]
    result = build(ExecResult, Expect(fields={"inbox": {"$len": 0}})).model_dump(mode="json")
    del result["inbox"]   # left out: at its default
    viewed = {**result, "model_view": {"quote_id": "q-1", "lines": [{"item": "drain", "cents": 18000}]}}
    assert undeclared_fields(viewed, ExecResult.model_validate(viewed)) == []
    twice = {**viewed, "receipt": {}, "facts": [{**fact, "extra": 1} for fact in viewed["facts"]]}
    assert undeclared_fields(twice, ExecResult.model_validate(twice)) == [
        f"facts.{n}.*" for n in range(len(viewed["facts"]))] + ["*"]


class Keyed(BaseModel):
    """A model with a `dict` of models, so a key the answer chose sits on the path to a field."""

    by_key: dict[str, VerifyStarted]


def test_an_undeclared_or_dynamic_key_is_never_named():
    """A key the contract doesn't declare is the answer's own choice, so it may be a code or a
    token, and a token can be spelled like a field name: `undeclared_fields` shows `*` for every
    such key, and for every key of a `dict` field, whatever its spelling. Only the contract's own
    field names and list indexes are shown."""
    token = "tok_" + secrets.token_hex(16)        # shaped like an identifier
    hex_key = "e" + secrets.token_hex(19)          # hexadecimal, starting with a letter
    notice = {"entry_id": "e-1", "to": "d•••@example.com", "preview": "A code is on its way."}
    keyed = {"message": "If that contact is on record, a code is on its way.",
             "inbox": [{**notice, "c-482913": 1, hex_key: 2}], "482913": True, "named_like_a_field": 1, token: 3}
    found = undeclared_fields(keyed, VerifyStarted.model_validate(keyed))
    assert found == ["inbox.0.*", "inbox.0.*", "*", "*", "*"]
    by_key = {"by_key": {token: {**keyed, "inbox": [notice]}, hex_key: {"message": "Hi", "inbox": [], "x": 1}}}
    found = undeclared_fields(by_key, Keyed.model_validate(by_key))
    assert found == ["by_key.*.*", "by_key.*.*", "by_key.*.*", "by_key.*.*"]
    assert not [path for path in found if token in path or hex_key in path]


async def test_a_request_off_contract_is_told_without_its_values():
    """A request that breaks its model fails by field and kind of error, never by what it held:
    pydantic's own text quotes the input, which may be a code or a token. So do the stub's
    expected values when they don't fit the response model."""
    k = ContractStub()
    body = {"session_id": "s-482913", "generation": "g-314159", "call": {"call_id": "c-271828", "tool": "native.quote"}}
    with pytest.raises(ContractError, match=r"breaks DecideRequest: .*generation: int_parsing") as failure:
        await k.call("POST /decide", body=body, auth=Auth.none())
    shown = str(failure.value)
    assert "call.args: missing" in shown, shown
    assert [value for value in ("482913", "314159", "271828", "native.quote") if value in shown] == [], shown
    with pytest.raises(ContractError, match=r"don't fit the response model: outcome: literal_error") as failure:
        await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=Expect(fields={"outcome": "482913"}))
    assert "482913" not in str(failure.value), str(failure.value)


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


def kernel_response_types() -> dict[str, type]:
    routes = [tp for _, tp in KERNEL_ROUTES.values() if tp is not None]
    return {repr(tp): tp for tp in [*routes, *KERNEL_RESPONSES]}   # KernelError answers non-2xx


def test_stub_builds_every_response_model():
    for name, tp in kernel_response_types().items():
        first, second = build(tp), build(tp)
        adapter = TypeAdapter(tp)
        assert adapter.validate_python(adapter.dump_python(first)) == first, name
        assert adapter.dump_json(first) == adapter.dump_json(second), name


@pytest.fixture
def wall_clock(monkeypatch: pytest.MonkeyPatch) -> type:
    """The wall clock as the stub's generators could read it, moved by `wall_clock.offset`. The
    modules that read it for a generated value (Faker's date and time provider, polyfactory's
    constrained dates) get `datetime` and `date` classes whose `now` and `today` are that far off;
    `isinstance` against them still takes the real classes' values."""

    class WallClock:
        offset = timedelta()

    class TakesReal(type):
        def __instancecheck__(cls, value: object) -> bool:
            return isinstance(value, cls.__base__)

    class MovedDatetime(datetime, metaclass=TakesReal):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + WallClock.offset

        @classmethod
        def today(cls):
            return datetime.today() + WallClock.offset

    class MovedDate(date, metaclass=TakesReal):
        @classmethod
        def today(cls):
            return date.today() + WallClock.offset

    for name in ("faker.providers.date_time", "polyfactory.value_generators.constrained_dates"):
        module = importlib.import_module(name)
        names = vars(module)
        assert any(value is datetime for value in names.values()), f"{name} no longer reads the clock as datetime"
        for attr, value in list(names.items()):
            if value is datetime or value is date:
                monkeypatch.setattr(module, attr, MovedDatetime if value is datetime else MovedDate)
    return WallClock


class Moments(BaseModel):
    """A field of each date and time type the stub's generators fill."""

    at: datetime
    aware: AwareDatetime
    naive: NaiveDatetime
    day: date
    clock: time
    span: timedelta


class Bare(BaseModel):
    """A field of each bare collection the stub's generators fill with plain values."""

    bag: dict
    items: list
    row: tuple
    kinds: set
    frozen: frozenset
    queue: deque


def test_stub_responses_never_read_the_wall_clock(wall_clock):
    """The stub's answer to a call doesn't depend on when it is built: every date and time it
    generates, nested ones, those in a bare collection's values and those a `$not` makes it build
    again, comes from its seeded generators, never the wall clock (moved here twenty years either
    way)."""
    models = {**kernel_response_types(), "Moments": Moments, "Bare": Bare}

    def build_all() -> dict[str, str]:
        built = {name: TypeAdapter(tp).dump_json(build(tp)).decode() for name, tp in models.items()}
        rejected = Expect(fields={field: {"$not": value} for field, value in json.loads(built["Moments"]).items()})
        built["Moments, each field rejected"] = build(Moments, rejected).model_dump_json()
        return built

    wall_clock.offset = timedelta(days=-20 * 365)
    earlier = build_all()
    wall_clock.offset = timedelta(days=20 * 365)
    assert build_all() == earlier
    first, again = json.loads(earlier["Moments"]), json.loads(earlier["Moments, each field rejected"])
    assert [field for field in first if again[field] == first[field]] == []   # each was built again


def test_stub_refuses_dates_relative_to_today():
    """A past or a future date (`PastDate`, `FutureDate`, `PastDatetime`, `FutureDatetime`) is
    one polyfactory fills from the wall clock and pydantic checks against today, so the stub has no
    seeded value for it: building a stand-in model holding one fails at build time, naming the
    type, and so does an expectation that needs a value where the default build left an optional
    one empty."""
    for tp in (PastDate, FutureDate, PastDatetime, FutureDatetime):
        name = tp.__name__
        holding = create_model(f"Holding{name}", when=(tp, ...))
        with pytest.raises(NotImplementedError, match=rf"can't build a {name}:"):
            build(holding)
        maybe = create_model(f"Maybe{name}", when=(tp | None, None))
        with pytest.raises(NotImplementedError, match=rf"can't build a {name}:"):
            build(maybe, Expect(fields={"when": {"$not": None}}))


async def test_stub_honours_the_expected_status():
    k = ContractStub()
    expect = Expect(status=409, fields={"code": "stale_generation"})
    error = await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=expect)
    assert error == KernelError(code="stale_generation")
    assert (k.responses[-1].status, k.responses[-1].body) == (409, {"code": "stale_generation"})
    for status in (500, 502, 503):   # every 5xx is "internal" ("Session state responses")
        error = await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=Expect(status=status))
        assert error == KernelError(code="internal"), status


async def test_stub_omits_unrequested_details_and_preserves_public_field_refusals():
    k = ContractStub()
    error = await k.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=Expect(status=422))
    assert error == KernelError(code="invalid")
    assert k.responses[-1].body == {"code": "invalid"}
    details = {"desk.intake.title": ["public_promise"]}
    detailed = await k.call("POST /decide", body=decide_body(), auth=Auth.none(),
                            expect=Expect(status=422, fields={"detail": details}))
    assert detailed == KernelError(code="invalid", detail=details)
    assert k.responses[-1].body == {"code": "invalid", "detail": details}


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


def test_a_mismatch_never_prints_what_a_list_or_object_held():
    """A list or an object the response held is told by its type and size alone: a start that
    should send nothing but sent a code fails showing neither the entry's code nor its contact,
    nor any other part of it."""
    entry = {"entry_id": "e-1", "to": "dana@example.com", "preview": "Your code is 482913"}
    assert match_expect(200, {"inbox": [entry]}, Expect(fields={"inbox": []})) == [
        "inbox: expected [], got a list of 1 item"]
    assert match_expect(200, {"inbox": [entry, entry]}, Expect(fields={"inbox": {"$len": 1}})) == [
        "inbox: expected {'$len': 1}, got a list of 2 items"]
    assert match_expect(200, {"model_view": entry}, Expect(fields={"model_view": {}})) == [
        "model_view: expected {}, got an object with 3 fields"]
    assert match_expect(200, {"execution": {"state": "succeeded"}}, Expect(fields={"execution": None})) == [
        "execution: expected None, got an object with 1 field"]


def test_a_mismatch_tells_a_string_by_its_size_unless_the_expectation_names_it():
    """A string the response held is shown only when the expectation itself names it and it is
    short and shaped like a field name or an enum value; any other is told by its length, since it
    may be a contact, a code or a token. A code or token the expectation names is still hidden on
    the got side (the expected side is the case's own text, printed as written): a code starts
    with a digit, and a token is longer than any field name or enum value."""
    session_token = secrets.token_urlsafe(32)   # tokens made fresh each run, so none is in the source
    named_token = "tok_" + secrets.token_hex(16)
    hex_token = "e" + secrets.token_hex(15)     # 31 characters, one over the longest shown
    mismatches = {
        "a raw contact for a masked one": ({"to": "dana@example.com"}, {"to": "d•••@example.com"},
                                           "to: expected 'd•••@example.com', got a string of 16 characters"),
        "a code in a preview": ({"preview": "Your code is 482913"}, {"preview": {"$not": {"$has": "482913"}}},
                                "preview: expected {'$not': {'$has': '482913'}}, got a string of 19 characters"),
        "a code the expectation names": ({"preview": "482913"}, {"preview": {"$not": "482913"}},
                                         "preview: expected {'$not': '482913'}, got a string of 6 characters"),
        "a token for none": ({"session_token": session_token}, {"session_token": None},
                             "session_token: expected None, got a string of 43 characters"),
        "an enum value it doesn't name": ({"outcome": "hold"}, {"outcome": "allow"},
                                          "outcome: expected 'allow', got a string of 4 characters"),
        "an empty string": ({"outcome": ""}, {"outcome": "allow"}, "outcome: expected 'allow', got an empty string"),
        "a named value with a capital letter": ({"outcome": "Allow"}, {"outcome": {"$not": "Allow"}},
                                                "outcome: expected {'$not': 'Allow'}, got a string of 5 characters"),
    }
    for name, (body, fields, shown) in mismatches.items():
        assert match_expect(200, body, Expect(fields=fields)) == [shown], name
    for token in (named_token, hex_token):   # named, and shaped like a field name, but longer than one
        [mismatch] = match_expect(200, {"session_token": token}, Expect(fields={"session_token": {"$not": token}}))
        assert mismatch.endswith(f", got a string of {len(token)} characters"), len(token)


def test_a_mismatch_shows_numbers_and_the_names_the_expectation_gives():
    """Numbers, booleans and None are shown as they are, and so is a string the expectation names
    anywhere, in a matcher or another alternative, when it is shaped like a field name or an enum
    value (lowercase words, a tool's dotted name) and no longer than one."""
    shown = {
        "a number": ({"amount_cents": 18500}, {"amount_cents": 18000}, "amount_cents: expected 18000, got 18500"),
        "a boolean for a number": ({"verified": True}, {"verified": 1}, "verified: expected 1, got True"),
        "a number for none": ({"first_bad_seq": 3}, {"first_bad_seq": None}, "first_bad_seq: expected None, got 3"),
        "none": ({"verdict": None}, {"verdict": "pass"}, "verdict: expected 'pass', got None"),
        "a value it rules out": ({"outcome": "allow"}, {"outcome": {"$not": "allow"}},
                                 "outcome: expected {'$not': 'allow'}, got 'allow'"),
        "a tool it rules out": ({"tool": "native.quote"}, {"tool": {"$not": {"$in": ["native.book", "native.quote"]}}},
                                "tool: expected {'$not': {'$in': ['native.book', 'native.quote']}}, "
                                "got 'native.quote'"),
        "the longest field name": ({"field": "agent_mandate_remaining_cents"},
                                   {"field": {"$not": "agent_mandate_remaining_cents"}},
                                   "field: expected {'$not': 'agent_mandate_remaining_cents'}, "
                                   "got 'agent_mandate_remaining_cents'"),
    }
    for name, (body, fields, mismatch) in shown.items():
        assert match_expect(200, body, Expect(fields=fields)) == [mismatch], name
    either = Expect(any_of=[Expect(fields={"outcome": "allow", "state": "allowed"}),
                            Expect(fields={"outcome": "hold", "state": "held"})])
    assert match_expect(200, {"outcome": "hold", "state": "allowed"}, either) == [
        "matches none of 2 alternatives: outcome: expected 'allow', got 'hold' | "
        "state: expected 'held', got 'allowed'"]


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
    returns a runner taking the target. No plan's landing file comes with it: Plan 02a's
    `api_impl.py` stays out as Plan 01a's `create_app` module does (it lives outside `evals/`), and
    a case that needs one plants it."""

    def make(cases: dict[str, str], landed: tuple[str, ...] = ("master",), env: str = ""):
        ignore = shutil.ignore_patterns("tests", "out", "__pycache__", ".pytest_cache", "test_*.py", "api_impl.py")
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


def test_empty_database_empties_every_table_a_case_can_write():
    """Every table of the kernel, the API, the mock payments server and the API's job queue, each
    table the code names among them, is emptied: no case can find a row an earlier case wrote."""
    named = {*(f"kernel.{table}" for table in KERNEL_TABLES), *(f"app.{table}" for table in APP_TABLES),
             *(f"mockpay.{table}" for table in MOCKPAY_TABLES)}
    emptied = empty_database()
    assert named <= set(emptied)
    assert {table.split(".")[0] for table in emptied} == set(CASE_SCHEMAS)
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        rows = {table: admin.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in emptied}
    assert rows == dict.fromkeys(emptied, 0)


def test_each_case_on_the_real_kernel_starts_on_an_empty_database(tier1):
    """`k` empties every kernel, API, mock payments and job queue table before it starts the case's
    kernel, so a case finds only what it makes: a kernel's startup looks at every copy in the
    database, and copies that earlier cases left made each start slower than the last."""
    run = tier1({"test_empty": '''
        import psycopg

        from desk.db.session import database_url, libpq_url

        def copies():
            with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
                return admin.execute("SELECT count(*) FROM kernel.copies").fetchone()[0]

        @pytest.mark.requires("01a")
        async def test_a_case_leaves_a_copy(k):
            await k.new_copy()
            assert copies() >= 1

        @pytest.mark.requires("01a")
        async def test_the_next_case_finds_none(k):
            assert copies() == 0
    '''}, landed=("master", "01a", "01b", "01c"))
    run("kernel", "--allow-bounded").assert_outcomes(passed=2)


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


async def test_stub_preserves_valid_public_policy_refusal_detail():
    detail = {"policy:about": ["language", "lex.en.promise"]}
    expect = Expect(status=422, fields={"code": "invalid", "detail": detail})
    stub = ContractStub()
    error = await stub.call("POST /decide", body=decide_body(), auth=Auth.none(), expect=expect)
    assert error == KernelError(code="invalid", detail=detail)
    assert undeclared_fields(stub.responses[-1].body, error) == []
    assert stub.responses[-1].body == {"code": "invalid", "detail": detail}
