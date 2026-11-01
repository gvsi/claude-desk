"""Setup's shared turn runner stores pending entries before consent, answers or card work runs."""

import asyncio
import contextlib

import pytest

from desk.api import setup
from desk.api.deps import ApiProblem
from tests.api.fakes import unavailable
from tests.api.test_setup_questions import (  # noqa: F401 — fixtures shared with setup's question tests
    WEBSITE, app, begin as begin_questions, held_limits, model, new_owner,
)


async def begin(owner, model, **fields):
    state = await begin_questions(owner, model, **fields)
    # These lifecycle tests use the consultant's fallback to the first question.
    model.add(unavailable())
    return state


async def test_the_turn_deadline_is_available_during_the_turn_but_never_stored(
        app, browser, fake, kernel_http, model, engine, monkeypatch):
    from tests.api.test_setup_questions import consent

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    after, commit = setup._after_consent, setup._commit
    deadlines = []
    monkeypatch.setattr(setup, "TURN_RUN_TIMEOUT_S", 1)
    before = asyncio.get_running_loop().time()

    async def saving(engine, ctx, interview, seen):
        assert before + 1 <= interview.turn_deadline <= asyncio.get_running_loop().time() + 1
        deadlines.append(interview.turn_deadline)
        assert "turn_deadline" not in setup._stored(interview)
        await commit(engine, ctx, interview, seen)

    async def understanding(ctx, engine, model, interview, entries):
        assert interview.turn_deadline == deadlines[0]
        loaded = await setup._read(engine, ctx, interview_id)
        assert loaded.turn_deadline is None
        await after(ctx, engine, model, interview, entries)

    monkeypatch.setattr(setup, "_commit", saving)
    monkeypatch.setattr(setup, "_after_consent", understanding)
    state = await consent(owner, interview_id, False, model)
    assert not state["busy"] and len(deadlines) == 2 and deadlines[0] == deadlines[1]
    async with engine.connect() as conn:
        loaded = await setup._load(conn, owner.copy_id, interview_id)
    assert loaded.turn_deadline is None and "turn_deadline" not in setup._stored(loaded)


async def test_a_slow_answer_answers_202_busy_and_lands_later(
        app, browser, fake, kernel_http, model, monkeypatch, db):
    from tests.api.fakes import gated
    from tests.api.test_setup_questions import consent, turn

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    waiting = await consent(owner, interview_id, False, model)
    before = db.execute("SELECT answers FROM app.setup_interviews WHERE interview_id = %s", (interview_id,)).fetchone()
    release = asyncio.Event()
    model.add(gated(turn(summary="Water heater repairs."), release))
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0.01, raising=False)
    try:
        reply = await asyncio.wait_for(owner.browser.post(path + "/answer", json={
            "question": waiting["question"], "text": "We repair water heaters."}), 0.5)
        assert reply.status_code == 202, reply.text
        busy = reply.json()
        assert busy["busy"] is True and busy["question"] is None
        assert busy["messages"][-1] == {"role": "owner", "text": "We repair water heaters.", "choices": [], "card": None}
        current = db.execute("SELECT answers FROM app.setup_interviews WHERE interview_id = %s",
                             (interview_id,)).fetchone()
        assert current == before
        assert (await owner.browser.get(path)).json() == busy
    finally:
        release.set()
    await app.state.runtime.turn_runs.wait(interview_id)
    landed = (await owner.browser.get(path)).json()
    assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[1]
    (answers,) = db.execute("SELECT answers FROM app.setup_interviews WHERE interview_id = %s", (interview_id,)).fetchone()
    assert answers["summary"] == "Water heater repairs."


@pytest.mark.parametrize("slow", [False, True])
async def test_a_failed_answer_turn_rolls_back_to_the_question_waiting(
        app, browser, fake, kernel_http, model, monkeypatch, db, slow):
    from tests.api.test_setup_questions import answer, consent, turn

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    waiting = await consent(owner, interview_id, False, model)
    before = db.execute("SELECT answers, transcript, step FROM app.setup_interviews WHERE interview_id = %s",
                        (interview_id,)).fetchone()
    release = asyncio.Event()
    rename = setup._rename

    async def failing(*args):
        await release.wait()
        raise ApiProblem(503, "model_unavailable")

    monkeypatch.setattr(setup, "_rename", failing)
    if slow:
        monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    else:
        release.set()
    reply = await answer(owner, model, interview_id, "We repair water heaters.",
                         turn(summary="Water heater repairs."))
    if slow:
        assert reply.status_code == 202
        task = app.state.runtime.turn_runs._tasks[interview_id]
        release.set()
        with pytest.raises(ApiProblem):
            await task
    else:
        assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
    assert (await owner.browser.get(path)).json() == waiting
    assert db.execute("SELECT answers, transcript, step FROM app.setup_interviews WHERE interview_id = %s",
                      (interview_id,)).fetchone() == before
    monkeypatch.setattr(setup, "_rename", rename)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 25)
    retry = await answer(owner, model, interview_id, "We repair water heaters.")
    assert retry.status_code == 200 and retry.json()["busy"] is False
    assert retry.json()["question"] == setup.QUESTION_KEYS[1]


