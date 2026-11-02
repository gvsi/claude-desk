"""Approvals: the owner's answer to a held request, and the visitor's cancel.

`POST /approvals/{decision_id}/answer` ("Decision lifecycle"). The answer locks the decision and
settles it as any read does (`execute.refresh_decision`: lazy expiry first, then a held discount
quote its session's later booking made stale cancelled, then the answers the active version's
money cap offers), so it answers only a request still `held`; anything else is
409, and an answer the request wasn't offered (`allow_person` for a request a stranger made, even
once the session has confirmed who it is, or above the active version's money cap; `deny_always`
on a hold no `ask` card decided, see `decide.held_by_ask`) is 422. Either refusal is ledgered
`approval`, and nothing runs. Then one `approvals` row records the answer, its single use enforced
by the unique index on `decision_id` too:

- `deny_once`, `deny_always`: the decision is `denied`. A denial is bound to nothing, so it can
  never run anything.
- `allow_once`, `allow_person`: the approval is bound to the exact action (`execute.binding_sha256`
  over the action and a fresh nonce) and re-checked on the `approved` path (step 6 of "Evaluation",
  which needs the binding and the current `approvable` verdict, not the session's mode or
  generation: a take-over or a breaker pause doesn't cancel a held action; a connected tool is
  listed again, so a refund approved after its definition changed is caught). An action that
  releases private data (`execute.releases_private_data`) is the exception: its session must still
  stand for its person (`execute.session_ended`), or it ends `refused_at_execution` with the plain
  reason (the person's session ended when their contact changed, or they were removed) and nothing
  runs; T2 asks again under the session row. A failed re-check or a `prepare` refusal ends
  `refused_at_execution` ("rules changed", or "This isn't available right now" when a connected
  tool's server can't list) with no intent row. Otherwise
  `approved`, `prepare`'s rows and the intent row commit together, and `execute.run_approved` runs
  the side effect as the session that asked, never the owner.

The approval is used up whichever way it ends. `allow_person` and `deny_always` also draft a card
(`person_card`, `never_card`) for the owner to prove (`/policy/draft`) and confirm; nothing here
changes a rule.

`POST /decisions/{decision_id}/cancel`: a session withdraws its own `held` request (`cancelled`);
any other state is 409, ledgered. A decision of another session, or another copy's for either
route, is 404, ledgered `auth` on the caller's Desk, or logged when the caller (an owner) has none.
A held quote with a discount is also `cancelled` by the first read after its session books
(`decide.supersede_if_booked`): the visitor booked without it, so an answer to it is 409 and
nothing runs.
"""

import secrets
from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from desk.contracts import (
    ApprovalAnswer,
    ApprovalResult,
    Decision,
    InboxNotice,
    LedgerEvent,
    Principal,
    RuleCard,
)
from desk.db.models import Action as ActionRow
from desk.db.models import Approval, Person
from desk.db.models import Decision as DecisionRow
from desk.kernel_api import AnswerRequest, CancelRequest
from desk.kernel_service import activation, auth, compiler, decide, execute, ledger
from desk.kernel_service.auth import AuthError, Named, OwnerCtx, SessionRow
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, new_id, storable
from desk.kernel_service.sessions import principal_for, verified

PERSON_REASON = "Allowed for {name} after you approved a request like this."
NEVER_REASON = "You said never for this."
DENIALS: frozenset[str] = frozenset({"deny_once", "deny_always"})
ANSWER_ROUTE = "POST /approvals/{decision_id}/answer"
CANCEL_ROUTE = "POST /decisions/{decision_id}/cancel"


def _scope(principal: Principal) -> tuple[str, str | None, str | None] | None:
    """Whom a card for this principal alone names: `("agent", None, key)` for an agent key,
    `("person", person_id, None)` for a verified person, else None."""
    if principal.kind == "agent" and principal.agent_key_id:
        return "agent", None, principal.agent_key_id
    if principal.person_id is not None and verified(principal.kind, principal.assurance, principal.person_id):
        return "person", principal.person_id, None
    return None


