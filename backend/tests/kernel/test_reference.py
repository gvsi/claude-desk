"""The reference generator and the bounded check.

`reference.py` derives what the owner's cards allow a second time, from the cards and the schema
alone, without the compiler. The bounded check evaluates the compiled sets and the reference sets
on requests generated at every card boundary and compares them, so these tests show both that the
two generators agree on the overlap and joint-coverage rules and that a compiler that drops an
exclusion or ORs a review gate is caught.
"""

import ast
import json
import re
from datetime import time
from pathlib import Path

import desk_kernel

from desk.contracts import HoursWindow, RuleCard, ToolProfile
from desk.kernel_service import activation, compiler, reference
from desk.kernel_service.seed import RIVERA_CARDS

from .helpers import TEST_CAP, compile_at, context
from .test_compiler import A_MIX_OF_CARDS, DANA, NATIVE_TOOLS, REFUND, WEEKDAYS, card, native_profile, schema_for

REFERENCE_PY = Path(reference.__file__)
CHECKS = {"auto_within_cards", "review_only_narrows", "hold_within_cards", "money_needs_card", "never_errors"}


def native_profiles() -> list[ToolProfile]:
    """A profile for every native tool the schema declares: effects from `memberOf`, the resource
    kind from `appliesTo` (the compiler tests' `native_profile`). `schema_for` adds an action for
    each test-only tool, such as the refund tool with `pay_out` and `private_data`."""
    return [native_profile(tool) for tool in NATIVE_TOOLS]


def check(cards: list[RuleCard], profiles: list[ToolProfile] | None = None, *, key_prefix: str = "desk-test:1",
          engine: desk_kernel.PolicyEngine | None = None):
    """The bounded check of `cards` compiled over `profiles` (the native tools by default), against
    the reference sets, on a fresh engine with the real baseline."""
    profiles = profiles if profiles is not None else native_profiles()
    schema = schema_for(profiles)
    compiled = compile_at(cards, profiles)
    a0 = compile_at(cards, profiles, review=False).A
    refs = reference.reference_sets(cards, schema)
    engine = engine or desk_kernel.PolicyEngine(compiler.BASELINE)
    return activation.bounded_check(engine, key_prefix=key_prefix, schema_json=json.dumps(schema), compiled=compiled,
                                    a0=a0, refs=refs, cards=cards, profiles=profiles, auto_money_cap_cents=TEST_CAP)


def auto_allows(verdict: dict) -> bool:
    """The auto evaluation allowed: an allow, or a hold an `A.` permit decided (money step 5)."""
    return verdict["outcome"] == "allow" or (
        verdict["outcome"] == "hold" and any(p.startswith("A.") for p in verdict["policy_ids"]))


def same_decisions(cards: list[RuleCard], profiles: list[ToolProfile] | None = None) -> int:
    """The bounded check shows only that the compiler is no wider than the reference. Here the two
    must agree exactly, on every bounded case: `R` auto-allows exactly where the compiler's `A0`
    does, and `R_hold` holds exactly where `H` does, so a reference wider than the cards (which
    would weaken every proof) fails too. Returns the number of cases compared."""
    profiles = profiles if profiles is not None else native_profiles()
    schema = schema_for(profiles)
    compiled = compile_at(cards, profiles, review=False)
    refs = reference.reference_sets(cards, schema)
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    loads = {"a0": (compiled.F, compiled.A, ""), "R": (refs.never, refs.R, ""),
             "approvable": (compiled.F, "", compiled.H), "R_hold": (refs.never, "", refs.R_hold)}
    for key, (f, a, h) in loads.items():
        assert engine.load(key, json.dumps(schema), json.dumps({"F": f, "A": a, "H": h})) == [], key
    cases = activation.bounded_cases(cards, profiles, schema, auto_money_cap_cents=TEST_CAP)
    for case in cases:
        verdict = {key: json.loads(engine.decide(key, json.dumps(case), "final")) for key in loads}
        assert not any(v["errors"] for v in verdict.values()), (case, verdict)
        assert auto_allows(verdict["a0"]) == auto_allows(verdict["R"]), (case, verdict)
        assert (verdict["approvable"]["outcome"] == "hold") == (verdict["R_hold"]["outcome"] == "hold"), (case, verdict)
    return len(cases)


