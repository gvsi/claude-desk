"""Decisions: deciding a proposed tool call (`POST /decide`) and reading decisions back.

`cedar_request` builds the master plan's `request_json` ("Cedar request shape") from kernel-built
values only: the principal from the session's rows (an agent's `mandate_remaining_cents` from its
mandate as it stands, `mandates.session_remaining`), the action as its adapter normalized it, and
the money cap of the version it will be evaluated against (`context.auto_money_cap_cents`, which
the baseline's `auto_money_cap` reads; `evaluate` refuses a request whose cap isn't its version's).
Optional attributes appear only when set, since the schema reads them behind `has`.
`owner_approved` is never sent: the engine sets it for each evaluation, over any value sent.

`decide_call` runs "Evaluation" for one call, after the route has answered the session-state
rows ("Session state responses": token, copy, closed, generation, mode `owner`) on the session
row, which the route holds locked until the decision commits:

0. A call ID the decisions table can't keep (`keepable_call_id`), or args canonical JSON can't hold
   (`call_sha256`), is 422 `invalid`.
1. Idempotency on `(session_id, generation, call_id)`: the same call returns its stored decision,
   another Desk, tool or args is 409 `conflict`.
2. A paused session (the breaker) gets a stored `refuse`.
3. Step 1: an unknown tool, one this session isn't given, args its adapter's strict model
   refuses (or text the database can't keep), or a call the adapter can't resolve is refused
   before any action exists.
4. With no active version that loads, the action is refused: `version_outdated` for one an
   earlier kernel stored that wasn't rebuilt (`activation.outdated`).
5. `evaluate`: partial evaluation first; the reviewer runs only when its score can change the
   outcome, and every verdict comes from a full evaluation. Any evaluation error refuses.

Everything a decision writes commits in the caller's transaction: the action, the decision, its
ledger entries (`review`, `decide`, `breaker`) and the owner's alerts. A decision is signed over
its state and status line (`sign_decision`), and every later state change ledgers and re-signs it
(`set_state`). Expiry is lazy (`expire_if_due`). A call refused before it has a decision (that
call ID or those args), or failed by anything but a refusal once its session is known (a
`KernelRepo` refusal, a database error: 500 `internal`), still gets its `decide` entry, written
after the transaction has rolled back.

A call's free-text arguments are Claude's wording and untrusted (they may repeat what a visitor
said, or not), and reach the decision only as data: the reviewer sees them under `untrusted_args`,
and the owner reads them quoted after "Claude's note", never as the visitor's words.
"""

import hashlib
import json
import logging
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial
from typing import Any, get_args
from zoneinfo import ZoneInfo

import desk_kernel
from fastapi import APIRouter, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.attributes import set_committed_value

from desk.contracts import (
    ApprovalAnswer,
    BusinessToolDef,
    ToolProfile,
    Decision,
    InboxNotice,
    LedgerEntry,
    LedgerEvent,
    NormalizedAction,
    Outcome,
    Principal,
    Review,
    RuleCard,
    ToolName,
    money_tool,
)
from desk.db.models import Action as ActionRow
from desk.db.models import Business, Desk, Execution, Person, Tool
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_api import DecideRequest
from desk.kernel_service import (activation, adapters, auth, clock, compiler, demo_inbox, desks, explain, ledger, mandates,
                                 render, repo)
from desk.kernel_service.adapters.base import Adapter, AdapterRefusal, NormalizeCtx, claudes_note, quoted
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.baseline_reasons import BASELINE_RULE_PLAIN
from desk.kernel_service.decisions import CallUsage, ReviewAction, ReviewCard, ReviewFact, ReviewInput, Reviewed
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, new_id, route_template
from desk.kernel_service.sessions import principal_for, verified

log = logging.getLogger(__name__)

PRINCIPAL_TYPES = {"visitor": "Visitor", "agent": "Agent", "owner": "Owner"}
RESOURCE_TYPES = {"quote": "Quote", "slot": "Slot", "booking": "Booking", "document": "Document",
                  "charge": "Charge", "desk": "Desk"}


def cedar_request(principal: Principal, action: NormalizedAction, *, tz: str, now: datetime,
                  auto_money_cap_cents: int, review: Review | None = None,
                  mandate_remaining_cents: int | None = None) -> dict[str, Any]:
    """The request for `PolicyEngine.decide`. `local_dow` (0 = Monday) and `local_minute` are taken in
    the business's time zone `tz` for the action's `starts_at`, else for `now`.
    `auto_money_cap_cents` is the money cap of the version the request is evaluated against
    (`activation.version_cap`), never above `AUTO_MONEY_HARD_CAP_CENTS`. `review` is the
    reviewer's whole `Review` (the engine keeps its scores only on an "allow" recommendation);
    `mandate_remaining_cents` is an `Agent` attribute and is ignored for any other principal."""
    if now.tzinfo is None:
        raise ValueError("now must be an aware datetime")
    cap = compiler.capped(auto_money_cap_cents)
    local_dow, local_minute = clock.local_dow_minute(action.starts_at or now, ZoneInfo(tz))

    principal_type = PRINCIPAL_TYPES[principal.kind]
    attrs: dict[str, Any] = {
        # the rule SessionState.verified reports, so the API and Cedar agree
        "verified": verified(principal.kind, principal.assurance, principal.person_id),
        "assurance": principal.assurance,
        "copy": principal.copy_id,
    }
    if principal.person_id is not None:
        attrs["person_id"] = principal.person_id
    if principal.kind == "agent":
        if not principal.agent_key_id:
            raise ValueError("an agent principal carries its agent_key_id")
        attrs["agent_key_id"] = principal.agent_key_id
        if mandate_remaining_cents is not None:
            attrs["mandate_remaining_cents"] = mandate_remaining_cents

    resource = action.resource
    resource_type = RESOURCE_TYPES[resource.kind]
    resource_attrs: dict[str, Any] = {"copy": action.copy_id}
    if resource.owner_person_id is not None:
        resource_attrs["owner_person_id"] = resource.owner_person_id

    context: dict[str, Any] = {
        "record_owner_match": principal.person_id is not None and resource.owner_person_id == principal.person_id,
        "local_dow": local_dow,
        "local_minute": local_minute,
        "auto_money_cap_cents": cap,
    }
    for name in ("list_cents", "discount_bp", "amount_cents", "recipient"):
        value = getattr(action, name)
        if value is not None:
            context[name] = value
    if review is not None:
        context["review"] = review.model_dump()

    principal_uid = {"type": principal_type, "id": principal.session_id}
    resource_uid = {"type": resource_type, "id": resource.id}
    return {
        "principal": principal_uid,
        "action": action.tool,
        "resource": resource_uid,
        "context": context,
        "entities": [
            {"uid": principal_uid, "attrs": attrs, "parents": []},
            {"uid": resource_uid, "attrs": resource_attrs, "parents": []},
        ],
    }


def with_review(request: dict[str, Any], review: Review) -> dict[str, Any]:
    """`request` with the reviewer's `Review` in its context (the engine keeps the scores only on
    an "allow" recommendation)."""
    return {**request, "context": {**request["context"], "review": review.model_dump()}}


# ---- Which tools a session is given ("Model-visible tools") ---------------------------------------

OWNER_TOOLS: frozenset[str] = frozenset({"native.fetch_website", "native.read_memory", "native.web_search"})
ANSWERING_OFF_TOOLS: frozenset[str] = frozenset({"native.capture_lead", "native.request_callback"})
TOOL_NAMES: frozenset[str] = frozenset(get_args(ToolName))

# The "Given to" column by session kind alone: every tool a session of that kind could be given
# in some standing (verified or not, with a mandate or not, Answering on or off).
_VISITOR_OR_AGENT = frozenset({
    "native.quote", "native.find_slots", "native.book", "native.release_document", "native.payment_link",
    "native.capture_lead", "native.request_callback", "native.start_verification", "payments.list_charges"})
