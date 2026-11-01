"""Owner writes to Desks, people and documents, and the owner's preview session.

The owner creates a Desk in its copy (`POST /desks`, the starter preset active from its shipped
report), replaces its parts (`PUT /desks/{id}/{part}`), adds and removes people, uploads
documents (`POST /documents`) and deletes it (`DELETE /desks/{id}`); every write goes on the
Desk's ledger as a `desk_data` entry that names what changed and never a contact or a body. A
removed person is no longer on record, a person given another contact keeps none of the
sessions verified at the old one, and a deleted Desk's sessions close while its ledger stays.
Tests run on Rivera Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland).
"""

import asyncio
import json
import re
from datetime import time

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import (ApprovalResult, BusinessSeed, CalendarSlot, Claim, DemoInboxEntry, DeskSeed, HoursWindow,
                            NotificationDefaults, PriceItem, SeedDocument, SeedPerson, SessionCreated)
from desk.db.models import (ActorSession, Booking, Business, Desk, Document, Execution, Fact, LedgerEntry, NotificationPref,
                             Person, PolicyVersion, Quote, Tool, VerificationChallenge)
from desk.db.models import CalendarSlot as SlotRow
from desk.db.models import Decision as DecisionRow
from desk.db.models import DemoInboxEntry as InboxRow
from desk.db.models import PriceItem as PriceRow
from desk.kernel_api import DeskCreated, DeskUpdated, DocumentCreated, PublicDesk
from desk.kernel_service import activation, adapters, auth, desks, verification
from desk.presets import PRESETS

from .helpers import active_version_number, connections_of, rows_of, until_waiting
from .test_adapters import Rivera, book, rivera, visitor_of
from .test_context import context_of, get_context, tools
from .test_decide import PASS, Visitor, decided, open_visitor
from .test_execute import post_execute
from .test_verification import api_rows, check, code_in, entry_of, started

LOPEZ_BUSINESS = BusinessSeed(name="Lopez Electric", owner_display_name="Ana Lopez", timezone="America/Chicago")
LOPEZ_DESK = DeskSeed(
    name="Main line",
    charter=[Claim(key="contact", kind="text", value="(312) 555-0110")],
    hours=[HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(9), end=time(17))],
    price_items=[PriceItem(item_id="visit", title="Service visit", unit_cents=9_500)],
    calendar_slots=[],
    people=[SeedPerson(ref="kim", display_name="Kim Park", contact="kim@example.com")],
    documents=[SeedDocument(ref="kim-estimate", title="Estimate, panel upgrade", record_owner_ref="kim",
                            body="Lopez Electric\nEstimate for Kim Park\nPanel upgrade: $2,400.00")],
    notifications=NotificationDefaults(now=["approval"], briefing=["lead", "callback"]),
)


def new_desk(business: BusinessSeed = LOPEZ_BUSINESS, desk: DeskSeed = LOPEZ_DESK, **business_fields) -> dict:
    """A `POST /desks` body: Lopez Electric's Desk, its business changed by `business_fields`."""
    return {"business": business.model_copy(update=business_fields).model_dump(mode="json"),
            "desk": desk.model_dump(mode="json")}


async def post_desk(client: httpx.AsyncClient, copy: Rivera, body: dict) -> httpx.Response:
    return await client.post("/desks", headers=copy.owner, json=body)


def slot_body(slot: SlotRow) -> dict:
    return {"slot_id": slot.slot_id, "starts_at": slot.starts_at.isoformat(), "minutes": slot.minutes}


async def desks_of(app: FastAPI, copy: Rivera) -> dict[str, Desk]:
    return {desk.desk_id: desk for desk in await rows_of(app, copy.copy_id, select(Desk))}


async def test_owner_creates_a_desk_in_its_copy(app, client):
    copy, other = await rivera(app, client), await rivera(app, client)
    response = await post_desk(client, copy, new_desk())
    assert response.status_code == 200, response.text
    created = DeskCreated.model_validate(response.json())
    assert re.fullmatch(r"lopez-electric-[a-z0-9]{6}", created.slug)
    desk = (await desks_of(app, copy))[created.desk_id]
    [business] = await rows_of(app, copy.copy_id, select(Business).where(Business.business_id == desk.business_id))
    assert (business.name, business.owner_display_name, business.timezone) == (
        "Lopez Electric", "Ana Lopez", "America/Chicago")
    assert (desk.slug, desk.name, desk.answering, desk.deleted_at) == (created.slug, "Main line", False, None)
    # native tools only, every registered one enabled; MCP tools come through a pinned connect
    tools = await rows_of(app, copy.copy_id, select(Tool).where(Tool.desk_id == created.desk_id))
    assert {tool.source for tool in tools} == {"native"}
    assert sorted(tool.tool for tool in tools) == [p.tool for p in adapters.registered_profiles(source="native")]
    response = await client.get("/whoami", headers=copy.owner)
    assert sorted(response.json()["desk_ids"]) == sorted([copy.desk_id, created.desk_id])   # created at one instant
    entries = await rows_of(app, copy.copy_id, select(LedgerEntry).where(LedgerEntry.desk_id == created.desk_id)
                            .order_by(LedgerEntry.seq))
    assert [(e.event.kind, e.event.summary) for e in entries] == [
        ("desk_data", {"part": "desk", "created": True}),
        ("policy", {"version": 1, "status": "active", "preset": "ask_first", "activated": True, "from": None,
                    "auto_money_cap_cents": 0})]

    # a second Desk for Rivera Plumbing itself, named after the stored business
    [rivera_business] = await rows_of(app, copy.copy_id, select(Business).where(Business.name == "Rivera Plumbing"))
    response = await post_desk(client, copy, new_desk(name="Ignored", existing_business_id=rivera_business.business_id))
    assert response.status_code == 200, response.text
    second = DeskCreated.model_validate(response.json())
    assert re.fullmatch(r"rivera-plumbing-[a-z0-9]{6}", second.slug)
    assert (await desks_of(app, copy))[second.desk_id].business_id == rivera_business.business_id

    # another copy's business isn't found; connections come through /tools/connect; neither writes anything
    [others] = await rows_of(app, other.copy_id, select(Business))
    response = await post_desk(client, copy, new_desk(existing_business_id=others.business_id))
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    connected = new_desk()
    connected["desk"]["connections"] = ["mock_payments"]
    response = await post_desk(client, copy, connected)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert set(await desks_of(app, copy)) == {copy.desk_id, created.desk_id, second.desk_id}
    assert len(await rows_of(app, copy.copy_id, select(Business))) == 2
    assert len(await rows_of(app, copy.copy_id, select(PolicyVersion))) == 3

    # only the owner's credential creates a Desk
    visitor = await open_visitor(client, copy)
    for headers in ({}, visitor.headers, {**copy.owner, **visitor.headers}):
        response = await client.post("/desks", headers=headers, json=new_desk())
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    assert len(await desks_of(app, copy)) == 3


