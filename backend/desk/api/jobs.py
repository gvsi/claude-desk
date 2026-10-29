"""Jobs: the work the API process leaves for later, run by a Procrastinate worker inside the same process (Plan 02a,
Task 8; master plan, "Resuming the conversation" and "Decision lifecycle").

A job's arguments are IDs and signed kernel records only, never a credential: no token, key or code reaches
`procrastinate.*`. So no job calls the kernel. What needs a credential is left as a control row (`app.run_events`)
for the session's next request, which holds the visitor's own (`runner.TurnRunner`): the open event stream or the
next message.

- `resume_after_answer(copy_id, desk_id, session_id, decision)`, deferred once the owner answered a held request:
  in one transaction, the decision as the kernel signed it, shown to the visitor as `resolved`; an `action_update`
  row that wakes Claude; and a `run_resumable` control row, which the visitor's next request handles by running
  Claude's follow-up with the visitor's credential. A decision whose outcome may still change (an `unknown`
  execution) also leaves a `decision_pending` row, so its final state is shown once it has one. Idempotent: a
  state already shown writes nothing, so a repeated or retried job, or a status another path showed first, adds
  nothing. Nor does a job that runs late, once a later state of its decision is shown (the visitor's next request
  found the approval executed, or an `unknown` outcome reconciled): the visitor never sees a decision go back.
- `surface_due_decisions`, each minute: every decision the visitor was shown as held, or that an unhandled
  `decision_pending` row names, whose final state isn't shown yet, and whose kernel_ro state is final or whose
  `expires_at` has passed (expiry is lazy: the kernel applies it on the next read) gets one `decision_due` control
  row. The session's next request reads the decision with its own credential and shows its final state.
- `retry_stalled_jobs`, every 10 minutes and one at a time: jobs whose worker stopped sending heartbeats (a task
  that died mid-job) go back to `todo`, as Procrastinate documents ("Retry stalled jobs").

`jobs_app(connector)` builds the Procrastinate app; the API's lifespan opens it and runs `run_worker`. The
connector is `desk.db.session.procrastinate_connector(url)`, its own small pool; tests use Procrastinate's
`InMemoryConnector`.
"""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import procrastinate
from procrastinate import JobContext
from procrastinate.connector import BaseConnector
from procrastinate.manager import JobManager
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.deliver import NOT_FINAL, Status, deliver, run_lock
from desk.api.ro import KERNEL_RO, due_decisions
from desk.api.sse import RUN_EVENTS, append_control
from desk.api.store import Ids, append_message
from desk.contracts import Decision

logger = logging.getLogger(__name__)

QUEUE = "desk"
RESUME_AFTER_ANSWER = "desk.resume_after_answer"
SURFACE_DUE_DECISIONS = "desk.surface_due_decisions"
RETRY_STALLED_JOBS = "desk.retry_stalled_jobs"
SCHEDULE = {SURFACE_DUE_DECISIONS: "* * * * *", RETRY_STALLED_JOBS: "*/10 * * * *"}
SHUTDOWN_GRACE_S = 5.0             # a stopping worker waits this long for its running jobs
RESTART_S = 5.0                    # a failed worker starts again after this long
ENV = "desk"                       # the worker's `additional_context` key for the jobs' `JobEnv`
WORKER = "desk-api"                # the worker's name: Procrastinate logs its jobs on `procrastinate.worker.desk-api`
EXPIRES = frozenset({"allowed", "held"})    # the states the kernel expires lazily, on its next read


@dataclass(frozen=True)
class JobEnv:
    """What jobs run with: the API's database engine, where kernel_ro is read (`kernel_ro`; the fake's mirror in
    tests) and the process's clock."""

    engine: AsyncEngine
    ro_schema: str
    clock: Callable[[], datetime]


def jobs_app(connector: BaseConnector, *, schedule: bool = True) -> procrastinate.App:
    """The Procrastinate app and its tasks; with `schedule`, its worker defers the periodic ones (`SCHEDULE`)."""
    app = procrastinate.App(connector=connector)

    @app.task(name=RESUME_AFTER_ANSWER, queue=QUEUE, pass_context=True)
    async def resume_after_answer_job(context: JobContext, copy_id: str, desk_id: str, session_id: str,
                                      decision: dict) -> None:
        env = _env(context)
        async with env.engine.connect() as conn:
            await resume_after_answer(conn, Ids(copy_id=copy_id, desk_id=desk_id, session_id=session_id),
                                      Decision.model_validate(decision))

    @app.task(name=SURFACE_DUE_DECISIONS, queue=QUEUE, pass_context=True)
    async def surface_due_decisions_job(context: JobContext, timestamp: int) -> None:
        env = _env(context)
        await surface_due_decisions(env.engine, now=env.clock(), ro_schema=env.ro_schema)

    @app.task(name=RETRY_STALLED_JOBS, queue=QUEUE, queueing_lock=RETRY_STALLED_JOBS, pass_context=True)
    async def retry_stalled_jobs_job(context: JobContext, timestamp: int) -> None:
        await retry_stalled_jobs(context.app.job_manager)

    if schedule:
        for task in (surface_due_decisions_job, retry_stalled_jobs_job):
            app.periodic(cron=SCHEDULE[task.name], periodic_id=task.name)(task)
    return app