def assert_agrees(report) -> None:
    failing = [(c.name, c.counterexample_raw) for c in report.checks if not c.ok]
    assert report.ok and not failing, failing
    assert report.method == "bounded" and {c.name for c in report.checks} == CHECKS


def test_reference_imports_nothing_from_the_compiler():
    imported: set[str] = set()
    for node in ast.walk(ast.parse(REFERENCE_PY.read_text())):
        if isinstance(node, ast.Import):
            imported |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            base = "." * node.level + (node.module or "")
            imported.add(base)
            imported |= {f"{base}.{alias.name}" for alias in node.names}
    assert not any("compiler" in name or "activation" in name for name in imported), imported
    # nothing from the kernel service at all: the reference reads only the cards, the schema and the contracts
    desk_modules = {name for name in imported if name.startswith(("desk", "."))}
    assert desk_modules <= {"desk.contracts"} | {name for name in desk_modules if name.startswith("desk.contracts.")}


def test_reference_agrees_with_the_compiler_on_rivera():
    report = check(RIVERA_CARDS)
    assert_agrees(report)
    assert report.cases > 100
    assert same_decisions(RIVERA_CARDS) == report.cases


AGENT = {"agent_key_id": "agent-key-1"}

# Each card set from the compiler's overlap tests, and a few that combine them.
OVERLAP_SETS = {
    "tool ask beats effect auto": [card("changes", "effect:change"), card("ask-booking", "native.book", mode="ask")],
    "person auto beats effect ask": [
        card("charges-ask", "effect:charge", mode="ask"),
        card("dana-link", "native.payment_link", who="person", max_amount_cents=2000, **DANA)],
    "more specific auto decides": [
        card("charges", "effect:charge", max_amount_cents=10_000),
        card("dana-link", "native.payment_link", who="person", max_amount_cents=2000, **DANA)],
    "same level, tool": [card("book", "native.book"), card("ask-verified", "native.book", mode="ask", who="verified")],
    "same level, effect": [card("changes", "effect:change", who="verified"),
                           card("ask-changes", "effect:change", mode="ask")],
    "same level, person": [card("dana-book", "native.book", who="person", **DANA),
                           card("dana-ask", "native.book", mode="ask", who="person", **DANA)],
    "a less specific ask below": [card("dana-book", "native.book", who="person", **DANA),
                                  card("dana-ask", "effect:change", mode="ask", who="person", **DANA)],
    "same level autos add up, tool": [card("quote-anyone", "native.quote", max_discount_bp=1000),
                                      card("quote-verified", "native.quote", who="verified", max_discount_bp=2000)],
    "same level autos add up, effect": [card("changes", "effect:change", max_amount_cents=1000),
                                        card("changes-verified", "effect:change", who="verified",
                                             max_amount_cents=5000)],
    "never always wins": [card("no-changes", "effect:change", mode="never"),
                          card("dana-book", "native.book", who="person", **DANA),
                          card("ask-book", "native.book", mode="ask")],
    "a never for Dana": [card("dana-no-book", "native.book", mode="never", who="person", **DANA),
                         card("book", "native.book")],
    "narrow auto for Dana": [card("dana-books", "native.book", who="person", **DANA)],
    "narrow never for Dana": [card("dana-books", "native.book", mode="never", who="person", **DANA)],
    "an agent's charges": [card("charges-ask", "effect:charge", mode="ask"),
                           card("agent-charge", "native.charge_mandate", who="agent", max_amount_cents=5000, **AGENT),
                           card("agent-no-pay-out", "effect:pay_out", mode="never", who="agent", **AGENT)],
    "hours, reviews and overlap": [card("book-weekdays", "native.book", hours=WEEKDAYS, review=True),
                                   card("book-dana", "native.book", who="person", max_discount_bp=500, **DANA),
                                   card("changes", "effect:change", review=True, max_discount_bp=1000,
                                        max_amount_cents=30_000),
                                   card("ask-quote-verified", "native.quote", mode="ask", who="verified")],
}


def test_reference_agrees_on_the_overlap_cases():
    for name, cards in OVERLAP_SETS.items():
        report = check(cards)
        failing = [(c.name, c.counterexample_raw) for c in report.checks if not c.ok]
        assert report.ok and not failing, (name, failing)
        assert same_decisions(cards) == report.cases > 0, name


