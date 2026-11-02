import inspect
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import get_args
from zoneinfo import ZoneInfo

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    ITEM_ID_PATTERN,
    SLOT_ID_PATTERN,
    A2ARequest,
    AgentAuth,
    BusinessSeed,
    CalendarSlot,
    Claim,
    CopyCreated,
    Decision,
    DemoInboxEntry,
    DeskSeed,
    Effect,
    HoursWindow,
    Label,
    LedgerEntry,
    MCP_TOOLS,
    Mandate,
    NormalizedAction,
    PolicyVersion,
    PriceItem,
    Probe,
    RenderedBlock,
    ReplayedEvent,
    ReplyVerdict,
    Review,
    RuleCard,
    SeedDocument,
    SeedPerson,
    SessionCreated,
    SessionState,
    ToolName,
    ToolProfile,
)
from desk.events import EvDemoInbox, EvError, EvHeld, EvOwnerJoined, EvOwnerTyping, SseEvent
from desk.kernel_api import (
    KERNEL_REQUESTS,
    KERNEL_RESPONSES,
    KERNEL_ROUTES,
    CreateCopyRequest,
    CreateSessionRequest,
    DeskUpdated,
    ExecuteRequest,
    DecideRequest,
    KernelError,
    LedgerAppendRequest,
    OpenStatus,
    PolicyDraftRequest,
    PublicDesk,
    ToolsConfirmRequest,
    TurnRequest,
    TurnStarted,
    WhoAmI,
)
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


def minimal_desk_seed(**fields) -> dict:
    """A `DeskSeed` body with every required field and nothing in it, plus `fields`."""
    return {"name": "Main line", "charter": [], "hours": [], "price_items": [], "calendar_slots": [], "people": [],
            "documents": [], "notifications": {"now": [], "briefing": []}, **fields}


def test_platform_ceiling_is_ten_thousand_dollars():
    # the platform ceiling is the per-payment limit every money action already has
    assert AUTO_MONEY_HARD_CAP_CENTS == 1_000_000
    PriceItem(item_id="big", title="Big job", unit_cents=AUTO_MONEY_HARD_CAP_CENTS)
    with pytest.raises(ValidationError):
        PriceItem(item_id="big", title="Big job", unit_cents=AUTO_MONEY_HARD_CAP_CENTS + 1)
    # an auto money card may allow up to the ceiling, and no more
    RuleCard(card_id="c11", applies_to="effect:charge", mode="auto", who="anyone", reason="x",
             max_amount_cents=1_000_000)
    with pytest.raises(ValidationError):
        RuleCard(card_id="c12", applies_to="effect:charge", mode="auto", who="anyone", reason="x",
                 max_amount_cents=1_000_001)
    # a Desk's first cap and a draft's cap: whole cents from 0 to the ceiling, never a bool, text or float
    DeskSeed.model_validate_json(json.dumps(minimal_desk_seed(auto_money_cap_cents=1_000_000)))
    draft = {"desk_id": "desk-1", "cards": [], "expected_parent": 1}
    PolicyDraftRequest.model_validate_json(json.dumps({**draft, "auto_money_cap_cents": 1_000_000}))
    for malformed in (1_000_001, -1, True, "500", 500.0):
        with pytest.raises(ValidationError):
            DeskSeed.model_validate_json(json.dumps(minimal_desk_seed(auto_money_cap_cents=malformed)))
        with pytest.raises(ValidationError):
            PolicyDraftRequest.model_validate_json(json.dumps({**draft, "auto_money_cap_cents": malformed}))
        with pytest.raises(ValidationError):
            DeskSeed.model_validate(minimal_desk_seed(auto_money_cap_cents=malformed))
        with pytest.raises(ValidationError):
            PolicyDraftRequest.model_validate({**draft, "auto_money_cap_cents": malformed})


def test_desk_cap_defaults_to_zero():
    # unset is 0: every charge and payout asks
    assert DeskSeed.model_validate(minimal_desk_seed()).auto_money_cap_cents == 0
    version = {"desk_id": "desk-1", "version": 1, "parent_version": None, "cards": [], "cedar_sha256": "c",
               "schema_sha256": "s", "baseline_sha256": "b", "profiles_sha256": "p", "invariants_sha256": "i",
               "review_thresholds_version": 1, "status": "active"}
    assert PolicyVersion.model_validate(version).auto_money_cap_cents == 0
    assert PolicyVersion.model_validate({**version, "auto_money_cap_cents": 50_000}).auto_money_cap_cents == 50_000


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
    # The Turner seed's cards, the approval drafts and a default ask: each constructor raises if a rule rejects it.
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


def test_cards_name_a_known_target_and_limits_in_range():
    valid = {"card_id": "x", "applies_to": "native.quote", "mode": "auto", "who": "anyone", "reason": "r"}
    RuleCard(**valid)
    for wrong in (
        {"applies_to": "native.payment_links"},   # a misspelt money tool would dodge the money-card rule
        {"applies_to": "effect:Charge"},
        {"applies_to": "anything"},
        {"max_amount_cents": -5},
        {"max_discount_bp": -1},
        {"max_discount_bp": 10_001},
    ):
        with pytest.raises(ValidationError):
            RuleCard(**valid | wrong)