DECLARED_TOOLS: dict[str, frozenset[str]] = {
    "visitor": _VISITOR_OR_AGENT | {"payments.create_refund"},
    "agent": _VISITOR_OR_AGENT | {"native.charge_mandate"},
    "owner": OWNER_TOOLS,
}


def declared_tools(kind: str) -> frozenset[str]:
    """Every tool a session of `kind` could ever be given; `tools_given` is always a subset."""
    return DECLARED_TOOLS.get(kind, frozenset())


async def enabled_tools(ctx: KernelCtx, desk_id: str) -> dict[str, Tool]:
    """The Desk's enabled `tools` rows that carry a pinned profile, by tool name: the only tools
    `tools_given` may give."""
    rows = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.desk_id == desk_id, Tool.status == "enabled")))
    return {row.tool: row for row in rows if row.profile is not None and row.profile_sha256}


def tools_given(principal: Principal, session_row: SessionRow, desk_row: Desk, enabled: Iterable[str]) -> set[str]:
    """The tools this session may call now: the "Given to" column of "Model-visible tools" for its
    kind and standing, kept to the Desk's `enabled` tools that have a registered adapter. With the
    Desk's Answering switch off, a visitor or agent (but not an owner's preview) keeps only lead
    capture and callbacks."""
    if principal.kind == "owner":
        given = set(OWNER_TOOLS)
    else:
        is_verified = verified(principal.kind, principal.assurance, principal.person_id)
        given = {"native.quote", "native.find_slots", "native.book", "native.capture_lead", "native.request_callback"}
        given |= {"native.release_document", "payments.list_charges"} if is_verified else {"native.start_verification"}
        if principal.kind == "visitor":
            given.add("native.payment_link")
            if is_verified:
                given.add("payments.create_refund")
        elif principal.mandate_id is not None:          # an agent holding a verified mandate
            given |= {"native.payment_link", "native.charge_mandate"}
        if not desk_row.answering and not session_row.preview:
            given &= ANSWERING_OFF_TOOLS
    native = given & set(enabled) & set(adapters.ADAPTERS)
    if hasattr(enabled, "items"):
        from desk.kernel_service.adapters import blocks
        # Rows own their status; wrappers must carry an explicitly enabled profile.
        for tool, row in enabled.items():
            profile = row if isinstance(row, ToolProfile) else row.profile
            if (profile is not None and profile.source == "business" and profile.business is not None
                    and (row.status if hasattr(row, "status") else row.profile.status) == "enabled"
                    and profile.business.config.block in blocks.SUPPORTED_BLOCKS
                    and blocks.BLOCK_BASE[profile.business.config.block] in given):
                native.add(tool)
    return native


# ---- Evaluation (steps 2 to 5) --------------------------------------------------------------------

ReviewSource = Callable[[list[RuleCard]], Awaitable[Reviewed]]


@dataclass(frozen=True)
class Evaluation:
    """What the policy engine and the reviewer made of one action."""

    outcome: Outcome
    policy_ids: list[str]                 # the deciding policies, as the engine names them (<set>.<@id>)
    card_ids: list[str]                   # the cards behind them
    review: Review | None                 # the reviewer's answer, when it ran and answered
    usage: CallUsage | None               # the reviewer call, when one was made
    strike: bool                          # a review that was used recommended "block" (counted at /decide only)
    needed_review: bool                   # the pre phase said the score could change the outcome
    errored: bool = False                 # an evaluation error refused it


# The compiler writes `@id("...") @card("a,b") @tier("...") ...` at the head of every policy.
_POLICY_HEAD = re.compile(r'^@id\("([^"]+)"\) @card\("([^"]*)"\)(?: @tier\("([^"]*)"\))?', re.MULTILINE)


@dataclass(frozen=True)
class PolicyHead:
    """What the compiler's annotations say about one policy: the cards behind it and its tier."""

    cards: tuple[str, ...]
    tier: str | None


def policy_heads(version_row: PolicyVersionRow) -> dict[str, PolicyHead]:
    """Each policy of a stored version, by the engine's name for it (`<set>.<@id>`), read from the
    `@card` and `@tier` annotations of its `F`, `A` and `H` texts. Baseline policies belong to no
    card."""
    cedar = version_row.cedar or {}
    return {f"{name}.{policy_id}": PolicyHead(tuple(card for card in cards.split(",") if card), tier or None)
            for name in ("F", "A", "H") for policy_id, cards, tier in _POLICY_HEAD.findall(cedar.get(name) or "")}


def policy_cards(version_row: PolicyVersionRow) -> dict[str, list[str]]:
    """The cards behind each policy of a stored version, by the engine's name for the policy."""
    return {policy_id: list(head.cards) for policy_id, head in policy_heads(version_row).items()}


def _card_ids(policy_ids: Iterable[str], by_policy: Mapping[str, list[str]]) -> list[str]:
    return sorted({card for policy_id in policy_ids for card in by_policy.get(policy_id, ())})


def _engine(ctx: KernelCtx, key: str, request: dict[str, Any], phase: str) -> dict[str, Any]:
    verdict = json.loads(ctx.policies.engine.decide(key, json.dumps(request), phase))
    if verdict["errors"]:
        log.warning("decide_evaluation_error key=%s phase=%s errors=%d", key, phase, len(verdict["errors"]))
    return verdict


async def evaluate(ctx: KernelCtx, version_row: PolicyVersionRow, request: dict[str, Any], *,
                   review_source: ReviewSource) -> Evaluation:
    """Steps 2 to 5 of "Evaluation" for `request` (without a review) on a loaded version.

    The pre phase runs partial evaluation with the review unknown. Only when the score can change
    the outcome is `review_source` called, with the review-gated cards still pending (at `/decide`
    it asks the reviewer; at execution it returns the stored review); a review that recommends
    anything but "allow" can't keep an auto allow, which goes on to `approvable`. Every outcome
    comes from a full evaluation, and any evaluation error refuses, as does a request whose money
    cap isn't the version's (`activation.version_cap`)."""
    key = activation.version_key(version_row.desk_id, version_row.version)
    if request.get("context", {}).get("auto_money_cap_cents") != activation.version_cap(version_row):
        log.error("decide_cap_mismatch key=%s", key)
        return Evaluation("refuse", [], [], None, None, strike=False, needed_review=False, errored=True)
    by_policy = policy_cards(version_row)
    pre = _engine(ctx, key, request, "pre")
    if pre["errors"]:
        return Evaluation("refuse", [], [], None, None, strike=False, needed_review=False, errored=True)
    review: Review | None = None
    usage: CallUsage | None = None
    strike = False
    needed_review = pre["outcome"] == "needs_review"
    if needed_review:
        cards = {card.card_id: card for card in version_row.cards}
        pending = [cards[card_id] for card_id in _card_ids(pre["pending_policy_ids"], by_policy) if card_id in cards]
        reviewed = await review_source(pending)
        review, usage = reviewed.review, reviewed.usage
        out = _engine(ctx, key, with_review(request, review) if review is not None else request, "final")
        if review is not None and out["outcome"] == "allow" and review.recommendation != "allow":
            out = _engine(ctx, key + ":approvable", request, "final")      # the auto allow is discarded
        strike = review is not None and review.recommendation == "block"
    else:
        out = _engine(ctx, key, request, "final")                          # a full evaluation decides
    if out["errors"] or out["outcome"] not in ("allow", "hold", "refuse"):
        return Evaluation("refuse", [], [], review, usage, strike=strike, needed_review=needed_review, errored=True)
    policy_ids = sorted(out["policy_ids"])
    return Evaluation(out["outcome"], policy_ids, _card_ids(policy_ids, by_policy), review, usage, strike=strike,
                      needed_review=needed_review)


