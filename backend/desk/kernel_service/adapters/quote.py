"""`native.quote`: a quote priced from the Desk's price list, never from the call's arguments.

The call names price-list items and quantities, and may ask for a discount and carry a note.
`normalize` prices it from `price_items`: an item that isn't on the list is refused at step 1,
`list_cents` is the sum of unit price times quantity (over $10,000 is refused), `discount_bp` is
the visitor's request (untrusted: the owner's cards decide whether it is auto-allowed, held or
refused) and `amount_cents` follows the master plan's "Discounts". No argument can name a price.

`execute` writes a `quotes` row good for 72 hours and a `quote:<id>` fact labelled for the
session, which the quote card renders. Claude sees the items and the fact to cite, not prices.
"""

from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from desk.contracts import ITEM_ID_PATTERN, Claim, Fact, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import Fact as FactRow
from desk.db.models import PriceItem, Quote
from desk.kernel_service import labels
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterFailure, AdapterRefusal, AdapterResult, ExecCtx, Normalized,
                                               NormalizeCtx, business_timezone)
from desk.kernel_service.repo import KernelCtx, new_id

MAX_LIST_CENTS = 1_000_000                # $10,000: the most one quote may come to before any discount
QUOTE_TTL = timedelta(hours=72)


class QuoteItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    item_id: str = Field(pattern=ITEM_ID_PATTERN)
    qty: int = Field(ge=1, le=10)


class QuoteArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    items: list[QuoteItem] = Field(min_length=1, max_length=5)
    requested_discount_bp: int = Field(0, ge=0, le=10_000)
    note: str | None = Field(None, max_length=200)      # visitor text: quoted to the owner, untrusted to the reviewer


PROFILE = ToolProfile(
    tool="native.quote", source="native", effects=["change"], reversible=True,
    adapter="desk.kernel_service.adapters.quote", resource_kind="desk",
    description_confirmed=(
        "Quotes a job from the business's price list. Name the price-list items and how many of each. The price "
        "comes from the business's records and the visitor sees it in a quote card, never in your own words. If "
        "the visitor asks for a discount, pass it as requested_discount_bp (hundredths of a percent); the "
        "owner's rules decide whether it applies."),
    input_schema=QuoteArgs.model_json_schema(), status="enabled")


async def price(ctx: KernelCtx, desk_id: str, items: Sequence[QuoteItem]) -> tuple[list[dict[str, Any]], int]:
    """The quote's lines from the Desk's price list (`item_id`, `title`, `qty`, `unit_cents`) and
    their total. An item that isn't on the list, or a total over `MAX_LIST_CENTS`, refuses."""
    wanted = sorted({item.item_id for item in items})
    listed = {row.item_id: row for row in await ctx.db.scalars(ctx.repo.scoped(
        select(PriceItem).where(PriceItem.desk_id == desk_id, PriceItem.item_id.in_(wanted))))}
    if set(wanted) - set(listed):
        raise AdapterRefusal("unknown_item")
    lines = [{"item_id": item.item_id, "title": listed[item.item_id].title, "qty": item.qty,
              "unit_cents": listed[item.item_id].unit_cents} for item in items]
    list_cents = sum(line["unit_cents"] * line["qty"] for line in lines)
    if list_cents > MAX_LIST_CENTS:
        raise AdapterRefusal("over_limit")
    return lines, list_cents


def discounted(list_cents: int, discount_bp: int) -> int:
    """The master plan's "Discounts": `list_cents - list_cents * discount_bp // 10_000`."""
    return list_cents - list_cents * discount_bp // 10_000


def items_text(lines: Sequence[dict[str, Any]]) -> str:
    """The quote's items as its card lists them: titles from the price list, with a count past one."""
    return ", ".join(line["title"] if line["qty"] == 1 else f"{line['title']} × {line['qty']}" for line in lines)


