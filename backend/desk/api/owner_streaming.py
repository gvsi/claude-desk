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
    """Only the current display snapshot is retained; slow subscribers may coalesce deltas. A turn's few read events
    are kept in order, so every subscriber, a late one too, gets each of them before the reply's text. A run shows at
    most one model call's text (`take`), so a reset only ever means a retry of that call, or text taken back."""

    def __init__(self, run: str | None = None):
        self.run = run
        self._version = 0
        self._generation = 0
        self._begun = False
        self._text: str | None = None
        self._terminal: tuple[str, dict] | None = None
        self._reads: list[tuple[str, dict]] = []
        self._open = True
        self._waiters: set[asyncio.Event] = set()

    def _wake(self) -> None:
        self._version += 1
        for waiter in self._waiters:
            waiter.set()

    def take(self) -> bool:
        """Whether a structured call shows its text: only the run's first one does, unless the run holds it."""
        taken, self._open = self._open, False
        return taken

    def hold(self) -> None:
        """Show no model text in this run: its first reply could still be hidden before it's saved."""
        self._open = False

    def withdraw(self, text: str) -> None:
        """Take back the text shown (a reset) when it is `text`, a reply that won't be saved as it showed."""
        if text.strip() and self._text is not None and self._text.strip() == text.strip():
            self._generation += 1
            self._text = None
            self._wake()

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

    def reading(self, read: str, host: str | None) -> None:
        """A read started: which one, and the website's host (None for any other read). No text."""
        self._reads.append(("reading", {"read": read, "host": host}))
        self._wake()

    def label(self, read: str, text: str) -> None:
        """A read finished: `text` is exactly the label its saved entry holds."""
        self._reads.append(("label", {"read": read, "text": text}))
        self._wake()

    def finish(self, event: str, data: dict) -> None:
        self._terminal = (event, data)
        self._wake()

    @property
    def finished(self) -> bool:
        return self._terminal is not None

    async def events(self) -> AsyncIterator[dict]:
        waiter = asyncio.Event()
        self._waiters.add(waiter)
        version, generation, previous, sent = -1, self._generation, None, 0
        base = {} if self.run is None else {"run": self.run}
        try:
            while True:
                waiter.clear()
                if version != self._version:
                    # Snapshot before yielding: a retry may finish while an HTTP send is blocked.
                    version, changed, text, terminal = self._version, self._generation, self._text, self._terminal
                    reads, sent = self._reads[sent:], len(self._reads)
                    for name, data in reads:
                        yield event(name, {**base, **data})
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
    """The JSON error body the route would answer `error` with (the app's error handlers, and the drafting routes'
    422 bodies), plus its HTTP `status`. Never the exception's message."""
    # Import lazily: deps owns the proving registry that also uses these display channels.
    from desk.api.deps import ApiProblem
    from desk.api.kernel_client import KernelFailed, KernelUnavailable
    from desk.api.main import KERNEL_CODES
    from desk.api.ratelimit import RateLimited
    from desk.api.rules import AboveMoneyCap
    from desk.api.schemas import AboveMoneyCap as AboveMoneyCapBody, ApiError, ChangesAlwaysOn as ChangesAlwaysOnBody
    from desk.api.versions import ChangesAlwaysOn

    if isinstance(error, AboveMoneyCap):
        status, body = 422, AboveMoneyCapBody(cap_cents=error.cap_cents)
    elif isinstance(error, ChangesAlwaysOn):
        status, body = 422, ChangesAlwaysOnBody(card_ids=error.card_ids)
    elif isinstance(error, ApiProblem):
        status, body = error.status, ApiError(error=error.error, code=error.code, retry_after=error.retry_after)
    elif isinstance(error, RateLimited):
        status, body = 429, ApiError(error="rate_limited", retry_after=error.retry_after)
    elif isinstance(error, KernelFailed):
        status, body = error.status, ApiError(error="kernel", code=error.code)
    elif isinstance(error, KernelUnavailable):
        status, body = 503, ApiError(error="kernel", code=error.code if error.code in KERNEL_CODES
                                     else "kernel_unavailable")
    else:
        status, body = 500, ApiError(error="internal")
    return {"status": status, **body.model_dump(mode="json", exclude_none=True)}
