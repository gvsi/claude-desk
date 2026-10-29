"""Decisions: deciding a proposed tool call (`POST /decide`) and reading decisions back.

`cedar_request` builds the master plan's `request_json` ("Cedar request shape") from kernel-built
values only: the principal from the session's rows, the action as its adapter normalized it.
Optional attributes appear only when set, since the schema reads them behind `has`.
`owner_approved` is never sent: the engine sets it for each evaluation, over any value sent.

`decide_call` runs "Evaluation" for one call, after the route has answered the session-state
rows ("Session state responses": token, copy, closed, generation, mode `owner`):

1. Idempotency on `(session_id, generation, call_id)`: the same call returns its stored decision,
   another Desk, tool or args is 409 `conflict`.
2. A paused session (the breaker) gets a stored `refuse`.
3. Step 1: an unknown tool, one this session isn't given, args its adapter's strict model
   refuses (or text the database can't keep), or a call the adapter can't resolve is refused
   before any action exists.
4. With no active version that loads, the action is refused.
5. `evaluate`: partial evaluation first; the reviewer runs only when its score can change the
   outcome, and every verdict comes from a full evaluation. Any evaluation error refuses.

Everything a decision writes commits in the caller's transaction: the action, the decision, its
ledger entries (`review`, `decide`, `breaker`) and the owner's alerts. A decision is signed over
its state and status line (`sign_decision`), and every later state change ledgers and re-signs it
(`set_state`). Expiry is lazy (`expire_if_due`).

Visitor text reaches the decision only as data: the reviewer sees free-text arguments under
`untrusted_args`, and the owner reads them quoted after "From the visitor".
"""

import hashlib
import json
import logging
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, get_args
from zoneinfo import ZoneInfo

import desk_kernel
from fastapi import APIRouter, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.attributes import set_committed_value

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    MONEY_TOOLS,
    ApprovalAnswer,
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
)
from desk.db.models import Action as ActionRow
from desk.db.models import Business, Desk, Execution, Person, Tool
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_api import DecideRequest
from desk.kernel_service import activation, adapters, auth, demo_inbox, explain, ledger, render, repo
from desk.kernel_service.adapters.base import Adapter, AdapterRefusal, NormalizeCtx
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.decisions import CallUsage, ReviewAction, ReviewCard, ReviewFact, ReviewInput, Reviewed
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, new_id, route_template
from desk.kernel_service.sessions import principal_for, verified

log = logging.getLogger(__name__)

PRINCIPAL_TYPES = {"visitor": "Visitor", "agent": "Agent", "owner": "Owner"}
RESOURCE_TYPES = {"quote": "Quote", "slot": "Slot", "booking": "Booking", "document": "Document",
                  "charge": "Charge", "desk": "Desk"}


def cedar_request(principal: Principal, action: NormalizedAction, *, tz: str, now: datetime,
                  review: Review | None = None, mandate_remaining_cents: int | None = None) -> dict[str, Any]:
    """The request for `PolicyEngine.decide`. `local_dow` (0 = Monday) and `local_minute` are taken in
    the business's time zone `tz` for the action's `starts_at`, else for `now`. `review` is the
    reviewer's whole `Review` (the engine keeps its scores only on an "allow" recommendation);
    `mandate_remaining_cents` is an `Agent` attribute and is ignored for any other principal."""
    if now.tzinfo is None:
        raise ValueError("now must be an aware datetime")
    local = (action.starts_at or now).astimezone(ZoneInfo(tz))

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
        "local_dow": local.weekday(),
        "local_minute": local.hour * 60 + local.minute,
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

OWNER_TOOLS: frozenset[str] = frozenset({"native.fetch_website", "native.read_memory"})
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
    return given & set(enabled) & set(adapters.ADAPTERS)


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


# The compiler writes `@id("...") @card("a,b") ...` at the head of every policy.
_POLICY_HEAD = re.compile(r'^@id\("([^"]+)"\) @card\("([^"]*)"\)', re.MULTILINE)


