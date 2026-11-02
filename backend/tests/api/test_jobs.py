"""The API's jobs (Plan 02a, Task 8): the resume job an owner's answer defers, the minute job that surfaces decisions
gone final or past their time, the retry of jobs a stopped worker left, and the two workers that run them (the
annotation jobs on their own, Plan 02b's Task 10).

The jobs run here as the worker runs them, on the API's engine and FakeKernel's kernel_ro mirror, without a credential:
what they leave is read with the visitor's own credential on the session's next request (`TurnRunner`).
"""

import asyncio
import inspect
import json
import logging
from dataclasses import replace
from xml.etree import ElementTree
from datetime import timedelta

import pytest
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

from desk.api.deliver import Status, deliver
from desk.api import jobs
from desk.api.jobs import (
    ANNOTATION_CONCURRENCY,
    ANNOTATION_POLL_S,
    ANNOTATION_QUEUE,
    ANNOTATION_WORKER,
    QUEUE,
    RESUME_AFTER_ANSWER,
    RETRY_STALLED_JOBS,
    SCHEDULE,
    SURFACE_DUE_DECISIONS,
    TRANSLATE_MESSAGE,
    TRIAGE_ATTEMPT,
    WORKER,
    JobEnv,
    jobs_app,
    resume_after_answer,
    retry_stalled_jobs,
    run_worker,
    surface_due_decisions,
)
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.runner import TurnRunner
from desk.api.loop import run_turn
from desk.api.sse import append_control, unhandled_controls
from desk.api.store import append_message
from desk.api.tools import Caller
from desk.contracts import Decision, ToolCall
from desk.db.session import procrastinate_connector
from desk.kernel_api import AnswerRequest, CreateCopyRequest, CreateSessionRequest, DecideRequest, ExecuteRequest
from tests.api.fakes import ScriptedModel, response, tool_use

DRAIN = {"items": [{"item_id": "drain", "qty": 1}]}


def test_resume_result_ids_cannot_bind_to_a_positional_argument():
    for function in (jobs.resume_after_answer, jobs.defer_resume_after_answer):
        signature = inspect.signature(function)
        with pytest.raises(TypeError):
            signature.bind(None, None, None, None, ["refund:R-1"])
        signature.bind(None, None, None, None, result_fact_ids=["refund:R-1"])


class Copy:
    """A Turner copy on FakeKernel: its owner's view, and visitors whose requests the tests decide."""

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


async def test_an_approved_booking_is_shown_with_its_result_card(copy, engine):
    caller = await copy.visitor()
    desk = copy.fake.desks[caller.desk_id]
    slot = next(iter(desk.slots))
    copy.fake.script("native.book", outcome="hold")
    held = await caller.kernel.call("POST /decide", DecideRequest(
        session_id=caller.session_id, generation=0,
        call=ToolCall(call_id="approved-booking", tool="native.book", args={"slot_id": slot})))
    assert held.state == "held"
    executed = await copy.answer(held)
    result = copy.fake.decisions[held.decision_id].result
    (fact,) = result.facts
    assert executed.state == "executed" and fact.kind == "booking"

    def show_booking(request):
        updates = [ElementTree.fromstring(block["text"]) for message in request.messages
                   for block in message["content"] if block.get("type") == "text"
                   and block["text"].startswith("<action_update ")]
        assert updates[0].attrib["result_fact_ids"].split() == [fact.fact_id]
        return response(tool_use("send_reply", {"prose": "Here are the details of your request.",
                                                "clauses": [{"template": "booking_confirmed",
                                                             "fact_id": fact.fact_id}]}))

    async with engine.connect() as conn:
        await resume_after_answer(conn, caller.ids, executed, result_fact_ids=[fact.fact_id])
        assert await run_turn(conn, caller, ScriptedModel([show_booking])) == "done"
        messages = (await conn.execute(text("SELECT payload FROM app.run_events WHERE session_id = :s"
                                            " AND type = 'message'"), {"s": caller.session_id})).scalars().all()
    assert [block["fact_id"] for message in messages for block in message["blocks"]
            if block.get("template") == "booking_confirmed"] == [fact.fact_id]
    assert len([entry for entry in desk.ledger if entry.event.kind == "execute"
                and entry.event.summary.get("decision_id") == held.decision_id]) == 1


