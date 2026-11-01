"""Owner-only whole replacement of a Desk's trusted block configurations."""

import re
from collections.abc import Iterable, Mapping
from functools import partial

from fastapi import APIRouter, Request
from sqlalchemy import select

from desk.contracts import BusinessTool, BusinessToolDef, LedgerEvent
from desk.db.models import Tool
from desk.kernel_api import BusinessToolsRequest, DeskUpdated
from desk.kernel_service import adapters, desks, labels, ledger, reply_check
from desk.kernel_service.adapters import blocks
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, storable

router = APIRouter()
# Owner decision (2026-10-31): payment titles may say neither free nor complimentary.
PAYMENT_TITLE_REFUSED_WORDS = frozenset({"free", "complimentary"})
INDEXED_KEY = re.compile(r"\.\d+-([^.]+)$")     # `<tool>.<index>-<field>`, the index only orders the scan


def config_texts(value):
    """Every string in the batch, before JSON escaping can conceal an unstorable character."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from config_texts(item)
    elif isinstance(value, list):
        for item in value:
            yield from config_texts(item)


def public_fields(tool: BusinessTool) -> dict[str, str]:
    """One tool's visitor-facing fields, keyed `<tool>.<index>-<field>` by render position; never its
    structured amount. The shared scan reads keys sorted, so with one digit per index (no block has
    more than 10 card fields) sorted order is render order."""
    return {f"{tool.tool}.{index}-{field}": getattr(tool if field == "title" else tool.config, field)
            for index, field in enumerate(blocks.CARD_FIELDS[tool.config.block])}


def free_allow_words(tool: BusinessTool) -> dict[str, frozenset[str]]:
    """The shared free words, allowed in a title or appointment type only, and never on a payment's
    card (`blocks.free_name_fields`, which the reply check's names also come from)."""
    fields = blocks.free_name_fields(tool.config.block)
    return {f"{tool.tool}.{index}-{field}": reply_check.FREE_WORDS
            for index, field in enumerate(blocks.CARD_FIELDS[tool.config.block]) if field in fields}


def payment_title_refused_fields(tool: BusinessTool) -> list[str]:
    if tool.config.block == "purpose_payment" and any(
            set(re.findall(r"\w+", reading.casefold())) & PAYMENT_TITLE_REFUSED_WORDS
            for reading in reply_check._readings(reply_check.shown(tool.title))):
        return [key for key in public_fields(tool) if key.endswith("-title")]
    return []


def unindexed_detail(fields: Mapping[str, Iterable[str]]) -> dict[str, list[str]]:
    """A refusal's detail under setup's stable `<tool>.<field>` keys, in the closed rule set:
    `format_control` stays, and every other rule the scan names is `public_promise`."""
    detail: dict[str, set[str]] = {}
    for key, rules in fields.items():
        detail.setdefault(INDEXED_KEY.sub(r".\1", key), set()).update(
            "format_control" if rule == "format_control" else "public_promise" for rule in rules)
    return {key: sorted(rules) for key, rules in sorted(detail.items()) if rules}


def hidden_fields(values: Mapping[str, str]) -> dict[str, list[str]]:
    """Every card field of a tool holding a character no font draws (a format control, such as a bidi
    override or isolate, or another ignorable), refused as `format_control` on the text as written,
    before any normalizing: a receipt renders the original text, while the scan reads it normalized."""
    if any(reply_check._unseen(ch) for value in values.values() for ch in value):
        return unindexed_detail({key: ["format_control"] for key in values})
    return {}


def card_refusal(tool: BusinessTool, scanned: Mapping[str, Iterable[str]]) -> dict[str, list[str]]:
    """One tool's refusal detail from the shared scan of its card fields (`scanned`, by indexed key),
    with the payment-title rule's own refusal; empty when nothing is refused. A key the scan wasn't
    given (a size limit's) refuses every card field, so the detail stays in the closed key set."""
    values = public_fields(tool)
    fields: dict[str, set[str]] = {}
    for key, rules in scanned.items():
        for each in [key] if key in values else values:
            fields.setdefault(each, set()).update(rules)
    for key in payment_title_refused_fields(tool):
        fields.setdefault(key, set()).add("public_promise")
    return unindexed_detail(fields)


async def _card_text_refusal(ctx: KernelCtx, desk_id: str, tool: BusinessTool) -> dict[str, list[str]]:
    """One combined public-promise scan of a tool's card fields in render order, after the hidden
    character check; the shared check's own refusal is folded into the batch's. Card fields get no
    amenity exception (`amenities=False`): the master plan allows the free words in a title or an
    appointment type only, and exempts no other hit, while charter policy text keeps that exception."""
    values = public_fields(tool)
    if hidden := hidden_fields(values):
        return hidden
    try:
        await desks.refuse_public_promises(ctx, "business_tools", values, desk_id,
                                           allow_words=free_allow_words(tool), amenities=False)
    except KernelFailure as failure:
        if failure.status != 422 or failure.detail is None:
            raise
        return card_refusal(tool, failure.detail)
    return card_refusal(tool, {})


async def _refusal(ctx: KernelCtx, *, copy_id: str, desk_id: str, reason: str) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="business_tools", origin="kernel",
                                          summary={"tools": [], "refused": reason}))


