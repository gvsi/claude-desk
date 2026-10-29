"""Desks: the one path that turns a `DeskSeed` into kernel rows, the owner's writes to them, and
contacts on record.

`create_desk` serves `POST /copies` (the Rivera seed) and `POST /desks`. It runs in the caller's
transaction and never commits, so a Desk and its `desk_data` ledger entry exist together or not at
all. The owner then replaces a Desk's parts (`put_part`, `PUT /desks/{id}/{part}`), uploads
documents (`upload_document`) and deletes it (`delete_desk`), each under the Desk row's lock and
ledgered `desk_data` in the same transaction.

Owner input is checked before anything is written (`InvalidSeed`, 422 `invalid`): the owner's
display name goes into visitor status lines, so it is letters, spaces, hyphens and apostrophes
only; the time zone is one the time zone database lists; hours live in `DeskSeed.hours`, never in a
charter claim; refs, which `desk_data` entries carry, are plain identifiers; a document's body is
at most 200 KiB and its record owner a live person; and a contact on record is an email address or
a phone number, never a masked one. Two live people never share a contact (409 `conflict`).

Contacts on record are kept three ways: `contact` as given (verification codes go only there),
`contact_norm` for lookups, and `masked_contact`, the only form any view, notice or owner alert
shows. A removed person (`removed_at`) is on record for no one.

A callback's window comes from the Desk's hours (`next_open_window`), never from a tool call.
"""

import json
import logging
import re
import secrets
import unicodedata
from collections.abc import Awaitable, Callable, Collection, Iterable, Sequence
from datetime import UTC, datetime, time, timedelta, tzinfo
from typing import Any
from zoneinfo import available_timezones

import desk_kernel
from fastapi import Request
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError

from desk.contracts import (BusinessSeed, Claim, DeskSeed, Fact, HoursWindow, Label, LedgerEvent, SeedDocument,
                            ToolProfile)
from desk.db.models import Action as ActionRow
from desk.db.models import (ActorSession, Booking, Business, CalendarSlot, Desk, Document, NotificationPref, Person,
                             PriceItem, Tool, VerificationChallenge)
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import (DeskAnsweringRequest, DeskBusinessRequest, DeskCalendarRequest, DeskCharterRequest,
                             DeskCreated, DeskHoursRequest, DeskNotificationsRequest, DeskPeopleRequest,
                             DeskPricesRequest, DeskUpdated, DocumentCreated, KernelRequest)
from desk.kernel_service import adapters, auth, ledger
from desk.kernel_service.auth import AuthError, Named
from desk.kernel_service.labels import fact_row
from desk.kernel_service.repo import KernelCtx, KernelFailure, new_id, route_template

log = logging.getLogger("desk.kernel_service")

OWNER_DISPLAY_NAME = re.compile(r"[A-Za-zÀ-ÿ' -]{1,40}")
SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
SLUG_SUFFIX_LENGTH = 6
SLUG_NAME_LENGTH = 40
MASK = "•••"
WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
WINDOW_SEARCH = timedelta(days=14)        # how far ahead a callback window is looked for
DAY_END = 24 * 60                         # an hours window ending at 00:00 ends at midnight
HOURS_FACT = "charter:hours"
TIMEZONES = frozenset(available_timezones())   # the IANA names the time zone database lists
REF = re.compile(r"[A-Za-z0-9_-]{1,64}")   # an owner's ref, as `desk_data` entries carry it
MAX_DOCUMENT_BYTES = 200 * 1024
MAX_CONTACT = 120                         # characters of a contact on record
MASKING = frozenset("•*")                 # what a masked contact holds and a real one never does
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
PHONE = re.compile(r"\+?[0-9 ().-]+")
PHONE_DIGITS = range(7, 16)               # E.164 numbers have at most 15 digits


class InvalidSeed(KernelFailure):
    """A Desk seed the kernel won't write; `reason` (internal) names the check that failed."""

    def __init__(self, reason: str):
        super().__init__(422, "invalid", reason)


def validate_business(business: BusinessSeed) -> None:
    name = business.owner_display_name
    if not OWNER_DISPLAY_NAME.fullmatch(name) or not any(ch.isalpha() for ch in name):
        raise InvalidSeed("owner_display_name")
    if business.timezone not in TIMEZONES:   # exactly as listed: a file system may also open "america/chicago"
        raise InvalidSeed("timezone")