async def test_new_desk_activates_the_starter_preset_in_either_mode(app, client, monkeypatch):
    copy = await rivera(app, client)
    for mode in ("symcc", "bounded"):          # a shipped report activates whatever the process can prove
        monkeypatch.setattr(activation, "_proof_mode", mode)
        app.state.proof_mode = mode
        assert (await client.get("/health")).json()["proof_mode"] == mode
        response = await post_desk(client, copy, new_desk())
        assert response.status_code == 200, (mode, response.text)
        desk_id = response.json()["desk_id"]
        [version] = await rows_of(app, copy.copy_id, select(PolicyVersion).where(PolicyVersion.desk_id == desk_id))
        assert (version.version, version.status, version.preset, version.parent_version) == (
            1, "active", "ask_first", None), mode
        owned = sorted((card for card in version.cards if not card.is_default), key=lambda card: card.card_id)
        assert owned == sorted(PRESETS["ask_first"], key=lambda card: card.card_id), mode
        assert activation.proved(version.proof), mode       # the shipped SymCC report, not a run here
        assert api_rows(copy.copy_id, "SELECT version, status FROM kernel_ro.policy_versions"
                                      f" WHERE desk_id = '{desk_id}'") == [(1, "active")]
        assert await active_version_number(client, copy.owner_token, desk_id) == 1


async def test_an_uncached_preset_is_503(app, client, monkeypatch):
    copy = await rivera(app, client)
    shipped = activation.version_hashes

    def unproved(*args, **kwargs):            # the preset's tools changed since its report was proved
        return shipped(*args, **kwargs)._replace(profiles_sha256="0" * 64)

    monkeypatch.setattr(activation, "version_hashes", unproved)
    response = await post_desk(client, copy, new_desk())
    assert (response.status_code, response.json()) == (503, {"code": "seed_unproved"})
    # nothing was created: no Desk, business, tools, version or ledger entry
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    assert [b.name for b in await rows_of(app, copy.copy_id, select(Business))] == ["Rivera Plumbing"]
    assert {t.desk_id for t in await rows_of(app, copy.copy_id, select(Tool))} == {copy.desk_id}
    assert {v.desk_id for v in await rows_of(app, copy.copy_id, select(PolicyVersion))} == {copy.desk_id}
    assert {e.desk_id for e in await rows_of(app, copy.copy_id, select(LedgerEntry))} == {copy.desk_id}
    assert (await client.get("/health")).json()["unproved_seeds"] == ["ask_first"]


async def put_part(client: httpx.AsyncClient, copy: Rivera, part: str, body: dict, *,
                   desk_id: str | None = None) -> httpx.Response:
    return await client.put(f"/desks/{desk_id or copy.desk_id}/{part}", headers=copy.owner, json=body)


async def updated(client: httpx.AsyncClient, copy: Rivera, part: str, body: dict) -> DeskUpdated:
    response = await put_part(client, copy, part, body)
    assert response.status_code == 200, (part, response.text)
    return DeskUpdated.model_validate(response.json())


async def entries_of(app: FastAPI, copy: Rivera, desk_id: str | None = None) -> list[LedgerEntry]:
    return await rows_of(app, copy.copy_id, select(LedgerEntry).where(
        LedgerEntry.desk_id == (desk_id or copy.desk_id)).order_by(LedgerEntry.seq))


async def facts_of(app: FastAPI, copy: Rivera, kind: str) -> dict[str, Fact]:
    rows = await rows_of(app, copy.copy_id, select(Fact).where(Fact.desk_id == copy.desk_id, Fact.kind == kind))
    return {row.fact_id: row for row in rows}


async def test_put_parts_replace_and_ledger(app, client, frozen_clock):
    copy = await rivera(app, client)
    [business] = await rows_of(app, copy.copy_id, select(Business))
    slots = await rows_of(app, copy.copy_id, select(SlotRow).order_by(SlotRow.slot_id))
    new_slot = {"slot_id": "S-20261116-0800", "starts_at": "2026-11-16T08:00:00-08:00", "minutes": 120}
    hours = [{"days": ["mon", "tue", "wed", "thu", "fri"], "start": "07:00:00", "end": "15:00:00"}]
    parts = [   # (part, body, refs in its desk_data entry)
        ("business", {"name": "Rivera Plumbing and Drains", "owner_display_name": "Maria Rivera",
                      "timezone": "America/Denver", "brand": {"primary": "#22524D"}}, [business.business_id]),
        ("charter", {"charter": [{"key": "contact", "kind": "text", "value": "(510) 555-0199"},
                                 {"key": "policy:service_area", "kind": "text", "value": "We work in Oakland."}]}, []),
        ("hours", {"hours": hours}, []),
        ("prices", {"price_items": [{"item_id": "deposit", "title": "Service call deposit", "unit_cents": 2_000},
                                    {"item_id": "drain", "title": "Drain clearing", "unit_cents": 19_000},
                                    {"item_id": "leak", "title": "Leak repair", "unit_cents": 25_000},
                                    {"item_id": "camera", "title": "Camera inspection", "unit_cents": 30_000}]},
         ["camera", "drain", "heater", "pipe", "short-notice"]),
        ("calendar", {"calendar_slots": [slot_body(slot) for slot in slots[1:]] + [new_slot]},
         sorted([slots[0].slot_id, new_slot["slot_id"]])),
        ("people", {"upsert": [{"ref": "eve", "display_name": "Eve Santos", "contact": "+1 (510) 555-0123"}]},
         ["eve"]),
        ("notifications", {"notifications": {"now": ["approval", "lead"], "briefing": ["callback"]}}, []),
        ("answering", {"on": False}, []),
    ]
    for part, body, refs in parts:
        before = len(await entries_of(app, copy))
        answer = await updated(client, copy, part, body)
        assert answer == DeskUpdated(desk_id=copy.desk_id, updated_at=frozen_clock.now()), part
        [entry] = (await entries_of(app, copy))[before:]
        assert (entry.event.kind, entry.event.summary) == ("desk_data", {"part": part, "refs": refs}), part

    [business] = await rows_of(app, copy.copy_id, select(Business))
    assert (business.name, business.owner_display_name, business.timezone, business.brand) == (
        "Rivera Plumbing and Drains", "Maria Rivera", "America/Denver", {"primary": "#22524D"})
    charter = await facts_of(app, copy, "charter")
    # the rest replaced, and the seed's starters kept, as the hours are
    assert set(charter) == {"charter:contact", "charter:policy:service_area", "charter:hours",
                            *(f"charter:starter:{n}:{lang}" for n in (1, 2, 3) for lang in ("en", "es"))}
    assert charter["charter:contact"].claims == [Claim(key="contact", kind="text", value="(510) 555-0199")]
    assert all(fact.readers == ["public"] and fact.source == "kernel" for fact in charter.values())
    prices = await rows_of(app, copy.copy_id, select(PriceRow).order_by(PriceRow.item_id))
    assert [(p.item_id, p.unit_cents) for p in prices] == [("camera", 30_000), ("deposit", 2_000), ("drain", 19_000),
                                                          ("leak", 25_000)]
    after = await rows_of(app, copy.copy_id, select(SlotRow).order_by(SlotRow.slot_id))
    assert [slot.slot_id for slot in after] == [slot.slot_id for slot in slots[1:]] + [new_slot["slot_id"]]
    assert api_rows(copy.copy_id, "SELECT display_name, masked_contact FROM kernel_ro.people"
                                  " WHERE display_name = 'Eve Santos'") == [("Eve Santos", "•••• 0123")]
    [prefs] = await rows_of(app, copy.copy_id, select(NotificationPref))
    assert (prefs.now, prefs.briefing) == (["approval", "lead"], ["callback"])
    desk = (await desks_of(app, copy))[copy.desk_id]
    assert desk.answering is False
    # no entry names a contact, and the chain still verifies
    page = (await client.get(f"/ledger/{copy.desk_id}", headers=copy.owner)).json()
    assert page["chain_ok"] is True
    summaries = json.dumps([entry["event"]["summary"] for entry in page["entries"]], ensure_ascii=False)
    # Eve's contact in no form; IDs and hashes may hold her digits by chance, never set apart as a number
    for form in ("+1 (510) 555-0123", "(510) 555-0123", "555-0123", "5105550123", "\u2022\u2022\u2022\u2022 0123"):
        assert form not in summaries, form
    assert re.search(r"(?<![0-9A-Za-z])(?:555|0123)(?![0-9A-Za-z])", summaries) is None


