"""The rule-card compiler: rule cards in, Cedar sets `F`, `A` and `H` out.

Each behaviour test compiles cards, loads the result with the real baseline into a fresh
`PolicyEngine` (`decide_with`) and checks the final outcome, so what is tested is the decision a
visitor would get, not the text.
"""

import copy
import hashlib
import importlib
import importlib.util
import itertools
import json
import pkgutil
import re
import subprocess
import sys
from datetime import time
from pathlib import Path
from types import MappingProxyType, ModuleType
from typing import get_args

import desk_kernel
import pytest

import desk
from desk import always_on
from desk.contracts import HoursWindow, ReviewThresholds, RuleCard, ToolName, ToolProfile
from desk.kernel_service import compiler, reference, review_thresholds
from desk.kernel_service.seed import RIVERA_CARDS
from desk.presets import PRESETS

from .helpers import TEST_CAP, compile_at
from .helpers import context as cedar_context

KEY = "desk-test:1"
RESOURCE_TYPES = {"quote": "Quote", "slot": "Slot", "booking": "Booking", "document": "Document",
                  "charge": "Charge", "desk": "Desk"}

# Profiles for the native tools, read from the schema: effects from memberOf, resource from appliesTo.
_ACTIONS = compiler.BASE_SCHEMA[""]["actions"]
NATIVE_TOOLS = sorted(tool for tool in get_args(ToolName) if tool in _ACTIONS)


def profile(tool: str, effects: list[str], resource_kind: str, source: str = "native") -> ToolProfile:
    return ToolProfile(tool=tool, source=source, effects=effects, reversible=False, adapter=f"test.{tool}",
                       resource_kind=resource_kind, description_confirmed=f"Test {tool}", input_schema={},
                       status="enabled")


def native_profile(tool: str) -> ToolProfile:
    action = _ACTIONS[tool]
    effects = [group["id"].removeprefix("effect:") for group in action["memberOf"]]
    kind = action["appliesTo"]["resourceTypes"][0].lower()
    return profile(tool, effects, kind)


NATIVE = [native_profile(tool) for tool in NATIVE_TOOLS]
# A refund tool with two effects, for joint coverage; its action is appended to the test schema.
REFUND = profile("payments.create_refund", ["pay_out", "private_data"], "charge", source="mcp")


def schema_for(profiles: list[ToolProfile]) -> dict:
    """The base schema, plus an action for every profile it lacks (test tools only)."""
    schema = copy.deepcopy(compiler.BASE_SCHEMA)
    actions = schema[""]["actions"]
    for p in profiles:
        if p.tool not in actions:
            actions[p.tool] = {"memberOf": [{"id": f"effect:{effect}"} for effect in p.effects],
                               "appliesTo": {"principalTypes": ["Visitor", "Agent"],
                                             "resourceTypes": [RESOURCE_TYPES[p.resource_kind]],
                                             "context": {"type": "Ctx"}}}
    return schema


def load_compiled(cards: list[RuleCard], profiles: list[ToolProfile], *, review: bool = True,
                  sets: compiler.CompiledSets | None = None) -> desk_kernel.PolicyEngine:
    compiled = sets or compile_at(cards, profiles, review=review)
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    errors = engine.load(KEY, json.dumps(schema_for(profiles)), json.dumps(compiled.sets()))
    assert errors == [], errors
    return engine


def decide_with(cards: list[RuleCard], profiles: list[ToolProfile], request: dict, *, phase: str = "final",
                review: bool = True) -> str:
    """Compiles `cards` over `profiles`, loads the version into a fresh engine with the real
    baseline and returns the outcome of `request`."""
    verdict = json.loads(load_compiled(cards, profiles, review=review).decide(KEY, json.dumps(request), phase))
    assert verdict["errors"] == [], verdict
    return verdict["outcome"]


def req(tool: str, *, kind: str = "Visitor", verified: bool = False, person_id: str | None = None,
        agent_key_id: str = "agent-key-1", record_owner: bool = False, dow: int = 1, minute: int = 600,
        **context) -> dict:
    """A request_json from one principal of `kind` on the tool's resource type; a person or a
    record owner is verified. `context` adds amount_cents, discount_bp, recipient or review, or
    another money cap than $500. The default time is Tuesday 10:00."""
    resource_type = schema_for([*NATIVE, REFUND])[""]["actions"][tool]["appliesTo"]["resourceTypes"][0]
    verified = verified or record_owner or person_id is not None
    attrs: dict = {"verified": verified, "assurance": "demo_code" if verified else "none", "copy": "copy-1"}
    if person_id is not None:
        attrs["person_id"] = person_id
    if kind == "Agent":
        attrs["agent_key_id"] = agent_key_id
    principal = {"type": kind, "id": "session-1"}
    resource = {"type": resource_type, "id": "record-1"}
    return {"principal": principal, "action": tool, "resource": resource,
            "context": cedar_context(**{"record_owner_match": record_owner, "local_dow": dow, "local_minute": minute,
                                        **context}),
            "entities": [{"uid": principal, "attrs": attrs, "parents": []},
                         {"uid": resource, "attrs": {"copy": "copy-1"}, "parents": []}]}


def card(card_id: str, applies_to: str, mode: str = "auto", who: str = "anyone", **fields) -> RuleCard:
    return RuleCard(card_id=card_id, applies_to=applies_to, mode=mode, who=who, reason=f"Test card {card_id}.",
                    **fields)


DANA = {"person_id": "dana"}
WEEKDAYS = HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(8), end=time(17))

POLICY = re.compile(r'@id\("([^"]+)"\) @card\("([^"]+)"\) @tier\("([^"]+)"\) @applies_to\("([^"]+)"\)\n'
                    r"(permit|forbid) \(")


def policies(text: str) -> list[tuple[str, str, str, str, str]]:
    return POLICY.findall(text)


A_MIX_OF_CARDS = [
    card("quote", "native.quote", max_discount_bp=1000, review=True),
    card("book-weekdays", "native.book", hours=WEEKDAYS, review=True),
    card("book-dana", "native.book", who="person", **DANA),
    card("deposit", "native.payment_link", max_amount_cents=2000),
    card("agent-charge", "native.charge_mandate", who="agent", agent_key_id="agent-key-1", max_amount_cents=5000),
    card("docs", "native.release_document", who="record_owner"),
    card("changes-verified", "effect:change", who="verified", max_amount_cents=30000),
    card("charge-ask", "effect:charge", mode="ask"),
    card("no-pay-out", "effect:pay_out", mode="never", who="agent", agent_key_id="agent-key-1"),
    card("send-auto", "effect:send_message", who="verified", review=True),
    card("private-auto", "effect:private_data", who="record_owner"),
    card("callback-ask", "native.request_callback", mode="ask", who="person", **DANA),
]