async def test_resume_carries_only_result_ids_on_executed_updates(copy, engine):
    caller = await copy.visitor()
    held = await copy.decide(caller, "with-result", discount_bp=1500)
    executed = await copy.answer(held)
    fact_ids = [fact.fact_id for fact in copy.fake.decisions[held.decision_id].result.facts]
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, executed, result_fact_ids=fact_ids)
        block = (await conn.execute(text("SELECT model_content FROM app.messages WHERE session_id = :s"
                                         " AND kind = 'action_update'"), {"s": caller.session_id})).scalar_one()
    update = ElementTree.fromstring(block["text"])
    assert update.attrib["result_fact_ids"].split() == fact_ids
    assert update.attrib["decision_id"] == held.decision_id
    for state in ("denied", "expired"):
        other = await copy.visitor()
        decision = (await copy.decide(other, state, discount_bp=1500)).model_copy(update={"state": state})
        async with engine.connect() as conn:
            await resume_after_answer(conn, other.ids, decision, result_fact_ids=fact_ids)
            block = (await conn.execute(text("SELECT model_content FROM app.messages WHERE session_id = :s"
                                             " AND kind = 'action_update'"), {"s": other.session_id})).scalar_one()
        assert "result_fact_ids" not in ElementTree.fromstring(block["text"]).attrib


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


@pytest.mark.parametrize("approved_shown", [False, True], ids=["both new", "approved already shown"])
async def test_resume_job_is_idempotent(copy, engine, db, approved_shown):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    result = await copy.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
                                   path={"decision_id": held.decision_id})
    executed, approved = result.decision, result.approved
    assert approved is not None
    if approved_shown:
        await show(engine, caller, approved, "receipt")

    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, executed, approved) is True
        assert await resume_after_answer(conn, caller.ids, executed, approved) is False  # repeated or retried job

    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("held", "held"), ("receipt", "approved"), ("resolved", "executed")]
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
    waiting = await copy.decide(third, "call-3", discount_bp=500)
    await show(engine, third, waiting, "held")
    result = await copy.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
                                   path={"decision_id": waiting.decision_id})
    unsure = result.decision
    assert result.approved is not None
    assert unsure.state == "unknown"
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, third.ids, unsure, result.approved) is True
        assert await resume_after_answer(conn, third.ids, unsure, result.approved) is False
    found = await session_rows(engine, third.session_id)
    assert found["sse"] == [("held", "held"), ("receipt", "approved"), ("resolved", "unknown")]
    assert found["control"] == [
        ("run_resumable", unsure.decision_id, False), ("decision_pending", unsure.decision_id, False)]
    assert found["action_update"] == [(unsure.decision_id, unsure.visitor_plain, True)]

    final = copy.fake.reconcile(unsure.decision_id)
    runner = TurnRunner(ScriptedModel(), engine=engine, lock_engine=engine, production=False, clock=lambda: copy.fake.now)
    async with engine.connect() as conn:
        await runner.handle_controls(conn, third)
        await runner.handle_controls(conn, third)
        assert await resume_after_answer(conn, third.ids, unsure, result.approved) is False
    found = await session_rows(engine, third.session_id)
    assert found["sse"] == [
        ("held", "held"), ("receipt", "approved"), ("resolved", "unknown"), ("resolved", "executed")]
    assert found["control"] == [
        ("run_resumable", unsure.decision_id, True), ("decision_pending", unsure.decision_id, True)]
    assert found["action_update"] == [
        (unsure.decision_id, unsure.visitor_plain, True), (unsure.decision_id, final.visitor_plain, True)]


