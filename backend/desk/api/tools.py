"""Claude's tools and the way each of its calls reaches the kernel (master plan, "Model-visible tools", "Fail-closed
behavior"; Plan 02a, "Tool results Claude receives").

Claude only proposes. Every tool call but `send_reply` goes to `/decide` with the `tool_use` ID as its call ID,
and runs only on the kernel's allow, through `/execute`; a hold returns at once. The visitor sees each decision
once, as the kernel signed it (`Status`, through `deliver()`), and an execution's Demo inbox notices meant for it (a
code sent), code-free; a decision's own notices are owner alerts and never reach it. `send_reply` goes to
`/check_reply`, and only the kernel's checked blocks reach the visitor, through `deliver()`. A
check is `final` (`CheckReplyRequest.final`) unless it is a first attempt the turn could still rewrite. A blocked
final check shows the checked cards when only the prose failed (with Claude's drafted handoff clause after them,
when it drafted one); with no card to keep, the kernel's call-back offer when the session is offered a call back,
else the handoff clause; the kernel opens the owner's handoff whenever the shown blocks include
that clause, and the API shows the verdict's blocks at once, so what the kernel opens is what the session sees. The
kinds a rewrite fixes are `desk.rewrites.REWRITABLE`, which the kernel reads too.

Failures fail closed ("Fail-closed behavior"): nothing is decided twice (a lost `/decide` answer is found by call
ID, a lost `/execute` answer by polling the decision), an `/execute` answered 409 `conflict` (the kernel has no
result to give yet) is never sent again but answered from the decision as it stands, nothing unchecked is shown,
and each `ToolOutcome` says how the turn goes on: `fenced` (a take-over or a stale generation: stop, silently),
`session_ended` (`error{code: "session"}`), `unavailable` (`error{code: "kernel_unavailable"}`) or `turn_over`
(stop: an agent's turn already answered, or a reply the kernel refused).

`route_call`, `recover_call`, `send_reply` and `hand_off` take the call's own connection and commit each
publication on it at once, so a receipt reaches the visitor while sibling calls still run.

An outcome also names the attempt the checkpoint stopped, when it did (`stopped`, as Safety counts one: a call refused
when decided, or a reply blocked for anything but a paused session), for the turn to leave for triage (Plan 02b,
Task 10).

A draft of Claude's the reply check stopped (`ok: false`) is kept for the owner (Plan 02b): one `stopped_draft` row
holding the draft as it was sent to `/check_reply`, the verdict's `message_id` and its violations
(`store.append_stopped_draft`). A handoff shown in the draft's place is delivered just after it, in the same
transaction. A block Claude may rewrite writes nothing here: its outcome carries the draft (`kept`) for the turn to
keep with the result Claude reads (its call's `tool_result`, or the note on its plain text), so the session's locks
are never held across a later kernel call. Only the owner's transcript shows the row, and the triage job reads only
the ledger entry it names (`ledger_seq`) to place a triage on it: never a visitor's read or stream, a model context, a
reply check, a job's arguments or a log line. Input that never reached the check, the loop's own handoff clause and an
owner's say (whose verdict goes back to the owner) are never kept this way.
"""

import asyncio
import json
import time
from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.deliver import NOT_FINAL, Reply, Status, deliver, run_lock
from desk.api.kernel_client import CredentialView, KernelFailed, KernelUnavailable
from desk.api.prompts import (
    INVALID_REPLY_DIAGNOSTIC, INVALID_REPLY_SHAPES, KERNEL_ONLY_TEMPLATES, REPLY_DIAGNOSTICS,
    REPLY_RULE_IDS, REPLY_TEMPLATES, REWRITE_INSTRUCTION, SEND_REPLY_TOOL, STATUS_LINES,
)
from desk.api.ro import KERNEL_RO
from desk.api.schemas import CheckedDraft, StoppedDraft
from desk.api.sse import append_control, emit_inbox
from desk.api.store import Ids, KeptDraft, append_stopped_draft
from desk.api.triage import Stopped
from desk.contracts import (
    ActorKind,
    Clause,
    Decision,
    ExecResult,
    RenderedBlock,
    ReplyDraft,
    ReplyVerdict,
    ToolCall,
    ToolProfile,
    money_tool,
)
from desk.kernel_api import CheckReplyRequest, DecideRequest, ExecuteRequest, SessionContext
from desk.rewrites import REWRITABLE

# How a change to the session's tools reaches Claude. "append": a `role: "system"` message of `tool_addition` and
# `tool_removal` blocks, appended to the same context. "fresh_context": a new context with the new tools and a
# code-built summary. The day-one live check (tests/api/test_loop_contract_live.py) passed, so it is "append".
TOOL_CHANGE_MODE: Literal["append", "fresh_context"] = "append"


def to_api_name(tool: str) -> str:
    """The name Claude sees (`native.quote` → `native__quote`): API tool names allow only letters, digits, `_`
    and `-`."""
    return tool.replace(".", "__")


