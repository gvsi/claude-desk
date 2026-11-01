"""The owner's rules after setup (Plan 02b, Task 9): what a draft changes, the Rules page, rules by chat, presets and
suggestions.

A Desk's rules are the cards of its active version (`kernel_ro.policy_versions`). The owner changes them only through
a draft the kernel compiles and proves (`POST /policy/draft`) and then confirms (`POST /policy/confirm`); the API
sends cards, never Cedar, and nothing changes until the confirm.
"""

import asyncio
import base64
import binascii
import json
from collections.abc import Collection, Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any, get_args

from pydantic import ValidationError
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncEngine

from desk.api.deps import ApiProblem, OwnerCtx
from desk.api.kernel_client import KernelFailed
from desk.api.link_notices import tell_cancelled_links
from desk.api.model import ModelClient
from desk.api.owner_reads import people, refusal_reason, utc
from desk.api.prompts import (
    CHAT_CARD_ERROR_LINE,
    CHAT_ERRORS,
    OWNER_CARDS_MAX,
    RECENT_TAG,
    REQUEST_TAG,
    RULES_CHAT_SYSTEM,
    RULES_TAG,
    TOOLS_TAG,
    ChatCard,
    HoursAnswer,
    RuleChat,
    dollars,
    rules_chat_head,
    wrap,
)
from desk.api.proving import AnswerError
from desk.api.ro import decision_replayed, ro_view, set_copy
from desk.api.schemas import (
    CardDiff,
    RuleChatOut,
    RulesDraft,
    RulesView,
    Suggestion,
    ToolDecisionRow,
    ToolDecisions,
)
from desk.api.setup import ask_model, recorder
from desk.api.versions import (
    active_row,
    checkable,
    covering_cards,
    post_draft,
    rules_draft,
    tool_rows,
    version_cap,
    version_from_row,
)
from desk.contracts import AUTO_MONEY_NEEDS_LIMIT, MONEY_TOOLS, Effect, HoursWindow, PolicyVersion, RuleCard, money_tools_of
from desk.kernel_api import PolicyConfirmRequest
from desk.money_cap import Language, auto_money, lower_to_cap
from desk.presets import PRESETS, PresetName, preset_cards

# The language the owner reads the rules in, for the rule copy code writes (a lowered card's reason). The owner app
# renders rules copy in English today (its rules chat shows Claude's answers with language "en"), and `kernel_ro`
# keeps no owner language, so this is English for every owner; an owner language source, once there is one, replaces
# this line. It is never read from a model.
OWNER_LANGUAGE: Language = "en"
DRAFT_STATUSES = ("draft", "proved", "rejected")     # a version the owner can still read as a draft
EFFECT_TARGETS = frozenset(f"effect:{effect}" for effect in get_args(Effect))
CHAT_ROUTE = "rules_chat"
CHAT_MAX_TOKENS = 8192
# The most a rules chat's structured call may take, the SDK's retries included: longer than setup's, since a chat
# answers every owner card as it should stand, and the route answers 202 at `proving.PROVING_WAIT_S` regardless, so the
# longer bound holds no request open.
CHAT_TIMEOUT_S = 120.0
RECENT_DECISIONS = 20
# Suggestions: a tool the owner approved this many times in this window, with no auto card, gets one.
SUGGEST_AFTER = 3
SUGGEST_WINDOW = timedelta(days=30)
# What the owner calls each tool's requests, in the suggestion's line and its card's reason.
TOOL_LABELS = {
    "native.quote": "quote", "native.find_slots": "open times", "native.book": "booking",
    "native.release_document": "document", "native.payment_link": "payment link",
    "native.charge_mandate": "agent payment", "native.capture_lead": "contact details",
    "native.request_callback": "callback", "native.start_verification": "verification",
    "payments.list_charges": "payment history", "payments.create_refund": "refund"}
SUGGESTION_TEXT = "You approved {count} {label} requests. Let me handle these?"
SUGGESTED_REASON = "{label} requests go ahead without asking you."
SUGGESTED_MONEY_REASON = "{label} requests up to {amount} go ahead without asking you."