def test_every_policy_is_annotated_and_lints():
    profiles = [*NATIVE, REFUND]
    compiled = compile_at(A_MIX_OF_CARDS, profiles)
    sets = compiled.sets()
    assert set(sets) == {"F", "A", "H"}
    assert desk_kernel.lint_policies(json.dumps(sets)) == []
    load_compiled(A_MIX_OF_CARDS, profiles, sets=compiled)          # strict validation, no errors

    expected = {"F": ("forbid", "refuse", ("never.",)), "A": ("permit", "auto", ("auto.",)),
                "H": ("permit", "hold", ("ask.", "twin."))}
    for name, text in sets.items():
        assert "!(context has" not in text                          # the form strict validation rejects
        found = policies(text)
        assert found and len(found) == text.count(";"), name        # every policy carries the four annotations
        effect, tier, prefixes = expected[name]
        for policy_id, card_ids, policy_tier, applies_to, policy_effect in found:
            assert policy_id.startswith(prefixes) and policy_tier == tier and policy_effect == effect, policy_id
            assert card_ids and applies_to
    ids = [found[0] for text in sets.values() for found in policies(text)]
    assert len(ids) == len(set(ids))
    # the mix reaches every shape: a joint permit, exclusions, hours, a review gate, money, agents
    assert "auto.private-auto+send-auto" in ids and "twin.private-auto+send-auto" in ids
    for shape in ("unless {", ".contains(context.local_dow)", "context has review &&",
                  "context has amount_cents && context.amount_cents <= 2000", "principal is Agent &&",
                  "principal has person_id &&", "context.record_owner_match"):
        assert shape in sets["A"], shape

    # deterministic: the same cards in any order compile to the same text and hash
    again = compile_at(list(reversed(A_MIX_OF_CARDS)), list(reversed(profiles)))
    assert again.sets() == sets
    assert [c.card_id for c in compiled.cards] == sorted(c.card_id for c in compiled.cards)
    jcs = desk_kernel.canonical_json(json.dumps(sets))
    assert compiler.cedar_sha256(compiled) == compiler.cedar_sha256(again) == hashlib.sha256(jcs.encode()).hexdigest()
    assert compiler.cedar_sha256(sets) == compiler.cedar_sha256(compiled)
    fewer = compile_at(A_MIX_OF_CARDS[1:], profiles)
    assert compiler.cedar_sha256(fewer) != compiler.cedar_sha256(compiled)


def test_uncovered_tools_get_a_default_ask():
    cards = [card("slots", "native.find_slots")]
    with_defaults = compiler.with_defaults(cards, NATIVE)
    defaults = {c.card_id: c for c in with_defaults if c.is_default}
    # verification is always on: its card is added to the set, so its tool gets no default ask
    assert set(defaults) == {f"default:{tool}" for tool in NATIVE_TOOLS
                             if tool not in ("native.find_slots", "native.start_verification")}
    assert [c.card_id for c in with_defaults if not c.is_default] == ["preset-start-verification", "slots"]
    assert defaults["default:native.book"] == RuleCard(
        card_id="default:native.book", applies_to="native.book", mode="ask", who="anyone", is_default=True,
        reason="Not covered by a rule yet, so it asks you.")
    assert [c.card_id for c in with_defaults] == sorted(c.card_id for c in with_defaults)
    assert compile_at(cards, NATIVE).cards == with_defaults
    assert decide_with(cards, NATIVE, req("native.book")) == "hold"
    assert decide_with(cards, NATIVE, req("native.find_slots")) == "allow"

    # a default given back as input is dropped and derived again: here it no longer applies
    never_anyone = [card("no-booking", "native.book", mode="never"), defaults["default:native.book"]]
    assert "default:native.book" not in {c.card_id for c in compiler.with_defaults(never_anyone, NATIVE)}
    assert decide_with(never_anyone, NATIVE, req("native.book")) == "refuse"

    never_dana = [card("no-booking-dana", "native.book", mode="never", who="person", **DANA)]
    assert "default:native.book" in {c.card_id for c in compiler.with_defaults(never_dana, NATIVE)}
    assert decide_with(never_dana, NATIVE, req("native.book")) == "hold"
    assert decide_with(never_dana, NATIVE, req("native.book", **DANA)) == "refuse"


def test_narrow_cards_keep_the_default_ask():
    for mode, dana_gets in (("auto", "allow"), ("never", "refuse")):
        cards = [card("dana-books", "native.book", mode=mode, who="person", **DANA)]
        assert decide_with(cards, NATIVE, req("native.book", **DANA)) == dana_gets
        assert decide_with(cards, NATIVE, req("native.book", person_id="eve")) == "hold"
        assert decide_with(cards, NATIVE, req("native.book")) == "hold"

    for applies_to in ("native.book", "effect:change"):
        cards = [card("verified-books", applies_to, who="verified")]
        assert "default:native.book" in {c.card_id for c in compiler.with_defaults(cards, NATIVE)}
        assert decide_with(cards, NATIVE, req("native.book", verified=True)) == "allow", applies_to
        assert decide_with(cards, NATIVE, req("native.book")) == "hold", applies_to


def test_tool_ask_beats_effect_auto():
    cards = [card("changes", "effect:change"), card("ask-booking", "native.book", mode="ask")]
    assert decide_with(cards, NATIVE, req("native.book")) == "hold"
    assert decide_with(cards, NATIVE, req("native.quote")) == "allow"
    assert decide_with(cards, NATIVE, req("native.capture_lead")) == "allow"


def test_person_auto_beats_effect_ask():
    cards = [card("charges-ask", "effect:charge", mode="ask"),
             card("dana-link", "native.payment_link", who="person", max_amount_cents=2000, **DANA)]
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=2000, **DANA)) == "allow"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=2000, person_id="eve")) == "hold"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=2000)) == "hold"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=2001, **DANA)) == "hold"


def test_more_specific_auto_decides():
    cards = [card("charges", "effect:charge", max_amount_cents=10_000),
             card("dana-link", "native.payment_link", who="person", max_amount_cents=2000, **DANA)]
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=8000, **DANA)) == "hold"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=2000, **DANA)) == "allow"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=8000, person_id="eve")) == "allow"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=8000)) == "allow"
    assert decide_with(cards, NATIVE, req("native.payment_link", amount_cents=10_001)) == "hold"



def test_same_level_auto_and_ask_ask():
    tool_level = [card("book", "native.book"), card("ask-verified", "native.book", mode="ask", who="verified")]
    assert decide_with(tool_level, NATIVE, req("native.book", verified=True)) == "hold"
    assert decide_with(tool_level, NATIVE, req("native.book")) == "allow"

    effect_level = [card("changes", "effect:change", who="verified"), card("ask-changes", "effect:change", mode="ask")]
    assert decide_with(effect_level, NATIVE, req("native.book", verified=True)) == "hold"

    person_level = [card("dana-book", "native.book", who="person", **DANA),
                    card("dana-ask", "native.book", mode="ask", who="person", **DANA)]
    assert decide_with(person_level, NATIVE, req("native.book", **DANA)) == "hold"
    # a less specific ask (an effect card, even Dana's) doesn't stop a tool card for Dana
    below = [card("dana-book", "native.book", who="person", **DANA),
             card("dana-ask", "effect:change", mode="ask", who="person", **DANA)]
    assert decide_with(below, NATIVE, req("native.book", **DANA)) == "allow"
    assert decide_with(below, NATIVE, req("native.quote", **DANA)) == "hold"