async def people_of(app: FastAPI, copy: Rivera) -> dict[str, Person]:
    return {person.ref: person for person in await rows_of(app, copy.copy_id, select(Person))}


async def refused_people(client: httpx.AsyncClient, app: FastAPI, copy: Rivera, body: dict, status: int,
                         code: str) -> None:
    """The people write is refused with `status` and `code`, and writes nothing."""
    before = ([(p.ref, p.display_name, p.contact, p.contact_norm, p.masked_contact, p.removed_at)
               for p in sorted((await people_of(app, copy)).values(), key=lambda p: p.ref)],
              len(await entries_of(app, copy)))
    response = await put_part(client, copy, "people", body)
    assert (response.status_code, response.json()) == (status, {"code": code}), body
    after = ([(p.ref, p.display_name, p.contact, p.contact_norm, p.masked_contact, p.removed_at)
              for p in sorted((await people_of(app, copy)).values(), key=lambda p: p.ref)],
             len(await entries_of(app, copy)))
    assert after == before, body


async def test_put_people_rejects_masked_contact_and_keeps_none(app, client):
    copy = await rivera(app, client)
    dana = (await people_of(app, copy))["dana"]
    # a contact as the owner app shows it is masked, never one a code could reach
    for masked in (dana.masked_contact, "d***@example.com", "•••• 0177", "(510) 555-01**"):
        await refused_people(client, app, copy, {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                             "contact": masked}]}, 422, "invalid")
    # None keeps the contact on record; a new person needs one
    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana W.", "contact": None,
                                                       "notes": "Prefers mornings"}]})
    kept = (await people_of(app, copy))["dana"]
    assert (kept.person_id, kept.display_name, kept.notes) == (dana.person_id, "Dana W.", "Prefers mornings")
    assert (kept.contact, kept.contact_norm, kept.masked_contact) == (dana.contact, dana.contact_norm,
                                                                      dana.masked_contact)
    await refused_people(client, app, copy, {"upsert": [{"ref": "eve", "display_name": "Eve Santos",
                                                         "contact": None}]}, 422, "invalid")

    # a changed contact cancels the code sent to the old one
    visitor = await open_visitor(client, copy)
    [notice] = (await started(client, visitor, "dana@example.com")).inbox
    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana W.",
                                                       "contact": " Dana.W@Example.com "}]})
    changed = (await people_of(app, copy))["dana"]
    assert (changed.contact, changed.contact_norm, changed.masked_contact) == (
        "Dana.W@Example.com", "dana.w@example.com", "d•••@example.com")
    [challenge] = await rows_of(app, copy.copy_id, select(VerificationChallenge))
    assert challenge.status == "cancelled"
    code = code_in(await entry_of(client, visitor, notice))
    assert (await check(client, visitor, code)).status_code == 422


async def test_people_contacts_are_unique_and_valid(app, client):
    copy = await rivera(app, client)

    def eve(**fields) -> dict:
        return {"upsert": [{"ref": "eve", "display_name": "Eve Santos", "contact": "eve@example.com"} | fields]}

    # one live person per contact on record, however it is written
    await refused_people(client, app, copy, eve(contact=" DANA@Example.com "), 409, "conflict")
    await refused_people(client, app, copy, {"upsert": [{"ref": "bob", "display_name": "Bob Okafor",
                                                         "contact": "dana@example.com"}]}, 409, "conflict")
    await refused_people(client, app, copy, {"upsert": [  # a swap in one write meets the other contact first
        {"ref": "dana", "display_name": "Dana Whitfield", "contact": "bob@example.com"},
        {"ref": "bob", "display_name": "Bob Okafor", "contact": "dana@example.com"}]}, 409, "conflict")
    # a contact is an email address or a phone number, at most 120 characters
    for contact in ("call the shop", "12345", "+1 555", "eve@example", "eve@exa mple.com", "eve@@example.com",
                    "e" * 109 + "@example.com", "eve\u0000@example.com", "(510) 555-0123 ext. 4"):
        await refused_people(client, app, copy, eve(contact=contact), 422, "invalid")
    # a ref goes on the ledger, so it is a plain identifier, once per write
    for ref in ("eve@example.com", "", "e v e", "eve:1", "e" * 65):
        await refused_people(client, app, copy, eve(ref=ref), 422, "invalid")
    await refused_people(client, app, copy, {"upsert": eve()["upsert"] * 2}, 422, "invalid")
    await refused_people(client, app, copy, {"upsert": eve()["upsert"], "remove": ["eve"]}, 422, "invalid")
    # these hold for a new Desk's people too
    twins = LOPEZ_DESK.model_copy(update={"people": [*LOPEZ_DESK.people, SeedPerson(
        ref="lee", display_name="Lee Park", contact="KIM@example.com")]})
    malformed = LOPEZ_DESK.model_copy(update={"people": [LOPEZ_DESK.people[0].model_copy(
        update={"contact": "k•••@example.com"})]})
    bad_ref = LOPEZ_DESK.model_copy(update={"people": [LOPEZ_DESK.people[0].model_copy(update={"ref": "kim@home"})],
                                            "documents": []})
    for desk, status, code in ((twins, 409, "conflict"), (malformed, 422, "invalid"), (bad_ref, 422, "invalid")):
        response = await post_desk(client, copy, new_desk(desk=desk))
        assert (response.status_code, response.json()) == (status, {"code": code}), desk.people
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    # a valid one is on record, masked everywhere but the kernel
    await updated(client, copy, "people", eve(contact="+44 20 7946 0958"))
    assert (await people_of(app, copy))["eve"].contact_norm == "+442079460958"
    assert api_rows(copy.copy_id, "SELECT masked_contact FROM kernel_ro.people WHERE display_name = 'Eve Santos'") == [
        ("•••• 0958",)]