def model_view(fact_id: str, quote_id: str, lines: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """What Claude sees of a quote: the fact to cite and the items, without prices."""
    return {"fact_id": fact_id, "quote_id": quote_id, "status": "available",
            "items": [{"item_id": line["item_id"], "title": line["title"], "qty": line["qty"]} for line in lines]}


async def written_quote(ctx: KernelCtx, action: NormalizedAction) -> tuple[Quote, Fact] | None:
    """This action's quote and its exact fact, if already written, even alongside link facts."""
    existing = (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(
        Quote.action_id == action.action_id)))).one_or_none()
    if existing is not None:
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.fact_id == f"quote:{existing.quote_id}",
            FactRow.action_id == action.action_id, FactRow.kind == "quote")))).one()
        return existing, labels.fact_of(row)
    return None


async def write_quote(xctx: ExecCtx, action: NormalizedAction, lines: list[dict[str, Any]]) -> tuple[Quote, Fact]:
    """Write one action's priced quote and session-labelled fact in the caller's transaction.

    The execution framework serializes retries by action; the unique action_id also fences writes.
    Reconciliation may find the quote already committed and returns that same fact.
    """
    ctx = xctx.ctx
    if (existing := await written_quote(ctx, action)) is not None:
        return existing
    now = ctx.clock.now()
    expires_at = now + QUOTE_TTL
    tz = await business_timezone(ctx, xctx.desk_row)
    session_id = xctx.session_row.session_id
    quote_id = new_id("quote")
    fact = Fact(fact_id=f"quote:{quote_id}", kind="quote", status="available", source="kernel", claims=[
        Claim(key="items", kind="text", value=items_text(lines)),
        Claim(key="list", kind="money", value=action.list_cents),
        Claim(key="total", kind="money", value=action.amount_cents),
        Claim(key="discount", kind="percent_bp", value=action.discount_bp),
        Claim(key="expires", kind="datetime", value=expires_at.astimezone(tz).isoformat()),
    ], label=labels.new_fact_label(xctx.session_row), expires_at=expires_at)
    ctx.db.add(Quote(quote_id=quote_id, copy_id=action.copy_id, desk_id=action.desk_id, session_id=session_id,
                     items=lines, list_cents=action.list_cents, discount_bp=action.discount_bp, amount_cents=action.amount_cents,
                     status="available", expires_at=expires_at, action_id=action.action_id, created_at=now))
    ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, now, session_id=session_id,
                               action_id=action.action_id))
    await ctx.db.flush()
    quote = (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(Quote.quote_id == quote_id)))).one()
    return quote, fact


class QuoteAdapter:
    profile = PROFILE
    Args = QuoteArgs
    free_text_fields = frozenset({"note"})
    model_view_keys = frozenset({"fact_id", "quote_id", "items", "status"})
    releases_private_data = False         # the session's own quote from the price list

    async def normalize(self, nctx: NormalizeCtx, args: QuoteArgs) -> Normalized:
        desk_id = nctx.desk_row.desk_id
        _, list_cents = await price(nctx.ctx, desk_id, args.items)
        discount_bp = args.requested_discount_bp
        return Normalized(resource=ResourceRef(kind="desk", id=desk_id, owner_person_id=None), list_cents=list_cents,
                          discount_bp=discount_bp, amount_cents=discounted(list_cents, discount_bp))

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: QuoteArgs) -> AdapterResult:
        """The quote at the action's prices, which the execution re-check has just priced again;
        a price list that changed since then fails it before anything is written."""
        ctx = xctx.ctx
        try:
            lines, list_cents = await price(ctx, action.desk_id, args.items)
        except AdapterRefusal:
            raise AdapterFailure("price_changed") from None
        discount_bp = args.requested_discount_bp
        if (list_cents, discount_bp, discounted(list_cents, discount_bp)) != (
                action.list_cents, action.discount_bp, action.amount_cents):
            raise AdapterFailure("price_changed")
        quote, fact = await write_quote(xctx, action, lines)
        return AdapterResult(facts=[fact], model_view=model_view(fact.fact_id, quote.quote_id, lines))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """The quote the action wrote, if it wrote one."""
        ctx = xctx.ctx
        quote = (await ctx.db.scalars(ctx.repo.scoped(
            select(Quote).where(Quote.action_id == action.action_id)))).one_or_none()
        if quote is None:
            return None
        fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id)))).one()
        return AdapterResult(facts=[labels.fact_of(fact)], model_view=model_view(fact.fact_id, quote.quote_id,
                                                                                  quote.items))


ADAPTER = register(QuoteAdapter())
