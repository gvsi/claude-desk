"""The demo visitor: an AI that plays a customer in a visitor chat on the owner's own Desk, so an owner can watch a live
conversation and try Take over, Whisper and Hand back from the owner app without a second browser. It is the visitor
side's counterpart of the built-in visiting agent (`agents.py`), and its runs are kept the same way.

It is a visitor like any other. It talks to the Desk only as a separate client of the API's own public visitor
endpoints at `settings.a2a_loopback` (no proxy from the environment, no redirects), never through the store, the loop
or the kernel: `POST /api/public/desks/{slug}/sessions` opens its session, and the cookie that answer sets is the one
credential it holds, sent by hand with each request (the cookie is `Secure` and the loopback is plain HTTP, so a
cookie jar wouldn't send it back) and kept in its run's coroutine and that run's own client alone, never in the run's
record, a log or a model request. So the kernel, the reply check, the visitor limits and the AI disclosure treat it as
any visitor; a loopback peer with no forwarded address is exempt from the per-address limits only (`deps.client_ip`),
and its own caps keep it small: one running per copy, three starts a copy an hour.

It keeps the session's event stream (`GET .../events`) open for the whole run, since an owner's whisper or hand-back
wakes Claude only while the visitor's credential is present. Each step:

1. Wait for the Desk: until Claude's turn ends (`turn_end`), or, once the owner has taken the chat over, until the
   owner says something or hands it back. While the owner has the chat and stays quiet, it sends its one fixed nudge
   (`DEMO_VISITOR_NUDGE`) after 90 seconds, with no model call, and ends `owner_silent` after four minutes.
2. Its model reads what a visitor saw since its last step: each delivered message's plain text labelled by who said
   it (Claude, or the owner by the name the stream carries, as a person), each request's signed status, and where the
   owner joined and left, all inside `<desk_reply>` (`prompts.wrap`), as information.
3. One structured model call (route `demo_visitor`, low effort, `VisitorStep`), recorded against the copy and the
   owner's session that started it. In production, today's model budget is checked first, and once it is spent the
   run ends `budget` with no further call.
4. A human pause: reading (two seconds, plus a little for each character it read, at most four), then a typing
   signal (`POST .../typing`, so the owner sees its dots) and typing time; six seconds at most together.
5. It sends the message (`POST .../messages`).

Its persona is the fixed line of the Desk's set (`prompts.DEMO_VISITORS`, chosen by the caller with
`agents.demo_task_set`), so no business's, owner's or visitor's words reach its model except the chat it is shown.

A run ends `done` once its brief is done (`finished`), at a cap (`limit`: ten messages, twelve model calls or fifteen
minutes) or when the owner stays quiet (`owner_silent`); `stopped` when the owner stops it (`stopped_by_owner`, with no
further model call, and its stream closed) or the chat's session is gone (`chat_ended`: a 401 `no_session`, a closed
stream or the stream's `session` error); `failed` for today's budget (`budget`) or a model or HTTP failure (`failed`,
logged by type only, never with the Desk's text). Runs live in this process's memory (`DemoVisitors`): the 50 newest
that have ended, for an hour, and every one still running, each readable by its copy alone.
"""

import asyncio
import contextlib
import logging
import math
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from urllib.parse import quote

import httpx
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.ext.asyncio import AsyncEngine

from desk.api.cookies import VISITOR_COOKIE
from desk.api.metrics import over_daily_budget, record_model_call
from desk.api.model import CONVERSATION_MODEL, ModelClient, ModelRequest, ModelResponse, ModelUnavailable
from desk.api.prompts import (
    DEMO_VISITOR_LINES,
    DEMO_VISITOR_NOTES,
    DEMO_VISITOR_NUDGE,
    DEMO_VISITOR_OWNER,
    DEMO_VISITOR_SYSTEM,
    DEMO_VISITORS,
    DESK_REPLY_TAG,
    RECEIPT_LINE,
    DemoTaskSet,
    VisitorStep,
    demo_visitor_brief,
    wrap,
)
from desk.api.schemas import DemoVisitorEnded, DemoVisitorRun, VisitorSession
from desk.api.settings import Settings
from desk.api.store import Ids
from desk.events import SseEvent

logger = logging.getLogger(__name__)

