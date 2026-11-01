"""Jobs: the work the API process leaves for later, run by a Procrastinate worker inside the same process (Plan 02a,
Task 8; master plan, "Resuming the conversation" and "Decision lifecycle").

A job's arguments are IDs and signed kernel records only, never a credential: no token, key or code reaches
`procrastinate.*`. So no job calls the kernel. What needs a credential is left as a control row (`app.run_events`)
for the session's next request, which holds the visitor's own (`runner.TurnRunner`): the open event stream or the
next message.

- `resume_after_answer(copy_id, desk_id, session_id, decision, approved=None, result_fact_ids=None)`, deferred once
  the owner answered a held request: in one transaction, the optional signed `approved` snapshot as a `receipt`,
  then the signed outcome as `resolved`, each with its owner-only reason stripped and its signed fields unchanged.
  Only the outcome adds an `action_update` row that wakes Claude and names the executed answer's result facts,
  and a `run_resumable` control row, which the visitor's next request handles by running Claude's follow-up with
  the visitor's credential. A decision whose outcome may still change (an `unknown` execution) also leaves a
  `decision_pending` row, so its final state is shown once it has one. Idempotent: a state already shown writes
  nothing, so a repeated or retried job, or a status another path showed first, adds nothing. Nor does a job that
  runs late, once a later state of its decision is shown (the visitor's next request found the approval executed,
  or an `unknown` outcome reconciled): the visitor never sees a decision go back.
- `surface_due_decisions`, each minute: every decision the visitor was shown as held, or that an unhandled
  `decision_pending` row names, whose final state isn't shown yet, and whose kernel_ro state is final or whose
  `expires_at` has passed (expiry is lazy: the kernel applies it on the next read) gets one `decision_due` control
  row. The session's next request reads the decision with its own credential and shows its final state; until
  then the decision isn't read again.
- `retry_stalled_jobs`, every 10 minutes and one at a time: jobs whose worker stopped sending heartbeats (a task
  that died mid-job) go back to `todo`, as Procrastinate documents ("Retry stalled jobs").
- `triage_attempt(copy_id, desk_id, session_id, ref_id, ref_kind)` and `translate_message(copy_id, message_id)`
  (Plan 02b, Task 10): AI-written text for the owner alone (`triage.py`), the only jobs that call the model. A turn
  defers a triage for each attempt the checkpoint stopped, and a translation for each reply of Claude's the kernel
  rendered in another language than English (`defer_turn_annotations`); the visitor's and the agent's routes defer
  one for each message they store (`defer_translation`), but none for a message to a paused chat, which the kernel's
  handoff answers with no model call. Each translation counts on the conversation's `translate` limit first
  (`translating`), and past it isn't queued: the owner reads the message as sent. Queueing one never fails what
  deferred it: a queue that can't take it is logged, and that annotation is simply missing.

**Two queues, two workers.** A job that waits on the model never stands in front of one a visitor waits for. The
resume job and the periodic ones run on `QUEUE`, one at a time, on the worker named `WORKER`, which listens for new
jobs. The triage and translation jobs run on `ANNOTATION_QUEUE`, on a worker of their own (`ANNOTATION_WORKER`),
`ANNOTATION_CONCURRENCY` at a time; each of their model calls gives up after `triage.ANNOTATION_TIMEOUT_S` a try. So
a Haiku call that is slow, retried or stalled delays other annotations at most, never the owner's answer reaching
the visitor or the due-decision scan. That worker polls for jobs every `ANNOTATION_POLL_S` instead of listening:
an owner-only annotation can wait a second, and polling holds no connection open.

`jobs_app(connector)` builds the Procrastinate app; the API's lifespan opens it and runs `run_worker`, which runs
both workers. The connector is `desk.db.session.procrastinate_connector(url)`, its own small pool; tests use
Procrastinate's `InMemoryConnector`.
"""

import asyncio
import contextlib
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

from desk.api.deliver import NOT_FINAL, Status, deliver, run_lock, visitor_safe
from desk.api.model import ModelClient
from desk.api.ratelimit import RateLimited, RateLimiter, RateLimitLedger
from desk.api.ro import KERNEL_RO, due_decisions
from desk.api.sse import RUN_EVENTS, append_control
from desk.api.store import MESSAGES, Ids, append_message
from desk.api.triage import RefKind, Stopped, translate_message, triage_attempt
from desk.contracts import Decision

logger = logging.getLogger(__name__)

