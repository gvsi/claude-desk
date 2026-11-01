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
Before those checks, what strangers are shown of the input (the business's and the Desk's names,
the owner's display name, the brand, the charter, the price list's IDs and titles, and a new
Desk's slug) is checked for the copy's document canaries (`refuse_public_canaries`): 422
`invalid`, ledgered.

Contacts on record are kept three ways: `contact` as given (verification codes go only there),
`contact_norm` for lookups, and `masked_contact`, the only form any view, notice or owner alert
shows. A removed person (`removed_at`) is on record for no one.

A callback's window comes from the Desk's hours (`next_open_window`), never from a tool call, and
the public page's open-now line from them too (`open_window_status`), on the local day and minute
Cedar's hours checks read.

A setup-made Desk's calendar is kept open from its hours (`extend_calendar`): at the kernel's start
and then daily, each live one gets the days after its latest slot, up to 14 days ahead. No slot it
has is changed, but a tail the owner trimmed or a calendar they cleared is filled again.
"""

import asyncio
import json
import logging
import math
import re
import secrets
import unicodedata
from collections.abc import Awaitable, Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta, tzinfo
from functools import partial
from typing import Any, Protocol
from zoneinfo import ZoneInfo, available_timezones

import desk_kernel
from fastapi import Request
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql import ColumnElement

from desk.calendar import calendar_slots
from desk.public_contact import valid_public_contact
from desk.contracts import (BusinessSeed, Claim, DeskSeed, Fact, HoursWindow, Label, LedgerEvent, SeedDocument,
                            ToolProfile, stored_brand)
from desk.contracts import CalendarSlot as CalendarSlotSeed
from desk.contracts import PriceItem as PriceItemSeed
from desk.db.models import Action as ActionRow
from desk.db.models import (ActorSession, Booking, Business, CalendarSlot, Desk, Document, NotificationPref, Person,
                             PriceItem, Tool, VerificationChallenge)
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.db.session import KernelRepo
from desk.kernel_api import (DeskAnsweringRequest, DeskBusinessRequest, DeskCalendarRequest, DeskCharterRequest,
                             DeskCreated, DeskHoursRequest, DeskMemoryRequest, DeskNotificationsRequest, DeskPeopleRequest,
                             DeskPricesRequest, DeskUpdated, DocumentCreated, KernelRequest)
from desk.kernel_service import adapters, auth, clock, labels, ledger, mcp_pins, payments, reply_check
from desk.kernel_service.auth import AuthError, Named
from desk.kernel_service.labels import fact_row
from desk.kernel_service.repo import (REF, KernelCtx, KernelFailure, KernelRuntime, copy_ids, kernel_transaction,
                                      limit_lock_waits, log_error, new_id, route_template, storable)

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
STARTER_KEY_PREFIX = "starter:"           # a seed-only public question's claim key, `starter:<n>:<lang>`
STARTER_FACT_PREFIX = f"charter:{STARTER_KEY_PREFIX}"   # its fact's ID, `charter:starter:<n>:<lang>`
TIMEZONES = frozenset(available_timezones())   # the IANA names the time zone database lists
MAX_DOCUMENT_BYTES = 200 * 1024
MAX_DOCUMENTS = 50                        # on one Desk, each a canary every scan looks for
MAX_CONTACT = 120                         # characters of a contact on record
MASKING = frozenset("•*")                 # what a masked contact holds and a real one never does
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
PHONE = re.compile(r"\+?[0-9 ().-]+")
PHONE_DIGITS = range(7, 16)               # E.164 numbers have at most 15 digits


def is_starter_key(key: str) -> bool:
    """A charter claim key only the demo seed writes: one of the public starter questions."""
    return key.startswith(STARTER_KEY_PREFIX)


def is_starter_fact(fact_id: str) -> bool:
    """A seed-only starter question's fact: a chip on the public page, never a fact for Claude."""
    return fact_id.startswith(STARTER_FACT_PREFIX)


def not_starter() -> ColumnElement[bool]:
    """The condition that leaves the seed-only starter facts out of a query of facts."""
    return ~FactRow.fact_id.startswith(STARTER_FACT_PREFIX)


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
    if len(desk.documents) > MAX_DOCUMENTS:
        raise InvalidSeed("documents_cap")
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
    """Charter claims become `charter:<key>` facts: one per key, never hours or seed-only starters."""
    if any(claim.key == "hours" for claim in charter):
        raise InvalidSeed("hours_claim")
    unique(claim.key for claim in charter)
    starters = {claim.key: ["starter_seed_only"] for claim in charter if is_starter_key(claim.key)}
    if starters:
        raise KernelFailure(422, "invalid", "starter_seed_only", detail=starters)


def unique(ids: Iterable[str]) -> None:
    """IDs the owner gives within one write (price items, slots, charter keys, refs) don't repeat."""
    ids = list(ids)
    if len(set(ids)) != len(ids):
        raise InvalidSeed("duplicate")


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
    """An enabled `tools` row for a registered native profile. Its `definition_sha256` is the
    profile's `profile_sha256`, the hash the owner names the tool by in `/tools/confirm`."""
    enabled = profile.model_copy(update={"status": "enabled"})
    pinned = adapters.profile_sha256(enabled)
    return Tool(desk_id=desk_id, tool=enabled.tool, copy_id=copy_id, source=enabled.source, effects=enabled.effects,
                reversible=enabled.reversible, status="enabled", description_confirmed=enabled.description_confirmed,
                definition_sha256=pinned, profile=enabled, profile_sha256=pinned)


async def update_native_tools(ctx: KernelCtx, desk_id: str) -> list[str]:
    """Brings the Desk's native tools up to date with the registered ones: gives it each it has no
    `tools` row for (one created before it was registered), enabled as `create_desk` writes them,
    and points each row an earlier kernel wrote with another profile at the registered one, its
    status kept, as the owner's confirm of the tool points it (`mcp_pins.pin_row`). In the caller's
    transaction under the Desk row's lock, as an owner's write takes it, then the native rows
    `FOR UPDATE` in tool order, and ledgered `desk_data` `{part: "tools", refs}`. Returns the tools
    added or changed, by name; [] when every one is current, or when the Desk is deleted, and then
    nothing is written."""
    desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id).with_for_update()
                                                     .execution_options(populate_existing=True)))).one()
    if desk_row.deleted_at is not None:              # deleted since it was found: it gets nothing
        return []
    registered = adapters.registered_profiles(source="native")
    have = {row.tool: row for row in (await ctx.db.scalars(ctx.repo.scoped(
        select(Tool).where(Tool.desk_id == desk_id, Tool.tool.in_([profile.tool for profile in registered]))
        .order_by(Tool.tool).with_for_update().execution_options(populate_existing=True)))).all()}
    missing = [profile for profile in registered if profile.tool not in have]
    stale = [profile.tool for profile in registered
             if profile.tool in have and have[profile.tool].profile_sha256 != mcp_pins.native_pin(profile.tool)]
    if not missing and not stale:
        return []
    ctx.db.add_all(tool_row(desk_row.copy_id, desk_id, profile) for profile in missing)
    for tool in stale:
        row = have[tool]
        mcp_pins.pin_row(row, tool, mcp_pins.native_pin(tool), status=row.status, review_reason=row.review_reason)
    await ctx.db.flush()
    changed = sorted([*(profile.tool for profile in missing), *stale])
    await ledger_desk_data(ctx, desk_row, {"part": "tools", "refs": changed})
    return changed


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

    What the public page and the Desk's public address (its slug, made from the business's name)
    would show is checked for the copy's document canaries first (`refuse_public_canaries`, part
    `desk`): the new business's name, display name and brand, or an existing business's stored
    name, and the Desk's name, charter and price list. The name is checked as typed and as the
    slug that will be written, suffix and all, since making it a slug drops what isn't ASCII (a
    sharp s inside a canary leaves the canary); either holding a canary refuses field
    `business.name`. The slug is read before the name, so the name is still read beside the field
    after it and a canary split between them is refused, as `put_business` refuses it.
    """
    copy = ctx.bind(copy_id)
    now = ctx.clock.now()
    existing = None
    if business.existing_business_id is not None:
        existing = (await ctx.db.execute(copy.scoped(select(Business.business_id, Business.name).where(
            Business.business_id == business.existing_business_id)))).one_or_none()
        if existing is None:   # row-level security hides every other copy's businesses
            raise KernelFailure(404, "not_found", "unknown_business")
    business_name = existing.name if existing is not None else business.name
    slug = new_slug(business_name)
    # the name as the slug writes it, which drops what isn't ASCII, and as the page shows it; the
    # slug first, so its suffix doesn't come between the name and the field after it
    shown: dict[str, object] = {"business.name": [slug, business_name]}
    if existing is None:
        shown |= {"business.owner_display_name": business.owner_display_name, "business.brand": business.brand}
    shown |= {"desk.name": desk.name, "desk.charter": charter_shown(desk.charter),
              "desk.price_items": prices_shown(desk.price_items)}
    await refuse_public_canaries(ctx, "desk", shown)
    validate_business(business)
    validate_desk(desk)
    await refuse_public_charter(ctx, "desk", desk.charter)
    if existing is not None:
        business_id = existing.business_id
    else:
        business_id = new_id("biz")
        ctx.db.add(Business(business_id=business_id, copy_id=copy_id, name=business.name,
                            owner_display_name=business.owner_display_name, timezone=business.timezone,
                            brand=stored_brand(business.brand)))
    desk_id = new_id("desk")
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
    """The Desk `desk_id` of the copy the owner's credential proves (`owner_alone`), locked as
    `held_desk` locks it."""
    return await held_desk(ctx, request, await owner_alone(ctx, request), desk_id)


async def held_desk(ctx: KernelCtx, request: Request, owner: auth.OwnerCtx, desk_id: str) -> Desk:
    """The Desk `desk_id` of the owner's copy, locked `FOR UPDATE` until the transaction ends and
    read afresh, so a deletion that committed first is seen and one that comes later waits.
    Another copy's Desk, or none, is 404; a deleted one is 409 `closed`, ledgered on it."""
    route = route_template(request)
    desk_row = None
    if storable(desk_id):
        desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id)
                                                         .with_for_update()
                                                         .execution_options(populate_existing=True)))).one_or_none()
    if desk_row is None:   # row-level security hides every other copy's Desks
        raise AuthError(404, "not_found", "wrong_copy", route=route)
    if desk_row.deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route, named=Named(copy_id=owner.copy_id, desk_id=desk_id))
    return desk_row