def _invalid(ctx: KernelCtx, desk_id: str, reason: str, *,
             detail: dict[str, list[str]] | None = None) -> KernelFailure:
    return KernelFailure(422, "invalid", reason, detail=detail,
                         persist=partial(_refusal, copy_id=ctx.copy_id, desk_id=desk_id, reason=reason))


async def replace_business_tools(ctx: KernelCtx, id: str, body: BusinessToolsRequest) -> list[Tool]:
    """Replace Desk `id`'s business tools with `body`, in the caller's transaction, once the caller
    holds the Desk (the owner's PUT, or a seed on a new copy).

    The whole batch is refused, with 422 `invalid` and a `business_tools` ledger entry naming a fixed
    reason, for a repeated tool, more than 8 tools (BusinessToolsRequest allows at most 8, and the PUT
    route refuses a longer batch the same way), unstorable text, a document canary, a format control,
    or card text the public-promise check refuses (`desks.refuse_public_promises`, one combined scan
    per tool in render order). A card-text refusal's `detail` names every refused `<tool>.<field>` in
    the batch with `public_promise` or `format_control`; the others carry no detail. Otherwise each new
    or changed tool waits for review, each one left out is disabled, and the batch is ledgered
    `business_tools`. Returns the batch's rows in batch order, without the disabled leftovers."""
    if len({tool.tool for tool in body.tools}) != len(body.tools):
        raise _invalid(ctx, id, "business_tools_duplicate")
    shown = body.model_dump(mode="json")
    if not all(storable(text) for text in config_texts(shown)):
        raise _invalid(ctx, id, "business_tools_text")
    if labels.canary_fields(shown, await labels.copy_canaries(ctx)):
        raise _invalid(ctx, id, "business_tools_canary")
    detail = {}
    for tool in body.tools:
        detail.update(await _card_text_refusal(ctx, id, tool))
    if detail:
        raise _invalid(ctx, id, "public_promise", detail=detail)
    rows = {row.tool: row for row in await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
        Tool.desk_id == id, Tool.source == "business").order_by(Tool.tool).with_for_update()))}
    written, changes = [], []
    for tool in body.tools:
        definition = BusinessToolDef.model_validate(tool.model_dump(exclude={"tool"}))
        profile = blocks.profile(tool.tool, definition)
        row = rows.pop(tool.tool, None)
        profile_hash = adapters.profile_sha256(profile)
        kept = (row is not None and row.definition_sha256 == profile.definition_sha256
                and row.profile_sha256 == profile_hash)
        change = "new" if row is None or row.status == "disabled" else "kept" if kept else "changed"
        if change != "kept":
            if row is None:
                row = Tool(copy_id=ctx.copy_id, desk_id=id, tool=tool.tool)
                ctx.db.add(row)
            profile = profile.model_copy(update={"review_reason": change})
            row.source, row.effects, row.reversible = profile.source, profile.effects, profile.reversible
            row.description_confirmed, row.profile = profile.description_confirmed, profile
            row.profile_sha256, row.definition_sha256 = profile_hash, profile.definition_sha256
            row.status, row.review_reason = "needs_review", change
            row.pending_definition_text = row.pending_sha256 = None
        written.append(row)
        changes.append({"tool": tool.tool, "block": definition.config.block,
                        "definition_sha256": row.definition_sha256, "change": change})
    for row in rows.values():
        row.status, row.review_reason = "disabled", None
        changes.append({"tool": row.tool, "block": row.profile.business.config.block,
                        "definition_sha256": row.definition_sha256, "change": "removed"})
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=id,
                        event=LedgerEvent(kind="business_tools", origin="kernel", summary={"tools": changes}))
    return written


@router.put("/desks/{id}/business_tools", response_model=DeskUpdated)
async def put_business_tools(id: str, body: BusinessToolsRequest, ctx: Ctx, request: Request) -> DeskUpdated:
    owner = await desks.owner_alone(ctx, request)
    desk = await desks.held_desk(ctx, request, owner, id)
    await replace_business_tools(ctx, id, body)
    return DeskUpdated(desk_id=desk.desk_id, updated_at=ctx.clock.now())


async def refuse_invalid_request(ctx: KernelCtx, request: Request) -> None:
    """Authenticate malformed typed batches before recording their code-only refusal."""
    owner = await desks.owner_alone(ctx, request)
    desk_id = request.path_params["id"]
    await desks.held_desk(ctx, request, owner, desk_id)
    raise _invalid(ctx, desk_id, "business_tools_invalid")