async def test_duplicate_decision_controls_wake_only_for_a_new_state(copy, engine, fake, monkeypatch):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    final = await copy.answer(held)
    async with engine.begin() as conn:
        for type in ("decision_pending", "decision_due"):
            await append_control(conn, caller.ids, type, {"decision_id": held.decision_id})
    runner = TurnRunner(ScriptedModel(), engine=engine, lock_engine=engine, production=False, clock=lambda: fake.now)
    started = []
    monkeypatch.setattr(runner, "start", started.append)
    async with engine.connect() as conn:
        rows = await unhandled_controls(conn, caller.ids)
        await conn.commit()
        for row in rows:
            assert await runner.handle_control(conn, caller, row) is True
        assert await runner.handle_control(conn, caller, rows[0]) is False

    assert started == [caller]
    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("held", "held"), ("resolved", "executed")]
    assert found["action_update"] == [(held.decision_id, final.visitor_plain, True)]
    assert found["control"] == [("decision_pending", held.decision_id, True), ("decision_due", held.decision_id, True)]


async def test_resume_drops_an_approved_snapshot_with_swapped_ledger_sequences(copy, engine, caplog):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    result = await copy.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
                                   path={"decision_id": held.decision_id})
    assert result.approved is not None
    outcome = result.decision.model_copy(update={"ledger_seq": result.approved.ledger_seq})
    approved = result.approved.model_copy(update={"ledger_seq": result.decision.ledger_seq})

    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, outcome, approved) is True

    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("held", "held"), ("resolved", "executed")]
    assert found["action_update"] == [(held.decision_id, outcome.visitor_plain, True)]
    assert found["control"] == [("run_resumable", held.decision_id, False)]
    assert "approved snapshot doesn't match its outcome" in caplog.text
    assert approved.visitor_plain not in caplog.text


async def test_resume_drops_another_decisions_approved_snapshot(copy, engine, caplog):
    caller = await copy.visitor()
    other = await copy.decide(caller, "other-call", discount_bp=1000)
    other_answer = await copy.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
                                         path={"decision_id": other.decision_id})
    approved = other_answer.approved
    assert approved is not None
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    outcome = await copy.answer(held)
    assert approved.ledger_seq < outcome.ledger_seq

    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, outcome, approved) is True

    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("held", "held"), ("resolved", "executed")]
    assert found["action_update"] == [(held.decision_id, outcome.visitor_plain, True)]
    assert found["control"] == [("run_resumable", held.decision_id, False)]
    assert "approved snapshot doesn't match its outcome" in caplog.text
    assert approved.visitor_plain not in caplog.text


async def test_resume_drops_a_snapshot_that_isnt_approved(copy, engine, caplog):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    result = await copy.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
                                   path={"decision_id": held.decision_id})
    assert result.approved is not None
    snapshot = result.approved.model_copy(update={"state": "denied"})

    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, result.decision, snapshot) is True

    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("held", "held"), ("resolved", "executed")]
    assert found["action_update"] == [(held.decision_id, result.decision.visitor_plain, True)]
    assert found["control"] == [("run_resumable", held.decision_id, False)]
    assert "approved snapshot doesn't match its outcome" in caplog.text
    assert snapshot.visitor_plain not in caplog.text


