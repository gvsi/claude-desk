"""Consent stores the owner's answer before its reads run in the background."""

import asyncio

import pytest

from desk.api import setup
from desk.api.deps import ApiProblem
from tests.api.test_setup_questions import (  # noqa: F401 — fixtures shared with setup's question tests
    WEBSITE, app, begin, held_limits, model, new_owner,
)


async def test_consent_answers_200_with_the_first_question_when_the_reads_finish_in_time(
        app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    assert state["busy"] is False
    reply = await owner.browser.post(f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": True})
    assert reply.status_code == 200, reply.text
    landed = reply.json()
    assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[0]
    assert [message["text"] for message in landed["messages"][2:4]] == [
        "Searched your Claude memory", "Read rivera-plumbing.example"]
    assert [message["role"] for message in landed["messages"]] == [
        "claude", "owner", "tool_label", "tool_label", "claude"]


async def test_a_failed_run_rolls_consent_back(app, browser, fake, kernel_http, model, monkeypatch, caplog):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    path = f"/api/owner/setup/{state['interview_id']}"
    release, entered = asyncio.Event(), asyncio.Event()
    after = setup._after_consent

    async def failing(owner, engine, model, interview, entries):
        assert [entry.read for entry in entries] == ["memory", "website"]
        assert interview.transcript[-2:] == entries
        entered.set()
        await release.wait()
        raise RuntimeError("private-owner-data")

    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    monkeypatch.setattr(setup, "_after_consent", failing)
    reply = await owner.browser.post(path + "/consent", json={"allow": True})
    assert reply.status_code == 202
    await asyncio.wait_for(entered.wait(), 5)
    task = app.state.runtime.consent_runs._tasks[state["interview_id"]]
    release.set()
    with pytest.raises(RuntimeError):
        await task
    rolled_back = (await owner.browser.get(path)).json()
    assert rolled_back == state
    assert "private-owner-data" not in caplog.text
    monkeypatch.setattr(setup, "_after_consent", after)
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 25)
    again = await owner.browser.post(path + "/consent", json={"allow": True})
    assert again.status_code == 200 and again.json()["busy"] is False


async def test_a_repeat_while_busy_answers_202_without_a_second_run(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    asked, _ = held_limits(app, monkeypatch)
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    release = fake.gate("POST /execute")
    path = f"/api/owner/setup/{state['interview_id']}/consent"
    try:
        first = await owner.browser.post(path, json={"allow": True})
        assert first.status_code == 202
        for allow in (True, False):
            repeat = await owner.browser.post(path, json={"allow": allow})
            assert (repeat.status_code, repeat.json()) == (202, first.json())
        assert asked.count("setup_turn") == 1
    finally:
        release.set()
        await app.state.runtime.consent_runs.wait(state["interview_id"])
    assert len(fake.called("POST /execute")) == 1


async def test_a_slow_consent_answers_202_busy_and_lands_later(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0.01, raising=False)
    release = fake.gate("POST /execute")
    path = f"/api/owner/setup/{state['interview_id']}"
    try:
        reply = await asyncio.wait_for(owner.browser.post(path + "/consent", json={"allow": True}), 0.5)
        assert reply.status_code == 202, reply.text
        busy = reply.json()
        assert busy["busy"] is True and busy["consent"] is True and busy["question"] is None
        assert busy["messages"][-1] == {"role": "owner", "text": setup.CONSENT_ANSWERS[True]}
        assert (await owner.browser.get(path)).json() == busy
    finally:
        release.set()
    await app.state.runtime.consent_runs.wait(state["interview_id"])
    landed = (await owner.browser.get(path)).json()
    assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[0]
    assert [message["role"] for message in landed["messages"]] == [
        "claude", "owner", "tool_label", "tool_label", "claude"]


async def test_a_failure_within_the_wait_answers_the_error_as_today(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    path = f"/api/owner/setup/{state['interview_id']}"

    async def failing(owner, engine, model, interview, entries):
        raise ApiProblem(503, "model_unavailable")

    monkeypatch.setattr(setup, "_after_consent", failing)
    reply = await owner.browser.post(path + "/consent", json={"allow": True})
    assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
    assert (await owner.browser.get(path)).json() == state


def abandoned(db, interview_id, age):
    from psycopg.types.json import Jsonb

    (transcript,) = db.execute("SELECT transcript FROM app.setup_interviews WHERE interview_id = %s",
                               (interview_id,)).fetchone()
    transcript.append({"role": "owner", "text": setup.CONSENT_ANSWERS[True]})
    db.execute("UPDATE app.setup_interviews SET consent = true, transcript = %s,"
               " updated_at = now() - make_interval(secs => %s) WHERE interview_id = %s",
               (Jsonb(transcript), age, interview_id))


@pytest.mark.parametrize("on", ["get", "consent"])
async def test_an_abandoned_run_is_rolled_back_on_get_and_on_consent(
        app, browser, fake, kernel_http, model, db, on):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    abandoned(db, interview_id, setup.CONSENT_ABANDONED_S - 10)
    # A run in another process gets its full deadline before this process may recover it.
    young = (await owner.browser.get(path)).json()
    assert young["busy"] is True
    repeat = await owner.browser.post(path + "/consent", json={"allow": False})
    assert (repeat.status_code, repeat.json()) == (202, young)
    assert fake.called("POST /execute") == []
    db.execute("UPDATE app.setup_interviews SET updated_at = now() - make_interval(secs => %s)"
               " WHERE interview_id = %s", (setup.CONSENT_ABANDONED_S + 10, interview_id))
    if on == "get":
        assert (await owner.browser.get(path)).json() == state
    else:
        fresh = await owner.browser.post(path + "/consent", json={"allow": False})
        assert fresh.status_code == 200, fresh.text
        assert fresh.json()["busy"] is False and fresh.json()["consent"] is False
        assert fresh.json()["question"] == setup.QUESTION_KEYS[0]


async def test_answer_is_409_while_busy(app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    path = f"/api/owner/setup/{state['interview_id']}"
    release = fake.gate("POST /execute")
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    try:
        assert (await owner.browser.post(path + "/consent", json={"allow": True})).status_code == 202
        calls = len(model.requests)
        reply = await owner.browser.post(path + "/answer", json={"question": "what_you_do", "text": "Plumbing"})
        assert (reply.status_code, reply.json()) == (409, {"error": "conflict"})
        assert len(model.requests) == calls
        assert (await owner.browser.get(path)).json()["busy"] is True
    finally:
        release.set()
        await app.state.runtime.consent_runs.wait(state["interview_id"])


async def test_declined_consent_reads_nothing_and_still_asks(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    after, seen = setup._after_consent, []

    async def asking(owner, engine, model, interview, entries):
        assert interview.busy and interview.consent is False
        assert interview.transcript[-1].text == setup.CONSENT_ANSWERS[False]
        assert entries == [] and interview.interview_id in setup._RUNNING
        seen.append(interview.interview_id)
        await after(owner, engine, model, interview, entries)

    monkeypatch.setattr(setup, "_after_consent", asking)
    reply = await owner.browser.post(f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": False})
    assert reply.status_code == 200, reply.text
    assert reply.json()["busy"] is False and reply.json()["question"] == setup.QUESTION_KEYS[0]
    assert seen == [state["interview_id"]]
    assert fake.called("POST /decide") == [] and fake.called("POST /execute") == []


@pytest.mark.parametrize("end", ["deadline", "shutdown"])
async def test_a_run_deadline_or_shutdown_reopens_consent(
        app, browser, fake, kernel_http, model, monkeypatch, end, caplog):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    path = f"/api/owner/setup/{state['interview_id']}"
    entered, release = asyncio.Event(), asyncio.Event()

    async def waiting(owner, engine, model, interview, entries):
        entered.set()
        await release.wait()

    monkeypatch.setattr(setup, "_after_consent", waiting)
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    monkeypatch.setattr(setup, "CONSENT_RUN_TIMEOUT_S", 0.2 if end == "deadline" else 100)
    assert (await owner.browser.post(path + "/consent", json={"allow": True})).status_code == 202
    await asyncio.wait_for(entered.wait(), 5)
    task = app.state.runtime.consent_runs._tasks[state["interview_id"]]
    if end == "shutdown":
        await app.state.runtime.consent_runs.close()
        assert task.cancelled()
        assert "CancelledError" in caplog.text
    else:
        with pytest.raises(ApiProblem) as failed:
            await asyncio.wait_for(asyncio.shield(task), 5)
        assert (failed.value.status, failed.value.error) == (503, "model_unavailable")
        assert "TimeoutError" in caplog.text
    assert (await owner.browser.get(path)).json() == state
    assert state["interview_id"] not in setup._RUNNING
    assert not app.state.runtime.consent_runs.holds(state["interview_id"])


async def test_a_wait_that_expires_returns_the_busy_snapshot_even_if_the_run_lands_just_after(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    runs = app.state.runtime.consent_runs
    read = setup._read

    async def after_the_run(engine, owner, interview_id):
        # If the request re-reads after its wait expired, let the run finish before that read.
        if runs.holds(interview_id):
            await runs.wait(interview_id)
        return await read(engine, owner, interview_id)

    monkeypatch.setattr(setup, "_read", after_the_run)
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    reply = await owner.browser.post(f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": False})
    assert reply.status_code == 202 and reply.json()["busy"] is True
    await runs.wait(state["interview_id"])


async def test_a_held_run_is_not_recovered_even_when_its_row_is_old(
        app, browser, fake, kernel_http, model, monkeypatch, db):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    path = f"/api/owner/setup/{state['interview_id']}"
    release = fake.gate("POST /execute")
    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    try:
        reply = await owner.browser.post(path + "/consent", json={"allow": True})
        assert reply.status_code == 202
        db.execute("UPDATE app.setup_interviews SET updated_at = now() - make_interval(secs => %s)"
                   " WHERE interview_id = %s", (setup.CONSENT_ABANDONED_S + 10, state["interview_id"]))
        assert (await owner.browser.get(path)).json() == reply.json()
        repeat = await owner.browser.post(path + "/consent", json={"allow": False})
        assert (repeat.status_code, repeat.json()) == (202, reply.json())
    finally:
        release.set()
        await app.state.runtime.consent_runs.wait(state["interview_id"])


@pytest.mark.parametrize("fail", [False, True])
async def test_a_run_neither_lands_nor_rolls_back_over_a_changed_interview(
        app, browser, fake, kernel_http, model, monkeypatch, db, fail):
    from psycopg.types.json import Jsonb

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    path = f"/api/owner/setup/{state['interview_id']}"
    entered, release = asyncio.Event(), asyncio.Event()
    after = setup._after_consent

    async def changed(owner, engine, model, interview, entries):
        entered.set()
        await release.wait()
        if fail:
            raise ApiProblem(503, "model_unavailable")
        await after(owner, engine, model, interview, entries)

    monkeypatch.setattr(setup, "CONSENT_WAIT_S", 0)
    monkeypatch.setattr(setup, "_after_consent", changed)
    assert (await owner.browser.post(path + "/consent", json={"allow": True})).status_code == 202
    await asyncio.wait_for(entered.wait(), 5)
    task = app.state.runtime.consent_runs._tasks[state["interview_id"]]
    (transcript,) = db.execute("SELECT transcript FROM app.setup_interviews WHERE interview_id = %s",
                               (state["interview_id"],)).fetchone()
    transcript.append({"role": "claude", "text": "Saved by another process", "question": "what_you_do"})
    db.execute("UPDATE app.setup_interviews SET transcript = %s, updated_at = now() WHERE interview_id = %s",
               (Jsonb(transcript), state["interview_id"]))
    release.set()
    with pytest.raises(ApiProblem) as refused:
        await task
    assert refused.value.status == (503 if fail else 409)
    current = (await owner.browser.get(path)).json()
    assert current["messages"][-1]["text"] == "Saved by another process"
    assert current["consent"] is True and current["busy"] is False
    assert all(message["role"] != "tool_label" for message in current["messages"])


async def test_a_cancelled_request_leaves_the_run_on_its_own_connection(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    path = f"/api/owner/setup/{state['interview_id']}"
    entered, release = asyncio.Event(), asyncio.Event()
    after = setup._after_consent

    async def reading(owner, engine, model, interview, entries):
        entered.set()
        await release.wait()
        assert owner.ro.own_transactions
        assert (await owner.ro.one("desks", desk_id=interview.desk_id))["slug"] == state["slug"]
        assert not owner.ro.conn.in_transaction()
        await after(owner, engine, model, interview, entries)

    monkeypatch.setattr(setup, "_after_consent", reading)
    request = asyncio.create_task(owner.browser.post(path + "/consent", json={"allow": True}))
    await asyncio.wait_for(entered.wait(), 5)
    try:
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        busy = (await owner.browser.get(path)).json()
        assert busy["busy"] is True and busy["messages"][-1]["role"] == "owner"
        assert all(message["role"] != "tool_label" for message in busy["messages"])
    finally:
        release.set()
        await app.state.runtime.consent_runs.wait(state["interview_id"])
    landed = (await owner.browser.get(path)).json()
    assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[0]


async def test_two_fresh_consents_store_only_one_owner_answer(
        app, browser, fake, kernel_http, model, monkeypatch):
    from tests.api.test_setup_questions import until

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    asked, (admit,) = held_limits(app, monkeypatch, hold=1)
    path = f"/api/owner/setup/{state['interview_id']}/consent"
    first = asyncio.create_task(owner.browser.post(path, json={"allow": True}))
    try:
        await until(lambda: asked.count("setup_turn") == 1)
        second = await owner.browser.post(path, json={"allow": False})
        assert (second.status_code, second.json()) == (409, {"error": "conflict"})
    finally:
        admit.set()
        reply = await first
    assert reply.status_code == 200
    assert asked.count("setup_turn") == 1 and len(fake.called("POST /execute")) == 1
    assert [message for message in reply.json()["messages"] if message["role"] == "owner"] == [
        {"role": "owner", "text": setup.CONSENT_ANSWERS[True]}]


async def test_a_stalled_rollback_does_not_outlive_the_abandonment_window(
        app, browser, fake, kernel_http, model, monkeypatch, caplog):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    release = asyncio.Event()

    async def failing(owner, engine, model, interview, entries):
        raise ApiProblem(503, "model_unavailable")

    async def stalled(*args, **kwargs):
        await release.wait()

    monkeypatch.setattr(setup, "_after_consent", failing)
    monkeypatch.setattr(setup, "_rollback_consent", stalled)
    monkeypatch.setattr(setup, "CONSENT_ROLLBACK_TIMEOUT_S", 0.01, raising=False)
    try:
        reply = await asyncio.wait_for(owner.browser.post(
            f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": False}), 0.5)
        assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
        assert "couldn't be reopened (TimeoutError)" in caplog.text
        assert not app.state.runtime.consent_runs.holds(state["interview_id"])
    finally:
        release.set()
        await asyncio.gather(app.state.runtime.consent_runs.wait(state["interview_id"]), return_exceptions=True)