def validate_desk(desk: DeskSeed) -> None:
    check_charter(desk.charter)
    unique(item.item_id for item in desk.price_items)
    unique(slot.slot_id for slot in desk.calendar_slots)
    check_refs(person.ref for person in desk.people)
    if any(not valid_contact(person.contact) for person in desk.people):
        raise InvalidSeed("contact")
    one_person_per_contact(person.contact for person in desk.people)
    refs = {person.ref for person in desk.people}
    for document in desk.documents:
        check_document(document, refs)


def check_document(document: SeedDocument, people_refs: Collection[str]) -> None:
    """A document's ref is a plain identifier, its body at most 200 KiB of UTF-8, and its record
    owner, if any, one of `people_refs` (the Desk's live people)."""
    if not REF.fullmatch(document.ref):
        raise InvalidSeed("ref")
    if not storable(document.body) or len(document.body.encode()) > MAX_DOCUMENT_BYTES:
        raise InvalidSeed("document_body")
    if document.record_owner_ref is not None and document.record_owner_ref not in people_refs:
        raise InvalidSeed("record_owner_ref")


def check_refs(refs: Iterable[str]) -> None:
    """Refs the owner gives go on the ledger (`desk_data`), so each is a plain identifier, once."""
    refs = list(refs)
    if not all(REF.fullmatch(ref) for ref in refs):
        raise InvalidSeed("ref")
    unique(refs)


def one_person_per_contact(contacts: Iterable[str]) -> None:
    """A verification code goes to one person: two live people never share a contact (409)."""
    norms = [normalize_contact(contact) for contact in contacts]
    if len(set(norms)) != len(norms):
        raise KernelFailure(409, "conflict", "contact_on_record")


def check_charter(charter: Sequence[Claim]) -> None:
    """Charter claims become `charter:<key>` facts: one per key, and never the hours."""
    if any(claim.key == "hours" for claim in charter):
        raise InvalidSeed("hours_claim")
    unique(claim.key for claim in charter)


def unique(ids: Iterable[str]) -> None:
    """IDs the owner gives within one write (price items, slots, charter keys, refs) don't repeat."""
    ids = list(ids)
    if len(set(ids)) != len(ids):
        raise InvalidSeed("duplicate")


def storable(text: str) -> bool:
    """Text Postgres can keep: valid UTF-8 without NUL."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return "\0" not in text


def valid_contact(contact: str) -> bool:
    """A contact an owner may put on record: at most 120 characters, none of a masked contact's
    characters (a contact as the owner app shows it is never one a code could reach), and an email
    address or a phone number of 7 to 15 digits, which `normalize_contact` makes `+` and digits."""
    text = contact.strip()
    if len(text) > MAX_CONTACT or MASKING & set(text) or not storable(text):
        return False
    if "@" in text:
        return EMAIL.fullmatch(text) is not None
    return PHONE.fullmatch(text) is not None and len(normalize_contact(text)) - 1 in PHONE_DIGITS


def normalize_contact(contact: str) -> str:
    """The form contacts are compared in: an email trimmed and lowercased; a phone number as `+` and
    its digits, with `+1` added to a 10-digit number written without a country code. Anything else
    (no `@` and no digits) normalizes to "", which no contact on record has."""
    contact = contact.strip()
    if "@" in contact:
        return contact.lower()
    digits = re.sub(r"[^0-9]", "", contact)
    if not digits:
        return ""
    if len(digits) == 10 and not contact.startswith("+"):
        digits = "1" + digits
    return "+" + digits


def mask_contact(contact: str) -> str:
    """The contact as anyone but the kernel sees it: `d•••@example.com`, `•••• 0177`."""
    norm = normalize_contact(contact)
    if "@" in norm:
        local, _, domain = norm.rpartition("@")
        return f"{local[:1]}{MASK}@{domain}"
    return f"•••• {norm[-4:]}" if norm else "••••"


def slugify(name: str) -> str:
    """Lowercase ASCII words joined by hyphens ("Rivera Plumbing" → "rivera-plumbing")."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:SLUG_NAME_LENGTH].rstrip("-") or "desk"


def new_slug(business_name: str) -> str:
    suffix = "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_SUFFIX_LENGTH))
    return f"{slugify(business_name)}-{suffix}"


