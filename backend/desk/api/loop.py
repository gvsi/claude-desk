"""Claude's turns: the agent loop (master plan, "Model-visible tools" loop contract, "Fail-closed behavior";
Plan 02a, Task 5).

`run_turn(conn, caller, model)` answers what is waiting in a session. It reads the session's mode and generation
from the kernel (`GET /whoami`), sends it the visitor's or agent's newest message so it renders the turn in that
message's language (`POST /sessions/{session_id}/turn`, before a paused or over-budget turn's handoff too, and again
before a model call that places a newer message), reads the session's tools and facts (`GET /context`), brings the
model context up to date (a `desk_context` row when the facts change, tool changes, or a fresh context, which a
changed system prompt opens too), then calls Claude on the system prompt and tools the context froze, and acts on
each response by its stop reason. Claude only proposes: every tool call goes through `/decide`
(`tools.route_call`), and every reply through `/check_reply` and `deliver()` (`tools.send_reply`).

When a response's calls showed an executed receipt, the turn then reads each decision its session still waits on,
with the session's own credential, before any reply of that response (`_surface_settled`): the kernel settles on that
read what the execution closed (a booking closes the session's earlier held quotes with a discount), and each decision
it shows final is left as a `decision_due` row, which the session's open stream or next request shows. It doesn't
look when the calls stop the turn for a reason that would fail every read (`LOOKS_AFTER`).

`run_pending(caller, model, ...)` is how a request starts turns (Task 6): one session's turns run one at a time,
under the turn lock (`turn_lock`), until no work is waiting (an agent's request runs one turn at most).

Given the job queue (`jobs`), a turn leaves for the owner, as it finishes (Plan 02b, Task 10): a triage of each attempt
the checkpoint stopped in it, and a translation of each reply of Claude's it delivered in another language than English
(`jobs.defer_turn_annotations`), each counted on the conversation's `translate` limit with the process's `limiter`
(none without it). Queueing them never changes how the turn ends.
"""

import asyncio
import contextlib
import json
import logging
import secrets
import time
import traceback
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import procrastinate
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.deliver import NOT_FINAL, run_lock
from desk.api.jobs import defer_turn_annotations, waiting_decisions
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.metrics import RevealMetric, TurnMetric, over_daily_budget, record_model_call
from desk.api.model import ModelClient, ModelRequest, ModelResponse, ModelUnavailable, ThinkingBoundElsewhere
from desk.api.prompts import NOTES, DeskIdentity, conversation_system
from desk.api.ratelimit import RateLimiter, RateLimitLedger
from desk.api.ro import KernelRO
from desk.api.sse import append_control, append_metric, emit
from desk.api.store import (
    OpenToolUse,
    Said,
    append_assistant,
    append_message,
    append_stopped_draft,
    append_time_note,
    append_tool_change,
    append_tool_results,
    clear_wake,
    context_hash,
    context_system,
    context_text,
    context_tools,
    delivered_reply,
    last_context_hash,
    latest_pending,
    latest_said,
    lock_key,
    newest_row,
    prepare_model_input,
    start_fresh_context,
    unanswered_tool_use,
)
from desk.api.tools import (
    SEND_REPLY,
    UNAVAILABLE,
    Caller,
    FrozenTools,
    ToolOutcome,
    delivered_result,
    hand_off,
    model_tools,
    not_run,
    offer_shown_instead,
    prose_unshown,
    recover_call,
    route_call,
    send_reply,
    tool_call,
    tool_delta,
)
from desk.api.triage import Stopped
from desk.contracts import SessionState
from desk.events import EvError, EvTurnEnd, EvWriting
from desk.kernel_api import TURN_TEXT_CHARS, SessionContext, TurnRequest

TurnOutcome = Literal["done", "fenced", "session_ended", "kernel_unavailable", "handoff", "turn_over", "not_ai",
                      "internal"]
logger = logging.getLogger(__name__)
# The model calls one turn may make before it hands off.
MAX_MODEL_CALLS = 6
THINKING = frozenset({"thinking", "redacted_thinking"})
# The static error a visitor sees when a turn fails ("Fail-closed behavior"); other ends are silent.
ERROR_CODES = {"session_ended": "session", "kernel_unavailable": "kernel_unavailable", "internal": "internal"}
# The stops after which a turn whose call ran still reads what its session waits on (`_surface_settled`): none (the
# turn goes on), a call that raised, and a take-over or stale generation (`fenced`), since a session's
# `GET /decisions/{id}` checks neither its mode nor its generation and a take-over leaves an agent's request unspent.
# Any other stop would fail every read: the kernel refuses an agent's request already answered (`turn_over`) and a
# session it ended, ledgering each refusal, and a kernel out of reach would only be waited on again.
LOOKS_AFTER: frozenset[TurnOutcome | None] = frozenset({None, "internal", "fenced"})


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def _raised(error: BaseException) -> str:
    """An error for the log: its type and where it was raised (the innermost frame's file and line), never its
    message, which can carry bound parameters, contacts or tokens."""
    frames = traceback.extract_tb(error.__traceback__)
    where = f" at {frames[-1].filename}:{frames[-1].lineno}" if frames else ""
    return type(error).__name__ + where


def _failed(failure: KernelFailed) -> TurnOutcome:
    """How a turn ends when the kernel refuses a read it needs (`/whoami`, `/context`)."""
    if failure.silent:
        return "fenced"
    if failure.ends_session:
        return "session_ended"
    if failure.turn_over:
        return "turn_over"
    return "kernel_unavailable"