ROUTE = "demo_visitor"
MAX_MESSAGES = 10               # messages a run sends the Desk, its one nudge included
MAX_MODEL_CALLS = 12
RUN_LIMIT = timedelta(minutes=15)
MAX_TOKENS = 1024               # one short message as JSON
MAX_RUNS = 50                   # ended runs kept, the newest; running ones are always kept
RUN_LIFE = timedelta(hours=1)   # how long an ended run's record, and a start, count
STARTS_PER_HOUR = 3             # a copy's starts
NUDGE_AFTER_S = 90.0            # the owner quiet this long after taking the chat over: one "Are you still there?"
OWNER_SILENT_S = 240.0          # and this long: the run ends
READING_MIN_S, READING_MAX_S, READING_PER_CHAR_S = 2.0, 4.0, 0.02
TYPING_PER_CHAR_S = 0.04
PAUSE_MAX_S = 6.0               # reading and typing together
STOP_WAIT_S = 10.0              # how long `stop` waits for the run to end
HTTP_TIMEOUT = httpx.Timeout(60.0)    # the stream's reads too: the API pings it every 15 seconds

# How each way of ending leaves the run.
STATES: dict[DemoVisitorEnded, str] = {
    "finished": "done", "limit": "done", "owner_silent": "done", "stopped_by_owner": "stopped",
    "chat_ended": "stopped", "budget": "failed", "failed": "failed"}

Record = Callable[[ModelResponse], Awaitable[None]]
Spent = Callable[[], Awaitable[bool]]
Sleep = Callable[[float], Awaitable[None]]
Opened = Callable[[DemoVisitorRun], Awaitable[None]]
OnOpen = Callable[[Ids, DemoVisitorRun], Awaitable[None]]
EVENT: TypeAdapter = TypeAdapter(SseEvent)


class RunFailed(Exception):
    """The run can't go on; the message says why without any of the Desk's or the model's text."""


class _Ended(Exception):
    """The run ends, as `how` says."""

    def __init__(self, how: DemoVisitorEnded):
        super().__init__(how)
        self.how = how


class TooManyStarts(Exception):
    """The copy started `STARTS_PER_HOUR` demo visitors within the hour: another fits in `retry_after` seconds."""

    def __init__(self, retry_after: int):
        super().__init__(f"another demo visitor fits in {retry_after} s")
        self.retry_after = retry_after


class KeyReused(Exception):
    """The idempotency key started a run in the copy on another Desk."""


# The event stream -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Seen:
    at: datetime                # when the run read it, by its clock
    event: object               # an `SseEvent`


class _Feed:
    """The session's events as the open stream brings them, each with when it came, and whether the stream has ended
    (`failed` when it sent something that isn't an event the API sends)."""

    def __init__(self) -> None:
        self.events: list[_Seen] = []
        self.ended = False
        self.failed = False
        self._changed = asyncio.Event()

    def push(self, at: datetime, event: object) -> None:
        self.events.append(_Seen(at, event))
        self._wake()

    def end(self, *, failed: bool = False) -> None:
        self.ended, self.failed = True, self.failed or failed
        self._wake()

    def _wake(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    async def after(self, count: int) -> None:
        """Return once the feed holds more than `count` events, or has ended."""
        while len(self.events) <= count and not self.ended:
            await self._changed.wait()


async def _read(response: httpx.Response, feed: _Feed, clock: Callable[[], datetime]) -> None:
    """Read the stream's frames into `feed` until it ends: each frame's `data` is one event (a comment, the keep-alive,
    carries none). Anything else ends it as failed; a dropped connection ends it."""
    data: list[str] = []
    try:
        async for line in response.aiter_lines():
            if line:
                name, _, value = line.partition(":")
                if name == "data":
                    data.append(value[1:] if value.startswith(" ") else value)
            elif data:
                feed.push(clock(), EVENT.validate_json("\n".join(data)))
                data = []
    except ValidationError:
        logger.warning("a demo visitor's stream sent a frame that isn't an event")
        feed.end(failed=True)
    except httpx.HTTPError as error:
        logger.info("a demo visitor's stream dropped (%s)", type(error).__name__)
    finally:
        feed.end()


@contextlib.asynccontextmanager
async def _listening(http: httpx.AsyncClient, path: str, cookie: str,
                     clock: Callable[[], datetime]) -> AsyncIterator[_Feed]:
    """The session's event stream, open (from its first event) while the block runs, read into a `_Feed` in a task of
    its own; closed on the way out, however the block ends."""
    async with contextlib.AsyncExitStack() as stack:
        try:
            response = await stack.enter_async_context(http.stream(
                "GET", f"{path}/events", headers={"Cookie": cookie, "Accept": "text/event-stream"}))
        except httpx.HTTPError as error:
            raise RunFailed(f"the event stream couldn't open ({type(error).__name__})") from None
        if response.status_code == 401:
            raise _Ended("chat_ended")
        if response.status_code != 200:
            raise RunFailed(f"the event stream answered {response.status_code}")
        feed = _Feed()
        reader = asyncio.create_task(_read(response, feed, clock), name="desk-demo-visitor-stream")
        try:
            yield feed
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)


