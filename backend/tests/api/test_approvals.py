"""The owner's answers to held requests (Plan 02a, Task 8): `POST /api/owner/approvals/{decision_id}/answer`, the resume
job it defers and Claude's follow-up, run with the visitor's own credential once it is present.

The app runs on FakeKernel, a scripted model and Procrastinate's in-memory job queue, its worker inside the app's
lifespan. A visitor's held request is made the way a visitor makes one: a message, and Claude's quote at a discount.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta
from xml.etree import ElementTree

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.exceptions import ConnectorException
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from desk.api.jobs import RESUME_AFTER_ANSWER, surface_due_decisions
from desk.api.main import create_app
from desk.contracts import Claim, Fact, Label
from desk.kernel_api import AnswerRequest, CreateCopyRequest
from tests.api.fakes import ScriptedModel, response, tool_use
from tests.api.test_jobs import session_rows
from tests.api.test_public_chat import DISCOUNTED_QUOTE, Stream, cookie, events_path, open_session, reply, types
from tests.kernel_contract.fake_kernel import fake_kernel_app

OWNER = "x-owner-session"
VISITOR = "x-session-token"


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def jobs_connector() -> InMemoryConnector:
    return InMemoryConnector()


@pytest.fixture
async def app(db, fake, api_settings, clock, model, jobs_connector) -> AsyncIterator[FastAPI]:
    """The API on FakeKernel, the scripted model and the in-memory job queue, its lifespan (and worker) running."""
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=jobs_connector)
    async with app.router.lifespan_context(app):
        yield app


@dataclass
class Held:
    """A visitor's request held for the owner: the owner's and the visitor's browsers, and what identifies it."""

    owner: httpx.AsyncClient
    visitor: httpx.AsyncClient
    owner_token: str
    token: str
    slug: str
    session_id: str
    decision_id: str


async def held_request(app, browser, fake, kernel_http, model) -> Held:
    """A new copy, its owner's browser, and a visitor whose discounted quote Claude asked for and the kernel held."""
    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    slug = fake.desks[copy.desk_ids[0]].slug
    owner = browser(app)
    owner.cookies.set("desk_owner", copy.owner_token, domain="desk.test", path="/api/owner")
    visitor, token, opened = await open_session(app, browser, slug)
    model.add(response(tool_use("native__quote", DISCOUNTED_QUOTE), reply("I've asked Maria to look at this.")))
    sent = await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": "Can I get a discount on a drain?"})
    assert sent.status_code == 202
    await app.state.runtime.runner.drain()
    session_id = opened["state"]["session_id"]
    (held,) = [record.decision for record in fake.decisions.values()
               if record.decision.session_id == session_id and record.decision.state == "held"]
    return Held(owner=owner, visitor=visitor, owner_token=copy.owner_token, token=token, slug=slug,
                session_id=session_id, decision_id=held.decision_id)


async def answer(held: Held, choice: str) -> httpx.Response:
    return await held.owner.post(f"/api/owner/approvals/{held.decision_id}/answer", json={"answer": choice})


async def sse_events(engine, session_id: str) -> list[tuple[str, dict]]:
    async with engine.connect() as conn:
        found = await conn.execute(text("SELECT type, payload FROM app.run_events WHERE session_id = :s"
                                        " AND kind = 'sse' ORDER BY seq"), {"s": session_id})
        return [(type, payload) for type, payload in found]


async def resolved(engine, session_id: str, count: int = 1, timeout: float = 5.0) -> list[dict]:
    """The session's `resolved` events, once there are `count` of them (the job runs in the app's worker)."""
    async def wait() -> list[dict]:
        while len(found := [payload for type, payload in await sse_events(engine, session_id)
                            if type == "resolved"]) < count:
            await asyncio.sleep(0.02)
        return found

    return await asyncio.wait_for(wait(), timeout)


def signed(decision: dict) -> dict:
    """The fields of a decision a `resolved` event carries, as the kernel signed them."""
    return {"type": "resolved", **{key: decision[key] for key in ("decision_id", "state", "visitor_plain",
                                                                    "ledger_seq", "signature")}}