def _stop(outcomes: Iterable[ToolOutcome]) -> TurnOutcome | None:
    """How the turn stops after these calls, if it must: a take-over or stale generation first (silently), then an
    agent's turn already answered, a session the kernel ended, and a kernel that can't be reached."""
    outcomes = list(outcomes)
    for flag, outcome in (("fenced", "fenced"), ("turn_over", "turn_over"), ("session_ended", "session_ended"),
                          ("unavailable", "kernel_unavailable")):
        if any(getattr(found, flag) for found in outcomes):
            return outcome
    return None


async def _session(caller: Caller) -> SessionState | TurnOutcome:
    """The caller's session as the kernel has it now (`GET /whoami`: its mode and generation), or how the turn ends
    when there is none to act in. An agent names its session in the query, since its signature can't (master,
    "Kernel HTTP API v2"); a token names its own."""
    try:
        who = await caller.kernel.whoami(session_id=caller.session_id if caller.kind == "agent" else None)
    except KernelFailed as failure:
        return _failed(failure)
    except KernelUnavailable:
        return "kernel_unavailable"
    session = who.session
    if session is None or (who.copy_id, who.desk_id, session.session_id) != (
            caller.copy_id, caller.desk_id, caller.session_id):
        return "session_ended"                            # the credential no longer names this session
    return session


async def desk_identity(conn: AsyncConnection, caller: Caller) -> DeskIdentity:
    """Who Claude answers for, from the kernel's records of the caller's Desk."""
    ro = KernelRO(conn, caller.copy_id, caller.ro_schema)
    desk = await ro.one("desks", desk_id=caller.desk_id)
    if desk is None:
        raise LookupError("the caller's Desk isn't in its copy")
    business = await ro.one("businesses", business_id=desk["business_id"])
    if business is None:
        raise LookupError("the caller's business isn't in its copy")
    return DeskIdentity(business_name=business["name"], desk_name=desk["name"],
                        owner_name=business["owner_display_name"], kind=caller.kind)


async def _surface_settled(conn: AsyncConnection, caller: Caller) -> None:
    """After a response's calls ran and one showed an executed receipt: each decision the session still waits on
    (`jobs.waiting_decisions`) is read with its own client (`GET /decisions/{id}`). The kernel settles on a read what
    an execution closed, as it applies expiry (a booking cancels the session's earlier held quotes with a discount),
    and the minute sweep reads only kernel_ro. Each one the read shows final gets one `decision_due` row, as the sweep
    writes it, for the session's open stream or next request to show (`runner.TurnRunner.handle_control`); one not
    final gets none, which would keep the sweep from marking it later. Nothing waiting, no kernel call. It runs before
    the response's replies, while an agent's request is unspent, holds no lock across a kernel call, and never raises:
    a failure is logged by type only and skipped, for the sweep or the owner's reads to settle. A kernel out of reach
    ends the look at once, so a turn waits out the client's timeout once at most, not once per waiting decision; a
    turn whose calls already found every read bound to fail (the kernel out of reach, an agent's request already
    answered, the session ended) doesn't look at all (`LOOKS_AFTER`), so it adds no refused read to the ledger."""
    try:
        waiting = [row.decision_id for row in await conn.execute(waiting_decisions(caller.ids))]
        await conn.commit()
    except Exception as error:
        logger.error("a session's waiting decisions couldn't be looked up (%s)", type(error).__name__)
        with contextlib.suppress(Exception):
            await conn.rollback()
        return
    for decision_id in waiting:
        try:
            decision = await caller.kernel.call("GET /decisions/{id}", path={"id": decision_id})
            if decision.session_id == caller.session_id and decision.state not in NOT_FINAL:
                await append_control(conn, caller.ids, "decision_due", {"decision_id": decision_id})
                await conn.commit()
        except KernelUnavailable as error:                  # the next read would wait as long: none is tried
            logger.warning("a waiting decision couldn't be read after a call ran (%s)", type(error).__name__)
            break
        except Exception as error:
            logger.warning("a waiting decision couldn't be read after a call ran (%s)", type(error).__name__)
            with contextlib.suppress(Exception):
                await conn.rollback()


class NotSent(Exception):
    """A tool call that failed on its way to the kernel (a block no call fits, no pooled connection left for it):
    the kernel never had it."""


