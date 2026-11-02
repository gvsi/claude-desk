"""Executing a decided action: an allow through `POST /execute`, and an approved hold inside the
owner's answer (`run_approved`).

An execution takes up to three transactions, so that a crash leaves a record of how far it got:

- T1 locks the decision (for an allow, once it holds the session row `FOR SHARE`), settles it as
  any read does (`refresh_decision`), re-checks it against the current rows (`recheck`, step 6
  of "Evaluation", against the active version at its money cap, which the `execute` entries that
  follow name as `policy_version` and `auto_money_cap_cents`, and with an agent's mandate spend as
  it stands, `mandates.session_remaining`), makes sure the receipt it will end on can be written
  (`_receipt_ready`), runs the adapter's `prepare` (an agent's money action reserves its amount on
  its mandate there, under the mandate row's lock) and commits the `executions` row in state
  `intent`, with whatever `prepare` reserved and the version and cap the re-check ran under.
  Nothing outside the kernel has happened yet.
- T2 first holds the session row (`_hold_session`), on either path: `FOR SHARE`, so a take-over,
  or a Desk's deletion closing the session, waits for a running execution, and one that came
  first stops it (the fence); `FOR UPDATE` for an adapter that writes the session's own rows
  (`locks_session`). Then it locks the decision and the intent row and, before any side effect,
  reads the session and the Desk afresh: a Desk deleted since T1, or an allow's session closed,
  ends `refused_at_execution` (`_refused_in_t2`), and so does an approved hold that releases private
  data whose session no longer stands for its person (`session_ended`), with the plain reason the
  owner reads; an allow's session that no longer stands
  otherwise (`auth.session_stands`: its person off the record, say) ends the same way and answers
  409 `closed`, ledgered as at authentication (`_closed_in_t2`); and an allow's take-over or pause
  is fenced. Otherwise it runs the adapter's `execute`, and commits `succeeded` with the result
  and the decision `executed`, ledgered and signed again. That commit runs no recheck
  (`KernelCtx.commit`): it records what the adapter did, whatever happens to the session after.
- T3 runs after an `Exception` in T2, which rolled back: `AdapterFailure` (raised only before any
  external side effect) is `failed`, after the adapter's `on_failed`; anything else, a failed T2
  commit included, is `unknown`, left to reconciliation. A `BaseException` (the process dying, a
  cancelled task) skips T3 and leaves the intent row.

Every step takes its locks in the kernel's order (`repo.py`): the session row, the decision, the
execution row, the rows the adapter's hooks lock, then the ledger head.

Reconciliation (`reconcile_orphans`) settles an intent no execution is running (older than
`ORPHAN_AFTER`, and its rows not locked) and an `unknown` action by asking the adapter what
happened (`reconcile`, by `action_id`), on every read of the decision and at startup. Nothing is
retried blindly. Its entries name the version and cap the execution row recorded in T1, never the
ones active when it runs. What it settles is a record of what already happened, like a T2 or T3
commit, so each action it settles commits at once, before a read goes on: no recheck of the read's
session takes it back. The adapter is asked even for an action that releases private data whose
session no longer stands for its person, so that what it did is recorded as it happened, and
nothing it answers is delivered (`_refused_in_recovery`).

A connected (MCP) tool is listed again in every re-check, before the server is asked anything
else, and its pin is checked last, under its `tools` row's lock: a changed or delisted definition
refuses the call ("rules changed") and is recorded, the owner alerted, in the refusal's own
transaction; a server that can't list refuses it with the visitor line `tool_unavailable`. The
re-check takes the `tools` row and then the ledger head, the order `activation.confirm` takes them
in after the active version, and it never takes the active version itself. One exception: on the
approved path, the owner's answer holds the decision row across the re-list, and may already hold
the ledger head when reading the decision recomputed a held money decision's answers
(`decide.refresh_answers`). Against a concurrent confirm that changes the same tool, Postgres may
then end one of the two transactions; either way it fails closed, with nothing run.

Claude sees an execution only through its `model_view`: kept to the adapter's `model_view_keys`,
and emptied when a fact the session can't read was dropped or a value carries a document canary,
which the `execute` entry records (`violation: "canary"`). A result an adapter declared not to
release private data mustn't carry is withheld whole, never failed, since the adapter may already
have acted outside the kernel: the action is executed with nothing in its result, the fact rows the
result names are narrowed to the owner, and the entry records both (`violation:
"undeclared_private_data"`, `narrowed`). This one check runs wherever a result is stored: an
allow, an approved hold and a reconciled orphan.
"""

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal, NamedTuple

import desk_kernel
from fastapi import APIRouter, Request
from pydantic import ValidationError
from sqlalchemy import and_, or_, select

from desk.contracts import ExecResult, Fact, InboxNotice, LedgerEvent, NormalizedAction, Principal
from desk.db.models import Action as ActionRow
from desk.db.models import Approval, Business, Desk, Execution, Person, Tool
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import ExecuteRequest
from desk.kernel_service import (activation, adapters, auth, decide, labels, ledger, mandates, mcp_client, mcp_pins,
                                 repo)
from desk.kernel_service.adapters.base import (Adapter, AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown,
                                               ExecCtx, Normalized, NormalizeCtx)
from desk.kernel_service.adapters.web_search import SearchFailure, record_usage
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.decisions import Reviewed
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, KernelRuntime, kernel_transaction
from desk.kernel_service.sessions import principal_for

log = logging.getLogger(__name__)

ORPHAN_AFTER = timedelta(seconds=30)      # an intent younger than this may still be running
EXECUTE_ROUTE = "POST /execute"
ExecPath = Literal["allow", "approved"]   # an allow through /execute, an approved hold inside the answer
UNAVAILABLE = "unavailable"               # the re-check's code for a connected tool's server that couldn't list
PIN = "pin"                               # its code for a connected tool not listed at its pin


def visitor_template(check: str | None) -> str | None:
    """The status line a `refused_at_execution` takes for the re-check part that failed, when it
    isn't the state's own ("rules changed"): `tool_unavailable` for a server that couldn't list."""
    return "tool_unavailable" if check == UNAVAILABLE else None


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