async def test_resume_strips_owner_reason_from_approved_snapshot(copy, engine, monkeypatch):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-private-approved", discount_bp=1500)
    result = await copy.owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
                                   path={"decision_id": held.decision_id})
    assert result.approved is not None
    approved = result.approved.model_copy(update={"owner_plain": "Private approved snapshot reason"})
    outcome = result.decision.model_copy(update={"owner_plain": "Private outcome reason"})
    connector = InMemoryConnector()
    app = jobs_app(connector, schedule=False)
    async with app.open_async():
        await jobs.defer_resume_after_answer(app, caller.ids, outcome, approved)
    (job,) = connector.jobs.values()
    assert "owner_plain" not in job["args"]["approved"]
    assert "owner_plain" not in job["args"]["decision"]
    assert job["args"]["approved"] == approved.model_dump(mode="json", exclude={"owner_plain"})
    assert job["args"]["decision"] == outcome.model_dump(mode="json", exclude={"owner_plain"})

    seen = []
    deliver = jobs.deliver

    async def checked(conn, ids, item):
        seen.append((item.phase, item.decision.owner_plain))
        return await deliver(conn, ids, item)

    monkeypatch.setattr(jobs, "deliver", checked)
    # Older queued arguments may still contain the field: clear both before building even a Status.
    status = jobs.Status

    def checked_status(decision, phase):
        assert decision.owner_plain is None
        return status(decision, phase)

    monkeypatch.setattr(jobs, "Status", checked_status)
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, outcome, approved)
    assert seen == [("receipt", None), ("resolved", None)]
    found = await session_rows(engine, caller.session_id)
    assert found["sse"] == [("receipt", "approved"), ("resolved", "executed")]
    assert len(found["action_update"]) == 1
    assert approved.owner_plain == "Private approved snapshot reason"
    assert outcome.owner_plain == "Private outcome reason"


@pytest.mark.parametrize("choice, given", [("deny_once", ["x"]), ("allow_once", [])])
async def test_resume_job_queues_result_ids_only_when_there_are_some(copy, choice, given):
    """A denied answer, or an executed one with no result facts, queues no result IDs at all, so a job queued during a
    rolling deploy still runs on a worker whose resume job doesn't take them."""
    caller = await copy.visitor()
    outcome = await copy.answer(await copy.decide(caller, f"call-no-result-ids-{choice}", discount_bp=1500), choice)
    assert outcome.state == ("denied" if choice == "deny_once" else "executed")
    connector = InMemoryConnector()
    app = jobs_app(connector, schedule=False)
    async with app.open_async():
        await jobs.defer_resume_after_answer(app, caller.ids, outcome, result_fact_ids=given)
    (job,) = connector.jobs.values()
    assert "result_fact_ids" not in job["args"]
    assert set(job["args"]) == {"copy_id", "desk_id", "session_id", "decision", "approved"}


async def test_direct_resume_clears_the_owner_reason(copy, engine, monkeypatch):
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-private-reason", discount_bp=1500)
    copy.fake.never(caller.desk_id, "native.quote")
    refused = await copy.answer(held)
    assert refused.owner_plain
    seen = []
    deliver = jobs.deliver

    async def checked(conn, ids, item):
        seen.append(item.decision.owner_plain)
        return await deliver(conn, ids, item)

    monkeypatch.setattr(jobs, "deliver", checked)
    async with engine.connect() as conn:
        assert await resume_after_answer(conn, caller.ids, refused)
    assert seen == [None]
    assert refused.owner_plain


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
        assert await resume_after_answer(conn, caller.ids, executed, approved) is False
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


async def test_an_abandoned_hold_is_read_once(copy, engine, fake, ro_schema, monkeypatch):
    """A visitor who never comes back leaves their decision's `decision_due` row unhandled. The minute scan reads that
    decision in kernel_ro once, when it comes due, and not again each minute while the row waits."""
    asked: list[list[str]] = []
    read = jobs.due_decisions

    async def reading(conn, decision_ids, schema):
        asked.append(list(decision_ids))
        return await read(conn, decision_ids, schema)

    monkeypatch.setattr(jobs, "due_decisions", reading)
    caller = await copy.visitor()
    held = await copy.decide(caller, "call-1", discount_bp=1500)
    await show(engine, caller, held, "held")
    await copy.answer(held, "deny_once")                       # final; its resume never reached the visitor

    assert [await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) for _ in range(3)] == [1, 0, 0]
    assert [decision_ids for decision_ids in asked if decision_ids] == [[held.decision_id]]


# Settled by a call that ran -----------------------------------------------------------------------------------

HALF_OFF = {**DRAIN, "requested_discount_bp": 5000}


def reply(prose: str) -> dict:
    return tool_use("send_reply", {"prose": prose, "clauses": []})