@dataclass
class _Turn:
    conn: AsyncConnection
    caller: Caller
    model: ModelClient
    end_on_reply: bool
    production: bool
    clock: Callable[[], datetime]
    started: float = field(default_factory=time.monotonic)
    generation: int = 0
    model_calls: int = 0
    tool_calls: int = 0
    decide_ms: int = 0
    execute_ms: int = 0
    attempt: int = 1                                   # the next reply's: 2 once a reply was blocked this turn
    empty_answers: int = 0                             # end_turns with nothing to show
    delivered: Literal["reply", "handoff"] | None = None   # what the turn last put on screen
    returned_at: float = 0.0                           # when the last model call returned (monotonic)
    reveals: list[RevealMetric] = field(default_factory=list)
    jobs: procrastinate.App | None = None              # the job queue, for the turn's triage and translations
    limiter: RateLimiter | None = None                 # the process's limits, for the conversation's translations
    stopped: list[Stopped] = field(default_factory=list)   # attempts the checkpoint stopped this turn
    replied: list[str] = field(default_factory=list)   # the kernel's message IDs of Claude's messages delivered
    context: SessionContext | None = None              # the session's tools and facts, as `/context` gave them
    system: list[dict] = field(default_factory=list)   # the system prompt this turn rendered
    rebound: bool = False                              # a thinking-binding 400 started a fresh context this turn
    recovered: bool = False                            # the turn `_drain` runs so Claude reads recovered results
    said_n: int | None = None                          # the newest message sent to `/turn` this turn, by its `n`
    annotates: bool = True                             # False for a handoff with no model call: none for the owner

    @property
    def visitor(self) -> bool:
        return self.caller.kind == "visitor"

    async def run(self) -> TurnOutcome:
        conn, caller = self.conn, self.caller
        session = await _session(caller)
        if isinstance(session, str):
            return session
        self.generation = session.generation
        if session.mode == "owner":                        # the owner took over: Claude stays quiet
            return "not_ai"
        refused = await self._tell_waiting()               # first, even for a handoff: it speaks the turn's language
        if refused is not None:
            return refused
        if session.mode == "paused":                       # the breaker tripped: the kernel's handoff, no model call
            await clear_wake(conn, caller.session_id)
            await conn.commit()
            self.annotates = False
            return await self._hand_off()
        if self.production:                                # past today's model budget: the handoff, no model call
            over = await over_daily_budget(conn, self.clock)
            if over:                                       # as paused: what waits stops waking turns
                await clear_wake(conn, caller.session_id)
            await conn.commit()
            if over:
                self.annotates = False
                return await self._hand_off()
        if self.visitor:
            await self._writing()
        try:
            context = await caller.kernel.call("GET /context/{session_id}?desk_id=",
                                               path={"session_id": caller.session_id})
        except KernelFailed as failure:
            return _failed(failure)
        except KernelUnavailable:
            return "kernel_unavailable"
        self.context, self.system = context, conversation_system(await desk_identity(conn, caller))
        await self._bring_up_to_date(context, self.system)
        await conn.commit()
        while True:
            if self.model_calls >= MAX_MODEL_CALLS:            # out of calls: the handoff, unless it is on screen
                return self._ended() if self.delivered == "handoff" else await self._hand_off()
            response = await self._call()
            if isinstance(response, str):                  # the kernel refused a newer message's `/turn`
                return response
            outcome = await self._act(response)
            if outcome is not None:
                return outcome

    async def _writing(self) -> None:
        """Show the visitor that Claude is writing, only while the session is still at the generation the turn read:
        a take-over landing since showed `owner_joined`, and a `writing` after it would read as Claude having the chat
        again. Checked under the run lock a take-over holds around its mode change and its event (`deliver.run_lock`),
        with the generation read from `kernel_ro` after the lock, as `deliver()` reads it; the lock goes at the commit,
        before any kernel call. A turn that skips it goes on, and the kernel fences what it does at the old
        generation."""
        conn, caller = self.conn, self.caller
        await run_lock(conn, caller.session_id)
        session = await KernelRO(conn, caller.copy_id, caller.ro_schema).session(caller.session_id)
        if session is not None and session["generation"] == self.generation:
            await emit(conn, caller.ids, EvWriting(type="writing"))
        await conn.commit()

    async def _tell_waiting(self, through: int | None = None) -> TurnOutcome | None:
        """Tell the kernel the turn's language before anything is rendered in it (GitHub issue #121): the newest
        visitor or agent message waiting for the next model call (`store.latest_said`, up to `through` when given),
        whether or not it woke the turn, goes to `POST /sessions/{session_id}/turn` (`_tell`), and the kernel keeps
        the language it detects as the session's, which the turn's receipts and cards and the reply check's fallback
        then speak. The turn calls it right after the session and mode checks, so a paused or over-budget turn's
        handoff speaks it too, and before each model call (`_call`), where it sends only a message newer than the last
        it sent. Nothing waiting, nothing sent. How the turn ends when the kernel refuses, as it would on `/context`,
        else None."""
        said = await latest_said(self.conn, self.caller.session_id, through=through)
        await self.conn.commit()
        return await self._tell(said)

    async def _tell(self, said: Said | None) -> TurnOutcome | None:
        """Send `said` to `POST /sessions/{session_id}/turn`, cut to the contract's `TURN_TEXT_CHARS`, unless the turn
        already sent it or a newer message: once per newer message, which the route detects again by design. The text
        is untrusted and goes only to the kernel's detector: nothing here logs or keeps it. How the turn ends when the
        kernel refuses, as it would on `/context` (`_failed`), else None."""
        if said is None or (self.said_n is not None and said.n <= self.said_n):
            return None
        caller = self.caller
        try:
            await caller.kernel.call("POST /sessions/{session_id}/turn",
                                     TurnRequest(generation=self.generation, text=said.text[:TURN_TEXT_CHARS]),
                                     path={"session_id": caller.session_id})
        except KernelFailed as failure:
            return _failed(failure)
        except KernelUnavailable:
            return "kernel_unavailable"
        self.said_n = said.n
        return None

    async def _bring_up_to_date(self, context: SessionContext, system: list[dict]) -> None:
        """A `desk_context` row when the facts or knowledge changed, then the tool changes `/context` calls for:
        appended to the current context, or a fresh one.

        A fresh context also opens when the system prompt this turn renders isn't the one the context froze: a
        deploy changed the template, the owner renamed the business, the Desk or themselves, or the context opened
        before contexts froze their prompt. Each thinking block is bound to the prompt it was made under, so this
        is a deliberate boundary: the new prompt applies from the summary, and no earlier thinking is replayed.

        Only the recovery turn waits (`recovered`: the turn `_drain` runs so Claude reads the results of calls a stopped
        turn left open): when the context froze a prompt, it runs on that prompt, so Claude reads them where it made the
        calls, and the next turn opens the new one. Any other turn opens it at once, its summary carrying the results
        Claude hadn't read, so the wait is at most that one turn."""
        conn, ids = self.conn, self.caller.ids
        body = context_text(context.facts, context.knowledge)
        if context_hash(body) != await last_context_hash(conn, ids.session_id):
            await append_message(conn, ids, "desk_context", text=body)
        await append_time_note(conn, ids, context.clock)
        found = await context_tools(conn, ids.session_id)
        delta = tool_delta(None if found is None else FrozenTools.from_context(*found), context)
        for name in delta.remove:
            await append_tool_change(conn, ids, "tool_removal", name)
        for name in delta.add:
            await append_tool_change(conn, ids, "tool_addition", name)
        fresh = delta.fresh
        frozen = None if fresh else await context_system(conn, ids.session_id)
        if not fresh and frozen != system:
            if self.recovered and frozen is not None:
                logger.info("session %s: the system prompt changed; it applies after this recovery turn",
                            ids.session_id)
            else:
                logger.info("session %s: the system prompt changed since the model context opened: a fresh context "
                            "starts", ids.session_id)
                fresh = True
        if fresh:
            await start_fresh_context(conn, ids, model_tools(context), system=system)

    async def _call(self) -> ModelResponse | TurnOutcome | None:
        """One model call on the context as it stands (the system prompt and tools it froze, and its messages), its
        usage recorded at once; None when the model was unavailable. A 400 saying a replayed thinking block is bound
        to a different conversation calls once more on a fresh context (`_rebind`); a second one, like any other
        failure, is None.

        A visitor or agent message newer than the one the turn last sent `/turn` (one sent while the turn ran) joins
        this call, so it goes to `/turn` first (`_tell_waiting`), while it still waits: a refusal leaves it waiting
        for a turn, as `/context`'s does, and ends this one (its outcome is returned in place of a response). The
        call places rows only up to a cutoff read just before the look (`store.newest_row`), which first waits out any
        message still being written, under the events lock it holds until `_tell_waiting` commits, before `/turn`. So
        every message up to the cutoff is seen by the look, and one written after it keeps waiting for the next call,
        which tells the kernel first."""
        conn, caller = self.conn, self.caller
        while True:
            through = await newest_row(conn, caller.session_id)      # this call places nothing written after it
            refused = await self._tell_waiting(through)
            if refused is not None:
                return refused
            model_input = await prepare_model_input(conn, caller.session_id, through=through)
            await conn.commit()
            self.model_calls += 1
            try:
                response = await self.model.call(ModelRequest(route="conversation", system=model_input.system,
                                                              messages=model_input.messages, tools=model_input.tools))
                failed = None
            except ModelUnavailable as unavailable:
                response, failed = unavailable.response, unavailable
            self.returned_at = time.monotonic()
            await record_model_call(conn, caller.copy_id, caller.session_id, "conversation", response)
            await conn.commit()
            if not (isinstance(failed, ThinkingBoundElsewhere) and await self._rebind(failed)):
                return None if failed else response

    async def _rebind(self, failed: ThinkingBoundElsewhere) -> bool:
        """After a 400 saying a replayed thinking block is bound to a different conversation, start a fresh context
        through the summary path, as a changed prompt does, so the next call replays no thinking: once a turn, and
        only while the turn has a model call left. Whether it did; either way the log names the session and the
        refused block's path (no content)."""
        context = None if self.rebound or self.model_calls >= MAX_MODEL_CALLS else self.context
        logger.warning("session %s: a replayed thinking block (%s) was bound to a different conversation: %s",
                       self.caller.session_id, failed.path or "no path given",
                       "the turn hands off" if context is None else "a fresh context starts")
        if context is None:
            return False
        self.rebound = True
        await start_fresh_context(self.conn, self.caller.ids, model_tools(context), system=self.system)
        await self.conn.commit()
        return True

    async def _act(self, response: ModelResponse | None) -> TurnOutcome | None:
        """Act on a response by its stop reason; None calls Claude again. No response (the model was unavailable),
        a refusal, a cut-off answer or any stop reason the loop doesn't know hands off."""
        if response is None:
            return await self._hand_off()
        content = response.content
        tool_uses = [block for block in content if block.get("type") == "tool_use"]
        if response.stop_reason == "tool_use" and tool_uses:
            return await self._tool_use(content, tool_uses)
        await self._store(content, tool_uses)
        if response.stop_reason == "end_turn":
            return await self._end_turn(content)
        if response.stop_reason == "pause_turn":           # the model paused its own turn: let it carry on
            return None
        return await self._hand_off()

    async def _store(self, content: list[dict], tool_uses: list[dict]) -> None:
        """Keep a response that runs no tools, as it came, with any call in it answered `not_run`. A response with
        nothing but thinking and blank text is left out, as a retry would leave it: there is nothing to replay, and
        the Messages API refuses blank text blocks."""
        if all(block.get("type") in THINKING or (block.get("type") == "text" and not block["text"].strip())
               for block in content):
            return
        assistant_n = await append_assistant(self.conn, self.caller.ids, content, generation=self.generation)
        if tool_uses:
            await append_tool_results(self.conn, self.caller.ids, assistant_n,
                                      [not_run().block(block["id"]) for block in tool_uses])
        await self.conn.commit()

    def _note(self, outcome: ToolOutcome) -> None:
        """Keep what the owner's annotations need from an outcome: an attempt the checkpoint stopped, a message of
        Claude's delivered."""
        if outcome.stopped is not None:
            self.stopped.append(outcome.stopped)
        if outcome.delivered is not None and outcome.message_id is not None:
            self.replied.append(outcome.message_id)

    async def _hand_off(self) -> TurnOutcome:
        """Hand the conversation to the owner: the handoff clause, checked by the kernel, then shown."""
        outcome = await hand_off(self.conn, self.caller, self.generation)
        self._note(outcome)
        stop = _stop([outcome])
        if stop is not None:
            return stop
        self.delivered = "handoff"
        return "handoff"

    def _ended(self) -> TurnOutcome:
        return "handoff" if self.delivered == "handoff" else "done"

    async def _end_turn(self, content: list[dict]) -> TurnOutcome | None:
        """Claude ended its turn. Its text goes out as prose, checked like any reply, unless a reply already went out
        this turn. When the kernel's call-back offer showed in the text's place, a note holds the result a reply call
        would have read (`shown_instead`), since no tool result tells Claude what the visitor saw."""
        prose = "\n\n".join(block["text"].strip() for block in content
                            if block.get("type") == "text" and block["text"].strip())
        if self.delivered is not None:
            return self._ended()
        if not prose:                                      # nothing to show: one more call, then the handoff
            self.empty_answers += 1
            return None if self.empty_answers == 1 else await self._hand_off()
        outcome = await self._reply({"prose": prose, "clauses": []}, None)
        stop = _stop([outcome])                            # no verdict, or a session that changed: stop as a call would
        if stop is not None:
            return stop
        if outcome.result["outcome"] == "blocked":         # once, with kinds a rewrite can fix: say why, call again
            violations = json.dumps({key: outcome.result[key] for key in ("violations", "diagnostics")},
                                    ensure_ascii=False)
            await append_message(self.conn, self.caller.ids, "note", text=NOTES["prose_blocked"] + "\n" + violations)
            await self.conn.commit()                       # with the stopped draft `_reply` kept for the owner
            return None
        if "shown_instead" in outcome.result:              # the call-back offer showed in the text's place, and no
            # tool result tells Claude so: a note holding the result a reply call would have read does
            await append_message(self.conn, self.caller.ids, "note",
                                 text=json.dumps(outcome.result, ensure_ascii=False))
            await self.conn.commit()
        return self._ended()

    async def _tool_use(self, content: list[dict], tool_uses: list[dict]) -> TurnOutcome | None:
        """Claude called tools. Its response is stored before any call runs. The other calls run together, each
        status shown as it is known; only then the replies, one at a time, so a reply never goes out (or spends an
        agent's request) while a sibling call still runs. One results row answers every call, in block order. A draft
        the check blocked (kept for the owner: `_reply`) commits with it, unless another reply's check follows: it then
        commits before that check, so no lock of the session is held across a kernel call, and it stays before
        whatever that reply shows. When a call showed an executed receipt, what the session still waits on is read
        before any reply is checked, while an agent's request is unspent (`_surface_settled`), unless the calls stop
        the turn for a reason that would fail every read (`LOOKS_AFTER`): the kernel out of reach, an agent's request
        already answered, the session ended. A fenced turn still looks: a take-over leaves the session's reads working.

        A call that raised before the kernel had it didn't run, and ends the turn with the static error. One that
        raised once the kernel may have had it is found by its call ID and settled (`_recover_raised`); if nothing
        can settle it (settling raised too, or its decision couldn't be looked up: `unread`), the response is left
        without its results row and the turn stops, so the session's next request answers it by call ID (`_recover`)
        before Claude is asked anything. So is an allow whose `/execute` couldn't reach the kernel and whose reads
        after found it not yet final (`unread` too): the next request runs it once, or gets its stored result, and
        Claude reads that, never `unavailable` for a call that ran. Any other call whose decision was found is
        answered however settling it ended, an `unknown` after a 409 whose decision couldn't be read included, so
        /execute is never sent again for it."""
        conn, ids = self.conn, self.caller.ids
        assistant_n = await append_assistant(conn, ids, content, generation=self.generation)
        await conn.commit()
        calls = [block for block in tool_uses if block["name"] != SEND_REPLY]
        routed = await asyncio.gather(*(self._route(block) for block in calls), return_exceptions=True)
        outcomes: dict[str, ToolOutcome] = {}
        unread: list[ToolOutcome] = []                     # calls left open as their outcomes couldn't be learned
        raised = False
        for block, outcome in zip(calls, routed, strict=True):
            if isinstance(outcome, NotSent):               # the kernel never had it: not run
                logger.warning("tool call %s didn't reach the kernel: %s", block["id"],
                               _raised(outcome.__cause__ or outcome))
                outcome, raised = not_run(), True
            elif isinstance(outcome, BaseException):       # the kernel may have had it: found by its call ID
                logger.warning("tool call %s raised %s", block["id"], _raised(outcome))
                outcome = await self._recover_raised(block)
                if outcome is None:                        # recovering it raised too: left open
                    raised = True
                    continue
            if outcome.unread:                             # its outcome couldn't be learned: left open
                unread.append(outcome)
                continue
            outcomes[block["id"]] = outcome
            self._note(outcome)
            self.decide_ms += outcome.decide_ms
            self.execute_ms += outcome.execute_ms
        self.tool_calls += len(calls)
        stop = _stop([*outcomes.values(), *unread]) or ("internal" if raised else None)
        if stop in LOOKS_AFTER and any(
                outcome.status is not None and outcome.status.phase == "receipt"
                and outcome.status.decision.state == "executed" for outcome in outcomes.values()):
            await _surface_settled(conn, self.caller)          # before a reply spends an agent's request
        if len(outcomes) < len(calls):                     # a call left open: no results row until it is settled
            return stop
        shown = kept = False
        for block in (block for block in tool_uses if block["name"] == SEND_REPLY):
            # A fenced turn's replies still go to the kernel, which fences them too (409 at a generation the session
            # has left; a paused session's check answers with its handoff). Any other stop, or one message of this
            # response already on screen, leaves them unchecked.
            if stop not in (None, "fenced") or shown:
                outcomes[block["id"]] = (ToolOutcome(dict(UNAVAILABLE), True) if stop == "kernel_unavailable"
                                         else not_run())
                continue
            if kept:                                       # the draft a sibling's check stopped, before this check
                await conn.commit()
            outcomes[block["id"]] = outcome = await self._reply(block["input"], block["id"])
            stop, shown, kept = stop or _stop([outcome]), outcome.delivered is not None, outcome.kept is not None
        await append_tool_results(conn, ids, assistant_n, [outcomes[block["id"]].block(block["id"])
                                                           for block in tool_uses])
        await conn.commit()
        if stop is not None:
            return stop
        if shown:
            return self._ended()
        return None                                        # Claude reads its results and goes on

    async def _route(self, block: dict) -> ToolOutcome:
        """One call, decided and run on a pooled connection of its own, so its status shows as soon as it is known.
        A call that fails on its way to the kernel (a block no call fits, no pooled connection left for it) raises
        `NotSent`: the kernel never had it."""
        try:
            tool_call(block)
            conn = await self.conn.engine.connect()
        except Exception as error:
            raise NotSent from error
        try:
            return await route_call(conn, self.caller, self.generation, block)
        finally:
            await conn.close()

    async def _recover_raised(self, block: dict) -> ToolOutcome | None:
        """A call whose routing raised once the kernel may have had it (a publication failed after `/decide` or
        `/execute`): found by its call ID and settled on the turn's connection (`recover_call`, never decided
        again), so Claude and the visitor learn what the kernel did. A take-over that lands first still leaves a call
        that ran answered from its decision (`_settle`), and stops the turn. None when that raises too."""
        try:
            return await recover_call(self.conn, self.caller, self.generation, block, made_at=self.generation,
                                      resumes_money=True)                  # the same turn, so the same request
        except Exception as error:
            logger.warning("recovering tool call %s raised %s", block["id"], _raised(error))
            await self.conn.rollback()
            return None

    async def _reply(self, tool_input: object, call_id: str | None) -> ToolOutcome:
        """One reply of Claude's at the turn's attempt (`tools.send_reply`), which Claude may still rewrite only on
        attempt 1 while the turn has a model call left (`call_left`; any other check is `final` for the kernel, in
        every kind of session). A draft the check stopped that Claude may rewrite is kept for the owner here, in the
        turn's transaction, which the caller commits with the result Claude reads and before any other kernel call
        (`_tool_use`, `_end_turn`)."""
        attempt = self.attempt
        outcome = await send_reply(self.conn, self.caller, self.generation, tool_input, attempt,
                                   call_left=self.model_calls < MAX_MODEL_CALLS, call_id=call_id)
        if outcome.kept is not None:
            await append_stopped_draft(self.conn, self.caller.ids, outcome.kept)
        self._note(outcome)
        if outcome.result["outcome"] == "blocked":
            self.attempt = 2
        if outcome.delivered is not None:
            self.delivered = outcome.delivered
            self.reveals.append(RevealMetric(message_id=outcome.message_id, model_finish_to_reveal_ms=_ms(
                self.returned_at), check_reply_ms=outcome.check_reply_ms, attempts=attempt))
        return outcome

    async def finish(self, outcome: TurnOutcome) -> None:
        """Show why the turn failed, if it did, record the turn's metrics and, for a visitor, end the turn on its
        stream (silent ends included); then leave the turn's triage and translations for the job queue, unless it
        handed off with no model call (paused, or past today's budget), which sets off no model call for the owner
        either: its handoff card, in the visitor's language, isn't translated."""
        conn, ids = self.conn, self.caller.ids
        if outcome in ERROR_CODES:
            await emit(conn, ids, EvError(type="error", code=ERROR_CODES[outcome]))
        for reveal in self.reveals:
            await append_metric(conn, ids, reveal)
        await append_metric(conn, ids, TurnMetric(
            turn_id="turn-" + secrets.token_hex(8), model_calls=self.model_calls, tool_calls=self.tool_calls,
            decide_ms=self.decide_ms, execute_ms=self.execute_ms, total_ms=_ms(self.started), outcome=outcome,
            rebound=self.rebound))
        if self.visitor:
            await emit(conn, ids, EvTurnEnd(type="turn_end"))
        await conn.commit()
        if not self.annotates:
            return
        await defer_turn_annotations(self.jobs, conn, ids, self.stopped, self.replied, limiter=self.limiter,
                                     ledger=RateLimitLedger(self.caller.kernel, desk_id=ids.desk_id,
                                                            session_id=ids.session_id))