async def ledger_desk_data(ctx: KernelCtx, desk_row: Desk, summary: dict[str, Any]) -> None:
    await ledger.append(ctx, copy_id=desk_row.copy_id, desk_id=desk_row.desk_id,
                        event=LedgerEvent(kind="desk_data", origin="kernel", summary=summary))


async def refuse_public_canaries(ctx: KernelCtx, part: str, values: Mapping[str, object],
                                 desk_id: str | None = None) -> None:
    """Refuses owner input that the public page shows to anyone (`values`, by the request's field
    names) when it holds the canary of any of the copy's documents, even split or disguised
    (`labels.canary_fields`): 422 `invalid`, ledgered `desk_data` `{part, refused: "canary",
    fields, fact_ids}` (the fields and the documents' `document:<id>` facts, never the text) after
    the request's transaction has rolled back, on Desk `desk_id`, or, for a Desk not yet created,
    on the Desks whose documents it held. Runs before the write it checks."""
    canaries = await labels.copy_canaries(ctx)
    fields = labels.canary_fields(values, canaries)
    if not fields:
        return
    found = labels.find_canaries_in(list(values.values()), canaries)
    desk_ids = [desk_id] if desk_id is not None else sorted(set(await ctx.db.scalars(ctx.repo.scoped(
        select(Document.desk_id).where(Document.document_id.in_(found))))))
    summary = {"part": part, "refused": "canary", "fields": fields,
               "fact_ids": [f"document:{document_id}" for document_id in found]}
    raise KernelFailure(422, "invalid", "public_canary", persist=partial(
        _ledger_refusal, copy_id=ctx.copy_id, desk_ids=desk_ids, summary=summary))


