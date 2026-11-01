"""GET /public/{desk_slug}: what anyone may read about a Desk, with no session.

The public page's header and charter: the business and Desk names, the owner's display name, the
brand colors, and the Desk's `public`-labelled charter facts rendered by the clause templates in
the language asked for (`?lang=es`, else English): its hours, its contact, then its policies. A
charter fact with nothing to show (hours with no windows) or carrying a document canary is left
out; owner writes of the charter refuse a canary (`desks.refuse_public_canaries`), so only one
stored before that check could carry it. Nothing else is read: no people, prices, quotes,
bookings or documents. `agent_card` is how a visiting agent talks to the Desk, in prose the kernel
writes (`render.agent_card`): the tools an agent session may be given on this Desk now (its enabled
tools with an adapter, of those an agent declares, kept to lead capture and callbacks while
Answering is off), by plain label, the endpoint, how to sign, and that agent keys aren't business
credentials. It names the business and the owner as the header shows them, so a name the header
withholds is withheld there too, and said in fixed words instead ("this business", "the owner"), and
a block carrying a canary is left out.

`open_status` is the header's open-now line ("Open status"), computed from the same `charter:hours`
fact in the business's time zone on the kernel's clock (`desks.open_window_status`), with its text
in the language asked for. It is None when the Desk has no current hours fact or no windows in it,
so a Desk without hours claims neither open nor closed, and None, logged as `open_status_failed`
with nothing of the Desk's, when computing it fails or it can't name its boundary: the rest of the
page is still served.

`starters` are the seed's three questions in the requested language, from separate text claims
`starter:<n>:<lang>`. They are trimmed, limited to 80 characters and checked for canaries, never
rendered as charter cards. A failed read logs only the error's type and serves an empty list.

The header's names are the owner's words as typed, and its brand colors are the business's palette
pick as `effective_brand` reads it (teal when it stored none, free-form colors from before the
palette as stored). Owner writes check them for document canaries (`desks.refuse_public_canaries`),
as they check the slug a new Desk's address is made from. One stored before that check and
holding a canary of the copy's documents, even split or disguised (`labels.canary_fields`), is
withheld: the page shows the field's fallback (an empty name, no brand colors) and the owner is
alerted in the Demo inbox, whatever their notification defaults, at most once an hour per Desk.

A stored policy line that fails the public-text scan is withheld individually. The remaining
policies are rescanned in display order after each removal. The owner isn't alerted (the owner's
decision of 2026-11-01): the line is simply left out.

The slug is the only key, found through the copy resolver (`repo.copy_of_desk_slug`); a slug no
Desk could have, an unknown one or a deleted Desk's is 404 `not_found`. The read writes nothing
but that alert, so it has no ledger entry.
"""

import logging
import re
from collections.abc import Mapping, Sequence
from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import select

from desk.public_contact import valid_public_contact
from desk.contracts import Clause, Fact, HoursWindow, RenderedBlock, effective_brand
from desk.db.models import Business, Desk
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import OpenStatus, PublicDesk
from desk.kernel_service import adapters, decide, demo_inbox, desks, labels, render, reply_check, repo
from desk.kernel_service.render.cards import DeskInfo, NothingToShow, hours_windows
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure

log = logging.getLogger(__name__)

SLUG = re.compile(r"[a-z0-9-]{1,64}")
CHARTER_TEMPLATES = ("hours", "contact", "policy")          # in the order the page shows them
PUBLIC = frozenset({"public"})

# The header's owner-typed fields, each with what the page shows when it is withheld, and what the
# owner's alert calls it (owner-only, in English, like every alert).
HEADER_FALLBACKS: dict[str, Any] = {"business_name": "", "desk_name": "", "owner_display_name": "", "brand": {}}
HEADER_WORDS = {"business_name": "business name", "desk_name": "Desk name", "owner_display_name": "display name",
                "brand": "brand colors"}
WITHHELD_ALERT_EVERY = timedelta(hours=1)


