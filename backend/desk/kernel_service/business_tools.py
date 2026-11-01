"""Owner-only whole replacement of a Desk's trusted block configurations."""

import re
import unicodedata
from collections.abc import Mapping
from functools import partial

from fastapi import APIRouter, Request
from pydantic import ValidationError
from sqlalchemy import select

from desk.contracts import BusinessTool, BusinessToolDef, LedgerEvent
from desk.db.models import Tool
from desk.kernel_api import BusinessToolsRequest, DeskUpdated
from desk.kernel_service import adapters, desks, labels, ledger
from desk.kernel_service.adapters import blocks
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, storable

router = APIRouter()
FREE_WORDS = frozenset({"free", "gratis", "gratuito", "gratuita", "gratuitos", "gratuitas"})

# Currency codes are unsafe even without an amount. Keep this local until the shared B7 check lands.
CURRENCY_CODE = re.compile(r"\b(?:USD|EUR|GBP|CAD|AUD|MXN|JPY|INR|CHF|CNY|HKD|NZD|SGD|BRL|ZAR|AED|SAR|KRW)\b")


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
    """One tool's visitor-facing fields in render order; never its structured amount."""
    return {f"{tool.tool}.{field}": getattr(tool if field == "title" else tool.config, field)
            for field in blocks.CARD_FIELDS[tool.config.block]}


def free_allow_words(tool: BusinessTool) -> dict[str, frozenset[str]]:
    return {f"{tool.tool}.{field}": FREE_WORDS for field in blocks.CARD_FIELDS[tool.config.block]
            if field in {"title", "appointment_type"}}


def public_promise_fields(values: Mapping[str, str], *,
                          allow_words: Mapping[str, frozenset[str]] = {}) -> list[str]:
    """Shared real/fake check: one prose scan, preserving field boundaries for narrow exceptions."""
    from desk.kernel_service import reply_check

    pieces, bounds, offset = [], [], 0
    for key, value in values.items():
        text = reply_check.shown(value)
        pieces.append(text)
        bounds.append((key, offset, offset + len(text)))
        offset += len(text) + 1
    combined = "\n".join(pieces)
    hits = reply_check.scan_prose(combined)
    if CURRENCY_CODE.search(combined) or any(unicodedata.category(ch) == "Sc" for ch in combined):
        return list(values)
    if not hits:
        return []
    if any(hit.rule_id not in {"lex.en.promise", "lex.es.promise"} for hit in hits):
        return list(values)

    # scan_prose returns text spans but not offsets. Recover only promise-hit locations from
    # its own read-only folding/lexicon machinery, until B7 exposes scan_public_text. Never
    # rescan fields separately: a promise can straddle their boundary ("no" + "charge").
    spans = {(f"lex.{language}.promise", origin[match.start()], origin[match.end() - 1] + 1)
             for reading, origin in reply_check._readings(combined).items()
             for language, entries in reply_check.LEXICONS.items() for category, pattern in entries
             if category == "promise" for match in pattern.finditer(reading) if match.end() > match.start()}

    def permitted(hit) -> bool:
        occurrences = [(start, end) for rule, start, end in spans
                       if rule == hit.rule_id and combined[start:end][:reply_check.SPAN_CHARS] == hit.span]
        # When identical hits occur more than once, every occurrence must be within an allowed
        # field; one allowed title must never exempt the same word in an unallowed purpose.
        return bool(occurrences) and all(
            any(left <= start and end <= right
                and any(reading.casefold() in allow_words.get(key, frozenset())
                        for reading in reply_check._readings(combined[start:end]))
                for key, left, right in bounds) for start, end in occurrences)

    return [] if all(permitted(hit) for hit in hits) else list(values)


async def refuse_public_promises(ctx, part, values, desk_id=None, *,
                                allow_words: Mapping[str, frozenset[str]] = {}) -> None:
    # TODO B7: replace this shim with desks.refuse_public_promises and its shared scanner.
    if public_promise_fields(values, allow_words=allow_words):
        raise _invalid(ctx, desk_id, "public_promise")


async def _refusal(ctx: KernelCtx, *, copy_id: str, desk_id: str, reason: str) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="business_tools", origin="kernel",
                                          summary={"tools": [], "refused": reason}))


def _invalid(ctx: KernelCtx, desk_id: str, reason: str) -> KernelFailure:
    return KernelFailure(422, "invalid", reason,
                         persist=partial(_refusal, copy_id=ctx.copy_id, desk_id=desk_id, reason=reason))


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
    for tool in parsed.tools:
        await refuse_public_promises(ctx, part="business_tools", values=public_fields(tool), desk_id=id,
                                     allow_words=free_allow_words(tool))
    rows = {row.tool: row for row in await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
        Tool.desk_id == id, Tool.source == "business").order_by(Tool.tool).with_for_update()))}
    changes = []
    for tool in parsed.tools:
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
