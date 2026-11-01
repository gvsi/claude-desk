"""Ephemeral owner-only display text; never a source for state or kernel input."""

import asyncio
import codecs
import contextlib
import json
from collections.abc import AsyncIterator, Iterator
from contextvars import ContextVar
from typing import Any

from sse_starlette import EventSourceResponse, ServerSentEvent


class StringField:
    """Incrementally decode one top-level JSON string, including split UTF-8 and surrogate pairs.

    This is a display extractor, not a validator. The complete response still goes through the
    existing strict schema parser before anything can be saved or used.
    """

    def __init__(self, name: str):
        self.name = name
        self._utf8 = codecs.getincrementaldecoder("utf-8")()
        self._depth = 0
        self._key_expected = False
        self._key: str | None = None
        self._string = False
        self._is_key = False
        self._target = False
        self._finished = False
        self._raw = ""
        self._escaped = False
        self._unicode: str | None = None
        self._high: int | None = None
        self.text = ""

    def _append(self, value: str) -> None:
        code = ord(value)
        if self._high is not None:
            if 0xDC00 <= code <= 0xDFFF:
                self.text += chr(0x10000 + ((self._high - 0xD800) << 10) + code - 0xDC00)
                self._high = None
                return
            # Malformed surrogate text is never sent to the browser; final validation still owns it.
            self._high = None
        if 0xD800 <= code <= 0xDBFF:
            self._high = code
        elif not 0xDC00 <= code <= 0xDFFF:
            self.text += value

    def feed(self, chunk: bytes | str) -> str | None:
        before = self.text
        decoded = self._utf8.decode(chunk) if isinstance(chunk, bytes) else chunk
        for char in decoded:
            if self._finished:
                break
            if self._string:
                if self._is_key:
                    self._raw += char
                if self._unicode is not None:
                    self._unicode += char
                    if len(self._unicode) == 4:
                        if self._target:
                            try:
                                self._append(chr(int(self._unicode, 16)))
                            except ValueError:
                                self._finished = True
                        self._unicode = None
                    continue
                if self._escaped:
                    self._escaped = False
                    if char == "u":
                        self._unicode = ""
                    elif self._target:
                        escapes = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f",
                                   "n": "\n", "r": "\r", "t": "\t"}
                        if char not in escapes:
                            self._finished = True
                        else:
                            self._append(escapes[char])
                    continue
                if char == "\\":
                    self._escaped = True
                elif char == '"':
                    self._string = False
                    if self._target:
                        self._finished = True
                    if self._is_key:
                        try:
                            self._key = json.loads(self._raw)
                        except json.JSONDecodeError:
                            self._finished = True
                        self._key_expected = False
                elif self._target:
                    self._append(char)
                continue
            if char == '"':
                self._string = True
                self._is_key = self._depth == 1 and self._key_expected
                self._target = self._depth == 1 and not self._is_key and self._key == self.name
                self._raw = '"' if self._is_key else ""
            elif char in "{[":
                self._depth += 1
                if self._depth == 1:
                    self._key_expected = True
            elif char in "}]":
                self._depth -= 1
            elif char == "," and self._depth == 1:
                self._key_expected = True
                self._key = None
        return self.text if self.text != before else None


class Display:
    """Only the current display snapshot is retained; slow subscribers may coalesce deltas."""

    def __init__(self, run: str | None = None):
        self.run = run
        self._version = 0
        self._generation = 0
        self._begun = False
        self._text: str | None = None
        self._terminal: tuple[str, dict] | None = None
        self._waiters: set[asyncio.Event] = set()

    def _wake(self) -> None:
        self._version += 1
        for waiter in self._waiters:
            waiter.set()

    def begin(self, field: str):
        if self._begun:
            self._generation += 1
            self._text = None
            self._wake()
        self._begun = True
        extractor = StringField(field)

        def text(chunk: str) -> None:
            value = extractor.feed(chunk)
            if value is not None:
                self._text = value
                self._wake()

        return text

    def finish(self, event: str, data: dict) -> None:
        self._terminal = (event, data)
        self._wake()

    async def events(self) -> AsyncIterator[dict]:
        waiter = asyncio.Event()
        self._waiters.add(waiter)
        version, generation, previous = -1, self._generation, None
        base = {} if self.run is None else {"run": self.run}
        try:
            while True:
                waiter.clear()
                if version != self._version:
                    # Snapshot before yielding: a retry may finish while an HTTP send is blocked.
                    version, changed, text, terminal = self._version, self._generation, self._text, self._terminal
                    if generation != changed:
                        generation, previous = changed, None
                        yield event("reset", base)
                    if text is not None and text != previous:
                        previous = text
                        yield event("delta", {**base, "text": previous})
                    if terminal is not None:
                        name, data = terminal
                        yield event(name, data)
                        return
                await waiter.wait()
        finally:
            self._waiters.discard(waiter)


current: ContextVar[Display | None] = ContextVar("owner_display", default=None)


@contextlib.contextmanager
def displaying(display: Display | None) -> Iterator[None]:
    token = current.set(display)
    try:
        yield
    finally:
        current.reset(token)


def event(name: str, data: dict) -> dict:
    return {"event": name, "data": json.dumps(data, ensure_ascii=False, separators=(",", ":"))}


def response(events: AsyncIterator[dict]) -> EventSourceResponse:
    return EventSourceResponse(events, ping=15, ping_message_factory=lambda: ServerSentEvent(comment="ping"))


def failure(error: BaseException) -> dict[str, Any]:
    # Import lazily: deps owns the proving registry that also uses these display channels.
    from desk.api.deps import ApiProblem
    from desk.api.kernel_client import KernelFailed, KernelUnavailable
    from desk.api.rules import AboveMoneyCap
    from desk.api.versions import ChangesAlwaysOn

    if isinstance(error, ApiProblem):
        return {"status": error.status, "error": error.error}
    if isinstance(error, AboveMoneyCap):
        return {"status": 422, "error": "above_money_cap"}
    if isinstance(error, ChangesAlwaysOn):
        return {"status": 422, "error": "changes_always_on"}
    if isinstance(error, KernelFailed):
        return {"status": error.status, "error": "kernel"}
    if isinstance(error, KernelUnavailable):
        return {"status": 503, "error": "kernel"}
    return {"status": 503, "error": "model_unavailable"}