def test_same_level_autos_add_up():
    cards = [card("quote-anyone", "native.quote", max_discount_bp=1000),
             card("quote-verified", "native.quote", who="verified", max_discount_bp=2000)]
    assert decide_with(cards, NATIVE, req("native.quote", verified=True, discount_bp=1500)) == "allow"
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=1500)) == "hold"
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=1000)) == "allow"

    effect_and_effect = [card("changes", "effect:change", max_amount_cents=1000),
                         card("changes-verified", "effect:change", who="verified", max_amount_cents=5000)]
    assert decide_with(effect_and_effect, NATIVE, req("native.quote", verified=True, amount_cents=4000)) == "allow"
    assert decide_with(effect_and_effect, NATIVE, req("native.quote", amount_cents=4000)) == "hold"


def test_never_always_wins():
    cards = [card("no-changes", "effect:change", mode="never"),
             card("dana-book", "native.book", who="person", **DANA),
             card("ask-book", "native.book", mode="ask")]
    assert decide_with(cards, NATIVE, req("native.book", **DANA)) == "refuse"
    assert decide_with(cards, NATIVE, req("native.book")) == "refuse"
    assert decide_with(cards, NATIVE, req("native.quote")) == "refuse"
    assert decide_with(cards, NATIVE, req("native.find_slots")) == "hold"          # not a change: default ask

    dana_never = [card("dana-no-book", "native.book", mode="never", who="person", **DANA),
                  card("book", "native.book")]
    assert decide_with(dana_never, NATIVE, req("native.book", **DANA)) == "refuse"
    assert decide_with(dana_never, NATIVE, req("native.book")) == "allow"


def test_one_effect_auto_does_not_cover_a_two_effect_tool():
    send = card("send", "effect:send_message")
    cards = [send]
    assert not compiler.covers(send, "native.release_document", NATIVE, cards)
    assert compiler.covers(send, "native.start_verification", NATIVE, cards)
    assert not compiler.covers(send, "native.payment_link", NATIVE, cards)
    assert not compiler.covers(card("book", "native.book"), "native.book", [], cards)    # not enabled: nothing
    assert "default:native.release_document" in {c.card_id for c in compiler.with_defaults(cards, NATIVE)}
    owner = {"record_owner": True, "recipient": "verified_contact"}
    assert decide_with(cards, NATIVE, req("native.release_document", **owner)) == "hold"
    assert decide_with(cards, NATIVE, req("native.start_verification", recipient="verified_contact")) == "allow"

    # an ask or never effect card covers every tool with its effect
    for mode, outcome in (("ask", "hold"), ("never", "refuse")):
        other = card("private", "effect:private_data", mode=mode)
        assert compiler.covers(other, "native.release_document", NATIVE, [send, other])
        assert decide_with([send, other], NATIVE, req("native.release_document", **owner)) == outcome


def test_joint_effect_autos_take_the_tightest_limits():
    profiles = [*NATIVE, REFUND]
    refunds = card("refunds", "effect:pay_out", max_amount_cents=5000)
    private = card("private-verified", "effect:private_data", who="verified", max_amount_cents=20_000)
    cards = [refunds, private]
    assert compiler.covers(refunds, "payments.create_refund", profiles, cards)
    assert compiler.covers(private, "payments.create_refund", profiles, cards)
    owner = {"record_owner": True}
    assert decide_with(cards, profiles, req("payments.create_refund", amount_cents=4000, **owner)) == "allow"
    assert decide_with(cards, profiles, req("payments.create_refund", amount_cents=5001, **owner)) == "hold"
    assert decide_with(cards, profiles, req("payments.create_refund", amount_cents=40_000, **owner)) == "hold"

    compiled = compile_at(cards, profiles)
    autos = policies(compiled.A)
    assert [(p[0], p[1], p[3]) for p in autos] == [
        ("auto.preset-start-verification", "preset-start-verification", "native.start_verification"),   # always on
        ("auto.private-verified+refunds", "private-verified,refunds", "effect:private_data,effect:pay_out")]
    assert "principal.verified" in compiled.A and "context.amount_cents <= 5000" in compiled.A
    assert "twin.private-verified+refunds" in compiled.H
    assert "default:payments.create_refund" in {c.card_id for c in compiled.cards}     # not all for anyone


def test_joint_coverage_keeps_the_review_gate():
    cards = [card("send-reviewed", "effect:send_message", review=True),
             card("private-owner", "effect:private_data", who="record_owner")]
    owner = {"record_owner": True, "recipient": "verified_contact"}
    assert decide_with(cards, NATIVE, req("native.release_document", **owner), phase="pre") == "needs_review"
    assert decide_with(cards, NATIVE, req("native.release_document", **owner)) == "hold"       # review absent
    # the strictest row across the tool's effects: private_data (8500, 1500) over send_message (8000, 2000)
    passing = {"within_charter_bp": 8500, "manipulation_bp": 1500}
    assert decide_with(cards, NATIVE, req("native.release_document", review=passing, **owner)) == "allow"
    low = {"within_charter_bp": 8499, "manipulation_bp": 1500}
    assert decide_with(cards, NATIVE, req("native.release_document", review=low, **owner)) == "hold"
    assert decide_with(cards, NATIVE, req("native.release_document", recipient="verified_contact",
                                          verified=True, review=passing)) == "refuse"   # not the record owner


def test_money_without_an_owner_card_holds():
    profiles = [*NATIVE, REFUND]
    no_money_cards = [card("changes", "effect:change"), card("private", "effect:private_data", who="record_owner"),
                      card("send", "effect:send_message")]
    compiled = compile_at(no_money_cards, profiles)
    for tool in ("native.payment_link", "native.charge_mandate", "payments.create_refund"):
        assert tool not in compiled.A                                       # no auto permit names it
        assert f"default:{tool}" in {c.card_id for c in compiled.cards}
    assert decide_with(no_money_cards, profiles, req("native.payment_link", amount_cents=2000)) == "hold"
    assert decide_with(no_money_cards, profiles, req("payments.create_refund", amount_cents=2000,
                                                     record_owner=True)) == "hold"
    assert decide_with([], profiles, req("native.payment_link", amount_cents=1)) == "hold"


def test_discount_limits():
    cards = [card("quote", "native.quote", max_discount_bp=1000)]
    assert decide_with(cards, NATIVE, req("native.quote")) == "allow"                       # no discount asked
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=1000)) == "allow"
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=1001)) == "hold"
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=8000)) == "hold"
    at_list_price = [card("quote", "native.quote")]                                          # max_discount_bp 0
    assert decide_with(at_list_price, NATIVE, req("native.quote", discount_bp=0)) == "allow"
    assert decide_with(at_list_price, NATIVE, req("native.quote", discount_bp=1)) == "hold"


def test_weekday_hours_hold_a_sunday_night_slot():
    cards = [card("book-weekdays", "native.book", hours=WEEKDAYS)]                          # Mon to Fri, 08:00 to 17:00
    assert decide_with(cards, NATIVE, req("native.book", dow=6, minute=1320)) == "hold"     # Sunday 22:00
    assert decide_with(cards, NATIVE, req("native.book", dow=1, minute=600)) == "allow"     # Tuesday 10:00
    assert decide_with(cards, NATIVE, req("native.book", dow=1, minute=1020)) == "hold"     # 17:00, the end, excluded
    assert decide_with(cards, NATIVE, req("native.book", dow=1, minute=1019)) == "allow"
    assert decide_with(cards, NATIVE, req("native.book", dow=4, minute=480)) == "allow"     # Friday 08:00
    assert decide_with(cards, NATIVE, req("native.book", dow=4, minute=479)) == "hold"
    assert decide_with(cards, NATIVE, req("native.book", dow=5, minute=600)) == "hold"      # Saturday

    to_midnight = [card("late", "native.book", hours=HoursWindow(days=["fri"], start=time(22), end=time(0)))]
    assert decide_with(to_midnight, NATIVE, req("native.book", dow=4, minute=1439)) == "allow"
    assert decide_with(to_midnight, NATIVE, req("native.book", dow=5, minute=0)) == "hold"


