"""GET /public/{desk_slug}: what anyone may read about a Desk, with no session.

The public page's header and charter: the business and Desk names, the owner's display name, the
brand colors, and the Desk's `public`-labelled charter facts rendered by the clause templates in
the language asked for (`?lang=es`, else English): its hours, its contact, then its policies. A
charter fact with nothing to show (hours with no windows) or carrying a document canary is left
out. Nothing else is read: no people, prices, quotes, bookings or documents. `agent_card` stays
empty until Plan 01c, and `open_status` is left out until the contract carries it.

The slug is the only key, found through the copy resolver (`repo.copy_of_desk_slug`); a slug no
Desk could have, an unknown one or a deleted Desk's is 404 `not_found`. The read writes nothing,
so it has no ledger entry.
"""

import re

from fastapi import APIRouter
from sqlalchemy import select

from desk.contracts import Clause, RenderedBlock
from desk.db.models import Business, Desk
from desk.db.models import Fact as FactRow
from desk.kernel_api import PublicDesk
from desk.kernel_service import labels, render, reply_check, repo
from desk.kernel_service.render.cards import DeskInfo
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure

SLUG = re.compile(r"[a-z0-9-]{1,64}")
CHARTER_TEMPLATES = ("hours", "contact", "policy")          # in the order the page shows them
PUBLIC = frozenset({"public"})


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
                      brand=business.brand, charter=charter, agent_card=[])


router = APIRouter()


@router.get("/public/{desk_slug}", response_model=PublicDesk)
async def get_public_desk(desk_slug: str, ctx: Ctx, lang: str | None = None) -> PublicDesk:
    return await public_desk(ctx, desk_slug, render.language(lang))