class Checked(NamedTuple):
    """The rules version a re-check ran against, and its money cap: what the `execute` entries of
    the execution it let through record ("Money cap")."""

    policy_version: int
    auto_money_cap_cents: int


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
    checked: Checked | None = None       # the version and cap step 6 ran against, once it has
    prepare_check: str = "prepare"
    notices: list[InboxNotice] = field(default_factory=list)   # owner alerts the re-check wrote (a drift)

    def xctx(self, ctx: KernelCtx, *, reconciling: bool = False) -> ExecCtx:
        """The adapter's context, with the version step 6 passed under: None before it runs, and when
        `reconciling`, since reconciliation runs no re-check (`checked` then holds the version T1's
        re-check ran under, which its entries name, and no adapter may take for a re-check of its own)."""
        version = self.checked.policy_version if self.checked is not None and not reconciling else None
        return ExecCtx(ctx=ctx, desk_row=self.desk_row, session_row=self.session_row, principal=self.principal,
                       recheck_version=version)


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
                   adapter=await adapters.resolve(ctx, decision.desk_id, action_row.tool),
                   principal=principal_for(session_row, desk_id=decision.desk_id))


async def _find_decision(ctx: KernelCtx, decision_id: str) -> DecisionRow | None:
    if not repo.storable(decision_id):                # text Postgres can't hold names no decision
        return None
    return (await ctx.db.scalars(ctx.repo.scoped(
        select(DecisionRow).where(DecisionRow.decision_id == decision_id)))).one_or_none()


async def _lock_decision(ctx: KernelCtx, decision_id: str) -> DecisionRow:
    return await _one(ctx, select(DecisionRow).where(DecisionRow.decision_id == decision_id).with_for_update()
                      .execution_options(populate_existing=True))


async def _share_session(ctx: KernelCtx, session_id: str, *, exclusive: bool = False) -> SessionRow:
    """The session row, held `FOR SHARE` until the transaction ends: a mode change (which takes it
    `FOR UPDATE`) waits, so the mode and generation read here hold for the whole transaction. With
    `exclusive`, `FOR UPDATE` instead, which a mode change waits for too."""
    return await _one(ctx, select(SessionRow).where(SessionRow.session_id == session_id)
                      .with_for_update(read=not exclusive).execution_options(populate_existing=True))


async def _hold_session(ctx: KernelCtx, session_id: str, action_id: str) -> SessionRow:
    """The session row T2 holds, on either path, taken first, before the decision and the intent
    row (`repo.py`), and read afresh. It is held `FOR SHARE` (the fence): a take-over, a pause or a
    Desk's deletion, each of which writes the row under `FOR UPDATE` (a deletion closes it),
    either commits before T2 takes it, and T2 sees what it wrote, or waits until T2 commits. An
    adapter that writes the session's own rows
    (`locks_session`: a verification start, a call-back request, which keeps one open handoff
    per session, a purpose payment, which keeps one open link per tool in a session, or a booking,
    which closes the session's card handoffs) holds it `FOR UPDATE` instead, so two such executions
    in one session take turns: each holding it shared and then asking for it outright, they would
    wait on each other until Postgres ended one. Never None, since a missing row raises (and the
    action ends `unknown`, never fenced). The action's tool is read without a lock, which waits
    for nothing."""
    tool = await _one(ctx, select(ActionRow.tool).where(ActionRow.action_id == action_id))
    desk_id = await _one(ctx, select(ActionRow.desk_id).where(ActionRow.action_id == action_id))
    return await _share_session(ctx, session_id,
                                exclusive=getattr(await adapters.resolve(ctx, desk_id, tool), "locks_session", False))


def _checked(execution: Execution) -> Checked | None:
    """The version and money cap the execution's T1 re-check ran under, as its row records them;
    None for a row written before they were recorded."""
    if execution.policy_version is None or execution.auto_money_cap_cents is None:
        return None
    return Checked(policy_version=execution.policy_version, auto_money_cap_cents=execution.auto_money_cap_cents)


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
    """An `execute` entry's summary; once step 6 has run, with the version and money cap it ran
    against, so each entry can be judged by its own version."""
    checked = target.checked._asdict() if target.checked is not None else {}
    return {"decision_id": target.decision.decision_id, "action_id": target.action.action_id, "state": state,
            **checked, **extra}


def _no_result(action_id: str, state: Literal["failed", "unknown"]) -> ExecResult:
    return ExecResult(action_id=action_id, state=state, facts=[], model_view={})


def _withheld(action_id: str) -> ExecResult:
    """The result of an action that ran but whose result reaches no one: no facts, an empty
    `model_view` and no inbox notices."""
    return ExecResult(action_id=action_id, state="succeeded", facts=[], model_view={}, inbox=[])


# ---- Step 6: the re-check -------------------------------------------------------------------------

async def recheck(ctx: KernelCtx, decision_row: DecisionRow, *, path: ExecPath) -> bool:
    """Step 6 of "Evaluation" for a decision about to run, against the current rows: on `allow`
    the conditions `/decide` had (mode `ai` at the decision's generation, the tool given to the
    session) and the `auto` verdict with the stored review; on `approved` the approvable verdict
    and the approval's binding. Either way the Desk must stand, the tool must be registered and
    enabled, and the adapter must normalize the stored args to exactly the stored action. The rules
    are the active version's, evaluated at its money cap, so a re-check after a confirm uses the
    new version's cap, and an agent's charge is bounded by what its mandate has left now."""
    return isinstance(await recheck_under(ctx, decision_row, path=path), Checked)


async def recheck_under(ctx: KernelCtx, decision_row: DecisionRow, *, path: ExecPath) -> Checked | str:
    """`recheck`, answering with the version and money cap it passed under, or, when it fails, with
    the part that failed (`desk`, `tool`, `session`, `args`, `profile`, `policy`, `conditions` or `binding`, and
    `UNAVAILABLE` or `PIN` for a connected tool), the `check` its refusal is ledgered with, as an
    allow's is. A pass that named no version fails as `policy`, so the refusal never ledgers a null
    check. `conditions` means the decision's own policy version refused after inputs it reads
    changed (such as a mandate's expiry or remaining allowance); `policy` means a different active
    version refused, or no usable active version exists."""
    outcome = await recheck_outcome(ctx, decision_row, path=path)
    return outcome.checked if outcome.checked is not None else outcome.failed


