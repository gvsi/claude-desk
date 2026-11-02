"""Setup's "Change something": reopening the interview's chat from a later step (`setup.reopen`).

Once setup has left its questions step, the owner can send Claude a change from Real situations or the closing plan.
The route moves the interview back to `questions` and runs the owner's message as the next owner turn, through the
same turn runner as an answer: idempotent per request by its key, refused while a turn runs, and refused once the
Desk is live. Going back invalidates what was drafted from the answers, so the rules, the situations and the safety
check are drafted again on the way forward, and nothing is confirmed or goes live without a new safety check.

The app runs on FakeKernel with a scripted model, as the other setup tests do.
"""

import asyncio
import json
import secrets

import httpx
import pytest
from sqlalchemy import text as sql

from desk.api import proving, setup
from desk.api.prompts import QUESTIONS, DraftedSituations
from tests.api.fakes import gated, unavailable
from tests.api.test_setup_questions import Owner, answer, next_step, stored as stored_questions, structured, turn, until
from tests.api.test_setup_rules import (  # noqa: F401  (the app and model fixtures)
    GOOD_CARDS,
    HOURS,
    SITUATIONS,
    app,
    drafted,
    drafted_rules,
    model,
    policy,
    ready,
    stored,
)

CHANGE = "We're closed on Saturdays now."
REOPENABLE = ("tools", "rules", "situations", "safety_check", "preview")


def reopen_path(state: dict) -> str:
    return f"/api/owner/setup/{state['interview_id']}/reopen"


async def reopen(owner: Owner, state: dict, text: str = CHANGE, *, key: str | None = None) -> httpx.Response:
    """The owner's change, sent from a step after the questions with its own idempotency key."""
    return await owner.browser.post(reopen_path(state), json={"text": text,
                                                              "idempotency_key": key or secrets.token_hex(8)})


async def at_step(owner: Owner, model, state: dict, step: str) -> None:
    """Move a setup that finished its questions (`ready`) forward to `step`, as the web does."""
    if step == "tools":
        return
    await drafted_rules(owner, model, state)
    if step == "rules":
        return
    model.add(structured(DraftedSituations(situations=SITUATIONS)))
    assert (await owner.browser.post(policy(state, "situations"))).status_code == 200
    if step == "situations":
        return
    assert (await owner.browser.post(policy(state, "safety_check"))).status_code == 200
    if step == "safety_check":
        return
    assert (await owner.browser.post(policy(state, "confirm"))).status_code == 200


@pytest.mark.parametrize("step", REOPENABLE)
async def test_a_change_from_a_later_step_reopens_the_questions_with_the_owners_message(
        app, browser, kernel_http, model, engine, step):
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, step)
    assert (await stored(engine, state["interview_id"]))["step"] == step
    calls = len(model.requests)

    # Claude answers the change as any owner turn, here asking a follow-up, so the interview waits on its question.
    model.add(turn("Closed on Saturdays, noted. Should weekday hours stay the same?", step_done=False))
    reply = await reopen(owner, state)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert body["step"] == "questions" and body["busy"] is False
    assert [(message["role"], message["text"]) for message in body["messages"][-2:]] == [
        ("owner", CHANGE), ("claude", "Closed on Saturdays, noted. Should weekday hours stay the same?")]
    assert body["question"] == setup.REOPEN_TOPIC

    # One model call: the turn on the reopened question, with the owner's words as its answer.
    (request,) = model.requests[calls:]
    assert request.output_schema is setup.SETUP_TURNS[setup.REOPEN_TOPIC]
    assert f"<owner_answer>{CHANGE}</owner_answer>" in request.messages[-1]["content"][0]["text"]

    # What was drafted from the answers is gone, so the steps after the questions draft it again.
    row = await stored(engine, state["interview_id"])
    assert (row["step"], row["draft_cards"], row["draft_version"]) == ("questions", [], None)
    for later in ("rules", "situations", "safety_check", "confirm", "go_live"):
        refused = await owner.browser.post(policy(state, later))
        assert (refused.status_code, refused.json()["error"]) == (409, "conflict"), later


