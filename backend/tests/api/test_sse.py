"""Run events: per-session SSE sequence numbers, control rows, replay and live wake-ups over one listener."""

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from desk.api import sse
from desk.api.sse import Listener, Wakeup, append_control, claim_control, emit, event_stream, unhandled_controls
from desk.db.session import database_url
from desk.api.store import Ids
from desk.contracts import RenderedBlock
from desk.events import EvError, EvHeld, EvMessage, EvOwnerTyping, EvReceipt, EvResolved, EvTurnEnd, EvWriting

SESSION_A = Ids(copy_id="copy-1", desk_id="desk-1", session_id="session-a")
SESSION_B = Ids(copy_id="copy-1", desk_id="desk-1", session_id="session-b")


@pytest.fixture
async def listener(db) -> AsyncIterator[Listener]:
    async with Listener(database_url("API")) as listener:
        yield listener


async def raw_frames(response, count: int, *, timeout: float = 5.0, seen: list[str] | None = None) -> list[str]:
    """Runs an SSE response as a browser would until `count` frames (events or comments) arrived, then hangs up.
    `seen`, when given, gets each frame too, as it arrives."""
    frames: list[str] = []
    hung_up = asyncio.Event()

    async def receive() -> dict:
        await hung_up.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            assert message["status"] == 200
        elif message["type"] == "http.response.body" and message["body"]:
            frames.append(message["body"].decode())
            if seen is not None:
                seen.append(frames[-1])
            if len(frames) >= count:
                hung_up.set()

    await asyncio.wait_for(response({"type": "http", "method": "GET"}, receive, send), timeout)
    return frames


async def read_frames(response, count: int, *, timeout: float = 5.0) -> list[str]:
    """The `count` frames after the comment every stream opens with, which comes first."""
    opening, *frames = await raw_frames(response, count + 1, timeout=timeout)
    assert opening == ": open\r\n\r\n"
    return frames


async def publish(engine, ids: Ids, *events) -> list[int]:
    async with engine.begin() as conn:
        return [await emit(conn, ids, event) for event in events]


async def test_seq_is_per_session_and_gapless(engine):
    async def append(ids: Ids) -> int:
        async with engine.begin() as conn:            # one transaction each, all at once
            return await emit(conn, ids, EvWriting(type="writing"))

    sessions = [SESSION_A, SESSION_B] * 10
    seqs = await asyncio.gather(*(append(ids) for ids in sessions))

    for ids in (SESSION_A, SESSION_B):
        assert sorted(seq for seq, owner in zip(seqs, sessions, strict=True) if owner == ids) == list(range(1, 11))
        async with engine.connect() as conn:
            stored = (await conn.execute(text("SELECT seq FROM app.run_events WHERE session_id = :s ORDER BY seq"),
                                         {"s": ids.session_id})).scalars().all()
        assert stored == list(range(1, 11))


SIGNED = {"decision_id": "d-1", "state": "executed", "visitor_plain": "Done.", "ledger_seq": 7, "signature": "fake:00"}


async def count_rows(conn, ids: Ids, kind: str) -> int:
    return (await conn.execute(text("SELECT count(*) FROM app.run_events WHERE session_id = :s AND kind = :k"),
                               {"s": ids.session_id, "k": kind})).scalar_one()


async def test_emit_rejects_signed_event_types(api_conn):
    signed = [
        EvMessage(type="message", message_id="msg-1", generation=0, author="claude", language="en", handoff=False,
                  blocks=[RenderedBlock(kind="prose", text="Hello.")], visitor_plain="Checked.", ledger_seq=3,
                  signature="fake:00"),
        EvReceipt(type="receipt", **SIGNED), EvHeld(type="held", **{**SIGNED, "state": "held"}),
        EvResolved(type="resolved", **SIGNED),
    ]
    for event in (*signed, {"type": "writing"}, "turn_end"):
        with pytest.raises(TypeError):
            await emit(api_conn, SESSION_A, event)
    assert await count_rows(api_conn, SESSION_A, "sse") == 0
    assert await emit(api_conn, SESSION_A, EvWriting(type="writing")) == 1
    assert await emit(api_conn, SESSION_A, EvError(type="error", code="kernel_unavailable")) == 2
    assert await emit(api_conn, SESSION_A, EvTurnEnd(type="turn_end")) == 3


async def test_emit_takes_owner_typing_as_unsigned(api_conn):
    # The dots after a take-over: emit() publishes the name and how long they show, and nothing else is stored.
    until = datetime(2026, 10, 29, 15, 4, 30, tzinfo=UTC)
    assert await emit(api_conn, SESSION_A, EvOwnerTyping(type="owner_typing", name="Mike Turner", until=until)) == 1
    stored = (await api_conn.execute(text("SELECT type, payload FROM app.run_events WHERE session_id = :s"),
                                     {"s": SESSION_A.session_id})).one()
    assert stored.type == "owner_typing"
    assert stored.payload == {"type": "owner_typing", "name": "Mike Turner", "until": "2026-10-29T15:04:30Z"}