@dataclass(frozen=True)
class Rechecked:
    """A re-check's outcome: exactly one of the version and money cap it passed under (`checked`)
    and the part that failed (`failed`, a ledgered code as `recheck_under` names it), and the owner
    alerts it wrote, which go in the transaction the caller commits."""

    checked: Checked | None
    failed: str | None
    notices: tuple[InboxNotice, ...] = ()


async def recheck_outcome(ctx: KernelCtx, decision_row: DecisionRow, *, path: ExecPath) -> Rechecked:
    """`recheck`, with the part that failed and the alerts it wrote. A pass that named no version
    fails as `policy`."""
    target = await _target(ctx, decision_row)
    failed = await _recheck(ctx, target, path)
    if failed is None and target.checked is None:
        failed = "policy"
    if failed is not None:
        return Rechecked(checked=None, failed=failed, notices=tuple(target.notices))
    return Rechecked(checked=target.checked, failed=None, notices=tuple(target.notices))


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
    # (1b) a connected tool's definitions, listed again before the server is asked anything else
    listed: dict[str, dict[str, Any]] | None = None
    if mcp_pins.is_mcp(action.tool):
        try:
            listed = await mcp_client.client(ctx.settings).list_tools_raw(action.copy_id)
        except mcp_client.McpUnavailable:
            return UNAVAILABLE
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
    # (3) the current rules at their money cap, for the principal as it stands now
    version_row = await activation.active_version(ctx, desk_row.desk_id)
    if version_row is None or ctx.policies.versions.use(version_row):
        return "policy"
    cap = activation.version_cap(version_row)
    target.checked = Checked(policy_version=version_row.version, auto_money_cap_cents=cap)
    remaining = await mandates.session_remaining(ctx, target.session_row, desk_row.desk_id)   # the spend left now
    request = decide.cedar_request(target.principal, action, tz=target.business.timezone, now=ctx.clock.now(),
                                   auto_money_cap_cents=cap, mandate_remaining_cents=remaining)
    if path == "allow":
        stored_review = Reviewed(review=decision.review, usage=None)

        async def review_source(pending: object) -> Reviewed:
            return stored_review                           # the review the allow was decided with, never a new call

        if (await decide.evaluate(ctx, version_row, request, review_source=review_source)).outcome != "allow":
            return "conditions" if version_row.version == decision.policy_version else "policy"
    else:
        key = activation.version_key(version_row.desk_id, version_row.version) + ":approvable"
        verdict = json.loads(ctx.policies.engine.decide(key, json.dumps(request), "final"))
        if verdict["errors"] or verdict["outcome"] != "hold":
            return "conditions" if version_row.version == decision.policy_version else "policy"
        approval = (await ctx.db.scalars(ctx.repo.scoped(
            select(Approval).where(Approval.decision_id == decision.decision_id)))).one_or_none()
        if approval is None or not approval.nonce or approval.binding_sha256 != binding_sha256(
                copy_id=action.copy_id, desk_id=action.desk_id, session_id=action.session_id,
                action_id=action.action_id, args_sha256=args_sha256, profile_sha256=tool_row.profile_sha256,
                nonce=approval.nonce):
            return "binding"
    # (4) a connected tool listed at its pin: checked last, under its row's lock (`check_pin`), which
    # records a drift and alerts the owner in this transaction, so they commit with the refusal
    if listed is not None:
        check = await mcp_pins.check_pin(ctx, desk_row.desk_id, action.tool, listed=listed)
        if check.notice is not None:
            target.notices.append(check.notice)
        if (check.state != "ok" or tool_row.status != "enabled" or check.sha256 != tool_row.definition_sha256
                or tool_row.profile_sha256 != action.profile_sha256):
            return PIN
    return None


# ---- T1: the intent --------------------------------------------------------------------------------

async def prepare_intent(ctx: KernelCtx, decision_row: DecisionRow, *, checked: Checked) -> bool:
    """The adapter's `prepare`, then the intent row, in the caller's transaction, which commits them
    together. False, with nothing written, when `prepare` refuses. Either path that runs an action
    comes through here, so a tool whose receipt can't be written fails first (`_receipt_ready`).
    `checked`, required, is the version and money cap the re-check passed under (`recheck_under`),
    which the intent row records for every entry after it, reconciliation's included."""
    target = await _target(ctx, decision_row)
    target.checked = checked
    return await _prepare_intent(ctx, target)


def _receipt_ready(target: _Target) -> None:
    """The status line the decision will end on once its action has run, made before anything is
    written. A tool with no executed line ("Receipts") is 500 `internal`, ledgered on the decision,
    with no intent row and no side effect, never the generic line and never an error after the
    side effect: every language has a line for the same tools, so one that has a line now still
    has one when the session's language has changed by the end. The refusal's `persist` only
    appends, without locking the decision first: it takes no other lock, so it never holds the
    ledger head while it waits for a row."""
    try:
        decide.status_line("executed", tool=target.action.tool, session=target.session_row,
                           owner=target.business.owner_display_name,
                           business=target.adapter.profile.business if target.adapter is not None else None)
    except KeyError:
        decision = target.decision
        copy_id, desk_id, session_id = decision.copy_id, decision.desk_id, decision.session_id
        summary = {"decision_id": decision.decision_id, "action_id": target.action.action_id,
                   "refused": "no_receipt_line"}

        async def persist(ctx: KernelCtx) -> None:
            ctx.bind(copy_id)                            # the request's transaction has rolled back
            await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
                kind="execute", origin="kernel", session_id=session_id, ref_id=summary["decision_id"],
                summary=summary))

        raise KernelFailure(500, "internal", "no_receipt_line", persist=persist) from None


async def _prepare_intent(ctx: KernelCtx, target: _Target) -> bool:
    _receipt_ready(target)
    prepare = getattr(target.adapter, "prepare", None)
    if prepare is not None:
        try:
            async with ctx.db.begin_nested():           # a refusal takes back what prepare wrote
                await prepare(target.xctx(ctx), target.action)
        except AdapterRefusal as refused:
            # A fixed search-budget code can be recorded as the terminal check; all other
            # prepare refusals keep the existing generic check and never expose adapter text.
            if refused.code == "search_limit":
                target.prepare_check = "search_limit"
                await _note(ctx, target.decision, _summary(target, "prepare_refused", reason="search_limit"))
            return False
    checked = target.checked
    ctx.db.add(Execution(action_id=target.action.action_id, copy_id=target.action.copy_id,
                         decision_id=target.decision.decision_id, state="intent", started_at=ctx.clock.now(),
                         policy_version=checked.policy_version if checked is not None else None,
                         auto_money_cap_cents=checked.auto_money_cap_cents if checked is not None else None))
    await ctx.db.flush()
    return True


