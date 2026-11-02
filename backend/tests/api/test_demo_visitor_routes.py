"""The owner's demo visitor routes (`routes/owner.py`) and how the owner's reads tell its chat apart.

The owner starts a demo visitor on one of the copy's own Desks, reads the newest one there, and stops it; each route
acts only in the owner cookie's copy. The app builds and closes its demo visitors itself (`main.py`), and the chat a
demo visitor opens is marked in the API's own transcript, so the owner's Conversations and transcript still flag it
once the process that ran it is gone.

The app runs on FakeKernel, and its demo visitors reach the app itself through the in-process streaming transport
(`StreamingLoopback`). The model is scripted per route (`ByRoute`). A step that is done at once, or one held open
(`gated`), keeps every run here free of the runner's human pauses, which are real sleeps in the app's own runs.
"""

import asyncio
import contextlib
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from desk.api.main import create_app
from desk.api.metrics import record_model_call
from desk.api.prompts import demo_visitor_brief
from desk.contracts import CopyCreated
from desk.kernel_api import CreateCopyRequest
from tests.api.fakes import ScriptedModel, gated
from tests.api.loopback import StreamingLoopback
from tests.api.test_copies import production_settings, usage_row
from tests.api.test_demo_agent import owner_desk, setup_row
from tests.api.test_demo_visitors import ByRoute, owner_of, say, step
from tests.api.test_public_chat import open_session
from tests.kernel_contract.fake_kernel import fake_kernel_app


@pytest.fixture
def visitor_model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def desk_model() -> ScriptedModel:
    return ScriptedModel()


