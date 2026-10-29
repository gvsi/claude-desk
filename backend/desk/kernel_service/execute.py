"""Executing a decided action: an allow through `POST /execute`, and an approved hold inside the
owner's answer (`run_approved`).

An execution takes up to three transactions, so that a crash leaves a record of how far it got:

- T1 locks the decision, settles it as any read does (`refresh_decision`), re-checks it against
  the current rows (`recheck`, step 6 of "Evaluation"), runs the adapter's `prepare` and commits
  the `executions` row in state `intent`, with whatever `prepare` reserved. Nothing outside the
  kernel has happened yet.
- T2 locks the intent row and, for an allow, holds the session row `FOR SHARE`, so a take-over
  waits for a running execution and one that came first stops it (the fence). It runs the
  adapter's `execute`, then commits `succeeded` with the result and the decision `executed`,
  ledgered and signed again.
- T3 runs after an `Exception` in T2, which rolled back: `AdapterFailure` (raised only before any
  external side effect) is `failed`, after the adapter's `on_failed`; anything else, a failed T2
  commit included, is `unknown`, left to reconciliation. A `BaseException` (the process dying, a
  cancelled task) skips T3 and leaves the intent row.

Reconciliation (`reconcile_orphans`) settles an intent no execution is running (older than
`ORPHAN_AFTER`, and its row not locked) and an `unknown` action by asking the adapter what
happened (`reconcile`, by `action_id`), on every read of the decision and at startup. Nothing is
retried blindly.

Claude sees an execution only through its `model_view`: kept to the adapter's `model_view_keys`,
and emptied when a fact the session can't read was dropped or a value carries a document canary.
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

import desk_kernel
from fastapi import APIRouter, Request
from pydantic import ValidationError
from sqlalchemy import and_, or_, select

from desk.contracts import ExecResult, LedgerEvent, NormalizedAction, Principal
from desk.db.models import Action as ActionRow
from desk.db.models import Approval, Business, Desk, Document, Execution, Tool
from desk.db.models import Decision as DecisionRow
from desk.kernel_api import ExecuteRequest
from desk.kernel_service import activation, adapters, auth, decide, labels, ledger, repo
from desk.kernel_service.adapters.base import (Adapter, AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown,
                                               ExecCtx, Normalized, NormalizeCtx)
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.decisions import Reviewed
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, KernelRuntime, kernel_transaction
from desk.kernel_service.sessions import principal_for

log = logging.getLogger(__name__)

ORPHAN_AFTER = timedelta(seconds=30)      # an intent younger than this may still be running
EXECUTE_ROUTE = "POST /execute"
ExecPath = Literal["allow", "approved"]   # an allow through /execute, an approved hold inside the answer


def binding_sha256(*, copy_id: str, desk_id: str, session_id: str, action_id: str, args_sha256: str,
                   profile_sha256: str, nonce: str) -> str:
    """The master's `Approval.binding_sha256`: sha256 of `canonical_json` of the action an approval
    is for and its nonce, so the approval runs that exact action and nothing else."""
    body = {"copy_id": copy_id, "desk_id": desk_id, "session_id": session_id, "action_id": action_id,
            "args_sha256": args_sha256, "profile_sha256": profile_sha256, "nonce": nonce}
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(body)).encode()).hexdigest()


async def _after_intent() -> None:
    """A test hook between T1 and T2 (the intent row committed, no side effect yet); does nothing.
    It is looked up by its module name on each call, so patching the attribute reaches it."""


# ---- The rows an execution works on --------------------------------------------------------------

@dataclass
class _Target:
    """A decision's action with the rows it runs on, read in the current transaction."""

    decision: DecisionRow
    action_row: ActionRow
    action: NormalizedAction
    session_row: SessionRow
    desk_row: Desk
    business: Business
    adapter: Adapter | None
    principal: Principal

    def xctx(self, ctx: KernelCtx) -> ExecCtx:
        return ExecCtx(ctx=ctx, desk_row=self.desk_row, session_row=self.session_row, principal=self.principal)