async def test_allow_once_resumes_with_the_visitor_credential(app, browser, fake, kernel_http, model, engine,
                                                            monkeypatch):
    held = await held_request(app, browser, fake, kernel_http, model)
    snapshots = []
    put = fake._put_decision

    def remember(record):
        if record.decision.decision_id == held.decision_id and record.decision.state == "approved":
            snapshots.append(record.decision)
        put(record)

    monkeypatch.setattr(fake, "_put_decision", remember)
    model.add(response(reply("Good news: Maria said yes.")))
    fake.calls.clear()

    answered = await answer(held, "allow_once")

    assert answered.status_code == 200, answered.text
    body = answered.json()
    assert (body["decision"]["decision_id"], body["decision"]["state"]) == (held.decision_id, "executed")
    assert (body["execution_state"], body["card_diff"]) == ("succeeded", None)
    (sent,) = fake.called("POST /approvals/{decision_id}/answer")
    assert sent.headers[OWNER] == held.owner_token and VISITOR not in sent.headers
    (shown,) = await resolved(engine, held.session_id)
    assert shown == signed(body["decision"])                       # the kernel's signed record, unchanged
    (approved,) = snapshots
    expected = [{**signed(approved.model_dump(mode="json")), "type": "receipt"}, shown]
    assert [payload for type, payload in await sse_events(engine, held.session_id)
            if type in ("receipt", "resolved")] == expected
    assert approved.ledger_seq < body["decision"]["ledger_seq"]
    transcript = await held.visitor.get(f"/api/public/desks/{held.slug}/session")
    assert transcript.status_code == 200
    assert [item["event"] for item in transcript.json()["items"]
            if item["kind"] == "status" and item["event"]["type"] in ("receipt", "resolved")] == expected
    assert model.requests[1:] == []                                  # no follow-up without the visitor's credential
    answered_at = len(fake.calls)

    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()

    assert types(events) == ["writing", "held", "message", "turn_end", "receipt", "resolved", "writing",
                             "message", "turn_end"]
    assert [event.model_dump(mode="json") for _, event in events if event.type in ("receipt", "resolved")] == expected
    assert events[7][1].blocks[0].text == "Good news: Maria said yes."
    follow_up = json.dumps(model.requests[1].messages)
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"executed\\" result_fact_ids=' in follow_up)
    after = fake.calls[answered_at:]
    assert "POST /check_reply" in [call.route for call in after]
    assert all(call.headers.get(VISITOR) == held.token and OWNER not in call.headers for call in after)
    async with engine.connect() as conn:
        updates = (await conn.execute(text(
            "SELECT text, wake FROM app.messages WHERE session_id = :s AND kind = 'action_update' ORDER BY n"),
            {"s": held.session_id})).all()
    assert [tuple(row) for row in updates] == [(body["decision"]["visitor_plain"], True)]
    assert len(model.requests) == 2


async def jobs_done(connector: InMemoryConnector, timeout: float = 5.0) -> list[dict]:
    """The queue's jobs, once the worker has finished every one of them."""
    async def wait() -> None:
        while any(job["status"] in ("todo", "doing") for job in connector.jobs.values()):
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), timeout)
    return list(connector.jobs.values())


async def resume_jobs(connector: InMemoryConnector) -> list[dict]:
    """The queue's resume jobs, once the worker has finished every job (a visitor's message queues its translation
    too, Plan 02b's Task 10)."""
    return [job for job in await jobs_done(connector) if job["task_name"] == RESUME_AFTER_ANSWER]


@pytest.mark.parametrize("inline", [False, True])
async def test_approved_result_ids_reach_the_follow_up(app, browser, fake, kernel_http, model, engine,
                                                      jobs_connector, monkeypatch, inline):
    held = await held_request(app, browser, fake, kernel_http, model)
    if inline:
        async def unavailable(*args, **kwargs):
            raise ConnectorException()
        monkeypatch.setattr(jobs_connector, "defer_jobs_all", unavailable)
    answered = await answer(held, "allow_once")
    assert answered.status_code == 200
    await resolved(engine, held.session_id)
    result = fake.decisions[held.decision_id].result
    fact_ids = [fact.fact_id for fact in result.facts]
    async with engine.connect() as conn:
        block = (await conn.execute(text("SELECT model_content FROM app.messages WHERE session_id = :s"
                                         " AND kind = 'action_update'"), {"s": held.session_id})).scalar_one()
    assert ElementTree.fromstring(block["text"]).attrib["result_fact_ids"].split() == fact_ids
    if not inline:
        (job,) = await resume_jobs(jobs_connector)
        assert job["args"]["result_fact_ids"] == fact_ids
        assert set(job["args"]) == {"copy_id", "desk_id", "session_id", "decision", "approved", "result_fact_ids"}
        assert result.model_view not in list(job["args"].values())
        assert all(isinstance(value, str) for value in job["args"]["result_fact_ids"])