# ---- Signing and state changes --------------------------------------------------------------------

DECISION_DOMAIN = b"desk-decision-v1\0"
STATE_OF: dict[str, str] = {"allow": "allowed", "hold": "held", "refuse": "refused"}
LIFETIME: dict[str, timedelta] = {"allow": timedelta(seconds=60), "hold": timedelta(hours=24), "refuse": timedelta(0)}


def sign_decision(signer: desk_kernel.Signer, *, decision_id: str, session_id: str, state: str, visitor_plain: str,
                  ledger_seq: int) -> str:
    """The master's `Decision.signature`: Ed25519 over `b"desk-decision-v1\\0"` + sha256 of
    `canonical_json({decision_id, session_id, state, visitor_plain, ledger_seq})`."""
    body = {"decision_id": decision_id, "session_id": session_id, "state": state, "visitor_plain": visitor_plain,
            "ledger_seq": ledger_seq}
    digest = hashlib.sha256(desk_kernel.canonical_json(json.dumps(body)).encode()).digest()
    return signer.sign(DECISION_DOMAIN, digest)


async def _append(ctx: KernelCtx, row: DecisionRow, kind: str, summary: dict[str, Any]) -> LedgerEntry:
    return await ledger.append(ctx, copy_id=row.copy_id, desk_id=row.desk_id, event=LedgerEvent(
        kind=kind, origin="kernel", session_id=row.session_id, ref_id=row.decision_id, summary=summary))


def _sign(ctx: KernelCtx, row: DecisionRow) -> None:
    row.signature = sign_decision(ctx.signer, decision_id=row.decision_id, session_id=row.session_id, state=row.state,
                                  visitor_plain=row.visitor_plain, ledger_seq=row.ledger_seq)


def status_line(state: str, *, tool: str, session: SessionRow, owner: str, key: str | None = None,
                business=None) -> str:
    """A decision's status line in `state`, in the session's language: the template `key` when
    given (why a refusal happened, say, or `tool_unavailable` for a `refused_at_execution` whose
    connected tool couldn't be reached); once a visitor's or an agent's action has run, what was
    done (`render.executed_status`, which raises KeyError for a tool without a line); in any other
    state, or for an owner session's own setup action, the state's template. The line is the
    decision's `visitor_plain`, which the visitor reads, so a `key` that isn't a decision's status
    line (`render.DECISION_STATUS_KEYS`: no receipt, so no owner-only line) raises ValueError."""
    if key is not None and key not in render.DECISION_STATUS_KEYS:
        raise ValueError(f"{key!r} is not a decision's status line")
    lang = render.language(session.last_language)
    if key is not None:
        return render.status(key, lang, owner=owner)
    if state == "executed" and session.kind != "owner":
        return render.executed_status(tool, lang, owner=owner, business=business)
    return render.status(state, lang, owner=owner)


# How a session that no longer stands ended (`execute.session_ended`), and the parts of the re-check
# that can fail (`execute.recheck_under`) other than the Desk's, each a refusal at execution's `check`.
SESSION_ENDED_CHECKS = frozenset({"contact_changed", "person_removed", "session_closed"})
# Only changed rules or tools justify the rules-changed owner line. Session state, approval
# bindings, runtime conditions, adapter refusals and unreachable servers name no cause.
RECHECK_CHECKS = frozenset({"tool", "profile", "pin", "policy"})


def owner_refusal_key(reason: str | None, check: str | None) -> str:
    """The owner line (`render.OWNER_STATUS`) for a refusal at execution, from its own ledgered
    `reason` and `check`: a deleted Desk (`desk`) says so; a private release whose session ended
    (`session_ended`) says how; the checks in `RECHECK_CHECKS` say the rules changed; anything else
    (changed runtime conditions, session state or approval binding, an adapter's normalization or
    `prepare` refusal, or an unreachable server) names no cause."""
    if check == "desk":
        return "refused_desk_deleted"
    if reason == "session_ended" and check in SESSION_ENDED_CHECKS:
        return f"refused_{check}"
    if reason == "rules_changed" and check in RECHECK_CHECKS:
        return "refused_rules_changed"
    return "refused_fallback"


# Every line `owner_refusal_key` picks is an owner line, checked at import: a missing one would raise in
# `set_state` and leave a refusal at execution without its line (in T2, an action settled `unknown`).
if not {owner_refusal_key(reason, check) for reason in ("session_ended", "rules_changed", None)
        for check in (*SESSION_ENDED_CHECKS, *RECHECK_CHECKS, "desk", None)} <= render.OWNER_STATUS_KEYS:
    raise RuntimeError("every refusal at execution has an owner line")


async def set_state(ctx: KernelCtx, row: DecisionRow, state: str, *, kind: str = "decide",
                    summary: dict[str, Any], status: str | None = None) -> LedgerEntry:
    """Moves a decision to `state` in the caller's transaction: the status line for the new state
    (`status_line`, the template `status` when given, which must be a decision's status line), the
    owner's line, a ledger entry (`kind`, `summary`, kernel-built values only) and a signature over
    the status line and the entry. Lock the row first. The lines are rendered first, so a `status`
    that isn't a decision's status line raises ValueError before anything here changes. The
    caller's handling decides the rest: in T1 and on the answer path the request fails and its
    transaction rolls back; in T2, `execute._run` settles the action `unknown`, with nothing
    delivered.

    The owner's line (`owner_plain`) is set for `refused_at_execution` alone, picked by the
    refusal's own `reason` and `check` in `summary` (`owner_refusal_key`, which always picks one)
    and rendered in the owner's language (`render.owner_line`), never the session's; every other
    state clears it. It isn't signed and never enters the summary, so no ledger entry holds it."""
    session = (await ctx.db.scalars(ctx.repo.scoped(
        select(SessionRow).where(SessionRow.session_id == row.session_id)))).one()
    adapter = await adapters.resolve(ctx, row.desk_id, row.tool) if state == "executed" else None
    visitor_plain = status_line(state, tool=row.tool, session=session,
                                owner=(await _business(ctx, row.desk_id)).owner_display_name, key=status,
                                business=adapter.profile.business if adapter is not None else None)
    owner_plain = None
    if state == "refused_at_execution":
        owner_plain = render.owner_line(owner_refusal_key(summary.get("reason"), summary.get("check")))
    row.state = state
    row.visitor_plain = visitor_plain
    row.owner_plain = owner_plain
    row.updated_at = ctx.clock.now()
    entry = await _append(ctx, row, kind, summary)
    row.ledger_seq = entry.seq
    _sign(ctx, row)
    await ctx.db.flush()
    return entry


async def _expiry_due(ctx: KernelCtx, row: DecisionRow) -> bool:
    if ctx.clock.now() < row.expires_at:
        return False
    if row.state == "held":
        return True
    if row.state != "allowed" or row.action_id is None:
        return False
    started = (await ctx.db.execute(ctx.repo.scoped(
        select(Execution.action_id).where(Execution.action_id == row.action_id)))).first()
    return started is None                # an allow that began executing is the executor's to settle


async def expire_if_due(ctx: KernelCtx, row: DecisionRow) -> DecisionRow:
    """Lazy expiry ("Decision lifecycle"), on every read: an allow past its 60 s that never began
    executing, or a hold past its 24 h, becomes `expired`, ledgered and re-signed. The row is
    locked and checked again before it changes, so two readers expire it once."""
    if not await _expiry_due(ctx, row):
        return row
    locked = (await ctx.db.scalars(ctx.repo.scoped(
        select(DecisionRow).where(DecisionRow.decision_id == row.decision_id).with_for_update()
        .execution_options(populate_existing=True)))).one()
    if await _expiry_due(ctx, locked):
        await set_state(ctx, locked, "expired", summary={"decision_id": locked.decision_id, "state": "expired"})
    return locked


