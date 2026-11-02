"""A booking needs a name and a way to reach the person (#740): a verified session, a lead the session
saved with a name and a phone number or email, or the booking's own `name` and `contact`. Anything
less is refused at step 1 (`contact_needed`), with a status line Claude can act on. The booking's
name, contact and address are untrusted text kept for the owner alone."""

import json

import pytest
from sqlalchemy import select

from desk.contracts import RuleCard
from desk.db.models import Booking, DemoInboxEntry, Document, Fact
from desk.kernel_service import adapters, render
from desk.kernel_service.adapters.base import claudes_note

from .helpers import kernel_ctx, ledger_rows, rows_of, save_lead, verify_session
from .test_approvals import add_person
from .test_context import context_of
from .test_decide import decided
from .test_execute import executed, read
from .test_typed_booking import SLOT, TOOL, configured

CONTACT_NEEDED = {"en": "To book, I need your name and a phone number or email",
                  "es": "Para reservar, necesito tu nombre y un teléfono o correo"}
DETAILS = {"name": "Jane Doe", "contact": "(510) 555-0123", "address": "12 Elm St, Oakland"}


def auto(tool: str) -> list[RuleCard]:
    return [RuleCard(card_id="book-auto", applies_to=tool, mode="auto", who="anyone", reason="Book times.")]


async def decide_checks(app, copy) -> list[tuple[str, str]]:
    """Each refused `decide` entry's reason and adapter check, in ledger order."""
    return [(entry.event.summary["reason"], entry.event.summary["check"]) for entry in await ledger_rows(app, copy)
            if entry.event.kind == "decide" and "check" in entry.event.summary]


def test_the_contact_needed_line_is_a_decision_status_line_in_both_languages():
    for lang, line in CONTACT_NEEDED.items():
        assert render.status("refused_contact_needed", lang, owner="Mike Turner") == line
    assert "refused_contact_needed" in render.DECISION_STATUS_KEYS


@pytest.mark.parametrize("tool", ["native.book", TOOL])
@pytest.mark.parametrize("args", [{}, {"name": "Jane Doe"}, {"contact": "jane@example.com"},
                                  {"name": "Jane Doe", "contact": "call me tomorrow"},
                                  {"name": "Jane Doe", "contact": "12345"},
                                  {"name": "Jane Doe", "address": "12 Elm St"}])
async def test_an_unverified_booking_without_a_name_and_contact_is_refused_contact_needed(app, client, tool, args):
    copy, visitor = await configured(app, client, cards=auto(tool), lead=False)
    decision = await decided(client, visitor, tool, {"slot_id": SLOT, **args})
    assert (decision.outcome, decision.state, decision.action) == ("refuse", "refused", None)
    assert decision.visitor_plain == CONTACT_NEEDED["en"]
    assert not await rows_of(app, copy.copy_id, select(Booking))
    assert await decide_checks(app, copy) == [("adapter_refused", "contact_needed")]


async def test_the_contact_needed_line_follows_the_visitors_language(app, client):
    copy, visitor = await configured(app, client, cards=auto("native.book"), lead=False)
    from .test_decide import set_session
    await set_session(app, copy, visitor.session_id, last_language="es")
    decision = await decided(client, visitor, "native.book", {"slot_id": SLOT})
    assert decision.visitor_plain == CONTACT_NEEDED["es"]


async def test_a_missing_slot_is_still_no_such_slot_before_any_contact_check(app, client):
    copy, visitor = await configured(app, client, cards=auto("native.book"), lead=False)
    decision = await decided(client, visitor, "native.book", {"slot_id": "S-20990101-0000"})
    assert decision.visitor_plain == "Not something I can do here"
    assert await decide_checks(app, copy) == [("adapter_refused", "no_such_slot")]


@pytest.mark.parametrize("tool", ["native.book", TOOL])
async def test_a_lead_with_a_name_and_contact_lets_the_session_book(app, client, tool):
    copy, visitor = await configured(app, client, cards=auto(tool), lead=False)
    await save_lead(app, copy, visitor.session_id)
    decision = await decided(client, visitor, tool, {"slot_id": SLOT})
    assert decision.outcome == "allow", decision
    assert (await executed(client, visitor, decision)).state == "succeeded"


@pytest.mark.parametrize("lead", [{"name": "Jane Doe", "contact": None}, {"name": "Jane Doe", "contact": "soon"},
                                  {"name": None, "contact": "jane@example.com"}])
async def test_a_lead_without_a_name_and_a_reachable_contact_doesnt_count(app, client, lead):
    copy, visitor = await configured(app, client, cards=auto("native.book"), lead=False)
    await save_lead(app, copy, visitor.session_id, **lead)
    decision = await decided(client, visitor, "native.book", {"slot_id": SLOT})
    assert (decision.outcome, decision.visitor_plain) == ("refuse", CONTACT_NEEDED["en"])


