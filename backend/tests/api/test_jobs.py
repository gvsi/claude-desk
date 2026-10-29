"""The API's jobs (Plan 02a, Task 8): the resume job an owner's answer defers, the minute job that surfaces decisions
gone final or past their time, and the retry of jobs a stopped worker left.

The jobs run here as the worker runs them, on the API's engine and FakeKernel's kernel_ro mirror, without a credential:
what they leave is read with the visitor's own credential on the session's next request (`TurnRunner`).
"""

import asyncio
from datetime import timedelta

import pytest
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

from desk.api.deliver import Status, deliver
from desk.api import jobs
from desk.api.jobs import (
    QUEUE,
    RETRY_STALLED_JOBS,
    SCHEDULE,
    SURFACE_DUE_DECISIONS,
    JobEnv,
    jobs_app,
    resume_after_answer,
    retry_stalled_jobs,
    run_worker,
    surface_due_decisions,
)
from desk.api.runner import TurnRunner
from desk.api.sse import append_control
from desk.api.tools import Caller
from desk.contracts import Decision, ToolCall
from desk.db.session import procrastinate_connector
from desk.kernel_api import AnswerRequest, CreateCopyRequest, CreateSessionRequest, DecideRequest, ExecuteRequest
from tests.api.fakes import ScriptedModel

DRAIN = {"items": [{"item_id": "drain", "qty": 1}]}


class Copy:
    """A Rivera copy on FakeKernel: its owner's view, and visitors whose requests the tests decide."""

    def __init__(self, kernel_http, fake, ro_schema: str):
        self.http, self.fake, self.ro_schema = kernel_http, fake, ro_schema

    async def open(self) -> "Copy":
        created = await self.http.public().call("POST /copies", CreateCopyRequest())
        self.owner = self.http.owner(created.owner_token)
        self.slug = self.fake.desks[created.desk_ids[0]].slug
        return self

    async def visitor(self) -> Caller:
        created = await self.http.public().call("POST /sessions", CreateSessionRequest(desk_slug=self.slug,
                                                                                         kind="visitor"))
        view = self.http.session(created.session_token)
        who = await view.whoami()
        return Caller(copy_id=who.copy_id, desk_id=who.desk_id, session_id=who.session.session_id, kind="visitor",
                      kernel=view, ro_schema=self.ro_schema)

    async def decide(self, caller: Caller, call_id: str, discount_bp: int = 0) -> Decision:
        args = {**DRAIN, "requested_discount_bp": discount_bp} if discount_bp else DRAIN
        return await caller.kernel.call("POST /decide", DecideRequest(
            session_id=caller.session_id, generation=0, call=ToolCall(call_id=call_id, tool="native.quote", args=args)))

    async def answer(self, decision: Decision, choice: str = "allow_once") -> Decision:
        result = await self.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer=choice),
                                       path={"decision_id": decision.decision_id})
        return result.decision


@pytest.fixture
async def copy(kernel_http, fake, ro_schema, db) -> Copy:
    return await Copy(kernel_http, fake, ro_schema).open()


async def show(engine, caller: Caller, decision: Decision, phase: str) -> None:
    """Publish the decision to the visitor as a turn does."""
    async with engine.connect() as conn:
        await deliver(conn, caller.ids, Status(decision, phase))
        await conn.commit()


async def session_rows(engine, session_id: str) -> dict[str, list]:
    """What the session's run events and transcript hold: SSE types, control rows, action updates."""
    async with engine.connect() as conn:
        found = {
            "sse": (await conn.execute(text("SELECT type, payload->>'state' FROM app.run_events WHERE session_id = :s"
                                            " AND kind = 'sse' ORDER BY seq"), {"s": session_id})).all(),
            "control": (await conn.execute(text(
                "SELECT type, payload->>'decision_id', handled_at IS NOT NULL FROM app.run_events"
                " WHERE session_id = :s AND kind = 'control' ORDER BY id"), {"s": session_id})).all(),
            "action_update": (await conn.execute(text(
                "SELECT ref_id, text, wake FROM app.messages WHERE session_id = :s AND kind = 'action_update'"
                " ORDER BY n"), {"s": session_id})).all()}
    return {name: [tuple(row) for row in rows] for name, rows in found.items()}