async def _one(ctx: KernelCtx, stmt: Any) -> Any:
    return (await ctx.db.scalars(ctx.repo.scoped(stmt))).one()


async def _target(ctx: KernelCtx, decision: DecisionRow) -> _Target:
    """The decision's action, session (the principal it runs as: the decision's own, never the
    caller's), Desk, business and adapter, from the current rows."""
    fresh = {"populate_existing": True}
    action_row = await _one(ctx, select(ActionRow).where(ActionRow.action_id == decision.action_id)
                            .execution_options(**fresh))
    session_row = await _one(ctx, select(SessionRow).where(SessionRow.session_id == decision.session_id)
                             .execution_options(**fresh))
    desk_row = await _one(ctx, select(Desk).where(Desk.desk_id == decision.desk_id).execution_options(**fresh))
    business = await _one(ctx, select(Business).where(Business.business_id == desk_row.business_id)
                          .execution_options(**fresh))
    return _Target(decision=decision, action_row=action_row, action=decide.normalized_action(action_row),
                   session_row=session_row, desk_row=desk_row, business=business,
                   adapter=adapters.ADAPTERS.get(action_row.tool),
                   principal=principal_for(session_row, desk_id=decision.desk_id))


async def _find_decision(ctx: KernelCtx, decision_id: str) -> DecisionRow | None:
    if not decide._storable(decision_id):                # text Postgres can't hold names no decision
        return None
    return (await ctx.db.scalars(ctx.repo.scoped(
        select(DecisionRow).where(DecisionRow.decision_id == decision_id)))).one_or_none()


async def _lock_decision(ctx: KernelCtx, decision_id: str) -> DecisionRow:
    return await _one(ctx, select(DecisionRow).where(DecisionRow.decision_id == decision_id).with_for_update()
                      .execution_options(populate_existing=True))


async def _share_session(ctx: KernelCtx, session_id: str) -> SessionRow:
    """The session row, held `FOR SHARE` until the transaction ends: a mode change (which takes it
    `FOR UPDATE`) waits, so the mode and generation read here hold for the whole transaction."""
    return await _one(ctx, select(SessionRow).where(SessionRow.session_id == session_id)
                      .with_for_update(read=True).execution_options(populate_existing=True))


async def _execution(ctx: KernelCtx, action_id: str, *, lock: bool = False) -> Execution | None:
    stmt = select(Execution).where(Execution.action_id == action_id)
    if lock:
        stmt = stmt.with_for_update()
    return (await ctx.db.scalars(ctx.repo.scoped(stmt.execution_options(populate_existing=True)))).one_or_none()


async def _note(ctx: KernelCtx, row: DecisionRow, summary: dict[str, Any]) -> None:
    """An `execute` entry on the decision's ledger that changes nothing about the decision."""
    await ledger.append(ctx, copy_id=row.copy_id, desk_id=row.desk_id, event=LedgerEvent(
        kind="execute", origin="kernel", session_id=row.session_id, ref_id=row.decision_id, summary=summary))


def _summary(target: _Target, state: str, **extra: Any) -> dict[str, Any]:
    return {"decision_id": target.decision.decision_id, "action_id": target.action.action_id, "state": state,
            **extra}


def _no_result(action_id: str, state: Literal["failed", "unknown"]) -> ExecResult:
    return ExecResult(action_id=action_id, state=state, facts=[], model_view={})


# ---- Step 6: the re-check -------------------------------------------------------------------------

async def recheck(ctx: KernelCtx, decision_row: DecisionRow, *, path: ExecPath) -> bool:
    """Step 6 of "Evaluation" for a decision about to run, against the current rows: on `allow`
    the conditions `/decide` had (mode `ai` at the decision's generation, the tool given to the
    session) and the `auto` verdict with the stored review; on `approved` the approvable verdict
    and the approval's binding. Either way the Desk must stand, the tool must be registered and
    enabled, and the adapter must normalize the stored args to exactly the stored action."""
    return await _recheck(ctx, await _target(ctx, decision_row), path) is None