def new_canary() -> str:
    return "cdk-" + secrets.token_hex(8)


def tool_row(copy_id: str, desk_id: str, profile: ToolProfile) -> Tool:
    """An enabled `tools` row for a registered native profile."""
    enabled = profile.model_copy(update={"status": "enabled"})
    return Tool(desk_id=desk_id, tool=enabled.tool, copy_id=copy_id, source=enabled.source, effects=enabled.effects,
                reversible=enabled.reversible, status="enabled", description_confirmed=enabled.description_confirmed,
                definition_sha256=enabled.definition_sha256, profile=enabled,
                profile_sha256=adapters.profile_sha256(enabled))


def hours_claim(hours: Sequence[HoursWindow]) -> Claim:
    """Fact `charter:hours`'s one claim: the canonical JSON of the Desk's hours windows."""
    windows = json.dumps([window.model_dump(mode="json") for window in hours])
    return Claim(key="windows", kind="text", value=desk_kernel.canonical_json(windows))


def charter_fact(claim: Claim, *, fact_id: str | None = None) -> Fact:
    """A public charter fact holding one claim: `charter:<key>`, or `fact_id` (the hours' windows)."""
    return Fact(fact_id=fact_id or f"charter:{claim.key}", kind="charter", status="available", source="kernel",
                claims=[claim], label=Label(readers=["public"]))


def person_row(copy_id: str, desk_id: str, ref: str, display_name: str, contact: str, notes: str,
               now: datetime) -> Person:
    """A person on record: the contact as given, normalized for lookups and masked for every view."""
    return Person(person_id=new_id("person"), copy_id=copy_id, desk_id=desk_id, ref=ref, display_name=display_name,
                  contact=contact.strip(), contact_norm=normalize_contact(contact),
                  masked_contact=mask_contact(contact), notes=notes, created_at=now)


def write_document(ctx: KernelCtx, copy_id: str, desk_id: str, document: SeedDocument, owner_person_id: str | None,
                   now: datetime) -> str:
    """A document with a fresh canary in its body, and its `document:<id>` fact holding the title
    alone, readable by the owner and, when it has one, its record owner. Returns its ID."""
    document_id, canary = new_id("doc"), new_canary()
    ctx.db.add(Document(document_id=document_id, copy_id=copy_id, desk_id=desk_id, ref=document.ref,
                        title=document.title, record_owner_person_id=owner_person_id,
                        body=f"{document.body}\n\nReference {canary}", canary=canary, created_at=now))
    readers = ["owner", f"person:{owner_person_id}"] if owner_person_id else ["owner"]
    ctx.db.add(fact_row(copy_id, desk_id, Fact(
        fact_id=f"document:{document_id}", kind="document", status="available", source="kernel",
        claims=[Claim(key="title", kind="text", value=document.title)],
        label=Label(readers=readers, record_owner=owner_person_id)), now))
    return document_id