async def test_resume_job_is_idempotent(copy, engine, db):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    executed = await copy.answer(held)

    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, executed) is True
        assert await resume_after_answer(conn, caller.ids, executed) is False      # a repeated or retried job

    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("held", "held"), ("resolved", "executed")]
    assert found["control"] == [("run_resumable", held.decision_id, False)]
    assert found["action_update"] == [(held.decision_id, executed.visitor_plain, True)]
    async with engine.connect() as conn:
        resolved = (await conn.execute(text("SELECT payload FROM app.run_events WHERE session_id = :s"
                                            " AND type = 'resolved'"), {"s": caller.session_id})).scalar_one()
    assert resolved == {"type": "resolved", **executed.model_dump(
        mode="json", include={"decision_id", "state", "visitor_plain", "ledger_seq", "signature"})}

    # A state another path showed first (the visitor's request found it due) adds nothing either.
    other = await copy.visitor()
    second = await copy.decide(other, "call-2", discount_bp=1000)
    denied = await copy.answer(second, "deny_once")
    await show(engine, other, denied, "resolved")
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, other.ids, denied) is False
        with pytest.raises(ValueError):                                   # a decision resumes only its own session
            await resume_after_answer(conn, caller.ids, denied)
    assert (await session_rows(engine, other.session_id))["control"] == []

    # An approval whose execution's outcome isn't known yet is shown as it stands and left for the visitor's next
    # request, which shows its final state once the kernel has one.
    copy.fake.script("native.quote", exec_state="unknown")
    third = await copy.visitor()
    unsure = await copy.answer(await copy.decide(third, "call-3", discount_bp=500))
    assert unsure.state == "unknown"
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, third.ids, unsure) is True
    assert (await session_rows(engine, third.session_id))["control"] == [
        ("run_resumable", unsure.decision_id, False), ("decision_pending", unsure.decision_id, False)]


async def test_a_late_resume_job_never_shows_an_older_state(copy, engine, fake, monkeypatch):
    """A resume job that runs late (retried after a deploy, or slow to start) can carry a state the kernel has since
    moved past, which the visitor's next request already showed. It shows nothing: no older status, no action
    update and no follow-up."""
    signed: list[Decision] = []                                         # every record the kernel signs, in order
    put = copy.fake._put_decision
    monkeypatch.setattr(copy.fake, "_put_decision", lambda record: (signed.append(record.decision), put(record))[1])

    async def everything(session_id: str) -> tuple:
        async with engine.connect() as conn:
            messages = (await conn.execute(text("SELECT count(*) FROM app.messages WHERE session_id = :s"),
                                           {"s": session_id})).scalar_one()
        return messages, await session_rows(engine, session_id)

    # The job of an approval carries the `approved` record; `executed`, signed just after it, was shown first.
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    executed = await copy.answer(held)
    (approved,) = [record for record in signed if record.decision_id == held.decision_id and record.state == "approved"]
    assert approved.ledger_seq < executed.ledger_seq
    await show(engine, caller, executed, "resolved")
    before = await everything(caller.session_id)
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, approved) is False
    assert await everything(caller.session_id) == before

    # The job of an `unknown` outcome, run after the kernel reconciled it and the visitor was shown `executed`.
    fake.script("native.quote", exec_state="unknown")
    other = await copy.visitor()
    unsure = await copy.answer(await copy.decide(other, "call-2", discount_bp=1500))
    assert unsure.state == "unknown"
    await show(engine, other, fake.reconcile(unsure.decision_id), "resolved")
    before = await everything(other.session_id)
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, other.ids, unsure) is False
    assert await everything(other.session_id) == before