QUEUE = "desk"
ANNOTATION_QUEUE = "desk-annotations"   # the triage and translation jobs' own queue (module docstring)
RESUME_AFTER_ANSWER = "desk.resume_after_answer"
SURFACE_DUE_DECISIONS = "desk.surface_due_decisions"
RETRY_STALLED_JOBS = "desk.retry_stalled_jobs"
TRIAGE_ATTEMPT = "desk.triage_attempt"
TRANSLATE_MESSAGE = "desk.translate_message"
SCHEDULE = {SURFACE_DUE_DECISIONS: "* * * * *", RETRY_STALLED_JOBS: "*/10 * * * *"}
SHUTDOWN_GRACE_S = 5.0             # a stopping worker waits this long for its running jobs
RESTART_S = 5.0                    # a failed worker starts again after this long
ENV = "desk"                       # the worker's `additional_context` key for the jobs' `JobEnv`
WORKER = "desk-api"                # the worker's name: Procrastinate logs its jobs on `procrastinate.worker.desk-api`
ANNOTATION_WORKER = "desk-api-annotations"  # the annotation queue's worker, logging on its own name likewise
ANNOTATION_CONCURRENCY = 4         # annotation jobs the worker runs at once
ANNOTATION_POLL_S = 1.0            # the annotation worker looks for new jobs this often (it doesn't listen)
# Each worker's name and options: the queues it runs and how.
WORKERS: dict[str, dict[str, Any]] = {
    WORKER: {"queues": [QUEUE]},
    ANNOTATION_WORKER: {"queues": [ANNOTATION_QUEUE], "concurrency": ANNOTATION_CONCURRENCY, "listen_notify": False,
                        "fetch_job_polling_interval": ANNOTATION_POLL_S},
}
EXPIRES = frozenset({"allowed", "held"})    # the states the kernel expires lazily, on its next read


@dataclass(frozen=True)
class JobEnv:
    """What jobs run with: the API's database engine, where kernel_ro is read (`kernel_ro`; the fake's mirror in
    tests), the process's clock, and for the triage and translation jobs the API's model client and whether this is
    production (where today's model budget applies)."""

    engine: AsyncEngine
    ro_schema: str
    clock: Callable[[], datetime]
    model: ModelClient | None = None
    production: bool = False


def jobs_app(connector: BaseConnector, *, schedule: bool = True) -> procrastinate.App:
    """The Procrastinate app and its tasks; with `schedule`, its worker defers the periodic ones (`SCHEDULE`)."""
    app = procrastinate.App(connector=connector)

    @app.task(name=RESUME_AFTER_ANSWER, queue=QUEUE, pass_context=True)
    async def resume_after_answer_job(context: JobContext, copy_id: str, desk_id: str, session_id: str,
                                      decision: dict, approved: dict | None = None, *,
                                      result_fact_ids: list[str] | None = None) -> None:
        env = _env(context)
        async with env.engine.connect() as conn:
            await resume_after_answer(conn, Ids(copy_id=copy_id, desk_id=desk_id, session_id=session_id),
                                      Decision.model_validate(decision),
                                      Decision.model_validate(approved) if approved is not None else None,
                                      result_fact_ids=result_fact_ids)

    @app.task(name=SURFACE_DUE_DECISIONS, queue=QUEUE, pass_context=True)
    async def surface_due_decisions_job(context: JobContext, timestamp: int) -> None:
        env = _env(context)
        await surface_due_decisions(env.engine, now=env.clock(), ro_schema=env.ro_schema)

    @app.task(name=RETRY_STALLED_JOBS, queue=QUEUE, queueing_lock=RETRY_STALLED_JOBS, pass_context=True)
    async def retry_stalled_jobs_job(context: JobContext, timestamp: int) -> None:
        await retry_stalled_jobs(context.app.job_manager)

    @app.task(name=TRIAGE_ATTEMPT, queue=ANNOTATION_QUEUE, pass_context=True)
    async def triage_attempt_job(context: JobContext, copy_id: str, desk_id: str, session_id: str, ref_id: str,
                                 ref_kind: RefKind) -> None:
        env = _env(context)
        await triage_attempt(env.engine, _model(env), Ids(copy_id=copy_id, desk_id=desk_id, session_id=session_id),
                             ref_id, ref_kind, ro_schema=env.ro_schema, production=env.production, clock=env.clock)

    @app.task(name=TRANSLATE_MESSAGE, queue=ANNOTATION_QUEUE, pass_context=True)
    async def translate_message_job(context: JobContext, copy_id: str, message_id: str) -> None:
        env = _env(context)
        await translate_message(env.engine, _model(env), copy_id, message_id, production=env.production,
                                clock=env.clock)

    if schedule:
        for task in (surface_due_decisions_job, retry_stalled_jobs_job):
            app.periodic(cron=SCHEDULE[task.name], periodic_id=task.name)(task)
    return app