async def _answers_now(ctx: KernelCtx, row: DecisionRow) -> tuple[list[ApprovalAnswer], dict[str, Any]]:
    """What a held decision offers the owner now: `answers_for` its action and the standing it was
    decided with (`allow_person_eligible`), at the active version's money cap, and the version and
    cap it was judged under. `deny_always` stays as the decision was offered it, since whether an
    `ask` card decided the hold (`held_by_ask`) belongs to the version that decided it, whatever
    the active one is now."""
    action = normalized_action((await ctx.db.scalars(ctx.repo.scoped(
        select(ActionRow).where(ActionRow.action_id == row.action_id)))).one())
    version_row = await activation.active_version(ctx, row.desk_id)
    cap = activation.version_cap(version_row)
    answers = answers_for(row.allow_person_eligible, action, ask_held="deny_always" in row.answers,
                          auto_money_cap_cents=cap)
    return answers, {"policy_version": version_row.version if version_row is not None else 0,
                     "auto_money_cap_cents": cap}


async def refresh_answers(ctx: KernelCtx, row: DecisionRow) -> DecisionRow:
    """A held money decision's answers as the active version's money cap offers them now, on every
    read ("Decision lifecycle"): `allow_person` drops out while the action's amount is above the
    active cap and comes back when a later version's cap covers it. Only the cap is read again:
    whether the asker could be given `allow_person` at all stays what it was when the hold was made
    (`allow_person_eligible`), so a hold a stranger asked for never gains it when the session
    confirms who it is later. A change is persisted, ledgered `decide` `{decision_id, answers,
    policy_version, auto_money_cap_cents}` and re-signed, as lazy expiry is: the row is locked and
    checked again first, so two readers change it once."""
    if row.state != "held" or row.action_id is None or not is_money(row.tool, row.effects):
        return row
    answers, _ = await _answers_now(ctx, row)
    if answers == list(row.answers):
        return row
    locked = (await ctx.db.scalars(ctx.repo.scoped(
        select(DecisionRow).where(DecisionRow.decision_id == row.decision_id).with_for_update()
        .execution_options(populate_existing=True)))).one()
    if locked.state != "held":
        return locked
    answers, judged = await _answers_now(ctx, locked)
    if answers == list(locked.answers):
        return locked
    locked.answers = answers
    locked.updated_at = ctx.clock.now()
    locked.ledger_seq = (await _append(ctx, locked, "decide",
                                       {"decision_id": locked.decision_id, "answers": answers, **judged})).seq
    _sign(ctx, locked)
    await ctx.db.flush()
    return locked


# ---- Reading decisions back -----------------------------------------------------------------------

def normalized_action(row: ActionRow) -> NormalizedAction:
    return NormalizedAction(action_id=row.action_id, copy_id=row.copy_id, desk_id=row.desk_id,
                            session_id=row.session_id, generation=row.generation, tool=row.tool, effects=row.effects,
                            args_sha256=row.args_sha256, profile_sha256=row.profile_sha256, resource=row.resource,
                            list_cents=row.list_cents, discount_bp=row.discount_bp, amount_cents=row.amount_cents,
                            recipient=row.recipient, starts_at=row.starts_at)


async def decision_contract(ctx: KernelCtx, row: DecisionRow, *, inbox: Sequence[InboxNotice] = (),
                            for_owner: bool = False) -> Decision:
    """The `Decision` a stored row answers with. `answers` are the owner's choices on a held
    request, so they are listed while it is `held` and in no other state (the row keeps what it
    was offered). `inbox` holds the alerts the call that created it wrote; a decision read back
    later carries none. `owner_plain` is the owner's alone: only an answer to the owner's own
    credential (`for_owner`: the owner's read by ID, the answer to a held request) carries it, and
    every other answer, to a session or an agent, has None whatever the row holds."""
    action = None
    if row.action_id is not None:
        action_row = (await ctx.db.scalars(ctx.repo.scoped(
            select(ActionRow).where(ActionRow.action_id == row.action_id)))).one()
        action = normalized_action(action_row)
    return Decision(decision_id=row.decision_id, session_id=row.session_id, call_id=row.call_id, action=action,
                    outcome=row.outcome, state=row.state, policy_version=row.policy_version,
                    policy_ids=row.policy_ids, card_ids=row.card_ids, review=row.review,
                    reason_plain=row.reason_plain, owner_plain=row.owner_plain if for_owner else None,
                    visitor_plain=row.visitor_plain, answers=row.answers if row.state == "held" else [],
                    expires_at=row.expires_at, inbox=list(inbox), ledger_seq=row.ledger_seq,
                    signature=row.signature or "")


async def find_call(ctx: KernelCtx, session_id: str, generation: int, call_id: str) -> DecisionRow | None:
    return (await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow).where(
        DecisionRow.session_id == session_id, DecisionRow.generation == generation,
        DecisionRow.call_id == call_id)))).one_or_none()


async def _business(ctx: KernelCtx, desk_id: str) -> Business:
    return (await ctx.db.scalars(ctx.repo.scoped(
        select(Business).join(Desk, Desk.business_id == Business.business_id).where(Desk.desk_id == desk_id)))).one()


# ---- Deciding a call ------------------------------------------------------------------------------

DECIDE_ROUTE = "POST /decide"
TOOL_NAME_CHARS = 64                      # a refused call's name is stored cut to this
CALL_ID_CHARS = 128                       # a longer call ID is refused: a long one can overflow the decisions index
BREAKER_STRIKES = 3
BREAKER_ALERT = ("Claude paused a conversation after the reviewer flagged three requests as attempts to get "
                 "around your rules. It stays paused until you resume it.")

# Why a call was refused without a full evaluation: a fixed code (ledgered) and the owner's words.
REFUSED_PLAIN: dict[str, str] = {
    "paused": "The conversation is paused, so it was refused.",
    "unknown_tool": "This Desk has no tool for that, so it was refused.",
    "not_given": "This conversation can't use that tool, so it was refused.",
    "invalid_args": "The request wasn't in a form the tool takes, so it was refused.",
    "adapter_refused": "It didn't match your records, so it was refused.",
    "no_active_version": "This Desk has no rules turned on, so it was refused.",
    "version_unloadable": "Your rules couldn't be loaded, so it was refused.",
    "version_outdated": "Your rules haven't been checked since an update, so it was refused.",
    "evaluation_error": "Your rules couldn't be checked for it, so it was refused.",
}
BASELINE_PLAIN = "The always-on safety rules don't allow it."
UNCOVERED_PLAIN = "None of your rules covers this yet, so it was refused."
# How the deciding rules decided, said before their own text (the owner's wording, 2026-10-30).
RULE_LEAD_INS: dict[str, str] = {
    "allow": "Your rule allows it",
    "ask": "Your rule asks you first",    # a hold an owner's `ask` card decided (the default ask has none)
    "limit": "It goes past your rule, so it waits for you",   # any other hold: an `auto` card's hold twin
    "refuse": "Your rule says never",     # a refusal's deciding rules are `never` cards; the baseline has none
}
# A hold only the compiler's default ask decided: no rule of the owner's decided, so it takes no
# lead-in and no quotes, only the default ask's own words.
DEFAULT_ASK_PLAIN = compiler.DEFAULT_REASON
REVIEW_PLAIN: dict[str, str] = {
    "absent": "The reviewer couldn't check it.",
    "block": "The reviewer flagged something in the request as a possible way around your rules.",
    "hold": "The reviewer suggested asking you.",
    "unsure": "The reviewer wasn't sure enough to let it through.",
    "allow": "The reviewer checked it.",
}


def call_sha256(req: DecideRequest) -> str:
    """sha256 of `canonical_json_any({desk_id, tool, args})` as received (raw args may hold floats).
    Raises ValueError for args canonical JSON can't hold."""
    text = json.dumps({"desk_id": req.desk_id, "tool": req.call.tool, "args": req.call.args})
    return hashlib.sha256(desk_kernel.canonical_json_any(text).encode()).hexdigest()