def policy_cards(version_row: PolicyVersionRow) -> dict[str, list[str]]:
    """The cards behind each policy of a stored version, by the engine's name for the policy
    (`<set>.<@id>`), read from the `@card` annotations of its `F`, `A` and `H` texts. Baseline
    policies belong to no card."""
    cedar = version_row.cedar or {}
    return {f"{name}.{policy_id}": [card for card in cards.split(",") if card]
            for name in ("F", "A", "H") for policy_id, cards in _POLICY_HEAD.findall(cedar.get(name) or "")}


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
    comes from a full evaluation, and any evaluation error refuses."""
    key = activation.version_key(version_row.desk_id, version_row.version)
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


async def set_state(ctx: KernelCtx, row: DecisionRow, state: str, *, kind: str = "decide",
                    summary: dict[str, Any]) -> LedgerEntry:
    """Moves a decision to `state` in the caller's transaction: the status line for the new state,
    a ledger entry (`kind`, `summary`, kernel-built values only) and a signature over both. Lock
    the row first."""
    session = (await ctx.db.scalars(ctx.repo.scoped(
        select(SessionRow).where(SessionRow.session_id == row.session_id)))).one()
    row.state = state
    row.visitor_plain = render.status(state, render.language(session.last_language),
                                      owner=(await _business(ctx, row.desk_id)).owner_display_name)
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


# ---- Reading decisions back -----------------------------------------------------------------------

def normalized_action(row: ActionRow) -> NormalizedAction:
    return NormalizedAction(action_id=row.action_id, copy_id=row.copy_id, desk_id=row.desk_id,
                            session_id=row.session_id, generation=row.generation, tool=row.tool, effects=row.effects,
                            args_sha256=row.args_sha256, profile_sha256=row.profile_sha256, resource=row.resource,
                            list_cents=row.list_cents, discount_bp=row.discount_bp, amount_cents=row.amount_cents,
                            recipient=row.recipient, starts_at=row.starts_at)


async def decision_contract(ctx: KernelCtx, row: DecisionRow, *, inbox: Sequence[InboxNotice] = ()) -> Decision:
    """The `Decision` a stored row answers with. `inbox` holds the alerts the call that created it
    wrote; a decision read back later carries none."""
    action = None
    if row.action_id is not None:
        action_row = (await ctx.db.scalars(ctx.repo.scoped(
            select(ActionRow).where(ActionRow.action_id == row.action_id)))).one()
        action = normalized_action(action_row)
    return Decision(decision_id=row.decision_id, session_id=row.session_id, call_id=row.call_id, action=action,
                    outcome=row.outcome, state=row.state, policy_version=row.policy_version,
                    policy_ids=row.policy_ids, card_ids=row.card_ids, review=row.review,
                    reason_plain=row.reason_plain, visitor_plain=row.visitor_plain, answers=row.answers,
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
QUOTED_CHARS = 200                        # free text quoted to the owner is cut to this
MONEY_EFFECTS = frozenset({"charge", "pay_out"})
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
    "evaluation_error": "Your rules couldn't be checked for it, so it was refused.",
}
BASELINE_PLAIN = "The always-on safety rules don't allow it."
REVIEW_PLAIN: dict[str, str] = {
    "absent": "The reviewer couldn't check it.",
    "block": "The reviewer flagged it as an attempt to get around your rules.",
    "hold": "The reviewer suggested asking you.",
    "unsure": "The reviewer wasn't sure enough to let it through.",
    "allow": "The reviewer checked it.",
}


def call_sha256(req: DecideRequest) -> str:
    """sha256 of `canonical_json_any({desk_id, tool, args})` as received (raw args may hold floats).
    Raises ValueError for args canonical JSON can't hold."""
    text = json.dumps({"desk_id": req.desk_id, "tool": req.call.tool, "args": req.call.args})
    return hashlib.sha256(desk_kernel.canonical_json_any(text).encode()).hexdigest()


def _storable(text: str) -> bool:
    """Text Postgres can keep: valid UTF-8 without NUL."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return "\0" not in text


def _storable_json(value: Any) -> bool:
    """Every key and string in a JSON value is text Postgres can keep."""
    if isinstance(value, str):
        return _storable(value)
    if isinstance(value, dict):
        return all(_storable(key) and _storable_json(item) for key, item in value.items())
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
    return tool in MONEY_TOOLS or bool(MONEY_EFFECTS & set(effects))


def held_answers(principal: Principal, action: NormalizedAction | None) -> list[ApprovalAnswer]:
    """The owner's answers to a hold ("Decision lifecycle"): `allow_person` only for a verified
    person or an agent key and, on a money tool, an amount within the hard cap. A session that
    names a person without having confirmed it's them is no person to allow."""
    person = principal.person_id is not None and verified(principal.kind, principal.assurance, principal.person_id)
    scoped = person or principal.agent_key_id is not None
    if action is not None and is_money(action.tool, action.effects):
        scoped = scoped and action.amount_cents is not None and action.amount_cents <= AUTO_MONEY_HARD_CAP_CENTS
    return [answer for answer in get_args(ApprovalAnswer) if answer != "allow_person" or scoped]


def free_text(adapter: Adapter, args: BaseModel) -> dict[str, str]:
    """The call's free-text arguments (the adapter's `free_text_fields`) that hold any text."""
    return {name: value for name in sorted(adapter.free_text_fields)
            if isinstance(value := getattr(args, name, None), str) and value}