async def run_turn(conn: AsyncConnection, caller: Caller, model: ModelClient, *, end_on_reply: bool = False,
                   production: bool = False, clock: Callable[[], datetime] = _utc_now,
                   jobs: procrastinate.App | None = None, limiter: RateLimiter | None = None,
                   recovered: bool = False) -> TurnOutcome:
    """Answer what is waiting in the caller's session, as the module docstring says; returns how the turn ended.
    `recovered` marks the turn `_drain` runs so Claude reads the results it recovered (`_bring_up_to_date`)."""
    turn = _Turn(conn, caller, model, end_on_reply, production, clock, jobs=jobs, limiter=limiter,
                 recovered=recovered)
    try:
        outcome = await turn.run()
    except Exception as error:                             # anything unexpected: the static error, never a silent end
        logger.error("a turn failed with %s", _raised(error))
        await conn.rollback()
        outcome = "internal"
    await turn.finish(outcome)
    return outcome


# Turns per session (Task 6) ---------------------------------------------------------------------------------

# The turn-lock pool: each running turn holds its session's lock on a connection of this pool, apart from the API's.
TURN_LOCK_POOL_SIZE = 10
# How long an agent's request waits for the turn running in its session (Plan 02b answers 409 `in_progress` after).
TURN_LOCK_WAIT_S = 30
LOCK_NOT_AVAILABLE = "55P03"                              # Postgres: lock_timeout ran out
PendingOutcome = TurnOutcome | Literal["busy", "idle"]
# Outcomes after which the session's next waiting work gets a turn.
GO_ON = frozenset({"done", "handoff", "idle"})