def keepable_call_id(call_id: str) -> bool:
    """A call ID the decisions table can store and index: text Postgres can keep (`repo.storable`),
    at most 128 characters."""
    return len(call_id) <= CALL_ID_CHARS and repo.storable(call_id)


def _storable_json(value: Any) -> bool:
    """Every key and string in a JSON value is text Postgres can keep."""
    if isinstance(value, str):
        return repo.storable(value)
    if isinstance(value, dict):
        return all(repo.storable(key) and _storable_json(item) for key, item in value.items())
    if isinstance(value, list):
        return all(_storable_json(item) for item in value)
    return True


def stored_name(name: str) -> str:
    """A called tool name as a refused decision keeps it: cut to 64 characters, with anything
    Postgres can't store replaced, so a hostile name can't make the record fail."""
    return name[:TOOL_NAME_CHARS].replace("\0", "\ufffd").encode("utf-8", "replace").decode("utf-8")


def args_sha256(args_json: dict[str, Any]) -> str:
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(args_json)).encode()).hexdigest()


def is_money(tool: str, effects: Iterable[str]) -> bool:
    """Does the tool take or pay out money (`desk.contracts.money_tool`, under the name approvals reads)."""
    return money_tool(tool, effects)


@dataclass(frozen=True)
class HoldDecider:
    """The cards that decided a hold, and whether they are `ask` cards."""

    ask: bool                             # an ask card decided it; otherwise an auto card's hold twin did
    card_ids: tuple[str, ...]             # the cards that decided, by `card_id`


def hold_decider(version_row: PolicyVersionRow | None, policy_ids: Iterable[str]) -> HoldDecider | None:
    """Which cards decided a hold, read from the deciding policies' `@tier` and the cards their
    `@card` names in the version that decided it ("Decision lifecycle").

    A hold's deciding policies are the `@tier("hold")` permits of `H` that matched: ask cards' own
    and the twins of auto cards. Hold permits carry no exclusions, so every matching one is listed,
    and "Coverage and overlap" settles which cards decided: the most specific, the ask cards among
    them when there are any (an ask card wins a tie). A person's own auto card thus decides over
    the default ask that matches them too. None when there is no deciding policy, or any is no hold
    permit of a known card (step 5's money hold, decided by an auto permit)."""
    if version_row is None:
        return None
    heads = policy_heads(version_row)
    cards = {card.card_id: card for card in version_row.cards}
    ranked: list[tuple[tuple[int, int], bool, tuple[str, ...]]] = []
    for policy_id in policy_ids:
        head = heads.get(policy_id)
        if head is None or head.tier != "hold" or not head.cards or not set(head.cards) <= cards.keys():
            return None
        behind = [cards[card_id] for card_id in head.cards]
        ranked.append((max(compiler.specificity(card) for card in behind), all(card.mode == "ask" for card in behind),
                       head.cards))
    if not ranked:
        return None
    top = max(rank for rank, _, _ in ranked)
    ask = any(is_ask for rank, is_ask, _ in ranked if rank == top)
    return HoldDecider(ask, tuple(sorted({card_id for rank, is_ask, ids in ranked if rank == top and is_ask == ask
                                          for card_id in ids})))


def held_by_ask(version_row: PolicyVersionRow | None, policy_ids: Iterable[str]) -> bool:
    """Was a hold decided by an `ask` card, the owner's or the compiler's default ask, rather than
    by an `auto` card's hold twin, whose amount, discount, hours or review gate failed (a limit
    hold)? (`hold_decider`; a hold it can't read is no ask hold.)"""
    decider = hold_decider(version_row, policy_ids)
    return decider is not None and decider.ask


def allow_person_eligible(principal: Principal) -> bool:
    """Could `allow_person` name this principal: a verified person or an agent key. A session that
    names a person without having confirmed it's them is no person to allow. A decision stores
    this as it was when it was made (its row's `allow_person_eligible`)."""
    person = principal.person_id is not None and verified(principal.kind, principal.assurance, principal.person_id)
    return person or principal.agent_key_id is not None


def answers_for(eligible: bool, action: NormalizedAction | None, *, ask_held: bool,
                auto_money_cap_cents: int) -> list[ApprovalAnswer]:
    """The owner's answers to a hold ("Decision lifecycle"): `allow_person` only when the asker is
    `eligible` (`allow_person_eligible`) and, on a money tool, the amount is within the active
    version's money cap `auto_money_cap_cents` (so never above `AUTO_MONEY_HARD_CAP_CENTS`, and
    never with the cap unset); `deny_always` only when an `ask` card decided the hold
    (`held_by_ask`)."""
    scoped = eligible
    if action is not None and is_money(action.tool, action.effects):
        cap = compiler.capped(auto_money_cap_cents)
        scoped = scoped and action.amount_cents is not None and action.amount_cents <= cap
    offered = {"allow_person": scoped, "deny_always": ask_held}
    return [answer for answer in get_args(ApprovalAnswer) if offered.get(answer, True)]


def held_answers(principal: Principal, action: NormalizedAction | None, *, ask_held: bool,
                 auto_money_cap_cents: int) -> list[ApprovalAnswer]:
    """The owner's answers to a hold `principal` asks for now (`answers_for` its standing)."""
    return answers_for(allow_person_eligible(principal), action, ask_held=ask_held,
                       auto_money_cap_cents=auto_money_cap_cents)


def free_text(adapter: Adapter, args: BaseModel) -> dict[str, str]:
    """The call's free-text arguments (the adapter's `free_text_fields`) that hold any text."""
    texts = {}
    for name in sorted(adapter.free_text_fields):
        value = getattr(args, name, None)
        if isinstance(value, str) and value:
            texts[name] = value
        elif isinstance(value, list) and value and all(isinstance(item, str) for item in value):
            texts.update({f"{name}[{index}]": item for index, item in enumerate(value) if item})
    return texts


def _asked(subject: str, tool: str, action: NormalizedAction | None, *,
           business: BusinessToolDef | None = None) -> str:
    """"<subject> asked to <what>.", with the amount and discount the kernel computed
    (`explain.asked`, which setup probes share)."""
    if action is None:
        return explain.asked(subject, "asked", tool, None, None, business=business)
    return explain.asked(subject, "asked", tool, action.amount_cents, action.discount_bp, business=business)


@dataclass
class _Call:
    """One call being decided: who, where and what was asked."""

    principal: Principal
    session_row: SessionRow
    req: DecideRequest
    call_sha256: str
    desk_row: Desk
    business: Business
    subject: str                          # who asked, in the owner's words
    version_row: PolicyVersionRow | None
    adapter: Adapter | None = None
    args: BaseModel | None = None
    action: NormalizedAction | None = None
    quotes: dict[str, str] = field(default_factory=dict)
    mandate_remaining_cents: int | None = None   # what an agent's mandate had left, as the request was built

    @property
    def policy_version(self) -> int:
        return self.version_row.version if self.version_row is not None else 0

    @property
    def auto_money_cap_cents(self) -> int:
        """The money cap the call is decided under: its version's, 0 without one."""
        return activation.version_cap(self.version_row)


async def _subject(ctx: KernelCtx, principal: Principal) -> str:
    """Who asked, as the owner reads it (the same words `explain` uses)."""
    if principal.kind == "owner":
        return "Setup"
    if principal.kind == "agent":
        return "A visiting agent"
    if not verified(principal.kind, principal.assurance, principal.person_id):
        return "A stranger"
    name = (await ctx.db.execute(ctx.repo.scoped(
        select(Person.display_name).where(Person.person_id == principal.person_id)))).scalar_one_or_none()
    return name or "A verified customer"


