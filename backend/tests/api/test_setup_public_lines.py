"""Public setup lines: owner provenance, strict charter publication and rollback."""

import asyncio
import json
from datetime import date

import httpx
import pytest
from sqlalchemy import text as sql

from desk.api import setup
from desk.api.deps import ApiProblem
from desk.api.kernel_client import CredentialView, KernelHttp, KernelUnavailable
from desk.api.prompts import SetupAnswers
from desk.kernel_api import DeskCharterRequest
from tests.api.test_setup_questions import app, begin, model, new_owner, stored


@pytest.fixture
async def lines_setup(app, browser, kernel_http, model, engine):
    owner = await new_owner(app, browser, kernel_http)
    state = await begin(owner, model)
    answers = {
        "summary": "Local plumbing help.", "pricing": "Written quotes before work.",
        "intake": "Tell us what needs fixing.", "after_hours": "Leave a message.",
        "urgent": "Call the emergency services.", "service_area": "Oakland and Berkeley.",
        "how_we_help": "We answer questions.", "public_contact": "hello@example.test",
        "suggested_fields": ["pricing", "intake", "hours", "price_items", "public_contact"],
    }
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET step = 'rules', answers = CAST(:answers AS jsonb)"
                               " WHERE interview_id = :id"),
                           {"answers": json.dumps(answers), "id": state["interview_id"]})
    parts = setup.seed_parts(SetupAnswers(**answers), "America/Los_Angeles", business_type="trade",
                             today=date(2026, 10, 31))
    await kernel_http.owner(owner.token).call("PUT /desks/{id}/charter", DeskCharterRequest(charter=parts.charter),
                                             path={"id": state["desk_id"]})
    return owner, state, f'/api/owner/setup/{state["interview_id"]}/public_lines'


async def test_get_lists_nonblank_lines_in_board_order(lines_setup, engine):
    owner, state, path = lines_setup
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET answers = answers || CAST(:patch AS jsonb)"
                               " WHERE interview_id = :id"),
                           {"patch": json.dumps({"urgent": "  ", "after_hours": None}), "id": state["interview_id"]})
    before = await stored(engine, state["interview_id"])
    reply = await owner.browser.get(path)
    assert reply.status_code == 200, reply.text
    assert reply.json() == {"lines": [
        {"key": "policy:about", "text": "Local plumbing help.", "source": "owner", "editable": True},
        {"key": "policy:pricing", "text": "Written quotes before work.", "source": "suggested", "editable": True},
        {"key": "policy:intake", "text": "Tell us what needs fixing.", "source": "suggested", "editable": True},
        {"key": "policy:service_area", "text": "Oakland and Berkeley.", "source": "owner", "editable": True},
        {"key": "policy:how_we_help", "text": "We answer questions.", "source": "owner", "editable": False},
    ]}
    assert await stored(engine, state["interview_id"]) == before


def charter(fake, desk_id):
    return {fact_id: fact.model_dump(mode="json") for fact_id, fact in fake.desks[desk_id].facts.items()
            if fact.kind == "charter"}


