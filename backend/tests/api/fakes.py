"""A scripted model for the API's tests, and helpers that build the blocks of its responses.

`ScriptedModel(script)` is a `ModelClient` that plays `script` in order, one item per call, and records each
request it was sent (`requests`). An item is:

- a `ModelResponse` (see `response`), returned;
- an exception (a `ModelUnavailable`, say), raised;
- a callable taking the `ModelRequest`, sync or async, whose return value is used as the item;
- `gated(item, release)`, which waits for the `asyncio.Event` `release` before playing `item`; its `entered`
  event is set once the call is waiting, so a test can act while a model call is in flight.

A call with nothing left to play fails the test.
"""

import asyncio
import copy
import inspect
import secrets
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from desk.api.model import CONVERSATION_MODEL, ModelRequest, ModelResponse, ModelUnavailable, ModelUsage

FINISHED_AT = datetime(2026, 10, 30, 17, 0, tzinfo=UTC)
USAGE = ModelUsage(input_tokens=1500, cache_read_input_tokens=4500, cache_creation_input_tokens=0, output_tokens=350)


def text(value: str) -> dict:
    return {"type": "text", "text": value}


def tool_use(name: str, input: dict, id: str | None = None) -> dict:
    return {"type": "tool_use", "id": id or "toolu_" + secrets.token_hex(8), "name": name, "input": input}


def thinking(value: str = "", signature: str | None = None) -> dict:
    """A thinking block as Opus 5.5 returns it by default (its text omitted), with a signature to replay."""
    return {"type": "thinking", "thinking": value, "signature": signature or "sig-" + secrets.token_hex(8)}


def response(*blocks: dict, stop_reason: str | None = None, usage: ModelUsage = USAGE,
             finished_at: datetime = FINISHED_AT, latency_ms: int = 900, model: str = CONVERSATION_MODEL,
             parsed: object = None) -> ModelResponse:
    """A finished call; the stop reason is `tool_use` when a block calls a tool, else `end_turn`."""
    if stop_reason is None:
        stop_reason = "tool_use" if any(block["type"] == "tool_use" for block in blocks) else "end_turn"
    return ModelResponse(content=list(blocks), stop_reason=stop_reason, usage=usage, latency_ms=latency_ms,
                         finished_at=finished_at, model=model, parsed=parsed)


def unavailable(finished_at: datetime = FINISHED_AT) -> ModelUnavailable:
    """What `AnthropicModel` raises once the SDK gives up (an overloaded API, say)."""
    failed = ModelResponse(content=[], stop_reason="error", usage=None, latency_ms=30_000, finished_at=finished_at,
                           model=CONVERSATION_MODEL)
    return ModelUnavailable(failed, "OverloadedError")


@dataclass
class Gated:
    item: object
    release: asyncio.Event
    entered: asyncio.Event = field(default_factory=asyncio.Event)


def gated(item: object, release: asyncio.Event) -> Gated:
    return Gated(item, release)


class ScriptedModel:
    """A `ModelClient` that plays a script (module docstring)."""

    def __init__(self, script: Iterable[object] = ()):
        self.script = deque(script)
        self.requests: list[ModelRequest] = []

    def add(self, *items: object) -> None:
        self.script.extend(items)

    async def call(self, request: ModelRequest) -> ModelResponse:
        self.requests.append(copy.deepcopy(request))
        if not self.script:
            raise AssertionError(f"the scripted model has nothing left for call {len(self.requests)}")
        item = self.script.popleft()
        if isinstance(item, Gated):
            item.entered.set()
            await item.release.wait()
            item = item.item
        if callable(item) and not isinstance(item, (ModelResponse, BaseException)):
            item = item(request)
            if inspect.isawaitable(item):
                item = await item
        if isinstance(item, BaseException):
            raise item
        if not isinstance(item, ModelResponse):
            raise AssertionError(f"a script item is a ModelResponse, an exception or a callable, not {item!r}")
        return item
