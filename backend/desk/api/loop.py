"""Claude's turns: the agent loop (master plan, "Model-visible tools" loop contract, "Fail-closed behavior";
Plan 02a, Task 5).

`run_turn(conn, caller, model)` answers what is waiting in a session. It reads the session's mode and generation
from the kernel (`GET /whoami`) and its tools and facts (`GET /context`), brings the model context up to date
(a `desk_context` row when the facts change, tool changes or a fresh context), then calls Claude and acts on each
response by its stop reason. Claude only proposes: every tool call goes through `/decide` (`tools.route_call`),
and every reply through `/check_reply` and `deliver()` (`tools.send_reply`).
"""

import asyncio
import json
import logging
import secrets
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.metrics import RevealMetric, TurnMetric, over_daily_budget, record_model_call
from desk.api.model import ModelClient, ModelRequest, ModelResponse, ModelUnavailable
from desk.api.prompts import NOTES, DeskIdentity, conversation_system
from desk.api.ro import KernelRO
from desk.api.sse import append_metric, emit
from desk.api.store import (
    append_assistant,
    append_message,
    append_tool_change,
    append_tool_results,
    clear_wake,
    context_hash,
    context_text,
    context_tools,
    last_context_hash,
    prepare_model_input,
    start_fresh_context,
)
from desk.api.tools import (
    SEND_REPLY,
    UNAVAILABLE,
    Caller,
    FrozenTools,
    ToolOutcome,
    hand_off,
    model_tools,
    not_run,
    route_call,
    send_reply,
    tool_delta,
)
from desk.events import EvError, EvTurnEnd, EvWriting
from desk.kernel_api import SessionContext