def from_api_name(name: str) -> str:
    """The kernel's name for a tool Claude called (`native__quote` → `native.quote`); an unknown name maps to an
    unknown tool, which the kernel refuses."""
    return name.replace("__", ".")


def _entry(profile: ToolProfile) -> dict:
    """A declared tool as Claude sees it: the owner-confirmed description, never the server's."""
    return {"name": to_api_name(profile.tool), "description": profile.description_confirmed,
            "input_schema": profile.input_schema}


def _loaded(context: SessionContext) -> frozenset[str]:
    """The API names of the tools this session may call now."""
    return frozenset(to_api_name(profile.tool) for profile in context.tools if profile.status == "enabled")


def model_tools(context: SessionContext) -> list[dict]:
    """A new model context's tools: every declared tool, sorted by name, deferred unless the session may call it
    now, then `send_reply`. Frozen for the context's life; changes are appended (`tool_delta`). A tool the session
    may call is declared as `tools` gives it (its current definition), even if `tools_declared` left it out."""
    loaded = _loaded(context)
    declared = {profile.tool: profile for profile in context.tools_declared}
    declared.update({profile.tool: profile for profile in context.tools})
    entries = sorted((_entry(profile) for profile in declared.values()), key=lambda entry: entry["name"])
    return [*(entry if entry["name"] in loaded else {**entry, "defer_loading": True} for entry in entries),
            SEND_REPLY_TOOL]


@dataclass(frozen=True)
class FrozenTools:
    """The current model context's tools: its entries as frozen when it opened, and the names Claude may call now
    (those not deferred then, with the context's tool changes since, pending ones included, applied in order)."""

    entries: tuple[dict, ...]
    loaded: frozenset[str]

    @classmethod
    def from_context(cls, entries: Iterable[dict], changes: Iterable[tuple[str, str]]) -> "FrozenTools":
        """From a `context_start` row's tools and the context's `tool_change` rows as (change, tool name)."""
        entries = tuple(entries)
        loaded = {entry["name"] for entry in entries if not entry.get("defer_loading")}
        for change, name in changes:
            if change == "tool_addition":
                loaded.add(name)
            elif change == "tool_removal":
                loaded.discard(name)
            else:
                raise ValueError(f"{change!r} is not a tool change")
        return cls(entries=entries, loaded=frozenset(loaded))


@dataclass(frozen=True)
class ToolDelta:
    """What to append before the next call: `tool_removal`s, then `tool_addition`s, by API name; then, when
    `fresh`, a new model context with `model_tools(context)`."""

    remove: tuple[str, ...] = ()
    add: tuple[str, ...] = ()
    fresh: bool = False


def _definition(entry: dict) -> dict:
    return {key: entry.get(key) for key in ("name", "description", "input_schema")}


def tool_delta(frozen: FrozenTools | None, context: SessionContext,
               mode: Literal["append", "fresh_context"] = TOOL_CHANGE_MODE) -> ToolDelta:
    """How the context's tools must change to match what `/context` says the session may call now.

    In mode "append" a declared tool the session gained is a `tool_addition` and one it lost a `tool_removal`
    (the entry stays). A changed definition is a removal, then a fresh context with the new entry: an entry is
    never edited, which would break replayed thinking. A tool the context never declared, no context yet, or any
    change at all in mode "fresh_context", is a fresh context."""
    if mode not in ("append", "fresh_context"):
        raise ValueError(f"{mode!r} is not a tool change mode")
    if frozen is None:
        return ToolDelta(fresh=True)
    wanted = model_tools(context)
    before = {entry["name"]: _definition(entry) for entry in frozen.entries}
    now = {entry["name"] for entry in wanted if not entry.get("defer_loading")}
    changed = {entry["name"] for entry in wanted
               if entry["name"] in before and before[entry["name"]] != _definition(entry)}
    undeclared = any(entry["name"] not in before for entry in wanted)
    remove = tuple(sorted(frozen.loaded - now))
    add = tuple(sorted(now - frozen.loaded - changed))
    if mode == "fresh_context":
        return ToolDelta(fresh=True) if remove or add or changed or undeclared else ToolDelta()
    if changed or undeclared:
        return ToolDelta(remove=tuple(sorted(frozen.loaded & changed)), fresh=True)
    return ToolDelta(remove=remove, add=add)


# Routing -------------------------------------------------------------------------------------------------

SEND_REPLY = SEND_REPLY_TOOL["name"]
# After an /execute timeout the decision is read each second for ten seconds ("Fail-closed behavior").
EXECUTE_POLL_S, EXECUTE_POLLS = 1.0, 10
EXECUTED = frozenset({"executed", "failed", "unknown"})
NOT_RUN = {"outcome": "not_run"}
UNAVAILABLE = {"outcome": "unavailable"}
REFUSED = {"outcome": "refused"}
DELIVERED_HANDOFF = {"outcome": "delivered_handoff"}
# The kernel's call-back offer, shown as prose in place of a draft blocked only for its prose with no card to keep.
CALL_BACK_OFFERS = frozenset(STATUS_LINES["offer_callback"].values())


