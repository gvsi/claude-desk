"""Claude's tools and the way each of its calls reaches the kernel (master plan, "Model-visible tools", "Fail-closed
behavior"; Plan 02a, "Tool results Claude receives").

Claude only proposes. Every tool call but `send_reply` goes to `/decide` with the `tool_use` ID as its call ID,
and runs only on the kernel's allow, through `/execute`; a hold returns at once. The visitor sees each decision
once, as the kernel signed it (`Status`, through `deliver()`). `send_reply` goes to `/check_reply`, and only what
the kernel passed, or its handoff, reaches the visitor, through `deliver()`.

Failures fail closed ("Fail-closed behavior"): nothing is decided twice (a lost `/decide` answer is found by call
ID, a lost `/execute` answer by polling the decision), an `/execute` answered 409 `conflict` (the kernel has no
result to give yet) is never sent again but answered from the decision as it stands, nothing unchecked is shown,
and each `ToolOutcome` says how the turn goes on: `fenced` (a take-over or a stale generation: stop, silently),
`session_ended` (`error{code: "session"}`), `unavailable` (`error{code: "kernel_unavailable"}`) or `turn_over`
(stop: an agent's turn already answered, or a reply the kernel refused).

`route_call`, `recover_call`, `send_reply` and `hand_off` take the call's own connection and commit each
publication on it at once, so a receipt reaches the visitor while sibling calls still run.
"""

import asyncio
import json
import time
from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.deliver import NOT_FINAL, Reply, Status, deliver
from desk.api.kernel_client import CredentialView, KernelFailed, KernelUnavailable
from desk.api.prompts import KERNEL_ONLY_TEMPLATES, REPLY_TEMPLATES, REWRITE_INSTRUCTION, SEND_REPLY_TOOL
from desk.api.ro import KERNEL_RO
from desk.api.sse import append_control
from desk.api.store import Ids
from desk.contracts import ActorKind, Clause, Decision, ExecResult, ReplyDraft, ReplyVerdict, ToolCall, ToolProfile
from desk.kernel_api import CheckReplyRequest, DecideRequest, ExecuteRequest, SessionContext

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
# Violations Claude gets one rewrite for; any other kind hands off at once.
REGENERABLE = frozenset({"number_in_prose", "promise_word", "soft_promise", "unknown_fact", "stale_fact",
                         "unentitled_fact"})
NOT_RUN = {"outcome": "not_run"}
UNAVAILABLE = {"outcome": "unavailable"}
REFUSED = {"outcome": "refused"}
DELIVERED_HANDOFF = {"outcome": "delivered_handoff"}


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
    `status` the decision shown to the visitor; `delivered` what a reply put on screen. The flags tell the turn
    how to go on (module docstring); the timings feed the turn's metrics."""

    result: dict
    is_error: bool
    status: Status | None = None
    delivered: Literal["reply", "handoff"] | None = None
    message_id: str | None = None
    fenced: bool = False
    session_ended: bool = False
    unavailable: bool = False
    turn_over: bool = False
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
    way or in doubt, or the allow no longer runnable) is answered from the decision as it stands (`_not_known_yet`)."""
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
        if final is None:
            await _pending(conn, caller, decision.decision_id)
            return _unavailable()
        return await _settle(conn, caller, generation, final)
    try:
        final = await _read(caller, decision.decision_id)
    except (KernelFailed, KernelUnavailable):
        await _pending(conn, caller, decision.decision_id)
        return ToolOutcome(_executed(None, decision.decision_id, result), result.state != "succeeded")
    status = await _publish(conn, caller, Status(final, "receipt"))
    return ToolOutcome(_executed(final, decision.decision_id, result), result.state != "succeeded", status=status)


async def _settle(conn: AsyncConnection, caller: Caller, generation: int | None, decision: Decision) -> ToolOutcome:
    """Act on a decision as it stands: run an allow, show a hold, and answer with what it ended as.

    `generation` None settles a decision made at a generation the session has since left (a take-over or a
    hand-back came after the turn that made it stopped): it is shown and answered from its state alone. Nothing goes
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
    return replace(outcome, decide_ms=decide_ms, execute_ms=_ms(started))