async def _recheck(ctx: KernelCtx, target: _Target, path: ExecPath) -> str | None:
    """`recheck`, returning None when it passes, else the part that failed (a ledgered code)."""
    decision, action, desk_row, adapter = target.decision, target.action, target.desk_row, target.adapter
    # (1) the Desk and the tool, as the path needs them
    if desk_row.deleted_at is not None:
        return "desk"
    enabled = {row.tool: row for row in await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
        Tool.desk_id == desk_row.desk_id, Tool.status == "enabled"))) if row.profile is not None and row.profile_sha256}
    tool_row = enabled.get(action.tool)
    if adapter is None or tool_row is None:
        return "tool"
    if path == "allow":
        session = target.session_row
        if session.mode != "ai" or session.generation != decision.generation:
            return "session"
        if action.tool not in decide.tools_given(target.principal, session, desk_row, enabled):
            return "tool"
    # (2) the same action from the stored args, at the current profile
    try:
        args = adapter.Args.model_validate(target.action_row.args_json)
        normalized = await adapter.normalize(NormalizeCtx(ctx=ctx, desk_row=desk_row, principal=target.principal),
                                             args)
    except (ValidationError, AdapterRefusal):
        return "args"
    stored = Normalized(resource=action.resource, list_cents=action.list_cents, discount_bp=action.discount_bp,
                        amount_cents=action.amount_cents, recipient=action.recipient, starts_at=action.starts_at)
    args_sha256 = decide.args_sha256(args.model_dump(mode="json", exclude_none=True))
    if normalized != stored or args_sha256 != action.args_sha256:
        return "args"
    if tool_row.profile_sha256 != action.profile_sha256:
        return "profile"
    # (3) the current rules, for the principal as it stands now
    version_row = await activation.active_version(ctx, desk_row.desk_id)
    if version_row is None or ctx.policies.versions.use(version_row):
        return "policy"
    request = decide.cedar_request(target.principal, action, tz=target.business.timezone, now=ctx.clock.now())
    if path == "allow":
        stored_review = Reviewed(review=decision.review, usage=None)

        async def review_source(pending: object) -> Reviewed:
            return stored_review                           # the review the allow was decided with, never a new call

        if (await decide.evaluate(ctx, version_row, request, review_source=review_source)).outcome != "allow":
            return "policy"
        return None
    key = activation.version_key(version_row.desk_id, version_row.version) + ":approvable"
    verdict = json.loads(ctx.policies.engine.decide(key, json.dumps(request), "final"))
    if verdict["errors"] or verdict["outcome"] != "hold":
        return "policy"
    approval = (await ctx.db.scalars(ctx.repo.scoped(
        select(Approval).where(Approval.decision_id == decision.decision_id)))).one_or_none()
    if approval is None or not approval.nonce or approval.binding_sha256 != binding_sha256(
            copy_id=action.copy_id, desk_id=action.desk_id, session_id=action.session_id, action_id=action.action_id,
            args_sha256=args_sha256, profile_sha256=tool_row.profile_sha256, nonce=approval.nonce):
        return "binding"
    return None


# ---- T1: the intent --------------------------------------------------------------------------------

async def prepare_intent(ctx: KernelCtx, decision_row: DecisionRow) -> bool:
    """The adapter's `prepare`, then the intent row, in the caller's transaction, which commits them
    together. False, with nothing written, when `prepare` refuses."""
    return await _prepare_intent(ctx, await _target(ctx, decision_row))


async def _prepare_intent(ctx: KernelCtx, target: _Target) -> bool:
    prepare = getattr(target.adapter, "prepare", None)
    if prepare is not None:
        try:
            async with ctx.db.begin_nested():           # a refusal takes back what prepare wrote
                await prepare(target.xctx(ctx), target.action)
        except AdapterRefusal:
            return False
    ctx.db.add(Execution(action_id=target.action.action_id, copy_id=target.action.copy_id,
                         decision_id=target.decision.decision_id, state="intent", started_at=ctx.clock.now()))
    await ctx.db.flush()
    return True