def open_slots(fake, caller: Caller) -> list[str]:
    """The Desk's open weekday slots, earliest first (in opening hours, so a booking is allowed)."""
    slots = sorted(fake.desks[caller.desk_id].slots.values(), key=lambda slot: slot.starts_at)
    return [slot.slot_id for slot in slots if slot.starts_at.weekday() < 5]


def decisions(fake, caller: Caller, tool: str) -> list[Decision]:
    """The session's decisions of `tool`, oldest first, as the kernel holds them now (no read refreshes them)."""
    return [record.decision for record in fake.decisions.values()
            if record.decision.session_id == caller.session_id and record.decision.action is not None
            and record.decision.action.tool == tool]


def reads(fake) -> list[str]:
    """The decisions read by ID (`GET /decisions/{id}`) since the fake's calls were last cleared, in order."""
    return [call.path.removeprefix("/decisions/") for call in fake.called("GET /decisions/{id}")]


async def turn(engine, caller: Caller, words: str, *script) -> str:
    """The visitor says `words`, and Claude answers in one turn, on `script`."""
    async with engine.connect() as conn:
        await append_message(conn, caller.ids, "visitor_text", text=words)
        await conn.commit()
        return await run_turn(conn, caller, ScriptedModel(list(script)))


async def held_half_off(engine, fake, caller: Caller) -> Decision:
    """The visitor asks for half off a drain clearing, and the kernel holds Claude's quote for the owner."""
    assert await turn(engine, caller, "Can I get the drain clearing at half price?",
                      response(tool_use("native__quote", HALF_OFF)), response(reply("I've asked Mike."))) == "done"
    (quote,) = decisions(fake, caller, "native.quote")
    assert quote.state == "held"
    return quote


def due_rows(found: dict) -> list[tuple]:
    return [row for row in found["control"] if row[0] == "decision_due"]


async def test_a_booking_turn_shows_the_held_quote_it_closed(copy, engine, fake):
    """The visitor's half-price quote waits for the owner, then they book a time at list price in a later turn. The
    kernel closes the stale quote only on a read through it, and the minute sweep reads kernel_ro, so the booking's
    turn reads what its session waits on itself: right after it, with no owner read and no sweep, the quote has its
    `decision_due` row, and handling the session's control rows shows it cancelled and wakes Claude."""
    caller = await copy.visitor()
    quote = await held_half_off(engine, fake, caller)

    assert await turn(engine, caller, "Never mind, book me in at list price.",
                      response(tool_use("native__book", {"slot_id": open_slots(fake, caller)[0]})),
                      response(reply("You're booked."))) == "done"

    assert fake.decisions[quote.decision_id].decision.state == "cancelled"
    found = await session_rows(engine, caller.session_id)
    assert due_rows(found) == [("decision_due", quote.decision_id, False)]
    assert ("resolved", "cancelled") not in found["sse"] and found["action_update"] == []

    runner = TurnRunner(ScriptedModel(), engine=engine, lock_engine=engine, production=False, clock=lambda: fake.now)
    async with engine.connect() as conn:
        await runner.handle_controls(conn, caller)
    found = await session_rows(engine, caller.session_id)
    assert found["sse"][-1] == ("resolved", "cancelled")
    assert found["action_update"] == [(quote.decision_id, "Cancelled", True)]
    assert all(handled for _, _, handled in found["control"])