async def test_due_decisions_get_one_control_row(copy, engine, fake, ro_schema, monkeypatch):
    fake.script("native.find_slots", exec_state="unknown")
    expiring, answered, unsure, shown = [await copy.visitor() for _ in range(4)]
    # A hold the visitor saw, left to expire.
    expires = await copy.decide(expiring, "call-expires", discount_bp=1500)
    await show(engine, expiring, expires, "held")
    # A hold the owner answered, and whose resume job never ran (the API stopped between the answer and the job).
    hold = await copy.decide(answered, "call-answered", discount_bp=1500)
    await show(engine, answered, hold, "held")
    await copy.answer(hold)
    # An allow whose execution's outcome the kernel didn't know: shown as it stood, and left pending.
    allowed = await unsure.kernel.call("POST /decide", DecideRequest(
        session_id=unsure.session_id, generation=0,
        call=ToolCall(call_id="call-unknown", tool="native.find_slots", args={"days": 3})))
    await unsure.kernel.call("POST /execute", ExecuteRequest(decision_id=allowed.decision_id,
                                                             session_id=unsure.session_id, generation=0))
    in_doubt = fake.decisions[allowed.decision_id].decision
    assert in_doubt.state == "unknown"
    await show(engine, unsure, in_doubt, "receipt")
    async with engine.begin() as conn:
        await append_control(conn, unsure.ids, "decision_pending", {"decision_id": in_doubt.decision_id})
    # A hold whose final state the visitor has already seen (and, below, one still waiting for the owner).
    done = await copy.decide(shown, "call-shown", discount_bp=1500)
    await show(engine, shown, done, "held")
    await show(engine, shown, await copy.answer(done, "deny_once"), "resolved")

    def controls(found: dict) -> list[tuple]:
        return [(type, decision_id) for type, decision_id, _ in found["control"]]

    async def due(caller: Caller) -> list[tuple]:
        return [row for row in controls(await session_rows(engine, caller.session_id)) if row[0] == "decision_due"]

    assert await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) == 1      # the answered one
    fake.now += timedelta(hours=13)
    for caller in (expiring, answered, unsure, shown):                   # the visitors come and go, so stay open
        await caller.kernel.whoami()
    fake.now += timedelta(hours=11, seconds=1)                           # a day after the holds were asked for
    waiting = await copy.visitor()
    still = await copy.decide(waiting, "call-waiting", discount_bp=1500)
    await show(engine, waiting, still, "held")
    assert await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) == 1      # and the expired one
    assert await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) == 0      # once each
    assert await due(answered) == [("decision_due", hold.decision_id)]
    assert await due(expiring) == [("decision_due", expires.decision_id)]
    assert [await due(caller) for caller in (unsure, waiting, shown)] == [[], [], []]     # none while not final

    fake.reconcile(in_doubt.decision_id, "succeeded")                    # the kernel found it ran (30 s on or more)
    assert await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) == 1
    assert await due(unsure) == [("decision_due", in_doubt.decision_id)]

    # Each session's next request handles them with its own credential: the final state is shown once, and the
    # job finds nothing more to do.
    runner = TurnRunner(ScriptedModel(), engine=engine, lock_engine=engine, production=False, clock=lambda: fake.now)
    for caller in (expiring, answered, unsure):
        async with engine.connect() as conn:
            await runner.handle_controls(conn, caller)
    assert [state for type, state in (await session_rows(engine, expiring.session_id))["sse"]] == ["held", "expired"]
    assert [state for type, state in (await session_rows(engine, answered.session_id))["sse"]] == ["held", "executed"]
    assert [state for type, state in (await session_rows(engine, unsure.session_id))["sse"]] == ["unknown", "executed"]
    for caller in (expiring, answered, unsure):
        assert all(handled for _, _, handled in (await session_rows(engine, caller.session_id))["control"])
    assert await surface_due_decisions(engine, now=fake.now + timedelta(days=1), ro_schema=ro_schema) == 1  # waiting
    assert await due(waiting) == [("decision_due", still.decision_id)]