def policy_values(charter: Sequence[Claim]) -> dict[str, str]:
    """Only free-text policies render verbatim; contact and structured claims have other checks."""
    return {claim.key: claim.value for claim in charter if claim.key.startswith("policy:") and claim.kind == "text"}


async def _refusal_desk_ids(ctx: KernelCtx, desk_id: str | None) -> list[str]:
    """Where a refused write is ledgered: its Desk, or for a Desk not yet created, the copy's Desks in ID order."""
    if desk_id is not None:
        return [desk_id]
    return list(await ctx.db.scalars(ctx.repo.scoped(select(Desk.desk_id).order_by(Desk.desk_id))))


async def refuse_public_charter(ctx: KernelCtx, part: str, charter: Sequence[Claim], desk_id: str | None = None) -> None:
    """Refuse a charter whose public contact isn't a list of contact endpoints (`valid_public_contact`) or
    whose text policies the reply check would reject, in one refusal naming every refused key, so the
    owner's setup learns them all from one write (`refuse_public_promises`)."""
    contact_format = any(claim.key == "contact" and (claim.kind != "text" or not valid_public_contact(claim.value))
                         for claim in charter)
    await refuse_public_promises(ctx, part, policy_values(charter), desk_id, contact_format=contact_format)


async def refuse_public_promises(ctx: KernelCtx, part: str, values: Mapping[str, str],
                                desk_id: str | None = None, *,
                                allow_words: Mapping[str, frozenset[str]] = {}, contact_format: bool = False,
                                amenities: bool = True) -> None:
    """Refuse public prose the reply check would reject, and with `contact_format` a contact that isn't a
    list of contact endpoints, before writing any of it: 422 `invalid`.

    Detail names only refused keys and sorted rule IDs, the contact as `{"contact": ["contact_format"]}`
    beside every refused policy. The post-rollback ledger entry `{part, refused, fields}` names the same,
    the contact by its fact ID `charter:contact`, since a ledger summary never carries a key named
    `contact` (`ledger.check_summary`); `refused` is "contact" when only the contact was refused, else
    "promise". For cap refusals it also records the first `PUBLIC_POLICY_MAX_COUNT` keys in order, the
    count of all policies, their total characters and a reason. Never rejected text or the contact.
    A refused creation has no Desk chain yet. Record it on the copy's existing Desks, in ID
    order, so the owner can audit the attempt without creating a row for refused input.
    """
    count, total_characters = len(values), sum(map(len, values.values()))
    limit = None
    if count > reply_check.PUBLIC_POLICY_MAX_COUNT:
        limit = "policy_count_limit"
    elif total_characters > reply_check.PUBLIC_POLICY_MAX_CHARS:
        limit = "policy_text_limit"
    fields = {"charter": [limit]} if limit is not None else reply_check.scan_public_policies(
        values, allow_words=allow_words, amenities=amenities)
    if not fields and not contact_format:
        return
    contact = {"contact": ["contact_format"]} if contact_format else {}
    summary = {"part": part, "refused": "promise" if fields else "contact",
               "fields": fields | ({"charter:contact": ["contact_format"]} if contact_format else {})}
    if limit is not None:
        keys = sorted(values)[:reply_check.PUBLIC_POLICY_MAX_COUNT]
        summary.update(keys=[ledger.safe_ref(key) for key in keys], policy_count=count,
                       total_characters=total_characters, reason=limit)
    reason = limit or ("public_promise" if fields else "contact_format")
    raise KernelFailure(422, "invalid", reason, detail=contact | fields, persist=partial(
        _ledger_refusal, copy_id=ctx.copy_id, desk_ids=await _refusal_desk_ids(ctx, desk_id), summary=summary))


async def _ledger_refusal(ctx: KernelCtx, *, copy_id: str, desk_ids: Sequence[str], summary: dict[str, Any]) -> None:
    """A refused owner write's `desk_data` entry on each of `desk_ids`, in ID order, in the fresh
    transaction `KernelFailure.persist` runs in."""
    ctx.bind(copy_id)
    for desk_id in desk_ids:
        await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                            event=LedgerEvent(kind="desk_data", origin="kernel", summary=summary))


async def put_business(ctx: KernelCtx, desk_row: Desk, body: DeskBusinessRequest) -> list[str]:
    """The Desk's business, replaced: its name, the owner's display name, time zone and brand. The
    public page shows all but the time zone, so a document's canary in them is refused first
    (`refuse_public_canaries`). A palette pick (`brand_palette`, or a `palette` key in a brand
    passed back as it was read) is stored as its key and the table's colours (`stored_brand`),
    never colours of the request's."""
    await refuse_public_canaries(ctx, "business", {"name": body.name, "owner_display_name": body.owner_display_name,
                                                   "brand": body.brand}, desk_row.desk_id)
    validate_business(BusinessSeed(**body.model_dump()))
    business = (await ctx.db.scalars(ctx.repo.scoped(select(Business).where(
        Business.business_id == desk_row.business_id).with_for_update()))).one()
    business.name, business.owner_display_name = body.name, body.owner_display_name
    business.timezone, business.brand = body.timezone, stored_brand(body.brand, body.brand_palette)
    return [business.business_id]


def charter_shown(charter: Sequence[Claim]) -> list[tuple[str, object]]:
    """What the public page shows of charter claims, one after another: each `charter:<key>`
    fact's key (its ID names it) and value."""
    return [(claim.key, claim.value) for claim in charter]


def prices_shown(price_items: Sequence[PriceItemSeed]) -> list[tuple[str, str]]:
    """What a stranger is shown of price items (the catalog's claims, a quote's lines), one after
    another: each item's ID and title."""
    return [(item.item_id, item.title) for item in price_items]


