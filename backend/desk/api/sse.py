"""Run events (`app.run_events`) and the visitor's event stream.

Each session's SSE events carry a `seq`, gapless per session, which is the SSE `id`: `append_event` takes
the session's events lock, writes `max + 1` and notifies `desk_run_events` with the session ID, all in the
caller's transaction, so a reader never sees a later event before an earlier one. `store.append_message` takes the
same lock, so the session's transcript rows commit in `n` order too. The locks are taken in one order, the run lock
(`deliver.run_lock`) before the events lock: `deliver()` takes both, so a transaction that emits or appends a message
and also delivers takes the run lock before its first `emit` or append. Only `deliver()` writes
the four signed events (message, receipt, held, resolved); `emit` writes the other seven. Control rows
(`run_resumable`, `decision_due`, `decision_pending`) are work for the next request that holds the
session's credential, claimed once each; metric rows record reveal and turn timings.

Functions that write run in the caller's transaction and never commit. `emit_inbox` publishes the kernel's Demo inbox
notices meant for the visitor (a code sent to the contact on record), code-free and once per entry; owner alerts never
reach a session.

The stream: one `Listener` per process holds the only `LISTEN desk_run_events` connection and wakes the
streams of the session each notification names. `event_stream` reads what it replays, sends an `open` comment
(behind CloudFront and the load balancer, a response's headers reach the browser only with its first body byte, and
EventSource opens on them), replays the session's events after the client's `Last-Event-ID`, calls `on_open`, then
sends each new event as it is committed (a wake-up, or a poll every 2 s when a notification is missed) and hands each
control row that appears unhandled while it is open to `on_control`, once per stream; an idle stream gets a
`keep-alive` comment every `ping_s`. A hang-up ends the stream wherever it is, as a cancellation, even
when a database read reports it as an error of its own. A stream whose `Wakeup` is closed (a newer stream of its
session took its place) ends at once when a send of its waits for the client (one that stopped reading never lets it
finish), else at its next look, and is cancelled wherever it waits should it still run `CLOSE_GRACE_S` later.
`on_end` runs once the stream has ended, however it ended.
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

import anyio
import psycopg
from pydantic import BaseModel, TypeAdapter
from sqlalchemy import func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sse_starlette import EventSourceResponse, ServerSentEvent
from starlette.types import Message, Receive, Scope, Send

from desk.api.metrics import metric_row
from desk.api.store import Ids, Replayed, lock_events
from desk.contracts import InboxNotice
from desk.db.models import RunEvent
from desk.db.session import libpq_url
from desk.events import EvDemoInbox, SseEvent

RUN_EVENTS = RunEvent.__table__
OWNER = "owner"                                  # an InboxNotice's `to` for an owner alert
CHANNEL = "desk_run_events"
SIGNED_TYPES = frozenset({"message", "receipt", "held", "resolved"})   # built only by deliver()
CONTROL_TYPES = frozenset({"run_resumable", "decision_due", "decision_pending"})
_EVENT = TypeAdapter(SseEvent)
POLL_S = 2.0
PING_S = 15.0
RECONNECT_S = 1.0
# The comment a stream starts with: no event, data or id, so it never moves the client's Last-Event-ID.
OPENING = ServerSentEvent(comment="open")
# How long a closed stream with no send waiting has to end at its next look before it is cancelled wherever it waits.
CLOSE_GRACE_S = 1.0
logger = logging.getLogger(__name__)


async def _notify(conn: AsyncConnection, session_id: str) -> None:
    """Wake the session's streams once the transaction commits."""
    await conn.execute(select(func.pg_notify(CHANNEL, session_id)))


async def append_event(conn: AsyncConnection, ids: Ids, event: BaseModel, *, replayed: Replayed | None = None) -> int:
    """Publish an SSE event to the session; returns its `seq`. Only deliver() and emit() call this. A `replayed`
    event (recorded history) is written at its moment with its `replay_id` and wakes no stream: no one holds a
    replayed session's credential."""
    event = _EVENT.validate_python(event.model_dump())
    await lock_events(conn, ids.session_id)
    last = (await conn.execute(select(func.max(RUN_EVENTS.c.seq)).where(
        RUN_EVENTS.c.session_id == ids.session_id, RUN_EVENTS.c.kind == "sse"))).scalar_one()
    seq = 1 if last is None else last + 1
    recorded = {} if replayed is None else {"created_at": replayed.at, "replay_id": replayed.replay_id}
    await conn.execute(insert(RUN_EVENTS).values(
        copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id, kind="sse", seq=seq,
        type=event.type, payload=event.model_dump(mode="json"), **recorded))
    if replayed is None:
        await _notify(conn, ids.session_id)
    return seq


