"""Public setup lines: owner provenance, strict charter publication and rollback."""

import asyncio
import json
from dataclasses import replace
from datetime import date

import httpx
import pytest
from sqlalchemy import text as sql

from desk.api import setup
from desk.api.kernel_client import CredentialView, KernelFailed, KernelHttp, KernelUnavailable
from desk.api.prompts import SETUP_POLICY_CLAIMS, SUGGESTED_FIELD_NAMES, SetupAnswers
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
    # Start from the publication hold that the incoming setup seeding change also enforces.
    parts = setup.seed_parts(SetupAnswers(**{**answers, "public_contact": ""}), "America/Los_Angeles", business_type="trade",
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
    public = reply.json()
    assert public.pop("revision")
    assert public == {"lines": [{**line, "held": False} for line in [
        {"key": "policy:about", "text": "Local plumbing help.", "source": "owner", "editable": True},
        {"key": "contact", "text": "hello@example.test", "source": "suggested", "editable": True},
        {"key": "policy:pricing", "text": "Written quotes before work.", "source": "suggested", "editable": True},
        {"key": "policy:intake", "text": "Tell us what needs fixing.", "source": "suggested", "editable": True},
        {"key": "policy:service_area", "text": "Oakland and Berkeley.", "source": "owner", "editable": True},
        {"key": "policy:how_we_help", "text": "We answer questions.", "source": "owner", "editable": False},
    ]], "hours": None, "prices": None}
    assert await stored(engine, state["interview_id"]) == before


def test_line_keys_follow_the_setup_claim_map():
    # Board order is the board's own; the keys, their fields and the suggestion names are setup's.
    assert setup.PUBLIC_LINE_KEYS == {"public_contact": "contact", **SETUP_POLICY_CLAIMS}
    assert {*setup.PUBLIC_LINE_KEYS, "hours", "price_items"} == set(SUGGESTED_FIELD_NAMES)


async def patch_answers(engine, state, **patch):
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET answers = answers || CAST(:patch AS jsonb)"
                               " WHERE interview_id = :id"),
                           {"patch": json.dumps(patch), "id": state["interview_id"]})


HOURS = [{"days": ["mon", "tue"], "start": "09:00:00", "end": "17:00:00"}]
PRICES = [{"title": "Visit", "unit_cents": 12500}]


async def test_revision_changes_after_edit_confirm_and_removal(lines_setup):
    owner, _, path = lines_setup
    initial = (await owner.browser.get(path)).json()
    assert isinstance(initial["revision"], str) and initial["revision"]
    assert (await owner.browser.get(path)).json()["revision"] == initial["revision"]
    edited = await owner.browser.put(path, json={"key": "policy:about", "text": "Plumbing repairs."})
    assert edited.status_code == 200, edited.text
    assert edited.json()["revision"] != initial["revision"]
    confirmed = await owner.browser.post(f"{path}/confirm", json={
        "keys": ["policy:pricing"], "revision": edited.json()["revision"]})
    assert confirmed.status_code == 200, confirmed.text
    removed = await owner.browser.delete(f"{path}/policy:intake")
    assert removed.status_code == 200, removed.text
    assert len({result["revision"] for result in (initial, edited.json(), confirmed.json(), removed.json())}) == 4


@pytest.mark.parametrize("suggested", [True, False])
async def test_get_lists_hours_and_prices_with_source(lines_setup, engine, suggested):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES * 3,
                        suggested_fields=["hours", "price_items"] if suggested else [])
    reply = await owner.browser.get(path)
    assert reply.status_code == 200, reply.text
    source = "suggested" if suggested else "owner"
    assert reply.json()["hours"] == {"source": source, "windows": HOURS}
    assert reply.json()["prices"] == {"source": source, "items": [
        {"item_id": item_id, **PRICES[0]} for item_id in ("visit", "visit-2", "visit-3")]}
    assert reply.json()["lines"][1] == {
        "key": "contact", "text": "hello@example.test", "source": "owner", "editable": True, "held": False}


def received_parts(monkeypatch):
    calls = []
    original = KernelHttp._send

    async def record(self, route, request, **kwargs):
        reply = await original(self, route, request, **kwargs)
        if route.startswith("PUT /desks/{id}/"):
            calls.append((route.rsplit("/", 1)[1], json.loads(request.content)))
        return reply

    monkeypatch.setattr(KernelHttp, "_send", record)
    return calls


async def test_other_line_edit_holds_all_unconfirmed_suggestions(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    suggested = ["public_contact", "hours", "price_items", "service_area", "after_hours", "pricing"]
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES, suggested_fields=suggested)
    calls = received_parts(monkeypatch)
    reply = await owner.browser.put(path, json={"key": "policy:intake", "text": "Describe the problem."})
    assert reply.status_code == 200, reply.text
    assert [part for part, _ in calls] == ["charter"]
    claims = {claim["key"]: claim["value"] for claim in calls[0][1]["charter"]}
    assert claims == {"policy:about": "Local plumbing help.", "policy:intake": "Describe the problem.",
                      "policy:urgent": "Call the emergency services.", "policy:how_we_help": "We answer questions."}
    assert "charter:contact" not in charter(fake, state["desk_id"])
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == suggested