async def _refused_at_execution(ctx: KernelCtx, target: _Target, check: str) -> KernelFailure:
    """The decision becomes `refused_at_execution` ("rules changed"), committed; the answer is 409."""
    await decide.set_state(ctx, target.decision, "refused_at_execution", kind="execute",
                           summary=_summary(target, "refused_at_execution", reason="rules_changed", check=check))
    await ctx.db.commit()
    return KernelFailure(409, "conflict", f"refused_at_execution:{check}")


async def _not_runnable(ctx: KernelCtx, row: DecisionRow, refused: str) -> KernelFailure:
    """A decision in no state to run (409), ledgered, with what reading it settled committed."""
    await _note(ctx, row, {"decision_id": row.decision_id, "refused": refused})
    await ctx.db.commit()
    return KernelFailure(409, "conflict", f"not_runnable:{refused}")


async def _repeat(ctx: KernelCtx, row: DecisionRow, execution: Execution) -> ExecResult:
    """A decision that already ran: its stored result, ledgered as a repeat; 409 while it runs or
    is unknown."""
    if execution.state not in ("succeeded", "failed") or execution.result is None:
        raise await _not_runnable(ctx, row, execution.state)
    await _note(ctx, row, {"decision_id": row.decision_id, "action_id": execution.action_id, "repeat": True})
    await ctx.db.commit()
    return execution.result


def _stale(named: Named, decision_id: str) -> AuthError:
    """409 `stale_generation`, ledgered as `auth`; the allow, if it never began, expires with it."""
    error = AuthError(409, "stale_generation", "stale_generation", route=EXECUTE_ROUTE, named=named)
    record_refusal = error.persist

    async def persist(ctx: KernelCtx) -> None:
        await record_refusal(ctx)                        # binds the copy
        row = await _lock_decision(ctx, decision_id)
        if row.state == "allowed" and await _execution(ctx, row.action_id) is None:
            await decide.set_state(ctx, row, "expired", kind="execute", summary={
                "decision_id": row.decision_id, "action_id": row.action_id, "state": "expired",
                "reason": "stale_generation"})

    error.persist = persist
    return error


async def execute_allowed(ctx: KernelCtx, session_row: SessionRow, decision_id: str, generation: int) -> ExecResult:
    """Runs one of the session's allows, once ("Session state responses", then T1 to T3). The caller
    has authenticated `session_row`; the decision must be that session's."""
    named = Named(copy_id=session_row.copy_id, desk_id=session_row.desk_id, session_id=session_row.session_id)
    found = await _find_decision(ctx, decision_id)
    if found is None or found.session_id != session_row.session_id:
        raise AuthError(404, "not_found", "unknown_decision" if found is None else "wrong_session",
                        route=EXECUTE_ROUTE, named=named)
    named = Named(copy_id=found.copy_id, desk_id=found.desk_id, session_id=found.session_id)
    row = await _lock_decision(ctx, found.decision_id)
    session = await _share_session(ctx, row.session_id)
    if generation != session.generation or row.generation != session.generation:
        raise _stale(named, row.decision_id)
    if session.mode in ("owner", "paused"):
        # a paused session's allow is left to expire
        raise AuthError(409, f"mode_{session.mode}", f"mode_{session.mode}", route=EXECUTE_ROUTE, named=named)

    row = await refresh_decision(ctx, row)
    execution = await _execution(ctx, row.action_id) if row.action_id is not None else None
    if execution is not None:
        return await _repeat(ctx, row, execution)
    if row.state != "allowed" or ctx.clock.now() >= row.expires_at:
        raise await _not_runnable(ctx, row, row.state)
    target = await _target(ctx, row)
    if (failed := await _recheck(ctx, target, "allow")) is not None:
        raise await _refused_at_execution(ctx, target, failed)
    if not await _prepare_intent(ctx, target):
        raise await _refused_at_execution(ctx, target, "prepare")
    await ctx.db.commit()                                # T1: the intent row, before any side effect
    return await _run(ctx, row.decision_id, target.action.action_id, path="allow")