@pytest.mark.parametrize("recover_on", ["get", "answer"])
async def test_an_abandoned_answer_turn_is_rolled_back_on_get(
        app, browser, fake, kernel_http, model, db, recover_on):
    from psycopg.types.json import Jsonb
    from tests.api.test_setup_questions import answer, consent

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    waiting = await consent(owner, interview_id, False, model)
    before = db.execute("SELECT answers, transcript, step FROM app.setup_interviews WHERE interview_id = %s",
                        (interview_id,)).fetchone()
    transcript = before[1] + [{"role": "owner", "text": "An abandoned answer", "pending": "dead-run"}]
    db.execute("UPDATE app.setup_interviews SET transcript = %s,"
               " updated_at = now() - make_interval(secs => %s) WHERE interview_id = %s",
               (Jsonb(transcript), setup.TURN_ABANDONED_S + 10, interview_id))
    if recover_on == "get":
        assert (await owner.browser.get(path)).json() == waiting
        assert db.execute("SELECT answers, transcript, step FROM app.setup_interviews WHERE interview_id = %s",
                          (interview_id,)).fetchone() == before
    else:
        retry = await answer(owner, model, interview_id, "Plumbing", question=waiting["question"])
        assert retry.status_code == 200 and retry.json()["busy"] is False
        assert all(message["text"] != "An abandoned answer" for message in retry.json()["messages"])
        assert retry.json()["question"] == setup.QUESTION_KEYS[1]


@pytest.mark.parametrize("fail", [False, True])
async def test_a_marker_stage_leaves_no_entry_after_commit(
        app, browser, fake, kernel_http, model, monkeypatch, db, fail):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    before = db.execute("SELECT answers, transcript, step FROM app.setup_interviews WHERE interview_id = %s",
                        (interview_id,)).fetchone()
    marked = []

    async def turn(ctx, interview, staged):
        assert len(staged) == 1 and staged[0].text == "" and staged[0].pending
        marked.append(staged[0].pending)
        stored = await setup._read(app.state.runtime.database(), ctx, interview_id)
        assert stored.busy and stored.transcript[-1].pending == staged[0].pending
        if fail:
            interview.step = "tools"
            interview.answers = interview.answers.model_copy(update={"summary": "Must not be saved"})
            raise ApiProblem(503, "model_unavailable")

    async def marker(ctx, engine, model, interview_id, allow, **kwargs):
        kwargs.pop("cards", None)
        kwargs.pop("business_tools_enabled", None)
        return await setup.run_turn(ctx, engine, model, interview_id, **kwargs,
                                    check=lambda interview: None,
                                    stage=lambda interview: [setup.Entry(role="owner", text="")],
                                    turn=turn, keep_staged=False)

    monkeypatch.setattr(setup, "consent", marker)
    reply = await owner.browser.post(path + "/consent", json={"allow": False})
    assert reply.status_code == (503 if fail else 200)
    assert marked
    assert (await owner.browser.get(path)).json() == state
    assert db.execute("SELECT answers, transcript, step FROM app.setup_interviews WHERE interview_id = %s",
                      (interview_id,)).fetchone() == before


@pytest.mark.parametrize("slow", [False, True])
@pytest.mark.parametrize("fail", [False, True])
async def test_after_runs_after_the_commit_and_its_failure_is_logged(
        app, browser, fake, kernel_http, model, monkeypatch, caplog, slow, fail):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    release, entered, after_ran = asyncio.Event(), asyncio.Event(), asyncio.Event()
    renders = []

    async def turn(ctx, interview, staged):
        entered.set()
        await release.wait()
        interview.step = "tools"
        interview.transcript.append(setup.Entry(role="claude", text="Committed turn"))

    async def after(ctx, interview):
        assert not ctx.ro.conn.in_transaction()
        stored = await setup._read(app.state.runtime.database(), ctx, interview_id)
        assert setup._stored(stored) == setup._stored(interview)
        assert stored.step == "tools" and not stored.busy
        after_ran.set()
        if fail:
            raise RuntimeError("private-after-data")

    def render(interview, slug):
        renders.append(interview.busy)
        return setup.setup_state(interview, slug)

    async def custom(ctx, engine, model, interview_id, allow, **kwargs):
        kwargs.pop("cards", None)
        kwargs.pop("business_tools_enabled", None)
        return await setup.run_turn(ctx, engine, model, interview_id, **kwargs,
                                    check=lambda interview: None,
                                    stage=lambda interview: [setup.Entry(role="owner", text="")],
                                    turn=turn, keep_staged=False, after=after, render=render)

    monkeypatch.setattr(setup, "consent", custom)
    if slow:
        monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    else:
        release.set()
    try:
        reply = await owner.browser.post(path + "/consent", json={"allow": False})
        assert reply.status_code == (202 if slow else 200)
        if slow:
            await asyncio.wait_for(entered.wait(), 5)
            assert not after_ran.is_set()
            release.set()
            await app.state.runtime.turn_runs.wait(interview_id)
        assert after_ran.is_set()
        landed = (await owner.browser.get(path)).json()
        assert landed["step"] == "tools" and landed["busy"] is False
        assert landed["messages"][-1]["text"] == "Committed turn"
        if not slow:
            assert reply.json() == landed
        assert renders == [True, False]
        if fail:
            assert "setup turn after failed (RuntimeError)" in caplog.text
        assert "private-after-data" not in caplog.text
    finally:
        release.set()