async def create_desk(ctx: KernelCtx, copy_id: str, business: BusinessSeed, desk: DeskSeed, *,
                      answering: bool = False) -> DeskCreated:
    """Write a Desk from its seed in the caller's transaction (binding it to `copy_id`).

    It writes the business (or reuses `existing_business_id`, a business of this copy, else 404;
    the Desk's slug then follows the stored name), the Desk, its people, prices,
    slots, documents (each with a fresh canary and an owner-only or record-owner `document:<id>`
    fact holding the title), notification preferences, an enabled `tools` row per registered
    native profile, a public `charter:<key>` fact per charter claim plus `charter:hours`, and a
    `desk_data` ledger entry. A new Desk starts with Answering off unless `answering` is set (the
    Rivera seed is live at once). MCP tools come only through a pinned connect (Plan 01c).
    """
    validate_business(business)
    validate_desk(desk)
    copy = ctx.bind(copy_id)
    now = ctx.clock.now()
    if business.existing_business_id is not None:
        existing = (await ctx.db.execute(copy.scoped(select(Business.business_id, Business.name).where(
            Business.business_id == business.existing_business_id)))).one_or_none()
        if existing is None:   # row-level security hides every other copy's businesses
            raise KernelFailure(404, "not_found", "unknown_business")
        business_id, business_name = existing
    else:
        business_id, business_name = new_id("biz"), business.name
        ctx.db.add(Business(business_id=business_id, copy_id=copy_id, name=business.name,
                            owner_display_name=business.owner_display_name, timezone=business.timezone,
                            brand=business.brand))
    desk_id = new_id("desk")
    slug = new_slug(business_name)
    ctx.db.add(Desk(desk_id=desk_id, copy_id=copy_id, business_id=business_id, name=desk.name, slug=slug,
                    hours=desk.hours, answering=answering, created_at=now))
    person_ids: dict[str, str] = {}
    for person in desk.people:
        row = person_row(copy_id, desk_id, person.ref, person.display_name, person.contact, person.notes, now)
        ctx.db.add(row)
        person_ids[person.ref] = row.person_id
    ctx.db.add_all(PriceItem(desk_id=desk_id, item_id=item.item_id, copy_id=copy_id, title=item.title,
                             unit_cents=item.unit_cents) for item in desk.price_items)
    ctx.db.add_all(CalendarSlot(desk_id=desk_id, slot_id=slot.slot_id, copy_id=copy_id, starts_at=slot.starts_at,
                                minutes=slot.minutes) for slot in desk.calendar_slots)
    for document in desk.documents:
        owner_id = person_ids[document.record_owner_ref] if document.record_owner_ref else None
        write_document(ctx, copy_id, desk_id, document, owner_id, now)
    ctx.db.add(NotificationPref(desk_id=desk_id, copy_id=copy_id, now=desk.notifications.now,
                                briefing=desk.notifications.briefing))
    ctx.db.add_all(tool_row(copy_id, desk_id, profile) for profile in adapters.registered_profiles(source="native"))
    for claim in desk.charter:
        ctx.db.add(fact_row(copy_id, desk_id, charter_fact(claim), now))
    ctx.db.add(fact_row(copy_id, desk_id, charter_fact(hours_claim(desk.hours), fact_id=HOURS_FACT), now))
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="desk_data", origin="kernel", summary={"part": "desk", "created": True}))
    return DeskCreated(desk_id=desk_id, slug=slug)


# ---- Owner writes: PUT /desks/{id}/{part} -------------------------------------------------------
#
# Each write runs in the request's transaction under the Desk row's lock (`owner_desk`), so writes
# to one Desk, and its deletion, happen one at a time. A writer checks its input before it writes
# anything and returns the refs it changed, which the route ledgers as one `desk_data` entry
# `{part, refs}` in the same transaction: IDs only, never a contact, a claim or a body.

async def owner_alone(ctx: KernelCtx, request: Request) -> auth.OwnerCtx:
    """The owner's credential, alone: a session token beside it is 401, as on the approvals route."""
    if auth.SESSION_HEADER in request.headers:
        raise AuthError(401, "auth", "bad_token", route=route_template(request))
    return await auth.require_owner(ctx, request)


async def owner_desk(ctx: KernelCtx, request: Request, desk_id: str) -> Desk:
    """The Desk `desk_id` of the copy the owner's credential proves (`owner_alone`), locked `FOR
    UPDATE` until the transaction ends. Another copy's Desk, or none, is 404; a deleted one is 409
    `closed`, ledgered on it."""
    route = route_template(request)
    owner = await owner_alone(ctx, request)
    desk_row = None
    if storable(desk_id):
        desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id)
                                                         .with_for_update()))).one_or_none()
    if desk_row is None:   # row-level security hides every other copy's Desks
        raise AuthError(404, "not_found", "wrong_copy", route=route)
    if desk_row.deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route, named=Named(copy_id=owner.copy_id, desk_id=desk_id))
    return desk_row


async def ledger_desk_data(ctx: KernelCtx, desk_row: Desk, summary: dict[str, Any]) -> None:
    await ledger.append(ctx, copy_id=desk_row.copy_id, desk_id=desk_row.desk_id,
                        event=LedgerEvent(kind="desk_data", origin="kernel", summary=summary))


async def put_business(ctx: KernelCtx, desk_row: Desk, body: DeskBusinessRequest) -> list[str]:
    """The Desk's business, replaced: its name, the owner's display name, time zone and brand."""
    validate_business(BusinessSeed(**body.model_dump()))
    business = (await ctx.db.scalars(ctx.repo.scoped(select(Business).where(
        Business.business_id == desk_row.business_id).with_for_update()))).one()
    business.name, business.owner_display_name = body.name, body.owner_display_name
    business.timezone, business.brand = body.timezone, body.brand
    return [business.business_id]