class AboveMoneyCap(AnswerError):
    """A new or changed auto money card above the money cap its draft is at: the route answers 422
    `above_money_cap` with the cap, and nothing is sent to the kernel."""

    def __init__(self, cap_cents: int):
        super().__init__("a card is above the money cap")
        self.cap_cents = cap_cents


def card_diff(before: list[RuleCard], after: list[RuleCard]) -> CardDiff:
    """How `after` differs from `before`, card by card, matched by `card_id`: the cards added and removed, and each
    one changed as a (before, after) pair, in the order of the list it is read from. Default asks are left out: the
    compiler adds and drops them with the tools the cards cover, so they are never a change the owner reviews."""
    old = {card.card_id: card for card in before if not card.is_default}
    new = [card for card in after if not card.is_default]
    kept = {card.card_id for card in new}
    return CardDiff(added=[card for card in new if card.card_id not in old],
                    removed=[card for card in old.values() if card.card_id not in kept],
                    changed=[(old[card.card_id], card) for card in new
                             if card.card_id in old and old[card.card_id] != card])


def preset_of(cards: Iterable[RuleCard], hours: list[HoursWindow]) -> PresetName | None:
    """The preset the owner cards are, exactly (default asks aside, in any order), as a Desk with these opening hours
    drafts it (`preset_cards`), else None."""
    owned = sorted((card for card in cards if not card.is_default), key=lambda card: card.card_id)
    for name in PRESETS:
        if owned == sorted(preset_cards(name, hours), key=lambda card: card.card_id):
            return name
    return None


async def desk_hours(owner: OwnerCtx, desk_id: str) -> list[HoursWindow]:
    """The Desk's opening hours, as its `kernel_ro.desks` row keeps them. None without a row, and none when the row's
    hours aren't a list of windows that each read as one, so the Rules page still loads and a preset's draft takes
    the shipped cards (`preset_cards`); a failed read still raises."""
    desk = await owner.ro.one("desks", desk_id=desk_id)
    stored = None if desk is None else desk.get("hours")
    if not isinstance(stored, list):
        return []
    try:
        return [HoursWindow.model_validate(window) for window in stored]
    except ValidationError:
        return []


async def rules_view(owner: OwnerCtx, desk_id: str) -> RulesView:
    """The Rules page: the active version, each tool with the cards that cover it, and its preset, if any."""
    active = version_from_row(await active_row(owner, desk_id))
    return RulesView(active=active, tools=await tool_rows(owner, desk_id, active.cards),
                     preset=preset_of(active.cards, await desk_hours(owner, desk_id)))


def _money_tools(rows: Iterable[Mapping[str, Any]]) -> frozenset[str]:
    """Money tools from the copy-scoped read view, which exposes effects rather than full profiles.

    Include every status: a card may name a tool before its owner enables it.
    """
    return money_tools_of((row["tool"], row["effects"]) for row in rows)


def moves_money_alone(card: RuleCard, money_tools: Collection[str] = frozenset()) -> bool:
    """Whether the card lets money be taken or paid out without asking: an auto card on a money tool or effect."""
    return auto_money(card, money_tools)


def above_cap(card: RuleCard, active: dict[str, RuleCard], cap_cents: int, *,
              money_tools: Collection[str] = frozenset()) -> bool:
    """Whether `card`, new or changed from the `active` card with its ID, moves more money on its own than the cap.
    An unchanged card stays as the kernel proved it; one with no amount is above any cap, as the kernel counts it."""
    return (moves_money_alone(card, money_tools) and active.get(card.card_id) != card
            and (card.max_amount_cents is None or card.max_amount_cents > cap_cents))


def check_cap(cards: Iterable[RuleCard], active: Iterable[RuleCard], cap_cents: int, *,
              money_tools: Collection[str] = frozenset()) -> None:
    """`AboveMoneyCap` when a card new or changed from the `active` ones moves more money on its own than the cap. The
    kernel's own check at draft and confirm stays the enforcement: this one only tells the owner the limit first."""
    kept = {card.card_id: card for card in active}
    if any(above_cap(card, kept, cap_cents, money_tools=money_tools) for card in cards):
        raise AboveMoneyCap(cap_cents)