async def _refused_at_execution(ctx: KernelCtx, target: _Target, check: str) -> KernelFailure:
    """The decision becomes `refused_at_execution` ("rules changed", or `tool_unavailable` for a
    connected tool's server that couldn't list), committed with whatever the re-check recorded (a
    drift and its alert); the answer is 409."""
    await decide.set_state(ctx, target.decision, "refused_at_execution", kind="execute",
                           status=visitor_template(check),
                           summary=_summary(target, "refused_at_execution", reason="rules_changed", check=check))
    await ctx.db.commit()
    return KernelFailure(409, "conflict", f"refused_at_execution:{check}")


async def _not_runnable(ctx: KernelCtx, row: DecisionRow, refused: str) -> KernelFailure:
    """A decision in no state to run (409), ledgered, with what reading it settled committed. A
    reconciliation in the read may have committed, so the owner could close the session since its
    check: a closed session is answered as closed first (`ctx.recheck`), never with the state."""
    await ctx.recheck()
    await _note(ctx, row, {"decision_id": row.decision_id, "refused": refused})
    await ctx.db.commit()
    return KernelFailure(409, "conflict", f"not_runnable:{refused}")


async def _repeat(ctx: KernelCtx, row: DecisionRow, execution: Execution) -> ExecResult:
    """A decision that already ran: its stored result, ledgered as a repeat naming the version and
    money cap the execution was checked under (`_checked`), when its row records them; 409 while it
    runs or is unknown."""
    if execution.state not in ("succeeded", "failed") or execution.result is None:
        raise await _not_runnable(ctx, row, execution.state)
    checked = _checked(execution)
    await _note(ctx, row, {"decision_id": row.decision_id, "action_id": execution.action_id, "repeat": True,
                           **(checked._asdict() if checked is not None else {})})
    await ctx.commit()                                   # the stored result, once its session still stands
    return execution.result


def _stale(named: Named, decision_id: str) -> AuthError:
    """409 `stale_generation`, ledgered as `auth`; the allow, if it never began, expires with it."""
    error = AuthError(409, "stale_generation", "stale_generation", route=EXECUTE_ROUTE, named=named)
    record_refusal = error.persist

    async def persist(ctx: KernelCtx) -> None:
        ctx.bind(named.copy_id)
        row = await _lock_decision(ctx, decision_id)     # the decision row before the ledger head
        await record_refusal(ctx)
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
    session = await _share_session(ctx, found.session_id)          # the session row before the decision row
    if session.closed_at is not None:
        # closed since its token was proved (`auth.still_open`): refused as at authentication, nothing run
        raise AuthError(409, "closed", "closed", route=EXECUTE_ROUTE, named=named)
    row = await _lock_decision(ctx, found.decision_id)
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
        raise await _refused_at_execution(ctx, target, target.prepare_check)
    await ctx.db.commit()                                # T1: the intent row, before any side effect
    return await _run(ctx, row.decision_id, target.action.action_id, row.session_id, path="allow",
                      checked=target.checked)


async def run_approved(ctx: KernelCtx, decision_row: DecisionRow, *, checked: Checked | None = None) -> ExecResult:
    """T2 and T3 for an approved hold whose intent row the answer has committed, as the held
    session's principal; mode, generation and whether the session is closed aren't checked (step
    6), but its Desk must still stand (`_refused_in_t2`). `checked` is the version and money cap
    the answer's re-check passed under (`recheck_under`), which its entries record; given none,
    they record the ones the intent row did (`_checked`)."""
    return await _run(ctx, decision_row.decision_id, decision_row.action_id, decision_row.session_id, path="approved",
                      checked=checked)


# ---- T2 and T3: the side effect and its outcome -----------------------------------------------------

async def _run(ctx: KernelCtx, decision_id: str, action_id: str, session_id: str, *, path: ExecPath,
               checked: Checked | None) -> ExecResult:
    await _after_intent()
    try:
        outcome = await _side_effect(ctx, decision_id, action_id, session_id, path, checked)
    except AdapterFailure as failure:
        await ctx.db.rollback()
        return await _settle_failed(ctx, decision_id, action_id, failure, checked)
    except Exception as exc:
        # an outcome nobody knows, a failed commit included: never retried, left to reconciliation
        repo.log_error(log, exc, "execution_unknown action_id=%s", action_id)
        await ctx.db.rollback()
        return await _settle_unknown(ctx, decision_id, action_id, checked)
    if isinstance(outcome, KernelFailure):
        raise outcome
    return outcome


