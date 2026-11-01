"""Session context (`GET /context/{session_id}`): what Claude is given for one session.

`session_context` answers with:

- `clock`: the kernel's current UTC instant and the business's local date and time, public
  information for every session kind, separate from labelled facts;
- `tools`: the profiles of the tools the session may call now (`decide.tools_given` over the
  Desk's enabled tools, followed by `adapters.resolve`), so stale or unresolved profiles
  cannot grant a next-step exemption;
- `tools_declared`: every profile on the Desk that a session of its kind could ever be given
  (`decide.declared_tools`), in any standing and status, so the API can declare them all when a
  conversation starts and load each one only once it is given;
- `facts` and `knowledge`: the Desk's unexpired facts and its knowledge, each in the order it
  was first written, that the session's labels let it read
  (`labels.session_readers`): the public's and its own session's, its person's once verified;
  the owner reads the business's and the public's. A row with no readers is the owner's alone.
  `labels.can_read` decides each row in Python, so there is one rule for who reads what; a
  Desk's rows stay few in a demo copy, where a real Desk would filter in SQL first. The facts
  start with the Desk's catalog (`catalog_fact`), so Claude knows the `item_id`s `native.quote`
  takes. The seed-only public starter questions (`charter:starter:*`) are left out for every
  session: they are chips on the public page, never business facts for Claude. A visitor's or
  agent's session is never given a row holding one of the copy's document canaries
  (`labels.find_canaries_in`) anywhere Claude would read it, whatever its label: in a
  fact's ID or a claim's key or value, or in a knowledge item's ID, title or text
  (`labels.knowledge_canaries`, which doesn't read again an item it found clean against the same
  canaries, at ingest or here). Knowledge holding one in its title or text is stored owner-only
  (and one in its ID is refused). Owner
  writes of charter policies and price items refuse one (`desks.refuse_public_canaries`); a
  policy stored holding one before that check, in its text or its key, is left out, as on the
  public page, and so is the catalog when such an item's ID or title holds one.

A profile carries what Claude is given, the confirmed description and the adapter's input
schema, and never the text of a changed MCP definition, which only the owner reviews.

The route answers "Session state responses" for `/context`: a session's own token, or the
owner's token for its own session and a Desk of its copy (`desk_id`, which the owner must name).
A bad token is 401, another copy or Desk 404, a closed session or deleted Desk 409 `closed`,
each ledgered `auth` on the Desk of the session it names (logged when it names none of them).
The call carries no generation, and a session the owner took over or the breaker paused still
reads its context.
"""

from fastapi import APIRouter, Request
from sqlalchemy import or_, select

from desk.contracts import Claim, Fact, KnowledgeItem, Label, Principal, ToolProfile
from desk.db.models import Desk, PriceItem, Tool
from desk.db.models import Fact as FactRow
from desk.db.models import KnowledgeItem as KnowledgeRow
from desk.kernel_api import ContextClock, SessionContext
from desk.kernel_service import adapters, auth, clock, decide, desks, labels
from desk.kernel_service.adapters.base import business_timezone
from desk.kernel_service.auth import SessionRow
from desk.kernel_service.repo import Ctx, KernelCtx
from desk.kernel_service.sessions import principal_for


CATALOG = "catalog"


async def catalog_fact(ctx: KernelCtx, desk_id: str) -> Fact | None:
    """The Desk's catalog: a public fact `catalog` holding a text claim per price item, its
    `item_id` as the key and its title as the value, in `item_id` order. None when the Desk sells
    nothing. An item named "hours", a valid item ID that no claim may have as its key, is left
    out rather than fail the session's whole context.

    It is built from `price_items` on each read and never stored, so it is always the current list,
    and no stored fact shares its ID (each of theirs is `<kind>:<id>`). It carries no price,
    amount or unit: an amount reaches a visitor only in the quote card the kernel renders, and no
    clause template reads this fact, so it backs no card."""
    items = (await ctx.db.execute(ctx.repo.scoped(select(PriceItem.item_id, PriceItem.title).where(
        PriceItem.desk_id == desk_id).order_by(PriceItem.item_id)))).all()
    claims = [Claim(key=item_id, kind="text", value=title) for item_id, title in items if item_id != "hours"]
    if not claims:
        return None
    return Fact(fact_id=CATALOG, kind="charter", status="available", source="kernel", claims=claims,
                label=Label(readers=["public"]))


def _profile(row: Tool) -> ToolProfile:
    """The row's profile at the row's status, without a pending MCP definition's text."""
    return row.profile.model_copy(update={"status": row.status, "pending_definition_text": None,
                                          "pending_sha256": None})