@contextlib.asynccontextmanager
async def running(fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    """The API app on FakeKernel with its lifespan running, its demo visitors reaching it in process."""
    fake.now = clock.now
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    app.state.runtime.a2a_transport = StreamingLoopback(app)
    async with app.router.lifespan_context(app):
        yield app


@pytest.fixture
async def app(db, fake, api_settings, clock, visitor_model, desk_model) -> AsyncIterator[FastAPI]:
    async with running(fake, api_settings, clock, ByRoute(visitor_model, desk_model)) as app:
        yield app


@pytest.fixture
async def copy(kernel_http) -> CopyCreated:
    """A fresh Turner copy: its own Desk is the copy's first."""
    return await kernel_http.public().call("POST /copies", CreateCopyRequest())


def visitor_sessions(fake) -> set[str]:
    return {session_id for session_id, session in fake.sessions.items() if session.kind == "visitor"}


async def start(owner: httpx.AsyncClient, desk_id: str, key: str = "click-1") -> httpx.Response:
    return await owner.post(f"/api/owner/desks/{desk_id}/demo_visitor", json={"idempotency_key": key})


async def test_starting_one_answers_its_run_and_its_open_session(app, browser, fake, copy, visitor_model):
    owner = owner_of(app, browser, copy)
    desk_id = copy.desk_ids[0]
    before = visitor_sessions(fake)
    visitor_model.add(step("", done=True))

    started = await start(owner, desk_id)
    assert started.status_code == 202, started.text
    body = started.json()
    assert set(body) == {"run_id", "desk_id", "session_id"} and body["desk_id"] == desk_id
    (opened,) = visitor_sessions(fake) - before            # a new visitor session on the Desk, opened by the run
    assert body["session_id"] == opened and fake.sessions[opened].desk_id == desk_id

    await app.state.runtime.demo_visitors.drain()
    newest = await owner.get(f"/api/owner/desks/{desk_id}/demo_visitor")
    assert newest.status_code == 200, newest.text
    assert newest.json() == {"run_id": body["run_id"], "desk_id": desk_id, "first_name": "Riley",
                             "session_id": opened, "state": "done", "messages_sent": 0, "ended": "finished"}


async def test_the_routes_need_the_owner_and_one_of_the_copys_own_desks(app, browser, fake, kernel_http, copy,
                                                                        visitor_model):
    other = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    before = visitor_sessions(fake)                         # each copy's seeded chat among them
    desk_id = copy.desk_ids[0]
    # No owner cookie: 401, and nothing starts.
    stranger = browser(app)
    refused = await start(stranger, desk_id)
    assert (refused.status_code, refused.json()) == (401, {"error": "no_owner_session"})
    unread = await stranger.get(f"/api/owner/desks/{desk_id}/demo_visitor")
    assert (unread.status_code, unread.json()) == (401, {"error": "no_owner_session"})

    # Another copy's Desk, or no Desk at all, is 404 to this copy's owner.
    owner = owner_of(app, browser, copy)
    for elsewhere in (other.desk_ids[0], "desk-unknown"):
        started = await start(owner, elsewhere)
        assert (started.status_code, started.json()) == (404, {"error": "not_found"})
        read = await owner.get(f"/api/owner/desks/{elsewhere}/demo_visitor")
        assert (read.status_code, read.json()) == (404, {"error": "not_found"})
    # And a Desk with no demo visitor yet has none to read.
    none_yet = await owner.get(f"/api/owner/desks/{desk_id}/demo_visitor")
    assert (none_yet.status_code, none_yet.json()) == (404, {"error": "not_found"})
    assert visitor_sessions(fake) == before and visitor_model.requests == []


async def test_a_key_answers_the_run_it_started(app, browser, fake, kernel_http, clock, copy, visitor_model):
    owner = owner_of(app, browser, copy)
    desk_id = copy.desk_ids[0]
    before = visitor_sessions(fake)
    visitor_model.add(step("", done=True))
    first = await start(owner, desk_id, key="click-1")
    assert first.status_code == 202, first.text
    await app.state.runtime.demo_visitors.drain()

    # The click's request sent again (its answer was lost): the same run, however it ended, and nothing new opens.
    repeat = await start(owner, desk_id, key="click-1")
    assert (repeat.status_code, repeat.json()) == (202, first.json())
    assert len(visitor_sessions(fake) - before) == 1 and len(visitor_model.requests) == 1

    # The same key to another of the copy's Desks is a conflict, and a start without a key is refused.
    other_desk, _ = await owner_desk(kernel_http, fake, clock, copy.owner_token, "Turner Emergency")
    conflict = await start(owner, other_desk, key="click-1")
    assert (conflict.status_code, conflict.json()) == (409, {"error": "conflict"})
    keyless = await owner.post(f"/api/owner/desks/{desk_id}/demo_visitor", json={})
    assert (keyless.status_code, keyless.json()) == (422, {"error": "invalid"})
    assert len(visitor_sessions(fake) - before) == 1 and len(visitor_model.requests) == 1


async def test_one_runs_at_a_time_in_a_copy_until_the_owner_stops_it(app, browser, fake, kernel_http, clock, copy,
                                                                     visitor_model):
    owner = owner_of(app, browser, copy)
    desk_id = copy.desk_ids[0]
    release = asyncio.Event()
    thinking = gated(step("never sent"), release)            # its first step is still being written
    visitor_model.add(thinking)
    first = await start(owner, desk_id, key="click-1")
    assert first.status_code == 202, first.text
    await asyncio.wait_for(thinking.entered.wait(), 5)
    before = visitor_sessions(fake)

    # Another click while it runs, on any of the copy's Desks, answers the running one and opens nothing.
    other_desk, _ = await owner_desk(kernel_http, fake, clock, copy.owner_token, "Turner Emergency")
    for desk in (desk_id, other_desk):
        again = await start(owner, desk, key=f"click-on-{desk}")
        assert (again.status_code, again.json()) == (202, first.json())
    assert visitor_sessions(fake) == before
    running = await owner.get(f"/api/owner/desks/{desk_id}/demo_visitor")
    assert (running.json()["state"], running.json()["ended"]) == ("running", None)

    # Stopping it: only its own copy's owner, on the Desk it runs on.
    run_id = first.json()["run_id"]
    stop = f"/api/owner/desks/{desk_id}/demo_visitor/{run_id}/stop"
    stranger = await browser(app).post(stop)
    assert (stranger.status_code, stranger.json()) == (401, {"error": "no_owner_session"})
    other = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    for path in (f"/api/owner/desks/{other_desk}/demo_visitor/{run_id}/stop",
                 f"/api/owner/desks/{desk_id}/demo_visitor/visitor-unknown/stop"):
        missing = await owner.post(path)
        assert (missing.status_code, missing.json()) == (404, {"error": "not_found"}), path
    elsewhere = await owner_of(app, browser, other).post(
        f"/api/owner/desks/{other.desk_ids[0]}/demo_visitor/{run_id}/stop")
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})

    stopped = await owner.post(stop)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json() == {"run_id": run_id, "desk_id": desk_id, "first_name": "Riley",
                              "session_id": first.json()["session_id"], "state": "stopped", "messages_sent": 0,
                              "ended": "stopped_by_owner"}
    release.set()
    await app.state.runtime.demo_visitors.drain()
    assert len(visitor_model.requests) == 1                   # no further step was asked
    assert app.state.runtime.stream_slots.open_counts() == ({}, {})       # its stream closed
    newest = await owner.get(f"/api/owner/desks/{desk_id}/demo_visitor")
    assert newest.json() == stopped.json()
    # Stopping it again answers it as it is.
    assert (await owner.post(stop)).json() == stopped.json()