async def _side_effect(ctx: KernelCtx, decision_id: str, action_id: str, session_id: str, path: ExecPath,
                       checked: Checked | None) -> ExecResult | KernelFailure:
    """T2: holding the decision's session row, `session_id`, taken first (`_hold_session`), then
    under the decision's and the intent row's locks, the checks that need the rows as they are now
    (`_gone`, then an allow's fence), then the adapter's `execute`, then `succeeded` and
    `executed`, committed. The decision is locked before anything here takes the ledger head (an
    adapter's own entry, such as a verification start's `verify`), as an answer or a read that
    locks it and then ledgers does. A failure answer comes back as a `KernelFailure`, already
    committed, for `_run` to raise. Its entry names `checked`, or, given none, the version and cap
    the intent row recorded, as T3's do."""
    session = await _hold_session(ctx, session_id, action_id)
    decision = await _lock_decision(ctx, decision_id)
    execution = await _execution(ctx, action_id, lock=True)
    if execution is None or execution.state != "intent":
        # reconciliation settled it first
        if execution is not None and execution.state in ("succeeded", "failed") and execution.result is not None:
            return execution.result
        return KernelFailure(409, "conflict", "not_an_intent")
    target = await _target(ctx, decision)
    target.checked = checked if checked is not None else _checked(execution)
    if session is None:                 # never: the session row is always held; `_run` ends it unknown
        raise RuntimeError(f"{path}_without_session")
    if (gone := _gone(target, session, path)) is not None:
        return await _refused_in_t2(ctx, target, execution, gone, path)
    if path == "approved" and releases_private_data(target.action.tool, target.adapter):
        # step 6 runs an approved hold for a closed session, but never one that releases private data
        if (ended := await session_ended(ctx, target.decision)) is not None:
            return await _refused_in_t2(ctx, target, execution, ended, path, reason="session_ended")
    if path == "allow":
        # the request's own session check, before the adapter acts: the commit below records what
        # it did whatever happens to the session after, so it runs no recheck of its own
        if not await auth.session_stands(ctx, _named(target), session.person_id):
            return await _closed_in_t2(ctx, target, execution)
        if session.generation != target.decision.generation:
            return await _fenced(ctx, target, execution, "stale_generation")
        if session.mode != "ai":
            return await _fenced(ctx, target, execution, f"mode_{session.mode}")
    from desk.contracts import is_business_tool
    if is_business_tool(target.action.tool):
        # T1 committed before the owner could replace this configuration. Re-read the row and
        # hold it through the side effect, so a replacement either wins first or waits for T2.
        current = (await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
            Tool.desk_id == target.action.desk_id, Tool.tool == target.action.tool)
            .with_for_update(read=True).execution_options(populate_existing=True)))).one_or_none()
        if (current is None or current.status != "enabled"
                or current.profile_sha256 != target.action.profile_sha256):
            return await _refused_in_t2(ctx, target, execution, "profile", path)
        target.adapter = await adapters.resolve(ctx, target.action.desk_id, target.action.tool)
        if target.adapter is None:
            return await _refused_in_t2(ctx, target, execution, "profile", path)
    adapter = target.adapter
    if adapter is None:
        raise AdapterFailure("no_adapter")
    args = adapter.Args.model_validate(target.action_row.args_json)
    result = await adapter.execute(target.xctx(ctx), target.action, args)
    visible, flagged = await _visible(ctx, target, result)
    await _finish(ctx, target, execution, visible, "executed", _summary(target, "executed", **flagged))
    await ctx.db.commit()                                # what ran, recorded as T2 decided
    return visible


def _gone(target: _Target, session: SessionRow, path: ExecPath) -> str | None:
    """What T2 finds gone since T1, read afresh under the session row it holds: `desk` when the
    Desk was deleted (on either path, as step 6 needs), `closed` when an allow's session was closed
    (an approved hold still runs for a closed session, as step 6 lets it, unless it releases private
    data: `session_ended`); None when neither. A
    Desk's deletion closes its open visitor and agent sessions under their rows' locks, so for such
    a session it either committed before T2 took the row, and T2 sees it here, or waits until T2
    commits. An owner's session, or one closed already, isn't among those: for them the Desk's row
    is read afresh, without that guarantee."""
    if target.desk_row.deleted_at is not None:
        return "desk"
    if path == "allow" and session.closed_at is not None:
        return "closed"
    return None


async def _refused_in_t2(ctx: KernelCtx, target: _Target, execution: Execution, check: str,
                         path: ExecPath, *, reason: str = "rules_changed",
                         status: str | None = None) -> ExecResult | KernelFailure:
    """A Desk deleted, an allow's session closed, or an approved release of private data whose
    session no longer stands (`session_ended`), after T1 and before the side effect: nothing runs.
    Its intent is `failed` (after `on_failed`), the decision `refused_at_execution` (`reason`, "rules
    changed" unless given), its `execute` entry naming the `check` that failed, committed. The
    visitor sees the state's own status line, never why their session ended. A `status`, when given,
    must be a decision's status line (`decide.status_line`): any other raises ValueError, which `_run`
    settles as `unknown`, with nothing delivered. An allow answers 409 `conflict`, as a refusal in T1
    does; an approved hold answers with its failed result, so the owner's answer reads the decision
    as refused."""
    await _undo(ctx, target)
    result = _no_result(target.action.action_id, "failed")
    await _finish(ctx, target, execution, result, "refused_at_execution",
                  _summary(target, "refused_at_execution", reason=reason, check=check), status=status)
    await ctx.db.commit()
    if path == "allow":
        return KernelFailure(409, "conflict", f"refused_at_execution:{check}")
    return result


async def _closed_in_t2(ctx: KernelCtx, target: _Target, execution: Execution) -> KernelFailure:
    """An allow whose session no longer stands, read afresh under the row T2 holds and before the
    side effect (`auth.session_stands`: its person off the record, say; a closed session or a deleted
    Desk is `_gone`'s): nothing runs. It is settled as `_refused_in_t2` settles a closed session,
    committed, and the answer is 409 `closed`, ledgered `auth` as at authentication."""
    await _refused_in_t2(ctx, target, execution, "closed", "allow")
    return AuthError(409, "closed", "closed", route=EXECUTE_ROUTE, named=_named(target))


def _named(target: _Target) -> Named:
    """The decision's session, on its Desk, which a refusal is ledgered on."""
    decision = target.decision
    return Named(copy_id=decision.copy_id, desk_id=decision.desk_id, session_id=decision.session_id)


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


async def _undo(ctx: KernelCtx, target: _Target, *, reconciling: bool = False) -> None:
    """The adapter's optional `on_failed`, undoing what `prepare` reserved."""
    on_failed = getattr(target.adapter, "on_failed", None)
    if on_failed is not None:
        await on_failed(target.xctx(ctx, reconciling=reconciling), target.action)


async def _finish(ctx: KernelCtx, target: _Target, execution: Execution, result: ExecResult, decision_state: str,
                  summary: dict[str, Any], *, status: str | None = None) -> None:
    """The execution's final row and the decision's state (its status line the template `status`
    when given, which must be a decision's status line: `decide.status_line` raises ValueError for
    any other, which `_run` settles as `unknown` on T2's path, with nothing delivered), ledgered and
    signed, in the caller's transaction, which holds the decision row (`target.decision`) and the
    execution row."""
    execution.state = {"executed": "succeeded", "failed": "failed", "expired": "failed",
                       "refused_at_execution": "failed"}[decision_state]
    execution.result = result
    execution.finished_at = ctx.clock.now()
    await decide.set_state(ctx, target.decision, decision_state, kind="execute", summary=summary, status=status)