async def put_charter(ctx: KernelCtx, desk_row: Desk, body: DeskCharterRequest) -> list[str]:
    """The Desk's public `charter:<key>` facts, replaced; `charter:hours` comes only from its hours."""
    check_charter(body.charter)
    now = ctx.clock.now()
    rows = {row.fact_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_row.desk_id, FactRow.kind == "charter", FactRow.fact_id != HOURS_FACT)))}
    wanted = {fact.fact_id: fact for fact in map(charter_fact, body.charter)}
    for fact_id, row in rows.items():
        if fact_id not in wanted:
            await ctx.db.delete(row)
    for fact_id, fact in wanted.items():
        if fact_id not in rows:
            ctx.db.add(fact_row(desk_row.copy_id, desk_row.desk_id, fact, now))
        else:
            rows[fact_id].claims, rows[fact_id].status = fact.claims, fact.status
    return []


async def put_hours(ctx: KernelCtx, desk_row: Desk, body: DeskHoursRequest) -> list[str]:
    """The Desk's hours, and fact `charter:hours` written again from them."""
    desk_row.hours = body.hours
    fact = charter_fact(hours_claim(body.hours), fact_id=HOURS_FACT)
    row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_row.desk_id, FactRow.fact_id == HOURS_FACT)))).one_or_none()
    if row is None:
        ctx.db.add(fact_row(desk_row.copy_id, desk_row.desk_id, fact, ctx.clock.now()))
    else:
        row.claims, row.status = fact.claims, fact.status
    return []


async def put_prices(ctx: KernelCtx, desk_row: Desk, body: DeskPricesRequest) -> list[str]:
    """The Desk's price list, replaced. Quotes already made keep their amounts."""
    unique(item.item_id for item in body.price_items)
    rows = {row.item_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(PriceItem).where(
        PriceItem.desk_id == desk_row.desk_id)))}
    wanted = {item.item_id: item for item in body.price_items}
    changed = set(rows) ^ set(wanted)
    for item_id in set(rows) - set(wanted):
        await ctx.db.delete(rows[item_id])
    for item_id, item in wanted.items():
        row = rows.get(item_id)
        if row is None:
            ctx.db.add(PriceItem(desk_id=desk_row.desk_id, item_id=item_id, copy_id=desk_row.copy_id,
                                 title=item.title, unit_cents=item.unit_cents))
        elif (row.title, row.unit_cents) != (item.title, item.unit_cents):
            row.title, row.unit_cents = item.title, item.unit_cents
            changed.add(item_id)
    return sorted(changed)


async def put_calendar(ctx: KernelCtx, desk_row: Desk, body: DeskCalendarRequest) -> list[str]:
    """The Desk's calendar slots, replaced. A slot that is booked, or that a booking waiting to run
    names (an `allowed`, `held` or `approved` decision), stays as it is: dropping or moving it is
    409 `conflict`."""
    unique(slot.slot_id for slot in body.calendar_slots)
    rows = {row.slot_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(CalendarSlot).where(
        CalendarSlot.desk_id == desk_row.desk_id)))}
    wanted = {slot.slot_id: slot for slot in body.calendar_slots}
    for slot_id in await _spoken_for(ctx, desk_row.desk_id) & set(rows):
        slot = wanted.get(slot_id)
        if slot is None or (slot.starts_at, slot.minutes) != (rows[slot_id].starts_at, rows[slot_id].minutes):
            raise KernelFailure(409, "conflict", "slot_spoken_for")
    changed = set(rows) ^ set(wanted)
    for slot_id in set(rows) - set(wanted):
        await ctx.db.delete(rows[slot_id])
    for slot_id, slot in wanted.items():
        row = rows.get(slot_id)
        if row is None:
            ctx.db.add(CalendarSlot(desk_id=desk_row.desk_id, slot_id=slot_id, copy_id=desk_row.copy_id,
                                    starts_at=slot.starts_at, minutes=slot.minutes))
        elif (row.starts_at, row.minutes) != (slot.starts_at, slot.minutes):
            row.starts_at, row.minutes = slot.starts_at, slot.minutes
            changed.add(slot_id)
    return sorted(changed)


