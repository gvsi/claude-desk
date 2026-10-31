"""A scripted model for the API's tests, and helpers that build the blocks of its responses.

`ScriptedModel(script)` is a `ModelClient` that plays `script` in order, one item per call, and records each
request it was sent (`requests`). An item is:

- a `ModelResponse` (see `response`), returned;
- an exception (a `ModelUnavailable`, say), raised;
- a callable taking the `ModelRequest`, sync or async, whose return value is used as the item;
- `gated(item, release)`, which waits for the `asyncio.Event` `release` before playing `item`; its `entered`
  event is set once the call is waiting, so a test can act while a model call is in flight.

A call with nothing left to play fails the test. The routes the API's jobs call (`JOB_ROUTES`: triage and owner
translations, Plan 02b's Task 10) play from scripts of their own (`ScriptedModel(..., triage=..., translation=...)`,
or `jobs[route]`) and are recorded in `job_requests`, so a job running beside a turn never takes the turn's answers;
a job call nobody scripted gets no answer, as from an unavailable model, and the job stores nothing.

`FakeMessagesApi(*answers)` stands in for the Messages API behind the SDK's own HTTP client (an
`httpx2.MockTransport`): it records each request and gives the next scripted answer, the last one again once
the script runs out, so the real `AnthropicModel` and `BedrockModel` run with no network.
"""

import asyncio
import copy
import inspect
import secrets
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx2

from desk.api.model import CONVERSATION_MODEL, ModelRequest, ModelResponse, ModelUnavailable, ModelUsage

FINISHED_AT = datetime(2026, 10, 30, 17, 0, tzinfo=UTC)
USAGE = ModelUsage(input_tokens=1500, cache_read_input_tokens=4500, cache_creation_input_tokens=0, output_tokens=350)


class FakeMessagesApi:
    """The Messages API as an `httpx2.MockTransport` (module docstring)."""

    def __init__(self, *answers: httpx2.Response):
        self.answers = list(answers)
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]

    def client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(self.handle))


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


def unavailable(finished_at: datetime = FINISHED_AT, model: str = CONVERSATION_MODEL) -> ModelUnavailable:
    """What `AnthropicModel` raises once the SDK gives up (an overloaded API, say)."""
    failed = ModelResponse(content=[], stop_reason="error", usage=None, latency_ms=30_000, finished_at=finished_at,
                           model=model)
    return ModelUnavailable(failed, "OverloadedError")


@dataclass
class Gated:
    item: object
    release: asyncio.Event
    entered: asyncio.Event = field(default_factory=asyncio.Event)


def gated(item: object, release: asyncio.Event) -> Gated:
    return Gated(item, release)


# The routes the API's jobs call, off any turn or request (Plan 02b, Task 10).
JOB_ROUTES = ("triage", "translation")


class ScriptedModel:
    """A `ModelClient` that plays a script, and the job routes' scripts apart from it (module docstring)."""

    def __init__(self, script: Iterable[object] = (), *, triage: Iterable[object] = (),
                 translation: Iterable[object] = ()):
        self.script = deque(script)
        self.requests: list[ModelRequest] = []
        self.jobs: dict[str, deque] = {"triage": deque(triage), "translation": deque(translation)}
        self.job_requests: list[ModelRequest] = []

    def add(self, *items: object) -> None:
        self.script.extend(items)

    def _next(self, request: ModelRequest) -> object:
        if request.route in self.jobs:
            self.job_requests.append(copy.deepcopy(request))
            script = self.jobs[request.route]
            return script.popleft() if script else unavailable(model=request.model)
        self.requests.append(copy.deepcopy(request))
        if not self.script:
            raise AssertionError(f"the scripted model has nothing left for call {len(self.requests)}")
        return self.script.popleft()

    async def call(self, request: ModelRequest) -> ModelResponse:
        item = self._next(request)
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