async def test_a_repeated_send_answers_the_first_and_another_body_with_its_key_is_a_conflict(
        app, browser, kernel_http, model, engine):
    owner, state = await ready(app, browser, kernel_http, model)
    model.add(turn("Closed on Saturdays, noted. Anything else?", step_done=False))
    first = await reopen(owner, state, key="change-1")
    assert first.status_code == 200, first.text
    calls = len(model.requests)

    # The same send again (a lost reply, say) runs nothing and answers the interview as it stands.
    again = await reopen(owner, state, key="change-1")
    assert again.status_code == 200, again.text
    assert again.json() == first.json()
    assert len(model.requests) == calls
    assert [message["text"] for message in again.json()["messages"]].count(CHANGE) == 1

    # The same key with other words is refused, with nothing run or stored.
    other = await reopen(owner, state, "Make it open on Sundays too.", key="change-1")
    assert (other.status_code, other.json()["error"]) == (409, "conflict")
    assert len(model.requests) == calls
    assert (await owner.browser.get(f"/api/owner/setup/{state['interview_id']}")).json() == first.json()

    # A send needs its key.
    keyless = await owner.browser.post(reopen_path(state), json={"text": CHANGE})
    assert keyless.status_code == 422


async def test_a_change_is_refused_while_a_turn_runs_at_the_questions_and_once_live(
        app, browser, kernel_http, model, engine):
    owner, state = await ready(app, browser, kernel_http, model)

    # While the change's own turn runs, another send is refused at once; the first lands on its own.
    release = asyncio.Event()
    model.add(gated(turn("Closed on Saturdays, noted. Anything else?", step_done=False), release))
    running = asyncio.create_task(reopen(owner, state, key="change-1"))
    await until(lambda: setup._RUNNING)
    busy = await reopen(owner, state, "Open on Sundays too.", key="change-2")
    assert (busy.status_code, busy.json()["error"]) == (409, "conflict")
    release.set()
    assert (await asyncio.wait_for(running, 10)).status_code == 200

    # Back at the questions, "Change something" has nothing to reopen: the chat takes answers.
    at_questions = await reopen(owner, state, key="change-3")
    assert (at_questions.status_code, at_questions.json()["error"]) == (409, "conflict")

    # A live Desk is changed in the owner app, never by reopening setup.
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, "preview")
    assert (await owner.browser.post(policy(state, "go_live"))).status_code == 200
    calls = len(model.requests)
    live = await reopen(owner, state)
    assert (live.status_code, live.json()["error"]) == (409, "conflict")
    assert len(model.requests) == calls
    assert (await stored(engine, state["interview_id"]))["step"] == "live"


async def test_a_failed_change_leaves_the_step_and_its_draft_as_they_were(app, browser, kernel_http, model, engine):
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, "situations")
    before = await stored(engine, state["interview_id"])
    model.add(unavailable())
    failed = await reopen(owner, state, key="change-1")
    assert (failed.status_code, failed.json()["error"]) == (503, "model_unavailable")
    assert await stored(engine, state["interview_id"]) == before
    shown = (await owner.browser.get(f"/api/owner/setup/{state['interview_id']}")).json()
    assert shown["step"] == "situations" and CHANGE not in [message["text"] for message in shown["messages"]]

    # The same send can go again, and lands.
    model.add(turn("Closed on Saturdays, noted. Anything else?", step_done=False))
    again = await reopen(owner, state, key="change-1")
    assert again.status_code == 200 and again.json()["step"] == "questions", again.text