async def _settle_failed(ctx: KernelCtx, decision_id: str, action_id: str, failure: AdapterFailure,
                         checked: Checked | None = None) -> ExecResult:
    """T3 after `AdapterFailure`, under the decision's and the execution's locks: `on_failed`,
    then `failed`. If `on_failed` itself fails, the reservation may still stand, so the action is
    `unknown` instead."""
    decision = await _lock_decision(ctx, decision_id)
    execution = await _execution(ctx, action_id, lock=True)
    if execution is None or execution.state != "intent":
        return await _settled_elsewhere(execution, action_id)
    target = await _target(ctx, decision)
    target.checked = checked if checked is not None else _checked(execution)
    try:
        async with ctx.db.begin_nested():
            await _undo(ctx, target)
    except Exception as exc:
        repo.log_error(log, exc, "on_failed_failed action_id=%s", action_id)
        await ctx.db.rollback()
        return await _settle_unknown(ctx, decision_id, action_id, checked)
    if isinstance(failure, SearchFailure):
        await record_usage(ctx, target.action, failure.usage)
    code = failure.args[0] if failure.args and isinstance(failure.args[0], str) else "adapter_failure"
    result = _no_result(action_id, "failed")
    await _finish(ctx, target, execution, result, "failed", _summary(target, "failed", reason=ledger.safe_ref(code)))
    await ctx.db.commit()
    return result


async def _settle_unknown(ctx: KernelCtx, decision_id: str, action_id: str,
                          checked: Checked | None = None) -> ExecResult:
    """T3 after any other exception, under the decision's and the execution's locks: `unknown`,
    with `prepare`'s reservation kept."""
    decision = await _lock_decision(ctx, decision_id)
    execution = await _execution(ctx, action_id, lock=True)
    if execution is None or execution.state != "intent":
        return await _settled_elsewhere(execution, action_id)
    target = await _target(ctx, decision)
    target.checked = checked if checked is not None else _checked(execution)
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

async def _visible(ctx: KernelCtx, target: _Target, result: AdapterResult) -> tuple[ExecResult, dict[str, Any]]:
    """The adapter's result as the session may see it, and what its `execute` entry adds: the facts
    its readers can read, and a `model_view` kept to the adapter's `model_view_keys`, or `{}` when a
    fact was dropped or the kept view holds one of the copy's document canaries, even split by
    spaces, in another case or width, accented or in lookalike letters (`labels.find_canaries_in`);
    a canary adds `{violation: "canary"}` to the entry. The execution's state is the same either
    way. Its `inbox` holds no notice addressed to the owner, whose alerts are read only from the
    Demo inbox: one an adapter returns is dropped and logged by its kind alone.

    An adapter declared not to release private data that returns some anyway
    (`undeclared_private_data`) is withheld, never failed: what it did stands, since it may have
    acted outside the kernel (a charge made must never read as not made), but nothing it returned
    reaches the session (`_withheld`), and its entry adds `{violation: "undeclared_private_data"}`.
    It is logged by its tool and action alone, never the data. The execution still `succeeded`, so
    no `on_failed` runs, and the adapter's own writes stay, except that every fact row the refused
    result names is narrowed to the owner in the caller's transaction (`_narrow_to_owner`), since a
    misdeclared adapter's labels can't be trusted for the session's later reads; the entry adds how
    many (`narrowed`). Only the facts it returns are read, so a row it writes without returning it
    is left as written: the guard holds reviewed adapter code to its word, it is no sandbox for it."""
    if undeclared_private_data(target, result):
        log.error("adapter_undeclared_private_data tool=%s action_id=%s", target.action.tool,
                  target.action.action_id)
        narrowed = await _narrow_to_owner(ctx, target.action.desk_id, result.facts)
        return _withheld(target.action.action_id), {"violation": "undeclared_private_data", "narrowed": narrowed}
    readers = labels.session_readers(target.session_row)
    facts = [fact for fact in result.facts if labels.can_read(fact.label, readers)]
    keys = target.adapter.model_view_keys if target.adapter is not None else frozenset()
    view = {key: value for key, value in result.model_view.items() if key in keys}
    flagged = {"violation": "canary"} if labels.find_canaries_in(view, await labels.copy_canaries(ctx)) else {}
    if len(facts) < len(result.facts) or flagged:
        view = {}
    inbox = []
    for notice in result.inbox:
        if notice.to == "owner":
            log.warning("inbox_notice_dropped to=owner tool=%s", target.action.tool)
        else:
            inbox.append(notice)
    return ExecResult(action_id=target.action.action_id, state="succeeded", facts=facts, model_view=view,
                      inbox=inbox), flagged


async def _narrow_to_owner(ctx: KernelCtx, desk_id: str, facts: list[Fact]) -> int:
    """Every row of the Desk's `facts` that one of `facts` names, readable by the owner alone
    (`readers ["owner"]`, a fact row's default; its record owner kept), in the caller's
    transaction; returns how many rows that is. It runs after the adapter's hook and before the
    step ledgers its record (`repo.py`, step 11), and rows the hook itself wrote wait for nothing."""
    fact_ids = sorted({fact.fact_id for fact in facts if repo.storable(fact.fact_id)})
    if not fact_ids:
        return 0
    rows = list(await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.fact_id.in_(fact_ids)).order_by(FactRow.fact_id).with_for_update())))
    for row in rows:
        row.readers = list(labels.OWNER_ONLY)
    await ctx.db.flush()
    return len(rows)


def releases_private_data(tool: str, resolved=None) -> bool:
    """Whether the tool's adapter declares that its result gives the session data it reads only as
    its verified person (`releases_private_data`); an unknown tool counts as one that does."""
    adapter = resolved if resolved is not None else adapters.ADAPTERS.get(tool)
    return True if adapter is None else adapter.releases_private_data