def person_card(decision: Decision, principal: Principal, *, auto_money_cap_cents: int,
                name: str | None = None) -> RuleCard:
    """`allow_person`'s draft ("Decision lifecycle"): an `auto` card for the decision's tool,
    scoped to the verified person or agent key that asked, whose limits are the action's own amount
    and discount, with no hours and no review, so it is no wider than what the owner just approved.
    `name` is how the owner knows them. Raises ValueError when there is no one to scope it to, or
    when the action moves money above the active version's money cap `auto_money_cap_cents` (or
    without an amount), so the draft fits the cap it will be drafted at."""
    action = decision.action
    scope = _scope(principal)
    if action is None or scope is None:
        raise ValueError("allow_person needs a verified person or an agent key")
    if decide.is_money(action.tool, action.effects) and (
            action.amount_cents is None or action.amount_cents > compiler.capped(auto_money_cap_cents)):
        raise ValueError("allow_person on money stops at the money cap")
    who, person_id, agent_key_id = scope
    fallback = "this visiting agent" if who == "agent" else "this customer"
    return RuleCard(card_id=f"person-{person_id or agent_key_id}-{action.tool}", applies_to=action.tool, mode="auto",
                    who=who, person_id=person_id, agent_key_id=agent_key_id, max_amount_cents=action.amount_cents,
                    max_discount_bp=action.discount_bp or 0, hours=None, review=False,
                    reason=PERSON_REASON.format(name=name or fallback))


def never_card(decision: Decision, principal: Principal) -> RuleCard:
    """`deny_always`'s draft ("Decision lifecycle"): a `never` card for the decision's tool, scoped
    to the verified person or agent key that asked, or to anyone when there is neither."""
    action = decision.action
    if action is None:
        raise ValueError("a never card names the tool of a held action")
    who, person_id, agent_key_id = _scope(principal) or ("anyone", None, None)
    return RuleCard(card_id=f"never-{person_id or agent_key_id or 'anyone'}-{action.tool}", applies_to=action.tool,
                    mode="never", who=who, person_id=person_id, agent_key_id=agent_key_id, reason=NEVER_REASON)


async def _locked(ctx: KernelCtx, decision_id: str) -> DecisionRow | None:
    """The copy's decision `decision_id`, locked `FOR UPDATE` until the transaction ends; None when
    the copy has none (text Postgres can't hold names none)."""
    if not storable(decision_id):
        return None
    return (await ctx.db.scalars(ctx.repo.scoped(
        select(DecisionRow).where(DecisionRow.decision_id == decision_id).with_for_update()
        .execution_options(populate_existing=True)))).one_or_none()


async def _note(ctx: KernelCtx, row: DecisionRow, summary: dict[str, Any]) -> None:
    """An `approval` entry on the decision's ledger that changes nothing about the decision."""
    await ledger.append(ctx, copy_id=row.copy_id, desk_id=row.desk_id, event=LedgerEvent(
        kind="approval", origin="kernel", session_id=row.session_id, ref_id=row.decision_id, summary=summary))


async def _refused(ctx: KernelCtx, row: DecisionRow, answer: ApprovalAnswer, refused: str, *,
                   status: int = 409) -> KernelFailure:
    """An answer that can't be taken: ledgered and committed with whatever reading the decision
    settled (its expiry, say); the answer is 409, or 422 for an answer the request wasn't offered."""
    await _note(ctx, row, {"decision_id": row.decision_id, "answer": answer, "refused": refused})
    await ctx.db.commit()
    return KernelFailure(status, "conflict" if status == 409 else "invalid", f"answer_refused:{refused}")