async def test_a_copy_starts_three_an_hour(app, browser, fake, clock, copy, visitor_model):
    owner = owner_of(app, browser, copy)
    desk_id = copy.desk_ids[0]
    for n in range(3):
        visitor_model.add(step("", done=True))
        started = await start(owner, desk_id, key=f"click-{n}")
        assert started.status_code == 202, started.text
        await app.state.runtime.demo_visitors.drain()
    before = visitor_sessions(fake)

    # The fourth within the hour waits until the first start's hour ends, in the repo's usual 429.
    clock.advance(600)
    refused = await start(owner, desk_id, key="click-3")
    assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 3000})
    assert refused.headers["retry-after"] == "3000"
    assert visitor_sessions(fake) == before and len(visitor_model.requests) == 3

    clock.advance(3000)
    visitor_model.add(step("", done=True))
    assert (await start(owner, desk_id, key="click-4")).status_code == 202
    await app.state.runtime.demo_visitors.drain()


async def test_none_starts_once_todays_model_budget_is_spent(app, browser, fake, clock, copy, visitor_model,
                                                             api_settings, passcode_hash, engine):
    runtime = app.state.runtime
    runtime.settings = production_settings(passcode_hash, api_database_url=api_settings.api_database_url,
                                           kernel_ro_schema=api_settings.kernel_ro_schema, trusted_proxy_hops=0)
    async with engine.begin() as conn:                     # $150 spent today: the whole budget
        await record_model_call(conn, "copy-budget", None, "setup", usage_row(7_500_000, clock()))
    before = visitor_sessions(fake)
    refused = await start(owner_of(app, browser, copy), copy.desk_ids[0])
    assert (refused.status_code, refused.json()) == (503, {"error": "demo_budget"})
    assert visitor_sessions(fake) == before and visitor_model.requests == []
    assert runtime.demo_visitors.newest(copy.copy_id, copy.desk_ids[0]) is None


async def test_a_run_whose_session_never_opened_is_unavailable(app, browser, fake, copy, visitor_model):
    owner = owner_of(app, browser, copy)
    fake.fail("POST /sessions", "422", times=1)            # the Desk won't open the visitor's session
    refused = await start(owner, copy.desk_ids[0])
    assert (refused.status_code, refused.json()) == (503, {"error": "demo_visitor_unavailable"})
    assert visitor_model.requests == []
    failed = await owner.get(f"/api/owner/desks/{copy.desk_ids[0]}/demo_visitor")
    assert (failed.json()["state"], failed.json()["ended"], failed.json()["session_id"]) == ("failed", "failed", None)


async def test_it_plays_the_persona_of_the_desks_set(app, browser, fake, kernel_http, clock, engine, copy,
                                                    visitor_model):
    # A Desk setup made for an office: its demo visitor is the office persona, chosen by that set alone.
    desk_id, slug = await owner_desk(kernel_http, fake, clock, copy.owner_token, "Nair Advisory")
    await setup_row(engine, copy.copy_id, desk_id, "office")
    visitor_model.add(step("", done=True))
    started = await start(owner_of(app, browser, copy), desk_id)
    assert started.status_code == 202, started.text
    await app.state.runtime.demo_visitors.drain()

    assert fake.sessions[started.json()["session_id"]].desk_id == desk_id
    run = app.state.runtime.demo_visitors.run(started.json()["run_id"], copy.copy_id)
    assert (run.desk_id, run.first_name) == (desk_id, "Priya")
    (request,) = visitor_model.requests
    assert request.messages == [{"role": "user", "content": [{"type": "text", "text": demo_visitor_brief("office")}]}]