EVE = {"person_id": "eve"}
# Joint coverage of the two-effect tools, and default asks (`native.release_document` and the
# test refund tool, with `pay_out` and `private_data`).
JOINT_SETS = {
    "joint autos take the tightest limits": [card("refunds", "effect:pay_out", max_amount_cents=5000),
                                             card("private-verified", "effect:private_data", who="verified",
                                                  max_amount_cents=20_000)],
    "joint coverage keeps the review gate": [card("send-reviewed", "effect:send_message", review=True),
                                             card("private-owner", "effect:private_data", who="record_owner")],
    "one effect auto alone": [card("send", "effect:send_message")],
    "one effect auto and an ask": [card("send", "effect:send_message"),
                                   card("private", "effect:private_data", mode="ask")],
    "one effect auto and a never": [card("send", "effect:send_message"),
                                    card("private", "effect:private_data", mode="never")],
    "an auto for one tool, defaults elsewhere": [card("slots", "native.find_slots")],
    "a never for anyone silences the default": [card("no-booking", "native.book", mode="never")],
    "a never for Dana keeps the default": [card("no-booking-dana", "native.book", mode="never", who="person", **DANA)],
    "a verified change card beside the booking default": [card("verified-changes", "effect:change", who="verified")],
    "money without an owner card": [card("changes", "effect:change"),
                                    card("private", "effect:private_data", who="record_owner"),
                                    card("send", "effect:send_message")],
    "a combination of Dana and Eve above one for anyone": [
        card("send-dana", "effect:send_message", who="person", **DANA),
        card("private-eve", "effect:private_data", who="person", **EVE),
        card("send", "effect:send_message"),
        card("private-owner", "effect:private_data", who="record_owner")],
    "a combination for Dana above a tool card": [
        card("docs", "native.release_document", review=True),
        card("send-dana", "effect:send_message", who="person", hours=WEEKDAYS, **DANA),
        card("private-dana", "effect:private_data", who="person", **DANA)],
    "a mix of every shape": A_MIX_OF_CARDS,
}


def test_reference_agrees_on_joint_coverage_and_default_asks():
    profiles = [*native_profiles(), REFUND]
    for name, cards in JOINT_SETS.items():
        report = check(cards, profiles)
        failing = [(c.name, c.counterexample_raw) for c in report.checks if not c.ok]
        assert report.ok and not failing, (name, failing)
        assert same_decisions(cards, profiles) == report.cases > 0, name

    # the reference derives the same default asks as the compiler, from the schema alone
    schema = schema_for(profiles)
    for name, cards in JOINT_SETS.items():
        compiled = {c.card_id for c in compile_at(cards, profiles).cards if c.is_default}
        derived = set(re.findall(r'@id\("ask\.(default:[^"]+)"\)', reference.reference_sets(cards, schema).R_hold))
        assert derived == compiled, name
    verified_changes = reference.reference_sets(JOINT_SETS["a verified change card beside the booking default"], schema)
    assert '@id("ask.default:native.book")' in verified_changes.R_hold
    assert '@id("auto.verified-changes")' in verified_changes.R
    # one joint permit, listing both cards, and no permit of either card's own for the refund tool
    joint = reference.reference_sets(JOINT_SETS["joint autos take the tightest limits"], schema)
    assert re.findall(r'@id\("([^"]+)"\)', joint.R) == ["auto.private-verified+refunds"]
    assert '@card("private-verified,refunds")' in joint.R and "context.amount_cents <= 5000" in joint.R


def decide_raw(sets: dict[str, str], schema: dict, request: dict) -> dict:
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    assert engine.load("raw", json.dumps(schema), json.dumps(sets)) == []
    return json.loads(engine.decide("raw", json.dumps(request), "final"))


