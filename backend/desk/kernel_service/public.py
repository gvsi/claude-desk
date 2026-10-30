"""GET /public/{desk_slug}: what anyone may read about a Desk, with no session.

The public page's header and charter: the business and Desk names, the owner's display name, the
brand colors, and the Desk's `public`-labelled charter facts rendered by the clause templates in
the language asked for (`?lang=es`, else English): its hours, its contact, then its policies. A
charter fact with nothing to show (hours with no windows) or carrying a document canary is left
out. Nothing else is read: no people, prices, quotes, bookings or documents. `agent_card` stays
empty until Plan 01c.

`open_status` is the header's open-now line ("Open status"), computed from the same `charter:hours`
fact in the business's time zone on the kernel's clock (`desks.open_window_status`), with its text
in the language asked for. It is None when the Desk has no current hours fact or no windows in it,
so a Desk without hours claims neither open nor closed, and None, logged as `open_status_failed`
with nothing of the Desk's, when computing it fails or it can't name its boundary: the rest of the
page is still served.

The slug is the only key, found through the copy resolver (`repo.copy_of_desk_slug`); a slug no
Desk could have, an unknown one or a deleted Desk's is 404 `not_found`. The read writes nothing,
so it has no ledger entry.
"""

import logging
import re
from collections.abc import Sequence
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import select

from desk.contracts import Clause, Fact, HoursWindow, RenderedBlock
from desk.db.models import Business, Desk
from desk.db.models import Fact as FactRow
from desk.kernel_api import OpenStatus, PublicDesk
from desk.kernel_service import desks, labels, render, reply_check, repo
from desk.kernel_service.render.cards import DeskInfo, NothingToShow, hours_windows
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure

log = logging.getLogger(__name__)

SLUG = re.compile(r"[a-z0-9-]{1,64}")
CHARTER_TEMPLATES = ("hours", "contact", "policy")          # in the order the page shows them
PUBLIC = frozenset({"public"})


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
    rows = await ctx.db.scalars(copy.scoped(select(FactRow).where(
        FactRow.desk_id == desk.desk_id, FactRow.kind == "charter").order_by(FactRow.fact_id)))
    facts = [labels.fact_of(row) for row in rows if labels.can_read(row.readers, PUBLIC)]
    info = DeskInfo(owner_display_name=business.owner_display_name, timezone=business.timezone)
    canaries = await labels.copy_canaries(ctx)
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
            if not reply_check.carries(block, canaries):
                charter.append(block)
    return PublicDesk(business_name=business.name, desk_name=desk.name, owner_display_name=business.owner_display_name,
                      brand=business.brand, charter=charter, agent_card=[],
                      open_status=_open_status(facts, info, now, lang))


router = APIRouter()


@router.get("/public/{desk_slug}", response_model=PublicDesk)
async def get_public_desk(desk_slug: str, ctx: Ctx, lang: str | None = None) -> PublicDesk:
    return await public_desk(ctx, desk_slug, render.language(lang))