async def run_approved(ctx: KernelCtx, decision_row: DecisionRow) -> ExecResult:
    """T2 and T3 for an approved hold whose intent row the answer has committed, as the held
    session's principal; mode and generation aren't checked (step 6)."""
    return await _run(ctx, decision_row.decision_id, decision_row.action_id, path="approved")


# ---- T2 and T3: the side effect and its outcome -----------------------------------------------------

async def _run(ctx: KernelCtx, decision_id: str, action_id: str, *, path: ExecPath) -> ExecResult:
    await _after_intent()
    try:
        outcome = await _side_effect(ctx, decision_id, action_id, path)
    except AdapterFailure as failure:
        await ctx.db.rollback()
        return await _settle_failed(ctx, action_id, failure)
    except Exception:
        # an outcome nobody knows, a failed commit included: never retried, left to reconciliation
        log.exception("execution_unknown action_id=%s", action_id)
        await ctx.db.rollback()
        return await _settle_unknown(ctx, action_id)
    if isinstance(outcome, KernelFailure):
        raise outcome
    return outcome


async def _side_effect(ctx: KernelCtx, decision_id: str, action_id: str, path: ExecPath) -> ExecResult | KernelFailure:
    """T2: under the intent row's lock (and, for an allow, the session's), the adapter's `execute`,
    then `succeeded` and `executed`, committed. A failure answer comes back as a `KernelFailure`,
    already committed, for `_run` to raise."""
    execution = await _execution(ctx, action_id, lock=True)
    if execution is None or execution.state != "intent":
        # reconciliation settled it first
        if execution is not None and execution.state in ("succeeded", "failed") and execution.result is not None:
            return execution.result
        return KernelFailure(409, "conflict", "not_an_intent")
    target = await _target(ctx, await _one(ctx, select(DecisionRow).where(DecisionRow.decision_id == decision_id)))
    if path == "allow":
        session = await _share_session(ctx, target.session_row.session_id)
        if session.generation != target.decision.generation:
            return await _fenced(ctx, target, execution, "stale_generation")
        if session.mode != "ai":
            return await _fenced(ctx, target, execution, f"mode_{session.mode}")
    adapter = target.adapter
    if adapter is None:
        raise AdapterFailure("no_adapter")
    args = adapter.Args.model_validate(target.action_row.args_json)
    result = await adapter.execute(target.xctx(ctx), target.action, args)
    visible = await _visible(ctx, target, result)
    await _finish(ctx, target, execution, visible, "executed", _summary(target, "executed"))
    await ctx.db.commit()
    return visible


async def _fenced(ctx: KernelCtx, target: _Target, execution: Execution, code: str) -> KernelFailure:
    """A take-over or a pause that came before the side effect: the allow doesn't run. Its intent
    is `failed` (after `on_failed`), the decision `expired`, and the answer is 409 with the
    session-state code, ledgered as `auth` too."""
    await _undo(ctx, target)
    await _finish(ctx, target, execution, _no_result(target.action.action_id, "failed"), "expired",
                  _summary(target, "expired", fenced=True))
    await ledger.append(ctx, copy_id=target.decision.copy_id, desk_id=target.decision.desk_id, event=LedgerEvent(
        kind="auth", origin="kernel", session_id=target.decision.session_id,
        summary={"route": EXECUTE_ROUTE, "reason": code}))
    await ctx.db.commit()
    return KernelFailure(409, code, f"fenced:{code}")


async def _undo(ctx: KernelCtx, target: _Target) -> None:
    """The adapter's optional `on_failed`, undoing what `prepare` reserved."""
    on_failed = getattr(target.adapter, "on_failed", None)
    if on_failed is not None:
        await on_failed(target.xctx(ctx), target.action)


async def _finish(ctx: KernelCtx, target: _Target, execution: Execution, result: ExecResult, decision_state: str,
                  summary: dict[str, Any]) -> None:
    """The execution's final row and the decision's state, ledgered and signed, in the caller's
    transaction."""
    execution.state = {"executed": "succeeded", "failed": "failed", "expired": "failed"}[decision_state]
    execution.result = result
    execution.finished_at = ctx.clock.now()
    decision = await _lock_decision(ctx, target.decision.decision_id)
    await decide.set_state(ctx, decision, decision_state, kind="execute", summary=summary)