@pytest.mark.parametrize(("end", "slow"), [("timeout", False), ("timeout", True), ("shutdown", True)])
async def test_after_timeout_or_shutdown_preserves_the_landed_state(
        app, browser, fake, kernel_http, model, monkeypatch, caplog, db, end, slow):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    entered = asyncio.Event()
    rollbacks = []
    rollback = setup._rollback_turn

    async def track_rollback(*args, **kwargs):
        rollbacks.append(True)
        await rollback(*args, **kwargs)

    async def turn(ctx, interview, staged):
        interview.step = "tools"
        interview.answers = interview.answers.model_copy(update={"summary": "Committed answer"})
        interview.transcript.append(setup.Entry(role="claude", text="Committed turn"))

    async def after(ctx, interview):
        assert interview_id in setup._RUNNING
        stored = await setup._read(app.state.runtime.database(), ctx, interview_id)
        assert setup._stored(stored) == setup._stored(interview)
        entered.set()
        await asyncio.Event().wait()

    async def custom(ctx, engine, model, interview_id, allow, **kwargs):
        kwargs.pop("cards", None)
        kwargs.pop("business_tools_enabled", None)
        return await setup.run_turn(ctx, engine, model, interview_id, **kwargs,
                                    check=lambda interview: None,
                                    stage=lambda interview: [setup.Entry(role="owner", text="")],
                                    turn=turn, keep_staged=False, after=after)

    monkeypatch.setattr(setup, "consent", custom)
    monkeypatch.setattr(setup, "_rollback_turn", track_rollback)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0 if slow else 25)
    # Only the post-commit callback should time out; staging and commits use the database, and the hook reads the
    # landed state before its own timeout or shutdown is tested.
    monkeypatch.setattr(setup, "TURN_RUN_TIMEOUT_S", 25)
    monkeypatch.setattr(setup, "TURN_AFTER_TIMEOUT_S", 2, raising=False)
    reply = await asyncio.wait_for(owner.browser.post(path + "/consent", json={"allow": False}), 5)
    assert reply.status_code == (202 if slow else 200), reply.text
    if slow:
        assert reply.json()["busy"] is True
        await asyncio.wait_for(entered.wait(), 5)
        assert app.state.runtime.turn_runs.holds(interview_id)
        assert (await owner.browser.get(path)).json()["step"] == "tools"
        if end == "shutdown":
            task = app.state.runtime.turn_runs._tasks[interview_id]
            await app.state.runtime.turn_runs.close()
            assert task.cancelled()
        else:
            await asyncio.wait_for(app.state.runtime.turn_runs.wait(interview_id), 5)
    assert entered.is_set()
    landed = (await owner.browser.get(path)).json()
    assert landed["step"] == "tools" and landed["busy"] is False
    assert landed["messages"][-1]["text"] == "Committed turn"
    if not slow:
        assert reply.json() == landed
    answers, transcript = db.execute("SELECT answers, transcript FROM app.setup_interviews WHERE interview_id = %s",
                                     (interview_id,)).fetchone()
    assert answers["summary"] == "Committed answer"
    assert all("pending" not in entry and entry["text"] != "" for entry in transcript)
    assert rollbacks == []
    assert interview_id not in setup._RUNNING
    assert not app.state.runtime.turn_runs.holds(interview_id)
    assert [(record.msg, record.args) for record in caplog.records if record.name == setup.logger.name] == (
        [("setup turn after failed (%s)", ("TimeoutError",))] if end == "timeout" else [])