async def test_a_call_that_runs_leaves_what_it_didnt_settle_waiting(copy, engine, fake, ro_schema):
    """A discount quote asked for after the session's booking, and a held booking, are still waiting after the next
    call that runs: the turn reads them, finds them held, and writes no row (a `decision_due` row for a decision that
    isn't final would keep the minute sweep from marking it again). Once the owner answers, the sweep picks each up."""
    caller = await copy.visitor()
    first, second = open_slots(fake, caller)[:2]
    assert await turn(engine, caller, "Book me in, please.", response(tool_use("native__book", {"slot_id": first})),
                      response(reply("You're booked."))) == "done"
    quote = await held_half_off(engine, fake, caller)
    fake.script("native.book", outcome="hold")                           # the owner looks at the next booking first
    fake.calls.clear()

    assert await turn(engine, caller, "Book a second visit too, and which times are free this week?",
                      response(tool_use("native__book", {"slot_id": second}),
                               tool_use("native__find_slots", {"days": 3})),
                      response(reply("I've asked Mike about the second visit."))) == "done"

    (_, held) = decisions(fake, caller, "native.book")
    assert {quote.decision_id, held.decision_id} <= set(reads(fake))     # the turn looked at both
    assert [fake.decisions[decision.decision_id].decision.state for decision in (quote, held)] == ["held", "held"]
    assert due_rows(await session_rows(engine, caller.session_id)) == []
    for decision in (quote, held):
        await copy.answer(decision, "deny_once")
    assert await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) == 2
    assert sorted(due_rows(await session_rows(engine, caller.session_id))) == sorted(
        ("decision_due", decision.decision_id, False) for decision in (quote, held))


async def test_a_call_that_runs_with_nothing_waiting_reads_no_other_decision(copy, engine, fake):
    """A booking in a session with nothing waiting reads no decision but its own, though another session's discount
    quote waits: a turn looks only at its own session's. The other session's own booking does read its quote."""
    other, caller = await copy.visitor(), await copy.visitor()
    first, second = open_slots(fake, caller)[:2]
    quote = await held_half_off(engine, fake, other)
    fake.calls.clear()

    assert await turn(engine, caller, "Book me in, please.", response(tool_use("native__book", {"slot_id": first})),
                      response(reply("You're booked."))) == "done"

    (booking,) = decisions(fake, caller, "native.book")
    assert reads(fake) == [booking.decision_id]
    assert [due_rows(await session_rows(engine, visitor.session_id)) for visitor in (caller, other)] == [[], []]

    fake.calls.clear()
    assert await turn(engine, other, "Book me in at list price instead.",
                      response(tool_use("native__book", {"slot_id": second})),
                      response(reply("You're booked."))) == "done"
    (booked,) = decisions(fake, other, "native.book")
    assert reads(fake) == [booked.decision_id, quote.decision_id]


class FailingKernel:
    """A session's kernel client on which each call that `fails(route, body, path)` names an error for raises that
    error, and is kept in `failed`; every other call goes through."""

    def __init__(self, kernel, fails):
        self._kernel, self._fails = kernel, fails
        self.failed: list[tuple[str, dict | None]] = []

    async def call(self, route: str, body=None, *, path: dict | None = None, **options):
        error = self._fails(route, body, path)
        if error is not None:
            self.failed.append((route, path))
            raise error
        return await self._kernel.call(route, body, path=path, **options)

    def __getattr__(self, name: str):
        return getattr(self._kernel, name)


@pytest.mark.parametrize(("error", "tried"), [
    (KernelUnavailable("GET /decisions/{id}"), 1),             # out of reach: the look stops at its first read
    (KernelFailed(409, "closed"), 2), (RuntimeError("dana@example.com"), 2)], ids=["unreachable", "closed", "anything"])