async def test_confirm_only_selected_text_leaves_hours_and_prices_held(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    shown = (await owner.browser.get(path)).json()
    calls = received_parts(monkeypatch)
    reply = await owner.browser.post(f"{path}/confirm", json={
        "keys": ["policy:pricing"], "revision": shown["revision"]})
    assert reply.status_code == 200, reply.text
    assert reply.json()["revision"] != shown["revision"]
    assert [part for part, _ in calls] == ["charter"]
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == [
        "intake", "hours", "price_items", "public_contact"]
    desk = fake.desks[state["desk_id"]]
    assert not desk.hours and not desk.prices and not desk.slots
    assert "charter:contact" not in charter(fake, state["desk_id"])
    assert reply.json()["hours"]["source"] == reply.json()["prices"]["source"] == "suggested"


async def test_confirm_stale_revision_conflicts_without_writing(lines_setup, engine, monkeypatch):
    owner, state, path = lines_setup
    shown = (await owner.browser.get(path)).json()
    edited = await owner.browser.put(path, json={"key": "policy:about", "text": "Plumbing repairs."})
    assert edited.status_code == 200, edited.text
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.post(f"{path}/confirm", json={
        "keys": ["policy:pricing"], "revision": shown["revision"]})
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


@pytest.mark.parametrize("keys", [["hours"], ["contact", "hours"]])
async def test_confirm_stale_revision_naming_a_removed_key_conflicts(lines_setup, engine, monkeypatch, keys):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    shown = (await owner.browser.get(path)).json()
    removed = await owner.browser.delete(f"{path}/hours")
    assert removed.status_code == 200, removed.text
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.post(f"{path}/confirm", json={"keys": keys, "revision": shown["revision"]})
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


@pytest.mark.parametrize("keys", [["unknown"], ["hours"], ["prices"], ["policy:intake"], ["contact"]])
async def test_confirm_unknown_or_unlisted_key_is_invalid(lines_setup, engine, monkeypatch, keys):
    owner, state, path = lines_setup
    await patch_answers(engine, state, intake="", public_contact="")
    shown = (await owner.browser.get(path)).json()
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.post(f"{path}/confirm", json={"keys": keys, "revision": shown["revision"]})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "invalid"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


@pytest.mark.parametrize("body", [None, {}, {"keys": ["contact"]}, {"revision": "current"},
    {"keys": [], "revision": "current"}, {"keys": ["contact"], "revision": ""},
    {"keys": ["contact"], "revision": "   "}, {"keys": None, "revision": "current"},
    {"keys": [1], "revision": "current"}, {"keys": ["contact"], "revision": 1}])
async def test_confirm_requires_nonempty_keys_and_revision(lines_setup, engine, monkeypatch, body):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.post(f"{path}/confirm", **({"json": body} if body is not None else {}))
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "invalid"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


async def test_confirm_only_hours_and_prices_publishes_them(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    calls = received_parts(monkeypatch)
    reply = await confirm_shown(owner.browser, path, ["hours", "prices"])
    assert reply.status_code == 200, reply.text
    assert [part for part, _ in calls] == ["charter", "hours", "calendar", "prices"]
    assert reply.json()["hours"]["source"] == reply.json()["prices"]["source"] == "owner"
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == [
        "pricing", "intake", "public_contact"]
    desk = fake.desks[state["desk_id"]]
    assert desk.hours and desk.prices and desk.slots
    assert "charter:contact" not in charter(fake, state["desk_id"])


async def test_confirm_publishes_suggested_contact_hours_calendar_and_prices(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    calls = received_parts(monkeypatch)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 200, reply.text
    assert [part for part, _ in calls] == ["charter", "hours", "calendar", "prices"]
    parts = dict(calls)
    assert {claim["key"]: claim["value"] for claim in parts["charter"]["charter"]}["contact"] == "hello@example.test"
    assert parts["hours"] == {"hours": HOURS}
    expected = setup.seed_parts(SetupAnswers(summary="Local plumbing help.", hours=HOURS, price_items=PRICES), "America/Los_Angeles",
                                business_type="trade", today=date(2026, 10, 31))
    assert parts["calendar"] == {"calendar_slots": [slot.model_dump(mode="json") for slot in expected.calendar]}
    assert parts["prices"] == {"price_items": [{"item_id": "visit", **PRICES[0]}]}
    assert fake.desks[state["desk_id"]].hours == expected.hours
    assert list(fake.desks[state["desk_id"]].prices.values()) == expected.prices
    assert reply.json()["hours"]["source"] == reply.json()["prices"]["source"] == "owner"
    assert all(line["source"] == "owner" for line in reply.json()["lines"])
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == []
    calls.clear()
    again = await confirm_shown(owner.browser, path)
    assert again.status_code == 200, again.text
    assert [part for part, _ in calls] == ["charter"]


@pytest.mark.parametrize(("suggested", "parts"), [
    (["hours"], ["charter", "hours", "calendar"]), (["price_items"], ["charter", "prices"]),
])
async def test_confirm_publishes_only_changed_fact_parts(lines_setup, engine, monkeypatch, suggested, parts):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES, suggested_fields=suggested)
    calls = received_parts(monkeypatch)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 200, reply.text
    assert [part for part, _ in calls] == parts
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == []


async def test_confirm_leaves_unlisted_empty_suggested_parts_held(lines_setup, engine, monkeypatch):
    owner, state, path = lines_setup
    calls = received_parts(monkeypatch)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 200, reply.text
    assert [part for part, _ in calls] == ["charter"]
    assert reply.json()["hours"] is reply.json()["prices"] is None
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == ["hours", "price_items"]


async def test_delete_suggested_prices_clears_answers_without_publishing_them(lines_setup, engine, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices")
    assert reply.status_code == 200, reply.text
    assert reply.json()["prices"] is None
    assert reply.json()["hours"] == {"source": "suggested", "windows": HOURS}
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers["price_items"] == []
    assert "price_items" not in answers["suggested_fields"]
    assert [part for part, _ in calls] == ["charter", "prices"]
    assert dict(calls)["prices"] == {"price_items": []}
    assert "contact" not in {claim["key"] for claim in calls[0][1]["charter"]}


@pytest.mark.parametrize(("key", "field", "value"), [("hours", "hours", HOURS), ("prices", "price_items", PRICES)])
async def test_delete_republishes_after_failed_confirm_repair(lines_setup, engine, fake, monkeypatch, key, field, value):
    owner, state, path = lines_setup
    await patch_answers(engine, state, **{field: value})
    before = await stored(engine, state["interview_id"])
    original = CredentialView.call
    lost = False
    lost_part = "calendar" if key == "hours" else key

    async def lose_and_fail_repair(self, route, body=None, **kwargs):
        nonlocal lost
        if lost and route.startswith("PUT /desks/{id}/"):
            raise KernelUnavailable(route)
        result = await original(self, route, body, **kwargs)
        if route == f"PUT /desks/{{id}}/{lost_part}":
            lost = True
            raise KernelUnavailable(route)
        return result

    monkeypatch.setattr(CredentialView, "call", lose_and_fail_repair)
    failed = await confirm_shown(owner.browser, path)
    assert failed.status_code == 503, failed.text
    assert await stored(engine, state["interview_id"]) == before
    desk = fake.desks[state["desk_id"]]
    assert getattr(desk, key)
    if key == "hours":
        assert desk.slots
    monkeypatch.setattr(CredentialView, "call", original)
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/{key}")
    assert reply.status_code == 200, reply.text
    assert reply.json()[key] is None
    assert (await stored(engine, state["interview_id"]))["answers"][field] == []
    assert [part for part, _ in calls] == (["charter", "hours", "calendar"] if key == "hours" else ["charter", key])
    assert dict(calls)[key] == {field: []}
    if key == "hours":
        assert dict(calls)["calendar"] == {"calendar_slots": []}
        assert desk.slots == {}
    assert not getattr(desk, key)


async def test_delete_one_suggested_price_preserves_other_suggestions(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    prices = [*PRICES, {"title": "Repair", "unit_cents": 20000}, {"title": "Inspection", "unit_cents": 6000}]
    await patch_answers(engine, state, hours=HOURS, price_items=prices)
    before = (await owner.browser.get(path)).json()
    suggested = (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"]
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/repair", params=prices[1])
    assert reply.status_code == 200, reply.text
    assert reply.json()["revision"] != before["revision"]
    assert reply.json() == {**before, "revision": reply.json()["revision"], "prices": {"source": "suggested", "items": [
        {"item_id": "visit", **prices[0]}, {"item_id": "inspection", **prices[2]}]}}
    saved = await stored(engine, state["interview_id"])
    assert saved["answers"]["price_items"] == [prices[0], prices[2]]
    assert saved["answers"]["suggested_fields"] == suggested
    assert saved["step"] == "rules"
    assert [part for part, _ in calls] == ["charter", "prices"]
    assert dict(calls)["prices"] == {"price_items": []}
    assert "contact" not in {claim["key"] for claim in calls[0][1]["charter"]}
    assert fake.desks[state["desk_id"]].prices == {}


async def test_delete_shifted_duplicate_price_conflicts_without_writing(lines_setup, engine, monkeypatch):
    owner, state, path = lines_setup
    prices = [{"title": "review", "unit_cents": amount} for amount in (25000, 60000, 15000)]
    await patch_answers(engine, state, price_items=prices)
    shown = (await owner.browser.get(path)).json()
    assert [item["item_id"] for item in shown["prices"]["items"]] == ["review", "review-2", "review-3"]
    removed = await owner.browser.delete(f"{path}/prices/review", params=prices[0])
    assert removed.status_code == 200, removed.text
    assert removed.json()["revision"] != shown["revision"]
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/review-2", params=prices[1])
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert (await owner.browser.get(path)).json() == removed.json()
    assert calls == []


@pytest.mark.parametrize("params", [{}, {"title": "Visit"}, {"unit_cents": 12500},
    {"title": "", "unit_cents": 12500}, {"title": "   ", "unit_cents": 12500},
    {"title": "x" * 81, "unit_cents": 12500}, {"title": "Visit", "unit_cents": ""},
    {"title": "Visit", "unit_cents": "abc"}, {"title": "Visit", "unit_cents": "12.5"},
    {"title": "Visit", "unit_cents": -1}, {"title": "Visit", "unit_cents": 1000001}])
async def test_delete_price_requires_valid_title_and_amount(lines_setup, engine, monkeypatch, params):
    owner, state, path = lines_setup
    await patch_answers(engine, state, price_items=PRICES)
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/visit", params=params)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "invalid"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


@pytest.mark.parametrize("params", [{"title": "visit", "unit_cents": 12500},
                                   {"title": "Visit", "unit_cents": 12501}])
async def test_delete_price_requires_exact_title_and_amount(lines_setup, engine, monkeypatch, params):
    owner, state, path = lines_setup
    await patch_answers(engine, state, price_items=PRICES)
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/visit", params=params)
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


async def test_delete_last_suggested_price_clears_list_and_provenance(lines_setup, engine, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, price_items=PRICES)
    before = (await owner.browser.get(path)).json()
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/visit", params=PRICES[0])
    assert reply.status_code == 200, reply.text
    assert reply.json()["revision"] != before["revision"]
    assert reply.json() == {**before, "revision": reply.json()["revision"], "prices": None}
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers["price_items"] == []
    assert answers["suggested_fields"] == ["pricing", "intake", "hours", "public_contact"]
    assert [part for part, _ in calls] == ["charter", "prices"]
    assert dict(calls)["prices"] == {"price_items": []}


@pytest.mark.parametrize("keep_remaining", [True, False])
async def test_delete_stale_price_id_conflicts_without_writing(lines_setup, engine, monkeypatch, keep_remaining):
    owner, state, path = lines_setup
    prices = [*PRICES, {"title": "Inspection", "unit_cents": 6000}] if keep_remaining else PRICES
    await patch_answers(engine, state, price_items=prices)
    removed = await owner.browser.delete(f"{path}/prices/visit", params=PRICES[0])
    assert removed.status_code == 200, removed.text
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/visit", params=PRICES[0])
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


async def test_delete_one_owner_price_is_not_suggested(lines_setup, engine, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, price_items=PRICES, suggested_fields=["hours"])
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/prices/visit", params=PRICES[0])
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "not_suggested", "key": "prices"}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


async def test_cancel_price_removal_settles_before_releasing_guard(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, price_items=PRICES)
    entered, release = asyncio.Event(), asyncio.Event()
    original = CredentialView.call

    async def pause_prices(self, route, body=None, **kwargs):
        result = await original(self, route, body, **kwargs)
        if route == "PUT /desks/{id}/prices":
            entered.set()
            await release.wait()
        return result

    monkeypatch.setattr(CredentialView, "call", pause_prices)
    request = asyncio.create_task(owner.browser.delete(f"{path}/prices/visit", params=PRICES[0]))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        request.cancel()
        await asyncio.sleep(0.01)
        assert not request.done()
        assert (await owner.browser.get(path)).status_code == 409
        request.cancel()
        await asyncio.sleep(0.01)
        assert not request.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await request
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers["price_items"] == []
    assert "price_items" not in answers["suggested_fields"]
    assert "public_contact" in answers["suggested_fields"]
    assert fake.desks[state["desk_id"]].prices == {}
    assert (await owner.browser.get(path)).status_code == 200


async def test_contact_edit_confirms_and_publishes_with_a_200_character_limit(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    too_long = await owner.browser.put(path, json={"key": "contact", "text": "a" * 201})
    assert too_long.status_code == 422, too_long.text
    assert too_long.json() == {"error": "invalid"}
    assert calls == []
    assert await stored(engine, state["interview_id"]) == before
    blank = await owner.browser.put(path, json={"key": "contact", "text": " \n\t "})
    assert blank.status_code == 422, blank.text
    assert calls == []
    text = "https://plumbing.example/" + "a" * 175   # a valid public contact at the 200-character limit
    assert len(text) == 200
    reply = await owner.browser.put(path, json={"key": "contact", "text": f"  {text}  "})
    assert reply.status_code == 200, reply.text
    assert reply.json()["lines"][1] == {"key": "contact", "text": text, "source": "owner", "editable": True,
                                        "held": False}
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers["public_contact"] == text
    assert "public_contact" not in answers["suggested_fields"]
    assert [part for part, _ in calls] == ["charter"]
    assert {claim["key"]: claim["value"] for claim in calls[0][1]["charter"]}["contact"] == text
    assert charter(fake, state["desk_id"])["charter:contact"]["claims"][0]["value"] == text


async def test_calendar_conflict_repairs_earlier_parts_without_saving(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    before = await stored(engine, state["interview_id"])
    original = KernelHttp._send
    conflicted = False
    calls = []

    async def conflict_once(self, route, request, **kwargs):
        nonlocal conflicted
        if route.startswith("PUT /desks/{id}/"):
            calls.append((route.rsplit("/", 1)[1], json.loads(request.content)))
        if route == "PUT /desks/{id}/calendar" and not conflicted:
            conflicted = True
            return httpx.Response(409, json={"code": "conflict", "detail": {"slot_spoken_for": []}})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", conflict_once)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "kernel", "code": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert fake.desks[state["desk_id"]].hours == []
    assert "charter:contact" not in charter(fake, state["desk_id"])
    assert [part for part, _ in calls] == ["charter", "hours", "calendar"] * 2
    assert dict(calls[3:])["hours"] == {"hours": []}
    assert dict(calls[3:])["calendar"] == {"calendar_slots": []}


@pytest.mark.parametrize(("part", "key"), [("hours", "hours"), ("calendar", "hours"), ("prices", "prices")])
async def test_part_refusal_names_item_and_repairs_only_sent_parts(lines_setup, engine, fake, monkeypatch, part, key):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    # A calendar the attempt never reaches must survive an hours refusal.
    slot = {"slot_id": "S-20261102-1230", "starts_at": "2026-11-02T12:30:00-08:00", "minutes": 30}
    if part == "hours":
        reply = await owner.browser.put(f'/api/owner/desks/{state["desk_id"]}/calendar',
                                        json={"calendar_slots": [slot]})
        assert reply.status_code == 200, reply.text
    before = await stored(engine, state["interview_id"])
    calls = []
    original = KernelHttp._send
    refused = False

    async def refuse_once(self, route, request, **kwargs):
        nonlocal refused
        if route.startswith("PUT /desks/{id}/"):
            calls.append((route.rsplit("/", 1)[1], json.loads(request.content)))
            if route == f"PUT /desks/{{id}}/{part}" and not refused:
                refused = True
                return httpx.Response(422, json={"code": "invalid"})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", refuse_once)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": key}
    assert await stored(engine, state["interview_id"]) == before
    sent = ["charter", "hours", "calendar", "prices"]
    sent = sent[:sent.index(part) + 1]
    assert [name for name, _ in calls] == sent * 2
    restored = dict(calls[len(sent):])
    assert "contact" not in {claim["key"] for claim in restored["charter"]["charter"]}
    assert restored["hours"] == {"hours": []}
    if "calendar" in sent:
        assert restored["calendar"] == {"calendar_slots": []}
    if "prices" in sent:
        assert restored["prices"] == {"price_items": []}
    desk = fake.desks[state["desk_id"]]
    assert desk.hours == [] and desk.prices == {}
    assert set(desk.slots) == ({slot["slot_id"]} if part == "hours" else set())
    assert "charter:contact" not in charter(fake, state["desk_id"])


@pytest.mark.parametrize(("key", "error"), [
    ("contact", "not_suggested"), ("hours", "not_suggested"), ("prices", "not_suggested"),
    ("policy:about", "not_suggested"), ("policy:how_we_help", "not_editable"), ("unknown", "invalid"),
])
async def test_delete_rejects_owner_readonly_and_unknown_items(lines_setup, engine, monkeypatch, key, error):
    owner, state, path = lines_setup
    await patch_answers(engine, state, suggested_fields=["how_we_help"])
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/{key}")
    assert reply.status_code == 422, reply.text
    assert reply.json() == ({"error": error} if error == "invalid" else {"error": error, "key": key})
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


@pytest.mark.parametrize(("key", "field", "empty"), [
    ("contact", "public_contact", ""), ("hours", "hours", []), ("policy:pricing", "pricing", ""),
])
async def test_delete_clears_other_suggested_items(lines_setup, engine, monkeypatch, key, field, empty):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS)
    calls = received_parts(monkeypatch)
    reply = await owner.browser.delete(f"{path}/{key}")
    assert reply.status_code == 200, reply.text
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers[field] == empty
    assert field not in answers["suggested_fields"]
    assert key not in {line["key"] for line in reply.json()["lines"]}
    if key == "hours":
        assert reply.json()["hours"] is None
    assert [part for part, _ in calls] == (["charter", "hours", "calendar"] if key == "hours" else ["charter"])
    if key == "hours":
        assert dict(calls)["hours"] == {"hours": []}
        assert dict(calls)["calendar"] == {"calendar_slots": []}
    assert "contact" not in {claim["key"] for claim in calls[0][1]["charter"]}


async def test_contact_refusal_names_contact_without_saving(lines_setup, engine, fake, monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"contact": ["lex.en.promise"]})
    reply = await owner.browser.put(path, json={"key": "contact", "text": "Private contact marker."})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "contact", "reason": ["lex.en.promise"]}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=contact)")
    assert "Private contact marker" not in caplog.text


async def test_confirm_save_conflict_repairs_same_parts_from_current_answers(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    calls = []
    original = KernelHttp._send
    current_hours = [{"days": ["fri"], "start": "10:00:00", "end": "11:00:00"}]
    current_prices = [{"title": "Consultation", "unit_cents": 2000}]

    async def competing_save(self, route, request, **kwargs):
        reply = await original(self, route, request, **kwargs)
        if route.startswith("PUT /desks/{id}/"):
            calls.append((route.rsplit("/", 1)[1], json.loads(request.content)))
            if len(calls) == 4:
                await patch_answers(engine, state, hours=current_hours, price_items=current_prices,
                                    public_contact="owner@example.test", suggested_fields=[])
        return reply

    monkeypatch.setattr(KernelHttp, "_send", competing_save)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 409, reply.text
    assert [part for part, _ in calls] == ["charter", "hours", "calendar", "prices"] * 2
    restored = dict(calls[-4:])
    assert restored["hours"] == {"hours": current_hours}
    assert restored["prices"] == {"price_items": [{"item_id": "consultation", **current_prices[0]}]}
    assert {claim["key"]: claim["value"] for claim in restored["charter"]["charter"]}["contact"] == "owner@example.test"
    expected_calendar = setup.calendar_slots(SetupAnswers(summary="", hours=current_hours).hours,
                                              "America/Los_Angeles", date(2026, 10, 31))
    assert restored["calendar"] == {"calendar_slots": [slot.model_dump(mode="json") for slot in expected_calendar]}
    assert fake.desks[state["desk_id"]].hours == SetupAnswers(summary="", hours=current_hours).hours
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers["public_contact"] == "owner@example.test"
    assert answers["price_items"] == current_prices


@pytest.mark.parametrize("part", ["hours", "calendar", "prices"])
async def test_lost_part_response_repairs_same_parts_under_guard(lines_setup, engine, fake, monkeypatch, part):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    before = await stored(engine, state["interview_id"])
    calls = []
    original = CredentialView.call
    lost = False

    async def lose_response(self, route, body=None, **kwargs):
        nonlocal lost
        result = await original(self, route, body, **kwargs)
        if route.startswith("PUT /desks/{id}/"):
            calls.append((route.rsplit("/", 1)[1], body.model_dump(mode="json")))
            assert state["interview_id"] in setup._RUNNING
            if route == f"PUT /desks/{{id}}/{part}" and not lost:
                lost = True
                raise KernelUnavailable(route)
        return result

    monkeypatch.setattr(CredentialView, "call", lose_response)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 503, reply.text
    assert await stored(engine, state["interview_id"]) == before
    sent = ["charter", "hours", "calendar", "prices"]
    sent = sent[:sent.index(part) + 1]
    assert [name for name, _ in calls] == sent * 2
    restored = dict(calls[len(sent):])
    assert restored["hours"] == {"hours": []}
    if "calendar" in sent:
        assert restored["calendar"] == {"calendar_slots": []}
    if "prices" in sent:
        assert restored["prices"] == {"price_items": []}
    assert "contact" not in {claim["key"] for claim in restored["charter"]["charter"]}
    desk = fake.desks[state["desk_id"]]
    assert desk.hours == [] and desk.slots == {} and desk.prices == {}
    assert (await owner.browser.get(path)).status_code == 200


async def test_lost_prices_response_allows_time_for_every_repair_part(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    before = await stored(engine, state["interview_id"])
    calls = []
    original = CredentialView.call
    lost = False

    async def slow_repair(self, route, body=None, **kwargs):
        nonlocal lost
        if route.startswith("PUT /desks/{id}/"):
            if lost:
                await asyncio.sleep(0.4)
            calls.append((route.rsplit("/", 1)[1], body.model_dump(mode="json")))
        result = await original(self, route, body, **kwargs)
        if route == "PUT /desks/{id}/prices" and not lost:
            lost = True
            raise KernelUnavailable(route)
        return result

    monkeypatch.setattr(CredentialView, "call", slow_repair)
    monkeypatch.setattr(setup, "PUBLIC_PARTS_REPAIR_TIMEOUT_S", 1)
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 503, reply.text
    assert await stored(engine, state["interview_id"]) == before
    assert fake.desks[state["desk_id"]].prices == {}
    assert [part for part, _ in calls] == ["charter", "hours", "calendar", "prices"] * 2
    assert dict(calls[4:])["prices"] == {"price_items": []}
    assert state["interview_id"] not in setup._RUNNING


def charter(fake, desk_id):
    return {fact_id: fact.model_dump(mode="json") for fact_id, fact in fake.desks[desk_id].facts.items()
            if fact.kind == "charter"}


def assert_public_parts_logs(caplog, *messages):
    # Exact messages prove each outcome is logged once, using keys rather than any claim text.
    assert [message for message in caplog.messages if message.startswith("setup public parts")] == list(messages)


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
    assert_public_parts_logs(caplog, "setup public parts restored from stored answers (key=policy:pricing)")
    assert "Private candidate marker" not in caplog.text


@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_uncertain_put_repair_times_out_and_releases_guard(lines_setup, engine, monkeypatch, caplog, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    calls = []
    original = CredentialView.call

    async def hang_repair(self, route, body=None, **kwargs):
        if route == "PUT /desks/{id}/charter":
            calls.append(body)
            if len(calls) == 2:
                await asyncio.Event().wait()
            await original(self, route, body, **kwargs)
            raise KernelUnavailable(route)
        return await original(self, route, body, **kwargs)

    monkeypatch.setattr(CredentialView, "call", hang_repair)
    monkeypatch.setattr(setup, "PUBLIC_PARTS_REPAIR_TIMEOUT_S", 1)
    reply = await asyncio.wait_for(request_lines(owner.browser, path, method), 5)
    assert reply.status_code == 503, reply.text
    assert len(calls) == 2
    assert await stored(engine, state["interview_id"]) == before
    key = "policy:pricing" if method == "put" else None
    assert_public_parts_logs(caplog, f"setup public parts restore failed (TimeoutError, key={key})")
    assert "Quotes before repairs." not in caplog.text
    assert "We answer questions." not in caplog.text
    assert (await owner.browser.get(path)).status_code == 200


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


@pytest.mark.parametrize("part", ["charter", "hours", "calendar", "prices"])
async def test_cancel_during_put_settles_before_releasing_guard(lines_setup, engine, fake, monkeypatch, part):
    owner, state, path = lines_setup
    if part != "charter":
        await patch_answers(engine, state, hours=HOURS, price_items=PRICES)
    entered, release = asyncio.Event(), asyncio.Event()
    original = CredentialView.call

    async def pause_put(self, route, body=None, **kwargs):
        result = await original(self, route, body, **kwargs)
        if route == f"PUT /desks/{{id}}/{part}":
            entered.set()
            await release.wait()
        return result

    monkeypatch.setattr(CredentialView, "call", pause_put)
    request = asyncio.create_task(request_lines(owner.browser, path, "put" if part == "charter" else "confirm"))
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
    pricing = "Quotes before repairs." if part == "charter" else "Written quotes before work."
    answers = (await stored(engine, state["interview_id"]))["answers"]
    assert answers["pricing"] == pricing
    assert charter(fake, state["desk_id"])["charter:policy:pricing"]["claims"][0]["value"] == pricing
    if part != "charter":
        assert answers["suggested_fields"] == []
        assert fake.desks[state["desk_id"]].hours == SetupAnswers(summary="", hours=HOURS).hours
        assert [item.title for item in fake.desks[state["desk_id"]].prices.values()] == ["Visit"]
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
    expected = {"policy:about": "Local plumbing help.",
                "policy:pricing": "Quotes before repairs.", "policy:after_hours": "Leave a message.",
                "policy:urgent": "Call the emergency services.", "policy:service_area": "Oakland and Berkeley.",
                "policy:how_we_help": "We answer questions."}
    assert len(calls) == 1
    assert {claim.key: claim.value for claim in calls[0].charter} == expected
    assert {fact["claims"][0]["key"]: fact["claims"][0]["value"]
            for fact_id, fact in charter(fake, state["desk_id"]).items() if fact_id != "charter:hours"} == expected
    assert charter(fake, state["desk_id"])["charter:hours"] == hours_before
    assert [line["key"] for line in reply.json()["lines"]] == [
        "policy:about", "contact", "policy:pricing", "policy:intake", "policy:after_hours", "policy:urgent",
        "policy:service_area", "policy:how_we_help",
    ]
    assert reply.json()["lines"][2] == {"key": "policy:pricing", "text": "Quotes before repairs.",
                                        "source": "owner", "editable": True, "held": False}


def refuse_charter(monkeypatch, detail):
    original = KernelHttp._send

    async def refuse(self, route, request, **kwargs):
        if route == "PUT /desks/{id}/charter":
            return httpx.Response(422, json={"code": "invalid", "detail": detail})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", refuse)


@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_refused_how_we_help_is_dropped_for_pricing(lines_setup, engine, fake, monkeypatch, caplog, method):
    owner, state, path = lines_setup
    calls = []
    original = KernelHttp._send

    async def refuse_help(self, route, request, **kwargs):
        if route == "PUT /desks/{id}/charter":
            claims = json.loads(request.content)["charter"]
            calls.append({claim["key"]: claim["value"] for claim in claims})
            if "policy:how_we_help" in calls[-1]:
                return httpx.Response(422, json={"code": "invalid", "detail": {
                    "policy:how_we_help": ["lex.en.promise"]}})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", refuse_help)
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 200, reply.text
    assert len(calls) == 2
    assert calls[1] == {key: value for key, value in calls[0].items() if key != "policy:how_we_help"}
    pricing = "Quotes before repairs." if method == "put" else "Written quotes before work."
    assert calls[1]["policy:pricing"] == pricing
    assert "charter:policy:how_we_help" not in charter(fake, state["desk_id"])
    assert (await stored(engine, state["interview_id"]))["answers"]["pricing"] == pricing
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:how_we_help)")
    assert "We answer questions." not in caplog.text


@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_mixed_help_refusal_keeps_editable_line_strict(lines_setup, engine, fake, monkeypatch, caplog, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    calls = []
    original = KernelHttp._send

    async def refuse_mixed(self, route, request, **kwargs):
        if route == "PUT /desks/{id}/charter":
            calls.append(request)
            return httpx.Response(422, json={"code": "invalid", "detail": {
                "policy:how_we_help": ["digit"], "policy:pricing": ["currency"]}})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", refuse_mixed)
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "policy:pricing", "reason": ["currency"]}
    assert len(calls) == 1
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:pricing)")
    assert "We answer questions." not in caplog.text
    assert "Quotes before repairs." not in caplog.text


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
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:pricing)")
    assert "private marker" not in caplog.text


def refused_charter_entries(fake, desk_id):
    return [entry.event.summary for entry in fake.desks[desk_id].ledger
            if entry.event.kind == "desk_data" and entry.event.summary.get("refused")]


async def test_kernel_scan_refuses_the_owners_edit_strictly(lines_setup, engine, fake, monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.put(path, json={"key": "policy:pricing", "text": "Repairs from 99 private marker."})
    assert reply.status_code == 422, reply.text
    refused = reply.json()
    assert (refused["error"], refused["key"]) == ("line_refused", "policy:pricing")
    assert "digit" in refused["reason"]
    # One write, refused and signed by the kernel; nothing dropped and sent again.
    assert [part for part, _ in calls] == ["charter"]
    assert refused_charter_entries(fake, state["desk_id"]) == [
        {"part": "charter", "refused": "promise", "fields": {"policy:pricing": refused["reason"]}}]
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:pricing)")
    assert "private marker" not in caplog.text


async def hold_keys(engine, owner, state, keys):
    """The charter keys the kernel held at the first rules draft, as that write records them."""
    async with engine.begin() as conn:
        interview = await setup._load(conn, owner.copy_id, state["interview_id"])
        interview.hold_policies(keys)
        await setup._save(conn, interview)


async def held_keys(owner, state):
    return (await owner.browser.get(f'/api/owner/setup/{state["interview_id"]}')).json()["held_policy_keys"]


async def test_held_lines_are_marked_and_part_of_the_revision(lines_setup, engine):
    owner, state, path = lines_setup
    shown = (await owner.browser.get(path)).json()
    assert [line["held"] for line in shown["lines"]] == [False] * len(shown["lines"])
    await hold_keys(engine, owner, state, ["policy:after_hours", "contact"])
    before = await stored(engine, state["interview_id"])
    held = (await owner.browser.get(path)).json()
    assert held["revision"] != shown["revision"]
    # The stored words and their source stay as they were; a held contact is marked like a held policy line.
    assert held["lines"] == [{**line, "held": line["key"] in ("policy:after_hours", "contact")}
                             for line in shown["lines"]]
    assert await stored(engine, state["interview_id"]) == before


@pytest.mark.parametrize("method", ["put", "confirm", "delete"])
async def test_every_write_leaves_held_lines_out_of_the_charter(lines_setup, engine, fake, monkeypatch, method):
    owner, state, path = lines_setup
    await patch_answers(engine, state, suggested_fields=["pricing", "intake"])
    await hold_keys(engine, owner, state, ["policy:after_hours", "contact"])
    calls = received_parts(monkeypatch)
    if method == "put":
        reply = await owner.browser.put(path, json={"key": "policy:intake", "text": "Describe the problem."})
    elif method == "confirm":
        reply = await confirm_shown(owner.browser, path, ["policy:pricing"])
    else:
        reply = await owner.browser.delete(f"{path}/policy:intake")
    assert reply.status_code == 200, reply.text
    (sent,) = [body["charter"] for part, body in calls if part == "charter"]
    # Pricing is still suggested unless confirmed; after hours and the contact are held.
    assert {claim["key"] for claim in sent} == {
        "policy:about", "policy:urgent", "policy:service_area", "policy:how_we_help",
        *({"put": ["policy:intake"], "confirm": ["policy:pricing"]}.get(method, []))}
    assert "charter:policy:after_hours" not in charter(fake, state["desk_id"])
    assert "charter:contact" not in charter(fake, state["desk_id"])
    assert await held_keys(owner, state) == ["policy:after_hours", "contact"]
    assert [line["key"] for line in reply.json()["lines"] if line["held"]] == ["contact", "policy:after_hours"]


async def test_rewording_a_held_contact_publishes_it_and_clears_its_hold(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await hold_keys(engine, owner, state, ["contact", "policy:urgent"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.put(path, json={"key": "contact", "text": "help@plumbing.example"})
    assert reply.status_code == 200, reply.text
    (sent,) = [body["charter"] for part, body in calls if part == "charter"]
    claims = {claim["key"]: claim["value"] for claim in sent}
    assert claims["contact"] == "help@plumbing.example"
    assert "policy:urgent" not in claims
    assert charter(fake, state["desk_id"])["charter:contact"]["claims"][0]["value"] == "help@plumbing.example"
    assert await held_keys(owner, state) == ["policy:urgent"]
    assert {line["key"]: line["held"] for line in reply.json()["lines"]
            if line["key"] in ("contact", "policy:urgent")} == {"contact": False, "policy:urgent": True}


async def test_rewording_a_held_line_publishes_it_and_clears_its_hold(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await hold_keys(engine, owner, state, ["policy:after_hours", "policy:urgent"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.put(path, json={"key": "policy:after_hours", "text": "Leave a voicemail."})
    assert reply.status_code == 200, reply.text
    (sent,) = [body["charter"] for part, body in calls if part == "charter"]
    claims = {claim["key"]: claim["value"] for claim in sent}
    assert claims["policy:after_hours"] == "Leave a voicemail."
    assert "policy:urgent" not in claims
    assert charter(fake, state["desk_id"])["charter:policy:after_hours"]["claims"][0]["value"] == "Leave a voicemail."
    assert await held_keys(owner, state) == ["policy:urgent"]
    assert {line["key"]: line["held"] for line in reply.json()["lines"]
            if line["key"] in ("policy:after_hours", "policy:urgent")} == {
        "policy:after_hours": False, "policy:urgent": True}


async def test_a_refused_rewording_stays_held(lines_setup, engine, fake):
    owner, state, path = lines_setup
    await hold_keys(engine, owner, state, ["policy:after_hours"])
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    reply = await owner.browser.put(path, json={"key": "policy:after_hours", "text": "Call after 6 tonight."})
    assert reply.status_code == 422, reply.text
    assert reply.json()["key"] == "policy:after_hours"
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert await held_keys(owner, state) == ["policy:after_hours"]


async def test_a_repair_after_rewording_a_held_line_leaves_it_out(lines_setup, engine, fake, monkeypatch):
    owner, state, path = lines_setup
    await hold_keys(engine, owner, state, ["policy:after_hours"])
    calls = []
    original = CredentialView.call

    async def record(self, route, body=None, **kwargs):
        result = await original(self, route, body, **kwargs)
        if route == "PUT /desks/{id}/charter":
            calls.append({claim.key: claim.value for claim in body.charter})
            if len(calls) == 1:
                await patch_answers(engine, state, summary="Updated by another request.")
        return result

    monkeypatch.setattr(CredentialView, "call", record)
    reply = await owner.browser.put(path, json={"key": "policy:after_hours", "text": "Leave a voicemail."})
    assert reply.status_code == 409, reply.text
    assert [claims.get("policy:after_hours") for claims in calls] == ["Leave a voicemail.", None]
    assert calls[1]["policy:about"] == "Updated by another request."
    assert "charter:policy:after_hours" not in charter(fake, state["desk_id"])
    assert await held_keys(owner, state) == ["policy:after_hours"]


@pytest.mark.parametrize("held", ["policy:pricing", "contact"])
async def test_confirm_with_a_held_key_is_refused_without_writing(lines_setup, engine, monkeypatch, held):
    owner, state, path = lines_setup
    await hold_keys(engine, owner, state, [held])
    shown = (await owner.browser.get(path)).json()
    before = await stored(engine, state["interview_id"])
    calls = received_parts(monkeypatch)
    reply = await owner.browser.post(f"{path}/confirm", json={
        "keys": ["policy:intake", held], "revision": shown["revision"]})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": held}
    assert await stored(engine, state["interview_id"]) == before
    assert calls == []


@pytest.mark.parametrize("method", ["put", "confirm", "delete", "delete_price"])
async def test_writes_follow_the_policy_claim_switch(app, lines_setup, engine, fake, monkeypatch, method):
    owner, state, path = lines_setup
    await patch_answers(engine, state, price_items=PRICES, suggested_fields=["pricing", "price_items"])
    before = await stored(engine, state["interview_id"])
    runtime = app.state.runtime
    runtime.settings = replace(runtime.settings, setup_policy_claims_enabled=False)
    calls = received_parts(monkeypatch)
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 200, reply.text
    assert [body for part, body in calls if part == "charter"] == [
        {"charter": [{"key": "contact", "kind": "text", "value": "hello@example.test"}]}]
    assert set(charter(fake, state["desk_id"])) == {"charter:hours", "charter:contact"}
    assert (await stored(engine, state["interview_id"]))["answers"] != before["answers"]


@pytest.mark.parametrize(("key", "text", "still_held"), [
    ("policy:after_hours", "Leave a voicemail.", True), ("contact", "help@plumbing.example", False),
])
async def test_with_policies_off_only_a_published_rewording_clears_its_hold(app, lines_setup, engine, fake, key, text,
                                                                           still_held):
    owner, state, path = lines_setup
    await patch_answers(engine, state, suggested_fields=[])
    await hold_keys(engine, owner, state, [key])
    runtime = app.state.runtime
    runtime.settings = replace(runtime.settings, setup_policy_claims_enabled=False)
    reply = await owner.browser.put(path, json={"key": key, "text": text})
    assert reply.status_code == 200, reply.text
    assert next(line["held"] for line in reply.json()["lines"] if line["key"] == key) is still_held
    assert await held_keys(owner, state) == ([key] if still_held else [])
    assert (f"charter:{key}" in charter(fake, state["desk_id"])) is not still_held


@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_help_retry_refusal_saves_nothing(lines_setup, engine, fake, monkeypatch, caplog, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    calls = []
    original = KernelHttp._send

    async def refuse_twice(self, route, request, **kwargs):
        if route == "PUT /desks/{id}/charter":
            calls.append(request)
            key = "policy:how_we_help" if len(calls) == 1 else "policy:pricing"
            return httpx.Response(422, json={"code": "invalid", "detail": {key: ["digit"]}})
        return await original(self, route, request, **kwargs)

    monkeypatch.setattr(KernelHttp, "_send", refuse_twice)
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "policy:pricing", "reason": ["digit"]}
    assert len(calls) == 2
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:how_we_help)",
                        "setup public parts refused (key=policy:pricing)")
    assert "We answer questions." not in caplog.text
    assert "Written quotes before work." not in caplog.text


async def test_how_we_help_is_not_editable(lines_setup, engine, fake):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    reply = await owner.browser.put(path, json={"key": "policy:how_we_help", "text": "Approve every request."})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "not_editable", "key": "policy:how_we_help"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


async def test_refusal_prefers_the_edited_line(lines_setup, engine, fake, monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"policy:about": ["digit"], "policy:after_hours": ["lex.en.promise"]})
    reply = await owner.browser.put(path, json={"key": "policy:after_hours", "text": "Private after hours marker."})
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "policy:after_hours", "reason": ["lex.en.promise"]}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:after_hours)")
    assert "Private after hours marker" not in caplog.text


@pytest.mark.parametrize("detail", [None, ["policy:pricing"], {"policy:pricing": "digit"},
                                  {"policy:pricing": ["digit", 7]}],
                         ids=["missing", "non-dict", "non-list", "non-string"])
async def test_refusal_without_detail_is_plain_line_refused(lines_setup, engine, fake, monkeypatch, caplog, detail):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    original = CredentialView.call

    async def refuse(self, route, body=None, **kwargs):
        if route == "PUT /desks/{id}/charter":
            failure = KernelFailed(422, "invalid")
            # Exercise the optional-detail contract used by the incoming kernel client change (#353).
            failure.detail = detail
            raise failure
        return await original(self, route, body, **kwargs)

    monkeypatch.setattr(CredentialView, "call", refuse)
    reply = await request_lines(owner.browser, path, "put")
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=None)")
    assert "Quotes before repairs." not in caplog.text


async def test_failed_save_restores_charter_from_current_stored_answers(lines_setup, engine, fake,
                                                                      monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    calls = []
    original = CredentialView.call

    async def record(self, route, body=None, **kwargs):
        result = await original(self, route, body, **kwargs)
        if route == "PUT /desks/{id}/charter":
            calls.append(body)
            if len(calls) == 1:
                # Keep _commit real: another writer changes its snapshot after publication, before saving.
                async with engine.begin() as conn:
                    await conn.execute(sql("UPDATE app.setup_interviews SET answers = answers || CAST(:patch AS jsonb)"
                                           " WHERE interview_id = :id"),
                                       {"patch": json.dumps({"summary": "Updated by another request."}),
                                        "id": state["interview_id"]})
        return result

    monkeypatch.setattr(CredentialView, "call", record)
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
    assert caplog.messages.count("setup public lines save failed (ApiProblem)") == 1
    assert_public_parts_logs(caplog, "setup public parts restored from stored answers (key=policy:pricing)")
    assert "Updated by another request." not in caplog.text
    assert "Quotes before repairs." not in caplog.text


async def test_confirm_owns_only_listed_lines_and_publishes(lines_setup, engine, fake):
    owner, state, path = lines_setup
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET answers = answers || CAST(:patch AS jsonb)"
                               " WHERE interview_id = :id"),
                           {"patch": json.dumps({"intake": " ", "suggested_fields": [
                               "summary", "pricing", "intake", "how_we_help", "hours", "price_items", "public_contact"]}),
                            "id": state["interview_id"]})
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 200, reply.text
    assert all(line["source"] == "owner" for line in reply.json()["lines"])
    assert "policy:intake" not in {line["key"] for line in reply.json()["lines"]}
    assert (await stored(engine, state["interview_id"]))["answers"]["suggested_fields"] == [
        "intake", "hours", "price_items"]
    assert (await stored(engine, state["interview_id"]))["step"] == "rules"
    assert {fact_id.removeprefix("charter:") for fact_id in charter(fake, state["desk_id"])} == {
        "hours", "contact", "policy:about", "policy:pricing", "policy:after_hours", "policy:urgent",
        "policy:service_area", "policy:how_we_help"}