async def put_charter(ctx: KernelCtx, desk_row: Desk, body: DeskCharterRequest) -> list[str]:
    """The Desk's public `charter:<key>` facts, replaced; keep hours and seed-only starters.
    The public page shows them, so a document's canary in a key or a value is refused first
    (`refuse_public_canaries`). Text policies render verbatim, so their values must also pass
    the reply check's public prose scan, and the contact must be a list of contact endpoints, both
    refused together in one refusal (`refuse_public_charter`). Structured claims keep their own checks.
    """
    await refuse_public_canaries(ctx, "charter", {"charter": charter_shown(body.charter)}, desk_row.desk_id)
    check_charter(body.charter)
    await refuse_public_charter(ctx, "charter", body.charter, desk_row.desk_id)
    now = ctx.clock.now()
    rows = {row.fact_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_row.desk_id, FactRow.kind == "charter", FactRow.fact_id != HOURS_FACT,
        not_starter())))}
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


async def put_memory(ctx: KernelCtx, desk_row: Desk, body: DeskMemoryRequest) -> list[str]:
    """Replace the Desk's simulated owner notes. Even private notes must not import document canaries."""
    if not storable(body.about) or any(not storable(value) for item in body.items
                                     for value in (item.id, item.title, *item.topics, item.text)):
        raise KernelFailure(422, "invalid", "memory_text", persist=partial(
            _ledger_refusal, copy_id=ctx.copy_id, desk_ids=[desk_row.desk_id],
            summary={"part": "memory", "refused": "invalid"}))
    await refuse_public_canaries(ctx, "memory", {
        "about": body.about, "items": [item.model_dump() for item in body.items]}, desk_row.desk_id)
    desk_row.simulated_memory = body.model_dump(mode="json")
    return [item.id for item in body.items]


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
    """The Desk's price list, replaced. Quotes already made keep their amounts. Strangers are
    shown its IDs and titles, so a document's canary in them is refused first
    (`refuse_public_canaries`)."""
    await refuse_public_canaries(ctx, "prices", {"price_items": prices_shown(body.price_items)}, desk_row.desk_id)
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
    409 `conflict`. The slots are taken `FOR UPDATE` in ID order before that check (`repo.py` step
    10, after the Desk row), and a booking's T2 takes its slot `FOR SHARE`, so a booking either
    commits before the check sees it or waits for this write and finds its slot as the write left
    it."""
    unique(slot.slot_id for slot in body.calendar_slots)
    rows = {row.slot_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(CalendarSlot).where(
        CalendarSlot.desk_id == desk_row.desk_id).order_by(CalendarSlot.slot_id).with_for_update()))}
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


# ---- Keeping a setup-made Desk's calendar open --------------------------------------------------
#
# Setup gives a new Desk 60-minute slots from its hours for the 14 days after it finishes
# (`desk.calendar.calendar_slots`), once. So that a live Desk doesn't run out of open times, the
# kernel adds the days after its latest slot from its hours as the days go by: at its start and
# then daily (`keep_calendars_open`, which the app's lifespan runs beside the kernel).

CALENDAR_REFRESH_EVERY_S = 24 * 60 * 60   # a pass at the kernel's start, then one a day
CALENDAR_REFRESH_LOCK_S = 5.0             # how long a pass waits for a row another write holds
CALENDAR_LOOKUP_S = 10.0                  # the pass's limit on listing the copies or one copy's Desks, as
                                          # the background rebuild's (`activation.BACKGROUND_LOOKUP_S`)
# The shipped rule set `POST /desks`, the route setup makes a Desk through, activates as a new Desk's
# version 1. Rivera's seed (`POST /copies`) starts from "rivera" instead and builds its own two-hour
# slots for each copy, so a Desk whose version 1 came from this preset is one setup made. Every
# Desk has had a version 1 since it was created, and nothing writes a version's `preset` after
# that: a confirm only changes `status`, and a rebuild only `_REBUILT_COLUMNS`
# (`activation.rebuild_version`), which leave it out.
NEW_DESK_PRESET = "ask_first"


class SlotStart(Protocol):
    slot_id: str
    starts_at: datetime


def later_slots(hours: Sequence[HoursWindow], timezone: str, now: datetime,
                rows: Collection[SlotStart]) -> list[CalendarSlotSeed]:
    """The slots `calendar_slots` gives from `hours` on the 14 days after `now`'s day in the
    business's time zone, keeping only the days after the latest of the Desk's slots `rows` (all
    of them when it has none), and none whose ID one of `rows` already has."""
    zone = ZoneInfo(timezone)
    today = now.astimezone(zone).date()
    last = max((row.starts_at.astimezone(zone).date() for row in rows), default=today)
    taken = {row.slot_id for row in rows}
    return [slot for slot in calendar_slots(list(hours), timezone, today)
            if slot.starts_at.astimezone(zone).date() > last and slot.slot_id not in taken]


def made_in_setup() -> ColumnElement[bool]:
    """The condition on a Desk's `policy_versions` rows that finds its version 1 when setup made
    the Desk (`NEW_DESK_PRESET`)."""
    return and_(PolicyVersionRow.version == 1, PolicyVersionRow.preset == NEW_DESK_PRESET)


async def _made_in_setup(ctx: KernelCtx, desk_id: str) -> bool:
    found = await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow.version).where(
        PolicyVersionRow.desk_id == desk_id, made_in_setup())))
    return found.first() is not None


async def extend_calendar(ctx: KernelCtx, desk_id: str) -> list[str]:
    """Adds to Desk `desk_id`'s calendar the slots its hours give for the days after its latest
    slot, up to 14 days ahead (`later_slots`), when it is a Desk whose calendar the kernel keeps
    open: live, not deleted, with hours, and made in setup (`NEW_DESK_PRESET`), never Rivera's
    seed. Returns their IDs, in order; [] when it adds none, and then writes nothing.

    It only inserts: a booked slot, one a request still names, and every change the owner made
    inside the days the calendar covers stay exactly as they are. A tail the owner trimmed, or a
    calendar they cleared, is filled again from the hours (wish #596 tracks keeping them).

    In the caller's transaction, bound to the Desk's copy, it holds the Desk row `FOR UPDATE`, read
    afresh, as an owner's calendar write does, so the two take turns (`repo.py`). Every write that
    changes or deletes a slot holds that row first, so the Desk's slots are read without a lock,
    and a booking holding its slot `FOR SHARE` and the refresh never wait on each other for a slot;
    like any two writes to one Desk, they take turns only at its ledger head. The new slots go in
    under fresh keys, then the ledger head is taken for the entry an owner's write leaves,
    `desk_data` `{part: "calendar", refs}`, with `extended_from: "hours"` saying the kernel added
    them from the hours."""
    desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id).with_for_update()
                                                     .execution_options(populate_existing=True)))).one_or_none()
    if (desk_row is None or desk_row.deleted_at is not None or not desk_row.answering or not desk_row.hours
            or not await _made_in_setup(ctx, desk_id)):
        return []
    timezone = (await ctx.db.scalars(ctx.repo.scoped(select(Business.timezone).where(
        Business.business_id == desk_row.business_id)))).one()
    rows = (await ctx.db.execute(ctx.repo.scoped(select(CalendarSlot.slot_id, CalendarSlot.starts_at).where(
        CalendarSlot.desk_id == desk_id)))).all()
    added = later_slots(desk_row.hours, timezone, ctx.clock.now(), rows)
    if not added:
        return []
    ctx.db.add_all(CalendarSlot(desk_id=desk_id, slot_id=slot.slot_id, copy_id=desk_row.copy_id,
                                starts_at=slot.starts_at, minutes=slot.minutes) for slot in added)
    await ctx.db.flush()
    refs = sorted(slot.slot_id for slot in added)
    await ledger_desk_data(ctx, desk_row, {"part": "calendar", "refs": refs, "extended_from": "hours"})
    return refs


async def desks_to_extend(runtime: KernelRuntime, copy_id: str) -> list[str]:
    """The copy's live Desks with hours that setup made (`NEW_DESK_PRESET`), in ID order: the
    ones `extend_calendar` may add to, which checks each again under its lock. Read through the
    copy's own `KernelRepo`, as `repo.desks_to_bring_up` reads each copy."""
    copy = KernelRepo(copy_id)
    async with runtime.sessions() as db:
        copy.bind(db)
        live = (await db.execute(copy.scoped(select(Desk.desk_id, Desk.hours).where(
            Desk.deleted_at.is_(None), Desk.answering.is_(True)).order_by(Desk.desk_id)))).all()
        setup_made = set(await db.scalars(copy.scoped(select(PolicyVersionRow.desk_id).where(made_in_setup()))))
    return [desk_id for desk_id, hours in live if hours and desk_id in setup_made]


async def extend_calendars(runtime: KernelRuntime) -> dict[str, list[str]]:
    """One pass over every copy (`repo.copy_ids`): each Desk `desks_to_extend` finds gets
    `extend_calendar` in a transaction of its own, whose lock waits are held to
    `CALENDAR_REFRESH_LOCK_S` (`repo.limit_lock_waits`). A copy whose lookup fails or outlasts
    `CALENDAR_LOOKUP_S` (stuck behind a migration's lock, say), or a Desk whose extension fails
    (one an owner's write holds past that wait), is logged and left to the next pass, and the
    others go on; a listing of the copies that outlasts it fails the pass, which the next one
    repeats. Returns the slots it added, by Desk."""
    added: dict[str, list[str]] = {}
    for copy_id in await asyncio.wait_for(copy_ids(runtime), CALENDAR_LOOKUP_S):
        try:
            desk_ids = await asyncio.wait_for(desks_to_extend(runtime, copy_id), CALENDAR_LOOKUP_S)
        except TimeoutError:
            log.info("calendar_lookup_cut_off copy_id=%s", copy_id)
            continue
        except Exception as exc:
            log_error(log, exc, "calendar_lookup_failed copy_id=%s", copy_id)
            continue
        for desk_id in desk_ids:
            try:
                async with kernel_transaction(runtime) as ctx:
                    ctx.bind(copy_id)
                    await limit_lock_waits(ctx, CALENDAR_REFRESH_LOCK_S)
                    refs = await extend_calendar(ctx, desk_id)
            except Exception as exc:
                log_error(log, exc, "calendar_extend_failed copy_id=%s desk_id=%s", copy_id, desk_id)
                continue
            if refs:
                added[desk_id] = refs
                log.info("calendar_extended copy_id=%s desk_id=%s slots=%s", copy_id, desk_id, len(refs))
    return added


async def keep_calendars_open(runtime: KernelRuntime, every_s: float = CALENDAR_REFRESH_EVERY_S) -> None:
    """Extends the calendars (`extend_calendars`) at once, then every `every_s` seconds, until it
    is cancelled: the kernel's lifespan runs it beside the kernel, without waiting for it, and
    cancels it at shutdown, when the Desk in hand rolls back. A pass that fails is logged, and the
    next one comes on time."""
    while True:
        try:
            await extend_calendars(runtime)
        except Exception as exc:
            log_error(log, exc, "calendar_refresh_failed")
        await asyncio.sleep(every_s)


async def put_people(ctx: KernelCtx, desk_row: Desk, body: DeskPeopleRequest) -> list[str]:
    """People upserted by `ref` and removed. A new person needs a contact, and `contact: None` keeps
    the one on record. A changed contact cancels the person's live verification code, which went
    to the old one, closes the sessions verified as them (ledgered `session`, reason
    `contact_changed`), which proved only that they could read the old one, and voids the links
    that released documents to them and haven't opened; their documents stay theirs. A removed
    person (`removed_at`) is never on record again, and their ref isn't reused (409): their live
    code is cancelled, the sessions verified as them close (ledgered `session`, reason
    `person_removed`), their documents become the owner's alone, and the links that released
    documents to them and haven't opened are void. Removing them again changes nothing; an unknown
    ref is 422.

    Its locks come in the kernel's order (`repo.py`), after the Desk row the caller holds: the open
    sessions verified as the people it removes or gives another contact (`verified_sessions`), then
    the Desk's people `FOR UPDATE` in ID order, as verification locks them, then their challenges,
    so a code can't be sent to a contact as it changes or its person goes; then what the write
    takes off the record (`_off_the_record`)."""
    check_refs([*(upsert.ref for upsert in body.upsert), *body.remove])
    if any(upsert.contact is not None and not valid_contact(upsert.contact) for upsert in body.upsert):
        raise InvalidSeed("contact")
    now = ctx.clock.now()
    await verified_sessions(ctx, desk_row, await _leaving(ctx, desk_row, body))
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
    await _off_the_record(ctx, desk_row, now, removed=[row.person_id for row in removed], recontacted=recontacted)
    return sorted([*(upsert.ref for upsert in body.upsert), *(row.ref for row in removed)])


async def _leaving(ctx: KernelCtx, desk_row: Desk, body: DeskPeopleRequest) -> list[str]:
    """The IDs of the Desk's people on record whom `body` removes or gives another contact, in ID
    order, read without a lock. Only an owner's write to people changes who is on record and at
    what contact, and it holds the Desk row, as the caller does, so what this reads holds until the
    caller commits."""
    contacts = {upsert.ref: normalize_contact(upsert.contact) for upsert in body.upsert if upsert.contact is not None}
    refs = [*body.remove, *contacts]
    if not refs:
        return []
    rows = (await ctx.db.execute(ctx.repo.scoped(select(Person.person_id, Person.ref, Person.contact_norm).where(
        Person.desk_id == desk_row.desk_id, Person.ref.in_(refs), Person.removed_at.is_(None))))).all()
    return sorted(person_id for person_id, ref, contact_norm in rows
                  if ref in body.remove or contacts[ref] != contact_norm)


async def verified_sessions(ctx: KernelCtx, desk_row: Desk, person_ids: Sequence[str]) -> list[ActorSession]:
    """The Desk's open sessions verified as these people, locked `FOR UPDATE` in ID order and read
    afresh: the lock order's session step for a write that ends them."""
    if not person_ids:
        return []
    return list((await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
        ActorSession.desk_id == desk_row.desk_id, ActorSession.person_id.in_(person_ids),
        ActorSession.closed_at.is_(None)).order_by(ActorSession.session_id).with_for_update()
        .execution_options(populate_existing=True)))).all())