async def _refused_at_execution(ctx: KernelCtx, row: DecisionRow, answer: ApprovalAnswer, check: str, *,
                                reason: str = "rules_changed", status: str | None = None,
                                inbox: Sequence[InboxNotice] = ()) -> ApprovalResult:
    """An approval that can't run: the re-check failed, and `check` names the part that did (a
    deleted Desk is `desk`, a connected tool's server that couldn't list is `unavailable`, its
    status line `tool_unavailable`), or `prepare` refused (`prepare`), all "rules changed"; or it
    would release private data into a session that no longer stands for its person
    (`execute.session_ended`, ledgered as `reason="session_ended"` with the part in `check`). The
    visitor's status line is the state's own, never why their session ended. A `status`, when given,
    must be a decision's status line (`decide.status_line`): any other raises ValueError, which fails
    the answer with nothing written. The approval is used up all the same, nothing ran and no intent
    row was written. `inbox` holds the owner alerts the re-check wrote (a connected tool's drift)."""
    await decide.set_state(ctx, row, "refused_at_execution", kind="approval", status=status, summary={
        "decision_id": row.decision_id, "action_id": row.action_id, "answer": answer,
        "state": "refused_at_execution", "reason": reason, "check": check})
    return ApprovalResult(decision=await decide.decision_contract(ctx, row, inbox=inbox, for_owner=True),
                          execution=None, card_diff=None)


async def answer(ctx: KernelCtx, owner: OwnerCtx, decision_id: str, answer: ApprovalAnswer) -> ApprovalResult:
    """The owner's answer to a held decision of the copy `owner` authenticated, which the
    transaction is bound to (see the module docstring). A refusal is ledgered and committed before
    it is raised; an approval that runs commits its intent before the side effect and its outcome
    after it."""
    row = await _locked(ctx, decision_id)
    if row is None:
        # another copy's decisions are invisible: no Desk of this copy to ledger it on, so it is logged
        raise AuthError(404, "not_found", "unknown_decision", route=ANSWER_ROUTE)
    row = await execute.refresh_decision(ctx, row)
    if row.state != "held":
        raise await _refused(ctx, row, answer, row.state)
    if answer not in row.answers:
        raise await _refused(ctx, row, answer, "not_offered", status=422)
    action = decide.normalized_action((await ctx.db.scalars(ctx.repo.scoped(
        select(ActionRow).where(ActionRow.action_id == row.action_id)))).one())
    session_row = (await ctx.db.scalars(ctx.repo.scoped(
        select(SessionRow).where(SessionRow.session_id == row.session_id)))).one()
    principal = principal_for(session_row, desk_id=row.desk_id)
    card_diff: list[RuleCard] | None = None
    if answer == "allow_person":
        name = None
        if principal.person_id is not None:
            name = (await ctx.db.execute(ctx.repo.scoped(select(Person.display_name).where(
                Person.person_id == principal.person_id)))).scalar_one_or_none()
        cap = activation.version_cap(await activation.active_version(ctx, row.desk_id))
        try:
            card_diff = [person_card(await decide.decision_contract(ctx, row), principal, auto_money_cap_cents=cap,
                                     name=name)]
        except ValueError:
            raise await _refused(ctx, row, answer, "not_offered", status=422) from None
    elif answer == "deny_always":
        card_diff = [never_card(await decide.decision_contract(ctx, row), principal)]
    now = ctx.clock.now()
    approval = Approval(approval_id=new_id("apr"), copy_id=row.copy_id, decision_id=row.decision_id, answer=answer,
                        policy_version=row.policy_version, expires_at=row.expires_at, created_at=now)
    if answer not in DENIALS:
        # only an approval that runs something is bound to it
        approval.nonce = secrets.token_hex(16)
        approval.binding_sha256 = execute.binding_sha256(
            copy_id=action.copy_id, desk_id=action.desk_id, session_id=action.session_id, action_id=action.action_id,
            args_sha256=action.args_sha256, profile_sha256=action.profile_sha256, nonce=approval.nonce)
    try:
        async with ctx.db.begin_nested():
            ctx.db.add(approval)
            await ctx.db.flush()
    except IntegrityError:
        # the decision already has an approval: one answer per decision
        raise await _refused(ctx, row, answer, "answered") from None
    approval.consumed_at = now
    if answer in DENIALS:
        await decide.set_state(ctx, row, "denied", kind="approval", summary={
            "decision_id": row.decision_id, "action_id": row.action_id, "answer": answer, "state": "denied"})
        return ApprovalResult(decision=await decide.decision_contract(ctx, row, for_owner=True), execution=None,
                              card_diff=card_diff)
    if execute.releases_private_data(row.tool) and (ended := await execute.session_ended(ctx, row)) is not None:
        # private data goes only to a session that still stands for its person; T2 asks again under its lock
        return await _refused_at_execution(ctx, row, answer, ended, reason="session_ended")
    rechecked = await execute.recheck_outcome(ctx, row, path="approved")
    checked = rechecked.checked
    if checked is None or rechecked.failed is not None:
        # not a version: the part of the re-check that failed, named as an allow's is
        failed = rechecked.failed or "policy"
        return await _refused_at_execution(ctx, row, answer, failed, status=execute.visitor_template(failed),
                                           inbox=rechecked.notices)
    if not await execute.prepare_intent(ctx, row, checked=checked):
        return await _refused_at_execution(ctx, row, answer, "prepare")
    await decide.set_state(ctx, row, "approved", kind="approval", summary={
        "decision_id": row.decision_id, "action_id": row.action_id, "answer": answer, "state": "approved"})
    await ctx.db.commit()
    approved = await decide.decision_contract(ctx, row)
    execution = await execute.run_approved(ctx, row, checked=checked)
    final = (await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow).where(
        DecisionRow.decision_id == row.decision_id).execution_options(populate_existing=True)))).one()
    if final.state == "refused_at_execution":
        approved = None                   # T2 refused it after all: nothing ran, so it isn't shown as approved
    return ApprovalResult(decision=await decide.decision_contract(ctx, final, for_owner=True), execution=execution,
                          card_diff=card_diff, approved=approved)