def test_change_card_with_a_discount_limit_allows_a_booking():
    cards = [card("changes", "effect:change", max_discount_bp=1000, max_amount_cents=30_000)]
    assert decide_with(cards, NATIVE, req("native.book")) == "allow"           # no amount, no discount: within both
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=1000, amount_cents=30_000)) == "allow"
    assert decide_with(cards, NATIVE, req("native.quote", discount_bp=1001)) == "hold"
    assert decide_with(cards, NATIVE, req("native.quote", amount_cents=30_001)) == "hold"
    compiled = compile_at(cards, NATIVE)
    assert "(if context has discount_bp then context.discount_bp <= 1000 else true)" in compiled.A
    assert "(if context has amount_cents then context.amount_cents <= 30000 else true)" in compiled.A


def test_review_gate_only_narrows():
    cards = [card("book", "native.book", hours=WEEKDAYS, review=True), card("quote", "native.quote", review=True),
             card("ask-dana", "native.book", mode="ask", who="person", **DANA)]
    gated, ungated = compile_at(cards, NATIVE), compile_at(cards, NATIVE, review=False)
    assert "context.review" in gated.A and "context.review" not in ungated.A
    assert (gated.F, gated.H, gated.cards) == (ungated.F, ungated.H, ungated.cards)
    assert [p[0] for p in policies(gated.A)] == [p[0] for p in policies(ungated.A)]

    a, a0 = load_compiled(cards, NATIVE, sets=gated), load_compiled(cards, NATIVE, sets=ungated)
    scores = ((10_000, 0), (0, 10_000), (7500, 2500), (7499, 2500), (7500, 2501))
    reviews = [None, *({"within_charter_bp": within, "manipulation_bp": manip} for within, manip in scores)]
    outcomes = set()
    for tool in ("native.book", "native.quote"):
        for who in ({}, DANA):
            for dow, minute in ((1, 600), (6, 600), (1, 1020)):
                for review in reviews:
                    request = req(tool, dow=dow, minute=minute, **who, **({"review": review} if review else {}))
                    with_gate = json.loads(a.decide(KEY, json.dumps(request), "final"))["outcome"]
                    without = json.loads(a0.decide(KEY, json.dumps(request), "final"))["outcome"]
                    outcomes.add((with_gate, without))
                    assert with_gate != "allow" or without == "allow", request
    assert {("allow", "allow"), ("hold", "allow"), ("hold", "hold")} <= outcomes      # the gate narrowed, never widened

    booking = req("native.book")
    assert json.loads(a.decide(KEY, json.dumps(booking), "pre"))["outcome"] == "needs_review"
    assert json.loads(a0.decide(KEY, json.dumps(booking), "pre"))["outcome"] == "allow"
    sunday = req("native.book", dow=6)
    assert json.loads(a.decide(KEY, json.dumps(sunday), "pre"))["outcome"] == "hold"   # the score can't matter


def gate(compiled: compiler.CompiledSets) -> tuple[int, int]:
    found = re.findall(r"within_charter_bp >= (\d+) && context\.review\.manipulation_bp <= (\d+)", compiled.A)
    assert len(found) == 1, compiled.A
    return int(found[0][0]), int(found[0][1])


def test_review_thresholds_follow_the_strictest_effect(monkeypatch):
    docs = [card("docs", "native.release_document", who="record_owner", review=True)]
    assert gate(compile_at(docs, NATIVE)) == (8500, 1500)      # private_data over send_message
    assert gate(compile_at([card("book", "native.book", review=True)], NATIVE)) == (7500, 2500)
    link = [card("link", "native.payment_link", max_amount_cents=2000, review=True)]
    assert gate(compile_at(link, NATIVE)) == (9000, 1000)

    owner = {"record_owner": True, "recipient": "verified_contact"}
    for review, outcome in (((8500, 1500), "allow"), ((8499, 1500), "hold"), ((8500, 1501), "hold")):
        scores = {"within_charter_bp": review[0], "manipulation_bp": review[1]}
        assert decide_with(docs, NATIVE, req("native.release_document", review=scores, **owner)) == outcome, review

    # the thresholds are read when the cards compile, each bound from its strictest effect
    stricter = {**review_thresholds.THRESHOLDS,
                "send_message": ReviewThresholds(min_within_charter_bp=9900, max_manipulation_bp=1800)}
    monkeypatch.setattr(review_thresholds, "THRESHOLDS", stricter)
    assert gate(compile_at(docs, NATIVE)) == (9900, 1500)


def test_auto_money_limit_is_capped():
    # cards that skipped their contract checks: over the platform ceiling, or with no amount at all;
    # compiled at a $500 money cap, as validation at that cap would also have refused the first
    over = RuleCard.model_construct(card_id="big-link", applies_to="native.payment_link", mode="auto", who="anyone",
                                    person_id=None, agent_key_id=None, max_amount_cents=1_000_001, max_discount_bp=0,
                                    hours=None, review=False, is_default=False, reason="Too big.")
    unset = RuleCard.model_construct(card_id="charges", applies_to="effect:charge", mode="auto", who="verified",
                                     person_id=None, agent_key_id=None, max_amount_cents=None, max_discount_bp=0,
                                     hours=None, review=False, is_default=False, reason="No amount.")
    for cards in ([over], [unset]):
        compiled = compile_at(cards, NATIVE)
        assert compiled.A.count("context has amount_cents && context.amount_cents <= 50000") == 1, compiled.A
        # without the baseline, the compiled permit alone stops at the version's cap
        engine = desk_kernel.PolicyEngine("")
        assert engine.load(KEY, json.dumps(schema_for(NATIVE)), json.dumps(compiled.sets())) == []
        for amount, outcome in ((50_000, "allow"), (50_001, "hold")):
            request = req("native.payment_link", verified=True, amount_cents=amount)
            assert json.loads(engine.decide(KEY, json.dumps(request), "final"))["outcome"] == outcome, (cards, amount)
        assert decide_with(cards, NATIVE, req("native.payment_link", verified=True, amount_cents=50_001)) == "hold"

    # a money permit always needs an amount, and takes the card's own limit when it is lower
    small = compile_at([card("deposit", "native.payment_link", max_amount_cents=2000)], NATIVE)
    assert "context has amount_cents && context.amount_cents <= 2000" in small.A
    engine = desk_kernel.PolicyEngine("")
    assert engine.load(KEY, json.dumps(schema_for(NATIVE)), json.dumps(small.sets())) == []
    no_amount = json.loads(engine.decide(KEY, json.dumps(req("native.payment_link")), "final"))
    assert no_amount["outcome"] == "hold"