async def _settle_failed(ctx: KernelCtx, action_id: str, failure: AdapterFailure) -> ExecResult:
    """T3 after `AdapterFailure`: `on_failed`, then `failed`. If `on_failed` itself fails, the
    reservation may still stand, so the action is `unknown` instead."""
    execution = await _execution(ctx, action_id, lock=True)
    if execution is None or execution.state != "intent":
        return await _settled_elsewhere(execution, action_id)
    target = await _target(ctx, await _lock_decision(ctx, execution.decision_id))
    try:
        async with ctx.db.begin_nested():
            await _undo(ctx, target)
    except Exception:
        log.exception("on_failed_failed action_id=%s", action_id)
        await ctx.db.rollback()
        return await _settle_unknown(ctx, action_id)
    code = failure.args[0] if failure.args and isinstance(failure.args[0], str) else "adapter_failure"
    result = _no_result(action_id, "failed")
    await _finish(ctx, target, execution, result, "failed", _summary(target, "failed", reason=ledger.safe_ref(code)))
    await ctx.db.commit()
    return result


async def _settle_unknown(ctx: KernelCtx, action_id: str) -> ExecResult:
    """T3 after any other exception: `unknown`, with `prepare`'s reservation kept."""
    execution = await _execution(ctx, action_id, lock=True)
    if execution is None or execution.state != "intent":
        return await _settled_elsewhere(execution, action_id)
    target = await _target(ctx, await _lock_decision(ctx, execution.decision_id))
    result = _no_result(action_id, "unknown")
    await _mark_unknown(ctx, target, execution, result)
    await ctx.db.commit()
    return result


async def _mark_unknown(ctx: KernelCtx, target: _Target, execution: Execution, result: ExecResult,
                        **extra: Any) -> None:
    execution.state = "unknown"
    execution.result = result
    await decide.set_state(ctx, target.decision, "unknown", kind="execute",
                           summary=_summary(target, "unknown", **extra))


async def _settled_elsewhere(execution: Execution | None, action_id: str) -> ExecResult:
    """An intent another call settled while this one failed: its result if it has one."""
    if execution is not None and execution.result is not None:
        return execution.result
    return _no_result(action_id, "unknown")


# ---- What Claude may see ---------------------------------------------------------------------------

async def _visible(ctx: KernelCtx, target: _Target, result: AdapterResult) -> ExecResult:
    """The adapter's result as the session may see it: the facts its readers can read, and a
    `model_view` kept to the adapter's `model_view_keys`, or `{}` when a fact was dropped or a value
    carries one of the copy's document canaries."""
    readers = labels.session_readers(target.session_row)
    facts = [fact for fact in result.facts if labels.can_read(fact.label, readers)]
    keys = target.adapter.model_view_keys if target.adapter is not None else frozenset()
    view = {key: value for key, value in result.model_view.items() if key in keys}
    if len(facts) < len(result.facts) or await _holds_canary(ctx, view):
        view = {}
    return ExecResult(action_id=target.action.action_id, state="succeeded", facts=facts, model_view=view,
                      inbox=list(result.inbox))


async def _holds_canary(ctx: KernelCtx, view: dict[str, Any]) -> bool:
    canaries = [canary.lower() for canary in await ctx.db.scalars(ctx.repo.scoped(select(Document.canary)))
                if canary]
    text = json.dumps(view, default=str).lower()
    return any(canary in text for canary in canaries)


# ---- Reconciliation ---------------------------------------------------------------------------------

def _orphaned(cutoff: datetime) -> Any:
    """An execution nobody is settling: an intent started before `cutoff`, or an `unknown`."""
    return or_(and_(Execution.state == "intent", Execution.started_at < cutoff), Execution.state == "unknown")