async def _spoken_for(ctx: KernelCtx, desk_id: str) -> set[str]:
    """The Desk's slots a confirmed booking holds, or a booking action whose decision may still run:
    `allowed` or `held` and not yet expired, or `approved`."""
    now = ctx.clock.now()
    booked = await ctx.db.scalars(ctx.repo.scoped(select(Booking.slot_id).where(
        Booking.desk_id == desk_id, Booking.status == "confirmed")))
    pending = await ctx.db.scalars(ctx.repo.scoped(select(ActionRow.resource).join(
        DecisionRow, DecisionRow.action_id == ActionRow.action_id).where(
        ActionRow.desk_id == desk_id, ActionRow.resource_kind == "slot",
        or_(DecisionRow.state == "approved",
            and_(DecisionRow.state.in_(("allowed", "held")), DecisionRow.expires_at > now)))))
    return set(booked) | {resource.id for resource in pending}


async def put_people(ctx: KernelCtx, desk_row: Desk, body: DeskPeopleRequest) -> list[str]:
    """People upserted by `ref` and removed. A new person needs a contact, and `contact: None` keeps
    the one on record; a changed contact cancels the person's live verification code, which went
    to the old one. A removed person (`removed_at`) is never on record again, and their ref isn't
    reused (409): their live code is cancelled, the sessions verified as them close (ledgered
    `session`), and their documents become the owner's alone. Removing them again changes nothing;
    an unknown ref is 422.

    The Desk's people are locked `FOR UPDATE` in ID order, as verification locks them, then their
    challenges, so a code can't be sent to a contact as it changes or its person goes."""
    check_refs([*(upsert.ref for upsert in body.upsert), *body.remove])
    if any(upsert.contact is not None and not valid_contact(upsert.contact) for upsert in body.upsert):
        raise InvalidSeed("contact")
    now = ctx.clock.now()
    people = {row.ref: row for row in await ctx.db.scalars(ctx.repo.scoped(select(Person).where(
        Person.desk_id == desk_row.desk_id).order_by(Person.person_id).with_for_update()))}
    recontacted: list[str] = []           # people whose code went to a contact no longer on record
    for upsert in body.upsert:
        row = people.get(upsert.ref)
        if row is not None and row.removed_at is not None:
            raise KernelFailure(409, "conflict", "person_removed")
        if row is None:
            if upsert.contact is None:
                raise InvalidSeed("contact")
            row = person_row(desk_row.copy_id, desk_row.desk_id, upsert.ref, upsert.display_name, upsert.contact,
                             upsert.notes, now)
            ctx.db.add(row)
            people[upsert.ref] = row
            continue
        row.display_name, row.notes = upsert.display_name, upsert.notes
        if upsert.contact is not None:
            if normalize_contact(upsert.contact) != row.contact_norm:
                recontacted.append(row.person_id)
            row.contact, row.contact_norm = upsert.contact.strip(), normalize_contact(upsert.contact)
            row.masked_contact = mask_contact(upsert.contact)
    removed: list[Person] = []
    for ref in body.remove:
        row = people.get(ref)
        if row is None:
            raise InvalidSeed("unknown_ref")
        if row.removed_at is None:
            row.removed_at = now
            removed.append(row)
    one_person_per_contact(row.contact for row in people.values() if row.removed_at is None)
    try:
        async with ctx.db.begin_nested():
            await ctx.db.flush()
    except IntegrityError:                # contacts swapped in one write meet each other's first
        raise KernelFailure(409, "conflict", "contact_on_record") from None
    await cancel_challenges(ctx, [*recontacted, *(row.person_id for row in removed)], now)
    for row in removed:
        await _off_the_record(ctx, desk_row, row.person_id, now)
    return sorted([*(upsert.ref for upsert in body.upsert), *(row.ref for row in removed)])


