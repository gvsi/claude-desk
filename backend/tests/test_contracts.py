import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import get_args
from zoneinfo import ZoneInfo

import pytest
from pydantic import TypeAdapter, ValidationError

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
    DeskSeed,
    Effect,
    HoursWindow,
    Label,
    LedgerEntry,
    MCP_TOOLS,
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
    ToolName,
)
from desk.events import EvDemoInbox, EvError, EvHeld, SseEvent
from desk.kernel_api import (
    KERNEL_REQUESTS,
    KERNEL_RESPONSES,
    KERNEL_ROUTES,
    CreateSessionRequest,
    DeskUpdated,
    ExecuteRequest,
    DecideRequest,
    KernelError,
    LedgerAppendRequest,
    OpenStatus,
    PublicDesk,
    ToolsConfirmRequest,
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
    assert CreateSessionRequest(desk_slug="rivera-plumbing-abc123", kind="visitor").preview is False
    assert CreateSessionRequest(desk_slug="rivera-plumbing-abc123", kind="visitor", preview=True).preview is True
    with pytest.raises(ValidationError):          # a preview is the owner acting as a visitor, never an agent: 422 invalid
        CreateSessionRequest(desk_slug="rivera-plumbing-abc123", kind="agent", preview=True)


def test_kernel_error_codes_include_rate_limited():
    # 429 (POST /agents/demo) has its own code, so a refused tool call is told apart from a bad request
    assert KernelError(code="rate_limited").code == "rate_limited"
    assert set(get_args(KernelError.model_fields["code"].annotation)) == {
        "auth", "not_found", "closed", "stale_generation", "mode_owner", "mode_paused", "replayed", "conflict",
        "invalid", "rate_limited", "seed_unproved", "internal"}


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


def test_enabling_an_mcp_tool_names_the_reviewed_definition():
    # the pin review: the owner's confirm names the exact definition hash they saw, so the kernel
    # compares it with the current listing and never enables a definition nobody reviewed
    assert MCP_TOOLS == {tool for tool in get_args(ToolName) if not tool.startswith("native.")}
    reviewed = "a" * 64
    for tool in sorted(MCP_TOOLS):
        assert ToolsConfirmRequest(desk_id="d", tool=tool, enable=True, definition_sha256=reviewed)
        assert ToolsConfirmRequest(desk_id="d", tool=tool, enable=False).definition_sha256 is None
        for missing in ({}, {"definition_sha256": None}, {"definition_sha256": ""}, {"definition_sha256": "A" * 64}):
            with pytest.raises(ValidationError):
                ToolsConfirmRequest(desk_id="d", tool=tool, enable=True, **missing)
    # native tools have no definition to pin, so naming one is a caller bug
    assert ToolsConfirmRequest(desk_id="d", tool="native.book", enable=True).definition_sha256 is None
    with pytest.raises(ValidationError):
        ToolsConfirmRequest(desk_id="d", tool="native.book", enable=True, definition_sha256=reviewed)


PUBLIC_DESK = {"business_name": "Rivera Plumbing", "desk_name": "Main line", "owner_display_name": "Maria Rivera",
               "brand": {}, "charter": [], "agent_card": []}


def test_public_desk_open_status_is_optional():
    # a Desk without charter:hours has no open status, and a kernel that doesn't fill it yet still validates
    assert PublicDesk.model_validate_json(json.dumps(PUBLIC_DESK)).open_status is None
    assert PublicDesk.model_validate_json(json.dumps(PUBLIC_DESK | {"open_status": None})).open_status is None
    assert "open_status" not in export_schema()["$defs"]["PublicDesk"]["required"]   # optional in the web's types too


AS_OF = "2026-11-02T12:04:00-08:00"   # a Monday in the business's time zone, on the kernel's clock
MIDNIGHT = "2026-11-03T00:00:00-08:00"   # the next local midnight
OPEN_STATUSES = (   # open until a time, open all week, closed until a time, closed with no window within 7 days
    {"open": True, "until": "2026-11-02T18:00:00-08:00", "opens_at": None, "text": "Open now, until 6:00 pm",
     "refresh_at": "2026-11-02T18:00:00-08:00"},
    {"open": True, "until": None, "opens_at": None, "text": "Abierto ahora", "refresh_at": MIDNIGHT},
    {"open": False, "until": None, "opens_at": "2026-11-02T13:00:00-08:00", "text": "Closed now. Opens today at 1:00 pm",
     "refresh_at": "2026-11-02T13:00:00-08:00"},
    {"open": False, "until": None, "opens_at": None, "text": "Cerrado ahora", "refresh_at": MIDNIGHT},
)


def test_open_status_shapes_validate():
    for status in OPEN_STATUSES:
        desk = PublicDesk.model_validate_json(json.dumps(PUBLIC_DESK | {"open_status": status | {"as_of": AS_OF}}))
        assert desk.open_status == OpenStatus.model_validate_json(json.dumps(status | {"as_of": AS_OF}))
        assert desk.open_status.as_of.utcoffset().total_seconds() == -8 * 3600
    with pytest.raises(ValidationError):   # until and opens_at are always sent, null when they don't apply
        OpenStatus.model_validate_json(json.dumps({"open": True, "text": "Open now", "as_of": AS_OF}))


def test_open_status_times_carry_their_offset():
    # the kernel works in the business's time zone; a time without its offset would leave the web to guess one
    for status in OPEN_STATUSES:
        valid = status | {"as_of": AS_OF}
        for field in ("until", "opens_at", "as_of"):
            if valid[field] is not None:
                with pytest.raises(ValidationError):
                    OpenStatus.model_validate_json(json.dumps(valid | {field: valid[field].removesuffix("-08:00")}))


def test_open_status_names_only_its_own_boundary():
    # the web schedules one refetch at the boundary that applies, so each state carries only its own, and it is
    # after as_of: windows end exclusive, so a business open until now is closed, and a past boundary would loop
    open_until = OPEN_STATUSES[0] | {"as_of": AS_OF}
    closed_until = OPEN_STATUSES[2] | {"as_of": AS_OF}
    assert OpenStatus.model_validate_json(json.dumps(open_until | {"until": "2026-11-03T02:00:00Z"})).until.hour == 2
    for wrong in (
        open_until | {"opens_at": "2026-11-03T08:00:00-08:00"},   # open, with a next opening
        closed_until | {"until": "2026-11-02T18:00:00-08:00"},    # closed, with an end of window
        open_until | {"until": AS_OF},
        open_until | {"until": "2026-11-02T20:04:00Z"},           # the same instant as as_of, in UTC
        closed_until | {"opens_at": "2026-11-02T11:00:00-08:00"},
    ):
        with pytest.raises(ValidationError):
            OpenStatus.model_validate_json(json.dumps(wrong))


def test_open_status_names_when_to_refresh():
    # the next moment the text may change: the boundary or the next local midnight, whichever comes first, so "today"
    # and "tomorrow" stay true; the web's one refetch is then, so it is after as_of and at most a 25-hour day away
    open_until = OPEN_STATUSES[0] | {"as_of": AS_OF}
    status = OpenStatus.model_validate_json(json.dumps(open_until))
    assert status.refresh_at == status.until
    fall_back = {"open": True, "until": None, "opens_at": None, "text": "Open now",   # 2026-11-01 lasts 25 hours
                 "as_of": "2026-11-01T00:00:00-07:00", "refresh_at": "2026-11-02T00:00:00-08:00"}
    OpenStatus.model_validate_json(json.dumps(fall_back))
    for wrong in (
        open_until | {"refresh_at": AS_OF},
        open_until | {"refresh_at": "2026-11-02T18:00:01-08:00"},   # after the boundary
        fall_back | {"refresh_at": "2026-11-02T00:00:01-08:00"},    # more than 25 hours away
        {key: value for key, value in open_until.items() if key != "refresh_at"},
    ):
        with pytest.raises(ValidationError):
            OpenStatus.model_validate_json(json.dumps(wrong))


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
        with pytest.raises(ValidationError):                                                    # a past one
            OpenStatus(open=open_, **empty | {boundary: pdt}, text="x", as_of=pst, refresh_at=pst + timedelta(hours=1))
        with pytest.raises(ValidationError):                                                    # a refresh after it
            OpenStatus(open=open_, **empty | {boundary: pdt}, text="x", as_of=early, refresh_at=pst)
    OpenStatus(open=True, **empty, text="x", as_of=pdt, refresh_at=pst)
    with pytest.raises(ValidationError):
        OpenStatus(open=True, **empty, text="x", as_of=pst, refresh_at=pdt)
    midnight = datetime(2026, 11, 1, tzinfo=la)             # 07:00Z; the next local midnight is 25 hours later
    OpenStatus(open=True, **empty, text="x", as_of=midnight, refresh_at=datetime(2026, 11, 2, tzinfo=la))
    with pytest.raises(ValidationError):                    # 25 hours 30 minutes, though only 24:30 by wall clock
        OpenStatus(open=True, **empty, text="x", as_of=midnight, refresh_at=datetime(2026, 11, 2, 0, 30, tzinfo=la))


def test_schema_export_is_current():
    assert export_schema() == json.loads(Path("desk/contracts.schema.json").read_text())