def test_invalid_cards_are_rejected():
    people, agent_keys = {"dana", 'dana" || true || "'}, {"agent-key-1"}
    valid = [card("quote", "native.quote"), card("dana-book", "native.book", who="person", **DANA),
             card("agent-charge", "native.charge_mandate", who="agent", agent_key_id="agent-key-1",
                  max_amount_cents=2000),
             card("late", "native.book", hours=HoursWindow(days=["fri"], start=time(22), end=time(0))),
             card("default:native.book", "native.book", mode="ask", is_default=True)]   # a default: dropped, unchecked
    assert compiler.validate_cards(valid, people=people, agent_keys=agent_keys,
                                   auto_money_cap_cents=TEST_CAP, money_tools=frozenset()) == []

    def errors(*cards: RuleCard, cap: int = TEST_CAP) -> list[str]:
        return compiler.validate_cards(list(cards), people=people, agent_keys=agent_keys,
                                       auto_money_cap_cents=cap, money_tools=frozenset())

    assert errors(card("Quote", "native.quote"))                                # IDs are lower case
    assert errors(card("-quote", "native.quote"))
    assert errors(card("q" * 65, "native.quote"))
    assert errors(card("quote one", "native.quote"))
    assert len(errors(card("quote", "native.quote"), card("quote", "native.book"))) == 1   # IDs are unique
    assert errors(card("default:native.book", "native.book", mode="ask"))       # reserved for the compiler's defaults
    assert errors(card("eve-book", "native.book", who="person", person_id="eve"))
    assert errors(card("other-agent", "native.book", who="agent", agent_key_id="agent-key-2"))
    hostile = errors(card("inject", "native.book", who="person", person_id='dana" || true || "'))
    assert hostile and all("||" not in error for error in hostile)              # refused, and not echoed back
    backwards = HoursWindow.model_construct(days=["mon"], start=time(10), end=time(9))
    assert errors(RuleCard.model_construct(**{**card("backwards", "native.book").model_dump(), "hours": backwards}))
    assert errors(card("seconds", "native.book", hours=HoursWindow(days=["mon"], start=time(8, 0, 30), end=time(9))))
    over = RuleCard.model_construct(**{**card("link", "native.payment_link", max_amount_cents=2000).model_dump(),
                                       "max_amount_cents": 1_000_001})
    assert errors(over)                                                         # the card's own contract, again
    # an auto money card above the version's money cap, named by the code the API words for the owner
    link = card("link", "native.payment_link", max_amount_cents=50_001)
    assert errors(link) == ["link: above_money_cap: it would take or pay out more than the money limit without asking"]
    assert errors(link, cap=50_001) == [] and errors(card("refunds", "effect:pay_out", max_amount_cents=1), cap=0)
    assert errors(card("asks", "effect:charge", mode="ask"), cap=0) == []      # an ask card moves nothing on its own

    # the compiler itself never writes such a string into Cedar
    with pytest.raises(ValueError):
        compile_at([card("inject", "native.book", who="person", person_id='dana" || true || "')], NATIVE)
    with pytest.raises(ValueError):
        compile_at([card("quote", "native.quote"), card("quote", "native.book")], NATIVE)


ALWAYS_ON = "native.start_verification: verification is always on, so no rule can change it"


def test_no_card_can_change_verification():
    """Verification belongs to the always-on baseline: a card on `native.start_verification`, in
    any mode and scope, is refused with a reason that names the tool (the presets' own card for it
    is the one exception, in the next test), and one such card refuses the whole set."""
    def errors(*cards: RuleCard) -> list[str]:
        return compiler.validate_cards(list(cards), people={"dana"}, agent_keys=(),
                                       auto_money_cap_cents=TEST_CAP, money_tools=frozenset())

    valid = [card("quote", "native.quote"), card("dana-book", "native.book", who="person", **DANA)]
    assert errors(*valid) == []
    for verify in (card("verify", "native.start_verification", mode="ask"),
                   card("verify", "native.start_verification", mode="never", who="person", **DANA),
                   card("verify", "native.start_verification", who="verified")):
        assert errors(verify) == [f"verify: {ALWAYS_ON}"], verify.mode
        assert errors(*valid, verify) == [f"verify: {ALWAYS_ON}"], verify.mode


def test_the_shipped_verification_card_stays_as_it_is():
    """Every preset and the Turner seed carry `preset-start-verification` (auto, for anyone): the
    always-on behaviour itself, which the API drafts back with the rest of a preset. That card is
    the one card on the tool a set may hold, its `reason` reworded or not (the owner's words,
    which compile to nothing, as `lower_to_cap` matches a carried card); any other change to it
    is refused."""
    def errors(*cards: RuleCard) -> list[str]:
        return compiler.validate_cards(list(cards), people=(), agent_keys=(),
                                       auto_money_cap_cents=TEST_CAP, money_tools=frozenset())

    [shipped] = [c for c in PRESETS["ask_first"] if c.applies_to == "native.start_verification"]
    # every field pinned (no review, hours or limits), so a preset edit can't tighten it unseen
    assert shipped == RuleCard(card_id="preset-start-verification", applies_to="native.start_verification",
                               mode="auto", who="anyone", reason=shipped.reason)
    others = [c for c in PRESETS["ask_first"] if c != shipped]
    for cards in (PRESETS["ask_first"], PRESETS["auto"], RIVERA_CARDS):
        assert shipped in cards and errors(*cards) == []
    reworded = shipped.model_copy(update={"reason": "Anyone can get a code sent to the contact on record."})
    assert errors(reworded) == [] and compile_at([reworded], NATIVE).sets() == compile_at([shipped], NATIVE).sets()
    changes = ({"who": "verified"}, {"mode": "ask"}, {"mode": "never"}, {"review": True},
               {"hours": WEEKDAYS}, {"card_id": "verify"})
    for change in changes:
        changed = RuleCard.model_validate({**shipped.model_dump(), **change})
        assert errors(changed) == [f"{changed.card_id}: {ALWAYS_ON}"], change
        assert errors(*others, changed) == [f"{changed.card_id}: {ALWAYS_ON}"], change   # in place of the shipped one


def test_a_set_without_the_verification_card_compiles_with_it():
    """Verification is always on, so a set can't leave it out either: one that lacks the presets'
    card for `native.start_verification` compiles with it, never with a default ask, in the
    compiler and in the reference generator alike. It compiles to the same Cedar as the set that
    holds it, and a start is allowed. A set holding it with its `reason` reworded compiles as it
    is; one holding another card under its ID can't compile at all."""
    [shipped] = compiler.ALWAYS_ON_CARDS
    schema = schema_for(NATIVE)
    start = req("native.start_verification", recipient="verified_contact")
    for cards in (PRESETS["ask_first"], PRESETS["auto"], RIVERA_CARDS, [card("book", "native.book")], []):
        without = [c for c in cards if c != shipped]
        compiled = compile_at(without, NATIVE)
        assert shipped in compiled.cards
        assert "default:native.start_verification" not in {c.card_id for c in compiled.cards}
        assert compiled.sets() == compile_at([*without, shipped], NATIVE).sets()
        assert reference.reference_sets(without, schema) == reference.reference_sets([*without, shipped], schema)
        assert decide_with(without, NATIVE, start) == "allow"
    reworded = shipped.model_copy(update={"reason": "Anyone can get a code sent to the contact on record."})
    assert [c for c in compile_at([reworded], NATIVE).cards if not c.is_default] == [reworded]
    assert reference.reference_sets([reworded], schema) == reference.reference_sets([shipped], schema)
    changed = shipped.model_copy(update={"mode": "ask"})
    with pytest.raises(ValueError):
        compile_at([changed], NATIVE)
    with pytest.raises(ValueError):
        reference.reference_sets([changed], schema)
    [own] = reference.ALWAYS_ON_CARDS                     # the reference states it apart: the same rule
    assert own.model_copy(update={"reason": shipped.reason}) == shipped


