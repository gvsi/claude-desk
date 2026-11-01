"""Credentials at rest (Plan 02a, "Credentials at rest"; master plan, "Resuming the conversation"): tokens live only in
cookies and in the memory of the request or turn holding them, never in `app.*`, the job queue's arguments, a model
request or a log, through a whole conversation with an owner's answer in the middle of it. The logs carry no visitor
text either: the job queue names a job with its arguments below WARNING and when the job fails, and the resume job's
signed decision quotes the visitor (its `reason_plain`)."""

import asyncio
import hashlib
import json
import logging
import traceback
from collections.abc import AsyncIterator

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text as sql
from sqlalchemy.exc import DBAPIError

from desk.api import jobs
from desk.api.jobs import RESUME_AFTER_ANSWER, TRANSLATE_MESSAGE
from desk.api.main import create_app
from desk.api.routes import public
from desk.db.tables import APP_TABLES
from tests.api.conftest import PASSCODE
from tests.api.fakes import ScriptedModel, response, tool_use
from tests.api.test_approvals import jobs_done, resolved
from tests.api.test_public_chat import DISCOUNTED_QUOTE, Stream, cookie, events_path, new_slug, reply, types
from tests.kernel_contract.fake_kernel import fake_kernel_app


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def jobs_connector() -> InMemoryConnector:
    return InMemoryConnector()


@pytest.fixture
async def app(db, fake, api_settings, clock, model, jobs_connector) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=jobs_connector)
    async with app.router.lifespan_context(app):
        yield app


def cookie_value(response: httpx.Response, name: str) -> str:
    (header,) = [value for value in response.headers.get_list("set-cookie") if value.startswith(name + "=")]
    return header.split(";", 1)[0].split("=", 1)[1]


def at_rest(admin: psycopg.Connection) -> str:
    """Every row of every `app.*` table and of the job queue's tables, as text."""
    tables = [f"app.{table}" for table in APP_TABLES] + [
        f"procrastinate.{table}" for table in ("procrastinate_jobs", "procrastinate_events",
                                               "procrastinate_periodic_defers", "procrastinate_workers")]
    return "\n".join(row[0] for table in tables
                     for row in admin.execute(f"SELECT row_to_json(t)::text FROM {table} t").fetchall())