@pytest.mark.parametrize("change", ["recontact", "remove"])
async def test_a_people_write_racing_a_start_sends_no_code(app, client, monkeypatch, change):
    """A start looks Dana up by the contact typed, then waits on her row. If the owner moves her to
    another contact or removes her meanwhile, the start finds her not on record: no code goes to
    the old contact, and no challenge is made."""
    copy = await rivera(app, client)
    dana = (await people_of(app, copy))["dana"]
    visitor = await open_visitor(client, copy)
    write = ({"upsert": [{"ref": "dana", "display_name": "Dana Whitfield", "contact": "whitfield@example.net"}]}
             if change == "recontact" else {"remove": ["dana"]})
    lock_people, raced = verification._lock_people, []

    async def owner_writes_first(ctx, person_ids):
        if not raced:                     # the owner's write commits before this start holds her row
            raced.append(await put_part(client, copy, "people", write))
        await lock_people(ctx, person_ids)

    monkeypatch.setattr(verification, "_lock_people", owner_writes_first)
    answer = await started(client, visitor, "dana@example.com")
    [response] = raced
    assert response.status_code == 200, response.text
    assert answer.inbox == []
    assert await rows_of(app, copy.copy_id, select(VerificationChallenge)) == []
    assert await rows_of(app, copy.copy_id, select(InboxRow).where(InboxRow.person_id == dana.person_id)) == []
    [summary] = [e.event.summary for e in await entries_of(app, copy)
                 if e.event.kind == "verify" and e.event.session_id == visitor.session_id]
    assert summary == {"outcome": "not_on_record"}
    if change == "recontact":             # she is on record at the contact the owner gave her
        [notice] = (await started(client, visitor, "whitfield@example.net")).inbox
        assert notice.to == "w•••@example.net"


async def entry_of_owner(client: httpx.AsyncClient, copy: Rivera, notice) -> DemoInboxEntry:
    """The Demo inbox entry a notice announced, as the owner reads it."""
    response = await client.get("/demo_inbox", headers=copy.owner)
    [entry] = [DemoInboxEntry.model_validate(e) for e in response.json() if e["entry_id"] == notice.entry_id]
    return entry


async def verified_as(client: httpx.AsyncClient, visitor: Visitor, contact: str) -> None:
    [notice] = (await started(client, visitor, contact)).inbox
    response = await check(client, visitor, code_in(await entry_of(client, visitor, notice)))
    assert response.status_code == 200 and response.json()["verified"] is True, response.text


async def test_removed_person_loses_entitlement(app, client):
    copy = await rivera(app, client)
    dana = (await people_of(app, copy))["dana"]
    [invoice] = await rows_of(app, copy.copy_id, select(Document).where(Document.ref == "dana-invoice"))
    verified, waiting = await open_visitor(client, copy), await open_visitor(client, copy)
    await verified_as(client, verified, "dana@example.com")
    [notice] = (await started(client, waiting, "dana@example.com")).inbox      # a code on its way to her
    before = len(await entries_of(app, copy))

    await updated(client, copy, "people", {"remove": ["dana"]})
    removed = (await people_of(app, copy))["dana"]
    assert removed.removed_at is not None                    # kept for the ledger and the facts that name her
    # the session verified as her is closed, and ledgered
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in (await entries_of(app, copy))[before:]] == [
        ("session", verified.session_id, {"session_id": verified.session_id, "closed": True,
                                          "reason": "person_removed"}),
        ("desk_data", None, {"part": "people", "refs": ["dana"]})]
    response = await get_context(client, verified.session_id, verified.headers)
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    # the code on its way to her no longer works, and her contact is on record for no one
    statuses = {c.session_id: c.status for c in await rows_of(app, copy.copy_id, select(VerificationChallenge))}
    assert statuses == {verified.session_id: "consumed", waiting.session_id: "cancelled"}
    assert (await check(client, waiting, code_in(await entry_of(client, waiting, notice)))).status_code == 422
    stranger = await open_visitor(client, copy)
    assert (await started(client, stranger, "dana@example.com")).inbox == []
    [summary] = [e.event.summary for e in await entries_of(app, copy)
                 if e.event.kind == "verify" and e.event.session_id == stranger.session_id]
    assert summary == {"outcome": "not_on_record"}
    # her invoice is the owner's alone; the API no longer lists her
    [document] = await rows_of(app, copy.copy_id, select(Document).where(Document.document_id == invoice.document_id))
    assert document.record_owner_person_id is None
    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.fact_id == f"document:{invoice.document_id}"))
    assert (fact.readers, fact.record_owner) == (["owner"], None)
    assert [name for (name,) in api_rows(copy.copy_id, "SELECT display_name FROM kernel_ro.people")] == ["Bob Okafor"]
    assert api_rows(copy.copy_id, "SELECT record_owner_person_id FROM kernel_ro.documents"
                                  f" WHERE document_id = '{invoice.document_id}'") == [(None,)]
    # a removed ref isn't reused; removing her again changes nothing; an unknown ref is refused
    await refused_people(client, app, copy, {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                         "contact": "dana@example.com"}]}, 409, "conflict")
    await updated(client, copy, "people", {"remove": ["dana"]})
    assert (await people_of(app, copy))["dana"].removed_at == removed.removed_at
    assert (await entries_of(app, copy))[-1].event.summary == {"part": "people", "refs": []}
    await refused_people(client, app, copy, {"remove": ["carol"]}, 422, "invalid")
    # her contact is free for someone else
    await updated(client, copy, "people", {"upsert": [{"ref": "eve", "display_name": "Eve Santos",
                                                       "contact": "dana@example.com"}]})
    assert (await people_of(app, copy))["eve"].person_id != dana.person_id


