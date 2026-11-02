"""The work a visitor's requests start for their session, done with their credential (Plan 02a, Task 7; master
plan, "Resuming the conversation").

`TurnRunner.start(caller)` does the session's waiting work in a task of its own, one task per session in this
process, holding the caller (the IDs a kernel answer named and the view carrying its credential) in memory only:
first what the session's control rows left for its credential, then its turns (`loop.run_pending`). A start while
that task runs has it look again once it is done, so work stored meanwhile never waits for another request;
`run_pending` serializes turns across processes with the session's turn lock. The event stream starts it as it
opens and as each control row appears, so a hang-up never cuts that work short.

`TurnRunner.handle_control(conn, caller, row)` does what one control row (`app.run_events`, kind `control`) left
for the session's credential, with that credential, then starts the session's turns:

- `run_resumable` (an owner's answer resumed the conversation, Task 8): claimed.
- `decision_due` (a held request that may have expired or been answered, or that the session's own booking closed:
  left by the minute sweep, or by the turn whose call ran, `loop._surface_settled`) and `decision_pending` (an allow
  whose execution's outcome wasn't known when its turn ended): the decision is read with the session's own client
  (`GET /decisions/{id}`, which applies expiry and settles what a booking closed). Once it is final, one transaction
  claims the row, publishes the decision as the kernel signed it (`resolved`, or `receipt` for an allow) and, when
  that is new to the session, an `action_update` row that wakes a turn. A decision not yet final (`unknown`
  included: it is reconciled later), or one the kernel can't read now, leaves the row for a later request.

A paused session's work runs here too: its turn (`run_pending`, under the turn lock) stops the waiting work from
starting more turns and hands off once, with no model call.
"""

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

import procrastinate
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.deliver import NOT_FINAL, Status, deliver
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.loop import PendingOutcome, run_pending
from desk.api.model import ModelClient
from desk.api.ratelimit import RateLimiter
from desk.api.sse import ControlRow, being_cancelled, claim_control, unhandled_controls
from desk.api.store import append_message
from desk.api.tools import Caller
from desk.contracts import Decision

logger = logging.getLogger(__name__)
DECISION_ROWS = frozenset({"decision_due", "decision_pending"})