AGENT = {"agent_key_id": "agent-key-1"}


def test_no_effect_card_can_change_verification():
    """`native.start_verification` has one effect, `send_message`, so a card on
    `effect:send_message` covers it too. A `never` or `ask` one, in any scope, would refuse or
    hold starts, and an `auto` one for a person or an agent outranks the presets' own card for
    that principal, so its hours or review gate would hold their starts: each is refused with the
    reason that names the tool, alone and beside the presets. An `auto` one for a wider group
    ranks below the presets' card and stays, as the master plan's joint-coverage cards use it."""
    def errors(*cards: RuleCard) -> list[str]:
        return compiler.validate_cards(list(cards), people={"dana"}, agent_keys={AGENT["agent_key_id"]},
                                       auto_money_cap_cents=TEST_CAP, money_tools=frozenset())

    refused = [card("send", "effect:send_message", mode="never"),
               card("send", "effect:send_message", mode="never", who="person", **DANA),
               card("send", "effect:send_message", mode="ask"),
               card("send", "effect:send_message", mode="ask", who="person", **DANA),
               card("send", "effect:send_message", mode="ask", who="agent", **AGENT),
               card("send", "effect:send_message", who="person", review=True, **DANA),
               card("send", "effect:send_message", who="agent", hours=WEEKDAYS, **AGENT),
               card("send", "effect:send_message", who="person", **DANA)]
    for send in refused:
        assert errors(send) == [f"send: {ALWAYS_ON}"], send
        assert errors(*PRESETS["ask_first"], send) == [f"send: {ALWAYS_ON}"], send
    kept = [card("send", "effect:send_message"),
            card("send", "effect:send_message", who="verified", review=True),
            card("send", "effect:send_message", who="record_owner", hours=WEEKDAYS),
            card("private", "effect:private_data", mode="never", who="person", **DANA)]
    for other in kept:
        assert errors(*PRESETS["ask_first"], other) == [], other


def test_an_effect_card_a_draft_may_hold_leaves_every_start_allowed():
    """Over every mode, scope and gate of an `effect:send_message` card beside the presets, with
    the real baseline: a card `validate_cards` accepts leaves every verification start allowed
    (an anonymous or verified visitor, Dana, an agent; in and out of hours; the review passing,
    failing or absent), and one it refuses is refused with the reason that names the tool."""
    presets = list(PRESETS["ask_first"])
    principals = ({}, {"verified": True}, DANA, {"kind": "Agent", **AGENT})
    times = ({"dow": 1, "minute": 600}, {"dow": 6, "minute": 1320})
    reviews = ({}, {"review": {"within_charter_bp": 10_000, "manipulation_bp": 0}},
               {"review": {"within_charter_bp": 0, "manipulation_bp": 10_000}})
    scopes = ({"who": "anyone"}, {"who": "verified"}, {"who": "record_owner"}, {"who": "person", **DANA},
              {"who": "agent", **AGENT})
    gates = ({}, {"review": True}, {"hours": WEEKDAYS})
    sends = [card("send", "effect:send_message", mode="auto", **scope, **gate) for scope in scopes for gate in gates]
    sends += [card("send", "effect:send_message", mode=mode, **scope) for mode in ("ask", "never") for scope in scopes]
    accepted = 0
    for send in sends:
        errors = compiler.validate_cards([*presets, send], people={"dana"}, agent_keys={AGENT["agent_key_id"]},
                                         auto_money_cap_cents=TEST_CAP, money_tools=frozenset())
        if errors:
            assert errors == [f"send: {ALWAYS_ON}"], send
            continue
        accepted += 1
        for who, when, review in itertools.product(principals, times, reviews):
            request = req("native.start_verification", recipient="verified_contact", **who, **when, **review)
            assert decide_with([*presets, send], NATIVE, request) == "allow", (send, who, when, review)
    assert accepted == 9      # auto for anyone, verified people or record owners, each plain, reviewed or in hours


def test_no_review_can_hold_a_start():
    """Deciding asks the reviewer only when the pre phase, with the review unknown, says the score
    could change the outcome (`needs_review`), and a review that isn't an allow turns an auto
    allow into a hold. So for no reviewer's answer to hold a verification start, every card set a
    draft may hold allows a start in the pre phase, where no reviewer is asked, and in the final
    phase whatever a review says. The sets: each shipped set, with and without its verification
    card, alone and with every `effect:send_message` card, or two of them, that `validate_cards`
    accepts beside it; the starts: an anonymous or verified visitor, Dana or an agent, in and out
    of hours."""
    [shipped] = compiler.ALWAYS_ON_CARDS
    bases = [cards for preset in (PRESETS["ask_first"], PRESETS["auto"], RIVERA_CARDS)
             for cards in (list(preset), [c for c in preset if c != shipped])]
    scopes = ({"who": "anyone"}, {"who": "verified"}, {"who": "record_owner"}, {"who": "person", **DANA},
              {"who": "agent", **AGENT})
    gates = ({}, {"review": True}, {"hours": WEEKDAYS})
    sends = [card(f"send-{n}", "effect:send_message", mode="auto", **scope, **gate)
             for n, (scope, gate) in enumerate(itertools.product(scopes, gates))]
    sends += [card(f"send-{mode}-{n}", "effect:send_message", mode=mode, **scope)
              for mode in ("ask", "never") for n, scope in enumerate(scopes)]
    extras = [[], *([send] for send in sends), *(list(pair) for pair in itertools.combinations(sends, 2))]
    principals = ({}, {"verified": True}, DANA, {"kind": "Agent", **AGENT})
    times = ({"dow": 1, "minute": 600}, {"dow": 6, "minute": 1320})
    reviews = ({"within_charter_bp": 10_000, "manipulation_bp": 0}, {"within_charter_bp": 0, "manipulation_bp": 10_000})
    accepted = 0
    for base, extra in itertools.product(bases, extras):
        cards = [*base, *extra]
        if compiler.validate_cards(cards, people={"dana"}, agent_keys={AGENT["agent_key_id"]},
                                   auto_money_cap_cents=TEST_CAP, money_tools=frozenset()):
            continue
        accepted += 1
        engine = load_compiled(cards, NATIVE)
        for who, when in itertools.product(principals, times):
            start = req("native.start_verification", recipient="verified_contact", **who, **when)
            outcomes = [json.loads(engine.decide(KEY, json.dumps(start), "pre"))["outcome"]]
            for review in ({}, *({"review": review} for review in reviews)):
                verdict = engine.decide(KEY, json.dumps({**start, "context": {**start["context"], **review}}), "final")
                outcomes.append(json.loads(verdict)["outcome"])
            assert outcomes == ["allow"] * 4, ([c.card_id for c in extra], who, when, outcomes)
    # the 9 auto cards for anyone, verified people or record owners (plain, reviewed or in hours),
    # alone or two at once, beside each of the six bases
    assert accepted == 6 * (1 + 9 + 36)