async def decide_call(ctx: KernelCtx, principal: Principal, session_row: SessionRow, req: DecideRequest) -> Decision:
    """Decides one proposed tool call for an authenticated session, once the route has answered the
    session-state rows, and stores the decision in the caller's transaction (see the module
    docstring for the order). Never executes anything."""
    if not keepable_call_id(req.call.call_id):
        raise _refused_call(422, "invalid", "invalid_call_id", _named(principal), req)
    try:
        sha = call_sha256(req)
    except ValueError:
        raise _refused_call(422, "invalid", "uncanonical_call", _named(principal), req) from None
    existing = await find_call(ctx, session_row.session_id, session_row.generation, req.call.call_id)
    if existing is not None:
        return await _repeat(ctx, existing, sha)
    desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == principal.desk_id)))).one()
    call = _Call(principal=principal, session_row=session_row, req=req, call_sha256=sha, desk_row=desk_row,
                 business=await _business(ctx, principal.desk_id), subject=await _subject(ctx, principal),
                 version_row=await activation.active_version(ctx, principal.desk_id))
    if session_row.mode == "paused":
        return await _refuse(ctx, call, "paused")

    tool = req.call.tool
    call.adapter = await adapters.resolve(ctx, principal.desk_id, tool)
    if call.adapter is None:
        return await _refuse(ctx, call, "unknown_tool")
    tools = await enabled_tools(ctx, principal.desk_id)
    if tool not in tools_given(principal, session_row, desk_row, tools):
        return await _refuse(ctx, call, "not_given")
    if not _storable_json(req.call.args):           # text that can't be stored can't be decided on either
        return await _refuse(ctx, call, "invalid_args")
    try:
        call.args = call.adapter.Args.model_validate(req.call.args)
    except ValidationError:
        return await _refuse(ctx, call, "invalid_args")
    call.quotes = free_text(call.adapter, call.args)
    try:
        normalized = await call.adapter.normalize(NormalizeCtx(ctx=ctx, desk_row=desk_row, principal=principal),
                                                  call.args)
    except AdapterRefusal as refusal:
        return await _refuse(ctx, call, "adapter_refused", check=refusal.code)

    args_json = call.args.model_dump(mode="json", exclude_none=True)
    profile = tools[tool]
    call.action = NormalizedAction(
        action_id=new_id("act"), copy_id=principal.copy_id, desk_id=principal.desk_id,
        session_id=session_row.session_id, generation=session_row.generation, tool=tool,
        effects=profile.profile.effects, args_sha256=args_sha256(args_json), profile_sha256=profile.profile_sha256,
        resource=normalized.resource, list_cents=normalized.list_cents, discount_bp=normalized.discount_bp,
        amount_cents=normalized.amount_cents, recipient=normalized.recipient, starts_at=normalized.starts_at)
    if call.version_row is None:
        return await _refuse(ctx, call, "no_active_version", args_json=args_json)
    if activation.outdated(call.version_row):         # stored by an earlier kernel and not rebuilt
        return await _refuse(ctx, call, "version_outdated", args_json=args_json)
    if ctx.policies.versions.use(call.version_row):
        return await _refuse(ctx, call, "version_unloadable", args_json=args_json)
    call.mandate_remaining_cents = await mandates.session_remaining(ctx, session_row, principal.desk_id)
    request = cedar_request(principal, call.action, tz=call.business.timezone, now=ctx.clock.now(),
                            auto_money_cap_cents=call.auto_money_cap_cents,
                            mandate_remaining_cents=call.mandate_remaining_cents)
    evaluation = await evaluate(ctx, call.version_row, request,
                                review_source=lambda pending: _review(ctx, call, pending))
    if evaluation.errored:
        return await _refuse(ctx, call, "evaluation_error", args_json=args_json, evaluation=evaluation)
    return await _store(ctx, call, evaluation.outcome, args_json=args_json, evaluation=evaluation)


def _named(principal: Principal) -> Named:
    """The session a decision is for, as a refusal names it."""
    return Named(copy_id=principal.copy_id, desk_id=principal.desk_id, session_id=principal.session_id)


def _refused_call(status: int, code: str, reason: str, named: Named, req: DecideRequest) -> KernelFailure:
    """A call refused before it has a decision row: answered `status` `code`, and ledgered `decide`
    on the Desk of the session it named once the request's transaction has rolled back
    (`KernelFailure.persist`), from kernel-built values only."""
    summary = {"outcome": "refuse", "tool": ledger.safe_ref(req.call.tool), "reason": reason}
    return KernelFailure(status, code, reason, persist=partial(
        _ledger_refused_call, copy_id=named.copy_id, desk_id=named.desk_id, session_id=named.session_id,
        summary=summary))


async def _ledger_refused_call(ctx: KernelCtx, *, copy_id: str, desk_id: str, session_id: str,
                               summary: dict[str, Any]) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="decide", origin="kernel", session_id=session_id, summary=summary))


def _internal_error(named: Named, req: DecideRequest, exc: BaseException) -> KernelFailure:
    """A failure while deciding that isn't a refusal (`KernelRepo` refusing a statement kernel code
    built, the database failing the transaction, an error in the engine): 500 `internal`, with the
    attempt still on record (`_refused_call`). The log names the failure's kind and the frames it
    rose through, never its text, which can quote the visitor's arguments (`repo.log_error`)."""
    repo.log_error(log, exc, "decide_internal_error")
    return _refused_call(500, "internal", "internal_error", named, req)


async def _review(ctx: KernelCtx, call: _Call, pending: list[RuleCard]) -> Reviewed:
    """Asks the reviewer about the call's action: the action as the adapter resolved it, the
    pending cards, the Desk's public charter facts but the seed-only starter questions
    (`charter:starter:*`), and the free-text arguments, never the conversation. Only a normalized
    action is reviewed: without one this raises, and the call ends with nothing stored."""
    if call.action is None:
        raise RuntimeError("review_without_action")
    facts = await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == call.action.desk_id, FactRow.kind == "charter",
        desks.not_starter()).order_by(FactRow.fact_id)))
    data = ReviewInput(action=ReviewAction.of(call.action, tz=call.business.timezone),
                       cards=[ReviewCard.of(card) for card in pending],
                       facts=[ReviewFact(key=claim.key, value=claim.value) for fact in facts
                              if "public" in fact.readers for claim in fact.claims],
                       untrusted_args=call.quotes)
    return await ctx.decisions.review(data)


async def _refuse(ctx: KernelCtx, call: _Call, reason: str, *, args_json: dict[str, Any] | None = None,
                  evaluation: Evaluation | None = None, check: str | None = None) -> Decision:
    return await _store(ctx, call, "refuse", reason=reason, args_json=args_json, evaluation=evaluation, check=check)


async def _repeat(ctx: KernelCtx, row: DecisionRow, sha: str) -> Decision:
    """The stored decision for a repeated call, refreshed; a different call under the same ID is a
    409 `conflict`, ledgered."""
    if row.call_sha256 != sha:
        raise AuthError(409, "conflict", "call_conflict", route=DECIDE_ROUTE,
                        named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))
    return await decision_contract(ctx, await refresh_answers(ctx, await expire_if_due(ctx, row)))


def _rules_decided(call: _Call, outcome: str, evaluation: Evaluation) -> tuple[str, Sequence[str]]:
    """How the deciding rules decided (`RULE_LEAD_INS`), and the cards to quote after it. A hold is
    an ask hold when an `ask` card decided it, by the same test that offers `deny_always`
    (`hold_decider`, as `held_by_ask` reads it); any other hold went past an `auto` card's amount,
    discount, hours window or review gate. Only the cards that decided a hold are quoted, so the
    lead-in and the quotes agree. An allow's permits already leave out every less specific card
    (their `unless` exclusions), and every matching `never` card refuses on its own, so those quote
    every deciding card."""
    if outcome != "hold":
        return RULE_LEAD_INS[outcome], evaluation.card_ids
    decider = hold_decider(call.version_row, evaluation.policy_ids)
    if decider is None:
        return RULE_LEAD_INS["limit"], evaluation.card_ids
    return RULE_LEAD_INS["ask" if decider.ask else "limit"], decider.card_ids