def _percent(bp: int) -> str:
    return f"{bp // 100}%" if bp % 100 == 0 else f"{bp / 100:g}%"


def _asked(subject: str, tool: str, action: NormalizedAction | None) -> str:
    """"<subject> asked to <what>.", with the amount and discount the kernel computed; a name that
    is no tool is never repeated."""
    phrases = explain.PHRASES.get(tool)
    if phrases is None:
        return f"{subject} asked for something this Desk can't do."
    plain, with_amount = phrases
    amount = action.amount_cents if action is not None else None
    what = with_amount.format(amount=explain.money(amount)) if with_amount and amount is not None else plain
    if action is not None and action.discount_bp:
        what += f" with {_percent(action.discount_bp)} off"
    return f"{subject} asked to {what}."


def _quoted(text: str) -> str:
    """Visitor text as the owner reads it: one line, cut, inside quotes it can't close."""
    line = " ".join(text.split())[:QUOTED_CHARS]
    return "“" + line.replace("“", '"').replace("”", '"') + "”"


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

    @property
    def policy_version(self) -> int:
        return self.version_row.version if self.version_row is not None else 0


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
    if not _storable(req.call.call_id):
        raise KernelFailure(422, "invalid", "unstorable_call_id")
    try:
        sha = call_sha256(req)
    except ValueError:
        raise KernelFailure(422, "invalid", "uncanonical_call") from None
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
    call.adapter = adapters.ADAPTERS.get(tool) if tool in TOOL_NAMES else None
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
    except AdapterRefusal:
        return await _refuse(ctx, call, "adapter_refused")

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
    if ctx.policies.versions.use(call.version_row):
        return await _refuse(ctx, call, "version_unloadable", args_json=args_json)
    request = cedar_request(principal, call.action, tz=call.business.timezone, now=ctx.clock.now())
    evaluation = await evaluate(ctx, call.version_row, request,
                                review_source=lambda pending: _review(ctx, call, pending))
    if evaluation.errored:
        return await _refuse(ctx, call, "evaluation_error", args_json=args_json, evaluation=evaluation)
    return await _store(ctx, call, evaluation.outcome, args_json=args_json, evaluation=evaluation)


async def _review(ctx: KernelCtx, call: _Call, pending: list[RuleCard]) -> Reviewed:
    """Asks the reviewer about the call's action: the action as the adapter resolved it, the
    pending cards, the Desk's public charter facts and the free-text arguments, never the
    conversation."""
    assert call.action is not None
    facts = await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == call.action.desk_id, FactRow.kind == "charter").order_by(FactRow.fact_id)))
    data = ReviewInput(action=ReviewAction.of(call.action, tz=call.business.timezone),
                       cards=[ReviewCard.of(card) for card in pending],
                       facts=[ReviewFact(key=claim.key, value=claim.value) for fact in facts
                              if "public" in fact.readers for claim in fact.claims],
                       untrusted_args=call.quotes)
    return await ctx.decisions.review(data)


async def _refuse(ctx: KernelCtx, call: _Call, reason: str, *, args_json: dict[str, Any] | None = None,
                  evaluation: Evaluation | None = None) -> Decision:
    return await _store(ctx, call, "refuse", reason=reason, args_json=args_json, evaluation=evaluation)


async def _repeat(ctx: KernelCtx, row: DecisionRow, sha: str) -> Decision:
    """The stored decision for a repeated call, refreshed; a different call under the same ID is a
    409 `conflict`, ledgered."""
    if row.call_sha256 != sha:
        raise AuthError(409, "conflict", "call_conflict", route=DECIDE_ROUTE,
                        named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))
    return await decision_contract(ctx, await expire_if_due(ctx, row))


def _reason_plain(call: _Call, outcome: str, reason: str | None, evaluation: Evaluation | None) -> str:
    """The owner's account of a decision: who asked for what, why it went this way (the deciding
    cards' reasons, the reviewer, or why it was refused early), then each free-text argument quoted
    after "From the visitor"."""
    parts = [_asked(call.subject, call.req.call.tool, call.action)]
    if reason is not None:
        parts.append(REFUSED_PLAIN[reason])
    else:
        assert evaluation is not None and call.version_row is not None
        cards = {card.card_id: card for card in call.version_row.cards}
        reasons = [cards[card_id].reason for card_id in evaluation.card_ids if card_id in cards]
        parts += reasons or ([BASELINE_PLAIN] if outcome == "refuse" else [])
    if evaluation is not None and evaluation.needed_review:
        review = evaluation.review
        if review is None:
            parts.append(REVIEW_PLAIN["absent"])
        elif review.recommendation != "allow":
            parts.append(REVIEW_PLAIN[review.recommendation])
        else:
            parts.append(REVIEW_PLAIN["allow" if outcome == "allow" else "unsure"])
    parts += [f"From the visitor: {_quoted(text)}." for text in call.quotes.values()]
    return " ".join(parts)