async def draft(owner: OwnerCtx, desk_id: str, cards: list[RuleCard], *, expected_parent: int | None = None,
                auto_money_cap_cents: int | None = None, carried_only: bool = False) -> RulesDraft:
    """The owner cards `cards` drafted on the active version (or `expected_parent`), at the money cap
    `auto_money_cap_cents` (None keeps the active version's): refused before the kernel is asked when there are more
    than `OWNER_CARDS_MAX` (422 `invalid`, so a draft never grows a Desk past what a rules chat can carry; not checked
    when `carried_only`, for a draft of the active owner cards and no other, whose count the Desk already holds), with
    `AboveMoneyCap` when a new or changed card is above the draft's cap, or with `versions.ChangesAlwaysOn` naming
    the cards that would change starting a verification; else compiled and proved by the kernel, with how the draft
    differs from the active rules. The draft's cap is read back from the version the kernel drafted."""
    if not carried_only and sum(not card.is_default for card in cards) > OWNER_CARDS_MAX:
        raise ApiProblem(422, "invalid")
    row = await active_row(owner, desk_id)
    active = version_from_row(row)
    check_cap(cards, active.cards, version_cap(row) if auto_money_cap_cents is None else auto_money_cap_cents,
              money_tools=_money_tools(await owner.ro.rows("tools", desk_id=desk_id)))
    parent = active.version if expected_parent is None else expected_parent
    version = checkable(await post_draft(owner, desk_id, cards, parent, auto_money_cap_cents=auto_money_cap_cents))
    return rules_draft(version, version_cap(version), card_diff(active.cards, version.cards))


async def draft_money_cap(owner: OwnerCtx, desk_id: str, cap: int) -> RulesDraft:
    """The active owner cards drafted at the money cap `cap`, on the active version. Lowering it, each active auto
    money card above it comes down to it in the draft (an `ask` card at 0), its reason the new limit in the owner's
    language (`desk.money_cap.lower_to_cap`, `OWNER_LANGUAGE`), so the diff shows each card the change moves; raising
    it changes no card. It adds none either, so a Desk holding more than `OWNER_CARDS_MAX` owner cards can still
    change its cap. Nothing changes the Desk's cap until the owner confirms the draft, and the kernel holds the draft's
    cards to its cap whatever the API sent."""
    active = version_from_row(await active_row(owner, desk_id))
    owned = [card for card in active.cards if not card.is_default]
    money_tools = _money_tools(await owner.ro.rows("tools", desk_id=desk_id))
    return await draft(owner, desk_id, lower_to_cap(owned, active.cards, cap, OWNER_LANGUAGE, money_tools=money_tools),
                       expected_parent=active.version, auto_money_cap_cents=cap, carried_only=True)


async def read_draft(owner: OwnerCtx, desk_id: str, version: int) -> RulesDraft:
    """One of the Desk's drafts as it was made (`kernel_ro.policy_versions`), with how it differs from the active
    rules now: 404 for a version that isn't a draft of the Desk's, or that the kernel hasn't checked yet."""
    row = await owner.ro.one("policy_versions", desk_id=desk_id, version=version)
    if row is None or row["status"] not in DRAFT_STATUSES or row["proof"] is None:
        raise ApiProblem(404, "not_found")
    drafted = version_from_row(row)
    active = version_from_row(await active_row(owner, desk_id))
    return rules_draft(drafted, version_cap(row), card_diff(active.cards, drafted.cards))


def merged(active: list[RuleCard], add: list[RuleCard]) -> list[RuleCard]:
    """The active owner cards with `add` merged in by `card_id`: a card with an active one's ID takes its place,
    the rest follow in order."""
    adding = {card.card_id: card for card in add}
    owned = [adding.pop(card.card_id, card) for card in active if not card.is_default]
    return [*owned, *adding.values()]


async def draft_added(owner: OwnerCtx, desk_id: str, add: list[RuleCard]) -> RulesDraft:
    """`add` (an approval's drafted cards, say) merged into the active owner cards, drafted."""
    active = version_from_row(await active_row(owner, desk_id))
    return await draft(owner, desk_id, merged(active.cards, add))


