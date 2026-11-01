"""Hold setup's owner turns until they land, or cancel them before the database pools close."""

import asyncio
import contextlib
import secrets
from collections.abc import Coroutine
from typing import Any

from desk.api.owner_streaming import Display, displaying, failure


class TurnRuns:
    """Only live runs are kept here; the interview row holds their durable outcome."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}
        self._displays: dict[str, Display] = {}

    def holds(self, interview_id: str) -> bool:
        return interview_id in self._tasks

    def start(self, interview_id: str, work: Coroutine[Any, Any, Any]) -> asyncio.Task:
        display = Display(run=secrets.token_hex(8))
        self._displays[interview_id] = display
        with displaying(display):
            task = asyncio.create_task(work, name="desk-setup-turn")
        self._tasks[interview_id] = task
        task.add_done_callback(lambda done: self._settled(interview_id, done))
        return task

    def _settled(self, interview_id: str, task: asyncio.Task) -> None:
        if self._tasks.get(interview_id) is task:
            del self._tasks[interview_id]
            display = self._displays.pop(interview_id, None)
            if display is not None and not display.finished:     # cancelled before the turn could say how it ended
                display.finish("error", {"run": display.run, "error": failure(asyncio.CancelledError())["error"]})
        if not task.cancelled():
            error = task.exception()       # retrieve failures even after the request answered 202
            if error is not None:
                error.__context__ = error.__cause__ = None
                error.with_traceback(None)

    def display(self, interview_id: str) -> Display | None:
        return self._displays.get(interview_id)

    async def wait(self, interview_id: str) -> None:
        """Wait for a held run without cancelling it when this waiter goes away."""
        task = self._tasks.get(interview_id)
        if task is not None:
            await asyncio.shield(task)

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