async def _off_the_record(ctx: KernelCtx, desk_row: Desk, now: datetime, *, removed: Sequence[str],
                          recontacted: Sequence[str]) -> None:
    """What a people write takes off the record for the people it removes or gives another contact,
    whose verifications went through a contact it takes away: the sessions verified as them closed,
    each ledgered `session` with its reason (`person_removed`, `contact_changed`); the document
    links released to them that haven't opened, void; and the removed people's documents, the
    owner's alone (`_taken_back`).

    Every row is locked before the ledger head, which is taken last, for all the people at once.
    Their sessions come first: `put_people` locked them before the people, and they are taken again
    here, which waits for none of those and also takes any session a check verified as one of them
    before `put_people` held their rows. That one comes after the people, yet waits on nothing that
    waits on this write: its check has committed, and nothing that holds a verified session's row
    asks for a Desk row, another session, a person or a challenge, all this write holds by then.
    Holding the sessions, a release running in one has committed its link before the links are
    voided. Then their links, the removed people's documents and the facts; then the closes are
    ledgered."""
    if not removed and not recontacted:
        return
    sessions = await verified_sessions(ctx, desk_row, [*removed, *recontacted])
    await _taken_back(ctx, desk_row, removed=removed, recontacted=recontacted)
    for session in sessions:
        session.closed_at = now
    await ctx.db.flush()
    for session in sessions:
        reason = "person_removed" if session.person_id in removed else "contact_changed"
        await ledger.append(ctx, copy_id=desk_row.copy_id, desk_id=desk_row.desk_id, event=LedgerEvent(
            kind="session", origin="kernel", session_id=session.session_id,
            summary={"session_id": session.session_id, "closed": True, "reason": reason}))