async def draft_preset(owner: OwnerCtx, desk_id: str, name: PresetName) -> RulesDraft:
    """The preset's cards for the Desk's opening hours (`preset_cards`: "Recommended rules" books weekdays in them) in
    place of every owner card, cards for one person and "never" cards included, so the draft's diff lists each card it
    removes. A Desk with no hours, or with Monday to Friday 09:00 to 17:00, drafts the preset's cards as they are,
    which hit the proofs shipped for them; one whose hours have no weekday gets no booking card. Presets carry no auto
    money card."""
    return await draft(owner, desk_id, preset_cards(name, await desk_hours(owner, desk_id)))


async def confirm(owner: OwnerCtx, engine: AsyncEngine, desk_id: str, version: int) -> PolicyVersion:
    """Activate the Desk's drafted `version`, which makes its cards (and its money cap) the Desk's. A version that
    isn't one of the Desk's is 404; one already active is answered as it is (a confirm whose answer was lost); one the
    kernel didn't prove is 409 `conflict`; and when the rules changed after the draft (the kernel's 409), 409
    `rules_changed_since_draft`. After success, cancelled-link notices are delivered best effort, including when
    recovering an already-active version; a notice failure never fails the confirm."""
    row = await owner.ro.one("policy_versions", desk_id=desk_id, version=version)
    if row is None:
        raise ApiProblem(404, "not_found")
    if row["status"] == "active":
        active = version_from_row(row)
    else:
        if row["status"] != "proved":
            raise ApiProblem(409, "conflict")
        try:
            active = await owner.kernel.call("POST /policy/confirm", PolicyConfirmRequest(
                desk_id=desk_id, version=version))
        except KernelFailed as refused:
            if refused.code != "conflict":
                raise
            row = await owner.ro.one("policy_versions", desk_id=desk_id, version=version)
            if row is None or row["status"] != "active":
                raise ApiProblem(409, "rules_changed_since_draft") from None
            active = version_from_row(row)
    await tell_cancelled_links(owner, engine, desk_id, active)
    return active


# Rules by chat -----------------------------------------------------------------------------------------------------


def chat_view(card: RuleCard) -> dict[str, Any]:
    """An owner card as Claude reads it in a rules chat: a `ChatCard`, its hours as local times. It is built without
    `ChatCard`'s checks, which bound what Claude writes: an active card may carry a longer reason than Claude may."""
    hours = None if card.hours is None else HoursAnswer.model_construct(
        days=card.hours.days, start=f"{card.hours.start:%H:%M}", end=f"{card.hours.end:%H:%M}")
    return ChatCard.model_construct(**card.model_dump(exclude={"is_default", "hours"}),
                                    hours=hours).model_dump(mode="json")


def _fields(card: ChatCard) -> dict[str, Any]:
    return {**card.model_dump(exclude={"hours"}), "is_default": False,
            "hours": card.hours.window() if card.hours is not None else None}


def unchecked(card: ChatCard) -> RuleCard:
    """The card Claude wrote as a `RuleCard` without the contract's checks, to compare and to check the cap with."""
    return RuleCard.model_construct(**_fields(card))


def rule_card(card: ChatCard) -> RuleCard:
    """The card Claude wrote as a `RuleCard`, checked by the contract."""
    return RuleCard.model_validate(_fields(card))


# The contract's limit line as pydantic reports a validator's ValueError, so a business money card's line matches a
# native one's word for word.
_NO_LIMIT_ERROR = f"Value error, {AUTO_MONEY_NEEDS_LIMIT}"


def _contract_errors(card: ChatCard) -> list[str]:
    """Why the contract refuses the card Claude wrote, one line per error; empty when it doesn't."""
    try:
        rule_card(card)
    except ValidationError as invalid:
        return [error["msg"] for error in invalid.errors(include_url=False, include_input=False)]
    return []