@dataclass(frozen=True)
class Caller:
    """Who a turn acts for, held in memory only: the IDs a kernel answer named and the view carrying the caller's
    credential. `ro_schema` is where `deliver()` reads the session's generation (`kernel_ro`; the fake's mirror in
    tests)."""

    copy_id: str
    desk_id: str
    session_id: str
    kind: ActorKind
    kernel: CredentialView
    ro_schema: str = KERNEL_RO

    @property
    def ids(self) -> Ids:
        return Ids(copy_id=self.copy_id, desk_id=self.desk_id, session_id=self.session_id)


def result_json(result: dict) -> str:
    """A tool result as JSON in which no text can open or close a tag: `<`, `>` and `&` are written as JSON escapes,
    which parse back to the same strings."""
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    return encoded.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")


@dataclass(frozen=True)
class ToolOutcome:
    """How one tool call ended. `result` is the JSON Claude receives (`block` wraps it in its `tool_result`);
    `status` the decision shown to the visitor; `delivered` what a reply put on screen; `kept` a draft the check
    stopped that Claude may rewrite, for the turn to keep for the owner. The flags tell the turn how to go on (module
    docstring); the timings feed the turn's metrics. `unread` (with `unavailable`) marks a call whose outcome the
    kernel couldn't be reached to give: `recover_call` couldn't look it up by its call ID, or an allow's `/execute`
    found no final state (`_execute`). Whether it ran, or still may, isn't known, so it is never answered but left open
    for a later request, which finds it by its call ID: an allow then runs once (a repeat returns the stored result),
    and Claude reads what it ended as, never `unavailable` for a call that ran."""

    result: dict
    is_error: bool
    status: Status | None = None
    delivered: Literal["reply", "handoff"] | None = None
    message_id: str | None = None
    fenced: bool = False
    session_ended: bool = False
    unavailable: bool = False
    turn_over: bool = False
    unread: bool = False
    stopped: Stopped | None = None                     # the attempt the checkpoint stopped, for triage
    kept: KeptDraft | None = None                      # a stopped draft the turn keeps with the result Claude reads
    decide_ms: int = 0
    execute_ms: int = 0
    check_reply_ms: int = 0

    def block(self, tool_use_id: str) -> dict:
        return {"type": "tool_result", "tool_use_id": tool_use_id, "content": result_json(self.result),
                "is_error": self.is_error}


def not_run() -> ToolOutcome:
    """The answer for a call that never ran: the kernel never had it, or refused it without a decision."""
    return ToolOutcome(dict(NOT_RUN), True)


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def _refusal(failure: KernelFailed) -> ToolOutcome:
    """A `KernelError` in a tool call, by its group ("Fail-closed behavior")."""
    if failure.refuses_call:
        return ToolOutcome(dict(REFUSED), True)
    return ToolOutcome(dict(NOT_RUN), True, fenced=failure.silent, session_ended=failure.ends_session,
                       turn_over=failure.turn_over)


def _unavailable() -> ToolOutcome:
    return ToolOutcome(dict(UNAVAILABLE), True, unavailable=True)


async def _publish(conn: AsyncConnection, caller: Caller, status: Status) -> Status:
    """Show the decision as the kernel signed it. A receipt for an execution whose outcome isn't final (`unknown`,
    reconciled later) is also left for the visitor's next request, which publishes its final state."""
    shown = await deliver(conn, caller.ids, status, ro_schema=caller.ro_schema)
    if shown is not None and status.phase == "receipt" and status.decision.state in NOT_FINAL:
        await append_control(conn, caller.ids, "decision_pending", {"decision_id": status.decision.decision_id})
    await conn.commit()
    return status


async def _show_inbox(conn: AsyncConnection, caller: Caller, result: ExecResult) -> None:
    """The execution's Demo inbox notices for the visitor (a code sent to the contact on record: the panel reads it
    through the kernel), on the stream at once; owner alerts never, and each entry once (`emit_inbox`). A decision's
    own notices (`Decision.inbox`: holds, pauses, drift alerts) are the owner's and are never shown."""
    if result.inbox:
        await emit_inbox(conn, caller.ids, result.inbox)
        await conn.commit()


async def _pending(conn: AsyncConnection, caller: Caller, decision_id: str) -> None:
    """Leave the decision for the visitor's next request: its final state is published once it has one."""
    await append_control(conn, caller.ids, "decision_pending", {"decision_id": decision_id})
    await conn.commit()


async def _read(caller: Caller, decision_id: str) -> Decision:
    return await caller.kernel.call("GET /decisions/{id}", path={"id": decision_id})