async def session_ended(ctx: KernelCtx, decision: DecisionRow) -> str | None:
    """Why the decision's session no longer stands for the person an action that releases private
    data would go to (`auth.session_stands`, read afresh): `person_removed` when its verified person
    is off the record, `contact_changed` when it was closed with its person still on record (only a
    new contact closes a session so), `session_closed` for any other close; None while it stands, or
    when its Desk is deleted, which the Desk's own checks refuse first."""
    from desk.contracts import is_business_tool
    if is_business_tool(decision.tool):
        # approvals.py still calls the conservative classifier without a resolved adapter.
        # Keep this compatibility check until that caller can be updated in its own lane.
        adapter = await adapters.resolve(ctx, decision.desk_id, decision.tool)
        if adapter is not None and not adapter.releases_private_data:
            return None
    named = Named(copy_id=decision.copy_id, desk_id=decision.desk_id, session_id=decision.session_id)
    if await auth.session_stands(ctx, named, None):
        return None
    deleted = (await ctx.db.execute(ctx.repo.scoped(select(Desk.deleted_at).where(
        Desk.desk_id == decision.desk_id)))).scalar_one()
    if deleted is not None:
        return None
    session = (await ctx.db.execute(ctx.repo.scoped(select(SessionRow.closed_at, SessionRow.person_id).where(
        SessionRow.session_id == decision.session_id)))).one()
    if session.person_id is not None:
        person = (await ctx.db.execute(ctx.repo.scoped(select(Person.removed_at).where(
            Person.person_id == session.person_id)))).one_or_none()
        if person is None or person.removed_at is not None:
            return "person_removed"
        if session.closed_at is not None:
            return "contact_changed"
    return "session_closed"


def undeclared_private_data(target: _Target, result: AdapterResult) -> bool:
    """Whether an adapter declared not to release private data returned some, for a visitor's or
    agent's session: a document fact (a document's title or link), or a fact naming a person as a
    reader or its record owner, unless that person is the session's own verified person and the
    session reads the fact as itself (`labels.new_fact_label`: the label of a quote or a booking
    made in a verified session). Another person's reader or ownership, or a fact the session reads
    only as its person, is never the session's own. An owner session's own setup results aren't a
    person's data."""
    adapter, session = target.adapter, target.session_row
    if adapter is None or adapter.releases_private_data or session.kind == "owner":
        return False
    own = labels.new_fact_label(session).record_owner              # the session's verified person, if any
    as_itself = {"public", f"session:{session.session_id}"}

    def private(fact: Fact) -> bool:
        people = {reader for reader in fact.label.readers if reader.startswith("person:")}
        if not people and fact.label.record_owner is None:
            return False
        return (own is None or people - {f"person:{own}"} != set() or fact.label.record_owner not in (None, own)
                or not labels.can_read(fact.label, as_itself))

    return any(fact.kind == "document" or private(fact) for fact in result.facts)

# ---- Reconciliation ---------------------------------------------------------------------------------

def _orphaned(cutoff: datetime) -> Any:
    """An execution nobody is settling: an intent started before `cutoff`, or an `unknown`."""
    return or_(and_(Execution.state == "intent", Execution.started_at < cutoff), Execution.state == "unknown")


async def refresh_decision(ctx: KernelCtx, decision_row: DecisionRow) -> DecisionRow:
    """A decision as a read settles it: its orphaned execution reconciled, then lazy expiry, then a
    held discount quote its session's later booking made stale cancelled
    (`decide.supersede_if_booked`), then a held money decision's answers recomputed at the active
    version's money cap (`decide.refresh_answers`; "Decision lifecycle"), in the caller's
    transaction, except that a reconciliation commits at once (`reconcile_orphans`). That commit
    ends the caller's locks, so the decision is then read again `FOR UPDATE`, as the caller may have
    held it, and the rest goes on in a new transaction under it. Returns the current row."""
    decision_id, action_id = decision_row.decision_id, decision_row.action_id
    if action_id is not None and decision_row.state in ("allowed", "approved", "unknown"):
        if await reconcile_orphans(ctx, at_startup=False, action_id=action_id):
            decision_row = await _one(ctx, select(DecisionRow).where(DecisionRow.decision_id == decision_id)
                                      .with_for_update().execution_options(populate_existing=True))
    return await decide.refresh_answers(
        ctx, await decide.supersede_if_booked(ctx, await decide.expire_if_due(ctx, decision_row)))


async def reconcile_orphans(ctx: KernelCtx, *, at_startup: bool, action_id: str | None = None) -> list[str]:
    """Reconciles the orphaned executions of the copy `ctx` is bound to (`action_id`: that action's
    alone) and returns the actions it settled or moved to `unknown`. Each action it settles commits
    at once with a plain commit, which runs none of the request's rechecks: it records what already
    happened, so a read refused afterwards (its session closed meanwhile, say) leaves it standing,
    and the reconciliation is never redone. On a read (`at_startup` False) a failure is raised and
    the caller's transaction rolls back; at startup it is logged and left for the next read."""
    cutoff = ctx.clock.now() - ORPHAN_AFTER
    stmt = select(Execution.action_id, Execution.decision_id).where(_orphaned(cutoff))
    if action_id is not None:
        stmt = stmt.where(Execution.action_id == action_id)
    candidates = list(await ctx.db.execute(ctx.repo.scoped(stmt.order_by(Execution.started_at,
                                                                          Execution.action_id))))
    reconciled = []
    for candidate, decision_id in candidates:
        try:
            settled = await _reconcile(ctx, candidate, decision_id, cutoff)
            if settled:
                reconciled.append(candidate)
            if settled or at_startup:
                await ctx.db.commit()
        except Exception as exc:
            if not at_startup:
                raise
            repo.log_error(log, exc, "reconcile_failed action_id=%s", candidate)
            await ctx.db.rollback()
    return reconciled