async def test_consent_answers_200_with_the_first_question_when_the_reads_finish_in_time(
        app, browser, fake, kernel_http, model, db):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    assert state["busy"] is False
    reply = await owner.browser.post(f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": True})
    assert reply.status_code == 200, reply.text
    landed = reply.json()
    assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[0]
    assert [message["text"] for message in landed["messages"][2:4]] == [
        "Searched your Claude memory", "Read turner-plumbing.example"]
    assert [message["role"] for message in landed["messages"]] == [
        "claude", "owner", "tool_label", "tool_label", "claude"]
    (transcript,) = db.execute("SELECT transcript FROM app.setup_interviews WHERE interview_id = %s",
                               (state["interview_id"],)).fetchone()
    assert all("pending" not in entry for entry in transcript)


async def test_an_empty_model_reply_never_leaves_the_interview_busy(
        app, browser, fake, kernel_http, model, db):
    from tests.api.test_setup_questions import answer, turn

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    assert (await owner.browser.post(path + "/consent", json={"allow": False})).status_code == 200
    reply = await answer(owner, model, interview_id, "We repair water heaters.",
                         turn(reply="", step_done=False, summary="Water heater repairs."))
    assert reply.status_code == 200, reply.text
    answered = reply.json()
    assert answered["messages"][-1] == {
        "role": "claude", "text": setup.question_text("what_you_do", "trade"), "choices": [], "card": None}
    assert answered["messages"][-2] == {
        "role": "owner", "text": "We repair water heaters.", "choices": [], "card": None}
    assert answered["busy"] is False
    db.execute("UPDATE app.setup_interviews SET updated_at = now() - make_interval(secs => %s)"
               " WHERE interview_id = %s", (setup.TURN_ABANDONED_S + 10, interview_id))
    before = db.execute("SELECT * FROM app.setup_interviews WHERE interview_id = %s", (interview_id,)).fetchone()
    assert (await owner.browser.get(path)).json() == answered
    assert db.execute("SELECT * FROM app.setup_interviews WHERE interview_id = %s", (interview_id,)).fetchone() == before


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

    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    monkeypatch.setattr(setup, "_after_consent", failing)
    reply = await owner.browser.post(path + "/consent", json={"allow": True})
    assert reply.status_code == 202
    await asyncio.wait_for(entered.wait(), 5)
    task = app.state.runtime.turn_runs._tasks[state["interview_id"]]
    release.set()
    with pytest.raises(RuntimeError):
        await task
    rolled_back = (await owner.browser.get(path)).json()
    assert rolled_back == state
    assert "private-owner-data" not in caplog.text
    monkeypatch.setattr(setup, "_after_consent", after)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 25)
    again = await owner.browser.post(path + "/consent", json={"allow": True})
    assert again.status_code == 200 and again.json()["busy"] is False