def _chat_problems(chat: RuleChat, owned: list[RuleCard], targets: frozenset[str], cap_cents: int, *,
                   money_tools: Collection[str] = frozenset()) -> str | None:
    """What makes Claude's change unusable, one line per card: an ID used twice or of the compiler's own, a target
    that is neither a tool of the Desk nor an effect, a card for one person or agent that isn't one of the active
    ones kept under its ID for the same person or agent on the same target, or a card the contract refuses. A money card above the cap
    isn't one: it is the owner's to raise the limit (`AboveMoneyCap`). An auto money card with no limit is one, on a
    business money tool too, which the contract alone can't recognise: Claude gets the contract's own line for it."""
    if chat.change is None:
        return None
    active = {card.card_id: card for card in owned}
    problems, seen = [], set()
    for index, card in enumerate(chat.change.cards):
        def problem(text: str) -> None:
            problems.append(CHAT_CARD_ERROR_LINE.format(index=index, problem=text))

        if card.card_id in seen:
            problem(CHAT_ERRORS["twice"])
            continue
        seen.add(card.card_id)
        was = active.get(card.card_id)
        if card.card_id.startswith("default-"):
            problem(CHAT_ERRORS["default"])
        elif card.applies_to not in targets:
            problem(CHAT_ERRORS["target"])
        elif card.who in ("person", "agent") and (
                was is None or (was.applies_to, was.who, was.person_id, was.agent_key_id) != (
                    card.applies_to, card.who, card.person_id, card.agent_key_id)):
            problem(CHAT_ERRORS["scoped"])
        else:
            no_limit = auto_money(unchecked(card), money_tools) and card.max_amount_cents is None
            if no_limit or not above_cap(unchecked(card), active, cap_cents, money_tools=money_tools):
                errors = _contract_errors(card)
                if no_limit and _NO_LIMIT_ERROR not in errors:
                    errors.insert(0, _NO_LIMIT_ERROR)
                for error in errors:
                    problem(error)
    return "\n".join(problems) or None


async def latest_decisions(owner: OwnerCtx, desk_id: str, limit: int, *, tool: str | None = None,
                           before: tuple[datetime, str] | None = None) -> list[dict[str, Any]]:
    """The Desk's `kernel_ro.decisions` rows (of `tool` alone, when given), newest first by `(created_at,
    decision_id)`, after the `before` key when given, at most `limit`."""
    source = ro_view(owner.ro.schema, "decisions")
    conditions = [source.c.copy_id == owner.copy_id, source.c.desk_id == desk_id]
    if tool is not None:
        conditions.append(source.c.tool == tool)
    if before is not None:
        conditions.append(tuple_(source.c.created_at, source.c.decision_id) < tuple_(*before))
    try:
        await set_copy(owner.ro.conn, owner.copy_id)
        result = await owner.ro.conn.execute(select(source).where(*conditions).order_by(
            source.c.created_at.desc(), source.c.decision_id.desc()).limit(limit))
        return [dict(row._mapping) for row in result]
    finally:
        await owner.ro.done()