@contextlib.asynccontextmanager
async def turn_lock(engine: AsyncEngine, session_id: str, *, blocking: bool = False) -> AsyncIterator[bool]:
    """Hold the session's turn lock while the block runs; yields whether it was taken.

    The lock is a session-level advisory lock keyed by sha256("turn:" + session_id), held on a connection of the
    turn-lock pool `engine` for the whole turn, so it serializes a session's turns across workers and tasks.
    Without `blocking` (a visitor's request) a turn already holding it isn't waited for: `pg_try_advisory_lock`.
    With it (an agent's request, which answers only once its turn ran) it is waited for up to `TURN_LOCK_WAIT_S`.
    A pooled connection keeps session-level locks, so the lock is let go explicitly, and a connection that may
    still hold it (an error or a cancellation while taking or letting go) is closed instead of reused.
    """
    key = lock_key("turn:" + session_id)
    async with engine.connect() as conn:
        try:
            taken = await _take_lock(conn, key, blocking)
        except BaseException:
            await conn.invalidate()
            raise
        if not taken:
            yield False
            return
        try:
            yield True
        finally:
            try:
                await conn.execute(select(func.pg_advisory_unlock(key)))
                await conn.commit()
            except BaseException:
                await conn.invalidate()
                raise


async def _take_lock(conn: AsyncConnection, key: int, blocking: bool) -> bool:
    if not blocking:
        taken = (await conn.execute(select(func.pg_try_advisory_lock(key)))).scalar_one()
        await conn.commit()
        return taken
    # the wait's bound applies to this transaction only; the lock outlives it
    await conn.execute(select(func.set_config("lock_timeout", f"{round(TURN_LOCK_WAIT_S * 1000)}ms", True)))
    try:
        await conn.execute(select(func.pg_advisory_lock(key)))
    except DBAPIError as error:
        if getattr(error.orig, "sqlstate", None) != LOCK_NOT_AVAILABLE:
            raise
        await conn.rollback()
        return False
    await conn.commit()
    return True