async def session_context(ctx: KernelCtx, principal: Principal, session_row: SessionRow,
                          desk_row: Desk) -> SessionContext:
    """The kernel's local time, tools, facts and knowledge given to the authenticated session."""
    from desk.kernel_service.adapters import blocks

    desk_id = desk_row.desk_id
    rows = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.desk_id == desk_id).order_by(Tool.tool)))
    profiles = {row.tool: _profile(row) for row in rows if row.profile is not None}
    given = await resolved_tools(ctx, principal, session_row, desk_row)
    declared = decide.declared_tools(principal.kind)
    valid_business = {tool for tool, profile in profiles.items() if profile.source == "business"
                      and profile.status == "enabled"
                      and profile.business is not None and profile.business.config.block in blocks.SUPPORTED_BLOCKS
                      and await adapters.resolve(ctx, desk_id, tool) is not None}
    if principal.kind in ("visitor", "agent"):
        declared = declared | valid_business

    readers = labels.session_readers(session_row)
    # the owner reads the business's own text; a conversation is never given a document's canary
    canaries = labels.NO_CANARIES if session_row.kind == "owner" else await labels.copy_canaries(ctx)
    now = ctx.clock.now()
    tz = await business_timezone(ctx, desk_row)
    local = now.astimezone(tz)
    facts = await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.status != "expired",
        desks.not_starter(),
        or_(FactRow.expires_at.is_(None), FactRow.expires_at > now)).order_by(FactRow.created_at, FactRow.fact_id)))
    knowledge = await ctx.db.scalars(ctx.repo.scoped(
        select(KnowledgeRow).where(KnowledgeRow.desk_id == desk_id).order_by(KnowledgeRow.created_at,
                                                                               KnowledgeRow.item_id)))
    catalog = await catalog_fact(ctx, desk_id)
    readable = [*([catalog] if catalog is not None and labels.can_read(catalog.label, readers) else []),
                *(labels.fact_of(row) for row in facts if labels.can_read(row.readers, readers))]
    return SessionContext(
        clock=ContextClock(as_of_utc=clock.signed_time(now), local_now=local.isoformat(timespec="minutes"),
                           local_date=local.date().isoformat(),
                           weekday=("mon", "tue", "wed", "thu", "fri", "sat", "sun")[local.weekday()],
                           timezone=tz.key),
        tools=given,
        tools_declared=[profile for tool, profile in profiles.items() if tool in declared],
        facts=[fact for fact in readable
               if not labels.find_canaries_in([fact.fact_id, *((claim.key, claim.value) for claim in fact.claims)],
                                              canaries)],
        knowledge=[KnowledgeItem(item_id=row.item_id, source=row.source, title=row.title, text=row.text,
                                 label=labels.label_of(row.readers))
                   for row in knowledge if labels.can_read(row.readers, readers)
                   and not labels.knowledge_canaries(row.item_id, row.title, row.text, canaries)],
    )


async def resolved_tools(ctx: KernelCtx, principal: Principal, session_row: SessionRow,
                         desk_row: Desk) -> list[ToolProfile]:
    """The callable session tools, after adapter resolution; shared with the reply check."""
    enabled = await decide.enabled_tools(ctx, desk_row.desk_id)
    given = decide.tools_given(principal, session_row, desk_row, enabled)
    return [_profile(enabled[tool]) for tool in sorted(given) if await _resolves(ctx, desk_row.desk_id, enabled[tool])]


async def _resolves(ctx: KernelCtx, desk_id: str, row: Tool) -> bool:
    """An enabled row's profile still matches its pin, and its adapter resolves."""
    return (adapters.profile_sha256(row.profile) == row.profile_sha256
            and await adapters.resolve(ctx, desk_id, row.tool) is not None)


async def business_free_names(ctx: KernelCtx, desk_id: str) -> list[str]:
    """The titles and appointment types (`blocks.free_name_fields`: never a payment's title) of the
    Desk's enabled business tools that resolve, by the checks `resolved_tools` makes, in tool order:
    the names inside whose repeat the reply check lets a free word stand in Claude's prose
    (`reply_check.scan_prose`'s `approved_free_names`, the owner's decision of 2026-10-31).
    Desk-wide, whichever tools the session is given."""
    from desk.kernel_service.adapters import blocks

    enabled = await decide.enabled_tools(ctx, desk_id)
    names: list[str] = []
    for tool in sorted(enabled):
        row = enabled[tool]
        if row.source == "business" and row.profile.business is not None and await _resolves(ctx, desk_id, row):
            definition = row.profile.business
            names += [getattr(definition if field == "title" else definition.config, field)
                      for field in blocks.free_name_fields(definition.config.block)]
    return names


router = APIRouter()


@router.get("/context/{session_id}", response_model=SessionContext)
async def get_context(session_id: str, ctx: Ctx, request: Request, desk_id: str | None = None) -> SessionContext:
    session_row, desk_row = await auth.require_caller(ctx, request, session_id, desk_id)
    return await session_context(ctx, principal_for(session_row, desk_id=desk_row.desk_id), session_row, desk_row)