@pytest.mark.parametrize("change", ["remove", "recontact"])
async def test_a_session_verified_as_a_people_write_begins_is_closed_too(app, client, monkeypatch, change):
    """Removing a person, or giving them another contact, locks the sessions verified as them
    before their row, in the kernel's lock order. A check that verifies another session as them in
    between, before the write holds their row, commits; the write still closes that session, and
    ledgers it, like the others."""
    write, reason = (({"remove": ["dana"]}, "person_removed") if change == "remove" else (
        {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield", "contact": "dana.w@example.net"}]},
        "contact_changed"))
    copy = await rivera(app, client)
    waiting = await open_visitor(client, copy)
    [notice] = (await started(client, waiting, "dana@example.com")).inbox
    code = code_in(await entry_of(client, waiting, notice))
    lock_sessions, raced = desks.verified_sessions, []

    async def a_check_verifies_meanwhile(ctx, desk_row, person_ids):
        sessions = await lock_sessions(ctx, desk_row, person_ids)
        if not raced:                     # the visitor's check commits before the write holds Dana's row
            raced.append(await check(client, waiting, code))
        return sessions

    monkeypatch.setattr(desks, "verified_sessions", a_check_verifies_meanwhile)
    before = len(await entries_of(app, copy))
    await updated(client, copy, "people", write)
    [response] = raced
    assert (response.status_code, response.json()["verified"]) == (200, True), response.text

    [session] = await rows_of(app, copy.copy_id, select(ActorSession).where(
        ActorSession.session_id == waiting.session_id))
    assert session.closed_at is not None
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in (await entries_of(app, copy))[before:]
            if e.event.kind == "session"] == [
        ("session", waiting.session_id, {"session_id": waiting.session_id, "closed": True, "reason": reason})]
    response = await get_context(client, waiting.session_id, waiting.headers)
    assert (response.status_code, response.json()) == (409, {"code": "closed"})


async def test_a_changed_contact_closes_the_sessions_verified_as_them(app, client):
    """A session verified as Dana proved only that it read a code sent to her old contact. When
    the owner gives her another, those sessions close (ledgered `session`, reason
    `contact_changed`) and the code on its way to the old one stops working; she stays on record
    at the new one. A write that keeps her contact closes nothing."""
    copy = await rivera(app, client)
    verified, waiting, bob = [await open_visitor(client, copy) for _ in range(3)]
    await verified_as(client, verified, "dana@example.com")
    await verified_as(client, bob, "bob@example.com")
    [notice] = (await started(client, waiting, "dana@example.com")).inbox
    before = len(await entries_of(app, copy))

    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                       "contact": "dana.w@example.net"}]})
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in (await entries_of(app, copy))[before:]] == [
        ("session", verified.session_id, {"session_id": verified.session_id, "closed": True,
                                          "reason": "contact_changed"}),
        ("desk_data", None, {"part": "people", "refs": ["dana"]})]
    response = await get_context(client, verified.session_id, verified.headers)
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    statuses = {c.session_id: c.status for c in await rows_of(app, copy.copy_id, select(VerificationChallenge))}
    assert statuses == {verified.session_id: "consumed", bob.session_id: "consumed", waiting.session_id: "cancelled"}
    assert (await check(client, waiting, code_in(await entry_of(client, waiting, notice)))).status_code == 422
    # Bob's session, and the one still waiting, stay open; Dana verifies at her new contact
    for session in (bob, waiting):
        assert (await get_context(client, session.session_id, session.headers)).status_code == 200
    again = await open_visitor(client, copy)
    await verified_as(client, again, "dana.w@example.net")

    # the same contact written another way, or none, keeps her contact, and her sessions stay open
    before = len(await entries_of(app, copy))
    for contact in (" Dana.W@Example.NET ", None):
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": contact}]})
    assert [e.event.kind for e in (await entries_of(app, copy))[before:]] == ["desk_data", "desk_data"]
    assert (await get_context(client, again.session_id, again.headers)).status_code == 200


async def test_one_write_closes_sessions_for_a_removal_and_a_new_contact(app, client):
    """One people write that removes Bob and gives Dana another contact closes the sessions
    verified as each, ledgered in session-ID order, each with its own reason, then the write."""
    copy = await rivera(app, client)
    dana, bob = await open_visitor(client, copy), await open_visitor(client, copy)
    await verified_as(client, dana, "dana@example.com")
    await verified_as(client, bob, "bob@example.com")
    before = len(await entries_of(app, copy))

    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                       "contact": "dana.w@example.net"}], "remove": ["bob"]})
    reasons = {dana.session_id: "contact_changed", bob.session_id: "person_removed"}
    # session-ID order is the database's, as the kernel locks the sessions (`ORDER BY session_id`),
    # which needn't be Python's: the IDs mix cases, and a collation may sort "hd…" before "WG…"
    in_id_order = await rows_of(app, copy.copy_id, select(ActorSession.session_id).where(
        ActorSession.session_id.in_(reasons)).order_by(ActorSession.session_id))
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in (await entries_of(app, copy))[before:]] == [
        *(("session", session_id, {"session_id": session_id, "closed": True, "reason": reasons[session_id]})
          for session_id in in_id_order),
        ("desk_data", None, {"part": "people", "refs": ["bob", "dana"]})]
    for visitor in (dana, bob):
        response = await get_context(client, visitor.session_id, visitor.headers)
        assert (response.status_code, response.json()) == (409, {"code": "closed"})


async def answered(client: httpx.AsyncClient, copy: Rivera, decision_id: str, answer: str) -> ApprovalResult:
    response = await client.post(f"/approvals/{decision_id}/answer", headers=copy.owner, json={"answer": answer})
    assert response.status_code == 200, response.text
    return ApprovalResult.model_validate(response.json())