async def _off_the_record(ctx: KernelCtx, desk_row: Desk, person_id: str, now: datetime) -> None:
    """What a removed person leaves: the sessions verified as them closed, each ledgered `session`,
    and their documents the owner's alone (no record owner; `document:*` facts relabelled
    `["owner"]`)."""
    sessions = await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
        ActorSession.desk_id == desk_row.desk_id, ActorSession.person_id == person_id,
        ActorSession.closed_at.is_(None)).order_by(ActorSession.session_id).with_for_update()))
    for session in sessions:
        session.closed_at = now
        await ledger.append(ctx, copy_id=desk_row.copy_id, desk_id=desk_row.desk_id, event=LedgerEvent(
            kind="session", origin="kernel", session_id=session.session_id,
            summary={"session_id": session.session_id, "closed": True, "reason": "person_removed"}))
    documents = await ctx.db.scalars(ctx.repo.scoped(select(Document).where(
        Document.desk_id == desk_row.desk_id, Document.record_owner_person_id == person_id).with_for_update()))
    for document in documents:
        document.record_owner_person_id = None
        fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == desk_row.desk_id, FactRow.fact_id == f"document:{document.document_id}")
            .with_for_update()))).one()
        fact.readers, fact.record_owner = ["owner"], None
    await ctx.db.flush()


async def cancel_challenges(ctx: KernelCtx, person_ids: Sequence[str], now: datetime) -> None:
    """The people's live verification codes, cancelled (or expired, if their time had run out)."""
    if not person_ids:
        return
    challenges = await ctx.db.scalars(ctx.repo.scoped(select(VerificationChallenge).where(
        VerificationChallenge.person_id.in_(person_ids), VerificationChallenge.status == "live")
        .order_by(VerificationChallenge.challenge_id).with_for_update()))
    for challenge in challenges:
        challenge.status = "expired" if challenge.expires_at <= now else "cancelled"


async def put_notifications(ctx: KernelCtx, desk_row: Desk, body: DeskNotificationsRequest) -> list[str]:
    """Which alerts reach the owner at once and which wait for the briefing."""
    prefs = (await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref).where(
        NotificationPref.desk_id == desk_row.desk_id)))).one()
    prefs.now, prefs.briefing = body.notifications.now, body.notifications.briefing
    return []


async def put_answering(ctx: KernelCtx, desk_row: Desk, body: DeskAnsweringRequest) -> list[str]:
    """The Answering switch: off, visitors and agents get only lead capture and callbacks."""
    desk_row.answering = body.on
    return []


Writer = Callable[[KernelCtx, Desk, Any], Awaitable[list[str]]]

PARTS: dict[str, tuple[type[KernelRequest], Writer]] = {   # PUT /desks/{id}/{part}: its body and its writer
    "business": (DeskBusinessRequest, put_business),
    "charter": (DeskCharterRequest, put_charter),
    "hours": (DeskHoursRequest, put_hours),
    "prices": (DeskPricesRequest, put_prices),
    "calendar": (DeskCalendarRequest, put_calendar),
    "people": (DeskPeopleRequest, put_people),
    "notifications": (DeskNotificationsRequest, put_notifications),
    "answering": (DeskAnsweringRequest, put_answering),
}


async def put_part(ctx: KernelCtx, request: Request, desk_id: str, part: str, body: KernelRequest) -> DeskUpdated:
    """`PUT /desks/{id}/{part}`: the part replaced (people upserted and removed) and ledgered
    `desk_data` `{part, refs}`, in one transaction."""
    desk_row = await owner_desk(ctx, request, desk_id)
    _, write = PARTS[part]
    refs = await write(ctx, desk_row, body)
    await ctx.db.flush()
    await ledger_desk_data(ctx, desk_row, {"part": part, "refs": refs})
    return DeskUpdated(desk_id=desk_row.desk_id, updated_at=ctx.clock.now())


async def upload_document(ctx: KernelCtx, desk_row: Desk, document: SeedDocument) -> DocumentCreated:
    """`POST /documents`: a document on the Desk, which the caller has locked, written as a seed's
    are (a fresh canary, a title-only fact) and ledgered `desk_data` `{part: "documents", refs:
    [document_id]}`. Its record owner must be one of the Desk's live people."""
    live = {row.ref: row.person_id for row in await ctx.db.scalars(ctx.repo.scoped(select(Person).where(
        Person.desk_id == desk_row.desk_id, Person.removed_at.is_(None))))}
    check_document(document, live)
    owner_person_id = live[document.record_owner_ref] if document.record_owner_ref is not None else None
    document_id = write_document(ctx, desk_row.copy_id, desk_row.desk_id, document, owner_person_id, ctx.clock.now())
    await ctx.db.flush()
    await ledger_desk_data(ctx, desk_row, {"part": "documents", "refs": [document_id]})
    return DocumentCreated(document_id=document_id)