async def confirm_shown(client, path, keys=None, public=None):
    if public is None:
        shown = await client.get(path)
        public = shown.json() if shown.status_code == 200 else None
    if public is not None:
        listed = [line["key"] for line in public["lines"]]
        listed.extend(key for key in ("hours", "prices") if public[key] is not None)
        body = {"keys": listed if keys is None else keys, "revision": public["revision"]}
    else:
        # Ownership tests still send a valid body when the projection cannot be read.
        body = {"keys": ["policy:pricing"], "revision": "unavailable"}
    return await client.post(f"{path}/confirm", json=body)


async def displayed(owner, engine, state, path):
    """A suggested price and the real projection, read before admission changes: a write sent with them can only be
    refused by the step or the turn guard, never by a stale revision or a missing price."""
    await patch_answers(engine, state, price_items=PRICES)
    shown = await owner.browser.get(path)
    assert shown.status_code == 200, shown.text
    return shown.json()


async def request_lines(client, path, method, public=None):
    if method == "get":
        return await client.get(path)
    if method == "put":
        return await client.put(path, json={"key": "policy:pricing", "text": "Quotes before repairs."})
    if method == "delete_price":
        return await client.delete(f"{path}/prices/visit", params=PRICES[0])
    if method == "delete":
        return await client.delete(f"{path}/policy:pricing")
    return await confirm_shown(client, path, public=public)