@pytest.mark.parametrize("kind, template, readable", [
    ("refund", "refund_issued", True), ("booking", "booking_confirmed", True),
    ("refund", "refund_issued", False),
])
async def test_resumed_result_card_uses_the_answer_association(app, browser, fake, kernel_http, model, engine,
                                                              jobs_connector, kind, template, readable):
    """Stage typed execution results on a held quote; real refund execution is tested in tier 1."""
    held = await held_request(app, browser, fake, kernel_http, model)
    desk = fake.desks[fake.sessions[held.session_id].desk_id]
    label = Label(readers=[f"session:{held.session_id}"] if readable else ["owner"])
    claims = ([Claim(key="starts_at", kind="datetime", value="2026-11-03T10:00:00-08:00")]
              if kind == "booking" else [Claim(key="total", kind="money", value=25000)])
    expected = Fact(fact_id=f"{kind}:approved", kind=kind, status="committed", source="kernel",
                    label=label, claims=claims)
    other = expected.model_copy(update={"fact_id": f"{kind}:earlier"})
    fake._put_fact(desk, other)
    fake.script("native.quote", facts=[expected], model_view={"owner_only": "PRIVATE RESULT DETAILS"})
    answered = await answer(held, "allow_once")
    assert answered.status_code == 200
    await resolved(engine, held.session_id)
    (job,) = await resume_jobs(jobs_connector)
    assert job["args"]["result_fact_ids"] == [expected.fact_id]
    assert "PRIVATE RESULT DETAILS" not in json.dumps(job["args"])

    def show_matching_card(request):
        updates = [ElementTree.fromstring(block["text"]) for message in request.messages
                   for block in message["content"] if block.get("type") == "text"
                   and block["text"].startswith("<action_update ")]
        (update,) = updates
        assert update.attrib["decision_id"] == held.decision_id
        (fact_id,) = update.attrib["result_fact_ids"].split()
        return response(tool_use("send_reply", {"prose": "Here are the details of your request.",
                                                "clauses": [{"template": template, "fact_id": fact_id}]}))

    model.add(show_matching_card)
    if not readable:
        model.add(response(tool_use("send_reply", {"prose": "Here are the details of your request.",
                                                  "clauses": [{"template": template,
                                                               "fact_id": expected.fact_id}]})), response())
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        shown = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    cards = [block for _, event in shown if event.type == "message" for block in event.blocks
             if block.template == template]
    if readable:
        assert [block.fact_id for block in cards] == [expected.fact_id]
    else:
        assert cards == []
        verdicts = [entry.event.summary for entry in desk.ledger if entry.event.kind == "reply"]
        assert any("unentitled_fact" in verdict["violations"] for verdict in verdicts), verdicts
    assert len([entry for entry in desk.ledger if entry.event.kind == "execute"
                and entry.event.summary.get("decision_id") == held.decision_id]) == 1


async def test_answer_twice_resolves_once(app, browser, fake, kernel_http, model, engine, jobs_connector):
    held = await held_request(app, browser, fake, kernel_http, model)
    first = await answer(held, "allow_once")
    assert first.status_code == 200
    (shown,) = await resolved(engine, held.session_id)
    await jobs_done(jobs_connector)

    for choice in ("allow_once", "deny_once"):
        again = await answer(held, choice)
        assert again.status_code == 409
        assert again.json() == {"error": "already_resolved", "decision": first.json()["decision"]}

    jobs = await resume_jobs(jobs_connector)
    assert [(job["task_name"], job["status"]) for job in jobs] == [("desk.resume_after_answer", "succeeded")]
    # The job holds IDs, signed decisions and result fact IDs only: no token, key or code.
    session = fake.sessions[held.session_id]
    approved = jobs[0]["args"]["approved"]
    assert (approved["decision_id"], approved["state"]) == (held.decision_id, "approved")
    assert jobs[0]["args"] == {"copy_id": session.copy_id, "desk_id": session.desk_id, "session_id": held.session_id,
                               "decision": {key: value for key, value in first.json()["decision"].items()
                                            if key != "owner_plain"}, "approved": approved,
                               "result_fact_ids": [fact.fact_id for fact in fake.decisions[held.decision_id].result.facts]}
    before = await sse_events(engine, held.session_id)
    async with engine.connect() as conn:
        messages_before = (await conn.execute(text("SELECT count(*) FROM app.messages WHERE session_id = :s"),
                                              {"s": held.session_id})).scalar_one()
    await app.state.runtime.jobs.configure_task(RESUME_AFTER_ANSWER).defer_async(**jobs[0]["args"])
    assert all(job["status"] == "succeeded" for job in await resume_jobs(jobs_connector))
    assert await sse_events(engine, held.session_id) == before
    async with engine.connect() as conn:
        assert (await conn.execute(text("SELECT count(*) FROM app.messages WHERE session_id = :s"),
                                   {"s": held.session_id})).scalar_one() == messages_before
    assert [payload for type, payload in await sse_events(engine, held.session_id) if type == "resolved"] == [shown]
    executions = [entry for entry in fake.desks[fake.sessions[held.session_id].desk_id].ledger
                  if entry.event.kind == "execute" and entry.event.summary.get("decision_id") == held.decision_id]
    assert len(executions) == 1                                      # the quote was made once