def withheld_alert(fields: Sequence[str]) -> str:
    """The owner's alert that the page left out `fields` (header field names)."""
    words = [HEADER_WORDS[field] for field in fields]
    named = words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"
    it = "it" if len(words) == 1 else "them"
    return (f"Text from one of your private documents is in your {named}, so your public page doesn't show {it}. "
            f"Change {it} to show {it} again.")


def header_of(desk: Desk, business: Business, canaries: Mapping[str, str]) -> tuple[dict[str, Any], list[str]]:
    """The page's header as it is served, each field holding a canary of `canaries`, however
    written or split (`labels.canary_fields`), in its fallback; and the fields withheld. The mock
    checkout names the business by this header's name too (`payments.link_view`)."""
    header: dict[str, Any] = {"business_name": business.name, "desk_name": desk.name,
                              "owner_display_name": business.owner_display_name,
                              "brand": effective_brand(business.brand)}
    withheld = labels.canary_fields(header, canaries)
    return header | {field: deepcopy(HEADER_FALLBACKS[field]) for field in withheld}, withheld


async def _alert_withheld(ctx: KernelCtx, desk_id: str, fields: Sequence[str]) -> None:
    """Tells the owner the page left out `fields`, unless it did within the hour."""
    preview, now = render.owner_preview("public_page"), ctx.clock.now()
    recent = await ctx.db.scalars(ctx.repo.scoped(select(DemoInboxRow.entry_id).where(
        DemoInboxRow.desk_id == desk_id, DemoInboxRow.kind == "alert", DemoInboxRow.preview == preview,
        DemoInboxRow.created_at > now - WITHHELD_ALERT_EVERY).limit(1)))
    if recent.first() is not None:
        return
    await demo_inbox.deliver(ctx, copy_id=ctx.copy_id, desk_id=desk_id, to="owner", person_id=None, kind="alert",
                             body=withheld_alert(fields), preview=preview)


def open_status(hours: Sequence[HoursWindow], timezone: str, now: datetime, lang: render.Language) -> OpenStatus | None:
    """The open-now line for weekly `hours` in the business's `timezone` at `now`, its text in
    `lang`; None without windows. A closed business with no opening in the week ahead (windows only
    in hours the clocks skip), like any failure, raises; so does a line `OpenStatus` refuses."""
    tz = ZoneInfo(timezone)
    window = desks.open_window_status(hours, tz, now)
    if window is None:
        return None
    boundary = window.until if window.open else window.opens_at
    if not window.open and boundary is None:
        raise ValueError("closed with no opening in the week ahead")
    return OpenStatus(open=window.open, until=window.until, opens_at=window.opens_at,
                      text=render.open_status_text(window.open, boundary, now, lang, tz), as_of=now,
                      refresh_at=window.refresh_at)


def _open_status(facts: list[Fact], info: DeskInfo, now: datetime, lang: render.Language) -> OpenStatus | None:
    """`open_status` from the Desk's current public hours fact, None without one; a failure is
    logged, naming only the error's type, and answered None."""
    hours = render.TEMPLATES["hours"]
    fact = next((fact for fact in facts if hours.reads(fact) and hours.current(fact, now)), None)
    if fact is None:
        return None
    try:
        return open_status(hours_windows(fact), info.timezone, now, lang)
    except NothingToShow:
        return None                                       # hours with no windows
    except Exception as error:
        log.warning("open_status_failed error=%s", type(error).__name__)
        return None


def starters(rows: Sequence[FactRow], canaries: Mapping[str, str], now: datetime,
             lang: render.Language) -> list[str]:
    """Up to three seed-only questions in `lang`, kept separate from charter cards and prose."""
    by_id = {row.fact_id: row for row in rows}
    questions = []
    for n in (1, 2, 3):
        key = f"{desks.STARTER_KEY_PREFIX}{n}:{lang}"
        row = by_id.get(f"{desks.STARTER_FACT_PREFIX}{n}:{lang}")
        if row is None or not labels.can_read(row.readers, PUBLIC):
            continue
        fact = labels.fact_of(row)
        if fact.status != "available" or (fact.expires_at is not None and fact.expires_at <= now):
            continue
        claim = next((claim for claim in fact.claims if claim.key == key and claim.kind == "text"), None)
        if claim is not None:
            text = claim.value.strip()
            if 0 < len(text) <= 80 and not labels.find_canaries_in([text], canaries):
                questions.append(text)
    return questions