# The owner's reads ---------------------------------------------------------------------------------------------


async def test_its_chat_is_flagged_in_conversations_and_its_transcript_across_a_restart(
        db, fake, api_settings, clock, browser, copy, visitor_model, desk_model):
    desk_id, slug = copy.desk_ids[0], fake.desks[copy.desk_ids[0]].slug
    model = ByRoute(visitor_model, desk_model)

    async def read(app: FastAPI, session_id: str) -> tuple[dict, dict]:
        owner = owner_of(app, browser, copy)
        listed = await owner.get(f"/api/owner/desks/{desk_id}/conversations")
        transcript = await owner.get(f"/api/owner/conversations/{session_id}")
        assert (listed.status_code, transcript.status_code) == (200, 200), (listed.text, transcript.text)
        return {row["session_id"]: row for row in listed.json()}, transcript.json()

    async with running(fake, api_settings, clock, model) as app:
        # A real visitor's chat beside it.
        visitor, _, opened = await open_session(app, browser, slug)
        desk_model.add(say("Yes, we fix leaks."))
        sent = await visitor.post(f"/api/public/desks/{slug}/messages", json={"text": "Do you fix leaks?"})
        assert sent.status_code == 202, sent.text
        await app.state.runtime.runner.drain()
        person = opened["state"]["session_id"]

        visitor_model.add(step("", done=True))
        started = await start(owner_of(app, browser, copy), desk_id)
        assert started.status_code == 202, started.text
        await app.state.runtime.demo_visitors.drain()
        demo = started.json()["session_id"]

        listed, transcript = await read(app, demo)
        # Listed as soon as its chat opens, named by its persona's first name and flagged; the real visitor isn't.
        assert (listed[demo]["demo_visitor"], listed[demo]["display_name"]) == (True, "Riley")
        assert (listed[person]["demo_visitor"], listed[person]["display_name"]) == (False, None)
        assert transcript["demo_visitor"] is True and transcript["items"] == []     # the mark is never an item
        assert (await read(app, person))[1]["demo_visitor"] is False

    # Another process, with no memory of the run: its chat is still flagged.
    async with running(fake, api_settings, clock, model) as app:
        owner = owner_of(app, browser, copy)
        gone = await owner.get(f"/api/owner/desks/{desk_id}/demo_visitor")
        assert (gone.status_code, gone.json()) == (404, {"error": "not_found"})
        listed, transcript = await read(app, demo)
        assert (listed[demo]["demo_visitor"], listed[demo]["display_name"]) == (True, "Riley")
        assert listed[person]["demo_visitor"] is False
        assert transcript["demo_visitor"] is True


# The process ---------------------------------------------------------------------------------------------------


async def test_the_app_closes_its_demo_visitors_when_it_stops(db, fake, api_settings, clock, browser, copy,
                                                             visitor_model, desk_model):
    release = asyncio.Event()
    thinking = gated(step("never sent"), release)
    visitor_model.add(thinking)
    async with running(fake, api_settings, clock, ByRoute(visitor_model, desk_model)) as app:
        runtime = app.state.runtime
        started = await start(owner_of(app, browser, copy), copy.desk_ids[0])
        assert started.status_code == 202, started.text
        await asyncio.wait_for(thinking.entered.wait(), 5)
        visitors = runtime.demo_visitors
    # Stopping the app ended the run still going, with its stream closed, and the runtime no longer offers it.
    run = visitors.run(started.json()["run_id"], copy.copy_id)
    assert (run.state, run.ended, run.messages_sent) == ("failed", "failed", 0)
    assert runtime.demo_visitors is None
    assert runtime.stream_slots.open_counts() == ({}, {})
    release.set()