async def test_old_resume_job_publishes_only_the_outcome(app, browser, fake, kernel_http, model, engine,
                                                       jobs_connector):
    held = await held_request(app, browser, fake, kernel_http, model)
    result = await kernel_http.owner(held.owner_token).call(
        "POST /approvals/{decision_id}/answer", AnswerRequest(answer="allow_once"),
        path={"decision_id": held.decision_id})
    assert result.approved is not None
    session = fake.sessions[held.session_id]
    await app.state.runtime.jobs.configure_task(RESUME_AFTER_ANSWER).defer_async(
        copy_id=session.copy_id, desk_id=session.desk_id, session_id=held.session_id,
        decision=result.decision.model_dump(mode="json"))
    (job,) = await resume_jobs(jobs_connector)
    assert job["status"] == "succeeded" and "approved" not in job["args"]
    assert [payload for type, payload in await sse_events(engine, held.session_id)
            if type in ("receipt", "resolved")] == [signed(result.decision.model_dump(mode="json"))]
    async with engine.connect() as conn:
        assert (await conn.execute(text(
            "SELECT count(*) FROM app.messages WHERE session_id = :s AND kind = 'action_update'"),
            {"s": held.session_id})).scalar_one() == 1


async def test_answer_after_expiry_or_cancel(app, browser, fake, kernel_http, model, engine, jobs_connector):
    # A request the visitor withdrew: shown as cancelled then, so the owner's answer leaves nothing more to show.
    cancelled = await held_request(app, browser, fake, kernel_http, model)
    withdrawn = await cancelled.visitor.post(
        f"/api/public/desks/{cancelled.slug}/decisions/{cancelled.decision_id}/cancel")
    assert withdrawn.status_code == 202
    late = await answer(cancelled, "allow_once")
    assert late.status_code == 409
    assert (late.json()["error"], late.json()["decision"]["state"]) == ("already_resolved", "cancelled")
    (shown,) = await resolved(engine, cancelled.session_id)
    assert shown == signed(late.json()["decision"])
    assert await resume_jobs(jobs_connector) == []

    # A request the owner answers a day late: the kernel expires it, and the visitor's next request shows it once.
    expired = await held_request(app, browser, fake, kernel_http, model)
    fake.now += timedelta(hours=13)
    assert (await expired.visitor.get(f"/api/public/desks/{expired.slug}/session")).status_code == 200
    fake.now += timedelta(hours=12)                                  # the hold is past its day; the visitor isn't idle
    model.add(response(reply("Maria didn't get to your request in time; shall I ask again?")))
    late = await answer(expired, "allow_once")
    assert late.status_code == 409
    assert (late.json()["error"], late.json()["decision"]["state"]) == ("already_resolved", "expired")
    await jobs_done(jobs_connector)

    async with Stream(app, events_path(expired.slug), headers=[cookie(expired.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert types(events) == ["writing", "held", "message", "turn_end", "resolved", "writing", "message", "turn_end"]
    assert events[4][1].model_dump(mode="json") == signed(late.json()["decision"])
    assert [type for type, _ in await sse_events(engine, expired.session_id)].count("resolved") == 1
    for held in (cancelled, expired):
        assert [call.route for call in fake.called("POST /execute")
                if call.body and call.body.get("decision_id") == held.decision_id] == []


@pytest.mark.parametrize("choice, final_state", [("allow_once", "refused_at_execution"), ("deny_once", "denied")])
async def test_answer_without_an_approved_snapshot_shows_only_the_outcome(app, browser, fake, kernel_http, model,
                                                                         engine, choice, final_state):
    held = await held_request(app, browser, fake, kernel_http, model)
    fake.never(fake.sessions[held.session_id].desk_id, "native.quote")     # the owner said never for quotes since
    model.add(response(reply("Maria's rules have changed, so I can't offer that one.")))

    answered = await answer(held, choice)

    assert answered.status_code == 200, answered.text
    body = answered.json()
    assert (body["decision"]["state"], body["execution_state"], body["card_diff"]) == (
        final_state, None, None)
    (shown,) = await resolved(engine, held.session_id)
    assert shown == signed(body["decision"])
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert types(events)[4:] == ["resolved", "writing", "message", "turn_end"]
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"{final_state}\\">'
            in json.dumps(model.requests[1].messages))
    assert not [fact for fact in fake.desks[fake.sessions[held.session_id].desk_id].facts.values()
                if fact.kind == "quote" and f"session:{held.session_id}" in fact.label.readers]   # nothing ran


async def test_refusal_reason_stays_on_owner_reads(app, browser, fake, kernel_http, model, engine, jobs_connector):
    held = await held_request(app, browser, fake, kernel_http, model)
    fake.never(fake.sessions[held.session_id].desk_id, "native.quote")
    model.add(response(reply("That request couldn't go ahead. Can I help with something else?")))

    answered = await answer(held, "allow_once")
    assert answered.status_code == 200, answered.text
    decision = answered.json()["decision"]
    owner_line = fake.decisions[held.decision_id].decision.owner_plain
    assert owner_line and decision["state"] == "refused_at_execution"
    assert decision["owner_plain"] == owner_line
    read = await held.owner.get(f"/api/owner/decisions/{held.decision_id}")
    assert read.status_code == 200 and read.json()["owner_plain"] == owner_line

    (job,) = await resume_jobs(jobs_connector)
    assert owner_line not in json.dumps(job["args"])
    assert "owner_plain" not in json.dumps(job["args"])
    assert "result_fact_ids" not in job["args"]                       # a refused answer queues no result IDs
    assert fake.decisions[held.decision_id].decision.owner_plain == owner_line
    visitor_read = await kernel_http.session(held.token).call("GET /decisions/{id}", path={"id": held.decision_id})
    assert visitor_read.owner_plain is None and owner_line not in visitor_read.model_dump_json()

    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    transcript = await held.visitor.get(f"/api/public/desks/{held.slug}/session")
    assert transcript.status_code == 200
    async with engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT row_to_json(m)::text FROM app.messages m WHERE session_id = :s"
            " UNION ALL SELECT row_to_json(e)::text FROM app.run_events e WHERE session_id = :s"),
            {"s": held.session_id})).scalars().all()
        updates = (await conn.execute(text(
            "SELECT text FROM app.messages WHERE session_id = :s AND kind = 'action_update'"),
            {"s": held.session_id})).scalars().all()
    assert updates == [decision["visitor_plain"]]
    for serialized in (transcript.text, json.dumps([event.model_dump(mode="json") for _, event in events]),
                       json.dumps(rows), json.dumps(model.requests[-1].messages)):
        assert owner_line not in serialized
        assert "owner_plain" not in serialized