async def test_a_waiting_decision_that_cant_be_read_is_left_for_later(copy, engine, fake, caplog, error, tried):
    """Two discount quotes wait, and the kernel can't be read for either: whatever the failure, it changes nothing the
    turn does. The booking is shown and answered as ever, nothing reaches the visitor about the reads, no row is
    written, and each failure is logged by its type alone. A refusal is skipped for the next decision, but a kernel out
    of reach stops the look at its first read, so a turn never waits out the client's timeout once per waiting
    decision. The minute sweep or the owner's reads settle the quotes later."""
    caller = await copy.visitor()
    assert await turn(engine, caller, "Can I get half off a drain clearing? Or 40% off, at least?",
                      response(tool_use("native__quote", HALF_OFF),
                               tool_use("native__quote", {**DRAIN, "requested_discount_bp": 4000})),
                      response(reply("I've asked Mike about both."))) == "done"
    quotes = {quote.decision_id for quote in decisions(fake, caller, "native.quote") if quote.state == "held"}
    assert len(quotes) == 2
    kernel = FailingKernel(caller.kernel, lambda route, body, path: (
        error if route == "GET /decisions/{id}" and path["id"] in quotes else None))

    assert await turn(engine, replace(caller, kernel=kernel), "Never mind, book me in at list price.",
                      response(tool_use("native__book", {"slot_id": open_slots(fake, caller)[0]})),
                      response(reply("You're booked."))) == "done"

    assert len(kernel.failed) == tried and {path["id"] for _, path in kernel.failed} <= quotes
    found = await session_rows(engine, caller.session_id)
    assert [type for type, _ in found["sse"]][-4:] == ["writing", "receipt", "message", "turn_end"]
    assert found["sse"][-3] == ("receipt", "executed") and "error" not in [type for type, _ in found["sse"]]
    assert due_rows(found) == []
    logged = [record.getMessage() for record in caplog.records
              if record.name == "desk.api.loop" and record.levelno >= logging.WARNING]
    assert logged == [f"a waiting decision couldn't be read after a call ran ({type(error).__name__})"] * tried
    assert "dana@example.com" not in caplog.text


async def test_a_turn_stopping_on_an_unreachable_kernel_doesnt_look(copy, engine, fake):
    """A booking runs, but a sibling call finds the kernel out of reach, so the turn stops with the static error. It
    doesn't look at what the session waits on, which would only wait out the client's timeout again: the quote is left
    for the minute sweep and the owner's reads."""
    caller = await copy.visitor()
    quote = await held_half_off(engine, fake, caller)

    def unreachable(route, body, path):         # the slots search can't reach the kernel, nor can its lookup by call ID
        searching = route == "POST /decide" and body.call.tool == "native.find_slots"
        return KernelUnavailable(route) if searching or route.startswith("GET /decisions/by_call") else None

    fake.calls.clear()
    assert await turn(engine, replace(caller, kernel=FailingKernel(caller.kernel, unreachable)),
                      "Book me in at list price, and which other times are free?",
                      response(tool_use("native__book", {"slot_id": open_slots(fake, caller)[0]}),
                               tool_use("native__find_slots", {"days": 3}))) == "kernel_unavailable"

    (booking,) = decisions(fake, caller, "native.book")
    assert booking.state == "executed"
    assert reads(fake) == [booking.decision_id]                 # the booking's own read, and no look at the quote
    assert fake.decisions[quote.decision_id].decision.state == "held"
    assert due_rows(await session_rows(engine, caller.session_id)) == []


# A run_events table as a running Desk fills it: mostly messages and receipts, a few held events and controls.
REALISTIC_RUN_EVENTS = """
INSERT INTO app.run_events (copy_id, desk_id, session_id, kind, seq, type, payload)
SELECT 'copy', 'desk', 's' || (g % 400), 'sse', g,
       (ARRAY['message', 'writing', 'turn_end', 'receipt', 'resolved', 'message', 'writing', 'message'])[1 + g % 8],
       jsonb_build_object('decision_id', 'd' || g, 'ledger_seq', g, 'state', 'allowed')
FROM generate_series(1, 8000) g;
INSERT INTO app.run_events (copy_id, desk_id, session_id, kind, seq, type, payload)
SELECT 'copy', 'desk', 's' || g, 'sse', 100000 + g, 'held', jsonb_build_object('decision_id', 'h' || g, 'ledger_seq', 100000 + g)
FROM generate_series(1, 20) g;
INSERT INTO app.run_events (copy_id, desk_id, session_id, kind, seq, type, payload)
SELECT 'copy', 'desk', 's' || g, 'control', NULL, (ARRAY['decision_due', 'decision_pending'])[1 + g % 2],
       jsonb_build_object('decision_id', 'c' || g)
FROM generate_series(1, 20) g;
ANALYZE app.run_events;
"""