@pytest.mark.parametrize("step", ["questions", "tools", "rules", "situations", "safety_check", "preview", "live"])
@pytest.mark.parametrize("method", ["get", "put", "confirm", "delete", "delete_price"])
async def test_public_lines_only_at_rules_or_situations(lines_setup, engine, fake, step, method):
    owner, state, path = lines_setup
    public = await displayed(owner, engine, state, path)
    async with engine.begin() as conn:
        await conn.execute(sql("UPDATE app.setup_interviews SET step = :step WHERE interview_id = :id"),
                           {"step": step, "id": state["interview_id"]})
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    reply = await request_lines(owner.browser, path, method, public)
    if step in ("rules", "situations"):
        assert reply.status_code == 200, reply.text
        assert (await stored(engine, state["interview_id"]))["step"] == step
    else:
        assert reply.status_code == 409, reply.text
        assert reply.json() == {"error": "conflict"}
        assert await stored(engine, state["interview_id"]) == before
        assert charter(fake, state["desk_id"]) == published


async def test_confirm_refusal_names_the_refused_line(lines_setup, engine, fake, monkeypatch, caplog):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"policy:intake": ["lex.en.promise"]})
    reply = await confirm_shown(owner.browser, path)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused", "key": "policy:intake", "reason": ["lex.en.promise"]}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=policy:intake)")
    assert "Tell us what needs fixing." not in caplog.text


