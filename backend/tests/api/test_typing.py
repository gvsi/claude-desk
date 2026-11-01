"""Typing, both ways (Plan 02b, Task 1): presence, not a message.

A visitor's typing shows to the owner alone, as `OwnerTranscript.typing_until`; the owner's typing after a take-over
shows to the visitor as an `owner_typing` event carrying the kernel's name for the owner and an end time, no text.
Neither stores anything in `app.*` but that event, calls the kernel beyond the `GET /whoami` that names the caller,
or writes the ledger. A signal shows for five seconds, and one within two seconds of the last that counted changes
nothing.

The app runs on FakeKernel with the test's clock (`api`).
"""

import json
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.routes import owner as owner_routes
from desk.events import EvOwnerJoined
from tests.api.test_public_chat import Stream, cookie, events_path, open_session, stored_events, types
from tests.api.test_take_over import OWNER_IP, Chat, mode_change, new_chat
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA


async def app_rows(engine) -> tuple[int, int]:
    """How many rows `app.messages` and `app.run_events` hold."""
    async with engine.connect() as conn:
        messages = (await conn.execute(text("SELECT count(*) FROM app.messages"))).scalar_one()
        events = (await conn.execute(text("SELECT count(*) FROM app.run_events"))).scalar_one()
        return messages, events


def ledger_size(fake, chat: Chat) -> int:
    return len(fake.desks[fake.sessions[chat.session_id].desk_id].ledger)


async def visitor_typing(chat: Chat):
    return await chat.visitor.post(f"/api/public/desks/{chat.slug}/typing")


async def typing_until(chat: Chat, session_id: str | None = None) -> datetime | None:
    """The owner's view of the conversation: when the visitor's typing dots stop, else None."""
    read = await chat.owner.get(f"/api/owner/conversations/{session_id or chat.session_id}")
    assert read.status_code == 200, read.text
    until = read.json()["typing_until"]
    return None if until is None else datetime.fromisoformat(until)


async def test_visitor_typing_reaches_only_the_owner(api, browser, fake, kernel_http, engine, clock):
    chat = await new_chat(api, browser, kernel_http, fake)
    _, _, beside = await open_session(api, browser, chat.slug)       # another visitor on the same Desk
    before, ledger = await app_rows(engine), ledger_size(fake, chat)

    async with Stream(api, events_path(chat.slug), headers=[cookie(chat.token)]) as stream:
        fake.calls.clear()
        typed = await visitor_typing(chat)
        assert (typed.status_code, typed.content) == (204, b"")
        # Presence only: nothing stored, no kernel call but the one naming the session, no ledger entry.
        assert [call.route for call in fake.calls] == ["GET /whoami"]
        assert await app_rows(engine) == before and ledger_size(fake, chat) == ledger

        # The owner sees the dots in this conversation until five seconds from now, and in no other.
        assert await typing_until(chat) == clock.now + timedelta(seconds=5)
        assert await typing_until(chat, beside["state"]["session_id"]) is None
        # The visitor's own transcript and stream never carry it.
        own = (await chat.visitor.get(f"/api/public/desks/{chat.slug}/session")).json()
        assert "typing" not in json.dumps(own)
    assert types(stream.events) == [] and await stored_events(engine, chat.session_id) == []


async def test_visitor_typing_expires_after_five_seconds(api, browser, fake, kernel_http, clock):
    chat = await new_chat(api, browser, kernel_http, fake)
    assert await typing_until(chat) is None
    started = clock.now

    assert (await visitor_typing(chat)).status_code == 204
    clock.advance(4.999)
    assert await typing_until(chat) == started + timedelta(seconds=5)
    clock.advance(0.001)                                        # five seconds on, with no new signal: gone
    assert await typing_until(chat) is None


async def test_visitor_typing_is_throttled(api, browser, fake, kernel_http, clock):
    chat = await new_chat(api, browser, kernel_http, fake)
    started = clock.now

    # A signal within two seconds of the last one that counted changes nothing, and is never refused.
    for _ in range(40):
        typed = await visitor_typing(chat)
        assert (typed.status_code, typed.content) == (204, b"")
    clock.advance(1.999)
    assert (await visitor_typing(chat)).status_code == 204
    assert await typing_until(chat) == started + timedelta(seconds=5)
    # Two seconds after the one that counted, the next counts again, from its own time.
    clock.advance(0.001)
    assert (await visitor_typing(chat)).status_code == 204
    assert await typing_until(chat) == started + timedelta(seconds=7)


async def owner_typing(chat: Chat, generation: int):
    return await chat.owner.post(chat.path("typing"), json={"generation": generation})


async def test_owner_typing_needs_take_over(api, browser, fake, kernel_http, engine):
    chat = await new_chat(api, browser, kernel_http, fake)

    refused = await owner_typing(chat, 0)                       # Claude has the conversation

    assert (refused.status_code, refused.json()) == (409, {"error": "take_over_first"})
    fake.set_mode(chat.session_id, "paused")
    assert (await owner_typing(chat, 0)).json() == {"error": "take_over_first"}
    assert await stored_events(engine, chat.session_id) == []
    # Another copy's conversation is 404.
    other = await new_chat(api, browser, kernel_http, fake)
    elsewhere = await chat.owner.post(other.path("typing"), json={"generation": 0})
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})