async def refresh_decision(ctx: KernelCtx, decision_row: DecisionRow) -> DecisionRow:
    """A decision as a read settles it: its orphaned execution reconciled, then lazy expiry
    ("Decision lifecycle"), in the caller's transaction. Returns the current row."""
    decision_id, action_id = decision_row.decision_id, decision_row.action_id
    if action_id is not None and decision_row.state in ("allowed", "approved", "unknown"):
        if await reconcile_orphans(ctx, at_startup=False, action_id=action_id):
            decision_row = await _one(ctx, select(DecisionRow).where(DecisionRow.decision_id == decision_id)
                                      .execution_options(populate_existing=True))
    return await decide.expire_if_due(ctx, decision_row)


async def reconcile_orphans(ctx: KernelCtx, *, at_startup: bool, action_id: str | None = None) -> list[str]:
    """Reconciles the orphaned executions of the copy `ctx` is bound to (`action_id`: that action's
    alone) and returns the actions it settled or moved to `unknown`. On a read (`at_startup`
    False) everything happens in the caller's transaction; at startup each action commits on its
    own, and one that fails is logged and left for the next read."""
    cutoff = ctx.clock.now() - ORPHAN_AFTER
    stmt = select(Execution.action_id).where(_orphaned(cutoff))
    if action_id is not None:
        stmt = stmt.where(Execution.action_id == action_id)
    candidates = list(await ctx.db.scalars(ctx.repo.scoped(stmt.order_by(Execution.started_at,
                                                                          Execution.action_id))))
    reconciled = []
    for candidate in candidates:
        try:
            if await _reconcile(ctx, candidate, cutoff):
                reconciled.append(candidate)
            if at_startup:
                await ctx.db.commit()
        except Exception:
            if not at_startup:
                raise
            log.exception("reconcile_failed action_id=%s", candidate)
            await ctx.db.rollback()
    return reconciled


async def _reconcile(ctx: KernelCtx, action_id: str, cutoff: datetime) -> bool:
    """One orphaned execution, under both rows' locks: an intent becomes `unknown` (ledgered), then
    the adapter says what happened. A result is `executed`, rebuilt as the session may see it;
    None is `failed`, after `on_failed`; `AdapterUnknown` (or any error) leaves it `unknown`. A row
    a running execution holds is skipped."""
    execution = (await ctx.db.scalars(ctx.repo.scoped(
        select(Execution).where(Execution.action_id == action_id, _orphaned(cutoff))
        .with_for_update(skip_locked=True).execution_options(populate_existing=True)))).one_or_none()
    if execution is None:
        return False
    target = await _target(ctx, await _lock_decision(ctx, execution.decision_id))
    if execution.state == "intent":
        await _mark_unknown(ctx, target, execution, _no_result(action_id, "unknown"), orphaned=True)
    if target.adapter is None:
        log.warning("reconcile_no_adapter action_id=%s", action_id)
        return True
    try:
        async with ctx.db.begin_nested():
            result = await target.adapter.reconcile(target.xctx(ctx), target.action)
            if result is None:
                await _undo(ctx, target)
                await _finish(ctx, target, execution, _no_result(action_id, "failed"), "failed",
                              _summary(target, "failed", reconciled=True))
            else:
                await _finish(ctx, target, execution, await _visible(ctx, target, result), "executed",
                              _summary(target, "executed", reconciled=True))
    except AdapterUnknown:
        log.info("reconcile_still_unknown action_id=%s", action_id)
    except Exception:
        log.exception("reconcile_error action_id=%s", action_id)       # still unknown; the next read tries again
    return True


async def reconcile_at_startup(runtime: KernelRuntime) -> list[str]:
    """Startup reconciliation: every copy with an orphaned execution (`repo.orphan_intents`),
    reconciled through its own `KernelRepo`. Returns the actions it settled or moved."""
    found = await repo.orphan_intents(runtime, runtime.clock.now() - ORPHAN_AFTER)
    reconciled: list[str] = []
    for copy_id in sorted({copy_id for copy_id, _ in found}):
        try:
            async with kernel_transaction(runtime) as ctx:
                ctx.bind(copy_id)
                reconciled += await reconcile_orphans(ctx, at_startup=True)
        except Exception:
            log.exception("startup_reconcile_failed copy_id=%s", copy_id)
    return reconciled