async def _by_call(caller: Caller, generation: int, call_id: str) -> Decision | ToolOutcome:
    """The decision made for this call ID, never a new one; a call the kernel never decided didn't run."""
    try:
        return await caller.kernel.call("GET /decisions/by_call?session_id=&generation=&call_id=", query={
            "session_id": caller.session_id, "generation": generation, "call_id": call_id})
    except KernelFailed as failure:
        return ToolOutcome(dict(NOT_RUN), True) if failure.code == "not_found" else _refusal(failure)
    except KernelUnavailable:
        return _unavailable()


async def _poll(caller: Caller, decision_id: str) -> Decision | ToolOutcome | None:
    """After an /execute timeout: the decision once it has left `allowed`, read each second for ten seconds;
    None when it hasn't."""
    for attempt in range(EXECUTE_POLLS):
        if attempt:
            await asyncio.sleep(EXECUTE_POLL_S)
        try:
            decision = await _read(caller, decision_id)
        except KernelFailed as failure:
            return _refusal(failure)
        except KernelUnavailable:
            continue
        if decision.state != "allowed":
            return decision
    return None


def _from_state(decision: Decision, status: Status | None) -> ToolOutcome:
    """A decision that ran, or may have, answered from its state alone (no stored result): what it ended as, or
    `unknown` while it isn't final."""
    message = {"decision_id": decision.decision_id, "message": decision.visitor_plain}
    if decision.state in NOT_FINAL:
        return ToolOutcome({"outcome": "unknown", **message}, True, status=status)
    if decision.state not in EXECUTED:                  # refused, at the decision or at execution, or expired
        return ToolOutcome({"outcome": "refused", **message}, True, status=status)
    ran = "done" if decision.state == "executed" else decision.state
    return ToolOutcome({"outcome": ran, **message}, ran != "done", status=status)


async def _not_known_yet(conn: AsyncConnection, caller: Caller, decision_id: str) -> ToolOutcome:
    """`/execute` answered 409 `conflict`: the kernel has no result to give for this decision now. Its execution is
    under way or its outcome `unknown` (no stored result yet), or it can't run (expired, refused at execution).
    That alone is never answered `refused`, and /execute is never sent again for the decision. It is read by its ID
    and shown as the kernel signed it, and Claude gets what it ended as, or `unknown` while it isn't final (then
    `_publish` has left a `decision_pending` row, so the visitor's next request publishes its final state). A
    decision that can't be read is left pending too and answered `unknown`, and the turn stops as that read's
    failure says."""
    try:
        decision = await _read(caller, decision_id)
    except (KernelFailed, KernelUnavailable) as failure:
        await _pending(conn, caller, decision_id)
        stopped = _unavailable() if isinstance(failure, KernelUnavailable) else _refusal(failure)
        return replace(stopped, result={"outcome": "unknown", "decision_id": decision_id})
    return _from_state(decision, await _publish(conn, caller, Status(decision, "receipt")))


def _executed(decision: Decision | None, decision_id: str, result: ExecResult) -> dict:
    if result.state == "succeeded":
        return {"outcome": "done", "decision_id": decision_id, "result": result.model_view,
                "fact_ids": [fact.fact_id for fact in result.facts]}
    message = {} if decision is None else {"message": decision.visitor_plain}
    return {"outcome": result.state, "decision_id": decision_id, **message}


async def _execute(conn: AsyncConnection, caller: Caller, generation: int, decision: Decision) -> ToolOutcome:
    """Run an allow, then show the decision as the kernel signed it once it ran. A 409 `conflict` (the execution under
    way or in doubt, or the allow no longer runnable) is answered from the decision as it stands (`_not_known_yet`). An
    `/execute` that can't reach the kernel is followed by reads of the decision; when none finds it final (it may
    have run, or may still run), the call is left open (`unread`) for a later request to find by its call ID, and
    left as a `decision_pending` row so its final state is shown even if none comes."""
    try:
        result = await caller.kernel.call("POST /execute", ExecuteRequest(
            decision_id=decision.decision_id, session_id=caller.session_id, generation=generation))
    except KernelFailed as failure:
        if failure.code == "conflict":                  # under way, in doubt, expired or refused at execution
            return await _not_known_yet(conn, caller, decision.decision_id)
        return _refusal(failure)
    except KernelUnavailable:
        final = await _poll(caller, decision.decision_id)
        if isinstance(final, ToolOutcome):
            return final
        if final is None:                               # it may have run, or still may: left open (`unread`)
            await _pending(conn, caller, decision.decision_id)
            return replace(_unavailable(), unread=True)
        return await _settle(conn, caller, generation, final)
    try:
        final = await _read(caller, decision.decision_id)
    except (KernelFailed, KernelUnavailable):
        await _pending(conn, caller, decision.decision_id)
        await _show_inbox(conn, caller, result)
        return ToolOutcome(_executed(None, decision.decision_id, result), result.state != "succeeded")
    status = await _publish(conn, caller, Status(final, "receipt"))
    await _show_inbox(conn, caller, result)
    return ToolOutcome(_executed(final, decision.decision_id, result), result.state != "succeeded", status=status)