@pytest.mark.parametrize("path", ["queued", "fallback", "lost_answer", "conflict"])
async def test_owner_reason_is_cleared_before_resume_crossings(app, browser, fake, kernel_http, model, engine,
                                                              jobs_connector, monkeypatch, path):
    from desk.api import jobs
    from desk.api.routes import owner

    held = await held_request(app, browser, fake, kernel_http, model)
    fake.never(fake.sessions[held.session_id].desk_id, "native.quote")
    if path == "lost_answer":
        fake.drop_response("POST /approvals/{decision_id}/answer")
    elif path == "conflict":
        await kernel_http.owner(held.owner_token).call(
            "POST /approvals/{decision_id}/answer", owner.AnswerRequest(answer="allow_once"),
            path={"decision_id": held.decision_id})
    deferred, delivered = [], []
    defer, deliver = owner.defer_resume_after_answer, jobs.deliver

    async def defer_seen(app, ids, decision, approved=None, result_fact_ids=None):
        deferred.append(decision.owner_plain)
        if path == "fallback":
            raise ConnectorException("queue unavailable")
        await defer(app, ids, decision, approved, result_fact_ids=result_fact_ids)

    async def deliver_seen(conn, ids, item, **kwargs):
        delivered.append(item.decision.owner_plain)
        return await deliver(conn, ids, item, **kwargs)

    monkeypatch.setattr(owner, "defer_resume_after_answer", defer_seen)
    monkeypatch.setattr(jobs, "deliver", deliver_seen)
    answered = await answer(held, "allow_once")
    assert answered.status_code == (409 if path in {"lost_answer", "conflict"} else 200), answered.text
    owner_line = answered.json()["decision"]["owner_plain"]
    assert owner_line
    await resolved(engine, held.session_id)
    await jobs_done(jobs_connector)
    assert deferred == [None]
    assert delivered == [None]
    assert fake.decisions[held.decision_id].decision.owner_plain == owner_line


async def test_owner_status_and_tool_history_include_refusal_reason(app, browser, fake, kernel_http, model, engine):
    held = await held_request(app, browser, fake, kernel_http, model)
    desk_id = fake.sessions[held.session_id].desk_id
    fake.never(desk_id, "native.quote")
    answered = await answer(held, "allow_once")
    assert answered.status_code == 200
    owner_line = answered.json()["decision"]["owner_plain"]
    assert owner_line
    await resolved(engine, held.session_id)

    history = await held.owner.get(f"/api/owner/conversations/{held.session_id}")
    assert history.status_code == 200, history.text
    statuses = [item for item in history.json()["items"] if item["kind"] == "status"]
    assert [(item["event"]["state"], item.get("owner_plain")) for item in statuses] == [
        ("held", None), ("refused_at_execution", owner_line)]
    assert all("owner_plain" not in item["event"] for item in statuses)
    tools = await held.owner.get(f"/api/owner/desks/{desk_id}/tools/native.quote/decisions")
    assert tools.status_code == 200, tools.text
    (row,) = [row for row in tools.json()["items"] if row["decision_id"] == held.decision_id]
    assert row["owner_plain"] == owner_line
    assert all(row["owner_plain"] is None for row in tools.json()["items"] if row["state"] != "refused_at_execution")