# What the visitor saw ---------------------------------------------------------------------------------------------


def _owner_names(events: Sequence[_Seen]) -> list[str]:
    """The owner's name as of each event: the one the latest `owner_joined` up to it carried."""
    name, names = DEMO_VISITOR_OWNER, []
    for seen in events:
        if getattr(seen.event, "type", None) == "owner_joined":
            name = seen.event.name
        names.append(name)
    return names


def _lines(events: Sequence[_Seen], start: int) -> list[str]:
    """How the chat's events from `start` on read to the visitor's model, each labelled by who said it (the Desk's
    own text, which the caller wraps)."""
    names, lines = _owner_names(events), []
    for index in range(start, len(events)):
        event = events[index].event
        kind = event.type
        if kind == "message":
            said = "\n".join(block.text for block in event.blocks)
            lines.append(DEMO_VISITOR_LINES[event.author].format(name=names[index], text=said))
        elif kind in ("receipt", "held", "resolved"):
            lines.append(RECEIPT_LINE.format(state=event.state, text=event.visitor_plain))
        elif kind == "owner_joined":
            lines.append(DEMO_VISITOR_LINES["joined"].format(name=event.name))
        elif kind == "owner_left":
            lines.append(DEMO_VISITOR_LINES["left"])
        elif kind == "error":
            lines.append(DEMO_VISITOR_LINES["error"])
    return lines


def _user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _shown(lines: list[str], *, nudged: bool) -> dict:
    """The visitor's next turn of input: the fixed note of its nudge, if it sent one, then what the chat showed,
    wrapped as information (or the fixed note that nothing new showed)."""
    parts = [DEMO_VISITOR_NOTES["nudged"]] if nudged else []
    parts.append(wrap(DESK_REPLY_TAG, "\n".join(lines)) if lines else DEMO_VISITOR_NOTES["quiet"])
    return _user("\n".join(parts))


@dataclass
class _Answer:
    """Where the chat stands after the visitor's message: whether the Desk has answered it, the session's mode as the
    stream last said, and when the owner last showed a sign of life since the message (joined or typing)."""

    answered: bool
    mode: str
    heard: datetime | None


def _answer(events: Sequence[_Seen], mark: int) -> _Answer:
    """Whether the events after `mark` (the feed's length when the message went) answer it: Claude's turn ending while
    Claude has the chat, or the owner's words or leaving while the owner has it. The stream's `session` error is the
    chat ending."""
    mode, heard = "ai", None
    for index, seen in enumerate(events):
        event = seen.event
        kind = event.type
        if kind == "owner_joined":
            mode = "owner"
        elif kind == "owner_left":
            mode = "ai"
        if index < mark:
            continue
        if kind == "error" and event.code == "session":
            raise _Ended("chat_ended")
        if kind in ("owner_joined", "owner_typing"):
            heard = seen.at
        elif kind == "owner_left" or (kind == "message" and event.author == "owner"):
            return _Answer(True, mode, heard)
        elif kind == "turn_end" and mode != "owner":
            return _Answer(True, mode, heard)
    return _Answer(False, mode, heard)