@pytest.mark.parametrize("timeout", [False, True])
async def test_a_slow_reopen_answers_202_and_is_polled_or_rolled_back_at_its_deadline(
        app, browser, kernel_http, model, engine, monkeypatch, timeout):
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, "preview")
    before = await stored(engine, state["interview_id"])
    monkeypatch.setattr(setup, "TURN_WAIT_S", 0.01)
    monkeypatch.setattr(setup, "TURN_RUN_TIMEOUT_S", 0.5 if timeout else 10)
    release = asyncio.Event()
    model.add(gated(turn("Closed on Saturdays, noted. Anything else?", step_done=False), release))
    pending = await reopen(owner, state, key="slow-change")
    assert pending.status_code == 202 and pending.json()["busy"] is True
    again = await reopen(owner, state, key="slow-change")
    assert again.status_code == 202 and again.json() == pending.json()
    different = await reopen(owner, state, "Open Sundays too.", key="slow-change")
    assert (different.status_code, different.json()["error"]) == (409, "conflict")
    # The old preview and draft cannot be used while the change runs.
    for early in ("rules", "confirm", "go_live"):
        refused = await owner.browser.post(policy(state, early))
        assert (refused.status_code, refused.json()["error"]) == (409, "conflict")
    if not timeout:
        release.set()
    await until(lambda: not setup._RUNNING)
    read = await owner.browser.get(f"/api/owner/setup/{state['interview_id']}")
    assert read.status_code == 200 and read.json()["busy"] is False
    if timeout:
        assert await stored(engine, state["interview_id"]) == before
    else:
        assert read.json()["step"] == "questions"
        assert read.json()["messages"][-1]["text"] == "Closed on Saturdays, noted. Anything else?"


# The safety check, the confirm and going live hold the interview from their first read to their last write: a change
# sent meanwhile is refused at once, and none of them starts while a change runs.
TRANSITIONS = [("safety_check", "POST /policy/{version}/probe", "situations", "safety_check"),
               ("confirm", "POST /policy/confirm", "safety_check", "preview"),
               ("go_live", "PUT /desks/{id}/answering", "preview", "live")]


@pytest.mark.parametrize(("route", "kernel_route", "step", "after"), TRANSITIONS)
async def test_a_change_sent_while_the_safety_check_confirm_or_go_live_runs_is_refused(
        app, browser, kernel_http, model, engine, fake, route, kernel_route, step, after):
    # Held at the kernel, past its checks: the change can't land under it, so old rules are never confirmed or taken
    # live after the owner reopened the questions.
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, step)
    active = fake.desks[state["desk_id"]].policy_version
    before = len(fake.called(kernel_route))
    release = fake.gate(kernel_route)
    running = asyncio.create_task(owner.browser.post(policy(state, route)))
    await until(lambda: len(fake.called(kernel_route)) > before)
    calls = len(model.requests)
    try:
        refused = await reopen(owner, state)
        assert (refused.status_code, refused.json()["error"]) == (409, "conflict")
    finally:
        release.set()
    finished = await asyncio.wait_for(running, 10)
    assert finished.status_code == 200, finished.text
    assert len(model.requests) == calls
    row = await stored_questions(engine, state["interview_id"])
    assert row["step"] == after
    assert CHANGE not in [entry["text"] for entry in row["transcript"]]
    if route == "confirm":
        assert fake.desks[state["desk_id"]].policy_version != active
    assert fake.desks[state["desk_id"]].answering is (route == "go_live")

    # Once it has landed, the change is taken as usual.
    if route != "go_live":
        model.add(turn("Closed on Saturdays, noted. Anything else?", step_done=False))
        changed = await reopen(owner, state)
        assert changed.status_code == 200 and changed.json()["step"] == "questions", changed.text


@pytest.mark.parametrize(("route", "kernel_route", "step", "after"), TRANSITIONS)
async def test_the_safety_check_confirm_or_go_live_is_refused_while_a_change_runs(
        app, browser, kernel_http, model, engine, fake, monkeypatch, route, kernel_route, step, after):
    # The change is admitted but hasn't stored its busy message yet: this process's guard alone refuses the
    # transition, before any kernel call.
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, step)
    before = await stored(engine, state["interview_id"])
    called = len(fake.called(kernel_route))
    held, original = asyncio.Event(), setup._commit

    async def commit(*args, **kwargs):
        await held.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(setup, "_commit", commit)
    model.add(turn("Closed on Saturdays, noted. Anything else?", step_done=False))
    changing = asyncio.create_task(reopen(owner, state))
    try:
        await until(lambda: setup._RUNNING)
        refused = await owner.browser.post(policy(state, route))
        assert (refused.status_code, refused.json()["error"]) == (409, "conflict")
        assert len(fake.called(kernel_route)) == called
        assert await stored(engine, state["interview_id"]) == before
    finally:
        held.set()
    changed = await asyncio.wait_for(changing, 10)
    assert changed.status_code == 200 and changed.json()["step"] == "questions", changed.text
    assert fake.desks[state["desk_id"]].answering is False


