"""The owner's Desk list names each Desk whose setup interview isn't finished (#233), so the owner app can lead the
owner back into it: `DeskSummary.setup` is the interview's ID and the step it is at until the interview goes live
(step `live`), and null after that, as it is for a Desk made outside setup. A Desk whose rules are confirmed but that
isn't live yet (step `preview`) is still unfinished, since going live is setup's last step. `GET /api/owner/desks` and
the copy's own answer (`me`) list the same, and a copy never sees another copy's interview.

The app runs on FakeKernel with a scripted model.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import event

from desk.api.main import create_app
from desk.api.kernel_client import KernelView
from tests.api.fakes import ScriptedModel
from tests.api.test_owner_desks import new_desk
from tests.api.test_setup_questions import Owner, begin, new_owner, start_body, started
from tests.api.test_setup_rules import drafted_rules, policy, ready
from tests.kernel_contract.fake_kernel import fake_kernel_app


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


async def setups(owner: Owner) -> dict[str, dict | None]:
    """Each of the copy's Desks' `setup`, by Desk ID, as the Desk list answers it; the copy's own answer (`me`) lists
    the same."""
    listed = await owner.browser.get("/api/owner/desks")
    assert listed.status_code == 200, listed.text
    found = {desk["desk_id"]: desk["setup"] for business in listed.json() for desk in business["desks"]}
    me = await owner.browser.get("/api/owner/me")
    assert me.status_code == 200, me.text
    assert {desk["desk_id"]: desk["setup"] for desk in me.json()["desks"]} == found
    return found


@asynccontextmanager
async def before_link(owner, model, fake, db, monkeypatch):
    """Hold the kernel's successful create response before setup can link the row."""
    entered, release = asyncio.Event(), asyncio.Event()
    call = KernelView.call
    made = None

    async def held(view, route, body=None, **options):
        nonlocal made
        if route == "POST /desks":
            fake.now += timedelta(seconds=1)
        result = await call(view, route, body, **options)
        if route == "POST /desks":
            made = result.desk_id
            entered.set()
            await release.wait()
        return result

    monkeypatch.setattr(KernelView, "call", held)
    model.add(started())
    body = start_body()
    first = asyncio.create_task(owner.browser.post("/api/owner/setup", json=body))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        ((interview_id, desk_id),) = db.execute(
            "SELECT interview_id, desk_id FROM app.setup_interviews WHERE copy_id = %s", (owner.copy_id,)).fetchall()
        assert desk_id is None
        yield first, made, interview_id
    finally:
        release.set()
        result = await asyncio.wait_for(first, 10)
        assert result.status_code == 201, result.text


@pytest.mark.parametrize("clock_offset", [-600, -2, 2, 600])
async def test_a_desk_list_read_mid_start_shows_the_desk_in_setup(app, browser, kernel_http, model, fake, db,
                                                                 monkeypatch, clock_offset):
    fake.now = db.execute("SELECT now()").fetchone()[0] + timedelta(seconds=clock_offset)
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    async with before_link(owner, model, fake, db, monkeypatch) as (_, desk_id, interview_id):
        assert await setups(owner) == {**seeded, desk_id: {"interview_id": interview_id, "step": "questions"}}