async def emit(conn: AsyncConnection, ids: Ids, event: Any) -> int:
    """Publish one of the seven unsigned events (writing, turn_end, owner_joined, owner_typing, owner_left,
    demo_inbox, error)."""
    if not isinstance(event, BaseModel) or getattr(event, "type", None) in SIGNED_TYPES:
        raise TypeError("emit() publishes unsigned events only; signed ones go through deliver()")
    return await append_event(conn, ids, event)


async def emit_inbox(conn: AsyncConnection, ids: Ids, notices: Iterable[InboxNotice]) -> list[int]:
    """Publish the kernel's Demo inbox notices meant for the session's visitor as code-free `demo_inbox` events; returns
    their `seq`s. An owner alert (`to == "owner"`) never reaches the session, and an entry already published to it isn't
    published again (a repeated `/execute` answers with the stored result, notices included)."""
    seqs = []
    for notice in notices:
        if notice.to == OWNER:
            continue
        await lock_events(conn, ids.session_id)              # the check and the write, one transaction at a time
        published = (await conn.execute(select(RUN_EVENTS.c.id).where(
            RUN_EVENTS.c.copy_id == ids.copy_id, RUN_EVENTS.c.session_id == ids.session_id,
            RUN_EVENTS.c.kind == "sse", RUN_EVENTS.c.type == "demo_inbox",
            RUN_EVENTS.c.payload["entry_id"].astext == notice.entry_id).limit(1))).first()
        if published is None:
            seqs.append(await emit(conn, ids, EvDemoInbox(type="demo_inbox", entry_id=notice.entry_id, to=notice.to,
                                                          preview=notice.preview)))
    return seqs


async def append_control(conn: AsyncConnection, ids: Ids, type: str, payload: dict) -> int | None:
    """Leave work for the next request holding the session's credential (IDs and signed records only, never a
    credential) and wake its streams; returns the row's id. A decision already due and unhandled isn't written
    again (None)."""
    if type not in CONTROL_TYPES:
        raise ValueError(f"{type!r} is not a control row type")
    row_id = (await conn.execute(pg_insert(RUN_EVENTS).values(
        copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id, kind="control", type=type,
        payload=payload).on_conflict_do_nothing().returning(RUN_EVENTS.c.id))).scalar_one_or_none()
    if row_id is not None:
        await _notify(conn, ids.session_id)
    return row_id


async def claim_control(conn: AsyncConnection, row_id: int) -> bool:
    """Mark a control row handled, in the caller's transaction; True for the one caller that claimed it."""
    claimed = await conn.execute(update(RUN_EVENTS).where(
        RUN_EVENTS.c.id == row_id, RUN_EVENTS.c.kind == "control", RUN_EVENTS.c.handled_at.is_(None))
        .values(handled_at=func.now()).returning(RUN_EVENTS.c.id))
    return claimed.first() is not None


# The stream ------------------------------------------------------------------------------------------------


class Wakeup:
    """A stream's wake-up: set by the listener when its session gets a notification. `close()` ends the stream it
    wakes, a newer stream of the session having taken its place: it wakes the stream's frames, which end at their next
    look, and has the stream's response (`EventStream`, while it runs) end itself, at once if a send waits."""

    def __init__(self) -> None:
        self._event = asyncio.Event()
        self.closed = False
        self._on_close: Callable[[], None] | None = None     # the running response's own end

    def set(self) -> None:
        self._event.set()

    def close(self) -> None:
        self.closed = True
        self._event.set()
        if self._on_close is not None:
            self._on_close()

    async def wait(self, timeout: float) -> bool:
        """True when woken within `timeout` seconds; either way the next wait starts afresh."""
        try:
            await asyncio.wait_for(self._event.wait(), timeout)
            return True
        except TimeoutError:
            return False
        finally:
            self._event.clear()