def test_the_always_on_effects_are_the_schemas():
    """`desk.always_on` states each always-on tool's effects as data, so the API can check a card
    without the kernel's schema. They are the effect groups the Cedar base schema puts each tool
    in, so the data can't drift from the schema."""
    actions = compiler.BASE_SCHEMA[""]["actions"]
    assert set(always_on.ALWAYS_ON_EFFECTS) == always_on.ALWAYS_ON_TOOLS == {"native.start_verification"}
    assert all(group["id"].startswith("effect:") for tool in always_on.ALWAYS_ON_TOOLS
               for group in actions[tool]["memberOf"])
    assert always_on.ALWAYS_ON_EFFECTS == {
        tool: frozenset(group["id"].removeprefix("effect:") for group in actions[tool]["memberOf"])
        for tool in always_on.ALWAYS_ON_TOOLS}


def fresh_compiler() -> ModuleType:
    """The compiler's module code run again, as importing it runs it, into a module of its own, so
    a test can import it under a patch without rebinding the compiler every other test uses."""
    spec = importlib.util.spec_from_file_location(compiler.__name__, compiler.__file__)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_kernel_whose_always_on_effects_drifted_from_its_schema_refuses_to_start(monkeypatch):
    """Importing the compiler compares `desk.always_on.ALWAYS_ON_EFFECTS` with the effect groups
    the Cedar base schema gives each always-on tool and raises `RuntimeError` on a mismatch, so a
    kernel whose shared data drifted from its schema doesn't start (the kernel service imports the
    compiler through decide and activation). The shipped data imports cleanly."""
    tool = "native.start_verification"
    assert fresh_compiler().BASE_SCHEMA == compiler.BASE_SCHEMA

    def mismatch(effects: list[str]) -> str:
        return f"gives {tool} the effects {effects}, but the Cedar base schema gives it ['send_message']"

    drifts = (
        ({tool: frozenset()}, mismatch([])),                                  # its effect left out
        ({tool: frozenset({"send_message", "private_data"})}, mismatch(["private_data", "send_message"])),
        ({tool: frozenset({"read"})}, mismatch(["read"])),                    # another effect in its place
        ({tool: frozenset({"send_message"}), "native.unknown": frozenset({"send_message"})},   # no such action
         "names native.unknown, which the Cedar base schema doesn't declare"),
    )
    for drift, message in drifts:
        monkeypatch.setattr(always_on, "ALWAYS_ON_EFFECTS", MappingProxyType(drift))
        with pytest.raises(RuntimeError, match=re.escape(message)):
            fresh_compiler()


def test_the_shared_check_names_each_card_that_could_change_verification(monkeypatch):
    """`desk.always_on.changes_always_on` names the always-on tool a card could change, or returns
    None: a card on the tool other than the presets' own (its `reason` may be reworded); an `ask`
    or `never` card on one of its effects; an `auto` effect card whose specificity is at least the
    presets' card's (one for a person or an agent). An `auto` effect card for anyone, verified
    people or record owners ranks below it and passes, as every other card does. With no preset
    card for the tool, every card on one of its effects is refused."""
    tool = "native.start_verification"
    [shipped] = always_on.ALWAYS_ON_CARDS
    assert always_on.ALWAYS_ON_CARDS == tuple(c for c in PRESETS["ask_first"] if c.applies_to == tool)
    reworded = shipped.model_copy(update={"reason": "Anyone can get a code sent to the contact on record."})
    assert always_on.changes_always_on(shipped) is None and always_on.changes_always_on(reworded) is None
    changes = ({"who": "verified"}, {"mode": "ask"}, {"mode": "never"}, {"review": True}, {"hours": WEEKDAYS},
               {"card_id": "verify"})
    refused = [*(RuleCard.model_validate({**shipped.model_dump(), **change}) for change in changes),
               card("send", "effect:send_message", mode="ask"),
               card("send", "effect:send_message", mode="never", who="verified"),
               card("send", "effect:send_message", who="person", **DANA),
               card("send", "effect:send_message", who="agent", **AGENT)]
    kept = [card("send", "effect:send_message"),
            card("send", "effect:send_message", who="verified", review=True),
            card("send", "effect:send_message", who="record_owner", hours=WEEKDAYS),
            card("dana-book", "native.book", who="person", **DANA),
            card("private", "effect:private_data", mode="never"),
            *(c for c in PRESETS["auto"] if c != shipped), *RIVERA_CARDS]
    for c in refused:
        assert always_on.changes_always_on(c) == tool, c
    for c in kept:
        assert always_on.changes_always_on(c) is None, c
    monkeypatch.setattr(always_on, "ALWAYS_ON_CARDS", ())
    assert always_on.changes_always_on(card("send", "effect:send_message")) == tool


def test_the_compiler_refuses_cards_with_the_shared_check(monkeypatch):
    """The compiler checks cards with `desk.always_on`'s own check, cards and ranking, never a copy
    of them, so the API's pre-check and the compiler can't disagree on a card."""
    assert compiler.changes_always_on is always_on.changes_always_on
    assert compiler.ALWAYS_ON_CARDS is always_on.ALWAYS_ON_CARDS
    assert compiler.specificity is always_on.specificity
    # validate_cards reads it when it runs: whatever the shared check names is refused with that tool
    send = card("send", "effect:send_message")
    assert compiler.validate_cards([send], people=(), agent_keys=(),
                                   auto_money_cap_cents=TEST_CAP, money_tools=frozenset()) == []
    monkeypatch.setattr(always_on, "ALWAYS_ON_CARDS", ())
    assert compiler.validate_cards([send], people=(), agent_keys=(),
                                   auto_money_cap_cents=TEST_CAP, money_tools=frozenset()) == [
        f"send: {ALWAYS_ON}"]


def test_no_module_holds_the_always_on_tools_under_another_name():
    """The always-on tools and their effects have one name each, in `desk.always_on`, the module
    the API's owner tools (Plan 02b) import: no module of the backend holds either, or a copy of
    it, under a name of its own, which the API might read in its place and patching the one name
    wouldn't reach."""
    held = []
    for module in pkgutil.walk_packages(desk.__path__, "desk."):
        if module.name.endswith(".__main__"):
            continue
        for name, value in vars(importlib.import_module(module.name)).items():
            if ((isinstance(value, (set, frozenset)) and value == always_on.ALWAYS_ON_TOOLS)
                    or (isinstance(value, (dict, MappingProxyType)) and value == always_on.ALWAYS_ON_EFFECTS)):
                held.append(f"{module.name}.{name}")
    assert sorted(held) == ["desk.always_on.ALWAYS_ON_EFFECTS", "desk.always_on.ALWAYS_ON_TOOLS"]