async def _first(feed: _Feed, timer: Awaitable[None]) -> None:
    """Wait until the feed changes or `timer` ends, whichever is first."""
    changed = asyncio.ensure_future(feed.after(len(feed.events)))
    timed = asyncio.ensure_future(timer)
    try:
        await asyncio.wait({changed, timed}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for waiter in (changed, timed):
            waiter.cancel()
        await asyncio.gather(changed, timed, return_exceptions=True)


# One run ------------------------------------------------------------------------------------------------------------


@dataclass
class _Chat:
    """A run's conversation with the Desk: its client, the Desk's path, its cookie and its open stream."""

    http: httpx.AsyncClient = field(repr=False)
    path: str
    cookie: str = field(repr=False)
    feed: _Feed
    run: DemoVisitorRun
    clock: Callable[[], datetime]
    sleep: Sleep
    deadline: datetime

    async def call(self, method: str, path: str, *, ok: int, json: dict | None = None) -> None:
        """One request to the Desk with the run's cookie: `RunFailed` for any answer but `ok`, and the chat's end for a
        401 `no_session`."""
        try:
            answer = await self.http.request(method, f"{self.path}{path}", headers={"Cookie": self.cookie},
                                             json=json)
        except httpx.HTTPError as error:
            raise RunFailed(f"a request to the Desk failed ({type(error).__name__})") from None
        if answer.status_code == 401:
            raise _Ended("chat_ended")
        if answer.status_code != ok:
            raise RunFailed(f"the Desk answered {answer.status_code}")

    async def write(self, message: str, *, read: int) -> None:
        """Send `message` after a human pause: reading the `read` characters it was shown, a typing signal, then the
        typing itself."""
        reading = min(READING_MAX_S, READING_MIN_S + READING_PER_CHAR_S * read)
        await self.sleep(reading)
        await self.call("POST", "/typing", ok=204)
        await self.sleep(min(TYPING_PER_CHAR_S * len(message), PAUSE_MAX_S - reading))
        await self.send(message)

    async def send(self, message: str) -> None:
        if self.run.messages_sent >= MAX_MESSAGES:
            raise _Ended("limit")
        await self.call("POST", "/messages", ok=202, json={"text": message})
        self.run.messages_sent += 1

    async def answered(self, mark: int, sent_at: datetime) -> bool:
        """Wait for the Desk's answer to the message sent when the feed held `mark` events; whether the visitor
        nudged the owner meanwhile. While the owner has the chat and says nothing, one nudge after `NUDGE_AFTER_S`,
        and the run ends after `OWNER_SILENT_S`; the run's own time limit holds throughout."""
        nudged = False
        while True:
            answer = _answer(self.feed.events, mark)
            if answer.answered:
                return nudged
            if self.feed.ended:
                if self.feed.failed:
                    raise RunFailed("the event stream sent a frame that isn't an event")
                raise _Ended("chat_ended")
            now = self.clock()
            wait = (self.deadline - now).total_seconds()
            if wait <= 0:
                raise _Ended("limit")
            if answer.mode == "owner":
                quiet = (now - max(answer.heard or sent_at, sent_at)).total_seconds()
                if quiet >= OWNER_SILENT_S:
                    raise _Ended("owner_silent")
                if not nudged and quiet >= NUDGE_AFTER_S:
                    nudged = True
                    if self.run.messages_sent < MAX_MESSAGES:
                        await self.call("POST", "/typing", ok=204)
                        await self.send(DEMO_VISITOR_NUDGE)
                    continue
                wait = min(wait, (OWNER_SILENT_S if nudged else NUDGE_AFTER_S) - quiet)
            await _first(self.feed, self.sleep(wait))


async def _step(model: ModelClient, messages: list[dict], record: Record) -> VisitorStep:
    """The visitor's next step, its usage recorded right after the call; `ModelUnavailable` when there is none."""
    request = ModelRequest(route=ROUTE, system=[{"type": "text", "text": DEMO_VISITOR_SYSTEM}],
                           messages=list(messages), model=CONVERSATION_MODEL, effort="low", max_tokens=MAX_TOKENS,
                           output_schema=VisitorStep)
    try:
        response = await model.call(request)
    except ModelUnavailable as unavailable:
        await record(unavailable.response)
        raise
    await record(response)
    if not isinstance(response.parsed, VisitorStep):
        raise ModelUnavailable(response, "no visitor step")
    return response.parsed


async def _open_session(http: httpx.AsyncClient, path: str, run: DemoVisitorRun) -> str:
    """Open a new visitor session on the Desk, its ID kept in `run`; the cookie header that names it."""
    try:
        answer = await http.post(f"{path}/sessions")
    except httpx.HTTPError as error:
        raise RunFailed(f"opening the session failed ({type(error).__name__})") from None
    if answer.status_code != 200:
        raise RunFailed(f"opening the session answered {answer.status_code}")
    try:
        opened = VisitorSession.model_validate_json(answer.content)
    except ValidationError:
        raise RunFailed("the session's answer isn't a visitor session") from None
    token = answer.cookies.get(VISITOR_COOKIE)
    if not token or opened.resumed:
        raise RunFailed("the session's answer set no new visitor cookie")
    run.session_id = opened.state.session_id
    return f"{VISITOR_COOKIE}={token}"


async def run_demo_visitor(slug: str, task_set: DemoTaskSet, http: httpx.AsyncClient, model: ModelClient,
                           run: DemoVisitorRun, *, clock: Callable[[], datetime], sleep: Sleep, record: Record,
                           spent: Spent | None = None, opened: Opened | None = None,
                           stopping: asyncio.Event | None = None) -> None:
    """Play the persona of the Desk's `task_set` in a new visitor chat on the slug's Desk through `http`, the public
    visitor endpoints' client, filling in `run` as it goes and ending it as the module docstring says. Each model call
    is recorded with `record`; `sleep` makes the human pauses and the timers. With `spent` (production: whether today's
    model budget is spent), it is asked before each step. `opened`, when given, runs once the session is open, before
    the run reads or writes anything else; it raising ends the run `failed`. A cancellation ends it `stopped_by_owner`
    once `stopping` is set (the owner pressed Stop), else `failed` (the process is stopping)."""
    started = clock()
    path = f"/api/public/desks/{quote(slug, safe='')}"
    try:                                            # everything in the run ends it, however it goes
        cookie = await _open_session(http, path, run)
        if opened is not None:
            await opened(run)
        async with _listening(http, path, cookie, clock) as feed:
            chat = _Chat(http=http, path=path, cookie=cookie, feed=feed, run=run, clock=clock, sleep=sleep,
                         deadline=started + RUN_LIMIT)
            await _converse(chat, model, task_set, record=record, spent=spent)
    except _Ended as ended:
        _end(run, ended.how)
    except ModelUnavailable:
        _fail(run, "the model was unavailable")
    except RunFailed as failed:
        _fail(run, str(failed))
    except asyncio.CancelledError:
        if stopping is not None and stopping.is_set():
            _end(run, "stopped_by_owner")
        else:
            _fail(run, "the process is stopping")
        raise
    except Exception as error:                      # logged by type only: a message can quote the Desk
        _fail(run, type(error).__name__)


async def _converse(chat: _Chat, model: ModelClient, task_set: DemoTaskSet, *, record: Record,
                    spent: Spent | None) -> None:
    """The run's steps (module docstring), until one of them ends it."""
    messages = [_user(demo_visitor_brief(task_set))]
    shown, read, calls = 0, 0, 0
    while True:
        if chat.run.messages_sent >= MAX_MESSAGES or calls >= MAX_MODEL_CALLS or chat.clock() >= chat.deadline:
            raise _Ended("limit")
        if spent is not None and await spent():
            raise _Ended("budget")
        step = await _step(model, messages, record)
        calls += 1
        if step.done:
            raise _Ended("finished")
        if not step.message.strip():
            raise RunFailed("the model wrote an empty message")
        await chat.write(step.message, read=read)
        mark = len(chat.feed.events)
        nudged = await chat.answered(mark, chat.clock())
        lines = _lines(chat.feed.events, shown)
        shown, read = len(chat.feed.events), sum(len(line) for line in lines)
        messages += [{"role": "assistant", "content": [{"type": "text", "text": step.model_dump_json()}]},
                     _shown(lines, nudged=nudged)]


def _end(run: DemoVisitorRun, how: DemoVisitorEnded) -> None:
    run.state, run.ended = STATES[how], how


def _fail(run: DemoVisitorRun, reason: str) -> None:
    _end(run, "failed")
    logger.warning("a demo visitor's run failed: %s", reason)


# The process's runs -----------------------------------------------------------------------------------------------


def visitor_client(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """A demo visitor's own client of the public visitor endpoints at `settings.a2a_loopback`, with no proxy from the
    environment and no redirects; one for each run. `transport` is a test hook (the app itself, in process), refused
    in production."""
    if transport is not None and settings.production:
        raise RuntimeError("an injected loopback transport is a test hook; production refuses it")
    return httpx.AsyncClient(base_url=settings.a2a_loopback, transport=transport, timeout=HTTP_TIMEOUT,
                             trust_env=False, follow_redirects=False)


@dataclass
class _Held:
    """A run as this process holds it: its record, the copy that started it, the idempotency key it started with,
    when, and its task. `opened` is set once its session is open or it has ended; `stopping` once the owner asked
    it to stop."""

    run: DemoVisitorRun
    copy_id: str
    key: str | None
    started_at: datetime
    opened: asyncio.Event = field(default_factory=asyncio.Event)
    stopping: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


class DemoVisitors:
    """The demo visitors running in this process, and those that ran within the hour: each in a task of its own,
    with a client of its own from `client`, its record kept for an hour once it has ended (the 50 newest), and read
    only by its copy. One runs at a time in a copy, and a copy starts at most three an hour. In `production`, each
    step first checks today's model budget (`metrics.over_daily_budget`). `on_open`, when given, runs once a run's
    session is open, with the session's IDs, before `start` answers and before the run writes; it raising ends the run
    `failed`."""

    def __init__(self, model: ModelClient, *, client: Callable[[], httpx.AsyncClient], engine: AsyncEngine,
                 clock: Callable[[], datetime], production: bool, sleep: Sleep = asyncio.sleep,
                 on_open: OnOpen | None = None):
        self._model, self._client, self._engine, self._clock = model, client, engine, clock
        self._production, self._sleep, self._on_open = production, sleep, on_open
        self._runs: dict[str, _Held] = {}                 # oldest first
        self._starts: dict[str, list[datetime]] = {}      # by copy: each start within the hour, oldest first
        self._tasks: set[asyncio.Task] = set()

    async def start(self, copy_id: str, owner_session_id: str, desk_id: str, slug: str, task_set: DemoTaskSet, *,
                    key: str | None = None) -> DemoVisitorRun:
        """Start a demo visitor on the copy's Desk (`desk_id`, whose public slug is `slug`) playing the persona of its
        `task_set`, for the owner's session, and answer it once its session is open (`session_id` set) or it has
        ended. The copy's run already going answers instead, and so does the run `key` started in the copy within the
        hour, however it ended (`KeyReused` when that run is on another Desk); neither counts as a start.
        `TooManyStarts` once the copy has started three within the hour. The checks and the start happen with no
        await between them, so of two starts racing in the process one starts."""
        now = self._clock()
        self._forget(now)
        held = self._keyed(copy_id, key, desk_id) or self._running(copy_id)
        if held is None:
            wait = self.start_wait(copy_id)
            if wait is not None:
                raise TooManyStarts(wait)
            held = self._launch(copy_id, owner_session_id, desk_id, slug, task_set, key, now)
        await held.opened.wait()
        return held.run.model_copy(deep=True)

    def start_wait(self, copy_id: str) -> int | None:
        """None while the copy may start another demo visitor this hour; else the whole seconds, at least 1, until
        its oldest start in the hour leaves it."""
        now = self._clock()
        starts = [at for at in self._starts.get(copy_id, []) if now - at < RUN_LIFE]
        if len(starts) < STARTS_PER_HOUR:
            return None
        return max(1, math.ceil((starts[0] + RUN_LIFE - now).total_seconds()))

    def run(self, run_id: str, copy_id: str) -> DemoVisitorRun | None:
        """The run as it stands, when the copy started it and it is still kept; else None."""
        self._forget(self._clock())
        held = self._runs.get(run_id)
        if held is None or held.copy_id != copy_id:
            return None
        return held.run.model_copy(deep=True)

    def newest(self, copy_id: str, desk_id: str) -> DemoVisitorRun | None:
        """The copy's newest run on the Desk still kept, or None."""
        self._forget(self._clock())
        for held in reversed(self._runs.values()):
            if held.copy_id == copy_id and held.run.desk_id == desk_id:
                return held.run.model_copy(deep=True)
        return None

    async def stop(self, run_id: str, copy_id: str) -> DemoVisitorRun | None:
        """Stop the copy's run: a running one ends `stopped_by_owner` with no further model call, its stream closed,
        and is answered once it has ended; one that ended already is answered as it is. None for a run the copy
        didn't start or that is no longer kept."""
        self._forget(self._clock())
        held = self._runs.get(run_id)
        if held is None or held.copy_id != copy_id:
            return None
        if held.run.state == "running" and held.task is not None:
            held.stopping.set()
            held.task.cancel()
            await asyncio.wait({held.task}, timeout=STOP_WAIT_S)
        return held.run.model_copy(deep=True)

    def _keyed(self, copy_id: str, key: str | None, desk_id: str) -> _Held | None:
        if key is None:
            return None
        for held in self._runs.values():
            if held.copy_id == copy_id and held.key == key:
                if held.run.desk_id != desk_id:
                    raise KeyReused
                return held
        return None

    def _running(self, copy_id: str) -> _Held | None:
        return next((held for held in self._runs.values()
                     if held.copy_id == copy_id and held.run.state == "running"), None)

    def _launch(self, copy_id: str, owner_session_id: str, desk_id: str, slug: str, task_set: DemoTaskSet,
                key: str | None, now: datetime) -> _Held:
        run = DemoVisitorRun(run_id="visitor-" + secrets.token_hex(16), desk_id=desk_id,
                             first_name=DEMO_VISITORS[task_set].first_name, session_id=None, state="running",
                             messages_sent=0, ended=None)
        held = _Held(run=run, copy_id=copy_id, key=key, started_at=now)
        self._runs[run.run_id] = held
        self._starts.setdefault(copy_id, []).append(now)
        held.task = asyncio.create_task(self._go(held, owner_session_id, slug, task_set), name="desk-demo-visitor")
        self._tasks.add(held.task)
        held.task.add_done_callback(lambda task: self._settle(held, task))
        return held

    async def _go(self, held: _Held, owner_session_id: str, slug: str, task_set: DemoTaskSet) -> None:
        """Run `held`'s demo visitor with a client of its own, closed when it ends."""

        async def record(response: ModelResponse) -> None:
            async with self._engine.connect() as conn:
                await record_model_call(conn, held.copy_id, owner_session_id, ROUTE, response)
                await conn.commit()

        async def spent() -> bool:
            async with self._engine.connect() as conn:
                return await over_daily_budget(conn, self._clock)

        async def opened(run: DemoVisitorRun) -> None:
            try:
                if self._on_open is not None and run.session_id is not None:
                    await self._on_open(Ids(copy_id=held.copy_id, desk_id=run.desk_id, session_id=run.session_id),
                                        run.model_copy(deep=True))
            finally:
                held.opened.set()

        try:
            async with self._client() as http:
                await run_demo_visitor(slug, task_set, http, self._model, held.run, clock=self._clock,
                                       sleep=self._sleep, record=record,
                                       spent=spent if self._production else None, opened=opened,
                                       stopping=held.stopping)
        except Exception as error:                  # its client, made or closed: logged by type only
            if held.run.state == "running":
                _fail(held.run, type(error).__name__)

    def _settle(self, held: _Held, task: asyncio.Task) -> None:
        """A run's task is over: a run it never got to end (cancelled before it began) ends now, and `start` is
        answered whatever happened."""
        self._tasks.discard(task)
        if held.run.state == "running":
            if held.stopping.is_set():
                _end(held.run, "stopped_by_owner")
            else:
                _fail(held.run, "the process is stopping")
        held.opened.set()

    def _forget(self, now: datetime) -> None:
        """Drop the ended runs older than an hour, then the oldest ended ones past the 50 newest, and the starts
        older than an hour. A running run is always kept."""
        ended = [run_id for run_id, held in self._runs.items() if held.run.state != "running"]
        for run_id in ended:
            if now - self._runs[run_id].started_at >= RUN_LIFE:
                del self._runs[run_id]
        ended = [run_id for run_id in ended if run_id in self._runs]
        for run_id in ended[:max(0, len(ended) - MAX_RUNS)]:
            del self._runs[run_id]
        for copy_id, starts in list(self._starts.items()):
            kept = [at for at in starts if now - at < RUN_LIFE]
            if kept:
                self._starts[copy_id] = kept
            else:
                del self._starts[copy_id]

    async def drain(self) -> None:
        """Wait until no run is going in this process."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def close(self) -> None:
        """Stop every run still going (the process is stopping); each ends `failed`."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