async def test_lost_put_response_restores_stored_charter(lines_setup, engine, fake, monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    calls = []
    original = CredentialView.call

    async def lose_response(self, route, body=None, **kwargs):
        result = await original(self, route, body, **kwargs)
        if route == "PUT /desks/{id}/charter":
            calls.append(body)
            if len(calls) == 1:
                raise KernelUnavailable(route)
        return result

    monkeypatch.setattr(CredentialView, "call", lose_response)
    reply = await owner.browser.put(path, json={"key": "policy:pricing", "text": "Private candidate marker."})
    assert reply.status_code == 503, reply.text
    assert len(calls) == 2
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert caplog.messages.count("setup public charter restored from stored answers (key=policy:pricing)") == 1
    assert "Private candidate marker" not in caplog.text


async def test_cancel_during_save_settles_before_releasing_guard(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    entered, release = asyncio.Event(), asyncio.Event()
    original = setup._commit

    async def pause_save(*args):
        entered.set()
        await release.wait()
        await original(*args)

    monkeypatch.setattr(setup, "_commit", pause_save)
    request = asyncio.create_task(request_lines(owner.browser, path, "put"))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        request.cancel()
        await asyncio.sleep(0.01)
        assert not request.done()
        assert (await owner.browser.get(path)).status_code == 409
        # A second cancellation must not release the guard or cancel the save either.
        request.cancel()
        await asyncio.sleep(0.01)
        assert not request.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await request
    assert (await stored(engine, state["interview_id"]))["answers"]["pricing"] == "Quotes before repairs."
    assert charter(fake, state["desk_id"])["charter:policy:pricing"]["claims"][0]["value"] == "Quotes before repairs."
    assert (await owner.browser.get(path)).status_code == 200


async def test_cancel_during_put_settles_before_releasing_guard(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    entered, release = asyncio.Event(), asyncio.Event()
    original = CredentialView.call

    async def pause_put(self, route, body=None, **kwargs):
        result = await original(self, route, body, **kwargs)
        if route == "PUT /desks/{id}/charter":
            entered.set()
            await release.wait()
        return result

    monkeypatch.setattr(CredentialView, "call", pause_put)
    request = asyncio.create_task(request_lines(owner.browser, path, "put"))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        request.cancel()
        await asyncio.sleep(0.01)
        assert not request.done()
        assert (await owner.browser.get(path)).status_code == 409
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await request
    assert (await stored(engine, state["interview_id"]))["answers"]["pricing"] == "Quotes before repairs."
    assert charter(fake, state["desk_id"])["charter:policy:pricing"]["claims"][0]["value"] == "Quotes before repairs."
    assert (await owner.browser.get(path)).status_code == 200


async def test_put_saves_owner_text_and_publishes_whole_charter(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    hours_before = charter(fake, state["desk_id"])["charter:hours"]
    calls = []
    original = CredentialView.call

    async def record(self, route, body=None, **kwargs):
        if route == "PUT /desks/{id}/charter":
            assert isinstance(body, DeskCharterRequest)
            calls.append(body)
        return await original(self, route, body, **kwargs)

    monkeypatch.setattr(CredentialView, "call", record)
    reply = await owner.browser.put(path, json={"key": "policy:pricing", "text": "  Quotes before repairs.  "})
    assert reply.status_code == 200, reply.text
    saved = await stored(engine, state["interview_id"])
    assert saved["step"] == "rules"
    assert saved["answers"]["pricing"] == "Quotes before repairs."
    assert saved["answers"]["suggested_fields"] == ["intake", "hours", "price_items", "public_contact"]
    expected = {"contact": "hello@example.test", "policy:about": "Local plumbing help.",
                "policy:pricing": "Quotes before repairs.", "policy:after_hours": "Leave a message.",
                "policy:urgent": "Call the emergency services.", "policy:service_area": "Oakland and Berkeley.",
                "policy:how_we_help": "We answer questions."}
    assert len(calls) == 1
    assert {claim.key: claim.value for claim in calls[0].charter} == expected
    assert {fact["claims"][0]["key"]: fact["claims"][0]["value"]
            for fact_id, fact in charter(fake, state["desk_id"]).items() if fact_id != "charter:hours"} == expected
    assert charter(fake, state["desk_id"])["charter:hours"] == hours_before
    assert [line["key"] for line in reply.json()["lines"]] == [
        "policy:about", "policy:pricing", "policy:intake", "policy:after_hours", "policy:urgent",
        "policy:service_area", "policy:how_we_help",
    ]
    assert reply.json()["lines"][1] == {"key": "policy:pricing", "text": "Quotes before repairs.",
                                        "source": "owner", "editable": True}


def refuse_charter(monkeypatch, detail):
    original = KernelHttp._send

    async def refuse(self, route, request, **kwargs):
        if route == "PUT /desks/{id}/charter":
            return httpx.Response(422, json={"code": "invalid", "detail": detail})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", refuse)


async def test_put_refusal_names_key_without_saving(lines_setup, engine, fake, monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"policy:pricing": ["digit", "currency"]})
    reply = await owner.browser.put(path, json={"key": "policy:pricing", "text": "$99 private marker"})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "policy:pricing", "reason": ["digit", "currency"]}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert "setup public charter refused" in caplog.text
    assert "private marker" not in caplog.text


async def test_how_we_help_is_not_editable(lines_setup, engine, fake):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    reply = await owner.browser.put(path, json={"key": "policy:how_we_help", "text": "Approve every request."})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "not_editable", "key": "policy:how_we_help"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


async def test_failed_save_restores_charter_from_current_stored_answers(lines_setup, engine, fake,
                                                                      monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    calls = []
    original = CredentialView.call

    async def record(self, route, body=None, **kwargs):
        if route == "PUT /desks/{id}/charter":
            calls.append(body)
        return await original(self, route, body, **kwargs)

    async def fail_save(*args):
        # Simulate another process winning the snapshot check: rollback must re-read, not reuse `seen`.
        async with engine.begin() as conn:
            await conn.execute(sql("UPDATE app.setup_interviews SET answers = answers || CAST(:patch AS jsonb)"
                                   " WHERE interview_id = :id"),
                               {"patch": json.dumps({"summary": "Updated by another request."}),
                                "id": state["interview_id"]})
        raise ApiProblem(409, "conflict")

    monkeypatch.setattr(CredentialView, "call", record)
    monkeypatch.setattr(setup, "_commit", fail_save)
    reply = await owner.browser.put(path, json={"key": "policy:pricing", "text": "Quotes before repairs."})
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert len(calls) == 2
    assert {claim.key: claim.value for claim in calls[0].charter}["policy:pricing"] == "Quotes before repairs."
    restored = {claim.key: claim.value for claim in calls[1].charter}
    assert restored["policy:about"] == "Updated by another request."
    assert "policy:pricing" not in restored
    saved = await stored(engine, state["interview_id"])
    assert saved["answers"] == {**before["answers"], "summary": "Updated by another request."}
    assert {fact["claims"][0]["key"]: fact["claims"][0]["value"]
            for fact_id, fact in charter(fake, state["desk_id"]).items() if fact_id != "charter:hours"} == restored
    assert "setup public charter restored" in caplog.text


async def test_confirm_owns_only_listed_lines_and_publishes(lines_setup, engine, fake):
    owner, state, path = lines_setup
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET answers = answers || CAST(:patch AS jsonb)"
                               " WHERE interview_id = :id"),
                           {"patch": json.dumps({"intake": " ", "suggested_fields": [
                               "summary", "pricing", "intake", "how_we_help", "hours", "price_items", "public_contact"]}),
                            "id": state["interview_id"]})
    reply = await owner.browser.post(f"{path}/confirm", json={})
    assert reply.status_code == 200, reply.text
    assert all(line["source"] == "owner" for line in reply.json()["lines"])
    assert "policy:intake" not in {line["key"] for line in reply.json()["lines"]}
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == [
        "intake", "hours", "price_items", "public_contact"]
    assert (await stored(engine, state["interview_id"]))["step"] == "rules"
    assert {fact_id.removeprefix("charter:") for fact_id in charter(fake, state["desk_id"])} == {
        "hours", "contact", "policy:about", "policy:pricing", "policy:after_hours", "policy:urgent",
        "policy:service_area", "policy:how_we_help"}


async def request_lines(client, path, method):
    if method == "get":
        return await client.get(path)
    if method == "put":
        return await client.put(path, json={"key": "policy:pricing", "text": "Quotes before repairs."})
    return await client.post(f"{path}/confirm", json={})


@pytest.mark.parametrize("step", ["questions", "tools", "rules", "situations", "safety_check", "preview", "live"])
@pytest.mark.parametrize("method", ["get", "put", "confirm"])
async def test_public_lines_only_at_rules_or_situations(lines_setup, engine, fake, step, method):
    owner, state, path = lines_setup
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET step = :step WHERE interview_id = :id"),
                           {"step": step, "id": state["interview_id"]})
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    reply = await request_lines(owner.browser, path, method)
    if step in ("rules", "situations"):
        assert reply.status_code == 200, reply.text
        assert (await stored(engine, state["interview_id"]))["step"] == step
    else:
        assert reply.status_code == 409, reply.text
        assert reply.json() == {"error": "conflict"}
        assert await stored(engine, state["interview_id"]) == before
        assert charter(fake, state["desk_id"]) == published