async def test_lost_answer_response_still_resumes(app, browser, fake, kernel_http, model, engine, jobs_connector):
    held = await held_request(app, browser, fake, kernel_http, model)
    fake.drop_response("POST /approvals/{decision_id}/answer")      # the kernel answers and runs it; the reply is lost

    lost = await answer(held, "allow_once")
    retried = await answer(held, "allow_once")                       # the owner's app tries again

    executed = fake.decisions[held.decision_id].decision
    assert executed.state == "executed"
    for response_ in (lost, retried):
        assert response_.status_code == 409
        assert response_.json() == {"error": "already_resolved", "decision": executed.model_dump(mode="json")}
    (shown,) = await resolved(engine, held.session_id)
    assert shown == signed(executed.model_dump(mode="json"))
    await jobs_done(jobs_connector)
    model.add(response(reply("Good news: Maria said yes.")))
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert types(events)[4:] == ["resolved", "writing", "message", "turn_end"]
    assert [type for type, _ in await sse_events(engine, held.session_id)].count("resolved") == 1
    assert len([call for call in fake.called("POST /approvals/{decision_id}/answer")]) == 2


async def test_retried_answer_during_execution_doesnt_resume(app, browser, fake, kernel_http, model, engine,
                                                            jobs_connector):
    held = await held_request(app, browser, fake, kernel_http, model)
    # The first answer committed its approval; its adapter has not returned yet.
    approved = fake._transition(fake.decisions[held.decision_id], "approved", kind="approval", answer="allow_once")
    before = await sse_events(engine, held.session_id)

    retried = await answer(held, "allow_once")

    assert retried.status_code == 409
    assert retried.json() == {"error": "already_resolved", "decision": approved.model_dump(mode="json")}
    assert await resume_jobs(jobs_connector) == []
    assert await sse_events(engine, held.session_id) == [
        *before, ("receipt", {**signed(approved.model_dump(mode="json")), "type": "receipt"})]
    assert (await session_rows(engine, held.session_id))["control"] == [
        ("decision_pending", held.decision_id, False)]
    async with engine.connect() as conn:
        assert (await conn.execute(text(
            "SELECT count(*) FROM app.messages WHERE session_id = :s AND kind = 'action_update'"),
            {"s": held.session_id})).scalar_one() == 0
        assert (await conn.execute(text(
            "SELECT count(*) FROM app.run_events WHERE session_id = :s AND kind = 'control'"
            " AND type = 'run_resumable'"), {"s": held.session_id})).scalar_one() == 0
    assert len(model.requests) == 1


async def test_lost_answer_while_approved_keeps_an_unknown_outcome_pending(
        app, browser, fake, kernel_http, model, engine, jobs_connector, monkeypatch):
    held = await held_request(app, browser, fake, kernel_http, model)
    run = fake._run

    def response_lost(record, session, exec_state=None):
        # Approval committed, but the adapter is still running when the answer times out.
        record.running = True
        raise httpx.ReadTimeout("the answer's response was lost during execution")

    monkeypatch.setattr(fake, "_run", response_lost)
    lost = await answer(held, "allow_once")
    approved = fake.decisions[held.decision_id].decision
    assert approved.state == "approved"
    assert lost.status_code == 409
    assert lost.json() == {"error": "already_resolved", "decision": approved.model_dump(mode="json")}
    found = await session_rows(engine, held.session_id)
    assert found["control"] == [("decision_pending", held.decision_id, False)]
    assert [payload for type, payload in await sse_events(engine, held.session_id) if type == "receipt"] == [
        {**signed(approved.model_dump(mode="json")), "type": "receipt"}]
    assert found["action_update"] == []
    assert (await answer(held, "allow_once")).status_code == 409
    assert await session_rows(engine, held.session_id) == found       # retry adds no receipt or pending row
    assert await resume_jobs(jobs_connector) == []

    monkeypatch.setattr(fake, "_run", run)
    assert fake.finish(held.decision_id, "unknown").state == "unknown"
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        await stream.until(lambda events: "receipt" in types(events))
    await app.state.runtime.runner.drain()
    assert await session_rows(engine, held.session_id) == found       # unknown stays pending, without waking Claude
    assert len(model.requests) == 1

    final = fake.reconcile(held.decision_id)
    model.add(response(reply("Good news: Maria said yes.")))
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert [event.model_dump(mode="json") for _, event in events if event.type == "resolved"] == [
        signed(final.model_dump(mode="json"))]
    found = await session_rows(engine, held.session_id)
    assert [state for type, state in found["sse"] if type in ("held", "receipt", "resolved")] == [
        "held", "approved", "executed"]
    assert found["control"] == [("decision_pending", held.decision_id, True)]
    assert found["action_update"] == [(held.decision_id, final.visitor_plain, True)]
    assert len(model.requests) == 2
    assert (await answer(held, "allow_once")).status_code == 409
    assert await session_rows(engine, held.session_id) == found       # final retry publishes nothing