async def run_pending(caller: Caller, model: ModelClient, *, engine: AsyncEngine, lock_engine: AsyncEngine,
                      production: bool, clock: Callable[[], datetime] = _utc_now, blocking: bool = False,
                      end_on_reply: bool = False, jobs: procrastinate.App | None = None,
                      limiter: RateLimiter | None = None, resend_since: datetime | None = None) -> PendingOutcome:
    """Run the caller's session's waiting work, one turn at a time, as a request does once it has stored its own.

    Takes the session's turn lock on `lock_engine` (the turn-lock pool), or returns "busy": the turn holding it runs
    this work too, since it looks for waiting work again after letting go and takes the lock back for any it finds.
    Under the lock, an interrupted turn's open tool calls are answered first (`_recover`), then turns run while work
    waits and the session is Claude's (`run_turn`, on a connection of `engine`, the API's pool); in mode `owner` the
    work waits for the hand-back. Returns "idle" when nothing was waiting, else how the last turn ended.

    With `end_on_reply` (an agent's request, whose signed nonce is spent by the turn's reply) one turn runs at most
    and nothing is looked for after it: work that woke the session meanwhile waits for the agent's next request,
    since another turn on the spent nonce could only fail. `resend_since` marks an agent's request sent again, whose
    first try began then: a call its tries left open may be resumed even when it moves money (`_drain`).

    It never raises but to be cancelled: an error outside a turn (no pooled connection, a recovery that broke) shows
    the static error when it can and returns "internal", leaving the work for the next request.
    """
    retry = False
    outcome: PendingOutcome = "idle"
    try:
        while True:
            async with turn_lock(lock_engine, caller.session_id, blocking=blocking and not retry) as taken:
                if not taken:
                    return outcome if retry else "busy"
                async with engine.connect() as conn:
                    outcome, left = await _drain(conn, caller, model, end_on_reply, production, clock, jobs,
                                                 limiter, resend_since)
            if outcome not in GO_ON or end_on_reply:
                return outcome
            async with engine.connect() as conn:
                waiting = await _waiting(conn, caller.session_id)
            if waiting is None or waiting == left:
                return outcome
            retry = True                                  # work arrived as the lock was let go: its request was busy
    except Exception as error:
        logger.error("running a session's turns failed with %s", _raised(error))
        try:
            async with engine.connect() as conn:
                await _end(conn, caller, model, "internal")
        except Exception as again:
            logger.error("the internal error couldn't be shown: %s", _raised(again))
        return "internal"