async def _taken_back(ctx: KernelCtx, desk_row: Desk, *, removed: Sequence[str], recontacted: Sequence[str]) -> None:
    """Once the sessions verified as them are held: the document links released to the people a
    write removes or gives another contact, and not yet opened, void, with their facts expired; and
    the removed people's documents the owner's alone (no record owner; `document:*` facts
    relabelled `["owner"]`). A person given another contact keeps their documents. Every one's
    links first, as an open of one holds its link and then its fact and the ledger head; then the
    removed people's documents; then the links' facts and the documents'."""
    voided = await adapters.release_document.void_links(ctx, desk_row.desk_id, person_ids=[*removed, *recontacted])
    if not removed:                       # no documents change hands
        await adapters.release_document.expire_link_facts(ctx, desk_row.desk_id, voided)
        return
    documents = (await ctx.db.scalars(ctx.repo.scoped(select(Document).where(
        Document.desk_id == desk_row.desk_id, Document.record_owner_person_id.in_(removed))
        .order_by(Document.document_id).with_for_update()))).all()
    for document in documents:
        document.record_owner_person_id = None
    await adapters.release_document.expire_link_facts(ctx, desk_row.desk_id, voided)
    facts = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_row.desk_id,
        FactRow.fact_id.in_([f"document:{document.document_id}" for document in documents]))
        .order_by(FactRow.fact_id).with_for_update()))).all()
    if len(facts) != len(documents):      # every document is written with its fact: never relabel half
        raise RuntimeError("document_fact_missing")
    for fact in facts:
        fact.readers, fact.record_owner = ["owner"], None


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
    "memory": (DeskMemoryRequest, put_memory),
    "hours": (DeskHoursRequest, put_hours),
    "prices": (DeskPricesRequest, put_prices),
    "calendar": (DeskCalendarRequest, put_calendar),
    "people": (DeskPeopleRequest, put_people),
    "notifications": (DeskNotificationsRequest, put_notifications),
    "answering": (DeskAnsweringRequest, put_answering),
}


async def put_part(ctx: KernelCtx, request: Request, desk_id: str, part: str, body: KernelRequest) -> DeskUpdated:
    """`PUT /desks/{id}/{part}`: the part replaced (people upserted and removed) and ledgered
    `desk_data` `{part, refs}`, in one transaction; a business write that stored a palette pick
    adds its key, `palette` (a closed identifier, never a colour)."""
    desk_row = await owner_desk(ctx, request, desk_id)
    _, write = PARTS[part]
    refs = await write(ctx, desk_row, body)
    await ctx.db.flush()
    summary: dict[str, Any] = {"part": part, "refs": refs}
    if isinstance(body, DeskBusinessRequest) and "palette" in (brand := stored_brand(body.brand, body.brand_palette)):
        summary["palette"] = brand["palette"]
    await ledger_desk_data(ctx, desk_row, summary)
    return DeskUpdated(desk_id=desk_row.desk_id, updated_at=ctx.clock.now())