def test_hours_windows_are_one_local_span():
    HoursWindow(days=["sat"], start="09:00", end="13:00")
    # an end of 00:00 is midnight, the end of the day: the first half of an overnight split, or a whole day
    HoursWindow(days=["fri"], start="22:00", end="00:00")
    HoursWindow(days=["sat"], start="00:00", end="02:00")
    HoursWindow(days=["sun"], start="00:00", end="00:00")
    for wrong in (
        {"days": []},
        {"start": "22:00", "end": "02:00"},   # past midnight is two windows
        {"start": "09:00", "end": "09:00"},
        {"start": "22:00", "end": "00:00:30"},
        {"start": "09:00+02:00"},              # local to the business, never an offset
        {"start": "22:00", "end": "00:00+02:00"},
    ):
        with pytest.raises(ValidationError):
            HoursWindow(**{"days": ["mon"], "start": "09:00", "end": "17:00"} | wrong)


def test_claim_values_match_their_kind():
    for kind, value in (("money", 18_000), ("percent_bp", 1_500), ("datetime", "2026-11-03T16:00:00-08:00"),
                        ("datetime", "2026-11-03T16:00:00Z"), ("text", "Fresno and Clovis"), ("ref", "doc-1")):
        Claim(key="k", kind=kind, value=value)
    for kind, value in (("money", "80% off"), ("percent_bp", "15"), ("percent_bp", 10_001), ("percent_bp", -1),
                        ("datetime", 5), ("datetime", "next tuesday"), ("datetime", "2026-11-03T16:00:00"),
                        ("text", 5), ("ref", 5)):
        with pytest.raises(ValidationError):
            Claim(key="k", kind=kind, value=value)
    with pytest.raises(ValidationError):
        Claim(key="hours", kind="text", value="8 to 6")   # hours live in DeskSeed.hours


def test_signed_timestamps_use_ascii_digits():
    with pytest.raises(ValidationError):
        AgentAuth(agent_key_id="k1", ts="\u0662\u0660\u0662\u0666-10-30T17:04:05.123000Z", nonce="n", sig="s")


def test_probes_name_their_subject_exactly_when_scoped():
    base = {"actor": "visitor", "call": {"call_id": "c1", "tool": "native.book", "args": {}}, "resource_kind": "slot"}
    Probe(**base, who="person", subject_id="p1")
    Probe(**base, who="anyone")
    for wrong in ({"who": "person"}, {"who": "agent"}, {"who": "anyone", "subject_id": "p1"}):
        with pytest.raises(ValidationError):
            Probe(**base | wrong)


def test_probe_names_a_start_time():
    # hours probes ask about a slot or booking at a given time; without one the kernel uses its own now
    base = {"actor": "visitor", "who": "anyone", "call": {"call_id": "c1", "tool": "native.book", "args": {}},
            "resource_kind": "slot"}
    assert Probe(**base).starts_at is None
    saturday = Probe(**base, starts_at="2026-11-07T10:00:00-08:00").starts_at
    assert (saturday.isoformat(), saturday.utcoffset().total_seconds()) == ("2026-11-07T10:00:00-08:00", -8 * 3600)
    with pytest.raises(ValidationError):
        Probe(**base, starts_at="2026-11-07T10:00:00")   # a time without its offset is ambiguous


def test_create_session_takes_preview():
    # the owner previews a draft as a customer before Answering goes live; a plain visitor session is no preview
    assert CreateSessionRequest(desk_slug="turner-plumbing-abc123", kind="visitor").preview is False
    assert CreateSessionRequest(desk_slug="turner-plumbing-abc123", kind="visitor", preview=True).preview is True
    with pytest.raises(ValidationError):          # a preview is the owner acting as a visitor, never an agent: 422 invalid
        CreateSessionRequest(desk_slug="turner-plumbing-abc123", kind="agent", preview=True)


def test_the_turn_sends_one_message_and_answers_a_language():
    # POST /sessions/{session_id}/turn (issue #121): the newest visitor or agent message, at most 2,000 characters,
    # only to detect its language, and the session's language after it, one the kernel has templates for
    assert KERNEL_ROUTES["POST /sessions/{session_id}/turn"] == (TurnRequest, TurnStarted)
    assert TurnRequest(generation=0, text="x" * 2000).desk_id is None          # an owner session names its Desk
    with pytest.raises(ValidationError):
        TurnRequest(generation=0, text="x" * 2001)                            # 422 invalid, nothing cut
    assert set(TurnRequest.model_fields) == {"generation", "text", "desk_id"}
    assert set(TurnStarted.model_fields) == {"language"}
    assert [TurnStarted(language=language).language for language in ("en", "es")] == ["en", "es"]
    with pytest.raises(ValidationError):
        TurnStarted(language="fr")