def _env(context: JobContext) -> JobEnv:
    env = context.additional_context.get(ENV)
    if not isinstance(env, JobEnv):
        raise RuntimeError("a job runs only in the API's worker (run_worker)")
    return env


async def run_worker(app: procrastinate.App, env: JobEnv) -> None:
    """Run the queue's jobs (and, when scheduled, defer the periodic ones) until cancelled; a stopping worker lets its
    running jobs finish for a few seconds. Signals are the server's, not the worker's. A worker that fails, or stops
    on its own (Procrastinate stops one whose listener lost the database), is started again, its error logged by type
    only: jobs wait in the queue meanwhile."""
    while True:
        try:
            await app.run_worker_async(queues=[QUEUE], name=WORKER, install_signal_handlers=False,
                                       additional_context={ENV: env}, shutdown_graceful_timeout=SHUTDOWN_GRACE_S)
            logger.error("the job worker stopped; starting it again")
        except Exception as error:
            logger.error("the job worker stopped with %s; starting it again", type(error).__name__)
        await asyncio.sleep(RESTART_S)


async def defer_resume_after_answer(app: procrastinate.App, ids: Ids, decision: Decision) -> None:
    """Leave the owner's answer for the resume job: the session's IDs and the decision the kernel signed, nothing
    else."""
    if decision.session_id != ids.session_id:
        raise ValueError("a decision resumes only its own session")
    await app.configure_task(RESUME_AFTER_ANSWER).defer_async(
        copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id, decision=decision.model_dump(mode="json"))


# The jobs ----------------------------------------------------------------------------------------------------


async def resume_after_answer(conn: AsyncConnection, ids: Ids, decision: Decision) -> bool:
    """Show the answered decision and resume the conversation, in one transaction on `conn` (module docstring); True
    when this call showed it, False when that state, or a later one, was already shown."""
    if decision.session_id != ids.session_id:
        raise ValueError("a decision resumes only its own session")
    await conn.commit()                                    # a READ COMMITTED transaction of its own, for deliver()
    try:
        await run_lock(conn, ids.session_id)               # what the session shows can't change until this commits
        if await deliver(conn, ids, Status(decision, "resolved")) is None:     # that state, or a later one, shown
            await conn.rollback()
            return False
        await append_message(conn, ids, "action_update", text=decision.visitor_plain, ref_id=decision.decision_id,
                             state=decision.state)
        await append_control(conn, ids, "run_resumable", {"decision_id": decision.decision_id})
        if decision.state in NOT_FINAL:
            await append_control(conn, ids, "decision_pending", {"decision_id": decision.decision_id})
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
    return True


def _waiting_decisions() -> Any:
    """Each decision the visitor was shown as held, or that an unhandled `decision_pending` row names, with no final
    state shown in its session yet: (copy_id, desk_id, session_id, decision_id)."""
    row, shown = RUN_EVENTS.alias("waiting"), RUN_EVENTS.alias("shown")
    decision_id = row.c.payload["decision_id"].astext
    final_shown = exists().where(
        shown.c.session_id == row.c.session_id, shown.c.kind == "sse", shown.c.type.in_(("receipt", "resolved")),
        shown.c.payload["decision_id"].astext == decision_id, shown.c.payload["state"].astext.not_in(sorted(NOT_FINAL)))
    return select(row.c.copy_id, row.c.desk_id, row.c.session_id, decision_id.label("decision_id")).distinct().where(
        or_(and_(row.c.kind == "sse", row.c.type == "held"),
            and_(row.c.kind == "control", row.c.type == "decision_pending", row.c.handled_at.is_(None))),
        ~final_shown)


def _due(decision: dict, now: datetime) -> bool:
    """Final in kernel_ro, or an allow or hold whose time ran out (the kernel expires it on its next read)."""
    if decision["state"] not in NOT_FINAL:
        return True
    expires_at = decision["expires_at"]
    return decision["state"] in EXPIRES and expires_at is not None and expires_at <= now


async def surface_due_decisions(engine: AsyncEngine, *, now: datetime, ro_schema: str = KERNEL_RO) -> int:
    """Leave one `decision_due` control row for each waiting decision that is due (module docstring); returns how many
    it wrote. A decision already due and unhandled isn't written again."""
    async with engine.connect() as conn:
        waiting = {row.decision_id: row for row in await conn.execute(_waiting_decisions())}
        found = await due_decisions(conn, sorted(waiting), ro_schema)
        await conn.commit()
        written = 0
        for decision in found:
            row = waiting[decision["decision_id"]]
            if (decision["copy_id"], decision["session_id"]) != (row.copy_id, row.session_id) or not _due(decision,
                                                                                                          now):
                continue
            ids = Ids(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id)
            if await append_control(conn, ids, "decision_due", {"decision_id": decision["decision_id"]}) is not None:
                written += 1
            await conn.commit()
        return written


async def retry_stalled_jobs(job_manager: JobManager) -> int:
    """Put every job whose worker stopped sending heartbeats back to `todo`; returns how many."""
    stalled = list(await job_manager.get_stalled_jobs())
    for job in stalled:
        await job_manager.retry_job(job)
    if stalled:
        logger.warning("retried %d stalled jobs", len(stalled))
    return len(stalled)