async def upload_document(ctx: KernelCtx, desk_row: Desk, document: SeedDocument) -> DocumentCreated:
    """`POST /documents`: a document on the Desk, which the caller has locked, written as a seed's
    are (a fresh canary, a title-only fact) and ledgered `desk_data` `{part: "documents", refs:
    [document_id]}`. Its record owner must be one of the Desk's live people, and a Desk holds at most
    `MAX_DOCUMENTS` (`labels.refuse_past_cap`)."""
    live = {row.ref: row.person_id for row in await ctx.db.scalars(ctx.repo.scoped(select(Person).where(
        Person.desk_id == desk_row.desk_id, Person.removed_at.is_(None))))}
    check_document(document, live)
    held = (await ctx.db.execute(ctx.repo.scoped(select(func.count(Document.document_id)).where(
        Document.desk_id == desk_row.desk_id)))).scalar_one()
    await labels.refuse_past_cap(ctx, desk_row.desk_id, "documents", held, MAX_DOCUMENTS)
    owner_person_id = live[document.record_owner_ref] if document.record_owner_ref is not None else None
    document_id = write_document(ctx, desk_row.copy_id, desk_row.desk_id, document, owner_person_id, ctx.clock.now())
    await ctx.db.flush()
    await ledger_desk_data(ctx, desk_row, {"part": "documents", "refs": [document_id]})
    return DocumentCreated(document_id=document_id)


# ---- DELETE /desks/{id} ---------------------------------------------------------------------------

DeleteHook = Callable[[KernelCtx, str], Awaitable[None]]


async def lock_payment_links(ctx: KernelCtx, desk_id: str) -> None:
    """The payment links `cancel_payment_links` will cancel, locked first (`payments.lock_desk_links`)."""
    await payments.lock_desk_links(ctx, desk_id)


async def void_document_links(ctx: KernelCtx, desk_id: str) -> None:
    """The Desk's unopened document links, void, and their facts expired."""
    voided = await adapters.release_document.void_links(ctx, desk_id)
    await adapters.release_document.expire_link_facts(ctx, desk_id, voided)


async def cancel_payment_links(ctx: KernelCtx, desk_id: str) -> None:
    """The Desk's issued payment links no completion has started, cancelled (`payments.cancel_desk_links`)."""
    await payments.cancel_desk_links(ctx, desk_id)


# What else a Desk's deletion ends (`(ctx, desk_id)`, in order, inside its transaction): its
# document links and its payment links. The payment links are locked before the document links
# and cancelled after them, so the deletion takes payment links, document links, facts and the
# ledger head in repo.py's order. An exception from any of them rolls the whole deletion back
# (500 `internal`).
ON_DELETE: list[DeleteHook] = [lock_payment_links, void_document_links, cancel_payment_links]


async def delete_desk(ctx: KernelCtx, desk_row: Desk) -> None:
    """Deletes the Desk, which the caller has locked, in one transaction: `deleted_at`, its open
    sessions closed, its live verification codes cancelled, the `ON_DELETE` hooks run, and a
    `desk_data` `{part: "desk", deleted: true}` entry. Its rows and its ledger stay: afterwards
    routes naming it answer 409 `closed`, its ledger still reads, an approved hold re-checks to
    `refused_at_execution`, and an execution whose intent was written before the deletion ends
    `refused_at_execution` before its side effect (`execute._gone`), so a verification start sends
    no code."""
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
        except Exception as exc:
            log_error(log, exc, "desk_delete_hook_failed desk_id=%s hook=%s", desk_row.desk_id,
                      getattr(hook, "__qualname__", repr(hook)))
            raise KernelFailure(500, "internal", "desk_delete_hook_failed") from None
    await ledger_desk_data(ctx, desk_row, {"part": "desk", "deleted": True})


def next_open_window(hours: Sequence[HoursWindow], tz: tzinfo, after: datetime) -> tuple[datetime, datetime] | None:
    """The first clock-aligned hour `[h, h + 1 h)` of the business's hours: `h` on the hour in its
    time zone `tz`, no earlier than `after`, and the whole hour inside one window (its end
    exclusive, 00:00 the end of the day), within 14 days. None when there is none: no hours, or
    only windows shorter than an hour. Hours are read on the wall clock, so a day the clocks
    change keeps its hours; an hour the change skips is never offered, and of an hour it repeats
    only the first. `after` is compared as an instant, whatever zone it is given in, and an end
    the change skips is the instant it names (2:00 am becomes 3:00 am)."""
    if after.tzinfo is None:
        raise ValueError("after must be an aware datetime")
    spans = [(set(window.days), window.start.hour * 60 + window.start.minute,
              DAY_END if window.end == time(0) else window.end.hour * 60 + window.end.minute) for window in hours]
    after_utc = after.astimezone(UTC)
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
        # instants, never wall clocks: two datetimes sharing one zone compare on the wall clock
        if start.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != wall or start.astimezone(UTC) < after_utc:
            continue                      # a wall time the clocks skip, or the repeated hour before `after`
        # an end the clocks skip (2:00 am the night they go forward) is read as the instant it
        # names, 3:00 am, so every reader of the window shows the same end
        return start, (wall + timedelta(hours=1)).replace(tzinfo=tz).astimezone(UTC).astimezone(tz)
    return None


# ---- Open now -------------------------------------------------------------------------------------

OPEN_STATUS_DAYS = 7                      # local calendar days ahead that the open-now line looks
REFRESH_WITHIN = timedelta(hours=25)      # the latest the line is asked for again (a fall-back day lasts 25 hours)
OFFSET_PROBE = timedelta(hours=1)         # the step that finds the clock changes ahead