async def test_unreadable_or_unanswered_is_503(app, browser, fake, kernel_http, model, engine, jobs_connector):
    """When the answer's response is lost and the decision can't be read, or is still held (the answer never
    reached the kernel), the owner gets 503 and may answer again; an answer the request doesn't offer is 422."""
    held = await held_request(app, browser, fake, kernel_http, model)
    unavailable = {"error": "kernel", "code": "kernel_unavailable"}
    fake.fail("POST /approvals/{decision_id}/answer", "timeout", times=1)          # never reached the kernel
    assert ((r := await answer(held, "allow_once")).status_code, r.json()) == (503, unavailable)
    fake.drop_response("POST /approvals/{decision_id}/answer")
    fake.fail("GET /decisions/{id}", "connect", times=1)
    assert ((r := await answer(held, "deny_once")).status_code, r.json()) == (503, unavailable)
    assert fake.decisions[held.decision_id].decision.state == "denied"
    assert ((r := await answer(held, "deny_once")).status_code, r.json()["error"]) == (409, "already_resolved")

    unverified = await held_request(app, browser, fake, kernel_http, model)
    refused = await answer(unverified, "allow_person")             # offered only for a verified person
    assert (refused.status_code, refused.json()) == (422, {"error": "kernel", "code": "invalid"})
    assert fake.decisions[unverified.decision_id].decision.state == "held"
    bad = await unverified.owner.post(f"/api/owner/approvals/{unverified.decision_id}/answer",
                                      json={"answer": "allow_always"})
    assert (bad.status_code, bad.json()) == (422, {"error": "invalid"})
    await jobs_done(jobs_connector)
    assert [payload["state"] for type, payload in await sse_events(engine, held.session_id) if type == "resolved"] == [
        "denied"]


async def test_a_failed_answer_to_a_held_request_keeps_the_kernels_error(app, browser, fake, kernel_http, model,
                                                                        engine, jobs_connector):
    """Only a request that left `held` is `already_resolved`. A kernel refusal or fault while the request is still
    held keeps the kernel's own status and code ("Errors"), so the owner's app shows an error and not an answer."""
    held = await held_request(app, browser, fake, kernel_http, model)

    fake.fail("POST /approvals/{decision_id}/answer", "409", times=1)
    conflict = await answer(held, "allow_once")
    assert (conflict.status_code, conflict.json()) == (409, {"error": "kernel", "code": "conflict"})
    fake.fail("POST /approvals/{decision_id}/answer", "500", times=1)
    fault = await answer(held, "allow_once")
    assert (fault.status_code, fault.json()) == (503, {"error": "kernel", "code": "internal"})

    assert fake.decisions[held.decision_id].decision.state == "held"
    assert await resume_jobs(jobs_connector) == []
    assert [type for type, _ in await sse_events(engine, held.session_id)] == ["writing", "held", "message",
                                                                              "turn_end"]
    assert (await answer(held, "allow_once")).status_code == 200          # answering again is safe


async def test_answer_resumes_in_the_request_when_the_queue_cant_take_the_job(app, browser, fake, kernel_http, model,
                                                                              engine, jobs_connector, monkeypatch,
                                                                              caplog):
    """When the job queue can't take the resume job, the request does its work itself: like the job, it holds only
    IDs and the signed record, makes no kernel call and needs no credential. The visitor sees the outcome at once and
    Claude follows up on the visitor's next request, as after the job."""
    held = await held_request(app, browser, fake, kernel_http, model)

    async def unreachable(jobs):
        raise ConnectorException("the job queue's database can't be reached")

    monkeypatch.setattr(jobs_connector, "defer_jobs_all", unreachable)
    model.add(response(reply("Good news: Maria said yes.")))
    calls = len(fake.calls)

    answered = await answer(held, "allow_once")

    assert answered.status_code == 200, answered.text
    shown = [payload for type, payload in await sse_events(engine, held.session_id) if type == "resolved"]
    assert shown == [signed(answered.json()["decision"])]                 # shown before the answer returned
    assert [(type, payload["state"]) for type, payload in await sse_events(engine, held.session_id)
            if type in ("receipt", "resolved")] == [("receipt", "approved"), ("resolved", "executed")]
    assert [job for job in jobs_connector.jobs.values() if job["task_name"] == RESUME_AFTER_ANSWER] == []
    made = fake.calls[calls:]                                           # the owner's, and nothing with the visitor's
    assert [call.route for call in made] == ["GET /whoami", "POST /approvals/{decision_id}/answer"]
    assert all(call.headers[OWNER] == held.owner_token and VISITOR not in call.headers for call in made)
    assert ("desk.api.routes.owner", "the resume job couldn't be queued (ConnectorException); resuming here") in [
        (record.name, record.getMessage()) for record in caplog.records]

    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert types(events)[4:] == ["receipt", "resolved", "writing", "message", "turn_end"]
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"executed\\" result_fact_ids='
            in json.dumps(model.requests[1].messages))