async def test_calendar_keeps_booked_and_pending_slots(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    held = await book(client, visitor, "S-20261102-1000", call_id="held")           # the reviewer fails: held
    booked = await book(client, visitor, "S-20261102-1200", call_id="booked")
    assert (held.state, booked.state) == ("held", "held")
    assert (await answered(client, copy, booked.decision_id, "allow_once")).decision.state == "executed"
    reviewer.answer = PASS
    allowed = await book(client, visitor, "S-20261102-1400", call_id="allowed")      # allowed, not yet run
    assert allowed.state == "allowed"
    slots = [slot_body(slot) for slot in await rows_of(app, copy.copy_id, select(SlotRow)
                                                       .order_by(SlotRow.slot_id))]

    def without(*slot_ids: str) -> dict:
        return {"calendar_slots": [slot for slot in slots if slot["slot_id"] not in slot_ids]}

    moved = [slot | {"minutes": 60} if slot["slot_id"] == "S-20261102-1200" else slot for slot in slots]
    for body in (without("S-20261102-1000"), without("S-20261102-1200"), without("S-20261102-1400"),
                 {"calendar_slots": moved}):
        before = len(await entries_of(app, copy))
        response = await put_part(client, copy, "calendar", body)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"})
        assert [slot_body(slot) for slot in await rows_of(app, copy.copy_id, select(SlotRow)
                                                          .order_by(SlotRow.slot_id))] == slots
        assert len(await entries_of(app, copy)) == before
    # an open slot can go, and so can a held one once its request is answered
    await updated(client, copy, "calendar", without("S-20261102-0800"))
    assert (await entries_of(app, copy))[-1].event.summary == {"part": "calendar", "refs": ["S-20261102-0800"]}
    await answered(client, copy, held.decision_id, "deny_once")
    await updated(client, copy, "calendar", without("S-20261102-0800", "S-20261102-1000"))
    assert "S-20261102-1000" not in {slot.slot_id for slot in await rows_of(app, copy.copy_id, select(SlotRow))}


async def test_a_booking_decided_during_a_calendar_write_waits_for_it_and_finds_its_slot_gone(app, client, reviewer,
                                                                                               monkeypatch):
    """The calendar write takes the Desk's slots before it checks which are spoken for, and a
    booking's T2 takes its slot before it books it, so a booking decided after the write's check
    waits for the write and finds its slot gone: no booking outlives its slot."""
    copy, visitor = await visitor_of(app, client)
    slot_id = "S-20261102-1400"
    slots = [slot_body(slot) for slot in await rows_of(app, copy.copy_id, select(SlotRow).order_by(SlotRow.slot_id))]
    checked, proceed = asyncio.Event(), asyncio.Event()
    spoken_for = desks._spoken_for

    async def paused(ctx, desk_id):
        found = await spoken_for(ctx, desk_id)
        checked.set()
        await proceed.wait()
        return found

    monkeypatch.setattr(desks, "_spoken_for", paused)
    replacing = asyncio.create_task(put_part(client, copy, "calendar", {
        "calendar_slots": [slot for slot in slots if slot["slot_id"] != slot_id]}))
    await asyncio.wait_for(checked.wait(), timeout=5)
    reviewer.answer = PASS
    allowed = await book(client, visitor, slot_id)
    assert allowed.state == "allowed"
    with connections_of(app) as pids:
        executing = asyncio.create_task(post_execute(client, visitor, allowed))
        await until_waiting(app, executing, pids, "kernel.calendar_slots")
    assert not executing.done()                          # the booking waits for the write's slots
    proceed.set()
    replaced = await asyncio.wait_for(replacing, timeout=5)
    assert replaced.status_code == 200, replaced.text
    booking = await asyncio.wait_for(executing, timeout=5)
    assert (booking.status_code, booking.json()["state"]) == (200, "failed"), booking.text
    assert await rows_of(app, copy.copy_id, select(Booking).where(Booking.slot_id == slot_id)) == []
    assert slot_id not in {slot.slot_id for slot in await rows_of(app, copy.copy_id, select(SlotRow))}


async def test_business_and_charter_validate(app, client):
    copy = await rivera(app, client)
    business = {"name": "Rivera Plumbing", "owner_display_name": "Maria Rivera", "timezone": "America/Los_Angeles",
                "brand": {}}
    charter = [{"key": "contact", "kind": "text", "value": "(510) 555-0142"}]
    refused = [("business", business | {"owner_display_name": name})
               for name in ("M4ria", "Maria <Rivera>", "Maria\nRivera", "", "M" * 41)]
    refused += [("business", business | {"timezone": tz})        # only a zone the time zone database lists
                for tz in ("Mars/Olympus", "america/los_angeles", "America/Los_Angeles/", "")]
    refused += [("charter", {"charter": [*charter, {"key": "hours", "kind": "text", "value": "Open 8 to 6"}]}),
                ("charter", {"charter": [*charter, *charter]}),
                ("business", business | {"existing_business_id": "biz-other"})]   # not a business field here
    rows_before = [(b.name, b.owner_display_name, b.timezone) for b in await rows_of(app, copy.copy_id,
                                                                                   select(Business))]
    facts_before = await facts_of(app, copy, "charter")
    entries_before = len(await entries_of(app, copy))
    for part, body in refused:
        response = await put_part(client, copy, part, body)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), body
    assert [(b.name, b.owner_display_name, b.timezone) for b in await rows_of(app, copy.copy_id,
                                                                            select(Business))] == rows_before
    assert {fact_id: fact.claims for fact_id, fact in (await facts_of(app, copy, "charter")).items()} == {
        fact_id: fact.claims for fact_id, fact in facts_before.items()}
    assert len(await entries_of(app, copy)) == entries_before
    # a new Desk is held to the same
    for fields in ({"owner_display_name": "M4ria"}, {"timezone": "america/chicago"}):
        response = await post_desk(client, copy, new_desk(**fields))
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), fields
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    # an apostrophe, a hyphen and an accent are a name
    await updated(client, copy, "business", business | {"owner_display_name": "María O'Neil-Rivera",
                                                         "timezone": "America/Chicago"})


async def public_hours(client: httpx.AsyncClient, copy: Rivera, lang: str = "en") -> list[tuple]:
    response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
    assert response.status_code == 200, response.text
    return [(block.title, block.lines) for block in PublicDesk.model_validate(response.json()).charter
            if block.template == "hours"]


async def test_hours_rewrite_the_charter_hours_fact(app, client):
    copy = await rivera(app, client)
    hours = [HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(7), end=time(15)),
             HoursWindow(days=["sat"], start=time(8), end=time(12))]
    await updated(client, copy, "hours", {"hours": [window.model_dump(mode="json") for window in hours]})
    assert (await desks_of(app, copy))[copy.desk_id].hours == hours          # callbacks are found in these
    [claim] = (await facts_of(app, copy, "charter"))["charter:hours"].claims
    assert claim == desks.hours_claim(hours)
    assert await public_hours(client, copy) == [
        ("Monday to Friday, 7:00 am to 3:00 pm", ["Saturday, 8:00 am to 12:00 pm"])]
    assert await public_hours(client, copy, "es") == [
        ("De lunes a viernes, de 7:00 a 15:00", ["Sábado, de 8:00 a 12:00"])]
    # a visitor's context reads the same fact
    visitor = await open_visitor(client, copy)
    facts = {fact.fact_id: fact for fact in (await context_of(client, visitor.session_id, visitor.headers)).facts}
    assert facts["charter:hours"].claims == [claim]
    # no hours: the fact holds no windows and the public page shows no hours card
    await updated(client, copy, "hours", {"hours": []})
    assert (await facts_of(app, copy, "charter"))["charter:hours"].claims == [desks.hours_claim([])]
    assert await public_hours(client, copy) == []


