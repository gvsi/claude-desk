import json
from pathlib import Path
from typing import get_args

import pytest
from pydantic import TypeAdapter, ValidationError

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    A2ARequest,
    AgentAuth,
    BusinessSeed,
    Claim,
    CopyCreated,
    DeskSeed,
    Effect,
    HoursWindow,
    Label,
    LedgerEntry,
    Mandate,
    NormalizedAction,
    PriceItem,
    Probe,
    Review,
    RuleCard,
    SeedDocument,
    SeedPerson,
    SessionCreated,
    SessionState,
)
from desk.events import EvDemoInbox, EvHeld, SseEvent
from desk.kernel_api import KERNEL_REQUESTS, KERNEL_RESPONSES, KERNEL_ROUTES, ExecuteRequest, KernelError, WhoAmI
from scripts.export_schema import export_schema

IDENTITY = {"principal", "person_id", "level", "assurance"}


def test_kernel_requests_and_seeds_never_carry_identity():
    for model in (*KERNEL_REQUESTS, AgentAuth, A2ARequest, BusinessSeed, DeskSeed, SeedPerson, SeedDocument):
        assert not IDENTITY & set(model.model_fields), model


def test_session_responses_never_name_a_person():
    for model in (SessionCreated, SessionState, CopyCreated, WhoAmI):
        assert not {"principal", "person_id"} & set(model.model_fields), model


def test_money_effect_is_split():
    assert "move_money" not in get_args(Effect)
    assert {"charge", "pay_out"} <= set(get_args(Effect))


def test_review_scores_are_bounded_basis_points():
    with pytest.raises(ValidationError):
        Review(within_charter_bp=10_001, manipulation_bp=0, recommendation="allow")


def test_review_scores_are_strict_integers():
    valid = {"within_charter_bp": 9_500, "manipulation_bp": 500, "recommendation": "allow"}
    assert Review.model_validate_json(json.dumps(valid)).manipulation_bp == 500
    for field in ("within_charter_bp", "manipulation_bp"):
        for malformed in (False, "0", 1.0):           # lax parsing would turn each into a favorable score
            with pytest.raises(ValidationError):
                Review.model_validate_json(json.dumps({**valid, field: malformed}))


def test_outside_amounts_and_basis_points_are_strict_integers():
    card = {"card_id": "rv-link", "applies_to": "native.payment_link", "mode": "auto", "who": "anyone", "reason": "x",
            "max_amount_cents": 30_000, "max_discount_bp": 500}
    probe = {"actor": "agent", "who": "agent", "subject_id": "k1", "agent_mandate_remaining_cents": 2_000,
             "call": {"call_id": "c1", "tool": "native.charge_mandate", "args": {}}, "resource_kind": "quote",
             "amount_cents": 2_000}
    mandate = {"mandate_id": "m1", "issuer": "demo-wallet", "agent_key_id": "k1", "desk_id": "d1",
               "allowed_effects": ["charge"], "per_charge_cents": 2_000, "total_cents": 10_000, "currency": "usd",
               "expires_at": "2026-11-03T00:00:00.000000Z", "nonce": "n", "sig": "s"}
    cases = [
        (Claim, {"key": "total", "kind": "money", "value": 18_000}, ["value"], (False, 1.0)),   # a str value is a text claim
        (PriceItem, {"item_id": "drain", "title": "Drain clearing", "unit_cents": 18_000}, ["unit_cents"], None),
        (RuleCard, card, ["max_amount_cents", "max_discount_bp"], None),
        (Probe, probe, ["agent_mandate_remaining_cents", "amount_cents"], None),
        (Mandate, mandate, ["per_charge_cents", "total_cents"], None),
    ]
    for model, valid, fields, malformed_values in cases:
        model.model_validate_json(json.dumps(valid))
        for field in fields:
            for malformed in malformed_values or (False, "100", 1.0):
                with pytest.raises(ValidationError):
                    model.model_validate_json(json.dumps({**valid, field: malformed}))


def test_review_and_limits_only_on_auto_cards():
    with pytest.raises(ValidationError):
        RuleCard(card_id="c1", applies_to="native.book", mode="ask", who="anyone", reason="x", review=True)
    with pytest.raises(ValidationError):
        RuleCard(card_id="c2", applies_to="effect:charge", mode="never", who="anyone", reason="x",
                 max_amount_cents=100)


def test_auto_money_cards_need_a_bounded_amount():
    for applies_to, amount in (("effect:charge", None), ("payments.create_refund", AUTO_MONEY_HARD_CAP_CENTS + 1)):
        with pytest.raises(ValidationError):
            RuleCard(card_id="c5", applies_to=applies_to, mode="auto", who="anyone", reason="x", max_amount_cents=amount)


def test_scoped_cards_need_their_subject():
    with pytest.raises(ValidationError):
        RuleCard(card_id="c3", applies_to="native.release_document", mode="auto", who="person", reason="x")
    with pytest.raises(ValidationError):
        RuleCard(card_id="c4", applies_to="native.charge_mandate", mode="auto", who="agent", reason="x",
                 max_amount_cents=1_000)


def test_card_subjects_only_on_their_scope():
    with pytest.raises(ValidationError):
        RuleCard(card_id="c6", applies_to="native.book", mode="auto", who="anyone", reason="x", person_id="p1")
    with pytest.raises(ValidationError):
        RuleCard(card_id="c7", applies_to="native.book", mode="auto", who="person", reason="x",
                 person_id="p1", agent_key_id="k1")