class Listener:
    """The process's one `LISTEN desk_run_events` connection, fanning wake-ups out by session ID.

    `start()` connects and listens before it returns; if the connection drops, every stream is woken (they
    re-read) and it reconnects. Streams poll as well, so a lost notification delays an event by at most the
    poll interval, never loses it.
    """

    def __init__(self, database_url: str):
        self._conninfo = libpq_url(database_url)
        self._streams: dict[str, set[Wakeup]] = {}
        self._conn: psycopg.AsyncConnection | None = None
        self._task: asyncio.Task | None = None
        self.backend_pid: int | None = None

    async def __aenter__(self) -> "Listener":
        await self.start()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    async def start(self) -> None:
        if self._task is None:
            await self._connect()
            self._task = asyncio.create_task(self._run(), name="run-events-listener")

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self._disconnect()

    @contextlib.asynccontextmanager
    async def subscribe(self, session_id: str, wakeup: Wakeup | None = None) -> AsyncIterator[Wakeup]:
        """Wake `wakeup` (a new one when None) on each notification for the session while the block runs."""
        wakeup = wakeup or Wakeup()
        self._streams.setdefault(session_id, set()).add(wakeup)
        try:
            yield wakeup
        finally:
            streams = self._streams.get(session_id, set())
            streams.discard(wakeup)
            if not streams:
                self._streams.pop(session_id, None)

    async def _connect(self) -> None:
        conn = await psycopg.AsyncConnection.connect(self._conninfo, autocommit=True,
                                                     application_name="desk-api-run-events")
        await conn.execute(f"LISTEN {CHANNEL}")
        self._conn, self.backend_pid = conn, conn.info.backend_pid

    async def _disconnect(self) -> None:
        conn, self._conn, self.backend_pid = self._conn, None, None
        if conn is not None:
            with contextlib.suppress(Exception):
                await conn.close()

    def _wake(self, session_id: str | None = None) -> None:
        targets = self._streams.values() if session_id is None else [self._streams.get(session_id, set())]
        for streams in targets:
            for wakeup in streams:
                wakeup.set()

    async def _run(self) -> None:
        while True:
            try:
                if self._conn is None:
                    await self._connect()
                    self._wake()
                async for notify in self._conn.notifies():
                    self._wake(notify.payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("the run events listener lost its database connection; reconnecting")
                await self._disconnect()
                self._wake()
                await asyncio.sleep(RECONNECT_S)


@dataclass(frozen=True)
class ControlRow:
    id: int
    type: str
    payload: dict
    copy_id: str
    desk_id: str | None
    session_id: str


def _frame(seq: int, payload: dict) -> ServerSentEvent:
    event = _EVENT.validate_python(payload)          # a stored row that isn't an SseEvent never reaches a visitor
    return ServerSentEvent(data=event.model_dump_json(), event=event.type, id=str(seq))


async def _events_after(engine: AsyncEngine, ids: Ids, after: int) -> list[tuple[int, dict]]:
    async with engine.connect() as conn:
        rows = await conn.execute(select(RUN_EVENTS.c.seq, RUN_EVENTS.c.payload).where(
            RUN_EVENTS.c.copy_id == ids.copy_id, RUN_EVENTS.c.session_id == ids.session_id,
            RUN_EVENTS.c.kind == "sse", RUN_EVENTS.c.seq > after).order_by(RUN_EVENTS.c.seq))
        return [(row.seq, row.payload) for row in rows]


async def unhandled_controls(conn: AsyncConnection, ids: Ids) -> list[ControlRow]:
    """The session's control rows no request has handled yet, oldest first, read in the caller's transaction."""
    rows = await conn.execute(select(RUN_EVENTS).where(
        RUN_EVENTS.c.copy_id == ids.copy_id, RUN_EVENTS.c.session_id == ids.session_id,
        RUN_EVENTS.c.kind == "control", RUN_EVENTS.c.handled_at.is_(None)).order_by(RUN_EVENTS.c.id))
    return [ControlRow(id=row.id, type=row.type, payload=row.payload, copy_id=row.copy_id, desk_id=row.desk_id,
                       session_id=row.session_id) for row in rows]


async def _unhandled_controls(engine: AsyncEngine, ids: Ids) -> list[ControlRow]:
    async with engine.connect() as conn:
        found = await unhandled_controls(conn, ids)
        await conn.commit()
        return found


def being_cancelled() -> bool:
    """Whether the running task is being cancelled (a client's hang-up, a shutdown), even when a database driver
    reported the cancellation as an error of its own."""
    task = asyncio.current_task()
    return task is not None and task.cancelling() > 0


async def _frames(engine: AsyncEngine, listener: Listener, ids: Ids, after: int,
                  on_control: Callable[[ControlRow], Awaitable[None]] | None,
                  on_open: Callable[[], Awaitable[None]] | None, poll_s: float,
                  wakeup: Wakeup) -> AsyncIterator[ServerSentEvent]:
    try:
        async with listener.subscribe(ids.session_id, wakeup) as wakeup:
            # Control rows are tracked by the IDs this stream has seen, not by a high-water mark: a row's ID is
            # taken at insert and rows commit in any order, so a lower ID can become visible after a higher one.
            # Rows already waiting are on_open's.
            handed = set() if on_control is None else {row.id for row in await _unhandled_controls(engine, ids)}
            replay = await _events_after(engine, ids, after)
            # Behind CloudFront and the load balancer, a response's headers reach the browser only with its first body
            # byte, and EventSource opens on them: the comment opens it now, not at the first event or keep-alive. It
            # comes once the replay is read, so the replay follows it with nothing awaited between them (the web takes
            # a quiet moment after the open as having caught up).
            yield OPENING
            for seq, payload in replay:
                yield _frame(seq, payload)
                after = seq
            if on_open is not None:
                await on_open()
            while not wakeup.closed:
                if on_control is not None:
                    unhandled = await _unhandled_controls(engine, ids)
                    handed &= {row.id for row in unhandled}           # a handled row is never unhandled again
                    for row in unhandled:
                        if row.id not in handed:                      # each row is handed over once per stream
                            handed.add(row.id)
                            await on_control(row)
                for seq, payload in await _events_after(engine, ids, after):
                    yield _frame(seq, payload)
                    after = seq
                await wakeup.wait(poll_s)
    except Exception:
        # A hang-up (or a shutdown) cancels the stream wherever it is, and a database driver may report the
        # cancellation as an error of its own: SQLAlchemy's pool ping does, from a `finally` that changes autocommit
        # on a connection still busy. While the task is being cancelled, such an error is the cancellation.
        if being_cancelled():
            raise asyncio.CancelledError() from None
        raise


class EventStream(EventSourceResponse):
    """An SSE response that its `wakeup`'s `close()` ends wherever it waits, and that calls `on_end` once it has ended,
    however it ended: a normal end, a hang-up, an error or a close, whether or not its body ever started.

    Closed while one of its sends waits (in a server, only a client that isn't reading keeps a send waiting), it is
    cancelled at once. Closed otherwise, its frames end at their next look, which the close wakes, and its last send
    goes out; should it still run `CLOSE_GRACE_S` later (a client that stopped reading just then), it is cancelled."""

    def __init__(self, content: Any, *, wakeup: Wakeup, on_end: Callable[[], None] | None = None, **options: Any):
        super().__init__(content, **options)
        self.wakeup, self.on_end = wakeup, on_end

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        sending = 0

        async def counted(message: Message) -> None:
            nonlocal sending
            sending += 1
            try:
                await send(message)
            finally:
                sending -= 1

        try:
            with anyio.CancelScope() as running:
                def close() -> None:
                    if sending:                    # a send waits for a client that isn't reading: end now
                        running.cancel()
                    else:                          # end at the next look, which the close woke, or be cancelled
                        running.deadline = min(running.deadline, anyio.current_time() + CLOSE_GRACE_S)

                self.wakeup._on_close = close
                if self.wakeup.closed:            # closed before it began
                    close()
                await super().__call__(scope, receive, counted)
        finally:
            self.wakeup._on_close = None
            if self.on_end is not None:
                self.on_end()


def event_stream(engine: AsyncEngine, listener: Listener, ids: Ids, last_event_id: int | None, *,
                 on_control: Callable[[ControlRow], Awaitable[None]] | None,
                 on_open: Callable[[], Awaitable[None]] | None, ping_s: float = PING_S,
                 poll_s: float = POLL_S, wakeup: Wakeup | None = None,
                 on_end: Callable[[], None] | None = None) -> EventStream:
    """An `open` comment as soon as the replay is read, then the session's events after `last_event_id` (all of them
    when None), then live ones: SSE `event` is the event's `type` and `id` its `seq`. `on_open` runs after the replay
    (the control rows and pending work already waiting); `on_control` gets each control row that appears unhandled
    while the stream is open, whatever order the rows' writers commit in. `wakeup`, when given, is the stream's own,
    and its `close()` ends the stream (`EventStream`); `on_end` runs once the stream has ended, however it ended.

    Both callbacks run inside the stream and hold back its frames until they return, so they return promptly
    and start longer work (a resumed turn) as a task. A row can reach `on_open` and `on_control`, or several
    streams; `claim_control` decides which caller handles it."""
    wakeup = wakeup or Wakeup()
    frames = _frames(engine, listener, ids, last_event_id or 0, on_control, on_open, poll_s, wakeup)
    return EventStream(frames, wakeup=wakeup, on_end=on_end, ping=ping_s,
                       ping_message_factory=lambda: ServerSentEvent(comment="keep-alive"))


async def append_metric(conn: AsyncConnection, ids: Ids, metric: BaseModel) -> int:
    """Record a `RevealMetric` or `TurnMetric` for the session (no wake-up); returns the row's id."""
    type, payload = metric_row(metric)
    return (await conn.execute(insert(RUN_EVENTS).values(
        copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id, kind="metric", type=type,
        payload=payload).returning(RUN_EVENTS.c.id))).scalar_one()
