"""Hold setup's consent work until it lands, or cancel it before the database pools close."""

import asyncio
import contextlib
from collections.abc import Coroutine
from typing import Any


class ConsentRuns:
    """Only live runs are kept here; the interview row holds their durable outcome."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}

    def holds(self, interview_id: str) -> bool:
        return interview_id in self._tasks

    def start(self, interview_id: str, work: Coroutine[Any, Any, Any]) -> asyncio.Task:
        task = asyncio.create_task(work, name="desk-setup-consent")
        self._tasks[interview_id] = task
        task.add_done_callback(lambda done: self._settled(interview_id, done))
        return task

    def _settled(self, interview_id: str, task: asyncio.Task) -> None:
        if self._tasks.get(interview_id) is task:
            del self._tasks[interview_id]
        if not task.cancelled():
            error = task.exception()       # retrieve failures even after the request answered 202
            if error is not None:
                error.__context__ = error.__cause__ = None
                error.with_traceback(None)

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