async def _drain(conn: AsyncConnection, caller: Caller, model: ModelClient, end_on_reply: bool, production: bool,
                 clock: Callable[[], datetime],
                 jobs: procrastinate.App | None = None,
                 limiter: RateLimiter | None = None,
                 resend_since: datetime | None = None) -> tuple[PendingOutcome, int | None]:
    """Under the turn lock: answer what an interrupted turn left open, then run turns while work waits. The recovered
    results get a turn of their own for Claude to read only when no recovered reply showed: a shown reply, a handoff
    included, had ended the turn, as it does in `_tool_use`.

    A turn that hands off with no model call (past the daily budget, or paused) stops the work it answers from waking
    turns (`clear_wake`), so neither this run nor the next request's hands off again for it; work that arrives after
    it still gets a turn. Should work still wait after such a turn, no other turn is run for it here: its latest
    waiting row is returned with the outcome. With `end_on_reply` the first turn is the last (`run_pending`).

    A call left open moves money again only for the request that made it: an agent's request sent again
    (`resend_since`), whose tries wrote the open row since its first one began. Any other request answers such a call
    from its decision, never sending `/execute` (`tools.recover_call`)."""
    open_tool_use = await unanswered_tool_use(conn, caller.session_id)
    waiting = await _waiting(conn, caller.session_id)
    if open_tool_use is None and waiting is None:
        return "idle", None
    session = await _session(caller)
    if isinstance(session, str):
        return await _end(conn, caller, model, session), None
    must_call = False
    if open_tool_use is not None:
        same_request = resend_since is not None and open_tool_use.created_at >= resend_since
        recovered = await _recover(conn, caller, session.generation, open_tool_use, resumes_money=same_request)
        if (stop := _stop(recovered)) is not None:
            return await _end(conn, caller, model, stop), None
        shown = {outcome.delivered for outcome in recovered} - {None}
        must_call = not shown          # any shown reply ended the turn, a handoff included; else Claude reads them
    if session.mode == "owner":
        return "not_ai", None                             # the owner has the conversation: work waits for hand-back
    outcome: PendingOutcome = "idle"
    while must_call or waiting is not None:
        recovered, must_call = must_call, False          # only the first turn reads what was recovered
        outcome = await run_turn(conn, caller, model, end_on_reply=end_on_reply, production=production, clock=clock,
                                 jobs=jobs, limiter=limiter, recovered=recovered)
        if outcome not in GO_ON or end_on_reply:
            return outcome, None
        before, waiting = waiting, await _waiting(conn, caller.session_id)
        if waiting is not None and waiting == before:
            return outcome, waiting
    return outcome, None