def _reason_plain(call: _Call, outcome: str, reason: str | None, evaluation: Evaluation | None) -> str:
    """The owner's account of a decision: who asked for what, why it went this way (the reasons of
    the cards that decided, each quoted after one lead-in that says how they decided; the reviewer;
    or why it was refused with no card deciding), then the call's free-text arguments, each
    quoted, under one "Claude's note" label: Claude wrote them into the call, the visitor didn't.
    A hold only the compiler's default ask decided quotes no rule: the lead-ins say "your rule",
    and no rule of the owner's decided it (`DEFAULT_ASK_PLAIN`). A decision not refused early
    takes its reasons from its evaluation and version: without them this raises, and the call ends
    with nothing stored."""
    parts = [_asked(call.subject, call.req.call.tool, call.action,
                    business=call.adapter.profile.business if call.adapter is not None else None)]
    if reason is not None:
        parts.append(REFUSED_PLAIN[reason])
    else:
        if evaluation is None or call.version_row is None:
            raise RuntimeError("reason_without_evaluation")
        cards = {card.card_id: card for card in call.version_row.cards}
        lead_in, card_ids = _rules_decided(call, outcome, evaluation)
        deciding = [cards[card_id] for card_id in card_ids if card_id in cards]
        if outcome == "hold" and deciding and all(card.is_default for card in deciding):
            parts.append(DEFAULT_ASK_PLAIN)
        elif deciding:
            # a rule's text is the owner's own words: quoted whole, never cut as free text is
            parts.append(f"{lead_in}: " + ", ".join(quoted(card.reason) for card in deciding))
        elif outcome == "refuse":
            baseline_ids = {policy_id.removeprefix("B.") for policy_id in evaluation.policy_ids
                            if policy_id.startswith("B.")}
            if len(baseline_ids) == 1:
                baseline_id = next(iter(baseline_ids))
                parts.append(BASELINE_PLAIN if baseline_id == "agent_charge_within_mandate"
                             and not _over_mandate(call, evaluation)
                             else BASELINE_RULE_PLAIN.get(baseline_id, BASELINE_PLAIN))
            else:
                parts.append(BASELINE_PLAIN if baseline_ids else UNCOVERED_PLAIN)
    if evaluation is not None and evaluation.needed_review:
        review = evaluation.review
        if review is None:
            parts.append(REVIEW_PLAIN["absent"])
        elif review.recommendation != "allow":
            parts.append(REVIEW_PLAIN[review.recommendation])
        else:
            parts.append(REVIEW_PLAIN["allow" if outcome == "allow" else "unsure"])
    if call.quotes:
        parts.append(claudes_note(call.quotes.values()))
    return " ".join(parts)


MANDATE_POLICY = "B.agent_charge_within_mandate"     # the baseline's bound on an agent's charge


def _over_mandate(call: _Call, evaluation: Evaluation) -> bool:
    """Only a charge above an existing mandate's remaining limit names that cause."""
    action, left = call.action, call.mandate_remaining_cents
    return (evaluation.policy_ids == [MANDATE_POLICY] and call.principal.kind == "agent"
            and left is not None and action is not None and action.amount_cents is not None
            and action.amount_cents > left)


def _status_key(call: _Call, state: str, reason: str | None, evaluation: Evaluation | None) -> str:
    """The status line a new decision is stored with: its state's, except for a refusal the
    evaluation made (no early `reason`) with the baseline's mandate rule as its only deciding
    policy, for an agent holding a mandate whose charge is above what that mandate had left
    (`refused_over_mandate`). Any other refusal by that rule (no mandate, no amount), or one
    another policy also decided, keeps the generic line, so the line never names a cause that
    isn't the real one."""
    over = (state == "refused" and reason is None and evaluation is not None
            and _over_mandate(call, evaluation))
    return "refused_over_mandate" if over else state


async def _store(ctx: KernelCtx, call: _Call, outcome: Outcome, *, reason: str | None = None,
                 args_json: dict[str, Any] | None = None, evaluation: Evaluation | None = None,
                 check: str | None = None) -> Decision:
    """Writes the decision (and its action, when one was normalized) with its ledger entries, the
    breaker's strike and the owner's alerts, in the caller's transaction, and signs it with its
    status line (`_status_key`). A twin call that committed first wins: its decision is returned
    instead. `check` is an adapter's own code for a step-1 refusal (`AdapterRefusal.code`), which
    its `decide` entry records beside the reason, through `ledger.safe_ref`; it changes neither the
    owner's words nor the visitor's line."""
    principal, session_row, action = call.principal, call.session_row, call.action
    now = ctx.clock.now()
    state = STATE_OF[outcome]
    answers: list[ApprovalAnswer] = []
    if outcome == "hold":
        answers = held_answers(principal, action, ask_held=evaluation is not None and held_by_ask(
            call.version_row, evaluation.policy_ids), auto_money_cap_cents=call.auto_money_cap_cents)
    row = DecisionRow(
        decision_id=new_id("dec"), copy_id=principal.copy_id, desk_id=principal.desk_id,
        session_id=session_row.session_id, generation=session_row.generation, call_id=call.req.call.call_id,
        call_sha256=call.call_sha256, tool=action.tool if action else stored_name(call.req.call.tool),
        effects=action.effects if action else [], outcome=outcome, state=state,
        answers=answers, allow_person_eligible=allow_person_eligible(principal), policy_version=call.policy_version,
        card_ids=evaluation.card_ids if evaluation and reason is None else [],
        policy_ids=evaluation.policy_ids if evaluation and reason is None else [],
        review=evaluation.review if evaluation else None,
        reason_plain=_reason_plain(call, outcome, reason, evaluation),
        visitor_plain=render.status(_status_key(call, state, reason, evaluation),
                                    render.language(session_row.last_language),
                                    owner=call.business.owner_display_name),
        expires_at=now + LIFETIME[outcome], ledger_seq=0, created_at=now, updated_at=now,
        action_id=action.action_id if action else None)
    try:
        async with ctx.db.begin_nested():
            if action is not None:
                ctx.db.add(ActionRow(**action.model_dump(exclude={"resource"}), resource=action.resource,
                                     resource_kind=action.resource.kind, args_json=args_json, created_at=now))
            ctx.db.add(row)
            await ctx.db.flush()
    except IntegrityError:
        # a concurrent twin of this call committed first: answer with its decision
        twin = await find_call(ctx, session_row.session_id, session_row.generation, call.req.call.call_id)
        if twin is None:
            raise
        return await _repeat(ctx, twin, call.call_sha256)

    if evaluation is not None and evaluation.usage is not None:
        await _append(ctx, row, "review", {"decision_id": row.decision_id, **evaluation.usage.model_dump()})
    if action is None:
        summary: dict[str, Any] = {"outcome": "refuse", "tool": ledger.safe_ref(call.req.call.tool), "reason": reason}
        if check is not None:
            summary["check"] = ledger.safe_ref(check)
    else:
        summary = {"decision_id": row.decision_id, "action_id": action.action_id, "tool": action.tool,
                   "outcome": outcome, "card_ids": row.card_ids, "policy_version": row.policy_version,
                   "auto_money_cap_cents": call.auto_money_cap_cents,
                   "reviewed": bool(evaluation and evaluation.needed_review)}
        if reason is not None:
            summary["reason"] = reason
    row.ledger_seq = (await _append(ctx, row, "decide", summary)).seq
    _sign(ctx, row)
    inbox: list[InboxNotice] = []
    if evaluation is not None and evaluation.strike:
        inbox += await _strike(ctx, row, session_row)
    if outcome == "hold":
        notice = await demo_inbox.alert_owner(ctx, row.desk_id, "approval", render.owner_preview("approval"),
                                              row.reason_plain, decision_id=row.decision_id)
        inbox += [notice] if notice is not None else []
    await ctx.db.flush()
    return await decision_contract(ctx, row, inbox=inbox)