async def test_a_repeat_while_busy_answers_202_without_a_second_run(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    asked, _ = held_limits(app, monkeypatch)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
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
        await app.state.runtime.turn_runs.wait(state["interview_id"])
    assert len(fake.called("POST /execute")) == 1


async def test_a_slow_consent_answers_202_busy_and_lands_later(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0.01, raising=False)
    release = fake.gate("POST /execute")
    path = f"/api/owner/setup/{state['interview_id']}"
    try:
        reply = await asyncio.wait_for(owner.browser.post(path + "/consent", json={"allow": True}), 0.5)
        assert reply.status_code == 202, reply.text
        busy = reply.json()
        assert busy["busy"] is True and busy["consent"] is True and busy["question"] is None
        assert busy["messages"][-1] == {
            "role": "owner", "text": setup.CONSENT_ANSWERS[True], "choices": [], "card": None}
        assert (await owner.browser.get(path)).json() == busy
    finally:
        release.set()
    await app.state.runtime.turn_runs.wait(state["interview_id"])
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
    transcript.append({"role": "owner", "text": setup.CONSENT_ANSWERS[True], "pending": "abandoned-consent"})
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
    abandoned(db, interview_id, setup.TURN_ABANDONED_S - 10)
    # A run in another process gets its full deadline before this process may recover it.
    young = (await owner.browser.get(path)).json()
    assert young["busy"] is True
    repeat = await owner.browser.post(path + "/consent", json={"allow": False})
    assert (repeat.status_code, repeat.json()) == (202, young)
    assert fake.called("POST /execute") == []
    db.execute("UPDATE app.setup_interviews SET updated_at = now() - make_interval(secs => %s)"
               " WHERE interview_id = %s", (setup.TURN_ABANDONED_S + 10, interview_id))
    if on == "get":
        assert (await owner.browser.get(path)).json() == state
    else:
        fresh = await owner.browser.post(path + "/consent", json={"allow": False})
        assert fresh.status_code == 200, fresh.text
        assert fresh.json()["busy"] is False and fresh.json()["consent"] is False
        assert fresh.json()["question"] == setup.QUESTION_KEYS[0]


@pytest.mark.parametrize("consent_pending", [True, False])
async def test_abandoned_recovery_removes_every_marker_and_preserves_unmarked_entries(
        app, browser, fake, kernel_http, model, db, consent_pending):
    from psycopg.types.json import Jsonb

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    (transcript,) = db.execute("SELECT transcript FROM app.setup_interviews WHERE interview_id = %s",
                               (interview_id,)).fetchone()
    consent_answer = {"role": "owner", "text": setup.CONSENT_ANSWERS[True]}
    if consent_pending:
        consent_answer["pending"] = "consent-run"
    transcript.extend([
        consent_answer,
        {"role": "claude", "text": "What do you do?", "question": "what_you_do"},
        {"role": "owner", "text": "A pending answer", "pending": "first-run"},
        {"role": "owner", "text": "Another pending answer", "pending": "second-run"},
        {"role": "owner", "text": "An ordinary answer"},
    ])
    expected = [entry for entry in transcript if "pending" not in entry]
    db.execute("UPDATE app.setup_interviews SET consent = true, transcript = %s,"
               " updated_at = now() - make_interval(secs => %s) WHERE interview_id = %s",
               (Jsonb(transcript), setup.TURN_ABANDONED_S - 10, interview_id))
    # Only the explicit markers make this busy, even with an ordinary answer at the end.
    assert (await owner.browser.get(path)).json()["busy"] is True
    db.execute("UPDATE app.setup_interviews SET updated_at = now() - make_interval(secs => %s)"
               " WHERE interview_id = %s", (setup.TURN_ABANDONED_S + 10, interview_id))
    recovered = (await owner.browser.get(path)).json()
    consent, transcript = db.execute("SELECT consent, transcript FROM app.setup_interviews WHERE interview_id = %s",
                                     (interview_id,)).fetchone()
    assert transcript == expected
    assert consent is (None if consent_pending else True)
    assert recovered["busy"] is False


async def test_any_turn_while_busy_answers_202_without_running(app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    asked, _ = held_limits(app, monkeypatch)
    path = f"/api/owner/setup/{state['interview_id']}"
    release = fake.gate("POST /execute")
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    try:
        pending = await owner.browser.post(path + "/consent", json={"allow": True})
        assert pending.status_code == 202
        calls = len(model.requests)
        reply = await owner.browser.post(path + "/answer", json={"question": "what_you_do", "text": "Plumbing"})
        assert (reply.status_code, reply.json()) == (202, pending.json())
        repeat = await owner.browser.post(path + "/consent", json={"allow": False})
        assert (repeat.status_code, repeat.json()) == (202, pending.json())
        assert len(model.requests) == calls
        assert asked.count("setup_turn") == 1
        assert (await owner.browser.get(path)).json()["busy"] is True
    finally:
        release.set()
        await app.state.runtime.turn_runs.wait(state["interview_id"])


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


async def test_a_stalled_detached_entry_is_bounded_by_the_run_deadline(
        app, browser, fake, kernel_http, model, monkeypatch, db):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    before = db.execute("SELECT * FROM app.setup_interviews WHERE interview_id = %s", (interview_id,)).fetchone()
    entered, exited = asyncio.Event(), asyncio.Event()
    detached = setup.detached
    runs = app.state.runtime.turn_runs

    @contextlib.asynccontextmanager
    async def stalled(owner, engine, ro_schema):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            exited.set()
        yield owner

    monkeypatch.setattr(setup, "detached", stalled)
    monkeypatch.setattr(setup, "TURN_RUN_TIMEOUT_S", 0.2)
    request = asyncio.create_task(owner.browser.post(path + "/consent", json={"allow": False}))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert interview_id in setup._RUNNING and runs.holds(interview_id)
        reply = await asyncio.wait_for(asyncio.shield(request), 1)
        assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
        assert exited.is_set()
        assert interview_id not in setup._RUNNING and not runs.holds(interview_id)
        assert (await owner.browser.get(path)).json() == state
        assert db.execute("SELECT * FROM app.setup_interviews WHERE interview_id = %s",
                          (interview_id,)).fetchone() == before
    finally:
        await runs.close()
        await asyncio.gather(request, return_exceptions=True)

    monkeypatch.setattr(setup, "detached", detached)
    monkeypatch.setattr(setup, "TURN_RUN_TIMEOUT_S", 100)
    retry = await owner.browser.post(path + "/consent", json={"allow": False})
    assert retry.status_code == 200 and retry.json()["busy"] is False
    assert retry.json()["question"] == setup.QUESTION_KEYS[0]


@pytest.mark.parametrize(("end", "slow"), [("deadline", False), ("deadline", True), ("shutdown", True)])
async def test_a_run_deadline_or_shutdown_reopens_consent(
        app, browser, fake, kernel_http, model, monkeypatch, end, slow, caplog):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model, website=WEBSITE)
    path = f"/api/owner/setup/{state['interview_id']}"
    entered, release = asyncio.Event(), asyncio.Event()

    async def waiting(owner, engine, model, interview, entries):
        entered.set()
        await release.wait()

    monkeypatch.setattr(setup, "_after_consent", waiting)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0 if slow else 25)
    monkeypatch.setattr(setup, "TURN_RUN_TIMEOUT_S", 100)
    if end == "deadline":
        # Keep the real timeout, but arm it only after database staging reaches the stalled step.
        deadline = asyncio.timeout(None)
        monkeypatch.setattr(setup.asyncio, "timeout_at", lambda when: deadline)
    request = asyncio.create_task(owner.browser.post(path + "/consent", json={"allow": True}))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if slow:
            reply = await asyncio.wait_for(asyncio.shield(request), 5)
        if end == "deadline":
            deadline.reschedule(asyncio.get_running_loop().time())
        if not slow:
            reply = await asyncio.wait_for(asyncio.shield(request), 5)
        assert reply.status_code == (202 if slow else 503)
        if slow:
            task = app.state.runtime.turn_runs._tasks[state["interview_id"]]
            if end == "shutdown":
                await app.state.runtime.turn_runs.close()
                assert task.cancelled()
                assert "CancelledError" in caplog.text
            else:
                with pytest.raises(ApiProblem) as failed:
                    await asyncio.wait_for(asyncio.shield(task), 5)
                assert (failed.value.status, failed.value.error) == (503, "model_unavailable")
                assert "TimeoutError" in caplog.text
        else:
            assert reply.json() == {"error": "model_unavailable"}
            assert "TimeoutError" in caplog.text
        assert (await owner.browser.get(path)).json() == state
        assert state["interview_id"] not in setup._RUNNING
        assert not app.state.runtime.turn_runs.holds(state["interview_id"])
    finally:
        release.set()
        await app.state.runtime.turn_runs.close()
        await asyncio.gather(request, return_exceptions=True)