async def test_a_change_landing_from_elsewhere_during_go_live_leaves_the_desk_off(
        app, browser, kernel_http, model, engine, fake):
    # Another API process's change lands while Answering is being turned on: the interview isn't marked live, and
    # Answering goes off again, so the Desk never answers on the rules the owner is changing.
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, "preview")
    route = "PUT /desks/{id}/answering"
    before = len(fake.called(route))
    release = fake.gate(route)
    running = asyncio.create_task(owner.browser.post(policy(state, "go_live")))
    await until(lambda: len(fake.called(route)) > before)
    try:
        async with engine.connect() as conn, conn.begin():
            found = await setup._load(conn, owner.copy_id, state["interview_id"], lock=True)
            found.step, found.draft_cards, found.draft_version = "questions", [], None
            found.transcript.append(setup.Entry(role="owner", text=CHANGE, reopen_key="elsewhere",
                                                reopen_sha256=setup.reopen_sha256(CHANGE)))
            await setup._save(conn, found)
    finally:
        release.set()
    refused = await asyncio.wait_for(running, 10)
    assert (refused.status_code, refused.json()["error"]) == (409, "conflict")
    assert (await stored(engine, state["interview_id"]))["step"] == "questions"
    assert fake.desks[state["desk_id"]].answering is False


async def test_a_safety_check_of_one_draft_never_marks_the_next_one_checked(
        app, browser, kernel_http, model, engine, fake, monkeypatch):
    # After a change, the rules are confirmed only once the safety check ran on their draft. A check still running on
    # the draft before when the rules are drafted again (the rules in force changed, say) answers 409 and leaves the
    # new draft unchecked.
    owner, state = await ready(app, browser, kernel_http, model)
    model.add(turn(next={"kind": "done"}))
    model.add(next_step("contact_and_after_hours", next={"kind": "done"}))
    assert (await reopen(owner, state)).status_code == 200
    await at_step(owner, model, state, "situations")
    checked = (await stored(engine, state["interview_id"]))["draft_version"]
    route = "POST /policy/{version}/probe"
    before = len(fake.called(route))
    release = fake.gate(route)
    checking = asyncio.create_task(owner.browser.post(policy(state, "safety_check")))
    await until(lambda: len(fake.called(route)) > before)
    try:
        fake.never(state["desk_id"], "native.capture_lead")
        app.state.runtime.proving.forget(state["desk_id"])
        redrafted = await owner.browser.post(policy(state, "rules"))
        assert redrafted.status_code == 200, redrafted.text
        assert redrafted.json()["version"] != checked
    finally:
        release.set()
    stale = await asyncio.wait_for(checking, 10)
    assert (stale.status_code, stale.json()["error"]) == (409, "conflict")
    row = await stored(engine, state["interview_id"])
    assert (row["step"], row["draft_version"]) == ("rules", redrafted.json()["version"])
    refused = await owner.browser.post(policy(state, "confirm"))
    assert (refused.status_code, refused.json()["error"]) == (409, "conflict")

    # Its own check, then the confirm.
    app.state.runtime.proving.forget(state["desk_id"])
    assert (await owner.browser.post(policy(state, "safety_check"))).status_code == 200
    assert (await owner.browser.post(policy(state, "confirm"))).status_code == 200