async def cancel(ctx: KernelCtx, session_row: SessionRow, decision_id: str) -> Decision:
    """The authenticated session withdraws one of its own held requests: `cancelled`, ledgered and
    signed again. A request no longer held is 409, ledgered; anyone else's is 404."""
    named = Named(copy_id=session_row.copy_id, desk_id=session_row.desk_id, session_id=session_row.session_id)
    row = await _locked(ctx, decision_id)
    if row is None or row.session_id != session_row.session_id:
        raise AuthError(404, "not_found", "unknown_decision" if row is None else "wrong_session", route=CANCEL_ROUTE,
                        named=named)
    row = await execute.refresh_decision(ctx, row)
    if row.state != "held":
        # a reconciliation in the read may have committed, so the owner could close the session since its
        # check: a closed session is answered as closed, never with the decision's state
        await ctx.recheck()
        await ledger.append(ctx, copy_id=row.copy_id, desk_id=row.desk_id, event=LedgerEvent(
            kind="decide", origin="kernel", session_id=row.session_id, ref_id=row.decision_id,
            summary={"decision_id": row.decision_id, "cancel_refused": row.state}))
        await ctx.db.commit()
        raise KernelFailure(409, "conflict", f"cancel_refused:{row.state}")
    await decide.set_state(ctx, row, "cancelled", summary={
        "decision_id": row.decision_id, "action_id": row.action_id, "state": "cancelled"})
    return await decide.decision_contract(ctx, row)


router = APIRouter()


@router.post("/approvals/{decision_id}/answer", response_model=ApprovalResult)
async def post_answer(decision_id: str, body: AnswerRequest, ctx: Ctx, request: Request) -> ApprovalResult:
    if auth.SESSION_HEADER in request.headers:
        raise AuthError(401, "auth", "bad_token", route=ANSWER_ROUTE)        # the owner's credential alone
    owner = await auth.require_owner(ctx, request)
    return await answer(ctx, owner, decision_id, body.answer)


@router.post("/decisions/{decision_id}/cancel", response_model=Decision)
async def post_cancel(decision_id: str, body: CancelRequest, ctx: Ctx, request: Request) -> Decision:
    session_row = await auth.require_session(ctx, request, body.session_id)
    return await cancel(ctx, session_row, decision_id)