async def test_a_wait_that_expires_returns_the_busy_snapshot_even_if_the_run_lands_just_after(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    runs = app.state.runtime.turn_runs
    read = setup._read

    async def after_the_run(engine, owner, interview_id):
        # If the request re-reads after its wait expired, let the run finish before that read.
        if runs.holds(interview_id):
            await runs.wait(interview_id)
        return await read(engine, owner, interview_id)

    monkeypatch.setattr(setup, "_read", after_the_run)
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    reply = await owner.browser.post(f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": False})
    assert reply.status_code == 202 and reply.json()["busy"] is True
    await runs.wait(state["interview_id"])


async def test_a_held_run_is_not_recovered_even_when_its_row_is_old(
        app, browser, fake, kernel_http, model, monkeypatch, db):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    path = f"/api/owner/setup/{state['interview_id']}"
    release = fake.gate("POST /execute")
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    try:
        reply = await owner.browser.post(path + "/consent", json={"allow": True})
        assert reply.status_code == 202
        db.execute("UPDATE app.setup_interviews SET updated_at = now() - make_interval(secs => %s)"
                   " WHERE interview_id = %s", (setup.TURN_ABANDONED_S + 10, state["interview_id"]))
        assert (await owner.browser.get(path)).json() == reply.json()
        repeat = await owner.browser.post(path + "/consent", json={"allow": False})
        assert (repeat.status_code, repeat.json()) == (202, reply.json())
    finally:
        release.set()
        await app.state.runtime.turn_runs.wait(state["interview_id"])


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

    monkeypatch.setattr(setup, "TURN_WAIT_S", 0)
    monkeypatch.setattr(setup, "_after_consent", changed)
    assert (await owner.browser.post(path + "/consent", json={"allow": True})).status_code == 202
    await asyncio.wait_for(entered.wait(), 5)
    task = app.state.runtime.turn_runs._tasks[state["interview_id"]]
    (transcript,) = db.execute("SELECT transcript FROM app.setup_interviews WHERE interview_id = %s",
                               (state["interview_id"],)).fetchone()
    # A completed turn clears the pending marker in the same write as Claude's reply.
    for entry in transcript:
        entry.pop("pending", None)
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
        await app.state.runtime.turn_runs.wait(state["interview_id"])
    landed = (await owner.browser.get(path)).json()
    assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[0]


async def test_cancelling_the_request_right_after_admission_still_finishes_consent(
        app, browser, fake, kernel_http, model, monkeypatch):
    from desk.api.routes import setup as routes

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    moving_on, after = routes._moving_on, setup._after_consent
    entered, release = asyncio.Event(), asyncio.Event()
    runs = app.state.runtime.turn_runs

    async def cancel_after_admission(*args):
        await moving_on(*args)
        asyncio.current_task().cancel()

    async def waiting(*args):
        entered.set()
        await release.wait()
        await after(*args)

    monkeypatch.setattr(routes, "_moving_on", cancel_after_admission)
    monkeypatch.setattr(setup, "_after_consent", waiting)
    request = asyncio.create_task(owner.browser.post(path + "/consent", json={"allow": False}))
    try:
        with pytest.raises(asyncio.CancelledError):
            await request
        assert runs.holds(interview_id)
        assert interview_id in setup._RUNNING
        await asyncio.wait_for(entered.wait(), 5)
        assert (await owner.browser.get(path)).json()["busy"] is True
    finally:
        release.set()
        await runs.wait(interview_id)
    landed = (await owner.browser.get(path)).json()
    assert landed["busy"] is False and landed["consent"] is False
    assert landed["question"] == setup.QUESTION_KEYS[0]
    assert interview_id not in setup._RUNNING


@pytest.mark.parametrize("fail", [False, True])
async def test_cancelling_the_request_during_the_busy_commit_cannot_strand_consent(
        app, browser, fake, kernel_http, model, monkeypatch, fail):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    commit, after = setup._commit, setup._after_consent
    committed, release = asyncio.Event(), asyncio.Event()
    runs = app.state.runtime.turn_runs

    async def finishing_commit(engine, ctx, interview, seen):
        await commit(engine, ctx, interview, seen)
        if interview.busy:
            committed.set()
            await release.wait()

    async def finishing(*args):
        if fail:
            raise ApiProblem(503, "model_unavailable")
        await after(*args)

    monkeypatch.setattr(setup, "_commit", finishing_commit)
    monkeypatch.setattr(setup, "_after_consent", finishing)
    request = asyncio.create_task(owner.browser.post(path + "/consent", json={"allow": False}))
    try:
        await asyncio.wait_for(committed.wait(), 5)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert runs.holds(interview_id)
        task = runs._tasks[interview_id]
        assert (await owner.browser.get(path)).json()["busy"] is True
    finally:
        release.set()
        await asyncio.gather(request, runs.wait(interview_id), return_exceptions=True)
    if fail:
        with pytest.raises(ApiProblem):
            task.result()
        assert (await owner.browser.get(path)).json() == state
    else:
        landed = (await owner.browser.get(path)).json()
        assert landed["busy"] is False and landed["question"] == setup.QUESTION_KEYS[0]
    assert interview_id not in setup._RUNNING and not runs.holds(interview_id)


async def test_a_rejected_busy_commit_answers_its_error_without_running_or_rolling_back(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    commits = []

    async def conflicting(engine, ctx, interview, seen):
        assert interview.busy
        commits.append(interview_id)
        raise ApiProblem(409, "conflict")

    async def unexpected(*args, **kwargs):
        pytest.fail("a rejected busy commit must neither run the seam nor roll back another run")

    monkeypatch.setattr(setup, "_commit", conflicting)
    monkeypatch.setattr(setup, "_after_consent", unexpected)
    monkeypatch.setattr(setup, "_rollback_turn", unexpected)
    reply = await asyncio.wait_for(owner.browser.post(path + "/consent", json={"allow": True}), 5)
    assert (reply.status_code, reply.json()) == (409, {"error": "conflict"})
    assert commits == [interview_id] and fake.called("POST /execute") == []
    assert (await owner.browser.get(path)).json() == state
    assert interview_id not in setup._RUNNING and not app.state.runtime.turn_runs.holds(interview_id)


async def test_a_failed_busy_commit_preserves_another_runs_identical_consent(
        app, browser, fake, kernel_http, model, monkeypatch, db):
    from psycopg.types.json import Jsonb

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    commit = setup._commit
    other = None

    async def connection_failure(engine, ctx, interview, seen):
        nonlocal other
        other = setup._stored(interview)
        assert other["transcript"][-1]["pending"]
        assert other["transcript"][-1]["pending"] != "other-consent-run"
        other["transcript"][-1]["pending"] = "other-consent-run"
        connect = type(engine).connect

        def unavailable(self):
            if self is not engine:
                return connect(self)
            monkeypatch.setattr(type(engine), "connect", connect)
            # Another process stores identical consent before this run obtains a connection.
            db.execute("UPDATE app.setup_interviews SET consent = true, transcript = %s,"
                       " updated_at = now() WHERE interview_id = %s", (Jsonb(other["transcript"]), interview_id))
            raise OSError("connection unavailable")

        monkeypatch.setattr(type(engine), "connect", unavailable)
        await commit(engine, ctx, interview, seen)

    async def unexpected(*args):
        pytest.fail("a failed busy commit must not start the consent work")

    monkeypatch.setattr(setup, "_commit", connection_failure)
    monkeypatch.setattr(setup, "_after_consent", unexpected)
    with pytest.raises(OSError, match="connection unavailable"):
        await asyncio.wait_for(owner.browser.post(path + "/consent", json={"allow": True}), 5)
    consent, transcript = db.execute("SELECT consent, transcript FROM app.setup_interviews WHERE interview_id = %s",
                                     (interview_id,)).fetchone()
    assert consent is True and transcript == other["transcript"]
    current = (await owner.browser.get(path)).json()
    assert current["busy"] is True and current["consent"] is True
    assert current["messages"][-1] == {
        "role": "owner", "text": setup.CONSENT_ANSWERS[True], "choices": [], "card": None}
    assert fake.called("POST /execute") == []
    assert interview_id not in setup._RUNNING and not app.state.runtime.turn_runs.holds(interview_id)


@pytest.mark.parametrize("consent_pending", [True, False])
async def test_a_failed_run_removes_only_its_markers_from_a_changed_transcript(
        app, browser, fake, kernel_http, model, monkeypatch, db, consent_pending):
    from psycopg.types.json import Jsonb

    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    kept = []

    async def changed(ctx, engine, model, interview, entries):
        (transcript,) = db.execute("SELECT transcript FROM app.setup_interviews WHERE interview_id = %s",
                                   (interview_id,)).fetchone()
        run_id = transcript[-1]["pending"]
        if not consent_pending:
            transcript[-1]["pending"] = "other-run"
        transcript.extend([
            {"role": "claude", "text": "What do you do?", "question": "what_you_do"},
            {"role": "owner", "text": "Another pending answer", "pending": run_id},
            {"role": "owner", "text": "Other run's answer", "pending": "other-run"},
            {"role": "claude", "text": "Saved by another process"},
        ])
        kept.extend(entry for entry in transcript if entry.get("pending") != run_id)
        db.execute("UPDATE app.setup_interviews SET transcript = %s, updated_at = now() WHERE interview_id = %s",
                   (Jsonb(transcript), interview_id))
        raise ApiProblem(503, "model_unavailable")

    monkeypatch.setattr(setup, "_after_consent", changed)
    reply = await owner.browser.post(path + "/consent", json={"allow": True})
    assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
    consent, transcript = db.execute("SELECT consent, transcript FROM app.setup_interviews WHERE interview_id = %s",
                                     (interview_id,)).fetchone()
    assert transcript == kept
    assert consent is (None if consent_pending else True)
    current = (await owner.browser.get(path)).json()
    assert current["busy"] is True and current["messages"][-1]["text"] == "Saved by another process"


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
        {"role": "owner", "text": setup.CONSENT_ANSWERS[True], "choices": [], "card": None}]


async def test_a_competing_consent_cannot_take_the_guard_during_handoff(
        app, browser, fake, kernel_http, model, monkeypatch):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    interview_id = state["interview_id"]
    path = f"/api/owner/setup/{interview_id}"
    runs = app.state.runtime.turn_runs
    recover, start, after = setup._recover_turn, runs.start, setup._after_consent
    loaded, handoff = asyncio.Event(), asyncio.Event()
    asked, (first_admission, second_admission) = held_limits(app, monkeypatch, hold=2)
    first_admission.set()
    executions = []

    async def stale_snapshot(*args, **kwargs):
        interview = await recover(*args, **kwargs)
        if asyncio.current_task() is competing:
            loaded.set()
            await handoff.wait()
        return interview

    def handing_off(key, work):
        # Queue the request with the old snapshot before the background coroutine can start.
        handoff.set()
        return start(key, work)

    async def counted(*args):
        executions.append(interview_id)
        await after(*args)

    monkeypatch.setattr(setup, "_recover_turn", stale_snapshot)
    monkeypatch.setattr(runs, "start", handing_off)
    monkeypatch.setattr(setup, "_after_consent", counted)
    competing = asyncio.create_task(owner.browser.post(path + "/consent", json={"allow": False}))
    try:
        await asyncio.wait_for(loaded.wait(), 5)
        reply = await asyncio.wait_for(owner.browser.post(path + "/consent", json={"allow": False}), 5)
        assert reply.status_code == 200, reply.text
        second = await asyncio.wait_for(asyncio.shield(competing), 5)
        assert second.status_code in (202, 409), second.text
        assert asked.count("setup_turn") == 1
        assert executions == [interview_id]
        assert (await owner.browser.get(path)).json()["busy"] is False
    finally:
        handoff.set()
        second_admission.set()
        await asyncio.gather(competing, runs.wait(interview_id), return_exceptions=True)
    assert interview_id not in setup._RUNNING


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
    monkeypatch.setattr(setup, "_rollback_turn", stalled)
    monkeypatch.setattr(setup, "TURN_ROLLBACK_TIMEOUT_S", 0.01, raising=False)
    try:
        reply = await asyncio.wait_for(owner.browser.post(
            f"/api/owner/setup/{state['interview_id']}/consent", json={"allow": False}), 5)
        assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
        assert "couldn't be reopened (TimeoutError)" in caplog.text
        assert not app.state.runtime.turn_runs.holds(state["interview_id"])
    finally:
        release.set()
        await asyncio.gather(app.state.runtime.turn_runs.wait(state["interview_id"]), return_exceptions=True)