async def test_another_sessions_lead_doesnt_count(app, client):
    from .test_decide import open_visitor
    copy, visitor = await configured(app, client, cards=auto("native.book"), lead=False)
    other = await open_visitor(client, copy)
    await save_lead(app, copy, other.session_id)
    decision = await decided(client, visitor, "native.book", {"slot_id": SLOT})
    assert (decision.outcome, decision.visitor_plain) == ("refuse", CONTACT_NEEDED["en"])


@pytest.mark.parametrize("tool", ["native.book", TOOL])
async def test_a_verified_session_books_with_its_contact_on_record(app, client, tool):
    copy, visitor = await configured(app, client, cards=auto(tool), lead=False)
    person = await add_person(app, copy, "zoe", "Zoe Park")
    await verify_session(app, copy.copy_id, visitor.session_id, person)
    decision = await decided(client, visitor, tool, {"slot_id": SLOT})
    assert decision.outcome == "allow", decision
    assert (await executed(client, visitor, decision)).state == "succeeded"
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == "New booking"))
    assert alert.body.startswith("Zoe Park booked")
    assert "verified" not in alert.body


@pytest.mark.parametrize("tool", ["native.book", TOOL])
async def test_a_booking_with_a_name_and_contact_keeps_them_for_the_owner_alone(app, client, tool):
    copy, visitor = await configured(app, client, cards=auto(tool), lead=False)
    decision = await decided(client, visitor, tool, {"slot_id": SLOT, **DETAILS})
    assert decision.outcome == "allow", decision
    result = await executed(client, visitor, decision)
    assert result.state == "succeeded"
    booking_id = result.model_view["booking_id"]
    assert set(result.model_view) == {"fact_id", "booking_id", "status"}
    [saved] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.fact_id == f"booking_note:{booking_id}"))
    assert (saved.kind, saved.readers) == ("knowledge", ["owner"])
    assert {claim.key: claim.value for claim in saved.claims} == {"booking": booking_id, **DETAILS}
    [booking_fact] = result.facts
    assert not {"name", "contact", "address"} & {claim.key for claim in booking_fact.claims}
    seen = await context_of(client, visitor.session_id, visitor.headers)
    dumped = json.dumps([fact.model_dump(mode="json") for fact in seen.facts])
    assert all(value not in dumped for value in DETAILS.values())
    assert all(value not in result.model_dump_json() for value in DETAILS.values())
    receipt = (await read(client, visitor.headers, decision)).visitor_plain
    assert all(value not in receipt for value in DETAILS.values())
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == "New booking"))
    assert alert.body.startswith("A stranger booked ")
    assert alert.body.endswith(". " + claudes_note(DETAILS.values()) + ". The contact isn't verified.")


async def test_a_note_comes_after_the_details_in_the_owners_alert(app, client):
    copy, visitor = await configured(app, client, cards=auto("native.book"), lead=False)
    decision = await decided(client, visitor, "native.book", {"slot_id": SLOT, **DETAILS, "note": "Side gate."})
    result = await executed(client, visitor, decision)
    [saved] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.fact_id.like("booking_note:%")))
    assert {claim.key: claim.value for claim in saved.claims} == {
        "booking": result.model_view["booking_id"], **DETAILS, "note": "Side gate."}
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == "New booking"))
    assert alert.body.endswith(". " + claudes_note([*DETAILS.values(), "Side gate."]) + ". The contact isn't verified.")


@pytest.mark.parametrize("field", ["name", "contact", "address"])
async def test_a_canary_in_the_bookings_details_is_refused_before_any_action(app, client, field):
    copy, visitor = await configured(app, client, cards=auto("native.book"), lead=False)
    [document, *_] = await rows_of(app, copy.copy_id, select(Document))
    args = {**DETAILS, field: f"{DETAILS[field]} {document.canary}"}
    decision = await decided(client, visitor, "native.book", {"slot_id": SLOT, **args})
    assert (decision.outcome, decision.action) == ("refuse", None)
    assert await decide_checks(app, copy) == [("adapter_refused", "note_canary")]
    assert not await rows_of(app, copy.copy_id, select(Booking))


async def test_the_bookings_details_are_free_text_for_the_reviewer_and_owner(app, client):
    copy, _ = await configured(app, client, cards=auto("native.book"), lead=False)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        for tool in ("native.book", TOOL):
            adapter = await adapters.resolve(ctx, copy.desk_id, tool)
            assert adapter.free_text_fields == frozenset({"note", "name", "contact", "address"})
            schema = adapter.profile.input_schema["properties"]
            assert {"name", "contact", "address"} <= set(schema)
            assert "phone number or email" in adapter.profile.description_confirmed