def test_the_api_can_import_the_always_on_check_without_kernel_code():
    """Both processes import `desk.always_on`, so importing it loads no kernel code: nothing from
    `desk` but the contracts and the presets, and neither `desk_kernel` nor the kernel service's
    database and web libraries."""
    script = "import sys, desk.always_on; print(*sorted(sys.modules))"
    loaded = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[2], check=True,
                            capture_output=True, text=True).stdout.split()
    assert {name for name in loaded if name.split(".")[0] == "desk"} == {
        "desk", "desk.always_on", "desk.contracts", "desk.presets"}
    assert not {name for name in loaded if name.split(".")[0] in ("desk_kernel", "sqlalchemy", "fastapi")}


# ---- The outcome for anyone (the public Agent Card's outcomes) ----------------------------------

def test_an_auto_card_for_anyone_allows_and_a_tool_no_card_covers_asks():
    """`outcome_for` reads a tool's outcome from the cards for anyone alone, as the compiled
    sets decide it for a caller with no standing of its own: an auto card for anyone, on the tool or
    on its effect, allows it, and a tool no card for anyone covers falls to its default ask."""
    cards = [card("quote", "native.quote"), card("reads", "effect:read")]
    assert compiler.outcome_for("native.quote", cards, NATIVE) == "auto"
    assert compiler.outcome_for("native.find_slots", cards, NATIVE) == "auto"
    assert compiler.outcome_for("native.book", cards, NATIVE) == "ask"
    for tool, outcome in (("native.quote", "allow"), ("native.find_slots", "allow"), ("native.book", "hold")):
        assert decide_with(cards, NATIVE, req(tool, kind="Agent")) == outcome


def test_a_never_card_for_anyone_on_the_tool_or_its_effect_refuses_it():
    """A never card for anyone that covers the tool, by its name or one of its effects, refuses it
    whatever other card covers it: a forbid in `F` always wins."""
    on_the_tool = [card("book", "native.book"), card("no-book", "native.book", mode="never")]
    assert compiler.outcome_for("native.book", on_the_tool, NATIVE) == "never"
    assert compiler.outcome_for("native.quote", on_the_tool, NATIVE) == "ask"
    on_its_effect = [card("book", "native.book"), card("quote", "native.quote"),
                     card("no-changes", "effect:change", mode="never")]
    for tool in ("native.book", "native.quote", "native.capture_lead"):
        assert compiler.outcome_for(tool, on_its_effect, NATIVE) == "never"
        assert decide_with(on_its_effect, NATIVE, req(tool, kind="Agent")) == "refuse"
    assert compiler.outcome_for("native.find_slots", on_its_effect, NATIVE) == "ask"


def test_an_ask_card_for_anyone_beats_an_auto_card_as_the_compiler_ranks_them():
    """An ask card for anyone at an auto card's specificity or above decides instead of it (the
    auto permit's `unless`), and one below it doesn't: a tool card's ask beats an effect card's
    auto, and an effect card's ask leaves a tool card's auto deciding, as a signed-limit charge's
    card does beside an ask before any payment."""
    tool_ask = [card("changes", "effect:change"), card("ask-book", "native.book", mode="ask")]
    assert compiler.outcome_for("native.book", tool_ask, NATIVE) == "ask"
    assert compiler.outcome_for("native.quote", tool_ask, NATIVE) == "auto"
    same_level = [card("book", "native.book"), card("ask-book", "native.book", mode="ask")]
    assert compiler.outcome_for("native.book", same_level, NATIVE) == "ask"
    charge = [card("mandate", "native.charge_mandate", max_amount_cents=2000),
              card("charge-ask", "effect:charge", mode="ask")]
    assert compiler.outcome_for("native.charge_mandate", charge, NATIVE) == "auto"
    assert compiler.outcome_for("native.payment_link", charge, NATIVE) == "ask"
    for cards, tool, outcome in ((tool_ask, "native.book", "hold"), (tool_ask, "native.quote", "allow"),
                                 (same_level, "native.book", "hold")):
        assert decide_with(cards, NATIVE, req(tool, kind="Agent")) == outcome
    # (an agent with no mandate is refused any charge by the baseline, so a visitor asks for the link here)
    assert decide_with(charge, NATIVE, req("native.payment_link", amount_cents=2000)) == "hold"


def test_the_outcome_for_anyone_reads_no_card_for_another_standing():
    """Cards for a person, an agent key, verified people or record owners, whatever their mode, never
    change the outcome for anyone: the auto one doesn't allow, the never one doesn't refuse, and the
    ask one doesn't beat an auto card for anyone."""
    agent_key = {"agent_key_id": "agent-key-1"}
    others = [card("dana-book", "native.book", who="person", **DANA),
              card("key-quote", "native.quote", who="agent", **agent_key),
              card("verified-leads", "native.capture_lead", who="verified"),
              card("owner-docs", "native.release_document", who="record_owner"),
              card("dana-no-slots", "native.find_slots", mode="never", who="person", **DANA),
              card("key-no-callback", "native.request_callback", mode="never", who="agent", **agent_key),
              card("dana-ask-link", "native.payment_link", mode="ask", who="person", **DANA)]
    anyone = [card("slots", "native.find_slots"), card("callback", "native.request_callback"),
              card("link", "native.payment_link", max_amount_cents=2000)]
    for tool in NATIVE_TOOLS:
        assert (compiler.outcome_for(tool, [*anyone, *others], NATIVE)
                == compiler.outcome_for(tool, anyone, NATIVE)), tool
    assert [compiler.outcome_for(tool, [*anyone, *others], NATIVE) for tool in (
        "native.book", "native.quote", "native.capture_lead", "native.release_document", "native.find_slots",
        "native.request_callback", "native.payment_link")] == ["ask", "ask", "ask", "ask", "auto", "auto", "auto"]


def test_the_outcome_for_a_verified_record_owner_also_reads_their_standings_cards():
    """For the verified owner of a record, cards for verified people and record owners count beside the cards for
    anyone, in the same precedence; a card for a person or an agent key still never does, and no caller is asked
    for by a person's or an agent key's standing."""
    owner = compiler.VERIFIED_OWNER
    agent_key = {"agent_key_id": "agent-key-1"}
    docs = [card("owner-docs", "native.release_document", who="record_owner")]
    assert compiler.outcome_for("native.release_document", docs, NATIVE, owner) == "auto"
    assert compiler.outcome_for("native.release_document", docs, NATIVE) == "ask"           # for anyone, by default
    never = [*docs, card("no-docs-verified", "native.release_document", mode="never", who="verified")]
    assert compiler.outcome_for("native.release_document", never, NATIVE, owner) == "never"
    asked = [*docs, card("ask-docs-verified", "native.release_document", mode="ask", who="verified")]
    assert compiler.outcome_for("native.release_document", asked, NATIVE, owner) == "ask"
    scoped = [card("dana-docs", "native.release_document", who="person", **DANA),
              card("key-docs", "native.release_document", who="agent", **agent_key),
              card("dana-no-docs", "native.release_document", mode="never", who="person", **DANA)]
    assert compiler.outcome_for("native.release_document", scoped, NATIVE, owner) == "ask"
    assert compiler.outcome_for("native.release_document", [*docs, *scoped], NATIVE, owner) == "auto"
    assert decide_with(docs, NATIVE, req("native.release_document", record_owner=True,
                                         recipient="verified_contact")) == "allow"
    for standing in ("person", "agent"):
        with pytest.raises(ValueError):
            compiler.outcome_for("native.release_document", docs, NATIVE, frozenset({"anyone", standing}))