def test_a_missing_exclusion_is_caught(monkeypatch):
    monkeypatch.setattr(compiler, "_exclusions", lambda *args: "")      # no `unless`: every auto card decides alone
    cards = OVERLAP_SETS["more specific auto decides"]                   # charges <= 10000; Dana's link <= 2000
    assert "unless" not in compile_at(cards, native_profiles()).A
    report = check(cards)
    assert not report.ok
    failed = {c.name: c for c in report.checks if not c.ok}
    assert set(failed) == {"auto_within_cards"}, failed
    raw = failed["auto_within_cards"].counterexample_raw
    # the counterexample is a request_json: Dana over her own limit, allowed by the wider effect card
    assert raw["action"] == "native.payment_link"
    principal = next(e for e in raw["entities"] if e["uid"] == raw["principal"])
    assert principal["attrs"]["person_id"] == "dana" and raw["context"]["amount_cents"] > 2000
    schema = schema_for(native_profiles())
    assert decide_raw(compile_at(cards, native_profiles()).sets(), schema, raw)["outcome"] == "allow"
    refs = reference.reference_sets(cards, schema)
    assert decide_raw({"F": refs.never, "A": refs.R, "H": ""}, schema, raw)["outcome"] != "allow"

    # the same for a tool ask under an effect auto: the booking the owner asked to approve is allowed
    report = check(OVERLAP_SETS["tool ask beats effect auto"])
    failed = {c.name: c for c in report.checks if not c.ok}
    assert set(failed) == {"auto_within_cards"}
    assert failed["auto_within_cards"].counterexample_raw["action"] == "native.book"


def test_an_or_gate_is_rejected(monkeypatch):
    cards = OVERLAP_SETS["hours, reviews and overlap"]
    gate = compiler._review_gate
    monkeypatch.setattr(compiler, "_review_gate", lambda *args: gate(*args).replace(" && ", " || "))
    assert "context has review || context.review" in compile_at(cards, native_profiles()).A
    report = check(cards)
    assert not report.ok
    assert [c.name for c in report.checks if not c.ok] in (["lint"], ["review_only_narrows"]), report.checks
    monkeypatch.undo()

    # past the lint, an auto set wider than the compiler's own ungated emission fails review_only_narrows:
    # here A0 is compiled without the gated weekday booking card, as if its gate had added the access
    profiles = native_profiles()
    schema = schema_for(profiles)
    narrower = compile_at([c for c in cards if c.card_id != "book-weekdays"], profiles, review=False).A
    report = activation.bounded_check(desk_kernel.PolicyEngine(compiler.BASELINE), key_prefix="desk-test:2",
                                      schema_json=json.dumps(schema), compiled=compile_at(cards, profiles),
                                      a0=narrower, refs=reference.reference_sets(cards, schema), cards=cards,
                                      profiles=profiles, auto_money_cap_cents=TEST_CAP)
    failed = {c.name: c for c in report.checks if not c.ok}
    assert set(failed) == {"review_only_narrows"}, failed
    raw = failed["review_only_narrows"].counterexample_raw
    assert raw["action"] == "native.book" and "review" in raw["context"]


def values(cases: list[dict], tool: str, field: str) -> set:
    """The distinct values of a context field across the tool's cases."""
    return {case["context"].get(field) for case in cases if case["action"] == tool}


def values_of(cases: list[dict], tool: str, field: str) -> list:
    """The same for unhashable values (reviews), in order."""
    found = []
    for case in cases:
        value = case["context"].get(field)
        if case["action"] == tool and value not in found:
            found.append(value)
    return found


def principal_of(case: dict) -> dict:
    return next(entity for entity in case["entities"] if entity["uid"] == case["principal"])