class TurnRunner:
    """The session work this process does, one task per session (module docstring)."""

    def __init__(self, model: ModelClient, *, engine: AsyncEngine, lock_engine: AsyncEngine, production: bool,
                 clock: Callable[[], datetime], jobs: procrastinate.App | None = None,
                 limiter: RateLimiter | None = None):
        self._model, self._engine, self._lock_engine = model, engine, lock_engine
        self._production, self._clock = production, clock
        self._jobs = jobs                         # the job queue the turns leave triage and translations for
        self._limiter = limiter                   # the process's limits, which bound a conversation's translations
        self._tasks: dict[str, asyncio.Task] = {}
        self._wanted: dict[str, Caller] = {}      # sessions whose task must look (again) for waiting work

    def start(self, caller: Caller) -> None:
        """Do the session's waiting work in its task, or, while that task runs, have it look again once it is done.
        Call it once what the request brought is committed."""
        self._wanted[caller.session_id] = caller
        if caller.session_id not in self._tasks:
            self._tasks[caller.session_id] = asyncio.create_task(self._run(caller.session_id),
                                                                 name="desk-session-work")

    def running(self, session_id: str) -> bool:
        return session_id in self._tasks

    async def run_agent_turn(self, caller: Caller, *, resend_since: datetime | None = None) -> PendingOutcome:
        """An agent's turn, run in its request (Plan 02b, Task 4): its session's waiting work, waiting up to 30 s for a
        turn already running there, and ended at Claude's reply, which answers the request. One turn only: the reply
        spends the request's nonce, so work that wakes meanwhile waits for the agent's next request. `resend_since`:
        the request is one sent again, whose first try began then (`loop.run_pending`)."""
        return await run_pending(caller, self._model, engine=self._engine, lock_engine=self._lock_engine,
                                 production=self._production, clock=self._clock, blocking=True, end_on_reply=True,
                                 jobs=self._jobs, limiter=self._limiter, resend_since=resend_since)

    async def _run(self, session_id: str) -> None:
        try:
            # Each pass covers every start made before it began, since those requests committed their work first.
            while (caller := self._wanted.pop(session_id, None)) is not None and not being_cancelled():
                await self._pass(caller)
        finally:
            del self._tasks[session_id]

    async def _pass(self, caller: Caller) -> None:
        """What the session's control rows left, then its turns. A failure is logged by type only (its message can
        carry contacts or tokens) and leaves the work for the next start; so does the process stopping."""
        try:
            async with self._engine.connect() as conn:
                await self.handle_controls(conn, caller)            # the turns below follow up on them
        except Exception as error:
            if not being_cancelled():
                logger.error("a session's control rows failed with %s", type(error).__name__)
        if being_cancelled():                                       # stopping: no turn starts now
            return
        try:
            await run_pending(caller, self._model, engine=self._engine, lock_engine=self._lock_engine,
                              production=self._production, clock=self._clock, jobs=self._jobs,
                              limiter=self._limiter)
        except Exception as error:                          # run_pending shows its own failures; this is a guard
            logger.error("a session's turns failed with %s", type(error).__name__)

    async def drain(self) -> None:
        """Wait until no session's work is running in this process."""
        while self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def close(self) -> None:
        """Cancel every running task (the process is stopping); their work waits for the session's next request."""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # Control rows ----------------------------------------------------------------------------------------------

    async def handle_controls(self, conn: AsyncConnection, caller: Caller) -> None:
        """Handle each of the session's waiting control rows (`handle_control`), each in a transaction of its own, but
        start nothing: a request starts the session's work once what it brought is stored too, so one turn answers
        both."""
        rows = await unhandled_controls(conn, caller.ids)
        await conn.commit()
        for row in rows:
            await self.handle_control(conn, caller, row, start=False)

    async def handle_control(self, conn: AsyncConnection, caller: Caller, row: ControlRow, *,
                             start: bool = True) -> bool:
        """Do what the row left for the session's credential (module docstring) on `conn`, committing what it
        publishes with its claim, then start the session's turns (unless `start` is False); True when this caller
        claimed it. Decision rows wake Claude only when they publish a new state. Kernel failures leave the row
        for a later request."""
        if (row.copy_id, row.session_id) != (caller.copy_id, caller.session_id):
            raise ValueError("a control row is handled only with its own session's credential")
        if row.type == "run_resumable":
            claimed = await claim_control(conn, row.id)
            await conn.commit()
            if claimed and start:
                self.start(caller)
            return claimed
        decision_id = row.payload.get("decision_id")
        if row.type not in DECISION_ROWS or not isinstance(decision_id, str) or not decision_id:
            logger.warning("a %s control row can't be handled", row.type)
            return False
        decision = await _read_decision(caller, decision_id)
        if decision is None or decision.state in NOT_FINAL:
            return False
        try:
            if not await claim_control(conn, row.id):          # another request handled it
                await conn.rollback()
                return False
            phase = "receipt" if decision.outcome == "allow" else "resolved"
            published = await deliver(conn, caller.ids, Status(decision, phase), ro_schema=caller.ro_schema) is not None
            if published:
                await append_message(conn, caller.ids, "action_update", text=decision.visitor_plain,
                                     ref_id=decision.decision_id, state=decision.state)
            await conn.commit()
        except BaseException:
            await conn.rollback()
            raise
        if start and published:
            self.start(caller)
        return True


async def _read_decision(caller: Caller, decision_id: str) -> Decision | None:
    """The decision as the kernel has it now, read with the session's credential; None when it can't be read now."""
    try:
        decision = await caller.kernel.call("GET /decisions/{id}", path={"id": decision_id})
    except (KernelFailed, KernelUnavailable) as failure:
        logger.warning("a waiting decision couldn't be read (%s)", type(failure).__name__)
        return None
    return decision if decision.session_id == caller.session_id else None
