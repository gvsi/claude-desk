"""Desks: the one path that turns a `DeskSeed` into kernel rows, and contacts on record.

`create_desk` serves `POST /copies` (the Rivera seed) here and `POST /desks` in Plan 01b. It runs
in the caller's transaction and never commits, so a Desk and its `desk_data` ledger entry exist
together or not at all.

A seed is checked before anything is written (`InvalidSeed`, 422 `invalid` on owner routes): the
owner's display name goes into visitor status lines, so it is letters, spaces, hyphens and
apostrophes only; hours live in `DeskSeed.hours`, never in a charter claim; and the time zone, the
documents' record owners and the contacts on record must be usable.

Contacts on record are kept three ways: `contact` as given (verification codes go only there),
`contact_norm` for lookups, and `masked_contact`, the only form any view, notice or owner alert
shows.
"""

import json
import re
import secrets
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import desk_kernel
from sqlalchemy import select

from desk.contracts import BusinessSeed, Claim, DeskSeed, Fact, Label, LedgerEvent, ToolProfile
from desk.db.models import Business, CalendarSlot, Desk, Document, NotificationPref, Person, PriceItem, Tool
from desk.db.models import Fact as FactRow
from desk.kernel_api import DeskCreated
from desk.kernel_service import adapters, ledger
from desk.kernel_service.repo import KernelCtx, KernelFailure, new_id

OWNER_DISPLAY_NAME = re.compile(r"[A-Za-zÀ-ÿ' -]{1,40}")
SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
SLUG_SUFFIX_LENGTH = 6
SLUG_NAME_LENGTH = 40
MASK = "•••"


class InvalidSeed(KernelFailure):
    """A Desk seed the kernel won't write; `reason` (internal) names the check that failed."""

    def __init__(self, reason: str):
        super().__init__(422, "invalid", reason)


def validate_business(business: BusinessSeed) -> None:
    name = business.owner_display_name
    if not OWNER_DISPLAY_NAME.fullmatch(name) or not any(ch.isalpha() for ch in name):
        raise InvalidSeed("owner_display_name")
    try:
        ZoneInfo(business.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise InvalidSeed("timezone") from None


def validate_desk(desk: DeskSeed) -> None:
    if any(claim.key == "hours" for claim in desk.charter):
        raise InvalidSeed("hours_claim")
    if any(not normalize_contact(person.contact) for person in desk.people):
        raise InvalidSeed("contact")
    refs = {person.ref for person in desk.people}
    if any(document.record_owner_ref not in (None, *refs) for document in desk.documents):
        raise InvalidSeed("record_owner_ref")


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


def fact_row(copy_id: str, desk_id: str, fact: Fact, created_at: datetime) -> FactRow:
    return FactRow(desk_id=desk_id, fact_id=fact.fact_id, copy_id=copy_id, kind=fact.kind, status=fact.status,
                   claims=fact.claims, readers=fact.label.readers, record_owner=fact.label.record_owner,
                   expires_at=fact.expires_at, source=fact.source, created_at=created_at)


def hours_claim(desk: DeskSeed) -> Claim:
    """Fact `charter:hours`'s one claim: the canonical JSON of the Desk's hours windows."""
    windows = json.dumps([window.model_dump(mode="json") for window in desk.hours])
    return Claim(key="windows", kind="text", value=desk_kernel.canonical_json(windows))


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
        person_ids[person.ref] = new_id("person")
        ctx.db.add(Person(person_id=person_ids[person.ref], copy_id=copy_id, desk_id=desk_id, ref=person.ref,
                          display_name=person.display_name, contact=person.contact.strip(),
                          contact_norm=normalize_contact(person.contact), masked_contact=mask_contact(person.contact),
                          notes=person.notes, created_at=now))
    ctx.db.add_all(PriceItem(desk_id=desk_id, item_id=item.item_id, copy_id=copy_id, title=item.title,
                             unit_cents=item.unit_cents) for item in desk.price_items)
    ctx.db.add_all(CalendarSlot(desk_id=desk_id, slot_id=slot.slot_id, copy_id=copy_id, starts_at=slot.starts_at,
                                minutes=slot.minutes) for slot in desk.calendar_slots)
    for document in desk.documents:
        document_id, canary = new_id("doc"), new_canary()
        owner_id = person_ids[document.record_owner_ref] if document.record_owner_ref else None
        ctx.db.add(Document(document_id=document_id, copy_id=copy_id, desk_id=desk_id, ref=document.ref,
                            title=document.title, record_owner_person_id=owner_id,
                            body=f"{document.body}\n\nReference {canary}", canary=canary, created_at=now))
        readers = ["owner", f"person:{owner_id}"] if owner_id else ["owner"]
        ctx.db.add(fact_row(copy_id, desk_id, Fact(
            fact_id=f"document:{document_id}", kind="document", status="available", source="kernel",
            claims=[Claim(key="title", kind="text", value=document.title)],
            label=Label(readers=readers, record_owner=owner_id)), now))
    ctx.db.add(NotificationPref(desk_id=desk_id, copy_id=copy_id, now=desk.notifications.now,
                                briefing=desk.notifications.briefing))
    ctx.db.add_all(tool_row(copy_id, desk_id, profile) for profile in adapters.registered_profiles(source="native"))
    public = Label(readers=["public"])
    for claim in desk.charter:
        ctx.db.add(fact_row(copy_id, desk_id, Fact(fact_id=f"charter:{claim.key}", kind="charter", status="available",
                                                   source="kernel", claims=[claim], label=public), now))
    ctx.db.add(fact_row(copy_id, desk_id, Fact(fact_id="charter:hours", kind="charter", status="available",
                                               source="kernel", claims=[hours_claim(desk)], label=public), now))
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="desk_data", origin="kernel", summary={"part": "desk", "created": True}))
    return DeskCreated(desk_id=desk_id, slug=slug)


async def enabled_profiles(ctx: KernelCtx, desk_id: str) -> list[ToolProfile]:
    """The profiles of the Desk's enabled tools, by tool name, from its `tools` rows. A row without
    a profile gives Claude nothing to call, so it is left out."""
    rows = await ctx.db.scalars(ctx.repo.scoped(
        select(Tool).where(Tool.desk_id == desk_id, Tool.status == "enabled").order_by(Tool.tool)))
    return [row.profile.model_copy(update={"status": "enabled"}) for row in rows if row.profile is not None]