def test_cases_cover_every_card_boundary():
    weekdays_8_to_5 = card("quote", "native.quote", max_amount_cents=10_000, max_discount_bp=1_000, hours=WEEKDAYS,
                           review=True)
    link = card("dana-link", "native.payment_link", who="person", max_amount_cents=2000, **DANA)
    cards = [weekdays_8_to_5, link, card("agent-charge", "native.charge_mandate", who="agent", max_amount_cents=5000,
                                         **AGENT)]
    profiles = native_profiles()
    cases = activation.bounded_cases(cards, profiles, schema_for(profiles), auto_money_cap_cents=TEST_CAP)
    assert len(cases) <= activation.MAX_BOUNDED_CASES
    assert len({json.dumps(case, sort_keys=True) for case in cases}) == len(cases)          # deduplicated

    assert {10_000, 10_001, None, 0} <= values(cases, "native.quote", "amount_cents")
    assert {1_000, 1_001, None, 10_000} <= values(cases, "native.quote", "discount_bp")
    assert {479, 480, 1019, 1020} <= values(cases, "native.quote", "local_minute")
    assert {5, 6} <= values(cases, "native.quote", "local_dow")                             # a day outside
    reviews = {(r["within_charter_bp"], r["manipulation_bp"]) if r else None
               for r in values_of(cases, "native.quote", "review")}
    # the change row (7500, 2500), each threshold one either side, none, and the extremes
    assert {(7500, 2500), (7499, 2500), (7501, 2500), (7500, 2499), (7500, 2501), None, (10_000, 0),
            (0, 10_000)} <= reviews
    # money: each limit and one over, none, zero, the version's money cap and one over, and the ceiling
    assert {2000, 2001, None, 0, 50_000, 50_001, 1_000_000} <= values(cases, "native.payment_link", "amount_cents")
    assert values(cases, "native.payment_link", "auto_money_cap_cents") == {TEST_CAP}           # every case, its cap
    at_zero = activation.bounded_cases(cards, profiles, schema_for(profiles), auto_money_cap_cents=0)
    assert {0, 1, 1_000_000} <= values(at_zero, "native.payment_link", "amount_cents")
    assert values(at_zero, "native.payment_link", "auto_money_cap_cents") == {0}
    assert {5000, 5001} <= values(cases, "native.charge_mandate", "amount_cents")

    # who: every principal kind the tool applies to, each standing, Dana and someone else, the agent key and another
    links = [case for case in cases if case["action"] == "native.payment_link"]
    principals = [principal_of(case) for case in links]
    assert {p["uid"]["type"] for p in principals} == {"Visitor", "Agent"}
    assert {p["attrs"].get("person_id") for p in principals} == {None, "dana", "case-other-person"}
    assert {p["attrs"].get("agent_key_id") for p in principals} == {None, "agent-key-1", "case-other-agent"}
    standings = {(principal_of(case)["attrs"]["verified"], case["context"]["record_owner_match"]) for case in links}
    assert standings == {(False, False), (True, False), (True, True)}
    mandates = {p["attrs"].get("mandate_remaining_cents") for p in principals if p["uid"]["type"] == "Agent"}
    assert mandates == {None, 1_000_000}
    # only where a card limits it: no card on native.find_slots, so one amount, discount, time and review
    for field in ("amount_cents", "discount_bp", "local_dow", "local_minute", "review"):
        assert len(values_of(cases, "native.find_slots", field)) == 1, field


def thirty_cards() -> list[RuleCard]:
    """Thirty cards, most with limits of their own, for ten people and four agent keys."""
    days = [["mon", "tue", "wed"], ["thu", "fri"], ["sat"], ["sun"], ["mon", "fri"], ["tue", "sat", "sun"]]
    cards = [card(f"quote-p{i}", "native.quote", who="person", person_id=f"p{i}", max_discount_bp=100 * i,
                  max_amount_cents=1000 * (i + 1)) for i in range(10)]
    cards += [card(f"book-{i}", "native.book", who=("anyone", "verified")[i % 2], review=i % 2 == 0,
                   hours=HoursWindow(days=days[i], start=time(7 + i), end=time(12 + i))) for i in range(6)]
    cards += [card(f"link-p{i}", "native.payment_link", who="person", person_id=f"p{i}", max_amount_cents=500 * (i + 1))
              for i in range(5)]
    cards += [card(f"charge-a{i}", "native.charge_mandate", who="agent", agent_key_id=f"a{i}",
                   max_amount_cents=2500 * (i + 1)) for i in range(4)]
    cards += [card("changes-verified", "effect:change", who="verified", review=True, max_amount_cents=20_000),
              card("charges-ask", "effect:charge", mode="ask"), card("reads", "effect:read"),
              card("no-pay-out-a0", "effect:pay_out", mode="never", who="agent", agent_key_id="a0"),
              card("no-leads-p3", "native.capture_lead", mode="never", who="person", person_id="p3")]
    assert len(cards) == 30
    return cards