async def test_the_minute_scan_reads_held_events_through_their_own_index(db, engine):
    """`surface_due_decisions` looks, every minute, at each held event ever shown, so it reads them through a partial
    index of their own, never the whole run_events table, and checks each for a final state through the index that
    keeps statuses unique and for a waiting `decision_due` row through the one that keeps those unique. Sequential
    scans are off, so the plan names an index wherever one serves the query. The table first holds what a running
    Desk writes, and is analyzed: on a near-empty table the indexes cost about the same, and the planner's choice
    hung on the statistics earlier tests happened to leave."""
    db.execute(REALISTIC_RUN_EVENTS)
    sql = jobs.waiting_decisions().compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    async with engine.connect() as conn:
        await conn.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join((await conn.execute(text(f"EXPLAIN {sql}"))).scalars())
    assert "run_events_held" in plan and "run_events_status_once" in plan and "run_events_due_once" in plan, plan
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


async def test_each_worker_that_stops_is_started_again(monkeypatch, caplog):
    """The jobs run on two queues, each with its own worker: the resume job and the periodic ones one at a time, on a
    worker that listens for them, and the triage and translation jobs, which wait on the model, several at a time on
    a worker that polls. A worker that fails, or stops on its own (Procrastinate stops one whose listener lost the
    database), is started again while the other runs on; its error is logged by type only."""
    app = jobs_app(InMemoryConnector(), schedule=False)
    assert {name: task.queue for name, task in app.tasks.items() if name.startswith("desk.")} == {
        RESUME_AFTER_ANSWER: QUEUE, SURFACE_DUE_DECISIONS: QUEUE, RETRY_STALLED_JOBS: QUEUE,
        TRIAGE_ATTEMPT: ANNOTATION_QUEUE, TRANSLATE_MESSAGE: ANNOTATION_QUEUE}
    monkeypatch.setattr(jobs, "RESTART_S", 0)
    env = JobEnv(engine=None, ro_schema="kernel_ro", clock=None)
    runs: dict[str, list[dict]] = {WORKER: [], ANNOTATION_WORKER: []}
    running = {name: asyncio.Event() for name in runs}

    class Queue:
        async def run_worker_async(self, **options) -> None:
            name = options["name"]
            runs[name].append(options)
            if name == WORKER and len(runs[name]) == 1:
                raise RuntimeError("could not connect to dana@example.com")
            if name == WORKER and len(runs[name]) == 2:
                return                                                 # stopped on its own
            running[name].set()
            await asyncio.Event().wait()                               # runs until the lifespan stops it

    worker = asyncio.create_task(run_worker(Queue(), env))
    await asyncio.wait_for(asyncio.gather(*(event.wait() for event in running.values())), 5)
    worker.cancel()
    with pytest.raises(asyncio.CancelledError):
        await worker
    assert {name: len(started) for name, started in runs.items()} == {WORKER: 3, ANNOTATION_WORKER: 1}
    for started in runs.values():
        assert all(options == started[0] for options in started)       # started again as it was
        assert started[0]["install_signal_handlers"] is False and started[0]["additional_context"] == {jobs.ENV: env}
    desk, annotations = runs[WORKER][0], runs[ANNOTATION_WORKER][0]
    assert (desk["queues"], desk.get("concurrency", 1), desk.get("listen_notify", True)) == ([QUEUE], 1, True)
    assert (annotations["queues"], annotations["concurrency"], annotations["listen_notify"]) == (
        [ANNOTATION_QUEUE], ANNOTATION_CONCURRENCY, False)
    assert ANNOTATION_CONCURRENCY >= 2 and annotations["fetch_job_polling_interval"] == ANNOTATION_POLL_S
    logged = [record.getMessage() for record in caplog.records if record.name == "desk.api.jobs"]
    assert logged == [f"the job worker {WORKER} stopped with RuntimeError; starting it again",
                      f"the job worker {WORKER} stopped; starting it again"]