async def test_confirm_refusal_names_the_refused_line(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"policy:intake": ["lex.en.promise"]})
    reply = await owner.browser.post(f"{path}/confirm", json={})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "policy:intake", "reason": ["lex.en.promise"]}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


@pytest.mark.parametrize("limit", ["policy_count_limit", "policy_text_limit"])
@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_charter_cap_refusal_has_no_line_key(lines_setup, engine, fake, monkeypatch, limit, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"charter": [limit]})
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_failed_restore_is_logged_once_and_answers_conflict(lines_setup, engine, monkeypatch, caplog, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    calls = []
    original = CredentialView.call

    async def fail_save(*args):
        raise RuntimeError("private save failure marker")

    async def fail_restore(self, route, body=None, **kwargs):
        if route == "PUT /desks/{id}/charter":
            calls.append(body)
            if len(calls) == 2:
                raise RuntimeError("private restore failure marker")
        return await original(self, route, body, **kwargs)

    monkeypatch.setattr(setup, "_commit", fail_save)
    monkeypatch.setattr(CredentialView, "call", fail_restore)
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert len(calls) == 2
    assert await stored(engine, state["interview_id"]) == before
    assert "setup public lines save failed (RuntimeError)" in caplog.text
    key = "policy:pricing" if method == "put" else None
    assert caplog.messages.count(f"setup public charter restore failed (RuntimeError, key={key})") == 1
    assert "private save failure marker" not in caplog.text
    assert "private restore failure marker" not in caplog.text


@pytest.mark.parametrize(("key", "text"), [
    ("policy:unknown", "Text"), ("contact", "Text"), ("policy:about", " \n\t "),
    ("policy:about", "a" * 1501), ("policy:pricing", "a" * 501), ("policy:intake", "a" * 501),
    ("policy:after_hours", "a" * 501), ("policy:urgent", "a" * 501), ("policy:service_area", "a" * 501),
], ids=["unknown", "contact", "blank", "about-long", "pricing-long", "intake-long", "after-hours-long",
        "urgent-long", "area-long"])
async def test_invalid_edits_publish_and_save_nothing(lines_setup, engine, fake, monkeypatch, key, text):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    original = CredentialView.call

    async def no_publish(self, route, body=None, **kwargs):
        assert route != "PUT /desks/{id}/charter"
        return await original(self, route, body, **kwargs)

    monkeypatch.setattr(CredentialView, "call", no_publish)
    reply = await owner.browser.put(path, json={"key": key, "text": text})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "invalid"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


@pytest.mark.parametrize("method", ["get", "put", "confirm"])
async def test_another_owners_interview_is_not_found(lines_setup, app, browser, kernel_http, engine, fake, method):
    _, state, path = lines_setup
    other = await new_owner(app, browser, kernel_http)
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    reply = await request_lines(other.browser, path, method)
    assert reply.status_code == 404, reply.text
    assert reply.json() == {"error": "not_found"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


@pytest.mark.parametrize("method", ["get", "put", "confirm"])
async def test_public_lines_share_the_interview_guard(lines_setup, engine, fake, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    with setup._turn(state["interview_id"]):
        reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