@dataclass(frozen=True)
class OpenWindow:
    """Whether the business is open at an instant, from its weekly hours, as instants in UTC."""

    open: bool
    until: datetime | None                # open: when it closes; None when it stays open through the 7 days
    opens_at: datetime | None             # closed: when it opens next; None when nothing opens in the 7 days
    refresh_at: datetime                  # the earliest of the boundary, the next local midnight and 25 hours on


def _spans(hours: Sequence[HoursWindow]) -> list[tuple[frozenset[int], int, int]]:
    """Each window as (its weekdays, 0 = Monday; its start and end minute), an end of 00:00 at
    `DAY_END`, as Cedar's hours conditions read it."""
    return [(frozenset(WEEK.index(day) for day in window.days), window.start.hour * 60 + window.start.minute,
             DAY_END if window.end == time(0) else window.end.hour * 60 + window.end.minute) for window in hours]


def _inside(spans: list[tuple[frozenset[int], int, int]], instant: datetime, tz: tzinfo) -> bool:
    """Whether `instant` falls inside a window, on the local day and minute Cedar reads."""
    dow, minute = clock.local_dow_minute(instant, tz)
    return any(dow in days and start <= minute < end for days, start, end in spans)


def _offset_changes(tz: tzinfo, after: datetime, through: datetime) -> list[datetime]:
    """The instants in `(after, through]` at which the zone's offset changes (a clock change), to
    the second: found by probing every hour, then halving the hour that holds one."""
    changes = []
    probe, offset = after, after.astimezone(tz).utcoffset()
    while probe < through:
        step = min(probe + OFFSET_PROBE, through)
        step_offset = step.astimezone(tz).utcoffset()
        if step_offset != offset:
            low, high = math.floor(probe.timestamp()), math.ceil(step.timestamp())
            while high - low > 1:
                middle = (low + high) // 2
                if datetime.fromtimestamp(middle, UTC).astimezone(tz).utcoffset() == offset:
                    low = middle
                else:
                    high = middle
            changes.append(datetime.fromtimestamp(high, UTC))
        probe, offset = step, step_offset
    return [change for change in changes if after < change <= through]


def _candidates(spans: list[tuple[frozenset[int], int, int]], tz: tzinfo, after: datetime,
                through: datetime) -> list[datetime]:
    """Every instant in `(after, through]` at which being open can change, in order: each window's
    start and end on each local date, at both readings of a wall time the clocks repeat, and each
    clock change, which moves the wall clock past a start or an end the clocks skip. Between two of
    them the local minute moves on without crossing a start or an end, so being open stays as it
    was at the earlier one."""
    first, last = after.astimezone(tz).date() - timedelta(days=1), through.astimezone(tz).date() + timedelta(days=1)
    found = set(_offset_changes(tz, after, through))
    day = first
    while day <= last:
        midnight = datetime.combine(day, time(0))
        for days, start, end in spans:
            if day.weekday() not in days:
                continue
            for minute in (start, end):
                wall = midnight + timedelta(minutes=minute)
                found.update(wall.replace(tzinfo=tz, fold=fold).astimezone(UTC) for fold in (0, 1))
        day += timedelta(days=1)
    return sorted(instant for instant in found if after < instant <= through)


def _next_local_midnight(now: datetime, tz: tzinfo) -> datetime | None:
    """The first instant after `now` on the next local date: its 00:00, or, when the clocks skip
    that 00:00, the clock change itself."""
    tomorrow = now.astimezone(tz).date() + timedelta(days=1)
    wall = datetime.combine(tomorrow, time(0))
    readings = (wall.replace(tzinfo=tz, fold=fold).astimezone(UTC) for fold in (0, 1))
    return min((instant for instant in readings if instant > now and instant.astimezone(tz).date() == tomorrow),
               default=None)


def open_window_status(hours: Sequence[HoursWindow], tz: tzinfo, now: datetime) -> OpenWindow | None:
    """Whether the business is open at `now`, from its weekly `hours` in its time zone `tz` ("Open
    status"): open when the local day and minute Cedar's hours checks read (`clock.local_dow_minute`)
    fall inside a window, its end exclusive. Overlapping or touching windows are one span, across
    midnight too: `until` is the first instant after `now` that is closed, or None when every
    instant through the same local time 7 days on is open; when closed, `opens_at` is the first
    instant that is open, or None when none is within those days. `refresh_at` is the earliest of
    that boundary, the next local midnight (so "today" and "tomorrow" stay true) and 25 hours on (a
    local day can be longer). None without windows. Every instant is compared in UTC, since two
    times sharing a zone compare by wall clock across a repeated hour."""
    if now.tzinfo is None:
        raise ValueError("now must be an aware datetime")
    spans = _spans(hours)
    if not spans:
        return None
    now = now.astimezone(UTC)
    local_now = now.astimezone(tz)
    week_on = (local_now.replace(tzinfo=None) + timedelta(days=OPEN_STATUS_DAYS)).replace(
        tzinfo=tz, fold=local_now.fold).astimezone(UTC)
    is_open = _inside(spans, now, tz)
    boundary = next((instant for instant in _candidates(spans, tz, now, week_on)
                     if _inside(spans, instant, tz) != is_open), None)
    refresh_at = min(instant for instant in (boundary, _next_local_midnight(now, tz), now + REFRESH_WITHIN)
                     if instant is not None)
    return OpenWindow(open=is_open, until=boundary if is_open else None, opens_at=None if is_open else boundary,
                      refresh_at=refresh_at)


async def enabled_profiles(ctx: KernelCtx, desk_id: str) -> list[ToolProfile]:
    """The profiles of the Desk's enabled tools, by tool name, from its `tools` rows (`enabled_of`)."""
    return enabled_of(await ctx.db.scalars(ctx.repo.scoped(
        select(Tool).where(Tool.desk_id == desk_id, Tool.status == "enabled").order_by(Tool.tool))))


def enabled_of(rows: Iterable[Tool]) -> list[ToolProfile]:
    """The profiles of the enabled ones of a Desk's `tools` rows, in their order. A row without a
    profile gives Claude nothing to call, so it is left out."""
    return [row.profile.model_copy(update={"status": "enabled"})
            for row in rows if row.status == "enabled" and row.profile is not None]