async def test_control_rows_are_claimed_once(engine):
    async with engine.begin() as conn:
        due = await append_control(conn, SESSION_A, "decision_due", {"decision_id": "d-1"})
        # one unhandled decision_due per decision: a second is not written
        assert await append_control(conn, SESSION_A, "decision_due", {"decision_id": "d-1"}) is None
        resumable = await append_control(conn, SESSION_A, "run_resumable", {})
        with pytest.raises(ValueError):
            await append_control(conn, SESSION_A, "writing", {})

    async def claim(row_id: int) -> bool:
        async with engine.begin() as conn:            # each claim in its own transaction, all at once
            return await claim_control(conn, row_id)

    assert sorted(await asyncio.gather(*(claim(due) for _ in range(5)))) == [False, False, False, False, True]
    assert await claim(resumable) is True
    assert await claim(resumable) is False
    async with engine.begin() as conn:
        # once handled, the decision may be due again, and a claim never touches an SSE row
        assert await append_control(conn, SESSION_A, "decision_due", {"decision_id": "d-1"}) is not None
        seq = await emit(conn, SESSION_A, EvWriting(type="writing"))
        sse_id = (await conn.execute(text("SELECT id FROM app.run_events WHERE kind = 'sse' AND seq = :q"),
                                     {"q": seq})).scalar_one()
        assert await claim_control(conn, sse_id) is False


async def test_unhandled_controls_read_in_the_callers_transaction(engine):
    async with engine.connect() as conn:
        row = await append_control(conn, SESSION_A, "run_resumable", {})
        assert [found.id for found in await unhandled_controls(conn, SESSION_A)] == [row]
        await conn.rollback()                            # the caller's write is still the caller's to undo
    async with engine.connect() as conn:
        assert await unhandled_controls(conn, SESSION_A) == []


async def test_replay_after_last_event_id(engine, listener):
    await publish(engine, SESSION_A, EvWriting(type="writing"), EvError(type="error", code="kernel_unavailable"),
                  EvTurnEnd(type="turn_end"))
    await publish(engine, SESSION_B, EvWriting(type="writing"))          # another session's: never in this stream
    opened: list[str] = []

    async def on_open() -> None:
        opened.append("open")                       # after the replay, before anything live
        await publish(engine, SESSION_A, EvWriting(type="writing"))

    stream = event_stream(engine, listener, SESSION_A, 1, on_open=on_open, on_control=None, ping_s=15)
    frames = await read_frames(stream, 3)

    assert frames == [
        'id: 2\r\nevent: error\r\ndata: {"type":"error","code":"kernel_unavailable"}\r\n\r\n',
        'id: 3\r\nevent: turn_end\r\ndata: {"type":"turn_end"}\r\n\r\n',
        'id: 4\r\nevent: writing\r\ndata: {"type":"writing"}\r\n\r\n',
    ]
    assert opened == ["open"]
    # with no Last-Event-ID the stream replays from the start
    first = await read_frames(event_stream(engine, listener, SESSION_A, None, on_open=None, on_control=None), 1)
    assert first[0].startswith("id: 1\r\nevent: writing\r\n")
    assert json.loads(first[0].split("data: ", 1)[1]) == {"type": "writing"}


async def test_a_stream_with_nothing_to_send_opens_at_once(engine, listener):
    """Behind CloudFront and the load balancer, a response's headers reach the browser only with its first body byte,
    and EventSource opens on them. A stream with no event to replay sends a comment as it starts, before on_open
    returns and long before its first keep-alive: no event, data or id, so it never moves the client's Last-Event-ID."""
    async def on_open() -> None:
        await asyncio.Event().wait()                # holds the stream until the client hangs up

    stream = event_stream(engine, listener, SESSION_A, None, on_open=on_open, on_control=None, ping_s=60)
    assert await raw_frames(stream, 1, timeout=1.0) == [": open\r\n\r\n"]


async def test_a_replay_follows_the_opening_comment_back_to_back(engine, listener, monkeypatch):
    """A stream reads what it replays before it opens, so its replay follows the opening comment with no read between
    them: the web takes a quiet moment after the open as having caught up."""
    await publish(engine, SESSION_A, EvWriting(type="writing"), EvTurnEnd(type="turn_end"))
    seen: list[str] = []
    events_after = sse._events_after

    async def reading(*args):
        seen.append("read")
        return await events_after(*args)

    monkeypatch.setattr(sse, "_events_after", reading)
    stream = event_stream(engine, listener, SESSION_A, None, on_open=None, on_control=None, ping_s=60)
    await raw_frames(stream, 3, seen=seen)

    assert seen[:4] == ["read", ": open\r\n\r\n",
                        'id: 1\r\nevent: writing\r\ndata: {"type":"writing"}\r\n\r\n',
                        'id: 2\r\nevent: turn_end\r\ndata: {"type":"turn_end"}\r\n\r\n']