async def test_owner_typing_shows_dots_to_the_visitor(api, browser, fake, kernel_http, engine, clock):
    chat = await new_chat(api, browser, kernel_http, fake)
    assert (await mode_change(chat, "takeover", 0)).status_code == 200
    rows_before, ledger = await app_rows(engine), ledger_size(fake, chat)
    fake.calls.clear()

    async with Stream(api, events_path(chat.slug), headers=[cookie(chat.token)]) as stream:
        typed = await owner_typing(chat, 1)
        events = await stream.until(lambda events: "owner_typing" in types(events))
        assert (typed.status_code, typed.content) == (204, b"")
        # The kernel's name for the owner and when the dots stop: nothing the owner typed.
        assert events[-1][1].model_dump() == {"type": "owner_typing", "name": "Mike Turner",
                                              "until": clock.now + timedelta(seconds=5)}
        # Within two seconds, another signal sends nothing; it is never refused.
        clock.advance(1.999)
        assert (await owner_typing(chat, 1)).status_code == 204
        # A signal at a generation the session has left is refused and sends nothing.
        assert (await owner_typing(chat, 0)).json() == {"error": "stale_generation"}
    assert types([(0, event) for event in await stored_events(engine, chat.session_id)]) == [
        "owner_joined", "owner_typing"]
    assert {call.route for call in fake.calls} == {"GET /whoami"}            # naming the callers, nothing else
    assert await app_rows(engine) == (rows_before[0], rows_before[1] + 1) and ledger_size(fake, chat) == ledger

    # Two seconds after the dots that went out, the next signal sends them again.
    clock.advance(0.001)
    assert (await owner_typing(chat, 1)).status_code == 204
    shown = await stored_events(engine, chat.session_id)
    assert [event.type for event in shown] == ["owner_joined", "owner_typing", "owner_typing"]
    assert shown[-1].until == clock.now + timedelta(seconds=5)


async def test_owner_typing_whose_name_read_failed_holds_back_no_signal(api, browser, fake, kernel_http, engine,
                                                                        clock, db):
    chat = await new_chat(api, browser, kernel_http, fake)
    assert (await mode_change(chat, "takeover", 0)).status_code == 200
    # The Desk's business is out of its copy's kernel_ro rows for a moment, so the owner's name can't be read.
    business_id = fake.desks[fake.sessions[chat.session_id].desk_id].business_id
    hide = f"UPDATE {FAKE_RO_SCHEMA}.businesses SET business_id = %s WHERE business_id = %s"
    db.execute(hide, (f"{business_id}.hidden", business_id))

    # The owner, through a transport that answers an app error as the server would (500), not by raising it.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api, client=(OWNER_IP, 50000),
                                                               raise_app_exceptions=False),
                                 base_url="https://desk.test", cookies=chat.owner.cookies) as owner:
        failed = await owner.post(chat.path("typing"), json={"generation": 1})
    assert (failed.status_code, failed.json()) == (500, {"error": "internal"})
    assert await stored_events(engine, chat.session_id) == [EvOwnerJoined(type="owner_joined", name="Mike Turner")]

    # The name reads again: the next signal, within two seconds of the failed one, sends the dots.
    db.execute(hide, (business_id, f"{business_id}.hidden"))
    clock.advance(1)
    assert (await owner_typing(chat, 1)).status_code == 204
    shown = await stored_events(engine, chat.session_id)
    assert [event.type for event in shown] == ["owner_joined", "owner_typing"]
    assert shown[-1].until == clock.now + timedelta(seconds=5)


@pytest.mark.parametrize("failing", ["emit", "commit"])
async def test_owner_typing_whose_event_failed_holds_back_no_signal(failing, api, browser, fake, kernel_http, engine,
                                                                    clock, monkeypatch):
    """The dots count only once their event is committed: when writing the event fails, or its commit does, the
    signal rolls back and holds nothing back, so the next signal, within two seconds of it, sends the dots."""
    chat = await new_chat(api, browser, kernel_http, fake)
    assert (await mode_change(chat, "takeover", 0)).status_code == 200
    real_emit, real_commit = owner_routes.emit, AsyncConnection.commit
    wrote_on: list[AsyncConnection] = []                 # the connection that wrote the event
    raised: list[str] = []

    async def emit_or_fail(conn, ids, event):
        if failing == "emit":
            raised.append("emit")
            raise RuntimeError("the event can't be written")
        wrote_on.append(conn)
        return await real_emit(conn, ids, event)

    async def commit_or_fail(self) -> None:
        # On the class, since a connection has `__slots__`: the first commit after the event, on the connection that
        # wrote it, fails before committing anything; every other commit is the real one.
        if any(self is conn for conn in wrote_on) and not raised:
            raised.append("commit")
            raise RuntimeError("the commit failed")
        await real_commit(self)

    with monkeypatch.context() as patched:
        patched.setattr(owner_routes, "emit", emit_or_fail)
        if failing == "commit":
            patched.setattr(AsyncConnection, "commit", commit_or_fail)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api, client=(OWNER_IP, 50000),
                                                                   raise_app_exceptions=False),
                                     base_url="https://desk.test", cookies=chat.owner.cookies) as owner:
            failed = await owner.post(chat.path("typing"), json={"generation": 1})
    assert raised == [failing]                           # it failed where this case says, and only there
    assert (failed.status_code, failed.json()) == (500, {"error": "internal"})
    assert await stored_events(engine, chat.session_id) == [EvOwnerJoined(type="owner_joined", name="Mike Turner")]

    clock.advance(1)
    assert (await owner_typing(chat, 1)).status_code == 204
    shown = await stored_events(engine, chat.session_id)
    assert [event.type for event in shown] == ["owner_joined", "owner_typing"]
    assert shown[-1].until == clock.now + timedelta(seconds=5)