async def test_answer_stands_when_neither_the_queue_nor_the_request_can_resume(app, browser, fake, kernel_http, model,
                                                                              engine, jobs_connector, ro_schema,
                                                                              monkeypatch, caplog):
    """When the job queue can't take the resume job and the request can't do its work either, the owner's answer
    still stands: both errors are logged by type only and nothing is shown yet. The minute scan then finds the
    decision final in kernel_ro and leaves a `decision_due` row, for the visitor's next request to show it."""
    held = await held_request(app, browser, fake, kernel_http, model)

    async def unreachable(jobs):
        raise ConnectorException("the job queue's database can't be reached")

    async def unresumable(conn, ids, decision, approved=None, result_fact_ids=None):
        raise RuntimeError(f"no resume for {decision.reason_plain}")

    monkeypatch.setattr(jobs_connector, "defer_jobs_all", unreachable)
    monkeypatch.setattr("desk.api.routes.owner.resume_after_answer", unresumable)

    answered = await answer(held, "allow_once")

    assert answered.status_code == 200, answered.text
    assert answered.json()["decision"]["state"] == fake.decisions[held.decision_id].decision.state == "executed"
    assert [record.getMessage() for record in caplog.records if record.name == "desk.api.routes.owner"] == [
        "the resume job couldn't be queued (ConnectorException); resuming here",
        "the answer couldn't be resumed here either (RuntimeError)"]
    assert [type for type, _ in await sse_events(engine, held.session_id)] == ["writing", "held", "message",
                                                                              "turn_end"]
    assert [job for job in jobs_connector.jobs.values() if job["task_name"] == RESUME_AFTER_ANSWER] == []

    assert await surface_due_decisions(engine, now=fake.now, ro_schema=ro_schema) == 1
    async with engine.connect() as conn:
        due = (await conn.execute(text("SELECT payload FROM app.run_events WHERE session_id = :s"
                                       " AND kind = 'control' AND type = 'decision_due'"),
                                  {"s": held.session_id})).scalars().all()
    assert due == [{"decision_id": held.decision_id}]


async def test_answer_during_take_over_executes_and_waits_for_hand_back(app, browser, fake, kernel_http, model,
                                                                        engine):
    held = await held_request(app, browser, fake, kernel_http, model)
    fake.set_mode(held.session_id, "owner")                          # the owner took the chat over
    calls_before = len(model.requests)

    answered = await answer(held, "allow_once")
    assert answered.status_code == 200
    assert answered.json()["decision"]["state"] == "executed"        # a take-over doesn't cancel a held action
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: "resolved" in types(events))
        await app.state.runtime.runner.drain()                       # the resumed work ran, and waits for the owner
    assert types(events) == ["writing", "held", "message", "turn_end", "receipt", "resolved"]
    assert len(model.requests) == calls_before
    async with engine.connect() as conn:
        waiting = (await conn.execute(text(
            "SELECT wake, model_seq FROM app.messages WHERE session_id = :s AND kind = 'action_update'"),
            {"s": held.session_id})).all()
        resumable = (await conn.execute(text(
            "SELECT handled_at IS NOT NULL FROM app.run_events WHERE session_id = :s AND type = 'run_resumable'"),
            {"s": held.session_id})).scalars().all()
    assert [tuple(row) for row in waiting] == [(True, None)] and resumable == [True]

    fake.set_mode(held.session_id, "ai")                             # handed back: Claude follows up
    model.add(response(reply("Good news: Maria said yes.")))
    async with Stream(app, events_path(held.slug, "after=6"), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()
    assert types(events) == ["writing", "message", "turn_end"]
    assert len(model.requests) == calls_before + 1
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"executed\\" result_fact_ids='
            in json.dumps(model.requests[-1].messages))