TurnOutcome = Literal["done", "fenced", "session_ended", "kernel_unavailable", "handoff", "turn_over", "not_ai"]
logger = logging.getLogger(__name__)
# The model calls one turn may make before it hands off.
MAX_MODEL_CALLS = 6
THINKING = frozenset({"thinking", "redacted_thinking"})
# The static error a visitor sees when a turn fails ("Fail-closed behavior"); other ends are silent.
ERROR_CODES = {"session_ended": "session", "kernel_unavailable": "kernel_unavailable"}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


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

    @property
    def visitor(self) -> bool:
        return self.caller.kind == "visitor"

    async def run(self) -> TurnOutcome:
        conn, caller = self.conn, self.caller
        try:
            who = await caller.kernel.whoami()
        except KernelFailed as failure:
            return _failed(failure)
        except KernelUnavailable:
            return "kernel_unavailable"
        session = who.session
        if session is None or (who.copy_id, who.desk_id, session.session_id) != (
                caller.copy_id, caller.desk_id, caller.session_id):
            return "session_ended"                        # the credential no longer names this session
        self.generation = session.generation
        if session.mode == "owner":                        # the owner took over: Claude stays quiet
            return "not_ai"
        if session.mode == "paused":                       # the breaker tripped: the kernel's handoff, no model call
            await clear_wake(conn, caller.session_id)
            await conn.commit()
            return await self._hand_off()
        if self.production:                                # past today's model budget: the handoff, no model call
            over = await over_daily_budget(conn, self.clock)
            await conn.commit()
            if over:
                return await self._hand_off()
        if self.visitor:
            await emit(conn, caller.ids, EvWriting(type="writing"))
            await conn.commit()
        try:
            context = await caller.kernel.call("GET /context/{session_id}?desk_id=",
                                               path={"session_id": caller.session_id})
        except KernelFailed as failure:
            return _failed(failure)
        except KernelUnavailable:
            return "kernel_unavailable"
        await self._bring_up_to_date(context)
        system = conversation_system(await desk_identity(conn, caller))
        await conn.commit()
        while True:
            if self.model_calls >= MAX_MODEL_CALLS:
                return await self._hand_off()
            response = await self._call(system)
            outcome = await self._act(response)
            if outcome is not None:
                return outcome

    async def _bring_up_to_date(self, context: SessionContext) -> None:
        """A `desk_context` row when the facts or knowledge changed, then the tool changes `/context` calls for:
        appended to the current context, or a fresh one."""
        conn, ids = self.conn, self.caller.ids
        body = context_text(context.facts, context.knowledge)
        if context_hash(body) != await last_context_hash(conn, ids.session_id):
            await append_message(conn, ids, "desk_context", text=body)
        found = await context_tools(conn, ids.session_id)
        delta = tool_delta(None if found is None else FrozenTools.from_context(*found), context)
        for name in delta.remove:
            await append_tool_change(conn, ids, "tool_removal", name)
        for name in delta.add:
            await append_tool_change(conn, ids, "tool_addition", name)
        if delta.fresh:
            await start_fresh_context(conn, ids, model_tools(context))

    async def _call(self, system: list[dict]) -> ModelResponse | None:
        """One model call on the context as it stands, its usage recorded at once; None when the model was
        unavailable."""
        conn, caller = self.conn, self.caller
        model_input = await prepare_model_input(conn, caller.session_id)
        await conn.commit()
        self.model_calls += 1
        try:
            response = await self.model.call(ModelRequest(route="conversation", system=system,
                                                          messages=model_input.messages, tools=model_input.tools))
            failed = None
        except ModelUnavailable as unavailable:
            response, failed = unavailable.response, unavailable
        self.returned_at = time.monotonic()
        await record_model_call(conn, caller.copy_id, caller.session_id, "conversation", response)
        await conn.commit()
        return None if failed else response

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
        assistant_n = await append_assistant(self.conn, self.caller.ids, content)
        if tool_uses:
            await append_tool_results(self.conn, self.caller.ids, assistant_n,
                                      [not_run().block(block["id"]) for block in tool_uses])
        await self.conn.commit()

    async def _hand_off(self) -> TurnOutcome:
        """Hand the conversation to the owner: the handoff clause, checked by the kernel, then shown."""
        outcome = await hand_off(self.conn, self.caller, self.generation)
        stop = _stop([outcome])
        if stop is not None:
            return stop
        self.delivered = "handoff"
        return "handoff"

    def _ended(self) -> TurnOutcome:
        return "handoff" if self.delivered == "handoff" else "done"

    async def _end_turn(self, content: list[dict]) -> TurnOutcome | None:
        """Claude ended its turn. Its text goes out as prose, checked like any reply, unless a reply already went out
        this turn."""
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
            violations = json.dumps({"violations": outcome.result["violations"]}, ensure_ascii=False)
            await append_message(self.conn, self.caller.ids, "note", text=NOTES["prose_blocked"] + "\n" + violations)
            await self.conn.commit()
            return None
        return self._ended()

    async def _tool_use(self, content: list[dict], tool_uses: list[dict]) -> TurnOutcome | None:
        """Claude called tools. Its response is stored before any call runs. The other calls run together, each
        status shown as it is known; only then the replies, one at a time, so a reply never goes out (or spends an
        agent's request) while a sibling call still runs. One results row answers every call, in block order."""
        conn, ids = self.conn, self.caller.ids
        assistant_n = await append_assistant(conn, ids, content)
        await conn.commit()
        calls = [block for block in tool_uses if block["name"] != SEND_REPLY]
        routed = await asyncio.gather(*(self._route(block) for block in calls), return_exceptions=True)
        outcomes: dict[str, ToolOutcome] = {}
        for block, outcome in zip(calls, routed, strict=True):
            if isinstance(outcome, BaseException):         # it never reached a result: not run, as far as Claude knows
                logger.warning("tool call %s raised %s", block["id"], type(outcome).__name__)
                outcome = not_run()
            outcomes[block["id"]] = outcome
            self.decide_ms += outcomes[block["id"]].decide_ms
            self.execute_ms += outcomes[block["id"]].execute_ms
        self.tool_calls += len(calls)
        stop = _stop(outcomes.values())
        shown = False
        for block in (block for block in tool_uses if block["name"] == SEND_REPLY):
            if stop is not None or shown:                  # stopped, or one message of this response is on screen
                outcomes[block["id"]] = (ToolOutcome(dict(UNAVAILABLE), True) if stop == "kernel_unavailable"
                                         else not_run())
                continue
            outcomes[block["id"]] = outcome = await self._reply(block["input"], block["id"])
            stop, shown = _stop([outcome]), outcome.delivered is not None
        await append_tool_results(conn, ids, assistant_n, [outcomes[block["id"]].block(block["id"])
                                                           for block in tool_uses])
        await conn.commit()
        if stop is not None:
            return stop
        if shown and (self.delivered == "reply" or self.end_on_reply):
            return self._ended()
        return None                                        # Claude reads its results (or the handoff) and goes on

    async def _route(self, block: dict) -> ToolOutcome:
        """One call, decided and run on a pooled connection of its own, so its status shows as soon as it is known."""
        async with self.conn.engine.connect() as conn:
            return await route_call(conn, self.caller, self.generation, block)

    async def _reply(self, tool_input: object, call_id: str | None) -> ToolOutcome:
        attempt = self.attempt
        outcome = await send_reply(self.conn, self.caller, self.generation, tool_input, attempt, call_id=call_id)
        if outcome.result["outcome"] == "blocked":
            self.attempt = 2
        if outcome.delivered is not None:
            self.delivered = outcome.delivered
            self.reveals.append(RevealMetric(message_id=outcome.message_id, model_finish_to_reveal_ms=_ms(
                self.returned_at), check_reply_ms=outcome.check_reply_ms, attempts=attempt))
        return outcome

    async def finish(self, outcome: TurnOutcome) -> None:
        """Show why the turn failed, if it did, record the turn's metrics and, for a visitor, end the turn on its
        stream (silent ends included)."""
        conn, ids = self.conn, self.caller.ids
        if outcome in ERROR_CODES:
            await emit(conn, ids, EvError(type="error", code=ERROR_CODES[outcome]))
        for reveal in self.reveals:
            await append_metric(conn, ids, reveal)
        await append_metric(conn, ids, TurnMetric(
            turn_id="turn-" + secrets.token_hex(8), model_calls=self.model_calls, tool_calls=self.tool_calls,
            decide_ms=self.decide_ms, execute_ms=self.execute_ms, total_ms=_ms(self.started), outcome=outcome))
        if self.visitor:
            await emit(conn, ids, EvTurnEnd(type="turn_end"))
        await conn.commit()


async def run_turn(conn: AsyncConnection, caller: Caller, model: ModelClient, *, end_on_reply: bool = False,
                   production: bool = False, clock: Callable[[], datetime] = _utc_now) -> TurnOutcome:
    """Answer what is waiting in the caller's session, as the module docstring says; returns how the turn ended."""
    turn = _Turn(conn, caller, model, end_on_reply, production, clock)
    outcome = await turn.run()
    await turn.finish(outcome)
    return outcome
