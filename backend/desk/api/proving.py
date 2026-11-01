"""Proving routes' waits (Plan 02b, Task 7; master "How proofs run").

Drafting and proving rules can take longer than a browser request should wait, so each request under
`/api/owner/policy/` runs its work as a task registered in this process by `(desk_id, path, sha256(body))`, and
waits for it until `PROVING_WAIT_S` after the request started, model drafting included. Past that it answers 202
`ProvingPending`, naming the same path and body to send again; the owner app re-sends it every 3 s. A re-post joins
the task still running, or takes its answer, kept 10 minutes. The work runs on whatever the request does: a client
that goes away, or a request answered 202, never cancels it.

The error a task ends with is its answer too, kept for exactly one taker: the request waiting for it, or, when that
request was answered 202, the next re-post. So a retry after a 202 hears "Rules can't be checked right now", a model
that couldn't answer, or a confirm that found the rules changed and drafted them again (`AnswerError`), rather than
running the work again behind the owner's back; the re-post after that runs it again (setup's rules re-post the
cards they stored and the kernel's draft is idempotent, so that re-reads the draft until it is proved or rejected).
An error is kept without the frames it was raised in, which hold the owner's credential view, and one that isn't an
answer the app gives (`answers`, and every `AnswerError`) is logged as it lands, since no request may be waiting to
hear it. Both drop the errors it was raised while handling, whose messages may carry what those frames held: the log
has the error and where it was raised, never its chain. Work that changes the Desk's rules drops the Desk's other
kept answers (`forget`), since they were about the draft before. Answers are kept only in memory; in a deploy's
overlap the retry may reach the other task and start over ("Connections and state"). The lifespan cancels what is
still running when the process stops.
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from desk.api.owner_streaming import Display, displaying, failure

PROVING_WAIT_S = 25           # the most a proving request waits for its work before answering 202
RESULT_KEPT_S = 600           # how long a finished answer stays for a re-post to take

logger = logging.getLogger(__name__)


class Pending:
    """The work is still running at the request's deadline: the route answers 202."""


PENDING = Pending()

Key = tuple[str, str, str]    # (desk_id, path, sha256 of the body)


class AnswerError(Exception):
    """An error the work answers with, as the app's own error answers are: never logged as a failure."""


@dataclass
class _Entry:
    task: asyncio.Task | None
    result: Any = None
    error: BaseException | None = None
    done_at: float | None = None
    display: Display | None = None


class Proving:
    """The proving work running or answered in this process, by key. `answers` are the error types the app answers
    with (an `AnswerError` always is one); the work's other errors are logged as they land."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, *,
                 answers: tuple[type[BaseException], ...] = ()):
        self._clock = clock
        self._answers = (AnswerError, *answers)
        self._entries: dict[Key, _Entry] = {}

    async def run(self, key: Key, work: Callable[[], Awaitable[Any]], *, deadline: float,
                  admit: Callable[[], Awaitable[None]], display: bool = False) -> Any:
        """The work's answer, or `PENDING` once the clock passes `deadline` with it still running. A key with work
        running is joined and a key with a kept answer takes it; otherwise `admit` runs first (the route's limits,
        which a re-post that joins never counts again), then the work starts. The work's error is raised here and
        taken: whoever hears it first, no later re-post hears it again."""
        entry = await self._start(key, work, admit=admit, display=display)
        if entry.task is None:                            # a kept answer
            return self._take(key, entry, entry.result, entry.error)
        task = entry.task
        done, _ = await asyncio.wait({task}, timeout=max(deadline - self._clock(), 0))
        if not done:                                      # asyncio.wait never cancels what it waits for
            return PENDING
        error = None if task.cancelled() else task.exception()
        if error is not None:
            return self._take(key, entry, None, error)
        return task.result()                              # raises CancelledError when the lifespan cancelled it

    async def _start(self, key: Key, work: Callable[[], Awaitable[Any]], *,
                     admit: Callable[[], Awaitable[None]], display: bool = False) -> _Entry:
        self._forget_old()
        entry = self._entries.get(key)
        if entry is None:
            await admit()
            entry = self._entries.get(key)                # another request may have started it meanwhile
            if entry is None:
                channel = Display() if display else None
                with displaying(channel):
                    entry = _Entry(task=asyncio.create_task(work(), name="desk-proving"), display=channel)
                self._entries[key] = entry
                entry.task.add_done_callback(lambda task: self._settled(key, entry, task))
        return entry

    async def stream(self, key: Key, work: Callable[[], Awaitable[Any]], *,
                     admit: Callable[[], Awaitable[None]]) -> AsyncIterator[dict]:
        """Admit before HTTP starts; subscribe to the same work a JSON re-post joins."""
        entry = await self._start(key, work, admit=admit, display=True)
        assert entry.display is not None

        async def events():
            async for item in entry.display.events():
                yield item
                if item["event"] == "error" and self._entries.get(key) is entry:
                    del self._entries[key]  # an error is heard once, as on the JSON path

        return events()

    def _take(self, key: Key, entry: _Entry, result: Any, error: BaseException | None) -> Any:
        if error is None:
            return result
        if self._entries.get(key) is entry:               # heard once: no later re-post hears it again
            del self._entries[key]
        raise error

    def _settled(self, key: Key, entry: _Entry, task: asyncio.Task) -> None:
        if task.cancelled():
            if self._entries.get(key) is entry:
                del self._entries[key]
            if entry.display is not None:                 # its subscribers stop waiting
                entry.display.finish("error", failure(asyncio.CancelledError()))
            return
        error = task.exception()                          # reading the error marks it retrieved
        if error is None:
            entry.result = task.result()
        else:
            error.__context__ = error.__cause__ = None    # logged and kept without the errors it was raised while
            if not isinstance(error, self._answers):      # handling, whose messages may carry what its frames held
                logger.error("proving work on %s failed", key[1], exc_info=(type(error), error, error.__traceback__))
            entry.error = error.with_traceback(None)      # kept without the frames: they hold the owner's credential
        if entry.display is not None:
            if error is None:
                entry.display.finish("final", entry.result.model_dump(mode="json"))
            else:
                entry.display.finish("error", failure(error))
        entry.task, entry.done_at = None, self._clock()

    def forget(self, desk_id: str) -> None:
        """Drop the Desk's kept answers (work still running keeps going): once its rules change, an answer about the
        draft before is no longer one to hand a re-post."""
        for key, entry in list(self._entries.items()):
            if key[0] == desk_id and entry.task is None:
                del self._entries[key]

    def _forget_old(self) -> None:
        now = self._clock()
        for key, entry in list(self._entries.items()):
            if entry.done_at is not None and now - entry.done_at > RESULT_KEPT_S:
                del self._entries[key]

    async def close(self) -> None:
        """Cancel the work still running (the lifespan's end)."""
        running = [entry.task for entry in self._entries.values() if entry.task is not None]
        for task in running:
            task.cancel()
        for task in running:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._entries.clear()