async def test_no_credential_at_rest_after_a_full_flow(app, browser, fake, model, engine, db, jobs_connector, caplog):
    caplog.set_level(logging.DEBUG)
    owner = browser(app)
    created = await owner.post("/api/owner/copies", json={"passcode": PASSCODE})
    assert created.status_code == 201
    owner_token = cookie_value(created, "desk_owner")
    slug = created.json()["desks"][0]["slug"]

    visitor = browser(app, ip="198.51.100.20")
    opened = await visitor.post(f"/api/public/desks/{slug}/sessions")
    token, session_id = cookie_value(opened, "desk_visitor"), opened.json()["state"]["session_id"]
    runner = app.state.runtime.runner

    # A held request, the owner's answer, the resume job and Claude's follow-up with the visitor's credential. Claude
    # passes the visitor's words on to Maria, so the decision the job carries quotes them.
    said = ["A discount, please? The sink flooded twice", "Are you there?", "Thanks!"]
    model.add(response(tool_use("native__quote", {**DISCOUNTED_QUOTE, "note": said[0]}),
                       reply("I've asked Maria to look at this.")))
    asked = await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": said[0]})
    assert asked.status_code == 202
    await runner.drain()
    (decision_id,) = [record.decision.decision_id for record in fake.decisions.values()
                      if record.decision.session_id == session_id and record.decision.state == "held"]
    answered = await owner.post(f"/api/owner/approvals/{decision_id}/answer", json={"answer": "allow_once"})
    assert answered.status_code == 200
    await resolved(engine, session_id)
    model.add(response(reply("Good news: Maria said yes.")))
    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        await stream.until(lambda events: types(events).count("turn_end") == 2)
    await runner.drain()

    # A take-over: the visitor's message waits for the owner, and Claude answers again once it is handed back.
    fake.set_mode(session_id, "owner")
    waiting = await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": said[1]})
    assert waiting.status_code == 202
    await runner.drain()
    fake.set_mode(session_id, "ai")
    model.add(response(reply("Yes, I'm here.")))
    assert (await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": said[2]})).status_code == 202
    await runner.drain()
    await jobs_done(jobs_connector)
    assert len(model.requests) == 3 and sorted(job["task_name"] for job in jobs_connector.jobs.values()) == [
        RESUME_AFTER_ANSWER, *[TRANSLATE_MESSAGE] * len(said)]                 # each message's translation too
    assert said[0] in json.dumps([job["args"] for job in jobs_connector.jobs.values()])   # quoted for the owner
    assert [sorted(job["args"]) for job in jobs_connector.jobs.values() if job["task_name"] == TRANSLATE_MESSAGE] == [
        ["copy_id", "message_id"]] * len(said)                                 # a translation holds only IDs

    secrets = {f"{who} token{form}": value for who, held in (("owner", owner_token), ("visitor", token))
               for form, value in (("", held), (" hash", hashlib.sha256(held.encode()).hexdigest()))}
    stored = at_rest(db)
    queued = json.dumps([job["args"] for job in jobs_connector.jobs.values()])
    sent_to_model = json.dumps([[request.system, request.messages] for request in model.requests])
    await asyncio.sleep(0)
    logged = "\n".join(record.getMessage() + (record.exc_text or "") for record in caplog.records)
    assert stored and queued and sent_to_model and logged
    for where, text in (("app and procrastinate tables", stored), ("job arguments", queued),
                        ("model requests", sent_to_model), ("logs", logged)):
        assert [name for name, value in secrets.items() if value in text] == [], where
    # The job queue logs nothing below WARNING, and no record, its extra fields included, holds what the visitor said.
    assert [(record.name, record.levelname) for record in caplog.records
            if record.name.split(".")[0] == "procrastinate" and record.levelno <= logging.INFO] == []
    every_field = "\n".join(repr(vars(record)) for record in caplog.records)
    assert [text for text in said if text in logged or text in every_field] == []


JOB_FAILED = "the resume job failed on purpose"


@pytest.mark.parametrize("job_queue_level", [None, logging.DEBUG], ids=["as built", "turned up to debug"])
async def test_a_failed_resume_job_logs_no_arguments(app, browser, fake, model, jobs_connector, caplog, monkeypatch,
                                                     job_queue_level):
    """The job queue logs a failed job at ERROR. That record names the action, the task and the job, and the error by
    its type only: never the job's arguments (the signed decision quotes the visitor), the error's message or its
    traceback. The same holds for every record that carries a job when the job queue's loggers are turned up."""
    if job_queue_level is not None:
        for name in [name for name in logging.root.manager.loggerDict if name.split(".")[0] == "procrastinate"]:
            caplog.set_level(job_queue_level, logger=name)
    caplog.set_level(logging.DEBUG)
    owner = browser(app)
    slug = (await owner.post("/api/owner/copies", json={"passcode": PASSCODE})).json()["desks"][0]["slug"]
    visitor = browser(app, ip="198.51.100.20")
    session_id = (await visitor.post(f"/api/public/desks/{slug}/sessions")).json()["state"]["session_id"]
    said = "A discount, please? The sink flooded twice"
    model.add(response(tool_use("native__quote", {**DISCOUNTED_QUOTE, "note": said}),
                       reply("I've asked Maria to look at this.")))
    assert (await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": said})).status_code == 202
    await app.state.runtime.runner.drain()
    (decision_id,) = [record.decision.decision_id for record in fake.decisions.values()
                      if record.decision.session_id == session_id and record.decision.state == "held"]

    async def fails(conn, ids, decision, approved=None, *, result_fact_ids=None):
        raise RuntimeError(f"{JOB_FAILED}: {decision.reason_plain}")

    monkeypatch.setattr(jobs, "resume_after_answer", fails)
    answered = await owner.post(f"/api/owner/approvals/{decision_id}/answer", json={"answer": "allow_once"})
    assert answered.status_code == 200
    (job,) = [job for job in await jobs_done(jobs_connector) if job["task_name"] == RESUME_AFTER_ANSWER]
    assert job["status"] == "failed" and said in json.dumps(job["args"])     # what the job held quoted the visitor

    assert [(record.name, record.levelname, record.getMessage()) for record in caplog.records
            if record.name.split(".")[0] == "procrastinate" and record.levelno >= logging.WARNING] == [
        ("procrastinate.worker", "ERROR", f"job_error: {RESUME_AFTER_ANSWER}[{job['id']}] (RuntimeError)")]
    logged = "\n".join([caplog.text, *(record.getMessage() + repr(record.args) + repr(vars(record))
                                       for record in caplog.records)])
    assert [text for text in (JOB_FAILED, said) if text in logged] == []


async def test_a_database_error_in_a_route_logs_no_parameter_value(app, browser, fake, kernel_http, monkeypatch,
                                                                    caplog):
    """A route whose database work fails answers the static 500, and the error the server then logs (the exception
    Starlette raises again once the 500 is sent) names the statement but never its parameters, so the visitor's words
    don't reach a log through it."""
    caplog.set_level(logging.DEBUG)
    said = "Call me on 555 0100, I'm at 12 Elm Street"

    async def failing(conn, ids, kind, **fields):                     # storing the message fails in the database
        await conn.execute(sql("SELECT 1 / 0 WHERE CAST(:said AS text) IS NOT NULL"), {"said": fields["text"]})

    monkeypatch.setattr(public, "append_message", failing)
    slug = await new_slug(kernel_http, fake)
    visitor = browser(app)
    assert (await visitor.post(f"/api/public/desks/{slug}/sessions")).status_code == 200
    with pytest.raises(DBAPIError) as raised:
        await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": said})

    server_log = "".join(traceback.format_exception(raised.value))
    assert "division by zero" in server_log and "SQL parameters hidden" in server_log
    logged = "\n".join([server_log, caplog.text, *(repr(vars(record)) for record in caplog.records)])
    assert said not in logged