def test_hours_and_discounts_only_on_auto_cards():
    weekdays = HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start="08:00", end="18:00")
    with pytest.raises(ValidationError):
        RuleCard(card_id="c8", applies_to="native.book", mode="never", who="anyone", reason="x", hours=weekdays)
    with pytest.raises(ValidationError):
        RuleCard(card_id="c9", applies_to="native.quote", mode="ask", who="anyone", reason="x", max_discount_bp=1_000)


def test_default_cards_are_compiler_asks_for_anyone():
    for mode, who in (("auto", "anyone"), ("never", "anyone"), ("ask", "verified")):
        with pytest.raises(ValidationError):
            RuleCard(card_id="c10", applies_to="native.book", mode=mode, who=who, reason="x", is_default=True)


def test_valid_cards_are_accepted():
    # The Rivera seed's cards, the approval drafts and a default ask: each constructor raises if a rule rejects it.
    weekdays = HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start="08:00", end="18:00")
    cards = [
        RuleCard(card_id="rv-quote", applies_to="native.quote", mode="auto", who="anyone", reason="x"),
        RuleCard(card_id="rv-book-wk", applies_to="native.book", mode="auto", who="anyone", reason="x",
                 hours=weekdays, review=True),
        RuleCard(card_id="rv-docs", applies_to="native.release_document", mode="auto", who="record_owner", reason="x"),
        RuleCard(card_id="rv-link", applies_to="native.payment_link", mode="auto", who="anyone", reason="x",
                 max_amount_cents=30_000, review=True),
        RuleCard(card_id="rv-refund", applies_to="payments.create_refund", mode="ask", who="record_owner", reason="x"),
        RuleCard(card_id="person-link", applies_to="native.payment_link", mode="auto", who="person", reason="x",
                 person_id="p1", max_amount_cents=AUTO_MONEY_HARD_CAP_CENTS, max_discount_bp=1_500),
        RuleCard(card_id="agent-never", applies_to="native.charge_mandate", mode="never", who="agent", reason="x",
                 agent_key_id="k1"),
        RuleCard(card_id="default-book", applies_to="native.book", mode="ask", who="anyone", reason="x", is_default=True),
        RuleCard(card_id="change-disc", applies_to="effect:change", mode="auto", who="anyone", reason="x",
                 max_discount_bp=1_000),
    ]
    assert [card.mode for card in cards].count("auto") == 6


def test_actions_carry_kernel_prices():
    assert {"list_cents", "discount_bp", "amount_cents"} <= set(NormalizedAction.model_fields)


def test_mandates_cannot_pay_out():
    with pytest.raises(ValidationError):
        Mandate(mandate_id="m1", issuer="demo-wallet", agent_key_id="k1", desk_id="d1",
                allowed_effects=["pay_out"], per_charge_cents=100, total_cents=1000, currency="usd",
                expires_at="2026-11-03T00:00:00.000000Z", nonce="n", sig="s")


def test_signed_timestamps_survive_a_round_trip():
    auth = AgentAuth(agent_key_id="k1", ts="2026-10-30T17:04:05.123000Z", nonce="n", sig="s")
    assert AgentAuth.model_validate_json(auth.model_dump_json()).ts == "2026-10-30T17:04:05.123000Z"
    with pytest.raises(ValidationError):
        AgentAuth(agent_key_id="k1", ts="2026-10-30T17:04:05+00:00", nonce="n", sig="s")


def test_missing_label_is_owner_only():
    assert Label().readers == ["owner"]


def test_ledger_entries_carry_their_hash_inputs():
    assert {"copy_id", "desk_id", "seq", "prev_hash", "created_at", "event"} <= set(LedgerEntry.model_fields)
    assert LedgerEntry.model_fields["created_at"].annotation is str


def test_demo_inbox_event_is_code_free():
    assert set(EvDemoInbox.model_fields) == {"type", "entry_id", "to", "preview"}


def test_sse_union_discriminates():
    ev = TypeAdapter(SseEvent).validate_python(
        {"type": "held", "decision_id": "d1", "state": "held", "visitor_plain": "Asked Maria",
         "ledger_seq": 7, "signature": "s"})
    assert isinstance(ev, EvHeld)


def test_every_kernel_route_names_its_models():
    bodiless_ok = {"GET /document_links/{token}", "DELETE /desks/{id}"}
    for route, (request, response) in KERNEL_ROUTES.items():
        assert request is None or request in KERNEL_REQUESTS, route
        assert response is not None or route in bodiless_ok, route
    used = {request for request, _ in KERNEL_ROUTES.values()}
    assert set(KERNEL_REQUESTS) <= used
    assert KernelError in KERNEL_RESPONSES            # the body of every non-2xx answer, so it is exported


def test_execute_names_generation_or_approval():
    assert ExecuteRequest(decision_id="d1", session_id="s1", generation=3).approval_id is None
    assert ExecuteRequest(decision_id="d1", session_id="s1", approval_id="a1").generation is None
    for extra in ({}, {"generation": 3, "approval_id": "a1"}):
        with pytest.raises(ValidationError):
            ExecuteRequest(decision_id="d1", session_id="s1", **extra)


def test_schema_export_is_current():
    assert export_schema() == json.loads(Path("desk/contracts.schema.json").read_text())