async def _store(ctx: KernelCtx, call: _Call, outcome: Outcome, *, reason: str | None = None,
                 args_json: dict[str, Any] | None = None, evaluation: Evaluation | None = None) -> Decision:
    """Writes the decision (and its action, when one was normalized) with its ledger entries, the
    breaker's strike and the owner's alerts, in the caller's transaction, and signs it. A twin call
    that committed first wins: its decision is returned instead."""
    principal, session_row, action = call.principal, call.session_row, call.action
    now = ctx.clock.now()
    state = STATE_OF[outcome]
    row = DecisionRow(
        decision_id=new_id("dec"), copy_id=principal.copy_id, desk_id=principal.desk_id,
        session_id=session_row.session_id, generation=session_row.generation, call_id=call.req.call.call_id,
        call_sha256=call.call_sha256, tool=action.tool if action else stored_name(call.req.call.tool),
        effects=action.effects if action else [], outcome=outcome, state=state,
        answers=held_answers(principal, action) if outcome == "hold" else [], policy_version=call.policy_version,
        card_ids=evaluation.card_ids if evaluation and reason is None else [],
        policy_ids=evaluation.policy_ids if evaluation and reason is None else [],
        review=evaluation.review if evaluation else None,
        reason_plain=_reason_plain(call, outcome, reason, evaluation),
        visitor_plain=render.status(state, render.language(session_row.last_language),
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
    else:
        summary = {"decision_id": row.decision_id, "action_id": action.action_id, "tool": action.tool,
                   "outcome": outcome, "card_ids": row.card_ids, "policy_version": row.policy_version,
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
                                              row.reason_plain)
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
    not taken over by the owner. A paused session passes: its decisions are stored refusals."""
    row, desk_row = await auth.require_caller(ctx, request, body.session_id, body.desk_id,
                                              generation=body.generation)
    if row.mode == "owner":
        raise AuthError(409, "mode_owner", "mode_owner", route=route_template(request),
                        named=Named(copy_id=row.copy_id, desk_id=desk_row.desk_id, session_id=row.session_id))
    return principal_for(row, desk_id=desk_row.desk_id), row


@router.post("/decide", response_model=Decision)
async def post_decide(body: DecideRequest, ctx: Ctx, request: Request) -> Decision:
    principal, row = await _decide_caller(ctx, request, body)
    return await decide_call(ctx, principal, row, body)


@router.get("/decisions/by_call", response_model=Decision)
async def get_by_call(session_id: str, generation: int, call_id: str, ctx: Ctx, request: Request) -> Decision:
    """The decision `/decide` committed for a call, after the API lost its answer, settled as any
    read is; 404 when none was. A session reads its own calls, the owner its own session's."""
    if await auth.caller(ctx, request, session_id) == "owner":
        owner = await auth.require_owner(ctx, request, session_id=session_id)
        if session_id != owner.session_id:
            raise AuthError(404, "not_found", "wrong_session", route=route_template(request),
                            named=Named(copy_id=owner.copy_id, session_id=session_id))
    else:
        await auth.require_session(ctx, request, session_id)
    row = await find_call(ctx, session_id, generation, call_id) if _storable(call_id) else None
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
    decision no copy holds is 404, ledgered on the session whose token asked; another copy's owner
    finds nothing (404)."""
    storable = _storable(decision_id)
    if auth.OWNER_HEADER in request.headers and auth.SESSION_HEADER not in request.headers:
        await auth.require_owner(ctx, request)
        row = await _decision_row(ctx, decision_id) if storable else None
        if row is None:
            raise KernelFailure(404, "not_found", "unknown_decision")
        return await decision_contract(ctx, await _read(ctx, row))
    copy_id = await repo.copy_of_decision_id(ctx, decision_id) if storable else None
    row = await _decision_row(ctx, decision_id, copy_id) if copy_id is not None else None
    if row is None:   # no decision has this ID, so it names no session: the token alone says who asks
        await auth.caller(ctx, request, None)
        session = await auth.require_session_token(ctx, request)
        raise AuthError(404, "not_found", "unknown_decision", route=route_template(request),
                        named=Named(copy_id=session.copy_id, desk_id=session.desk_id, session_id=session.session_id))
    await auth.caller(ctx, request, row.session_id)
    await auth.require_session(ctx, request, row.session_id)
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