@pytest.mark.parametrize("step", ["safety_check", "preview"])
async def test_moving_forward_after_a_change_drafts_the_rules_situations_and_safety_check_again(
        app, browser, kernel_http, model, engine, fake, step):
    # From the safety check, the answers its steps gave before are still kept for a re-post; from the preview, the
    # rules are already confirmed.
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, step)
    first = (await stored(engine, state["interview_id"]))
    confirmed = fake.desks[state["desk_id"]].policy_version

    # The change lands and Claude closes the questions again with a new plan: setup is at its tools again.
    model.add(turn("Closed on Saturdays, noted.", hours=[HOURS[0]],
                   next={"kind": "done"}, plan="Your Desk books weekday visits."))
    model.add(next_step("contact_and_after_hours", next={"kind": "done"}, plan="Your Desk books weekday visits."))
    changed = await reopen(owner, state)
    assert changed.status_code == 200, changed.text
    assert changed.json()["step"] == "tools"
    assert changed.json()["messages"][-1]["text"] == "Your Desk books weekday visits."
    weekday_hours = [{"days": HOURS[0].days, "start": "08:00:00", "end": "18:00:00"}]
    assert (await stored(engine, state["interview_id"]))["answers"]["hours"] == weekday_hours

    # The rules are drafted again from the answers (a new card draft, a new version), never re-posted from before.
    drafts = len([request for request in model.requests if request.route == "card_draft"])
    changed_cards = [card.model_copy(update={"reason": "Book weekday visits only."})
                     if card.applies_to == "native.book" else card for card in GOOD_CARDS]
    draft = await drafted_rules(owner, model, state, *changed_cards)
    assert len([request for request in model.requests if request.route == "card_draft"]) == drafts + 1
    assert draft.version not in (first["draft_version"], confirmed)
    assert (await stored(engine, state["interview_id"]))["draft_version"] == draft.version
    public = await owner.browser.get(f"/api/owner/setup/{state['interview_id']}/public_lines")
    assert public.status_code == 200, public.text
    assert public.json()["hours"]["windows"] == weekday_hours

    # Real situations are written again for the new draft, not answered from the ones before.
    situations = len([request for request in model.requests if request.route == "situations"])
    model.add(structured(DraftedSituations(situations=SITUATIONS)))
    reply = await owner.browser.post(policy(state, "situations"))
    assert reply.status_code == 200, reply.text
    assert len([request for request in model.requests if request.route == "situations"]) == situations + 1
    assert fake.called("POST /policy/{version}/probe")[-1].path == f"/policy/{draft.version}/probe"

    # The rules aren't confirmed, nor the Desk taken live, until the safety check has run again on the new draft.
    for early in ("confirm", "go_live"):
        refused = await owner.browser.post(policy(state, early))
        assert (refused.status_code, refused.json()["error"]) == (409, "conflict"), early
    assert fake.desks[state["desk_id"]].policy_version == confirmed
    checked = await owner.browser.post(policy(state, "safety_check"))
    assert checked.status_code == 200, checked.text
    assert fake.called("POST /policy/{version}/probe")[-1].path == f"/policy/{draft.version}/probe"
    assert (await owner.browser.post(policy(state, "confirm"))).status_code == 200
    assert fake.desks[state["desk_id"]].policy_version == draft.version
    assert (await owner.browser.post(policy(state, "go_live"))).status_code == 200
    assert fake.desks[state["desk_id"]].answering is True