async def _settle(conn: AsyncConnection, caller: Caller, generation: int | None, decision: Decision) -> ToolOutcome:
    """Act on a decision as it stands: run an allow, show a hold, and answer with what it ended as.

    `generation` None settles a decision made at a generation the session has since left (a take-over or a
    hand-back came after the turn that made it stopped), or one that moves money found by another request than the
    one that made it (`recover_call`): it is shown and answered from its state alone. Nothing goes
    to /execute, which the kernel refuses at another generation than the decision's (an allow would expire there,
    and the turn stop as fenced), so a call that ran is answered without the stored result a repeat returns, and
    an allow that isn't final yet (an execution may still be under way) is left for the visitor's next request,
    which publishes its final state, and answered `unknown`.

    A call that ran is sent to /execute again, for its stored result, only once it finished (`executed`, `failed`):
    the kernel refuses to repeat one whose outcome isn't known (409 `conflict`), so an `unknown` decision is answered
    from its state, as its receipt shows it, and left for the visitor's next request. A finished one whose repeat the
    kernel refuses silently (the session moved on since: a take-over or a pause came between the turn's look at the
    decision and the repeat) is answered from its state too, never `not_run`, and stops the turn as fenced; one whose
    repeat answers 409 `conflict` (no stored result to give) is read again and answered from its state, never
    `refused` (`_not_known_yet`)."""
    if decision.outcome == "hold":
        # The owner may have answered while this turn was interrupted. Never execute a hold again;
        # approved/unknown still wait, and the resume job publishes the eventual answer.
        if decision.state not in ("held", "approved", "unknown"):
            return _from_state(decision, None)
        status = None
        if decision.state == "held":
            status = await _publish(conn, caller, Status(decision, "held"))
        # an answered hold reaches the visitor through the owner's answer (Task 8), as resolved
        message = {"decision_id": decision.decision_id, "message": decision.visitor_plain}
        return ToolOutcome({"outcome": "held_for_owner", **message}, False, status=status)
    if decision.state == "allowed":
        if generation is None:
            await _pending(conn, caller, decision.decision_id)
            return _from_state(decision, None)
        return await _execute(conn, caller, generation, decision)
    from_state = _from_state(decision, await _publish(conn, caller, Status(decision, "receipt")))
    if generation is None or decision.state not in ("executed", "failed"):
        # refused or expired; ran at a generation the session has left; or its outcome isn't known yet (a repeat of an
        # execution in doubt is refused): answered from the decision, and an `unknown` one is left pending by `_publish`
        return from_state
    try:                                                # finished: a repeat returns the stored result
        result = await caller.kernel.call("POST /execute", ExecuteRequest(
            decision_id=decision.decision_id, session_id=caller.session_id, generation=generation))
    except KernelFailed as failure:
        if failure.silent:                              # the session moved on since: what ran, and the turn stops
            return replace(from_state, fenced=True)
        if failure.code == "conflict":                  # no stored result to give: answered from the decision
            return await _not_known_yet(conn, caller, decision.decision_id)
        return replace(_refusal(failure), status=from_state.status)
    except KernelUnavailable:
        return replace(_unavailable(), status=from_state.status)
    await _show_inbox(conn, caller, result)              # once: a notice the first run published isn't again
    return ToolOutcome(_executed(decision, decision.decision_id, result), result.state != "succeeded",
                       status=from_state.status)


def tool_call(block: dict) -> ToolCall:
    """The call a `tool_use` block proposes, as `/decide` takes it; raises for a block that can't be one."""
    if block.get("name") == SEND_REPLY:
        raise ValueError("send_reply goes to the kernel's reply check, never to /decide")
    return ToolCall(call_id=block["id"], tool=from_api_name(block["name"]), args=block["input"])


async def route_call(conn: AsyncConnection, caller: Caller, generation: int, block: dict) -> ToolOutcome:
    """One `tool_use` block, decided by the kernel under its ID and run only on an allow. A lost `/decide` answer
    is found by call ID, never decided again."""
    call = tool_call(block)
    started = time.monotonic()
    try:
        decision = await caller.kernel.call("POST /decide", DecideRequest(
            session_id=caller.session_id, generation=generation, call=call,
            desk_id=caller.desk_id if caller.kind == "owner" else None))
    except KernelFailed as failure:
        return replace(_refusal(failure), decide_ms=_ms(started))
    except KernelUnavailable:
        found = await _by_call(caller, generation, call.call_id)
        if isinstance(found, ToolOutcome):
            return replace(found, decide_ms=_ms(started))
        decision = found
    decide_ms, started = _ms(started), time.monotonic()
    outcome = await _settle(conn, caller, generation, decision)
    stopped = Stopped("decision", decision.decision_id) if decision.outcome == "refuse" else None
    return replace(outcome, stopped=stopped, decide_ms=decide_ms, execute_ms=_ms(started))