async def test_delete_desk_closes_sessions_and_keeps_ledger(app, client, monkeypatch):
    copy = await rivera(app, client)
    browsing, verifying = await open_visitor(client, copy), await open_visitor(client, copy)
    [notice] = (await started(client, verifying, "dana@example.com")).inbox
    seen: list[tuple[str, object]] = []

    async def breaks(ctx, desk_id: str) -> None:
        raise RuntimeError("a hook that fails")

    async def records(ctx, desk_id: str) -> None:       # runs inside the deletion's transaction
        [desk] = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id)))).all()
        seen.append((desk_id, desk.deleted_at))

    # a hook that raises rolls the whole deletion back
    entries = len(await entries_of(app, copy))
    monkeypatch.setattr(desks, "ON_DELETE", [records, breaks])
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert (await desks_of(app, copy))[copy.desk_id].deleted_at is None
    assert (await get_context(client, browsing.session_id, browsing.headers)).status_code == 200
    assert [c.status for c in await rows_of(app, copy.copy_id, select(VerificationChallenge))] == ["live"]
    assert len(await entries_of(app, copy)) == entries

    # hooks run in order inside one transaction with the deletion
    monkeypatch.setattr(desks, "ON_DELETE", [records])
    seen.clear()
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert (response.status_code, response.content) == (204, b"")
    deleted_at = (await desks_of(app, copy))[copy.desk_id].deleted_at
    assert deleted_at is not None and seen == [(copy.desk_id, deleted_at)]
    sessions = await rows_of(app, copy.copy_id, select(ActorSession).where(ActorSession.desk_id == copy.desk_id))
    assert sessions and all(session.closed_at == deleted_at for session in sessions)
    assert [c.status for c in await rows_of(app, copy.copy_id, select(VerificationChallenge))] == ["cancelled"]
    [deletion] = [e for e in await entries_of(app, copy) if e.event.kind == "desk_data"
                  and e.event.summary.get("deleted")]
    assert (deletion.seq, deletion.event.summary) == (entries + 1, {"part": "desk", "deleted": True})

    # every route that names the Desk answers 409 closed; its public page is gone
    closed = [await get_context(client, browsing.session_id, browsing.headers),
              await check(client, verifying, code_in(await entry_of_owner(client, copy, notice))),
              await client.post("/sessions", json={"desk_slug": copy.slug, "kind": "visitor"}),
              await put_part(client, copy, "answering", {"on": True}),
              await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner),
              await client.post("/policy/draft", headers=copy.owner, json={
                  "desk_id": copy.desk_id, "cards": [], "expected_parent": 1}),
              await client.post("/policy/confirm", headers=copy.owner, json={"desk_id": copy.desk_id, "version": 1})]
    assert [(r.status_code, r.json()) for r in closed] == [(409, {"code": "closed"})] * len(closed)
    response = await client.get(f"/public/{copy.slug}")
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert (await client.get("/whoami", headers=copy.owner)).json()["desk_ids"] == []
    # the ledger stays, and verifies
    page = await client.get(f"/ledger/{copy.desk_id}", headers=copy.owner)
    assert page.status_code == 200 and page.json()["chain_ok"] is True
    assert len(page.json()["entries"]) > entries


async def test_deleted_desk_holds_are_refused_at_execution(app, client):
    copy = await rivera(app, client)
    [held] = await rows_of(app, copy.copy_id, select(DecisionRow).where(DecisionRow.state == "held"))  # on Today
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    result = await answered(client, copy, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution) == ("refused_at_execution", None)
    assert result.decision.visitor_plain == "The rules changed, so this didn't go ahead"
    assert await rows_of(app, copy.copy_id, select(Quote)) == []                 # nothing ran
    assert await rows_of(app, copy.copy_id, select(Execution)) == []
    [entry] = [e for e in await entries_of(app, copy) if e.event.kind == "approval"]   # the deleted Desk refused it
    assert entry.event.summary == {"decision_id": held.decision_id, "action_id": held.action_id, "answer": "allow_once",
                                   "state": "refused_at_execution", "reason": "rules_changed", "check": "desk"}


async def upload(client: httpx.AsyncClient, copy: Rivera, document: dict, *, desk_id: str | None = None
                 ) -> httpx.Response:
    return await client.post("/documents", headers=copy.owner, json={"desk_id": desk_id or copy.desk_id,
                                                                     "document": document})


async def test_uploaded_documents_get_a_fresh_canary(app, client):
    copy, other = await rivera(app, client), await rivera(app, client)
    people = await people_of(app, copy)
    seeded = {document.canary for document in await rows_of(app, copy.copy_id, select(Document))}
    estimate = {"ref": "bob-estimate", "title": "Estimate, repipe", "body": "Repipe the kitchen: $2,900.00",
                "record_owner_ref": "bob"}
    response = await upload(client, copy, estimate)
    assert response.status_code == 200, response.text
    document_id = DocumentCreated.model_validate(response.json()).document_id
    [document] = await rows_of(app, copy.copy_id, select(Document).where(Document.document_id == document_id))
    assert (document.desk_id, document.ref, document.title, document.record_owner_person_id) == (
        copy.desk_id, "bob-estimate", "Estimate, repipe", people["bob"].person_id)
    assert re.fullmatch(r"cdk-[0-9a-f]{16}", document.canary) and document.canary not in seeded
    assert document.body == f"Repipe the kitchen: $2,900.00\n\nReference {document.canary}"
    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.fact_id == f"document:{document_id}"))
    assert fact.claims == [Claim(key="title", kind="text", value="Estimate, repipe")]      # never the body
    assert (fact.kind, fact.status, fact.readers, fact.record_owner) == (
        "document", "available", ["owner", f"person:{people['bob'].person_id}"], people["bob"].person_id)
    assert (await entries_of(app, copy))[-1].event.summary == {"part": "documents", "refs": [document_id]}
    # with no record owner, it is the owner's alone; 200 KiB of body is the most
    response = await upload(client, copy, {"ref": "price-sheet", "title": "Price sheet", "body": "é" * 102_400})
    assert response.status_code == 200, response.text
    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(
        Fact.fact_id == f"document:{response.json()['document_id']}"))
    assert (fact.readers, fact.record_owner) == (["owner"], None)

    # the record owner must be a live person; a ref is a plain identifier; the body is bounded
    await updated(client, copy, "people", {"remove": ["dana"]})
    documents = len(await rows_of(app, copy.copy_id, select(Document)))
    entries = len(await entries_of(app, copy))
    for document in (estimate | {"record_owner_ref": "carol"}, estimate | {"record_owner_ref": "dana"},
                     estimate | {"ref": "bob estimate"}, estimate | {"body": "é" * 102_400 + "x"}):
        response = await upload(client, copy, document)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), document["ref"]
    response = await upload(client, copy, estimate, desk_id=other.desk_id)              # another copy's Desk
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert len(await rows_of(app, copy.copy_id, select(Document))) == documents
    assert len(await entries_of(app, copy)) == entries