async def test_a_change_to_a_limit_is_asked_on_the_limits_own_question(app, browser, kernel_http, model, engine):
    # The owner's change names a limit, which the reopened turn can't set: Claude names its topic, and code asks the
    # limit's own question again, in its words and with its choices. The limit comes only from that answer.
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, "situations")
    model.add(turn("I'll ask you about that.", next={"kind": "topic", "topic": "quote_limit"}))
    changed = await reopen(owner, state, "Quotes up to $1,000 can go out without asking me.")
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["step"], body["question"]) == ("questions", "quote_limit")
    assert body["messages"][-1]["text"] == QUESTIONS["quote_limit"]
    assert [choice["text"] for choice in body["messages"][-1]["choices"]] == [
        "Always ask me first", "Up to $250", "Up to $500", "Up to $1,000"]
    assert (await stored(engine, state["interview_id"]))["answers"]["quote_auto_max_cents"] == 50_000

    # Claude then has nothing more to ask: setup closes again.
    reply = await answer(owner, model, state["interview_id"], "Up to $1,000", turn(),
                         next_step("quote_limit", next={"kind": "done"}))
    assert reply.status_code == 200, reply.text
    assert reply.json()["step"] == "tools"
    assert (await stored(engine, state["interview_id"]))["answers"]["quote_auto_max_cents"] == 100_000


async def test_proving_work_from_before_a_change_never_lands_after_it(app, browser, kernel_http, model, engine, fake,
                                                                      monkeypatch):
    # A rules draft still running when the owner reopens the questions: its cards and version are about the answers
    # before, so it stores nothing and doesn't move the interview on; the next draft starts afresh.
    owner, state = await ready(app, browser, kernel_http, model)
    monkeypatch.setattr(proving, "PROVING_WAIT_S", 0.3)
    release = fake.gate("POST /policy/draft")
    model.add(drafted(*GOOD_CARDS))
    pending = await owner.browser.post(policy(state, "rules"))
    assert pending.status_code == 202
    model.add(turn("Closed on Saturdays, noted. Anything else?", step_done=False))
    assert (await reopen(owner, state)).status_code == 200
    release.set()
    work = app.state.runtime.proving
    await until(lambda: all(entry.task is None for entry in work._entries.values()))
    row = await stored(engine, state["interview_id"])
    assert (row["step"], row["draft_version"]) == ("questions", None)


async def test_a_stale_redraft_needs_its_own_safety_check_after_reopening(
        app, browser, kernel_http, model, engine, fake):
    owner, state = await ready(app, browser, kernel_http, model)
    model.add(turn(next={"kind": "done"}))
    model.add(next_step("contact_and_after_hours", next={"kind": "done"}))
    assert (await reopen(owner, state)).status_code == 200
    await at_step(owner, model, state, "safety_check")
    fake.never(state["desk_id"], "native.capture_lead")
    changed = await owner.browser.post(policy(state, "confirm"))
    assert (changed.status_code, changed.json()["error"]) == (409, "rules_changed_since_draft")
    assert (await stored(engine, state["interview_id"]))["step"] == "rules"
    refused = await owner.browser.post(policy(state, "confirm"))
    assert (refused.status_code, refused.json()["error"]) == (409, "conflict")
    assert (await owner.browser.post(policy(state, "safety_check"))).status_code == 200
    assert (await owner.browser.post(policy(state, "confirm"))).status_code == 200


async def test_an_abandoned_reopen_is_recovered_and_the_same_send_can_run_again(
        app, browser, kernel_http, model, engine):
    owner, state = await ready(app, browser, kernel_http, model)
    await at_step(owner, model, state, "situations")
    before = await stored_questions(engine, state["interview_id"])
    staged = [*before["transcript"], setup.Entry(
        role="owner", text=CHANGE, pending="dead-run", reopen_key="abandoned",
        reopen_sha256=setup.reopen_sha256(CHANGE)).model_dump(mode="json")]
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET transcript = CAST(:transcript AS jsonb),"
                               " updated_at = now() - :age * interval '1 second' WHERE interview_id = :id"),
                           {"transcript": json.dumps(staged), "age": setup.TURN_ABANDONED_S + 5,
                            "id": state["interview_id"]})
    model.add(turn("Closed on Saturdays, noted. Anything else?", step_done=False))
    recovered = await reopen(owner, state, key="abandoned")
    assert recovered.status_code == 200 and recovered.json()["step"] == "questions", recovered.text
    assert [message["text"] for message in recovered.json()["messages"]].count(CHANGE) == 1
    row = await stored(engine, state["interview_id"])
    assert row["draft_cards"] == [] and row["draft_version"] is None