def _env(context: JobContext) -> JobEnv:
    env = context.additional_context.get(ENV)
    if not isinstance(env, JobEnv):
        raise RuntimeError("a job runs only in the API's worker (run_worker)")
    return env


def _model(env: JobEnv) -> ModelClient:
    if env.model is None:
        raise RuntimeError("the triage and translation jobs run only with the API's model client")
    return env.model


async def run_worker(app: procrastinate.App, env: JobEnv) -> None:
    """Run both queues' jobs, each on its own worker (`WORKERS`, module docstring), and, when scheduled, defer the
    periodic ones, until cancelled; a stopping worker lets its running jobs finish for a few seconds. Signals are the
    server's, not the workers'. Each worker that fails, or stops on its own (Procrastinate stops one whose listener
    lost the database), is started again on its own, its error logged by type only: its jobs wait in their queue
    meanwhile, and the other worker runs on. Both workers defer the periodic jobs; the job queue's database defers
    each once."""
    async with asyncio.TaskGroup() as workers:
        for name, options in WORKERS.items():
            workers.create_task(_keep_running(app, env, name, options), name=f"desk-jobs-{name}")


async def _keep_running(app: procrastinate.App, env: JobEnv, name: str, options: dict[str, Any]) -> None:
    while True:
        try:
            await app.run_worker_async(name=name, install_signal_handlers=False, additional_context={ENV: env},
                                       shutdown_graceful_timeout=SHUTDOWN_GRACE_S, **options)
            logger.error("the job worker %s stopped; starting it again", name)
        except Exception as error:
            logger.error("the job worker %s stopped with %s; starting it again", name, type(error).__name__)
        await asyncio.sleep(RESTART_S)


async def defer_resume_after_answer(app: procrastinate.App, ids: Ids, decision: Decision,
                                    approved: Decision | None = None, *,
                                    result_fact_ids: list[str] | None = None) -> None:
    """Queue IDs, the signed outcome, its optional approved snapshot and executed result fact IDs only.
    Exclude the owner-only reason and key; result claims and model_view never enter the queue. The result fact IDs are
    queued only when an executed outcome has some, so a job queued during a rolling deploy without them still runs on
    an older worker whose resume job doesn't take them."""
    if decision.session_id != ids.session_id:
        raise ValueError("a decision resumes only its own session")
    decision = visitor_safe(decision)
    approved = visitor_safe(approved) if approved is not None else None
    results = {"result_fact_ids": list(result_fact_ids)} if decision.state == "executed" and result_fact_ids else {}
    await app.configure_task(RESUME_AFTER_ANSWER).defer_async(
        copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id,
        decision=decision.model_dump(mode="json", exclude={"owner_plain"}),
        approved=approved.model_dump(mode="json", exclude={"owner_plain"}) if approved is not None else None,
        **results)


async def defer_triage(app: procrastinate.App, ids: Ids, stopped: Stopped) -> None:
    """Leave a stopped attempt for the triage job: the session's IDs and the attempt's, nothing else."""
    await app.configure_task(TRIAGE_ATTEMPT).defer_async(
        copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id, ref_id=stopped.ref_id,
        ref_kind=stopped.ref_kind)


async def translating(limiter: RateLimiter | None, ids: Ids, ledger: RateLimitLedger) -> bool:
    """Whether the conversation may have one more owner translation: a hit on its `translate` limit, the window's first
    refusal ledgered with the caller's credential. Without a limiter there is none."""
    if limiter is None:
        return False
    try:
        await limiter.enforce("translate", ids.session_id, ledger=ledger)
    except RateLimited:
        logger.info("a conversation's translations are past their limit; the owner reads the message as sent")
        return False
    return True


async def defer_translation(app: procrastinate.App | None, ids: Ids, message_id: str, *,
                            limiter: RateLimiter | None, ledger: RateLimitLedger) -> None:
    """Leave a stored message of the session's for the translation job, by its `message_id`, once the conversation's
    `translate` limit admits it (`translating`). Never raises: a queue that can't take it is logged by the error's
    type, and the owner sees the message untranslated, as past the limit."""
    if app is None or not await translating(limiter, ids, ledger):
        return
    try:
        await app.configure_task(TRANSLATE_MESSAGE).defer_async(copy_id=ids.copy_id, message_id=message_id)
    except Exception as error:
        logger.error("a translation couldn't be queued (%s)", type(error).__name__)