async def test_a_start_that_fails_after_its_desk_is_made_deletes_it(app, browser, kernel_http, model, fake, db):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    body = start_body()
    failed_writes = []

    def fail_start_save(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("UPDATE app.setup_interviews SET") and "transcript=" in statement:
            failed_writes.append(statement)
            raise RuntimeError("start save failed")

    engine = app.state.runtime.engine.sync_engine
    event.listen(engine, "before_cursor_execute", fail_start_save)
    try:
        with pytest.raises(RuntimeError, match="start save failed"):
            await owner.browser.post("/api/owner/setup", json=body)
    finally:
        event.remove(engine, "before_cursor_execute", fail_start_save)
    assert len(failed_writes) == 1
    ((interview_id, linked, failed),) = db.execute(
        "SELECT interview_id, desk_id, start_error IS NOT NULL FROM app.setup_interviews"
        " WHERE copy_id = %s", (owner.copy_id,)).fetchall()
    assert linked is not None and failed
    (deleted,) = fake.called("DELETE /desks/{id}")
    assert deleted.path == f"/desks/{linked}" and deleted.headers["x-owner-session"] == owner.token
    assert fake.desks[linked].deleted_at is not None
    assert await setups(owner) == seeded
    repeat = await owner.browser.post("/api/owner/setup", json=body)
    assert (repeat.status_code, repeat.json()) == (409, {"error": "key_spent"})
    assert (await owner.browser.get(f"/api/owner/setup/{interview_id}")).status_code == 404


@pytest.mark.parametrize("delete_failure, failure_type", [("500", "KernelUnavailable"), ("422", "KernelFailed")])
async def test_a_failed_delete_keeps_the_desk_in_setup(app, browser, kernel_http, model, fake, db, caplog,
                                                     delete_failure, failure_type):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    body = start_body()
    fake.fail("DELETE /desks/{id}", delete_failure, times=1)
    caplog.set_level(logging.WARNING, logger="desk.api.setup")

    def fail_start_save(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("UPDATE app.setup_interviews SET") and "transcript=" in statement:
            raise RuntimeError("start save failed")

    engine = app.state.runtime.engine.sync_engine
    event.listen(engine, "before_cursor_execute", fail_start_save)
    try:
        with pytest.raises(RuntimeError, match="start save failed"):
            await owner.browser.post("/api/owner/setup", json=body)
    finally:
        event.remove(engine, "before_cursor_execute", fail_start_save)
    ((interview_id, desk_id, failed),) = db.execute(
        "SELECT interview_id, desk_id, start_error IS NOT NULL FROM app.setup_interviews"
        " WHERE copy_id = %s", (owner.copy_id,)).fetchall()
    assert desk_id is not None and failed
    (deleted,) = fake.called("DELETE /desks/{id}")
    assert deleted.path == f"/desks/{desk_id}"
    assert fake.desks[desk_id].deleted_at is None and not fake.desks[desk_id].answering
    assert await setups(owner) == {**seeded, desk_id: {"interview_id": interview_id, "step": "questions"}}
    assert f"a failed setup start's Desk couldn't be deleted ({failure_type})" in caplog.messages
    repeat = await owner.browser.post("/api/owner/setup", json=body)
    assert (repeat.status_code, repeat.json()) == (409, {"error": "key_spent"})
    assert len(fake.called("DELETE /desks/{id}")) == 1


async def test_a_refused_start_claims_no_later_desk(app, browser, kernel_http, model, fake, db):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    fake.fail("POST /desks", "422", times=1)
    refused = await owner.browser.post("/api/owner/setup", json=start_body())
    assert (refused.status_code, refused.json()) == (422, {"error": "kernel", "code": "invalid"})
    ((desk_id, failure),) = db.execute(
        "SELECT desk_id, start_error FROM app.setup_interviews WHERE copy_id = %s", (owner.copy_id,)).fetchall()
    assert desk_id is None and failure["kernel"] == "failed"
    fake.now += timedelta(seconds=1)
    made = await owner.browser.post("/api/owner/desks", json=new_desk())
    assert made.status_code == 201, made.text
    assert await setups(owner) == {**seeded, made.json()["desk_id"]: None}


@pytest.mark.parametrize("outcome", ["timeout", "500", "unrecorded"])
async def test_an_uncertain_start_claims_only_the_earliest_later_desk(app, browser, kernel_http, model, fake, db,
                                                                   outcome):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    fake.fail("POST /desks", "timeout" if outcome == "unrecorded" else outcome, times=1)
    failed = await owner.browser.post("/api/owner/setup", json=start_body())
    assert failed.status_code == 503, failed.text
    ((interview_id, failure),) = db.execute(
        "SELECT interview_id, start_error FROM app.setup_interviews WHERE copy_id = %s", (owner.copy_id,)).fetchall()
    assert failure["kernel"] == "unavailable"
    if outcome == "unrecorded":
        db.execute("UPDATE app.setup_interviews SET start_error = NULL WHERE interview_id = %s", (interview_id,))
    fake.now += timedelta(seconds=1)
    first = await owner.browser.post("/api/owner/desks", json=new_desk("First"))
    assert first.status_code == 201, first.text
    fake.now += timedelta(seconds=1)
    second = await owner.browser.post("/api/owner/desks", json=new_desk("Second"))
    assert second.status_code == 201, second.text
    assert await setups(owner) == {
        **seeded, first.json()["desk_id"]: {"interview_id": interview_id, "step": "questions"},
        second.json()["desk_id"]: None}


async def test_two_pending_starts_claim_distinct_desks_in_created_order(app, browser, kernel_http, model, fake, db):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    interviews = []
    for _ in range(2):
        body = start_body()
        model.add(started())
        fake.fail("POST /desks", "timeout", times=1)
        failed = await owner.browser.post("/api/owner/setup", json=body)
        assert failed.status_code == 503, failed.text
        interviews.append(db.execute(
            "SELECT interview_id FROM app.setup_interviews WHERE copy_id = %s AND idempotency_key = %s",
            (owner.copy_id, body["idempotency_key"])).fetchone()[0])
    expected = dict(seeded)
    for number, interview_id in enumerate(interviews):
        fake.now += timedelta(seconds=1)
        made = await owner.browser.post("/api/owner/desks", json=new_desk(f"Line {number}"))
        assert made.status_code == 201, made.text
        expected[made.json()["desk_id"]] = {"interview_id": interview_id, "step": "questions"}
    fake.now += timedelta(seconds=1)
    extra = await owner.browser.post("/api/owner/desks", json=new_desk("Outside setup"))
    assert extra.status_code == 201, extra.text
    expected[extra.json()["desk_id"]] = None
    assert await setups(owner) == expected


async def test_deleting_an_uncertain_starts_claimed_desk_does_not_claim_the_next_desk(
        app, browser, kernel_http, model, fake, db):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    fake.fail("POST /desks", "timeout", times=1)
    failed = await owner.browser.post("/api/owner/setup", json=start_body())
    assert failed.status_code == 503, failed.text
    ((interview_id,),) = db.execute(
        "SELECT interview_id FROM app.setup_interviews WHERE copy_id = %s", (owner.copy_id,)).fetchall()

    for number, name in enumerate(("First", "Second", "Third")):
        fake.now += timedelta(seconds=1)
        made = await owner.browser.post("/api/owner/desks", json=new_desk(name))
        assert made.status_code == 201, made.text
        desk_id = made.json()["desk_id"]
        expected = {"interview_id": interview_id, "step": "questions"} if number == 0 else None
        assert await setups(owner) == {**seeded, desk_id: expected}
        deleted = await owner.browser.delete(f"/api/owner/desks/{desk_id}")
        assert deleted.status_code == 204, deleted.text
        assert await setups(owner) == seeded


async def test_a_deleted_desks_linked_interview_keeps_it_out_of_pending_claims(
        app, browser, kernel_http, model, fake, db):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    fake.fail("POST /desks", "timeout", times=1)
    failed = await owner.browser.post("/api/owner/setup", json=start_body())
    assert failed.status_code == 503, failed.text
    ((interview_id,),) = db.execute(
        "SELECT interview_id FROM app.setup_interviews WHERE copy_id = %s", (owner.copy_id,)).fetchall()

    fake.now += timedelta(seconds=1)
    linked = await begin(owner, model)
    deleted = await owner.browser.delete(f"/api/owner/desks/{linked['desk_id']}")
    assert deleted.status_code == 204, deleted.text
    fake.now += timedelta(seconds=1)
    made = await owner.browser.post("/api/owner/desks", json=new_desk("Outside setup"))
    assert made.status_code == 201, made.text
    assert await setups(owner) == {
        **seeded, made.json()["desk_id"]: {"interview_id": interview_id, "step": "questions"}}


async def test_a_desk_without_an_interview_stays_live_during_another_start(app, browser, kernel_http, model, fake, db,
                                                                         monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    fake.now += timedelta(seconds=1)
    extra = await owner.browser.post("/api/owner/desks", json=new_desk())
    assert extra.status_code == 201, extra.text
    seeded = await setups(owner)
    assert list(seeded.values()) == [None, None]
    async with before_link(owner, model, fake, db, monkeypatch) as (_, desk_id, interview_id):
        ((requested_at,),) = db.execute(
            "SELECT desk_requested_at FROM app.setup_interviews WHERE interview_id = %s", (interview_id,)).fetchall()
        assert requested_at == max(fake.desks[seed].created_at for seed in seeded)
        assert await setups(owner) == {**seeded, desk_id: {"interview_id": interview_id, "step": "questions"}}


async def test_an_early_link_is_not_a_readable_or_repeatable_interview(app, browser, kernel_http, model, db,
                                                                     monkeypatch):
    from desk.api import setup as desk_setup

    owner = await new_owner(app, browser, kernel_http)
    body = start_body()
    model.add(started())
    entered, release = asyncio.Event(), asyncio.Event()
    answering_off = desk_setup._answering_off

    async def held(owner, desk_id):
        entered.set()
        await release.wait()
        await answering_off(owner, desk_id)

    monkeypatch.setattr(desk_setup, "_answering_off", held)
    first = asyncio.create_task(owner.browser.post("/api/owner/setup", json=body))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        ((interview_id, desk_id, transcript),) = db.execute(
            "SELECT interview_id, desk_id, transcript FROM app.setup_interviews WHERE copy_id = %s",
            (owner.copy_id,)).fetchall()
        assert desk_id is not None and transcript == []
        assert (await setups(owner))[desk_id] == {"interview_id": interview_id, "step": "questions"}
        assert (await owner.browser.get(f"/api/owner/setup/{interview_id}")).status_code == 404
        repeat = await asyncio.wait_for(owner.browser.post("/api/owner/setup", json=body), 3)
        assert (repeat.status_code, repeat.json()) == (409, {"error": "in_progress", "retry_after": 2})
        db.execute("UPDATE app.setup_interviews SET created_at = now() - make_interval(secs => %s)"
                   " WHERE interview_id = %s", (desk_setup.START_ABANDONED_S + 5, interview_id))
        repeat = await owner.browser.post("/api/owner/setup", json=body)
        assert (repeat.status_code, repeat.json()) == (409, {"error": "key_spent"})
    finally:
        release.set()
        result = await asyncio.wait_for(first, 10)
        assert result.status_code == 201, result.text
    assert (await owner.browser.get(f"/api/owner/setup/{interview_id}")).json() == result.json()
    assert (await owner.browser.post("/api/owner/setup", json=body)).json() == result.json()


@pytest.mark.parametrize("lose_settlement", [False, True])
@pytest.mark.parametrize("clock_offset", [-600, -2, 2, 600])
@pytest.mark.parametrize("delete_fails", [False, True])
async def test_a_failed_link_deletes_the_desk_or_keeps_it_in_setup(app, browser, kernel_http, model, fake, db,
                                                                 lose_settlement, clock_offset, delete_fails):
    from desk.api import setup as desk_setup

    fake.now = db.execute("SELECT now()").fetchone()[0] + timedelta(seconds=clock_offset)
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    model.add(started())
    body = start_body()
    call = KernelView.call
    if delete_fails:
        fake.fail("DELETE /desks/{id}", "500", times=1)

    async def timed(view, route, body=None, **options):
        if route == "POST /desks":
            fake.now += timedelta(seconds=1)
        return await call(view, route, body, **options)

    def fail_link(conn, cursor, statement, parameters, context, executemany):
        if (statement.startswith("UPDATE app.setup_interviews SET") and "desk_id=" in statement
                and (lose_settlement or "start_error=" not in statement)):
            raise RuntimeError("link write failed")

    engine = app.state.runtime.engine.sync_engine
    event.listen(engine, "before_cursor_execute", fail_link)
    # Patch only the clock of POST /desks, leaving the real API/kernel path intact.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(KernelView, "call", timed)
        try:
            with pytest.raises(RuntimeError, match="link write failed"):
                await owner.browser.post("/api/owner/setup", json=body)
        finally:
            event.remove(engine, "before_cursor_execute", fail_link)
    listed = await setups(owner)
    (deleted,) = fake.called("DELETE /desks/{id}")
    desk_id = deleted.path.removeprefix("/desks/")
    ((interview_id, linked, failed),) = db.execute(
        "SELECT interview_id, desk_id, start_error IS NOT NULL FROM app.setup_interviews"
        " WHERE copy_id = %s", (owner.copy_id,)).fetchall()
    assert not fake.desks[desk_id].answering
    assert (fake.desks[desk_id].deleted_at is None) == delete_fails
    assert (linked, failed) == ((None, False) if lose_settlement else (desk_id, True))
    assert listed == ({**seeded, desk_id: {"interview_id": interview_id, "step": "questions"}}
                      if delete_fails else seeded)
    assert all(listed[seed] is None for seed in seeded)
    assert (await owner.browser.get(f"/api/owner/setup/{interview_id}")).status_code == 404
    repeat = await owner.browser.post("/api/owner/setup", json=body)
    assert repeat.status_code == 409
    assert repeat.json()["error"] == ("in_progress" if lose_settlement else "key_spent")
    db.execute("UPDATE app.setup_interviews SET created_at = now() - make_interval(secs => %s)"
               " WHERE interview_id = %s", (desk_setup.START_ABANDONED_S + 5, interview_id))
    repeat = await owner.browser.post("/api/owner/setup", json=body)
    assert (repeat.status_code, repeat.json()) == (409, {"error": "key_spent"})
    assert await setups(owner) == listed  # a surviving Desk stays guarded even when both link writes were lost


async def test_an_unfinished_setups_desk_lists_its_interview(app, browser, kernel_http, model):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    assert list(seeded.values()) == [None]                 # the seeded Desk was made outside setup

    state = await begin(owner, model)

    # The Desk setup made lists its interview and the step it is at, beside the seeded Desk's null.
    assert await setups(owner) == {**seeded, state["desk_id"]: {"interview_id": state["interview_id"],
                                                                "step": "questions"}}


async def test_a_setup_is_listed_until_its_desk_goes_live(app, browser, kernel_http, model):
    owner, state = await ready(app, browser, kernel_http, model)
    desk_id, interview = state["desk_id"], {"interview_id": state["interview_id"]}
    assert (await setups(owner))[desk_id] == {**interview, "step": "tools"}
    await drafted_rules(owner, model, state)
    assert (await setups(owner))[desk_id] == {**interview, "step": "rules"}

    # Confirmed, with Answering still off, the setup isn't finished: going live is its last step.
    confirmed = await owner.browser.post(policy(state, "confirm"))
    assert confirmed.status_code == 200, confirmed.text
    assert (await setups(owner))[desk_id] == {**interview, "step": "preview"}

    # Live, the setup is finished: the Desk lists null, as the seeded Desk does.
    went_live = await owner.browser.post(policy(state, "go_live"))
    assert went_live.status_code == 200, went_live.text
    listed = await setups(owner)
    assert desk_id in listed and list(listed.values()) == [None, None]


async def test_answering_turned_on_before_setup_finishes_keeps_the_setup_listed(app, browser, kernel_http, model):
    # The Answering switch is separate from setup: turned on at the first question, the Desk answers the public, and
    # its setup, which never went live, is still listed at the step it is at.
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    switched = await owner.browser.put(f"/api/owner/desks/{state['desk_id']}/answering", json={"on": True})
    assert switched.status_code == 200, switched.text

    listed = await owner.browser.get("/api/owner/desks")
    (desk,) = [desk for business in listed.json() for desk in business["desks"] if desk["desk_id"] == state["desk_id"]]
    assert (desk["answering"], desk["setup"]) == (True, {"interview_id": state["interview_id"], "step": "questions"})
    assert (await setups(owner))[state["desk_id"]] == desk["setup"]


async def test_a_desk_made_outside_setup_lists_no_setup(app, browser, kernel_http):
    owner = await new_owner(app, browser, kernel_http)
    made = await owner.browser.post("/api/owner/desks", json=new_desk())
    assert made.status_code == 201, made.text

    listed = await setups(owner)
    assert made.json()["desk_id"] in listed and list(listed.values()) == [None, None]


async def test_another_copys_interview_never_shows(app, browser, kernel_http, model, db):
    owner, other = await new_owner(app, browser, kernel_http), await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    elsewhere = await begin(other, model)

    # The other copy's setup is listed in that copy alone.
    assert (await setups(other))[elsewhere["desk_id"]] == {"interview_id": elsewhere["interview_id"],
                                                           "step": "questions"}
    assert await setups(owner) == seeded
    assert elsewhere["interview_id"] not in (await owner.browser.get("/api/owner/desks")).text

    # An interview row of the other copy that names this copy's Desk is still the other copy's: it never shows here.
    (desk_id,) = seeded
    db.execute("INSERT INTO app.setup_interviews (interview_id, copy_id, desk_id, step)"
               " VALUES ('setup-elsewhere', %s, %s, 'questions')", (other.copy_id, desk_id))
    assert await setups(owner) == seeded