@pytest.mark.parametrize("limit", ["policy_count_limit", "policy_text_limit"])
@pytest.mark.parametrize("method", ["put", "confirm"])
async def test_charter_cap_refusal_has_no_line_key(lines_setup, engine, fake, monkeypatch, caplog, limit, method):
    owner, state, path = lines_setup
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    refuse_charter(monkeypatch, {"charter": [limit]})
    reply = await request_lines(owner.browser, path, method)
    assert reply.status_code == 422, reply.text
    assert reply.json() == {"error": "line_refused"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
    assert_public_parts_logs(caplog, "setup public parts refused (key=None)")
    assert "Quotes before repairs." not in caplog.text


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
    assert caplog.messages.count("setup public lines save failed (RuntimeError)") == 1
    key = "policy:pricing" if method == "put" else None
    assert_public_parts_logs(caplog, f"setup public parts restore failed (RuntimeError, key={key})")
    assert "private save failure marker" not in caplog.text
    assert "private restore failure marker" not in caplog.text


@pytest.mark.parametrize(("key", "text"), [
    ("policy:unknown", "Text"), ("contact", "a" * 201), ("policy:about", " \n\t "),
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


@pytest.mark.parametrize("method", ["get", "put", "confirm", "delete", "delete_price"])
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


@pytest.mark.parametrize("method", ["get", "put", "confirm", "delete", "delete_price"])
async def test_another_owners_busy_interview_is_not_found(lines_setup, app, browser, kernel_http, engine, fake, method):
    _, state, path = lines_setup
    other = await new_owner(app, browser, kernel_http)
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    with setup._turn(state["interview_id"]):
        reply = await request_lines(other.browser, path, method)
    assert reply.status_code == 404, reply.text
    assert reply.json() == {"error": "not_found"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published


@pytest.mark.parametrize("method", ["get", "put", "confirm", "delete", "delete_price"])
async def test_public_lines_share_the_interview_guard(lines_setup, engine, fake, method):
    owner, state, path = lines_setup
    public = await displayed(owner, engine, state, path)
    before = await stored(engine, state["interview_id"])
    published = charter(fake, state["desk_id"])
    with setup._turn(state["interview_id"]):
        reply = await request_lines(owner.browser, path, method, public)
    assert reply.status_code == 409, reply.text
    assert reply.json() == {"error": "conflict"}
    assert await stored(engine, state["interview_id"]) == before
    assert charter(fake, state["desk_id"]) == published