def moves_money(decision: Decision) -> bool:
    """Whether the decision's action moves money: a money tool, or an action with a money effect
    (`desk.contracts.money_tool`, the one definition the kernel holds them to)."""
    action = decision.action
    return action is not None and money_tool(action.tool, action.effects)


async def recover_call(conn: AsyncConnection, caller: Caller, generation: int, block: dict, *,
                       made_at: int, resumes_money: bool = False) -> ToolOutcome:
    """A `tool_use` block a turn left unanswered (it stopped after the call): found by call ID at `made_at`, the
    session generation that turn ran at, never decided again. No decision means it never ran; an allow runs now (a
    repeat returns the stored result, and a 409 `conflict`, its execution already under way, answers from the
    decision: `unknown` while it isn't final); a final decision answers with what it ended as. When the session has
    left that generation since (`generation` is the session's now), the decision is only shown and answered from its
    state (`_settle`). If settling it raises (a publication that failed), a decision that isn't final is left as a
    `decision_pending` row before the error goes on, so its final state is still shown once it has one.

    Money stays fail-closed outside the request that made the call: a decision that moves money (`moves_money`) goes
    to `/execute` again only when `resumes_money` (this request is that one, sent again, or the same turn); any other
    request answers it from its state, never sending `/execute` (`unknown` while it isn't final, left to its
    `decision_pending` row and the kernel's reconciliation).

    A lookup that can't reach the kernel answers `unread`: the call may have run, so its caller leaves it open, with no
    results row, for a later request to look up again. Once the decision is found the kernel was asked, and whatever
    settling it answers (`unknown` after a 409 whose decision couldn't be read, left pending) closes the call, so
    /execute is never sent again for it, but for an allow whose `/execute` again found no final state, left open the
    same way (`_execute`): a later `/execute` of the same decision runs it once or returns its stored result."""
    call = tool_call(block)
    found = await _by_call(caller, made_at, call.call_id)
    if isinstance(found, ToolOutcome):
        return replace(found, unread=True) if found.unavailable else found
    runs = made_at == generation and (resumes_money or not moves_money(found))
    try:
        return await _settle(conn, caller, generation if runs else None, found)
    except Exception:
        await conn.rollback()
        if found.state in NOT_FINAL:
            await _pending(conn, caller, found.decision_id)
        raise


# Replies -------------------------------------------------------------------------------------------------