async def test_heartbeat_is_a_comment(engine, listener):
    stream = event_stream(engine, listener, SESSION_A, None, on_open=None, on_control=None, ping_s=0.05)
    frames = await read_frames(stream, 2)
    assert frames == [": keep-alive\r\n\r\n"] * 2           # a comment: no event, id or data for the client


async def test_a_hang_up_that_a_read_reports_as_its_own_error_ends_the_stream_quietly(engine, listener):
    # A hang-up cancels the stream wherever it is. SQLAlchemy's pool ping reports a cancellation that lands in it as
    # a ProgrammingError (its `finally` changes autocommit on a connection still busy); on_open stands in for it.
    await publish(engine, SESSION_A, EvWriting(type="writing"))
    reading = asyncio.Event()

    async def on_open() -> None:
        reading.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            raise RuntimeError("can't change 'autocommit' now: connection in transaction status ACTIVE") from None

    stream = event_stream(engine, listener, SESSION_A, None, on_open=on_open, on_control=None)
    frames = await read_frames(stream, 1)                  # hangs up after the first event, while on_open reads

    assert reading.is_set() and len(frames) == 1            # ended as a hang-up ends it, with nothing raised


async def until(condition, timeout: float = 3.0) -> None:
    """Waits until `condition()` holds; fails after `timeout` seconds."""
    async def poll() -> None:
        while not condition():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(poll(), timeout)


async def test_control_rows_committed_out_of_id_order_are_each_handed_over(engine, listener):
    async with engine.begin() as conn:             # already waiting when the stream opens: on_open's, not handed
        waiting = await append_control(conn, SESSION_A, "decision_due", {"decision_id": "d-1"})
    opened = asyncio.Event()
    handed: list[int] = []

    async def on_open() -> None:
        opened.set()

    async def on_control(row) -> None:
        handed.append(row.id)

    stream = asyncio.create_task(read_frames(event_stream(
        engine, listener, SESSION_A, None, on_open=on_open, on_control=on_control, poll_s=0.1), 1, timeout=10))
    await asyncio.wait_for(opened.wait(), 5)       # subscribed and replayed
    async with engine.connect() as slow:
        # the slow writer takes the lower id and commits last
        first = await append_control(slow, SESSION_A, "run_resumable", {})
        async with engine.begin() as quick:
            second = await append_control(quick, SESSION_A, "decision_pending", {"decision_id": "d-2"})
        assert waiting < first < second
        await until(lambda: second in handed)
        await slow.commit()
    await until(lambda: first in handed)           # polled many times over: a skipped row would never arrive
    await publish(engine, SESSION_A, EvWriting(type="writing"))
    await stream
    assert handed == [second, first]                # each once, in the order they became visible


async def listening_backends(conn) -> set[int]:
    rows = await conn.execute(text("SELECT pid FROM pg_stat_activity WHERE datname = current_database()"
                                   " AND query = 'LISTEN desk_run_events'"))
    return set(rows.scalars().all())


async def test_streams_share_one_listener(engine, db, monkeypatch):
    async with engine.connect() as conn:
        before = await listening_backends(conn)
    handed: list[tuple[str, str]] = []

    async def on_control(row) -> None:
        handed.append((row.session_id, row.type))

    # a stream first waits for a wake-up once it has replayed and read what was already there
    waiting: set[int] = set()
    both_waiting = asyncio.Event()
    wait = Wakeup.wait

    async def watched_wait(self, timeout: float) -> bool:
        waiting.add(id(self))
        if len(waiting) == 2:
            both_waiting.set()
        return await wait(self, timeout)

    monkeypatch.setattr(Wakeup, "wait", watched_wait)

    async with Listener(database_url("API")) as listener:
        # a long poll: what arrives within the test's few seconds came from a notification
        streams = [asyncio.create_task(read_frames(
            event_stream(engine, listener, ids, None, on_open=None, on_control=on_control, poll_s=60), 2,
            timeout=10)) for ids in (SESSION_A, SESSION_B)]
        await asyncio.wait_for(both_waiting.wait(), 5)
        async with engine.connect() as conn:
            assert await listening_backends(conn) - before == {listener.backend_pid}
        async with engine.begin() as conn:
            await append_control(conn, SESSION_A, "run_resumable", {})
            await emit(conn, SESSION_A, EvWriting(type="writing"))
            await emit(conn, SESSION_B, EvWriting(type="writing"))
            await emit(conn, SESSION_A, EvTurnEnd(type="turn_end"))
            await emit(conn, SESSION_B, EvTurnEnd(type="turn_end"))
        a, b = await asyncio.wait_for(asyncio.gather(*streams), 3)

    assert [frame.split("\r\n", 2)[:2] for frame in a] == [["id: 1", "event: writing"], ["id: 2", "event: turn_end"]]
    assert [frame.split("\r\n", 2)[:2] for frame in b] == [["id: 1", "event: writing"], ["id: 2", "event: turn_end"]]
    assert handed == [("session-a", "run_resumable")]       # handed to the stream it was written for, once
