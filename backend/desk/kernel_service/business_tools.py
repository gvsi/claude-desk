"""Owner-only whole replacement of a Desk's trusted block configurations."""

import re
import unicodedata
from collections.abc import Mapping
from functools import partial

from fastapi import APIRouter, Request
from sqlalchemy import select

from desk.contracts import BusinessTool, BusinessToolDef, LedgerEvent
from desk.db.models import Tool
from desk.kernel_api import BusinessToolsRequest, DeskUpdated
from desk.kernel_service import adapters, desks, labels, ledger
from desk.kernel_service.adapters import blocks
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, storable

router = APIRouter()
FREE_WORDS = frozenset({"free", "gratis", "gratuito", "gratuita", "gratuitos", "gratuitas"})
# Owner decision (2026-10-31): payment titles may say neither free nor complimentary.
PAYMENT_TITLE_REFUSED_WORDS = frozenset({"free", "complimentary"})

# Currency codes are unsafe even without an amount. Keep this local until the shared B7 check lands.
CURRENCY_CODE = re.compile(r"\b(?:USD|EUR|GBP|CAD|AUD|MXN|JPY|INR|CHF|CNY|HKD|NZD|SGD|BRL|ZAR|AED|SAR|KRW)\b")

# Mirror B7's policy-only other_promises.txt until its shared scanner is available here.
# Spanish/Italian "gratis" remains subject to the field-scoped FREE_WORDS exception;
# Portuguese "grátis" requires its accent and is always refused by this language rule.
OTHER_PROMISE = re.compile(
    r"(?<!\w)(?:gratuite?s?|offerte?s?|sans[\s-]+frais|remises?|rabais|garantie?s?"
    r"|remboursee?s?|remboursements?|sem[\s-]+(?:custos?|taxas?)|descontos?|garantid[oa]s?"
    r"|senza[\s-]+cost[oi]|scont[oi]|omaggi(?:o)?|garantit[oaie]|rimborso|rimborsi"
    r"|kostenlos(?:e[nmrs]?)?|umsonst|rabatt(?:e|en|s)?|garantiert(?:e[nmrs]?)?|erstattung(?:en)?)(?!\w)",
    re.IGNORECASE)
ACCENTED_PROMISE = re.compile(r"(?<!\w)grátis(?!\w)", re.IGNORECASE)


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
    return {f"{tool.tool}.{index}-{field}": getattr(tool if field == "title" else tool.config, field)
            for index, field in enumerate(blocks.CARD_FIELDS[tool.config.block])}


def free_allow_words(tool: BusinessTool) -> dict[str, frozenset[str]]:
    if tool.config.block == "purpose_payment":
        return {}
    return {f"{tool.tool}.{index}-{field}": FREE_WORDS
            for index, field in enumerate(blocks.CARD_FIELDS[tool.config.block])
            if field in {"title", "appointment_type"}}


def payment_title_refused_fields(tool: BusinessTool) -> list[str]:
    from desk.kernel_service import reply_check

    if tool.config.block == "purpose_payment" and any(
            set(re.findall(r"\w+", reading.casefold())) & PAYMENT_TITLE_REFUSED_WORDS
            for reading in reply_check._readings(reply_check.shown(tool.title))):
        return [key for key in public_fields(tool) if key.endswith("-title")]
    return []


def unindexed_detail(detail: Mapping[str, list[str]]) -> dict[str, list[str]]:
    """Return setup's stable field names; indexes only control the scanner's render order."""
    return {re.sub(r'\.\d+-([^.]+)$', r'.\1', key): rules for key, rules in detail.items()}