def test_kernel_error_codes_include_rate_limited():
    # 429 (POST /agents/demo) has its own code, so a refused tool call is told apart from a bad request
    assert KernelError(code="rate_limited").code == "rate_limited"
    assert set(get_args(KernelError.model_fields["code"].annotation)) == {
        "auth", "not_found", "closed", "stale_generation", "mode_owner", "mode_paused", "replayed", "conflict",
        "invalid", "rate_limited", "seed_unproved", "internal"}


@pytest.mark.parametrize('detail', [
    {'A visitor wrote this': ['public_promise']},
    {'desk.x.title': ['This text is a promise']},
    {'': ['public_promise']},
    {'x' * 121: ['public_promise']},
    {'desk.x.title\n': ['public_promise']},
    {'desk.x/title': ['public_promise']},
    {'desk.x.title': ['']},
    {'desk.x.title': ['x' * 65]},
    {'desk.x.title': ['Public_Promise']},
    {'desk.x.title': ['lex.en.promise\n']},
    {'desk.x.title': ['lex.en/promise']},
    {'desk.x.title': ['prómise']},
])
def test_kernel_error_detail_refuses_free_text_and_invalid_identifiers(detail):
    with pytest.raises(ValidationError):
        KernelError(code='invalid', detail=detail)
    with pytest.raises(ValidationError):
        KernelError.model_validate_json(json.dumps({'code': 'invalid', 'detail': detail}))


def test_kernel_error_detail_accepts_emitted_fields_and_bounded_rule_ids():
    from desk.contracts import BusinessTool
    from desk.kernel_service import business_tools, reply_check

    for config in ({'block': 'intake', 'questions': ['What?']},
                   {'block': 'typed_booking', 'appointment_type': 'Consult', 'minutes': 30},
                   {'block': 'purpose_payment', 'purpose': 'Retainer', 'amount_cents': 5000},
                   {'block': 'urgent', 'urgent_when': 'A burst pipe'}):
        for title in ('Guaranteed service', 'Intake \u202edeetnaraug\u202c'):
            tool = BusinessTool(tool='desk.' + 'x' * 40, title=title, description='Take details.', config=config)
            values = business_tools.public_fields(tool)
            detail = business_tools.hidden_fields(values) or business_tools.card_refusal(
                tool, reply_check.scan_public_policies(values, allow_words=business_tools.free_allow_words(tool),
                                                  amenities=False))
            assert detail and KernelError(code='invalid', detail=detail).detail == detail

    detail = {'charter:policy:service_area': [f'lex.{language}.{category}'
              for language, entries in reply_check.LEXICONS.items() for category, _ in entries],
              'desk.x.0-title': ['public_promise', 'format_control'], 'A' * 120: ['r' * 64]}
    answer = KernelError(code='invalid', detail=detail)
    assert KernelError.model_validate_json(answer.model_dump_json()).detail == detail


def test_kernel_error_detail_schema_constrains_every_key():
    detail = KernelError.model_json_schema()['properties']['detail']
    assert detail['propertyNames'] == {'pattern': '^[A-Za-z0-9_.:-]{1,120}$'}


def test_ev_error_codes_are_closed():
    # the web app shows a static string per code, so the list is fixed and nothing else gets through
    events = TypeAdapter(SseEvent)
    for code in ("kernel_unavailable", "session", "rate_limited", "internal"):
        assert isinstance(events.validate_python({"type": "error", "code": code}), EvError)
    for code in ("auth", "stale_generation", "Session", "", "Something broke: see the logs"):
        with pytest.raises(ValidationError):
            events.validate_python({"type": "error", "code": code})


def test_ids_follow_their_patterns():
    # price item and slot ids repeat across Desks and reach cards and probes, so their shape is fixed
    assert re.fullmatch(ITEM_ID_PATTERN, "drain") and re.fullmatch(SLOT_ID_PATTERN, "S-20261102-0800")
    PriceItem(item_id="drain", title="Drain clearing", unit_cents=18_000)
    CalendarSlot(slot_id="S-20261102-0800", starts_at="2026-11-02T08:00:00-08:00", minutes=120)
    for item_id in ("Drain", "", "a" * 41, "drain clearing", "drain/1"):
        with pytest.raises(ValidationError):
            PriceItem(item_id=item_id, title="Drain clearing", unit_cents=18_000)
    for slot_id in ("S-2026112-800", "s-20261102-0800", "S-20261102-0800-x", "20261102-0800"):
        with pytest.raises(ValidationError):
            CalendarSlot(slot_id=slot_id, starts_at="2026-11-02T08:00:00-08:00", minutes=120)


def test_slot_ids_use_ascii_digits():
    # as with SignedTime: Python and Pydantic read \d as any Unicode digit, the web app's regex as 0-9 only
    arabic_indic = "S-٢٠٢٦١١٠٢-٠٨٠٠"   # S-20261102-0800
    assert not re.fullmatch(SLOT_ID_PATTERN, arabic_indic)
    with pytest.raises(ValidationError):
        CalendarSlot(slot_id=arabic_indic, starts_at="2026-11-02T08:00:00-08:00", minutes=120)