# ---- The approval form: reconciling an unknown approved execution ------------------------------------

async def reconcile_approved(ctx: KernelCtx, session_row: SessionRow, decision_id: str, approval_id: str) -> ExecResult:
    """`POST /execute` with `approval_id`: reconciles the session's `unknown` approved decision, once
    the approval's binding still matches its action; it never runs anything anew. Anything else is
    409, ledgered."""
    named = Named(copy_id=session_row.copy_id, desk_id=session_row.desk_id, session_id=session_row.session_id)
    found = await _find_decision(ctx, decision_id)
    if found is None or found.session_id != session_row.session_id:
        raise AuthError(404, "not_found", "unknown_decision" if found is None else "wrong_session",
                        route=EXECUTE_ROUTE, named=named)
    row = await _lock_decision(ctx, found.decision_id)
    approval = (await ctx.db.scalars(ctx.repo.scoped(select(Approval).where(
        Approval.approval_id == approval_id)))).one_or_none() if decide._storable(approval_id) else None
    if approval is None or approval.decision_id != row.decision_id or row.state != "unknown" or row.action_id is None:
        raise await _not_runnable(ctx, row, row.state)
    action = decide.normalized_action(await _one(ctx, select(ActionRow).where(ActionRow.action_id == row.action_id)))
    if not approval.nonce or approval.binding_sha256 != binding_sha256(
            copy_id=action.copy_id, desk_id=action.desk_id, session_id=action.session_id, action_id=action.action_id,
            args_sha256=action.args_sha256, profile_sha256=action.profile_sha256, nonce=approval.nonce):
        raise await _not_runnable(ctx, row, "binding")
    await reconcile_orphans(ctx, at_startup=False, action_id=row.action_id)
    execution = await _execution(ctx, row.action_id)
    if execution is not None and execution.state in ("succeeded", "failed") and execution.result is not None:
        return execution.result
    return _no_result(row.action_id, "unknown")


# ---- Route -------------------------------------------------------------------------------------------

router = APIRouter()


def _not_its_credential(row: SessionRow | DecisionRow) -> AuthError:
    """401 for the owner's token on another session's allow, ledgered on that session's Desk."""
    return AuthError(401, "auth", "bad_token", route=EXECUTE_ROUTE,
                     named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))


async def _caller_session(ctx: KernelCtx, request: Request, body: ExecuteRequest) -> SessionRow:
    """The session `/execute` acts for. A session's token acts for its own session. The owner's
    token acts for a session of its copy, but an allow runs only with its own session's credential,
    so the owner executes only its own session's allows (anyone else's: 401) and reconciles any
    session's approved hold, having answered it."""
    owner_header, session_header = auth.OWNER_HEADER in request.headers, auth.SESSION_HEADER in request.headers
    if owner_header == session_header:
        raise AuthError(401, "auth", "bad_token", route=EXECUTE_ROUTE)
    if session_header:
        return await auth.require_session(ctx, request, body.session_id)
    owner = await auth.require_owner(ctx, request, session_id=body.session_id)
    row = await _one(ctx, select(SessionRow).where(SessionRow.session_id == body.session_id))
    if body.approval_id is not None:
        return row
    if row.session_id != owner.session_id:
        raise _not_its_credential(row)
    found = await _find_decision(ctx, body.decision_id)
    if found is not None and found.session_id != owner.session_id:
        raise _not_its_credential(found)
    return row


@router.post("/execute", response_model=ExecResult)
async def post_execute(body: ExecuteRequest, ctx: Ctx, request: Request) -> ExecResult:
    session_row = await _caller_session(ctx, request, body)
    if body.approval_id is not None:
        return await reconcile_approved(ctx, session_row, body.decision_id, body.approval_id)
    if body.generation is None:                           # ExecuteRequest takes exactly one of the two
        raise KernelFailure(422, "invalid", "no_generation")
    return await execute_allowed(ctx, session_row, body.decision_id, body.generation)