async def _strike(ctx: KernelCtx, row: DecisionRow, session_row: SessionRow) -> list[InboxNotice]:
    """A strike against the session, under its row lock, ledgered `breaker`; the third pauses it
    (ledgered too) and alerts the owner."""
    strikes, mode = (await ctx.db.execute(
        update(SessionRow).where(SessionRow.session_id == row.session_id, SessionRow.copy_id == row.copy_id)
        .values(strikes=SessionRow.strikes + 1).returning(SessionRow.strikes, SessionRow.mode)
        .execution_options(synchronize_session=False))).one()
    await _append(ctx, row, "breaker", {"strike": strikes})
    notices: list[InboxNotice] = []
    if strikes >= BREAKER_STRIKES and mode == "ai":
        await ctx.db.execute(
            update(SessionRow).where(SessionRow.session_id == row.session_id, SessionRow.copy_id == row.copy_id)
            .values(mode="paused").execution_options(synchronize_session=False))
        mode = "paused"
        await _append(ctx, row, "breaker", {"paused": True})
        notice = await demo_inbox.alert_owner(ctx, row.desk_id, "breaker", render.owner_preview("breaker"),
                                              BREAKER_ALERT)
        notices += [notice] if notice is not None else []
    set_committed_value(session_row, "strikes", strikes)
    set_committed_value(session_row, "mode", mode)
    return notices


# ---- Routes ---------------------------------------------------------------------------------------

router = APIRouter()


async def _decide_caller(ctx: KernelCtx, request: Request, body: DecideRequest) -> tuple[Principal, SessionRow]:
    """The session `/decide` acts for, once the session-state rows pass: its token (or the owner's,
    for the owner's own session and a Desk of its copy), copy and Desk, open, at its generation, and
    not taken over by the owner. A paused session passes: its decisions are stored refusals.

    Once the token is proved the session is known, and from there any failure that isn't a refusal
    is a 500 `internal` with its `decide` entry (`_internal_error`), as in `post_decide`, never a
    bare 500. Inside that scope the session row is locked (`auth.lock_session`) for the rest of the
    request, so the closed, generation and mode checks see its current state, and a take-over or
    hand-back comes either before the whole decision (409) or after it commits."""
    named = await auth.authenticate_caller(ctx, request, body.session_id, body.desk_id)
    try:
        row, desk_row = await auth.check_caller(ctx, request, named, generation=body.generation, lock=True)
        if row.mode == "owner":
            raise AuthError(409, "mode_owner", "mode_owner", route=route_template(request), named=named)
        return principal_for(row, desk_id=desk_row.desk_id), row
    except KernelFailure:
        raise
    except Exception as exc:                          # never BaseException: a cancelled request passes
        raise _internal_error(named, body, exc) from None


@router.post("/decide", response_model=Decision)
async def post_decide(body: DecideRequest, ctx: Ctx, request: Request) -> Decision:
    principal, row = await _decide_caller(ctx, request, body)
    try:
        return await decide_call(ctx, principal, row, body)
    except KernelFailure:
        raise
    except Exception as exc:                          # never BaseException: a cancelled request passes
        raise _internal_error(_named(principal), body, exc) from None


@router.get("/decisions/by_call", response_model=Decision)
async def get_by_call(session_id: str, generation: int, call_id: str, ctx: Ctx, request: Request) -> Decision:
    """The decision `/decide` committed for a call, after the API lost its answer, settled as any
    read is; 404 when none was. A session reads its own calls, the owner its own session's. It
    stands in for `/decide`'s answer, which goes back to the session's turn, so, like that answer,
    it never carries the owner's line (`owner_plain`), whoever asks."""
    if await auth.caller(ctx, request, session_id) == "owner":
        owner = await auth.require_owner(ctx, request, session_id=session_id)
        if session_id != owner.session_id:
            raise AuthError(404, "not_found", "wrong_session", route=route_template(request),
                            named=Named(copy_id=owner.copy_id, session_id=session_id))
    else:
        await auth.require_session(ctx, request, session_id)
    row = await find_call(ctx, session_id, generation, call_id) if keepable_call_id(call_id) else None
    if row is None:
        raise KernelFailure(404, "not_found", "unknown_call")
    return await decision_contract(ctx, await _read(ctx, row))


# Declared after /decisions/by_call, so that path never reads as a decision ID.
@router.get("/decisions/{decision_id}", response_model=Decision)
async def get_decision(decision_id: str, ctx: Ctx, request: Request) -> Decision:
    """A decision, read by its own session or by the owner of its copy, settled as a read does (an
    orphaned execution reconciled, lazy expiry applied). The session a read names is the
    decision's ("Kernel HTTP API v2", Credentials), so any other session's token, or no single
    credential, is 401, ledgered on the decision's session whatever copy the caller is in. A
    decision no copy holds is 404, ledgered on the session whose token asked. The owner's
    credential is held to the same naming: a bad owner token is 401 and another copy's owner finds
    nothing (404), each ledgered on the decision's session; an owner asking for a decision no copy
    holds is 404, logged, since an owner session has no Desk ledger of its own. Only the owner's read
    carries the owner's line (`owner_plain`); the session's has None.

    Each credential is resolved before the transaction takes its connection, except the decision's
    session, which only the decision names: that session is proved in the copy the transaction
    has already read the decision in (`auth.authenticate_session`'s `copy_id`), so a read never
    holds one connection while it waits for another."""
    copy_id = await repo.copy_of_decision_id(ctx, decision_id) if repo.storable(decision_id) else None
    if auth.OWNER_HEADER in request.headers and auth.SESSION_HEADER not in request.headers:
        named = Named(copy_id=copy_id, decision_id=decision_id) if copy_id is not None else None
        owner = await auth.require_owner(ctx, request, named=named)
        row = await _decision_row(ctx, decision_id) if copy_id == owner.copy_id else None
        if row is None:   # another copy's decision, or none: 404 alike
            raise AuthError(404, "not_found", "unknown_decision" if named is None else "wrong_copy",
                            route=route_template(request), named=named)
        return await decision_contract(ctx, await _read(ctx, row), for_owner=True)
    row = await _decision_row(ctx, decision_id, copy_id) if copy_id is not None else None
    if row is None:   # no decision has this ID, so it names no session: the token alone says who asks
        await auth.caller(ctx, request, None)
        session = await auth.require_session_token(ctx, request)
        raise AuthError(404, "not_found", "unknown_decision", route=route_template(request),
                        named=Named(copy_id=session.copy_id, desk_id=session.desk_id, session_id=session.session_id))
    await auth.caller(ctx, request, row.session_id, copy_id=row.copy_id)
    await auth.require_session(ctx, request, row.session_id, copy_id=row.copy_id)
    return await decision_contract(ctx, await _read(ctx, row))


async def _decision_row(ctx: KernelCtx, decision_id: str, copy_id: str | None = None) -> DecisionRow | None:
    """The decision with this ID in `copy_id` (bound here), else in the copy already bound."""
    copy = ctx.bind(copy_id) if copy_id is not None else ctx.repo
    return (await ctx.db.scalars(copy.scoped(select(DecisionRow).where(
        DecisionRow.decision_id == decision_id)))).one_or_none()


async def _read(ctx: KernelCtx, row: DecisionRow) -> DecisionRow:
    """A decision as a read settles it: an orphaned execution reconciled, then lazy expiry
    (`execute.refresh_decision`)."""
    from desk.kernel_service import execute     # execute builds on this module

    return await execute.refresh_decision(ctx, row)