async def decision_entries(owner: OwnerCtx, desk_id: str, rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """The Desk's `kernel_ro.ledger_entries` rows the decisions name, by `seq`, for `decision_replayed`; an entry
    that can't be read is simply absent."""
    seqs = [row["ledger_seq"] for row in rows if row["ledger_seq"] is not None]
    return {entry["seq"]: entry
            for entry in (await owner.ro.rows("ledger_entries", desk_id=desk_id, seq=seqs) if seqs else [])}


async def recent_reasons(owner: OwnerCtx, desk_id: str) -> list[str]:
    """The kernel's owner text of the Desk's last decisions, newest first (untrusted: it may quote a visitor), with
    recorded history left out, since it never reaches a model (Plan 01d): a decision whose ledger entry the kernel
    marked replayed is dropped, and so is one that names no entry or whose entry can't be read (`decision_replayed`),
    so a decision of unknown origin isn't sent."""
    rows = await latest_decisions(owner, desk_id, RECENT_DECISIONS)
    entries = await decision_entries(owner, desk_id, rows)
    return [row["reason_plain"] for row in rows if not decision_replayed(row, entries.get(row["ledger_seq"]))]


async def chat(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, desk_id: str, text: str) -> RuleChatOut:
    """The owner's words about the rules, answered by Claude (route `rules_chat`, one structured call at medium effort
    bounded by `CHAT_TIMEOUT_S`, with one retry for a change code can't use, else 503 `model_unavailable`). Claude
    sees the money cap, the active owner cards, the Desk's tools, its last 20 decisions in the kernel's words (recorded
    history left out) and the owner's text, each wrapped as untrusted text. A question drafts nothing; a change is
    checked (`AboveMoneyCap` for a money card above the cap) and drafted on the version Claude saw."""
    row = await active_row(owner, desk_id)
    active = version_from_row(row)
    cap = version_cap(row)
    owned = [card for card in active.cards if not card.is_default]
    tools = await owner.ro.rows("tools", desk_id=desk_id, order_by=("tool",))
    money_tools = _money_tools(tools)
    listed = [{"tool": tool["tool"], "effects": list(tool["effects"]), "status": tool["status"]} for tool in tools]
    message = "\n\n".join([rules_chat_head(cap), wrap(RULES_TAG, json.dumps([chat_view(card) for card in owned])),
                            wrap(TOOLS_TAG, json.dumps(listed)),
                            wrap(RECENT_TAG, json.dumps(await recent_reasons(owner, desk_id))),
                            wrap(REQUEST_TAG, text)])
    targets = frozenset(tool["tool"] for tool in tools) | EFFECT_TARGETS
    answered = await ask_model(model, recorder(engine, owner, CHAT_ROUTE), RULES_CHAT_SYSTEM,
                               [{"role": "user", "content": [{"type": "text", "text": message}]}], RuleChat,
                               max_tokens=CHAT_MAX_TOKENS, route=CHAT_ROUTE, effort="medium",
                               check=lambda chat: _chat_problems(chat, owned, targets, cap, money_tools=money_tools),
                               timeout_s=CHAT_TIMEOUT_S)
    if answered is None:
        raise ApiProblem(503, "model_unavailable")
    if answered.change is None:
        return RuleChatOut(answer=answered.answer, draft=None)
    check_cap([unchecked(card) for card in answered.change.cards], active.cards, cap, money_tools=money_tools)
    cards = [rule_card(card) for card in answered.change.cards]
    return RuleChatOut(answer=answered.answer,
                       draft=await draft(owner, desk_id, cards, expected_parent=active.version))


# Suggestions -------------------------------------------------------------------------------------------------------


async def _suggested_card(owner: OwnerCtx, tool: str, effects: list[str], approved: list[dict],
                          cap_cents: int, *, label: str | None = None) -> RuleCard | None:
    """The auto card that would have let Claude handle the `approved` requests of `tool`: for anyone, or for the
    verified record owner when the tool reaches private data; on a money tool, up to the largest amount approved
    (each read from the kernel) and never above the money cap, and none while the cap is 0."""
    label = label if label is not None else TOOL_LABELS.get(tool, tool)
    card = {"card_id": f"suggested-{tool.replace('.', '-').replace('_', '-')}", "applies_to": tool, "mode": "auto",
            "who": "record_owner" if "private_data" in effects else "anyone",
            "reason": SUGGESTED_REASON.format(label=label.capitalize())}
    if tool in MONEY_TOOLS or {"charge", "pay_out"} & set(effects):
        if cap_cents <= 0:
            return None
        decisions = await asyncio.gather(*(owner.kernel.call("GET /decisions/{id}", path={"id": row["decision_id"]})
                                           for row in approved))
        amounts = [decision.action.amount_cents for decision in decisions
                   if decision.action is not None and decision.action.amount_cents is not None]
        if not amounts:
            return None
        amount = min(max(amounts), cap_cents)
        card |= {"max_amount_cents": amount,
                 "reason": SUGGESTED_MONEY_REASON.format(label=label.capitalize(), amount=dollars(amount))}
    return RuleCard(**card)


async def suggestions(owner: OwnerCtx, desk_id: str, now: datetime) -> list[Suggestion]:
    """A suggestion for each tool of the Desk the owner approved once (`allow_once`) at least 3 times in the 30 days
    before `now` (by when each request was made) that no auto card of the active rules covers, by tool."""
    row = await active_row(owner, desk_id)
    active, cap = version_from_row(row), version_cap(row)
    listed = await owner.ro.rows("tools", desk_id=desk_id)
    tools = {tool["tool"]: list(tool["effects"]) for tool in listed}
    labels = {row["tool"]: (row["business"]["title"] if row.get("business") is not None
                           else TOOL_LABELS.get(row["tool"], row["tool"])) for row in listed}
    since = now - SUGGEST_WINDOW
    recent = {decision["decision_id"]: decision for decision in await owner.ro.rows("decisions", desk_id=desk_id)
              if utc(decision["created_at"]) >= since and decision["tool"] in tools}
    approved: dict[str, list[dict]] = {}
    if recent:
        for approval in await owner.ro.rows("approvals", decision_id=list(recent), answer="allow_once"):
            decision = recent[approval["decision_id"]]
            approved.setdefault(decision["tool"], []).append(decision)
    found = []
    for tool, rows in sorted(approved.items()):
        if len(rows) < SUGGEST_AFTER or any(each.mode == "auto"
                                            for each in covering_cards(active.cards, tool, tools[tool])):
            continue
        card = await _suggested_card(owner, tool, tools[tool], rows, cap, label=labels[tool])
        if card is not None:
            found.append(Suggestion(tool=tool, count=len(rows), card=card,
                                    text=SUGGESTION_TEXT.format(count=len(rows), label=labels[tool])))
    return found


async def draft_suggestion(owner: OwnerCtx, desk_id: str, tool: str, now: datetime) -> RulesDraft:
    """The suggestion for `tool` added to the active owner cards, drafted; 404 when there is none now."""
    suggestion = next((each for each in await suggestions(owner, desk_id, now) if each.tool == tool), None)
    if suggestion is None:
        raise ApiProblem(404, "not_found")
    return await draft_added(owner, desk_id, [suggestion.card])


# A tool's decisions ------------------------------------------------------------------------------------------------


def _cursor(row: dict[str, Any]) -> str:
    """The opaque cursor after `row`: its `(created_at, decision_id)` key."""
    key = json.dumps([utc(row["created_at"]).isoformat(), row["decision_id"]], separators=(",", ":"))
    return base64.urlsafe_b64encode(key.encode()).decode().rstrip("=")


def _after(cursor: str) -> tuple[datetime, str]:
    """The key an opaque cursor names; 422 `invalid` for one this API didn't make."""
    try:
        at, decision_id = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        moment = datetime.fromisoformat(at)
    except (binascii.Error, UnicodeDecodeError, ValueError, TypeError):
        raise ApiProblem(422, "invalid") from None
    if moment.tzinfo is None or not isinstance(decision_id, str):
        raise ApiProblem(422, "invalid")
    return moment, decision_id


async def tool_decisions(owner: OwnerCtx, desk_id: str, tool: str, *, before: str | None,
                         limit: int) -> ToolDecisions:
    """A page of the Desk's decisions on `tool`, newest first, from the `before` cursor: 404 for a tool the Desk
    doesn't have. Each is marked `replayed` when it is recorded history, failing closed (`decision_replayed`): one
    whose ledger entry can't be read is marked too, so a decision of unknown origin never shows as live.
    Owner-only refusal reasons are read concurrently and cached by final decision version; an unavailable or
    refused kernel read leaves that reason null while the rest of the history still renders."""
    if await owner.ro.one("tools", desk_id=desk_id, tool=tool) is None:
        raise ApiProblem(404, "not_found")
    rows = await latest_decisions(owner, desk_id, limit + 1, tool=tool,
                                  before=None if before is None else _after(before))
    page = rows[:limit]
    who = await people(owner, desk_id)
    entries = await decision_entries(owner, desk_id, page)
    reasons = await asyncio.gather(*(refusal_reason(owner, row["decision_id"], row["session_id"], row["state"],
                                                   row["ledger_seq"]) for row in page))
    return ToolDecisions(
        items=[ToolDecisionRow(decision_id=row["decision_id"], session_id=row["session_id"],
                               display_name=who.name(row["session_id"]), outcome=row["outcome"], state=row["state"],
                               reason_plain=row["reason_plain"], owner_plain=reason, created_at=row["created_at"],
                               ledger_seq=row["ledger_seq"],
                               replayed=decision_replayed(row, entries.get(row["ledger_seq"])))
               for row, reason in zip(page, reasons, strict=True)],
        next_before=_cursor(page[-1]) if len(rows) > limit else None)