def public_promise_fields(values: Mapping[str, str], *,
                          allow_words: Mapping[str, frozenset[str]] = {}) -> list[str]:
    """Shared real/fake check: one prose scan, preserving field boundaries for narrow exceptions."""
    from desk.kernel_service import reply_check

    # Receipts render the original value, so normalization must not conceal a control.
    if any(reply_check._unseen(ch) for value in values.values() for ch in value):
        return list(values)
    pieces, bounds, offset = [], [], 0
    for key, value in sorted(values.items()):
        text = reply_check.shown(value)
        pieces.append(text)
        bounds.append((key, offset, offset + len(text)))
        offset += len(text) + 1
    combined = "\n".join(pieces)
    hits = reply_check.scan_prose(combined)
    accented = unicodedata.normalize("NFC", "".join(reply_check.LOOKALIKES.get(ch, ch) for ch in combined))
    if (any(OTHER_PROMISE.search(reading) for reading in reply_check._readings(combined))
            or ACCENTED_PROMISE.search(accented)):
        return list(values)
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


def public_refusal_detail(values: Mapping[str, str], *,
                          allow_words: Mapping[str, frozenset[str]] = {}) -> dict[str, list[str]]:
    """Classify hidden characters before normalization; keep the real and fake refusals identical."""
    from desk.kernel_service import reply_check

    if any(reply_check._unseen(ch) for value in values.values() for ch in value):
        return {field: ["format_control"] for field in values}
    return {field: ["public_promise"]
            for field in public_promise_fields(values, allow_words=allow_words)}


async def refuse_public_promises(ctx, part, values, desk_id=None, *,
                                allow_words: Mapping[str, frozenset[str]] = {}) -> None:
    # TODO B7: replace this shim with desks.refuse_public_promises and its shared scanner.
    if detail := public_refusal_detail(values, allow_words=allow_words):
        failure = _invalid(ctx, desk_id, "public_promise")
        failure.detail = detail
        raise failure


async def check_public_fields(ctx, desk_id: str, tool: BusinessTool) -> None:
    try:
        await refuse_public_promises(ctx, "business_tools", public_fields(tool), desk_id,
                                     allow_words=free_allow_words(tool))
        if fields := payment_title_refused_fields(tool):
            failure = _invalid(ctx, desk_id, "public_promise")
            failure.detail = {field: ["public_promise"] for field in fields}
            raise failure
    except KernelFailure as failure:
        if failure.detail is not None:
            failure.detail = unindexed_detail(failure.detail)
        raise


async def _refusal(ctx: KernelCtx, *, copy_id: str, desk_id: str, reason: str) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="business_tools", origin="kernel",
                                          summary={"tools": [], "refused": reason}))


def _invalid(ctx: KernelCtx, desk_id: str, reason: str) -> KernelFailure:
    return KernelFailure(422, "invalid", reason,
                         persist=partial(_refusal, copy_id=ctx.copy_id, desk_id=desk_id, reason=reason))


@router.put("/desks/{id}/business_tools", response_model=DeskUpdated)
async def put_business_tools(id: str, body: BusinessToolsRequest, ctx: Ctx, request: Request) -> DeskUpdated:
    owner = await desks.owner_alone(ctx, request)
    desk = await desks.held_desk(ctx, request, owner, id)
    parsed = body
    if len({tool.tool for tool in parsed.tools}) != len(parsed.tools):
        raise _invalid(ctx, id, "business_tools_duplicate")
    shown = parsed.model_dump(mode="json")
    if not all(storable(text) for text in config_texts(shown)):
        raise _invalid(ctx, id, "business_tools_text")
    if labels.canary_fields(shown, await labels.copy_canaries(ctx)):
        raise _invalid(ctx, id, "business_tools_canary")
    detail = {}
    for tool in parsed.tools:
        try:
            await check_public_fields(ctx, id, tool)
        except KernelFailure as failure:
            if failure.status != 422 or failure.detail is None:
                raise
            detail.update(failure.detail)
    if detail:
        failure = _invalid(ctx, id, "public_promise")
        failure.detail = detail
        raise failure
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


async def refuse_invalid_request(ctx: KernelCtx, request: Request) -> None:
    """Authenticate malformed typed batches before recording their code-only refusal."""
    owner = await desks.owner_alone(ctx, request)
    desk_id = request.path_params["id"]
    await desks.held_desk(ctx, request, owner, desk_id)
    raise _invalid(ctx, desk_id, "business_tools_invalid")