async def test_the_minute_scan_reads_held_events_through_their_own_index(engine):
    """`surface_due_decisions` looks, every minute, at each held event ever shown, so it reads them through a partial
    index of their own, never the whole run_events table, and checks each for a final state through the index that
    keeps statuses unique. Sequential scans are off, so the plan names an index wherever one serves the query."""
    sql = jobs._waiting_decisions().compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    async with engine.connect() as conn:
        await conn.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join((await conn.execute(text(f"EXPLAIN {sql}"))).scalars())
    assert "run_events_held" in plan and "run_events_status_once" in plan, plan
    assert "Seq Scan" not in plan, plan


async def test_stalled_job_is_retried(db):
    """A job whose worker stopped sending heartbeats (its task died mid-job) goes back to `todo` on the next retry
    run, on the real job queue in Postgres; the retry and the due-decisions job run on a schedule."""
    app = jobs_app(procrastinate_connector())
    periodic = {task.task.name: (task.cron, task.task.queue, task.task.queueing_lock)
                for task in app.periodic_registry.periodic_tasks.values()}
    assert periodic == {SURFACE_DUE_DECISIONS: (SCHEDULE[SURFACE_DUE_DECISIONS], QUEUE, None),
                        RETRY_STALLED_JOBS: ("*/10 * * * *", QUEUE, RETRY_STALLED_JOBS)}
    assert SCHEDULE[SURFACE_DUE_DECISIONS] == "* * * * *"
    assert jobs_app(InMemoryConnector(), schedule=False).periodic_registry.periodic_tasks == {}

    async with app.open_async():
        manager = app.job_manager
        job_id = await app.configure_task("desk_tests.stalls", queue="desk_tests").defer_async()
        worker_id = await manager.register_worker()
        try:
            job = await manager.fetch_job(queues=["desk_tests"], worker_id=worker_id)
            assert job.id == job_id and (await manager.get_job_status_async(job_id)).value == "doing"
            # The worker's last heartbeat was a minute ago: it is gone, and its job stalled with it.
            await app.connector.execute_query_async(
                "UPDATE procrastinate_workers SET last_heartbeat = now() - interval '1 minute' WHERE id = %(id)s",
                id=worker_id)

            assert await retry_stalled_jobs(manager) >= 1
            assert (await manager.get_job_status_async(job_id)).value == "todo"
        finally:
            await app.connector.execute_query_async("DELETE FROM procrastinate_jobs WHERE id = %(id)s", id=job_id)
            await manager.unregister_worker(worker_id)


async def test_a_worker_that_stops_is_started_again(monkeypatch, caplog):
    """A worker that fails, or stops on its own (Procrastinate stops one whose listener lost the database), is
    started again; its error is logged by type only."""
    monkeypatch.setattr(jobs, "RESTART_S", 0)
    started = asyncio.Event()

    class Queue:
        runs = 0

        async def run_worker_async(self, **options) -> None:
            Queue.runs += 1
            assert options["install_signal_handlers"] is False and options["queues"] == [QUEUE]
            if Queue.runs == 1:
                raise RuntimeError("could not connect to dana@example.com")
            if Queue.runs == 3:
                started.set()
                await asyncio.Event().wait()                           # runs until the lifespan stops it

    worker = asyncio.create_task(run_worker(Queue(), JobEnv(engine=None, ro_schema="kernel_ro", clock=None)))
    await asyncio.wait_for(started.wait(), 5)
    worker.cancel()
    with pytest.raises(asyncio.CancelledError):
        await worker
    assert Queue.runs == 3
    logged = [record.getMessage() for record in caplog.records if record.name == "desk.api.jobs"]
    assert logged == ["the job worker stopped with RuntimeError; starting it again",
                      "the job worker stopped; starting it again"]
