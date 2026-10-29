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

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.exceptions import ConnectorException
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from desk.api.main import create_app
from desk.kernel_api import CreateCopyRequest
from tests.api.fakes import ScriptedModel, response, tool_use
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


async def test_allow_once_resumes_with_the_visitor_credential(app, browser, fake, kernel_http, model, engine):
    held = await held_request(app, browser, fake, kernel_http, model)
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
    assert model.requests[1:] == []                                  # no follow-up without the visitor's credential
    answered_at = len(fake.calls)

    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()

    assert types(events) ==["writing", "held", "message", "turn_end", "resolved", "writing", "message", "turn_end"]
    assert events[6][1].blocks[0].text == "Good news: Maria said yes."
    follow_up = json.dumps(model.requests[1].messages)
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"executed\\">' in follow_up)
    after = fake.calls[answered_at:]
    assert "POST /check_reply" in [call.route for call in after]
    assert all(call.headers.get(VISITOR) == held.token and OWNER not in call.headers for call in after)


async def jobs_done(connector: InMemoryConnector, timeout: float = 5.0) -> list[dict]:
    """The queue's jobs, once the worker has finished every one of them."""
    async def wait() -> None:
        while any(job["status"] in ("todo", "doing") for job in connector.jobs.values()):
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), timeout)
    return list(connector.jobs.values())


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

    jobs = await jobs_done(jobs_connector)
    assert [(job["task_name"], job["status"]) for job in jobs] == [("desk.resume_after_answer", "succeeded")]
    assert [payload for type, payload in await sse_events(engine, held.session_id) if type == "resolved"] == [shown]
    executions = [entry for entry in fake.desks[fake.sessions[held.session_id].desk_id].ledger
                  if entry.event.kind == "execute" and entry.event.summary.get("decision_id") == held.decision_id]
    assert len(executions) == 1                                      # the quote was made once


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
    assert await jobs_done(jobs_connector) == []

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


async def test_rules_changed_resolves_as_refused_at_execution(app, browser, fake, kernel_http, model, engine):
    held = await held_request(app, browser, fake, kernel_http, model)
    fake.never(fake.sessions[held.session_id].desk_id, "native.quote")     # the owner said never for quotes since
    model.add(response(reply("Maria's rules have changed, so I can't offer that one.")))

    answered = await answer(held, "allow_once")

    assert answered.status_code == 200, answered.text
    body = answered.json()
    assert (body["decision"]["state"], body["execution_state"], body["card_diff"]) == (
        "refused_at_execution", None, None)
    (shown,) = await resolved(engine, held.session_id)
    assert shown == signed(body["decision"])
    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert types(events)[4:] == ["resolved", "writing", "message", "turn_end"]
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"refused_at_execution\\">'
            in json.dumps(model.requests[1].messages))
    assert not [fact for fact in fake.desks[fake.sessions[held.session_id].desk_id].facts.values()
                if fact.kind == "quote" and f"session:{held.session_id}" in fact.label.readers]   # nothing ran


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
    assert await jobs_done(jobs_connector) == []
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
    assert jobs_connector.jobs == {}
    made = fake.calls[calls:]                                           # the owner's, and nothing with the visitor's
    assert [call.route for call in made] == ["GET /whoami", "POST /approvals/{decision_id}/answer"]
    assert all(call.headers[OWNER] == held.owner_token and VISITOR not in call.headers for call in made)
    assert ("desk.api.routes.owner", "the resume job couldn't be queued (ConnectorException); resuming here") in [
        (record.name, record.getMessage()) for record in caplog.records]

    async with Stream(app, events_path(held.slug), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: types(events).count("turn_end") == 2)
    await app.state.runtime.runner.drain()
    assert types(events)[4:] == ["resolved", "writing", "message", "turn_end"]
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"executed\\">'
            in json.dumps(model.requests[1].messages))


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
    assert types(events) == ["writing", "held", "message", "turn_end", "resolved"]
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
    async with Stream(app, events_path(held.slug, "after=5"), headers=[cookie(held.token)]) as stream:
        events = await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()
    assert types(events) == ["writing", "message", "turn_end"]
    assert len(model.requests) == calls_before + 1
    assert (f'<action_update decision_id=\\"{held.decision_id}\\" state=\\"executed\\">'
            in json.dumps(model.requests[-1].messages))