async def _end(conn: AsyncConnection, caller: Caller, model: ModelClient, outcome: TurnOutcome) -> TurnOutcome:
    """End a turn that stopped before any model call, as `run_turn` ends one."""
    await _Turn(conn, caller, model, False, False, _utc_now).finish(outcome)
    return outcome


async def _recover(conn: AsyncConnection, caller: Caller, generation: int, open_tool_use: OpenToolUse, *,
                   resumes_money: bool = False) -> list[ToolOutcome]:
    """Answer the tool calls a turn left without results (it stopped after they went out), before any model call
    and never by deciding again: a reply is `delivered` when a `delivered` row carries its call ID, else `not_run`;
    any other call is found by its ID at the generation its turn ran at (`recover_call`), even after a take-over
    or a hand-back moved the session on (`generation`, the session's now).

    A call whose decision couldn't be looked up (`unread`: the kernel was out of reach) may have run, so the response
    keeps no results row: the outcomes stop the turn as the kernel being unavailable, and the next request tries
    again. Answering it `unavailable` would tell Claude a call that ran never did, and leave its receipt unshown."""
    outcomes = []
    for block in open_tool_use.tool_uses:
        if block["name"] == SEND_REPLY:
            outcomes.append(_recovered_reply(await delivered_reply(conn, caller.session_id, block["id"]), block))
            await conn.commit()
        else:
            outcomes.append(await recover_call(conn, caller, generation, block, made_at=open_tool_use.generation,
                                               resumes_money=resumes_money))
    if any(outcome.unread for outcome in outcomes):        # left open: the next request looks it up again
        return outcomes
    await append_tool_results(conn, caller.ids, open_tool_use.assistant_n, [
        outcome.block(block["id"]) for block, outcome in zip(open_tool_use.tool_uses, outcomes, strict=True)])
    await conn.commit()
    return outcomes


def _recovered_reply(shown: Any | None, block: dict) -> ToolOutcome:
    """A `send_reply` call's (`block`'s) result from its delivered row, as `send_reply` answered it: its event's
    handoff flag, `prose_shown` false when the prose the call drafted isn't among the shown blocks, and the kernel's
    call-back offer as `shown_instead` when that was shown in its place."""
    if shown is None:
        return not_run()
    result = delivered_result(shown.handoff, shown.ref_id,
                              prose_shown=not prose_unshown(block["input"], shown.blocks or []),
                              shown_instead=offer_shown_instead(block["input"], shown.blocks or []))
    return ToolOutcome(result, shown.handoff, delivered="handoff" if shown.handoff else "reply",
                       message_id=shown.ref_id)


async def _waiting(conn: AsyncConnection, session_id: str) -> int | None:
    """The session's latest waiting row (`latest_pending`), read in a transaction of its own."""
    found = await latest_pending(conn, session_id)
    await conn.commit()
    return found