def test_kernel_requests_refuse_unknown_fields():
    # an identity field the API shouldn't send is refused, not silently dropped
    for model in KERNEL_REQUESTS:
        assert model.model_config.get("extra") == "forbid", model
    decide = {"session_id": "s1", "generation": 1, "call": {"call_id": "c1", "tool": "native.quote", "args": {}}}
    DecideRequest.model_validate(decide)
    for identity in ({"person_id": "p-dana"}, {"assurance": "owner_session"}):
        with pytest.raises(ValidationError):
            DecideRequest.model_validate(decide | identity)


def test_the_api_appends_only_its_own_ledger_events():
    for kind in ("session", "rate_limit", "agent_auth"):
        LedgerAppendRequest(desk_id="d", event={"kind": kind, "origin": "api", "summary": {}})
    for event in ({"kind": "decide", "origin": "api", "summary": {}},
                  {"kind": "session", "origin": "kernel", "summary": {}}):
        with pytest.raises(ValidationError):
            LedgerAppendRequest(desk_id="d", event=event)


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


def test_demo_inbox_decision_id_is_optional():
    # a held request's owner alert names its decision; every other entry, and a kernel that doesn't fill it yet,
    # still validates
    alert = {"entry_id": "inbox-1", "to": "owner", "kind": "alert", "body": "Dana asked for 15% off.",
             "created_at": "2026-10-30T10:04:05-07:00"}
    assert DemoInboxEntry.model_validate_json(json.dumps(alert)).decision_id is None
    assert DemoInboxEntry.model_validate_json(json.dumps(alert | {"decision_id": None})).decision_id is None
    assert DemoInboxEntry.model_validate_json(json.dumps(alert | {"decision_id": "dec-1"})).decision_id == "dec-1"
    assert "decision_id" not in export_schema()["$defs"]["DemoInboxEntry"]["required"]   # optional in the web's too


def test_a_decisions_owner_reason_is_optional_and_unsigned():
    # why an action didn't run, for the owner alone: None unless the kernel filled it, so a kernel that doesn't
    # and every answer to a session still validate; it sits beside reason_plain, and the signature leaves it out
    assert list(Decision.model_fields).index("owner_plain") == list(Decision.model_fields).index("reason_plain") + 1
    assert Decision.model_fields["owner_plain"].annotation == str | None
    assert Decision.model_fields["owner_plain"].default is None
    assert "owner_plain" not in export_schema()["$defs"]["Decision"]["required"]     # optional in the web's too
    source = inspect.getsource(Decision)
    assert re.search(r"^ +owner_plain: str \| None = None +# owner-facing kernel template", source, re.MULTILINE)
    assert re.search(r"owner_plain.*\n(?:.*\n)*? +signature: str +#.*\{decision_id, session_id, state, visitor_plain, "
                     r"ledger_seq\}\)$", source, re.MULTILINE)


def test_owner_typing_carries_no_free_text():
    # Presence after a take-over: the owner's display name and how long the dots show, never what they type.
    assert set(EvOwnerTyping.model_fields) == {"type", "name", "until"}
    assert EvOwnerTyping.model_config.get("extra") == EvOwnerJoined.model_config.get("extra")   # as its siblings
    assert EvOwnerTyping in get_args(get_args(SseEvent)[0])
    events = TypeAdapter(SseEvent)
    until = datetime(2026, 10, 29, 15, 4, 30, tzinfo=UTC)
    event = events.validate_python(
        {"type": "owner_typing", "name": "Mike Turner", "until": "2026-10-29T08:04:30-07:00", "text": "On my way"})
    assert isinstance(event, EvOwnerTyping)
    assert event.model_dump() == {"type": "owner_typing", "name": "Mike Turner", "until": until}   # no text travels
    with pytest.raises(ValidationError):
        events.validate_python({"type": "owner_typing", "name": "Mike Turner", "until": "2026-10-29T15:04:30"})