async def recover_call(conn: AsyncConnection, caller: Caller, generation: int, block: dict, *,
                       made_at: int) -> ToolOutcome:
    """A `tool_use` block a turn left unanswered (it stopped after the call): found by call ID at `made_at`, the
    session generation that turn ran at, never decided again. No decision means it never ran; an allow runs now (a
    repeat returns the stored result, and a 409 `conflict`, its execution already under way, answers from the
    decision: `unknown` while it isn't final); a final decision answers with what it ended as. When the session has
    left that generation since (`generation` is the session's now), the decision is only shown and answered from its
    state (`_settle`). If settling it raises (a publication that failed), a decision that isn't final is left as a
    `decision_pending` row before the error goes on, so its final state is still shown once it has one."""
    call = tool_call(block)
    found = await _by_call(caller, made_at, call.call_id)
    if isinstance(found, ToolOutcome):
        return found
    try:
        return await _settle(conn, caller, generation if made_at == generation else None, found)
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
    issues (`owner_said`, `payment_confirmed`), or nothing to show. None of these reaches the kernel."""
    try:
        reply = _ReplyInput.model_validate(tool_input)
    except ValidationError as error:
        where = ".".join(str(part) for part in error.errors()[0]["loc"])
        return [{"kind": "invalid_input", "span": where}]
    problems = [{"kind": "unknown_fact", "span": clause.template} for clause in reply.clauses
                if clause.template in KERNEL_ONLY_TEMPLATES]
    problems += [{"kind": "invalid_input", "span": clause.template} for clause in reply.clauses
                 if clause.template not in REPLY_TEMPLATES and clause.template not in KERNEL_ONLY_TEMPLATES]
    if not reply.prose and not reply.clauses:
        problems.append({"kind": "invalid_input", "span": "prose"})
    if problems:
        return problems
    return reply.prose, [Clause(template=clause.template, fact_id=clause.fact_id) for clause in reply.clauses]


def _blocked(violations: list[dict], **timing: int) -> ToolOutcome:
    return ToolOutcome({"outcome": "blocked", "violations": violations, "instruction": REWRITE_INSTRUCTION}, True,
                       **timing)


async def _check(caller: Caller, generation: int, prose: str, clauses: list[Clause]) -> ReplyVerdict | ToolOutcome:
    """The kernel's verdict on a draft, or how the turn ends when there is none: a refused check shows nothing and
    ends the turn."""
    draft = ReplyDraft(session_id=caller.session_id, generation=generation, prose=prose, clauses=clauses)
    try:
        return await caller.kernel.call("POST /check_reply", CheckReplyRequest(draft=draft))
    except KernelFailed as failure:
        if failure.refuses_call:
            return ToolOutcome(dict(REFUSED), True, turn_over=True)
        return _refusal(failure)
    except KernelUnavailable:
        return _unavailable()


async def _show(conn: AsyncConnection, caller: Caller, verdict: ReplyVerdict, call_id: str | None, result: dict,
                delivered: Literal["reply", "handoff"], **timing: int) -> ToolOutcome:
    """Deliver a checked reply. A verdict whose generation the session has left (a take-over while it was checked)
    is dropped by `deliver()`: nothing is shown, and the turn stops."""
    reply = Reply(verdict, "claude", "model" if call_id is not None else "api", call_id=call_id)
    seq = await deliver(conn, caller.ids, reply, ro_schema=caller.ro_schema)
    await conn.commit()
    if seq is None:
        return ToolOutcome(dict(NOT_RUN), True, fenced=True, **timing)
    return ToolOutcome(result, delivered == "handoff", delivered=delivered, message_id=verdict.message_id, **timing)


async def hand_off(conn: AsyncConnection, caller: Caller, generation: int, *,
                   call_id: str | None = None) -> ToolOutcome:
    """Hand the conversation to the owner: the handoff clause alone, checked like any reply (a paused session's
    check answers with the handoff verdict too), then shown. `call_id` is the `send_reply` call it answers, if any,
    so the delivered row records what that call put on screen."""
    started = time.monotonic()
    verdict = await _check(caller, generation, "", [Clause(template="handoff")])
    if isinstance(verdict, ToolOutcome):
        return replace(verdict, check_reply_ms=_ms(started))
    return await _show(conn, caller, verdict, call_id, dict(DELIVERED_HANDOFF), "handoff",
                       check_reply_ms=_ms(started))


async def send_reply(conn: AsyncConnection, caller: Caller, generation: int, tool_input: Any, attempt: int, *,
                     call_id: str | None = None) -> ToolOutcome:
    """Claude's reply: checked by the kernel, then shown through `deliver()` only as the kernel passed it.

    A reply blocked on attempt 1 with only kinds a rewrite can fix shows nothing and sends Claude the violations and
    `REWRITE_INSTRUCTION`. An immediate-handoff kind (`canary`, `unsupported_language`, `session_paused`), or a block
    on attempt 2, shows the verdict's blocks, the handoff clause, with no further kernel call. Input that doesn't
    fit the tool never reaches the kernel: Claude gets one rewrite, then the handoff. `call_id` is the `send_reply`
    call's `tool_use` ID; without one (Claude's plain text) the reply is the API's."""
    if attempt not in (1, 2):
        raise ValueError("a reply has two attempts")
    draft = _draft(tool_input)
    if isinstance(draft, list):
        if attempt == 1:
            return _blocked(draft)
        return await hand_off(conn, caller, generation, call_id=call_id)
    started = time.monotonic()
    verdict = await _check(caller, generation, *draft)
    timing = {"check_reply_ms": _ms(started)}
    if isinstance(verdict, ToolOutcome):
        return replace(verdict, **timing)
    if verdict.ok:
        return await _show(conn, caller, verdict, call_id, {"outcome": "delivered", "message_id": verdict.message_id},
                           "reply", **timing)
    if attempt == 1 and all(violation.kind in REGENERABLE for violation in verdict.violations):
        return _blocked([{"kind": violation.kind, "span": violation.span} for violation in verdict.violations],
                        **timing)
    return await _show(conn, caller, verdict, call_id, dict(DELIVERED_HANDOFF), "handoff", **timing)