# ---- DELETE /desks/{id} ---------------------------------------------------------------------------

DeleteHook = Callable[[KernelCtx, str], Awaitable[None]]

# What else a Desk's deletion ends (`(ctx, desk_id)`, in order, inside its transaction): document
# links (Task 6 of this plan) and payment links (Plan 01c) register here. An exception from any of
# them rolls the whole deletion back (500 `internal`).
ON_DELETE: list[DeleteHook] = []


async def delete_desk(ctx: KernelCtx, desk_row: Desk) -> None:
    """Deletes the Desk, which the caller has locked, in one transaction: `deleted_at`, its open
    sessions closed, its live verification codes cancelled, the `ON_DELETE` hooks run, and a
    `desk_data` `{part: "desk", deleted: true}` entry. Its rows and its ledger stay: afterwards
    routes naming it answer 409 `closed`, its ledger still reads, and an approved hold re-checks to
    `refused_at_execution`."""
    now = ctx.clock.now()
    desk_row.deleted_at = now
    sessions = await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
        ActorSession.desk_id == desk_row.desk_id, ActorSession.closed_at.is_(None))
        .order_by(ActorSession.session_id).with_for_update()))
    for session in sessions:
        session.closed_at = now
    challenges = await ctx.db.scalars(ctx.repo.scoped(select(VerificationChallenge).where(
        VerificationChallenge.desk_id == desk_row.desk_id, VerificationChallenge.status == "live")
        .order_by(VerificationChallenge.challenge_id).with_for_update()))
    for challenge in challenges:
        challenge.status = "cancelled"
    await ctx.db.flush()
    for hook in ON_DELETE:
        try:
            await hook(ctx, desk_row.desk_id)
        except Exception:
            log.exception("desk_delete_hook_failed desk_id=%s hook=%s", desk_row.desk_id,
                          getattr(hook, "__qualname__", repr(hook)))
            raise KernelFailure(500, "internal", "desk_delete_hook_failed") from None
    await ledger_desk_data(ctx, desk_row, {"part": "desk", "deleted": True})


def next_open_window(hours: Sequence[HoursWindow], tz: tzinfo, after: datetime) -> tuple[datetime, datetime] | None:
    """The first clock-aligned hour `[h, h + 1 h)` of the business's hours: `h` on the hour in its
    time zone `tz`, no earlier than `after`, and the whole hour inside one window (its end
    exclusive, 00:00 the end of the day), within 14 days. None when there is none: no hours, or
    only windows shorter than an hour. Hours are read on the wall clock, so a day the clocks
    change keeps its hours; an hour the change skips is never offered, and of an hour it repeats
    only the first."""
    if after.tzinfo is None:
        raise ValueError("after must be an aware datetime")
    spans = [(set(window.days), window.start.hour * 60 + window.start.minute,
              DAY_END if window.end == time(0) else window.end.hour * 60 + window.end.minute) for window in hours]
    local = after.astimezone(tz).replace(tzinfo=None, fold=0)
    first = local.replace(minute=0, second=0, microsecond=0)
    if first < local:
        first += timedelta(hours=1)
    for step in range(WINDOW_SEARCH // timedelta(hours=1)):
        wall = first + timedelta(hours=step)
        minute = wall.hour * 60
        if not any(WEEK[wall.weekday()] in days and start <= minute and minute + 60 <= end
                   for days, start, end in spans):
            continue
        start = wall.replace(tzinfo=tz)
        if start.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != wall or start < after:
            continue                      # a wall time the clocks skip, or the repeated hour before `after`
        return start, (wall + timedelta(hours=1)).replace(tzinfo=tz)
    return None


async def enabled_profiles(ctx: KernelCtx, desk_id: str) -> list[ToolProfile]:
    """The profiles of the Desk's enabled tools, by tool name, from its `tools` rows. A row without
    a profile gives Claude nothing to call, so it is left out."""
    rows = await ctx.db.scalars(ctx.repo.scoped(
        select(Tool).where(Tool.desk_id == desk_id, Tool.status == "enabled").order_by(Tool.tool)))
    return [row.profile.model_copy(update={"status": "enabled"}) for row in rows if row.profile is not None]