def _starters(rows: Sequence[FactRow], canaries: Mapping[str, str], now: datetime,
              lang: render.Language) -> list[str]:
    """A failed starter read leaves the public page intact; log only the error's type."""
    try:
        return starters(rows, canaries, now, lang)
    except Exception as error:
        log.warning("starters_failed error=%s", type(error).__name__)
        return []


async def public_desk(ctx: KernelCtx, slug: str, lang: render.Language) -> PublicDesk:
    """The Desk `slug` names, as anyone may read it, its charter cards in `lang`."""
    copy_id = await repo.copy_of_desk_slug(ctx, slug) if SLUG.fullmatch(slug) else None
    if copy_id is None:
        raise KernelFailure(404, "not_found", "unknown_desk")
    copy = ctx.bind(copy_id)
    desk, business = (await ctx.db.execute(copy.scoped(select(Desk, Business).join(
        Business, Business.business_id == Desk.business_id).where(Desk.slug == slug)))).one()
    if desk.deleted_at is not None:
        raise KernelFailure(404, "not_found", "deleted_desk")
    # Match the policy write scan's order regardless of the database's default collation.
    rows = list(await ctx.db.scalars(copy.scoped(select(FactRow).where(
        FactRow.desk_id == desk.desk_id, FactRow.kind == "charter").order_by(FactRow.fact_id.collate("C")))))
    facts = [labels.fact_of(row) for row in rows if labels.can_read(row.readers, PUBLIC)
             and not desks.is_starter_fact(row.fact_id)]
    canaries = await labels.copy_canaries(ctx)
    header, withheld = header_of(desk, business, canaries)
    if withheld:
        await _alert_withheld(ctx, desk.desk_id, withheld)
    info = DeskInfo(owner_display_name=header["owner_display_name"], timezone=business.timezone)
    now = ctx.clock.now()
    charter: list[RenderedBlock] = []
    for name in CHARTER_TEMPLATES:
        template = render.TEMPLATES[name]
        for fact in facts:
            if not (template.reads(fact) and template.current(fact, now)):
                continue
            try:
                block = render.render_clause(Clause(template=name, fact_id=fact.fact_id), fact, lang, info)
            except render.NothingToShow:
                continue
            if name == "contact" and not valid_public_contact(block.text):
                continue
            if not reply_check.carries(block, canaries):
                charter.append(block)
    # Scan only the policies that survived visibility, currentness and canary filtering,
    # in the order the visitor receives them. Remove only contributing lines, then rescan:
    # removing one line can bring formerly separated promise fragments together.
    # Remove individual failures first, so their language evidence cannot withhold honest neighbors.
    # The owner isn't alerted (the owner's decision of 2026-11-01).
    failing = {fact_id for block in charter for fact_id in reply_check.policy_card_rules("", [block])}
    charter = [block for block in charter if block.fact_id not in failing]
    while refused := reply_check.policy_card_rules("", charter):
        charter = [block for block in charter if block.fact_id not in refused]
    tools = set(await decide.enabled_tools(ctx, desk.desk_id)) & decide.declared_tools("agent") & set(adapters.ADAPTERS)
    if not desk.answering:
        tools &= decide.ANSWERING_OFF_TOOLS
    card = render.agent_card(lang, business=header["business_name"], owner=header["owner_display_name"],
                             slug=desk.slug, tools=tools)
    return PublicDesk(**header, charter=charter,
                      agent_card=[block for block in card if not reply_check.carries(block, canaries)],
                      open_status=_open_status(facts, info, now, lang), starters=_starters(rows, canaries, now, lang))


router = APIRouter()


@router.get("/public/{desk_slug}", response_model=PublicDesk)
async def get_public_desk(desk_slug: str, ctx: Ctx, lang: str | None = None) -> PublicDesk:
    return await public_desk(ctx, desk_slug, render.language(lang))