def test_case_count_is_bounded():
    cards, profiles = thirty_cards(), native_profiles()
    cases = activation.bounded_cases(cards, profiles, schema_for(profiles), auto_money_cap_cents=TEST_CAP)
    assert len(cases) <= activation.MAX_BOUNDED_CASES
    assert {case["action"] for case in cases} == {p.tool for p in profiles}            # every tool gets its turn

    # under the cap, each card's own boundaries still reach someone the card is for
    for c in cards:
        if c.mode != "auto" or c.applies_to.startswith("effect:"):
            continue
        mine = [case for case in cases if case["action"] == c.applies_to
                and principal_of(case)["attrs"].get("person_id") == c.person_id
                and (c.agent_key_id is None or principal_of(case)["attrs"].get("agent_key_id") == c.agent_key_id)]
        if c.max_amount_cents is not None:
            assert {c.max_amount_cents, c.max_amount_cents + 1} <= values(mine, c.applies_to, "amount_cents"), c.card_id
        assert {c.max_discount_bp, c.max_discount_bp + 1} <= values(mine, c.applies_to, "discount_bp"), c.card_id
        if c.hours is not None:
            start, end = c.hours.start.hour * 60, c.hours.end.hour * 60
            assert {start - 1, start, end - 1, end} <= values(mine, c.applies_to, "local_minute"), c.card_id

    # and the two generators agree on all of it
    assert_agrees(check(cards))


def test_bounded_reports_say_checked_not_proved():
    cards, profiles = OVERLAP_SETS["hours, reviews and overlap"], native_profiles()
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    report = check(cards, profiles, key_prefix="desk-7:3", engine=engine)
    assert report.ok and report.method == "bounded" and not report.timed_out
    assert report.cases == len(activation.bounded_cases(cards, profiles, schema_for(profiles), auto_money_cap_cents=TEST_CAP)) > 0
    assert [c.name for c in report.checks] == list(activation.BOUNDED_CHECKS)

    # its five keys are dropped afterwards, and never collide with a loaded version's keys
    keys = activation.bounded_keys("desk-7:3")
    assert len(keys) == 5 and not {"desk-7:3", "desk-7:3:approvable"} & set(keys)
    request = json.dumps(activation.bounded_cases(cards, profiles, schema_for(profiles), auto_money_cap_cents=TEST_CAP)[0])
    for key in keys:
        verdict = json.loads(engine.decide(key, request, "final"))
        assert verdict["outcome"] == "refuse" and any("not loaded" in e for e in verdict["errors"]), key

    # a check that can't load reports a failed lint and still drops its keys
    empty = reference.RefSets(never="", R="", R_hold="")
    report = activation.bounded_check(engine, key_prefix="desk-7:4", schema_json="{}",
                                      compiled=compile_at(cards, profiles), a0="", refs=empty, cards=cards,
                                      profiles=profiles, auto_money_cap_cents=TEST_CAP)
    assert not report.ok and [(c.name, c.ok) for c in report.checks] == [("lint", False)]
    for key in activation.bounded_keys("desk-7:4"):
        assert "not loaded" in json.loads(engine.decide(key, request, "final"))["errors"][0]


def test_failed_load_drops_the_key():
    profiles = native_profiles()
    schema = json.dumps(schema_for(profiles))
    sets = compile_at([card("book", "native.book")], profiles).sets()
    visitor, slot = {"type": "Visitor", "id": "session-1"}, {"type": "Slot", "id": "slot-1"}
    booking = json.dumps({"principal": visitor, "action": "native.book", "resource": slot,
                          "context": context(record_owner_match=False, local_dow=1, local_minute=600),
                          "entities": [{"uid": visitor, "attrs": {"verified": False, "assurance": "none", "copy": "c"},
                                        "parents": []},
                                       {"uid": slot, "attrs": {"copy": "c"}, "parents": []}]})
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    assert engine.load("desk-7:1", schema, json.dumps(sets)) == []
    assert json.loads(engine.decide("desk-7:1", booking, "final"))["outcome"] == "allow"

    # an invalid load under the same key drops what was there: deciding on it refuses with an error
    assert engine.load("desk-7:1", schema, json.dumps({**sets, "A": "permit (principal, action, resource);"}))
    verdict = json.loads(engine.decide("desk-7:1", booking, "final"))
    assert verdict["outcome"] == "refuse" and verdict["errors"], verdict

    # drop_keys does exactly that, on purpose, and leaves other keys alone
    for key in ("desk-7:2", "desk-7:3"):
        assert engine.load(key, schema, json.dumps(sets)) == []
    activation.drop_keys(engine, ["desk-7:2"])
    assert "not loaded" in json.loads(engine.decide("desk-7:2", booking, "final"))["errors"][0]
    assert json.loads(engine.decide("desk-7:3", booking, "final"))["outcome"] == "allow"