async def _reconcile(ctx: KernelCtx, action_id: str, decision_id: str, cutoff: datetime) -> bool:
    """One orphaned execution, under both rows' locks, the decision's first. The adapter says what
    happened (`_ask_adapter`) before anything is ledgered, so the rows its hooks lock come before
    the ledger head, as in every other step (`repo.py`). Then the record: an intent becomes
    `unknown` (ledgered as orphaned), then the adapter's answer, ledgered as reconciled; an adapter
    that can't say leaves it `unknown`. A failure while recording is raised, and the rollback
    takes back the adapter's `on_failed` with the record. Rows another transaction holds (a
    running execution holds both) are skipped, never waited on; a lock this transaction holds
    already is no wait. Each entry names the version and cap the row recorded in T1 (`_checked`).

    An action that releases private data is recovered into its session only while the session
    still stands for its person, as T2 runs it: the session's row is held `FOR SHARE` first, before
    the decision's (`repo.py`). If the session no longer stands (`auth.session_stands`,
    `session_ended`), the adapter is still asked, under that row, since what it did outside the
    kernel must be recorded as it happened, but nothing it answers reaches the session
    (`_refused_in_recovery`)."""
    action_row = (await ctx.db.execute(ctx.repo.scoped(select(ActionRow.tool, ActionRow.desk_id).where(
        ActionRow.action_id == action_id)))).one_or_none()
    resolved = (await adapters.resolve(ctx, action_row.desk_id, action_row.tool)
                if action_row is not None else None)
    private = action_row is None or releases_private_data(action_row.tool, resolved)
    if private and not await _hold_session_for(ctx, decision_id):
        return False
    decision = (await ctx.db.scalars(ctx.repo.scoped(
        select(DecisionRow).where(DecisionRow.decision_id == decision_id)
        .with_for_update(skip_locked=True).execution_options(populate_existing=True)))).one_or_none()
    if decision is None:
        return False
    execution = (await ctx.db.scalars(ctx.repo.scoped(
        select(Execution).where(Execution.action_id == action_id, _orphaned(cutoff))
        .with_for_update(skip_locked=True).execution_options(populate_existing=True)))).one_or_none()
    if execution is None:
        return False
    target = await _target(ctx, decision)
    target.checked = _checked(execution)
    orphaned = execution.state == "intent"
    ended = None
    if private and not await auth.session_stands(ctx, _named(target), None):
        # `session_ended` names nothing once the Desk is gone, whose deletion closed the session: "desk", as
        # every other refusal names a deleted Desk
        ended = await session_ended(ctx, decision) or ("desk" if target.desk_row.deleted_at is not None
                                                       else "session_closed")
    outcome = await _ask_adapter(ctx, target, action_id, ended=ended)
    if orphaned:
        await _mark_unknown(ctx, target, execution, _no_result(action_id, "unknown"), orphaned=True)
    if outcome is not None:
        result, state, extra = outcome
        await _finish(ctx, target, execution, result, state, _summary(target, state, reconciled=True, **extra))
    return True


async def _hold_session_for(ctx: KernelCtx, decision_id: str) -> bool:
    """The decision's session row, held `FOR SHARE` before the decision's (`repo.py`), so no write
    that closes it commits while a private result is recovered; False when another transaction
    holds it outright (a closing write, a decision, an execution that writes the session), which
    the reconciliation skips rather than waits for, as it does the decision and the execution."""
    session_id = (await ctx.db.execute(ctx.repo.scoped(select(DecisionRow.session_id).where(
        DecisionRow.decision_id == decision_id)))).scalar_one_or_none()
    if session_id is None:
        return False
    return (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(SessionRow.session_id == session_id)
                                                 .with_for_update(read=True, skip_locked=True)
                                                 .execution_options(populate_existing=True)))).one_or_none() is not None


def _refused_in_recovery(action_id: str, ended: str, *, ran: bool) -> tuple[ExecResult, str, dict[str, Any]]:
    """What the recovery of an action that releases private data records once its session no
    longer stands for its person (`ended`, why: the `check`), as `_ask_adapter` answers: the result,
    the decision's state and what its entry adds. Nothing reaches the session either way. It ran
    (`ran`): `executed`, with an empty result (`_withheld`) and the entry adding `{withheld:
    "session_ended", check}`, no `on_failed`, and no fact row narrowed: the adapter declares that
    it releases private data, so its labels stand, and the session they name has ended. It didn't:
    `refused_at_execution`, with the plain reason `session_ended`, the `check` and nothing in its
    result, after `on_failed` has run. The visitor's line is the state's own, never why the session
    ended."""
    if ran:
        return _withheld(action_id), "executed", {"withheld": "session_ended", "check": ended}
    return _no_result(action_id, "failed"), "refused_at_execution", {"reason": "session_ended", "check": ended}


async def _ask_adapter(ctx: KernelCtx, target: _Target, action_id: str, *,
                       ended: str | None = None) -> tuple[ExecResult, str, dict[str, Any]] | None:
    """What the adapter's `reconcile` says happened to an orphan, as its result, the decision's
    state and what its `execute` entry adds, ledgering nothing: a result is `executed`, rebuilt as
    the session may see it (`_visible`, which flags a canary, and withholds a result an adapter
    declared not to release private data mustn't carry, narrowing the fact rows it names to the
    owner, with no `on_failed`); None is `failed`, once `on_failed` has undone what `prepare`
    reserved, so its rows come before the ledger head (`repo.py`). With `ended`, the reason a
    private action's session no longer stands, it is asked just the same and nothing it answers is
    delivered (`_refused_in_recovery`). None when it can't say (no adapter, `AdapterUnknown` or any
    other error, a failing `on_failed` included), with whatever its hooks wrote taken back."""
    if target.adapter is None:
        log.warning("reconcile_no_adapter action_id=%s", action_id)
        return None
    try:
        async with ctx.db.begin_nested():
            result = await target.adapter.reconcile(target.xctx(ctx, reconciling=True), target.action)
            if result is None:
                await _undo(ctx, target, reconciling=True)
            if ended is not None:
                return _refused_in_recovery(action_id, ended, ran=result is not None)
            if result is None:
                return _no_result(action_id, "failed"), "failed", {}
            visible, flagged = await _visible(ctx, target, result)
            return visible, "executed", flagged
    except AdapterUnknown:
        log.info("reconcile_still_unknown action_id=%s", action_id)
    except Exception as exc:                        # still unknown; the next read tries again
        repo.log_error(log, exc, "reconcile_error action_id=%s", action_id)
    return None


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
        except Exception as exc:
            repo.log_error(log, exc, "startup_reconcile_failed copy_id=%s", copy_id)
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
        Approval.approval_id == approval_id)))).one_or_none() if repo.storable(approval_id) else None
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
    if await auth.caller(ctx, request, body.session_id) == "session":
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