class _ReplyClause(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    template: str
    fact_id: str | None = None


class _ReplyInput(BaseModel):
    """`send_reply`'s input as `SEND_REPLY_TOOL` declares it (a missing `clauses` is an empty list)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    prose: str
    clauses: list[_ReplyClause] = []


def _draft(tool_input: Any) -> tuple[str, list[Clause]] | list[dict]:
    """The reply Claude drafted, or what is wrong with it: input that doesn't fit the tool, a clause only the kernel
    issues (`owner_said`, `payment_confirmed`, `link_cancelled`), or nothing to show. None of these reaches the
    kernel."""
    try:
        reply = _ReplyInput.model_validate(tool_input)
    except ValidationError as error:
        problem = error.errors()[0]
        # Pydantic locations may contain arbitrary caller keys. Only schema fields and indices are public paths.
        where = ".".join(str(part) if isinstance(part, int) or part in {"prose", "clauses", "template", "fact_id"}
                         else "extra_field" for part in problem["loc"]) or "draft"
        code = problem["type"] if problem["type"] in INVALID_REPLY_SHAPES else "invalid_input"
        return [{"kind": "invalid_input", "rule_id": "other", "field": where, "code": code,
                 "expected": INVALID_REPLY_SHAPES[code]}]
    problems = [{"kind": "unknown_fact", "rule_id": "kernel_only_template", "template": clause.template}
                for clause in reply.clauses
                if clause.template in KERNEL_ONLY_TEMPLATES]
    problems += [{"kind": "invalid_input", "rule_id": "template_unavailable", "field": f"clauses.{index}.template",
                  "code": "template_unavailable", "expected": INVALID_REPLY_SHAPES["template_unavailable"]}
                 for index, clause in enumerate(reply.clauses)
                 if clause.template not in REPLY_TEMPLATES and clause.template not in KERNEL_ONLY_TEMPLATES]
    if not reply.prose and not reply.clauses:
        problems.append({"kind": "invalid_input", "rule_id": "other", "field": "prose", "code": "empty_draft",
                         "expected": INVALID_REPLY_SHAPES["empty_draft"]})
    if problems:
        return problems
    return reply.prose, [Clause(template=clause.template, fact_id=clause.fact_id) for clause in reply.clauses]


def _stopped(verdict: ReplyVerdict) -> Stopped | None:
    """A reply of Claude's the checkpoint stopped, as Safety counts one: blocked for anything but a paused session."""
    if verdict.ok or all(violation.kind == "session_paused" for violation in verdict.violations):
        return None
    return Stopped("reply", str(verdict.ledger_seq))


def _kept(prose: str, clauses: list[Clause], verdict: ReplyVerdict, *, rewritable: bool) -> KeptDraft:
    """A draft of Claude's the check stopped, as the owner keeps it: as it was sent to `/check_reply`, with the
    verdict's violations and `message_id` and, when Claude may rewrite it (nothing is shown in its place), the
    verdict's ledger entry, so the attempt's triage shows on the draft's item."""
    stopped = StoppedDraft(draft=CheckedDraft(prose=prose, clauses=clauses), violations=verdict.violations)
    return KeptDraft(message_id=verdict.message_id, stopped=stopped,
                     ledger_seq=verdict.ledger_seq if rewritable else None)


def _blocked(violations: list[dict], **timing: int) -> ToolOutcome:
    diagnostics = list(dict.fromkeys(
        INVALID_REPLY_DIAGNOSTIC.format(**v) if "field" in v else
        REPLY_DIAGNOSTICS.get(v.get("rule_id"), REPLY_DIAGNOSTICS["other"]) for v in violations))
    return ToolOutcome({"outcome": "blocked", "delivered": False, "violations": violations,
                        "diagnostics": diagnostics, "instruction": REWRITE_INSTRUCTION}, True,
                       **timing)


CLAUSE_RULE_IDS = frozenset({"names_no_fact", "no_such_fact", "not_a_reader", "template_mismatch", "not_current",
                            "nothing_to_show", "template_unavailable", "kernel_only_template", "claims_changed",
                            "policy_combined"})


def _feedback(verdict: ReplyVerdict, clauses: list[Clause]) -> list[dict]:
    """Fixed diagnostics and only references from Claude's own draft, never checker spans or payloads."""
    feedback = []
    for violation in verdict.violations:
        rule_id = violation.rule_id if violation.rule_id in REPLY_RULE_IDS else "other"
        item = {"kind": violation.kind, "rule_id": rule_id}
        if rule_id in CLAUSE_RULE_IDS:
            matches = [(index, clause) for index, clause in enumerate(clauses)
                       if clause.template == violation.span and (
                           not violation.fact_ids or clause.fact_id in violation.fact_ids)]
            # Empty metadata can also mean the kernel couldn't store the cited ID (for example, a NUL).
            # Don't infer an omitted ID from it, or forward an ID the kernel couldn't name.
            if len(matches) == 1 and (violation.fact_ids or matches[0][1].fact_id is None):
                index, clause = matches[0]
                item.update(clause_index=index, template=clause.template)
                if clause.fact_id is not None:
                    item["fact_id"] = clause.fact_id
        feedback.append(item)
    return feedback


async def _check(caller: Caller, generation: int, prose: str, clauses: list[Clause], *,
                 final: bool = True) -> ReplyVerdict | ToolOutcome:
    """The kernel's verdict on a draft, or how the turn ends when there is none: a refused check shows nothing and
    ends the turn. `final` false tells the kernel a block of only rewritable kinds won't be shown (Claude rewrites
    it), so it opens no owner handoff for it."""
    draft = ReplyDraft(session_id=caller.session_id, generation=generation, prose=prose, clauses=clauses)
    try:
        return await caller.kernel.call("POST /check_reply", CheckReplyRequest(draft=draft, final=final))
    except KernelFailed as failure:
        if failure.refuses_call:
            return ToolOutcome(dict(REFUSED), True, turn_over=True)
        return _refusal(failure)
    except KernelUnavailable:
        return _unavailable()


def prose_unshown(tool_input: Any, blocks: Iterable[RenderedBlock]) -> bool:
    """Whether Claude drafted prose (`tool_input`, its `send_reply` input, a nonempty string `prose`) that none of the
    shown `blocks` holds: the check failed and showed the kept cards, a handoff or the kernel's call-back offer in its
    place. The offer is the one prose block the kernel writes, in the signed words (`CALL_BACK_OFFERS`), so a prose
    block holding them is Claude's only when Claude drafted those words."""
    prose = tool_input.get("prose") if isinstance(tool_input, dict) else None
    if not isinstance(prose, str) or not prose.strip():
        return False
    return not any(block.kind == "prose" and (block.text not in CALL_BACK_OFFERS or block.text == prose.strip())
                   for block in blocks)


def delivered_result(handoff: bool, message_id: str, *, prose_shown: bool = True) -> dict:
    """What Claude reads for a shown reply: `delivered_handoff` when it showed the handoff clause, else `delivered`
    with the message ID, each with `prose_shown` false when the prose Claude drafted wasn't shown."""
    result = dict(DELIVERED_HANDOFF) if handoff else {"outcome": "delivered", "message_id": message_id}
    if not prose_shown:
        result["prose_shown"] = False
    return result


async def _show(conn: AsyncConnection, caller: Caller, verdict: ReplyVerdict, call_id: str | None,
                tool_input: Any = None, **timing: int) -> ToolOutcome:
    """Deliver a checked reply. A verdict whose generation the session has left (a take-over while it was checked)
    is dropped by `deliver()`: nothing is shown, and the turn stops. `tool_input` is the `send_reply` input the
    verdict answers, if any, for `prose_shown`."""
    reply = Reply(verdict, "claude", "model" if call_id is not None else "api", call_id=call_id)
    seq = await deliver(conn, caller.ids, reply, ro_schema=caller.ro_schema)
    await conn.commit()
    if seq is None:
        return ToolOutcome(dict(NOT_RUN), True, fenced=True, **timing)
    result = delivered_result(reply.handoff, verdict.message_id, prose_shown=not prose_unshown(
        tool_input, verdict.blocks))
    return ToolOutcome(result, reply.handoff, delivered="handoff" if reply.handoff else "reply",
                       message_id=verdict.message_id, **timing)


async def hand_off(conn: AsyncConnection, caller: Caller, generation: int, *,
                   call_id: str | None = None, tool_input: Any = None) -> ToolOutcome:
    """Hand the conversation to the owner: the handoff clause alone, checked like any reply (a paused session's
    check answers with the handoff verdict too), then shown. `call_id` is the `send_reply` call it answers, if any,
    so the delivered row records what that call put on screen, and `tool_input` that call's input."""
    started = time.monotonic()
    verdict = await _check(caller, generation, "", [Clause(template="handoff")])
    if isinstance(verdict, ToolOutcome):
        return replace(verdict, check_reply_ms=_ms(started))
    shown = await _show(conn, caller, verdict, call_id, tool_input, check_reply_ms=_ms(started))
    return replace(shown, stopped=_stopped(verdict))


async def send_reply(conn: AsyncConnection, caller: Caller, generation: int, tool_input: Any, attempt: int, *,
                     call_left: bool = True, call_id: str | None = None) -> ToolOutcome:
    """Claude's reply: checked by the kernel, then shown through `deliver()` as the kernel's verdict permits.

    Claude may rewrite only attempt 1, and only while the turn has a model call left (`call_left`); that check alone
    is sent with `final` false, every other one final, for every kind of session. A non-final reply blocked with
    only kinds a rewrite can fix (`desk.rewrites.REWRITABLE`) shows nothing and sends Claude the violations and
    `REWRITE_INSTRUCTION`; a soft check that gave no verdict (`check_unavailable`) is one of them, and the final
    check makes its own try. Any other block, an immediate-handoff kind (`canary`, `unsupported_language`,
    `session_paused`) or a final check's, shows the verdict's blocks with no further kernel call: the checked cards
    when they survive (with Claude's drafted handoff clause after them, when it drafted one), otherwise, when only
    the prose failed and the session is offered a call back, the kernel's call-back offer, delivered as a reply as
    kept cards are, and otherwise the handoff the kernel opened for the owner. Any shown handoff clause ends the turn
    as `delivered_handoff`, even when the draft passed. Either outcome carries `prose_shown` false when the prose
    Claude drafted wasn't shown (the kept cards, the offer or a handoff in its place), so Claude never refers to it.
    Input that doesn't fit the tool never reaches the kernel:
    Claude gets one rewrite while it can, then the handoff. `call_id` is the `send_reply` call's `tool_use` ID;
    without one (Claude's plain text) the reply is the API's.

    A draft the check stopped is kept for the owner (module docstring): committed with the checked cards or handoff shown,
    or, on a block Claude may rewrite, carried on the outcome (`kept`) for the caller to keep with the call's result.
    Nothing is left open on `conn` either way, so no lock of the session outlives the call."""
    if attempt not in (1, 2):
        raise ValueError("a reply has two attempts")
    final = attempt != 1 or not call_left
    draft = _draft(tool_input)
    if isinstance(draft, list):
        if not final:
            return _blocked(draft)
        return await hand_off(conn, caller, generation, call_id=call_id, tool_input=tool_input)
    started = time.monotonic()
    verdict = await _check(caller, generation, *draft, final=final)
    timing = {"check_reply_ms": _ms(started)}
    if isinstance(verdict, ToolOutcome):
        return replace(verdict, **timing)
    if verdict.ok:
        return await _show(conn, caller, verdict, call_id, tool_input, **timing)
    if not final and all(violation.kind in REWRITABLE for violation in verdict.violations):
        return replace(_blocked(_feedback(verdict, draft[1]), **timing), stopped=_stopped(verdict),
                       kept=_kept(*draft, verdict, rewritable=True))
    await run_lock(conn, caller.session_id)            # before the events lock, as the handoff's delivery takes them
    await append_stopped_draft(conn, caller.ids, _kept(*draft, verdict, rewritable=False))
    shown = await _show(conn, caller, verdict, call_id, tool_input, **timing)
    return replace(shown, stopped=_stopped(verdict))