async def defer_turn_annotations(app: procrastinate.App | None, conn: AsyncConnection, ids: Ids,
                                 stopped: list[Stopped], replied: list[str], *, limiter: RateLimiter | None = None,
                                 ledger: RateLimitLedger | None = None) -> None:
    """After a turn: a triage for each attempt it saw stopped, and a translation for each reply of Claude's it
    delivered (`replied`, by the kernel's `message_id`) that the kernel rendered in another language than English,
    each counted on the conversation's `translate` limit (`defer_translation`; none without `limiter` and `ledger`).
    Never raises, so it never changes how the turn ends: each one that can't be queued is logged by the error's type
    and left out. Reads in a transaction of its own on `conn`."""
    if app is None or not (stopped or replied):
        return
    translate: list[str] = []
    if replied:
        try:
            rows = await conn.execute(select(MESSAGES.c.message_id).where(
                MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id,
                MESSAGES.c.kind == "delivered", MESSAGES.c.author == "claude", MESSAGES.c.ref_id.in_(replied),
                MESSAGES.c.language.is_distinct_from("en")).order_by(MESSAGES.c.n))
            translate = [message_id for (message_id,) in rows]
            await conn.commit()
        except Exception as error:
            logger.error("a turn's replies couldn't be read for translation (%s)", type(error).__name__)
            with contextlib.suppress(Exception):
                await conn.rollback()
    for attempt in dict.fromkeys(stopped):
        try:
            await defer_triage(app, ids, attempt)
        except Exception as error:
            logger.error("a triage couldn't be queued (%s)", type(error).__name__)
    if ledger is None:
        return
    for message_id in translate:
        await defer_translation(app, ids, message_id, limiter=limiter, ledger=ledger)


# The jobs ----------------------------------------------------------------------------------------------------


async def resume_after_answer(conn: AsyncConnection, ids: Ids, decision: Decision,
                              approved: Decision | None = None, *,
                              result_fact_ids: list[str] | None = None) -> bool:
    """Show the approved snapshot before the outcome and resume once, in one transaction (module docstring).
    Only the executed outcome's action update names result facts. Without a snapshot (including older jobs),
    show only the outcome. True when this call showed the outcome, False when that state, or a later one,
    was already shown."""
    if approved is not None and (approved.decision_id != decision.decision_id
                                 or approved.state != "approved"
                                 or approved.ledger_seq >= decision.ledger_seq):
        logger.warning("an approved snapshot doesn't match its outcome; showing only the outcome")
        approved = None
    if decision.session_id != ids.session_id:
        raise ValueError("a decision resumes only its own session")
    decision = visitor_safe(decision)
    approved = visitor_safe(approved) if approved is not None else None
    await conn.commit()                                    # a READ COMMITTED transaction of its own, for deliver()
    try:
        await run_lock(conn, ids.session_id)               # what the session shows can't change until this commits
        if approved is not None:
            await deliver(conn, ids, Status(approved, "receipt"))
        if await deliver(conn, ids, Status(decision, "resolved")) is None:     # that state, or a later one, shown
            await conn.rollback()
            return False
        await append_message(conn, ids, "action_update", text=decision.visitor_plain, ref_id=decision.decision_id,
                             state=decision.state,
                             result_fact_ids=(result_fact_ids or ()) if decision.state == "executed" else ())
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
    state shown in its session yet and no unhandled `decision_due` row (it is due already: a visitor who never comes
    back leaves that row waiting, and the decision isn't read again each minute): (copy_id, desk_id, session_id,
    decision_id)."""
    row, shown, due = RUN_EVENTS.alias("waiting"), RUN_EVENTS.alias("shown"), RUN_EVENTS.alias("due")
    decision_id = row.c.payload["decision_id"].astext
    final_shown = exists().where(
        shown.c.session_id == row.c.session_id, shown.c.kind == "sse", shown.c.type.in_(("receipt", "resolved")),
        shown.c.payload["decision_id"].astext == decision_id, shown.c.payload["state"].astext.not_in(sorted(NOT_FINAL)))
    due_already = exists().where(
        due.c.session_id == row.c.session_id, due.c.kind == "control", due.c.type == "decision_due",
        due.c.handled_at.is_(None), due.c.payload["decision_id"].astext == decision_id)
    return select(row.c.copy_id, row.c.desk_id, row.c.session_id, decision_id.label("decision_id")).distinct().where(
        or_(and_(row.c.kind == "sse", row.c.type == "held"),
            and_(row.c.kind == "control", row.c.type == "decision_pending", row.c.handled_at.is_(None))),
        ~final_shown, ~due_already)


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