def test_sse_union_discriminates():
    ev = TypeAdapter(SseEvent).validate_python(
        {"type": "held", "decision_id": "d1", "state": "held", "visitor_plain": "Asked Mike",
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


MASTER_PLAN = Path(__file__).resolve().parents[2] / "docs" / "plans" / "2026-10-28-00-master-plan.md"


def plan_kernel_routes() -> set[str]:
    """The calls in the master plan's "Kernel HTTP API v2" table, with PUT /desks/{id}/{part} one route per part."""
    lines = MASTER_PLAN.read_text().splitlines()
    start = lines.index("| Call | Auth | Body → response |") + 2
    routes: set[str] = set()
    for line in lines[start:]:
        if not line.startswith("|"):
            break
        call, _auth, body = (cell.strip() for cell in line.strip("|").split(" | ", 2))
        call = call.strip("`")
        if call.endswith("/{part}"):
            parts = re.findall(r"`(\w+)`", body.split("part ∈ ", 1)[1].split(";", 1)[0])
            routes |= {call.replace("{part}", part) for part in parts}
        else:
            routes.add(call)
    return routes


def test_kernel_routes_match_the_plan():
    # the fake kernel and the contract suite are built from KERNEL_ROUTES, so it lists every call the plan does
    assert set(KERNEL_ROUTES) == plan_kernel_routes()
    assert KERNEL_ROUTES["POST /handoffs/{id}/done"] == (None, DeskUpdated)   # bodiless; closes an open handoff


def test_execute_names_generation_or_approval():
    assert ExecuteRequest(decision_id="d1", session_id="s1", generation=3).approval_id is None
    assert ExecuteRequest(decision_id="d1", session_id="s1", approval_id="a1").generation is None
    for extra in ({}, {"generation": 3, "approval_id": "a1"}):
        with pytest.raises(ValidationError):
            ExecuteRequest(decision_id="d1", session_id="s1", **extra)


def test_confirming_tools_names_the_reviewed_definitions():
    # the pin review: the owner's confirm names the exact hash they saw for each tool (an MCP tool's
    # listed definition, a native tool's adapter profile), so the kernel compares it with what is
    # current and never turns on a definition nobody reviewed; a whole connector goes in one batch
    assert MCP_TOOLS == {tool for tool in get_args(ToolName) if not tool.startswith("native.")}
    reviewed, other = "a" * 64, "b" * 64
    for enable in (True, False):
        batch = ToolsConfirmRequest(desk_id="d", enable=enable, tools=[
            {"tool": "payments.list_charges", "definition_sha256": reviewed},
            {"tool": "native.book", "definition_sha256": other}])
        assert [(pin.tool, pin.definition_sha256) for pin in batch.tools] == [
            ("payments.list_charges", reviewed), ("native.book", other)]
    one = {"tool": "payments.create_refund", "definition_sha256": reviewed}
    for bad in ({"tools": []}, {"tools": [one, one]}, {"tools": [{**one, "definition_sha256": None}]},
                {"tools": [{"tool": "payments.create_refund"}]}, {"tools": [{**one, "definition_sha256": "A" * 64}]},
                {"tools": [{**one, "tool": "payments.delete_customer"}]}, {"tools": [{**one, "extra": 1}]},
                {"tool": "native.book", "tools": [one]}):
        with pytest.raises(ValidationError):
            ToolsConfirmRequest(desk_id="d", enable=True, **bad)


def test_a_tool_says_why_it_needs_review():
    # the owner's tool row tells a new connect, a changed definition and a delisted tool apart; the
    # reason is never part of a profile's hash
    base = {"tool": "payments.list_charges", "source": "mcp", "effects": ["private_data"], "reversible": True,
            "adapter": "a", "resource_kind": "charge", "description_confirmed": "d", "input_schema": {}}
    assert ToolProfile(**base, status="enabled").review_reason is None
    for reason in ("new", "changed", "delisted"):
        assert ToolProfile(**base, status="needs_review", review_reason=reason).review_reason == reason
    with pytest.raises(ValidationError):
        ToolProfile(**base, status="needs_review", review_reason="edited")


PUBLIC_DESK = {"business_name": "Turner Plumbing", "desk_name": "Main line", "owner_display_name": "Mike Turner",
               "brand": {}, "charter": [], "agent_card": []}


def test_public_desk_open_status_is_optional():
    # a Desk without charter:hours has no open status, and a kernel that doesn't fill it yet still validates
    assert PublicDesk.model_validate_json(json.dumps(PUBLIC_DESK)).open_status is None
    assert PublicDesk.model_validate_json(json.dumps(PUBLIC_DESK | {"open_status": None})).open_status is None
    assert "open_status" not in export_schema()["$defs"]["PublicDesk"]["required"]   # optional in the web's types too


def test_public_desk_starters_default_to_an_independent_empty_list():
    first, second = (PublicDesk.model_validate(PUBLIC_DESK) for _ in range(2))
    assert first.starters == second.starters == []
    first.starters.append("Do you work in Alameda?")
    assert second.starters == []
    schema = export_schema()["$defs"]["PublicDesk"]
    assert "starters" not in schema["required"]
    assert schema["properties"]["starters"] == {
        "default": [], "items": {"type": "string"}, "title": "Starters", "type": "array"}


AS_OF = "2026-11-02T12:04:00-08:00"   # a Monday in the business's time zone, on the kernel's clock
MIDNIGHT = "2026-11-03T00:00:00-08:00"   # the next local midnight
OPEN_STATUSES = (   # open until a time, open all week, closed until later today, closed until tomorrow
    {"open": True, "until": "2026-11-02T18:00:00-08:00", "opens_at": None, "text": "Open now, until 6:00 pm",
     "refresh_at": "2026-11-02T18:00:00-08:00"},
    {"open": True, "until": None, "opens_at": None, "text": "Abierto ahora", "refresh_at": MIDNIGHT},
    {"open": False, "until": None, "opens_at": "2026-11-02T13:00:00-08:00", "text": "Closed now. Opens today at 1:00 pm",
     "refresh_at": "2026-11-02T13:00:00-08:00"},
    {"open": False, "until": None, "opens_at": "2026-11-03T08:00:00-08:00", "text": "Cerrado ahora. Abre mañana a las 8:00",
     "refresh_at": MIDNIGHT},
)


def test_open_status_shapes_validate():
    for status in OPEN_STATUSES:
        desk = PublicDesk.model_validate_json(json.dumps(PUBLIC_DESK | {"open_status": status | {"as_of": AS_OF}}))
        assert desk.open_status == OpenStatus.model_validate_json(json.dumps(status | {"as_of": AS_OF}))
        assert desk.open_status.as_of.utcoffset().total_seconds() == -8 * 3600
    with pytest.raises(ValidationError) as missing:   # until and opens_at are always sent, null when they don't apply
        OpenStatus.model_validate_json(json.dumps({"open": True, "text": "Open now", "as_of": AS_OF, "refresh_at": MIDNIGHT}))
    assert {error["loc"] for error in missing.value.errors()} == {("until",), ("opens_at",)}


def test_open_status_times_carry_their_offset():
    # the kernel works in the business's time zone; a time without its offset would leave the web to guess one
    for status in OPEN_STATUSES:
        valid = status | {"as_of": AS_OF}
        for field in ("until", "opens_at", "as_of", "refresh_at"):
            if valid[field] is not None:
                with pytest.raises(ValidationError) as naive:
                    OpenStatus.model_validate_json(json.dumps(valid | {field: valid[field].removesuffix("-08:00")}))
                assert [(error["loc"], error["type"]) for error in naive.value.errors()] == [((field,), "timezone_aware")]


def test_open_status_names_only_its_own_boundary():
    # each state carries only its own boundary, a closed one always (no hours means no status), and it is after as_of:
    # windows end exclusive, so a business open until now is closed
    open_until = OPEN_STATUSES[0] | {"as_of": AS_OF}
    closed_until = OPEN_STATUSES[2] | {"as_of": AS_OF}
    assert OpenStatus.model_validate_json(json.dumps(open_until | {"until": "2026-11-03T02:00:00Z"})).until.hour == 2
    for wrong, reason in (
        (open_until | {"opens_at": "2026-11-03T08:00:00-08:00"}, "names only until"),   # open, with a next opening
        (closed_until | {"until": "2026-11-02T18:00:00-08:00"}, "names only until"),    # closed, with an end of window
        (closed_until | {"opens_at": None}, "a closed status names when it opens"),
        (open_until | {"until": AS_OF}, "the boundary is after as_of"),
        (open_until | {"until": "2026-11-02T20:04:00Z"}, "the boundary is after as_of"),   # as_of's instant, in UTC
        (closed_until | {"opens_at": "2026-11-02T11:00:00-08:00"}, "the boundary is after as_of"),
    ):
        with pytest.raises(ValidationError, match=reason):
            OpenStatus.model_validate_json(json.dumps(wrong))


def test_open_status_names_when_to_refresh():
    # the next moment the text may change: the boundary or the next local midnight, whichever comes first, so "today"
    # and "tomorrow" stay true; the web's one refetch is then, so it is after as_of and at most 25 hours away
    open_until = OPEN_STATUSES[0] | {"as_of": AS_OF}
    status = OpenStatus.model_validate_json(json.dumps(open_until))
    assert status.refresh_at == status.until
    fall_back = {"open": True, "until": None, "opens_at": None, "text": "Open now",   # 2026-11-01 lasts 25 hours
                 "as_of": "2026-11-01T00:00:00-07:00", "refresh_at": "2026-11-02T00:00:00-08:00"}
    OpenStatus.model_validate_json(json.dumps(fall_back))
    for wrong, reason in (
        (open_until | {"refresh_at": AS_OF}, "refresh_at is after as_of"),
        (open_until | {"refresh_at": "2026-11-02T18:00:01-08:00"}, "refresh_at is at or before the boundary"),
        (fall_back | {"refresh_at": "2026-11-02T00:00:01-08:00"}, "refresh_at is at most 25 hours after as_of"),
    ):
        with pytest.raises(ValidationError, match=reason):
            OpenStatus.model_validate_json(json.dumps(wrong))
    with pytest.raises(ValidationError) as missing:
        OpenStatus.model_validate_json(json.dumps({key: value for key, value in open_until.items() if key != "refresh_at"}))
    assert [error["loc"] for error in missing.value.errors()] == [("refresh_at",)]


def test_open_status_refreshes_within_25_hours_on_a_longer_day():
    # Troll's clocks go back two hours on 2026-10-25, so that local day lasts 26 hours: refresh_at is the earliest of
    # the boundary, the next local midnight and as_of + 25 hours, which is still the same local date
    troll = ZoneInfo("Antarctica/Troll")
    as_of, next_midnight = datetime(2026, 10, 25, tzinfo=troll), datetime(2026, 10, 26, tzinfo=troll)
    assert next_midnight.astimezone(UTC) - as_of.astimezone(UTC) == timedelta(hours=26)
    open_all_week = {"open": True, "until": None, "opens_at": None, "text": "Open now", "as_of": as_of}
    status = OpenStatus(**open_all_week, refresh_at=as_of.astimezone(UTC) + timedelta(hours=25))
    assert status.refresh_at.astimezone(troll).date() == as_of.date()
    with pytest.raises(ValidationError, match="refresh_at is at most 25 hours after as_of"):
        OpenStatus(**open_all_week, refresh_at=next_midnight)


def test_open_status_compares_instants_across_the_fold():
    # 01:00-02:00 happens twice in Los Angeles on 2026-11-01, and Python compares and subtracts two times that share a
    # ZoneInfo by wall clock, ignoring fold, so the kernel's own local times are compared as instants
    la = ZoneInfo("America/Los_Angeles")
    pdt = datetime(2026, 11, 1, 1, 30, tzinfo=la)           # 08:30Z
    pst = datetime(2026, 11, 1, 1, 15, fold=1, tzinfo=la)   # 09:15Z, 45 minutes later
    assert pst - pdt == timedelta(minutes=-15)              # wall-clock arithmetic
    assert (pdt.utcoffset(), pst.utcoffset()) == (timedelta(hours=-7), timedelta(hours=-8))
    early, empty = datetime(2026, 11, 1, 0, 30, tzinfo=la), {"until": None, "opens_at": None}
    for open_, boundary in ((True, "until"), (False, "opens_at")):
        OpenStatus(open=open_, **empty | {boundary: pst}, text="x", as_of=pdt, refresh_at=pst)   # a future boundary
        with pytest.raises(ValidationError, match="the boundary is after as_of"):                 # a past one
            OpenStatus(open=open_, **empty | {boundary: pdt}, text="x", as_of=pst, refresh_at=pst + timedelta(hours=1))
        with pytest.raises(ValidationError, match="refresh_at is at or before the boundary"):
            OpenStatus(open=open_, **empty | {boundary: pdt}, text="x", as_of=early, refresh_at=pst)
    OpenStatus(open=True, **empty, text="x", as_of=pdt, refresh_at=pst)
    with pytest.raises(ValidationError, match="refresh_at is after as_of"):
        OpenStatus(open=True, **empty, text="x", as_of=pst, refresh_at=pdt)
    midnight = datetime(2026, 11, 1, tzinfo=la)             # 07:00Z; the next local midnight is 25 hours later
    OpenStatus(open=True, **empty, text="x", as_of=midnight, refresh_at=datetime(2026, 11, 2, tzinfo=la))
    with pytest.raises(ValidationError, match="refresh_at is at most 25 hours after as_of"):   # 25:30, 24:30 by wall clock
        OpenStatus(open=True, **empty, text="x", as_of=midnight, refresh_at=datetime(2026, 11, 2, 0, 30, tzinfo=la))


def test_a_copy_replays_the_recorded_night_only_when_asked():
    assert set(CreateCopyRequest.model_fields) == {"replay_night"}
    assert CreateCopyRequest().replay_night is False
    assert CreateCopyRequest.model_validate({}).replay_night is False      # an empty body still makes a live copy
    assert CreateCopyRequest(replay_night=True).model_dump() == {"replay_night": True}
    assert "replay_night" not in export_schema()["$defs"]["CreateCopyRequest"].get("required", [])


def test_replayed_events_carry_the_kernels_signed_records():
    assert list(ReplayedEvent.model_fields) == ["session_id", "shown_at", "kind", "text", "verdict", "decision", "author"]
    assert export_schema()["$defs"]["ReplayedEvent"]["required"] == [
        name for name in ReplayedEvent.model_fields if name != "author"]   # nulls explicit; author defaults
    assert get_args(ReplayedEvent.model_fields["kind"].annotation) == ("visitor_message", "reply", "receipt")
    assert ReplayedEvent.model_fields["verdict"].annotation == ReplyVerdict | None
    assert ReplayedEvent.model_fields["decision"].annotation == Decision | None
    shown_at = "2026-10-28T23:41:07.250000Z"
    said = ReplayedEvent(session_id="s1", shown_at=shown_at, kind="visitor_message", text="Anyone there tonight?",
                         verdict=None, decision=None)
    verdict = ReplyVerdict(ok=True, language="en", blocks=[RenderedBlock(kind="prose", text="Yes, I can help.")],
                           violations=[], message_id="m1", generation=0, visitor_plain="Replied", ledger_seq=4,
                           signature="sig-v")
    reply = ReplayedEvent(session_id="s1", shown_at=shown_at, kind="reply", text=None, verdict=verdict, decision=None)
    decision = Decision(decision_id="d1", session_id="s1", call_id="c1", action=None, outcome="refuse", state="refused",
                        policy_version=1, policy_ids=[], card_ids=[], reason_plain="Refused", visitor_plain="Not here",
                        expires_at=datetime(2026, 10, 29, 6, 41, 7, tzinfo=UTC), ledger_seq=5, signature="sig-d")
    receipt = ReplayedEvent(session_id="s1", shown_at=shown_at, kind="receipt", text=None, verdict=None,
                            decision=decision)
    for event in (said, reply, receipt):                    # the kernel's signed fields arrive unchanged
        assert ReplayedEvent.model_validate_json(event.model_dump_json()) == event
        assert event.author == "claude"
    desk_reply = ReplayedEvent.model_validate(reply.model_dump() | {"author": "desk"})
    assert desk_reply.author == "desk"
    assert ReplayedEvent.model_validate_json(desk_reply.model_dump_json()) == desk_reply
    for event in (said, receipt):
        with pytest.raises(ValidationError, match="only a replayed reply"):
            ReplayedEvent.model_validate(event.model_dump() | {"author": "desk"})
    with pytest.raises(ValidationError):
        ReplayedEvent.model_validate(reply.model_dump() | {"author": "owner"})
    with pytest.raises(ValidationError):                    # shown_at is a SignedTime, not any timestamp
        ReplayedEvent(session_id="s1", shown_at="2026-10-28T23:41:07+00:00", kind="visitor_message", text="Hi",
                      verdict=None, decision=None)
    with pytest.raises(ValidationError):                    # three kinds only
        ReplayedEvent(session_id="s1", shown_at=shown_at, kind="whisper", text="Hi", verdict=None, decision=None)


def test_replayed_persona_words_are_marked_untrusted():
    # the shared contract says what a replayed visitor_message's text is: words to quote, never instructions
    source = inspect.getsource(ReplayedEvent)
    assert re.search(r"^ +text: str \| None +# visitor_message only: the persona's words \(untrusted text\)$",
                     source, re.MULTILINE), source


def test_a_copy_without_a_replay_carries_nothing_replayed():
    owner = SessionState(session_id="s1", kind="owner", verified=True, assurance="owner_session", mode="ai",
                         generation=0)
    copy = CopyCreated(copy_id="c1", desk_ids=["d1"], owner_session=owner, owner_token="t")
    assert copy.replayed_messages == [] and copy.replay_id is None
    assert list(CopyCreated.model_fields)[-2:] == ["replayed_messages", "replay_id"]
    assert CopyCreated.model_fields["replayed_messages"].annotation == list[ReplayedEvent]
    assert CopyCreated.model_fields["replay_id"].annotation == str | None
    # a kernel that sends neither field still answers a valid copy, with live data only
    assert not {"replayed_messages", "replay_id"} & set(export_schema()["$defs"]["CopyCreated"]["required"])


def test_schema_export_marks_the_fields_a_model_leaves_out_while_they_hold_their_default():
    # A turn end's generation and a hand-back's resume fields are sent only when they say something, so the web's
    # check of the mock's payloads (which takes every other field as always sent) may find them missing.
    from desk import events
    from scripts.export_openapi import export_openapi

    left_out = {(model.__name__, name) for model in vars(events).values()
                if isinstance(model, type) and issubclass(model, BaseModel) and model.__module__ == events.__name__
                for name, field in model.model_fields.items() if field.exclude_if is not None}
    assert left_out == {("EvTurnEnd", "generation"), ("EvOwnerLeft", "resuming"), ("EvOwnerLeft", "generation")}
    # Marked so in both exports, wherever the model is in them (the API's document has no turn end).
    for defs in (export_schema()["$defs"], export_openapi()["components"]["schemas"]):
        marked = {(name, field) for name, model in defs.items()
                  for field, prop in (model.get("properties") or {}).items() if prop.get("x-omitted-when-default")}
        assert marked == {(name, field) for name, field in left_out if name in defs}
        assert ("EvOwnerLeft", "resuming") in marked
    # Each one also as the model sends it: left out while it holds its default.
    from desk.events import EvOwnerLeft, EvTurnEnd
    assert EvTurnEnd(type="turn_end").model_dump(mode="json") == {"type": "turn_end"}
    assert EvOwnerLeft(type="owner_left").model_dump(mode="json") == {"type": "owner_left"}
    assert EvOwnerLeft(type="owner_left", resuming=True, generation=3).model_dump(mode="json") == {
        "type": "owner_left", "resuming": True, "generation": 3}


def test_schema_export_is_current():
    assert export_schema() == json.loads(Path("desk/contracts.schema.json").read_text())


def test_knowledge_sources_share_one_contract_type():
    from desk.contracts import KnowledgeItem, KnowledgeSource
    from desk.api.schemas import KnowledgeRow

    assert get_args(KnowledgeSource) == ("website", "upload", "setup", "memory_import", "web_search")
    assert KnowledgeItem.model_fields["source"].annotation is KnowledgeSource
    assert KnowledgeRow.model_fields["source"].annotation is KnowledgeSource
