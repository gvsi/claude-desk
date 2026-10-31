"""Owner-only whole replacement of a Desk's trusted block configurations."""

import re
from collections.abc import Mapping
from functools import partial

from fastapi import APIRouter, Request
from pydantic import ValidationError
from sqlalchemy import select

from desk.contracts import BusinessToolDef, LedgerEvent
from desk.db.models import Tool
from desk.kernel_api import BusinessToolsRequest, DeskUpdated
from desk.kernel_service import adapters, desks, labels, ledger
from desk.kernel_service.adapters import blocks
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, storable

router = APIRouter()


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


def public_fields(batch: BusinessToolsRequest) -> dict[str, str]:
    values = {f"{tool.tool}.title": tool.title for tool in batch.tools}
    for tool in batch.tools:
        config = tool.config
        if config.block == "typed_booking":
            values[f"{tool.tool}.appointment_type"] = config.appointment_type
        elif config.block == "purpose_payment":
            values[f"{tool.tool}.purpose"] = config.purpose
    return values


def public_promise_fields(values: Mapping[str, str]) -> list[str]:
    """The temporary B7 shim's pure check. No structured amount is passed here."""
    from desk.kernel_service import reply_check

    currency_or_percent = re.compile(
        r"[$€£¥₹₽₩]\s*\d|(?:usd|eur|gbp|cad|aud|mxn|jpy|inr)\s*\d"
        r"|\d[\d.,\s]*(?:[%٪‰‱]|usd|eur|gbp|cad|aud|mxn|jpy|inr)", re.IGNORECASE)
    patterns = [pattern for entries in reply_check.LEXICONS.values() for category, pattern in entries
                if category in ("promise", "booking", "money", "percent")]
    return [field for field, text in values.items()
            if any(currency_or_percent.search(reading) or any(pattern.search(reading) for pattern in patterns)
                   for reading in reply_check._readings(reply_check.shown(text)))]


async def refuse_public_promises(ctx: KernelCtx, *, part: str, values: Mapping[str, str], desk_id: str) -> None:
    # TODO B7: switch the call below directly to desks.refuse_public_promises once it lands.
    check = getattr(desks, "refuse_public_promises", None)
    if check is not None:
        await check(ctx, part=part, values=values, desk_id=desk_id)
    elif public_promise_fields(values):
        raise _invalid(ctx, desk_id, "public_promise")


async def _refusal(ctx: KernelCtx, *, copy_id: str, desk_id: str) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="business_tools", origin="kernel", summary={"tools": []}))


def _invalid(ctx: KernelCtx, desk_id: str, reason: str) -> KernelFailure:
    return KernelFailure(422, "invalid", reason,
                         persist=partial(_refusal, copy_id=ctx.copy_id, desk_id=desk_id))


@router.put("/desks/{id}/business_tools", response_model=DeskUpdated)
async def put_business_tools(id: str, body: dict, ctx: Ctx, request: Request) -> DeskUpdated:
    # Parse after authentication so invalid batches also have a copy-scoped refusal ledger entry.
    owner = await desks.owner_alone(ctx, request)
    desk = await desks.held_desk(ctx, request, owner, id)
    try:
        parsed = BusinessToolsRequest.model_validate(body)
    except ValidationError:
        raise _invalid(ctx, id, "business_tools_invalid") from None
    if len({tool.tool for tool in parsed.tools}) != len(parsed.tools):
        raise _invalid(ctx, id, "business_tools_duplicate")
    shown = parsed.model_dump(mode="json")
    if not all(storable(text) for text in config_texts(shown)):
        raise _invalid(ctx, id, "business_tools_text")
    if labels.canary_fields(shown, await labels.copy_canaries(ctx)):
        raise _invalid(ctx, id, "business_tools_canary")
    await refuse_public_promises(ctx, part="business_tools", values=public_fields(parsed), desk_id=id)
    rows = {row.tool: row for row in await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
        Tool.desk_id == id, Tool.source == "business").order_by(Tool.tool).with_for_update()))}
    changes = []
    for tool in parsed.tools:
        definition = BusinessToolDef.model_validate(tool.model_dump(exclude={"tool"}))
        profile = blocks.profile(tool.tool, definition)
        row = rows.pop(tool.tool, None)
        change = "new" if row is None else "kept" if row.definition_sha256 == profile.definition_sha256 else "changed"
        if change != "kept":
            if row is None:
                row = Tool(copy_id=ctx.copy_id, desk_id=id, tool=tool.tool)
                ctx.db.add(row)
            profile = profile.model_copy(update={"review_reason": change})
            row.source, row.effects, row.reversible = profile.source, profile.effects, profile.reversible
            row.description_confirmed, row.profile = profile.description_confirmed, profile
            row.profile_sha256, row.definition_sha256 = adapters.profile_sha256(profile), profile.definition_sha256
            row.status, row.review_reason = "needs_review", change
            row.pending_definition_text = row.pending_sha256 = None
        changes.append({"tool": tool.tool, "block": definition.config.block,
                        "definition_sha256": row.definition_sha256, "change": change})
    for row in rows.values():
        row.status, row.review_reason = "disabled", None
        changes.append({"tool": row.tool, "block": row.profile.business.config.block,
                        "definition_sha256": row.definition_sha256, "change": "removed"})
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=id,
                        event=LedgerEvent(kind="business_tools", origin="kernel", summary={"tools": changes}))
    return DeskUpdated(desk_id=desk.desk_id, updated_at=ctx.clock.now())
