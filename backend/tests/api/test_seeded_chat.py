"""The demo's held request has the visitor's question and the kernel's signed held receipt, with no Claude reply."""

import asyncio

import pytest

from desk.api.routes import owner as owner_routes
from desk.api.routes.owner import store_seeded_chat
from desk.api.store import Ids, transcript
from desk.kernel_api import CreateCopyRequest
from tests.api.conftest import PASSCODE
from tests.api.test_recorded_history import LAST_NIGHT, booked_visit


@pytest.mark.parametrize("start_over", [False, True])
async def test_new_copy_shows_seeded_chat_to_owner_and_visitor(api, browser, fake, engine, start_over):
    client = browser(api)
    response = await client.post("/api/owner/copies", json={"passcode": PASSCODE})
    assert response.status_code == 201
    if start_over:
        response = await client.post("/api/owner/start_over")
        assert response.status_code == 200
    copy_id = response.json()["copy_id"]
    (decision,) = [record.decision for record in fake.decisions.values()
                   if fake.sessions[record.decision.session_id].copy_id == copy_id]
    session = fake.sessions[decision.session_id]
    owner = await client.get(f"/api/owner/conversations/{session.session_id}")
    assert owner.status_code == 200
    items = owner.json()["items"]
    assert [item["kind"] for item in items] == ["visitor_text", "status"]
    assert items[0]["text"] == "Could you do the drain clearing at 15% off?"
    assert items[0]["event"] is None
    assert items[1]["event"] == {
        "type": "held", "decision_id": decision.decision_id, "state": decision.state,
        "visitor_plain": decision.visitor_plain, "ledger_seq": decision.ledger_seq, "signature": decision.signature,
    }
    async with engine.connect() as conn:
        visitor = await transcript(conn, Ids(copy_id=copy_id, desk_id=session.desk_id,
                                             session_id=session.session_id), "visitor")
    assert [item.model_dump(mode="json") for item in visitor] == [
        {key: item[key] for key in ("n", "kind", "created_at", "text", "event")} for item in items]
    assert fake.called("POST /check_reply") == []


async def test_copy_without_seeded_chat_writes_nothing(kernel_http, api_conn, ro_schema, db):
    created = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    created = created.model_copy(update={"seeded_chat": None})
    assert await store_seeded_chat(api_conn, created, ro_schema=ro_schema) == 0
    await api_conn.commit()
    assert db.execute("SELECT count(*) FROM app.messages").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM app.run_events").fetchone()[0] == 0


async def test_repeated_store_writes_no_duplicate(kernel_http, api_conn, ro_schema, db):
    created = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    assert await store_seeded_chat(api_conn, created, ro_schema=ro_schema) == 2
    await api_conn.commit()
    assert await store_seeded_chat(api_conn, created, ro_schema=ro_schema) == 0
    await api_conn.commit()
    assert db.execute("SELECT kind FROM app.messages ORDER BY n").fetchall() == [("visitor_text",), ("status",)]
    assert db.execute("SELECT count(*) FROM app.run_events").fetchone()[0] == 1


@pytest.mark.parametrize("invalid", ["closed", "other_copy", "other_desk", "agent", "missing"])
async def test_invalid_seeded_session_writes_nothing_and_logs(invalid, kernel_http, api_conn, ro_schema, db, caplog):
    created = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    session_id = created.seeded_chat.session_id
    if invalid == "closed":
        db.execute("UPDATE fake_kernel_ro.sessions SET closed_at = now() WHERE session_id = %s", (session_id,))
    elif invalid == "other_copy":
        other = await kernel_http.public().call("POST /copies", CreateCopyRequest())
        created = created.model_copy(update={"seeded_chat": other.seeded_chat})
    elif invalid == "other_desk":
        created = created.model_copy(update={"desk_ids": []})
    elif invalid == "agent":
        db.execute("UPDATE fake_kernel_ro.sessions SET kind = 'agent' WHERE session_id = %s", (session_id,))
    else:
        created = created.model_copy(update={"seeded_chat": created.seeded_chat.model_copy(
            update={"session_id": "missing-session"})})
    assert await store_seeded_chat(api_conn, created, ro_schema=ro_schema) == 0
    await api_conn.commit()
    assert db.execute("SELECT count(*) FROM app.messages").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM app.run_events").fetchone()[0] == 0
    logged = [record.getMessage() for record in caplog.records if record.name == "desk.api.routes.owner"]
    assert logged == ["the seeded chat wasn't stored: not an open visitor session on one of the copy's Desks"]


@pytest.mark.parametrize("replay", [False, True])
async def test_failed_seeded_writer_still_returns_copy(api, browser, fake, db, monkeypatch, caplog, replay):
    if replay:
        fake.record_night(booked_visit(LAST_NIGHT))
    deliver = owner_routes.deliver

    async def fail_after_delivery(*args, **kwargs):
        result = await deliver(*args, **kwargs)
        if kwargs.get("replayed") is None:
            raise RuntimeError("untrusted error details must not be logged")
        return result

    monkeypatch.setattr(owner_routes, "deliver", fail_after_delivery)
    response = await browser(api).post("/api/owner/copies", json={"passcode": PASSCODE})
    assert response.status_code == 201
    assert response.json()["desks"]
    assert db.execute("SELECT count(*) FROM app.messages WHERE replay_id IS NULL").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM app.run_events WHERE replay_id IS NULL").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM app.messages WHERE replay_id IS NOT NULL").fetchone()[0] == (3 if replay else 0)
    assert db.execute("SELECT count(*) FROM app.run_events WHERE replay_id IS NOT NULL").fetchone()[0] == (2 if replay else 0)
    logged = [record.getMessage() for record in caplog.records if record.name == "desk.api.routes.owner"]
    assert logged == ["the seeded chat couldn't be stored (RuntimeError); the copy is still available"]


async def test_dropped_held_receipt_leaves_no_partial_chat(api, browser, db, monkeypatch, caplog):
    async def drop_delivery(*args, **kwargs):
        return None

    monkeypatch.setattr(owner_routes, "deliver", drop_delivery)
    response = await browser(api).post("/api/owner/copies", json={"passcode": PASSCODE})
    assert response.status_code == 201
    assert db.execute("SELECT count(*) FROM app.messages").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM app.run_events").fetchone()[0] == 0
    logged = [record.getMessage() for record in caplog.records if record.name == "desk.api.routes.owner"]
    assert logged == ["the seeded chat couldn't be stored (ValueError); the copy is still available"]


async def test_concurrent_stores_write_one_chat(kernel_http, engine, ro_schema, db):
    created = await kernel_http.public().call("POST /copies", CreateCopyRequest())

    async def store():
        async with engine.begin() as conn:
            return await store_seeded_chat(conn, created, ro_schema=ro_schema)

    assert sorted(await asyncio.wait_for(asyncio.gather(store(), store()), timeout=5)) == [0, 2]
    assert db.execute("SELECT kind FROM app.messages ORDER BY n").fetchall() == [("visitor_text",), ("status",)]
    assert db.execute("SELECT count(*) FROM app.run_events").fetchone()[0] == 1