async def test_price_and_slot_ids_follow_the_contract(app, client):
    copy = await rivera(app, client)
    item = {"item_id": "drain", "title": "Drain clearing", "unit_cents": 18_000}
    slot = {"slot_id": "S-20261116-0800", "starts_at": "2026-11-16T08:00:00-08:00", "minutes": 120}
    prices = [(p.item_id, p.unit_cents) for p in await rows_of(app, copy.copy_id, select(PriceRow))]
    slots = [s.slot_id for s in await rows_of(app, copy.copy_id, select(SlotRow))]
    entries = len(await entries_of(app, copy))
    refused = [("prices", {"price_items": [item | {"item_id": item_id}]})
               for item_id in ("Drain", "drain clearing", "")]
    refused += [("prices", {"price_items": [item, item]}),
                ("prices", {"price_items": [item | {"unit_cents": 1_000_001}]})]
    refused += [("calendar", {"calendar_slots": [slot | {"slot_id": slot_id}]})
                for slot_id in ("Slot 1", "S-2026116-800", "S-20261116-0800 ")]
    refused += [("calendar", {"calendar_slots": [slot, slot]})]
    for part, body in refused:
        response = await put_part(client, copy, part, body)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), body
    assert [(p.item_id, p.unit_cents) for p in await rows_of(app, copy.copy_id, select(PriceRow))] == prices
    assert [s.slot_id for s in await rows_of(app, copy.copy_id, select(SlotRow))] == slots
    assert len(await entries_of(app, copy)) == entries
    # a new Desk's ids repeat no more than an edit's
    for update in ({"price_items": [PriceItem(**item)] * 2},
                   {"calendar_slots": [CalendarSlot.model_validate(slot)] * 2},
                   {"charter": [*LOPEZ_DESK.charter] * 2}):
        response = await post_desk(client, copy, new_desk(desk=LOPEZ_DESK.model_copy(update=update)))
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), update
    assert set(await desks_of(app, copy)) == {copy.desk_id}


async def preview(client: httpx.AsyncClient, copy: Rivera, headers: dict[str, str], kind: str = "visitor"
                  ) -> httpx.Response:
    return await client.post("/sessions", headers=headers, json={"desk_slug": copy.slug, "kind": kind,
                                                                 "preview": True})


async def test_preview_session_needs_the_owner_of_the_copy(app, client):
    copy, other = await rivera(app, client), await rivera(app, client)
    visitor = await open_visitor(client, copy)
    sessions = len(await rows_of(app, copy.copy_id, select(ActorSession)))
    entries = len(await entries_of(app, copy))
    for headers in ({}, other.owner, {"X-Owner-Session": visitor.token}, {"X-Owner-Session": "not-a-token"},
                    visitor.headers):
        response = await preview(client, copy, headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    response = await preview(client, copy, copy.owner, kind="agent")          # a preview is a visitor session
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert len(await rows_of(app, copy.copy_id, select(ActorSession))) == sessions
    refusals = (await entries_of(app, copy))[entries:]                          # each on the slug's Desk
    assert [(e.event.kind, e.event.summary) for e in refusals] == [
        ("auth", {"route": "POST /sessions", "reason": "preview_unavailable"})] * 5

    response = await preview(client, copy, copy.owner)
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    assert (created.state.kind, created.state.verified, created.state.mode) == ("visitor", False, "ai")
    [row] = await rows_of(app, copy.copy_id, select(ActorSession).where(
        ActorSession.session_id == created.state.session_id))
    assert (row.desk_id, row.kind, row.preview, row.secret_hash) == (
        copy.desk_id, "visitor", True, auth.hash_token(created.session_token))
    assert (await entries_of(app, copy))[-1].event.summary == {"session_id": row.session_id, "kind": "visitor",
                                                               "preview": True}
    whoami = await client.get("/whoami", headers={auth.SESSION_HEADER: created.session_token})
    assert (whoami.status_code, whoami.json()["kind"], whoami.json()["desk_id"]) == (200, "visitor", copy.desk_id)


async def test_preview_checks_the_owner_as_owner_routes_do(app, client, monkeypatch):
    """One owner check serves both the owner's routes and the preview, so whatever later refuses an
    owner token there (an expiry, a revocation) refuses its preview too."""
    copy = await rivera(app, client)
    sessions = len(await rows_of(app, copy.copy_id, select(ActorSession)))
    owner_session = auth.owner_session

    async def revoked(ctx, request, copy_id=None):
        row = await owner_session(ctx, request, copy_id)
        return None if row is not None and row.copy_id == copy.copy_id else row

    monkeypatch.setattr(auth, "owner_session", revoked)
    response = await client.get("/whoami", headers=copy.owner)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    response = await preview(client, copy, copy.owner)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert len(await rows_of(app, copy.copy_id, select(ActorSession))) == sessions


async def test_preview_session_gets_visitor_tools_with_answering_off(app, client):
    copy = await rivera(app, client)
    live = await open_visitor(client, copy)
    visitor_tools = tools((await context_of(client, live.session_id, live.headers)).tools)
    await updated(client, copy, "answering", {"on": False})
    response = await preview(client, copy, copy.owner)
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    owner_preview = Visitor(session_id=created.state.session_id, token=created.session_token)
    stranger = await open_visitor(client, copy)
    # the owner tries the Desk as a customer would; anyone else meets only lead capture and callbacks
    previewed = await context_of(client, owner_preview.session_id, owner_preview.headers)
    answering_off = await context_of(client, stranger.session_id, stranger.headers)
    assert tools(previewed.tools) == visitor_tools
    assert tools(answering_off.tools) == ["desk.emergency-callback", "native.capture_lead", "native.request_callback"]
    assert tools(answering_off.tools_declared) == tools(previewed.tools_declared)
    args = {"items": [{"item_id": "drain", "qty": 1}]}
    assert (await decided(client, owner_preview, "native.quote", args)).outcome == "allow"
    refused = await decided(client, stranger, "native.quote", args)
    assert (refused.outcome, refused.action) == ("refuse", None)
    previews = dict(api_rows(copy.copy_id, "SELECT session_id, preview FROM kernel_ro.sessions"))
    assert (previews[owner_preview.session_id], previews[stranger.session_id]) == (True, False)   # the API sees which
