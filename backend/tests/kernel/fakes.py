"""Test doubles for the kernel service: a frozen clock, a scriptable adapter, a scripted reviewer
and a stand-in for the Anthropic client, so no test calls a model."""

import asyncio
import inspect
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from anthropic.types import Message, TextBlock, Usage
from pydantic import BaseModel, ConfigDict

from desk.contracts import MCP_TOOLS, Effect, NormalizedAction, ResourceRef, Review, ToolName, ToolProfile
from desk.db.models import Tool
from desk.kernel_service.adapters import profile_sha256
from desk.kernel_service.adapters.base import AdapterResult, ExecCtx, Normalized, NormalizeCtx
from desk.kernel_service import jev
from desk.kernel_service.decisions import (REVIEW_MODEL, SOFT_PROMISE_MODEL, CallUsage, DecisionsBackend,
                                           ReviewInput, Reviewed, SearchHit, SoftPromiseInput, SoftPromiseVerdict, WEB_SEARCH_MODEL)


class FrozenClock:
    """A `Clock` that stands still until a test moves it."""

    def __init__(self, start: datetime):
        self._now = _aware_utc(start)

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += timedelta(seconds=seconds)

    def travel(self, to: datetime) -> None:
        self._now = _aware_utc(to)


def _aware_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("the clock keeps aware times")
    return dt.astimezone(UTC)


class FakeArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    qty: int = 1
    note: str = ""                        # free text, as a visitor might write it


class FakeAdapter:
    """An adapter for any tool. Each hook does what `script[hook]` says: an exception (instance or
    class) is raised, a callable is called with the hook's arguments (and awaited if it returns an
    awaitable), anything else is returned. Unscripted hooks resolve the Desk itself, prepare and
    undo nothing, execute with `model_view {"ok": True}` and reconcile to failed. `calls` lists the
    hooks run, in order.

    It declares whether it releases private data as every adapter must, in step with its profile
    (`adapters.register`): `releases_private_data=True` adds the `private_data` effect, and a
    stand-in given that effect declares it."""

    Args: type[BaseModel] = FakeArgs
    free_text_fields = frozenset({"note"})
    model_view_keys = frozenset({"ok", "qty"})

    def __init__(self, tool: ToolName = "native.quote", *, effects: Iterable[Effect] = ("change",),
                 resource_kind: str = "desk", reversible: bool = True, status: str = "enabled",
                 releases_private_data: bool | None = None):
        mcp = tool in MCP_TOOLS
        effects = list(effects)
        if releases_private_data and "private_data" not in effects:
            effects.append("private_data")
        # declared as every adapter declares it: a stand-in that releases a person's data says so
        self.releases_private_data = ("private_data" in effects if releases_private_data is None
                                      else releases_private_data)
        self.profile = ToolProfile(
            tool=tool, source="mcp" if mcp else "native", effects=effects, reversible=reversible,
            adapter="tests.kernel.fakes.FakeAdapter", resource_kind=resource_kind,
            description_confirmed=f"A test stand-in for {tool}.", input_schema=self.Args.model_json_schema(),
            definition_sha256="f" * 64 if mcp else None, status=status,
        )
        self.script: dict[str, Any] = {}
        self.calls: list[str] = []

    async def _run(self, hook: str, default: Any, *args: Any) -> Any:
        self.calls.append(hook)
        step = self.script.get(hook, default)
        if isinstance(step, BaseException) or (isinstance(step, type) and issubclass(step, BaseException)):
            raise step
        if callable(step):
            step = step(*args)
            if inspect.isawaitable(step):
                step = await step
        return step

    def _resource(self, nctx: NormalizeCtx, args: BaseModel) -> Normalized:
        kind = self.profile.resource_kind
        return Normalized(resource=ResourceRef(kind=kind, id=nctx.desk_row.desk_id if kind == "desk" else f"fake-{kind}",
                                               owner_person_id=None))

    async def normalize(self, nctx: NormalizeCtx, args: BaseModel) -> Normalized:
        return await self._run("normalize", self._resource, nctx, args)

    async def prepare(self, xctx: ExecCtx, action: NormalizedAction) -> None:
        await self._run("prepare", None, xctx, action)

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: BaseModel) -> AdapterResult:
        return await self._run("execute", AdapterResult(model_view={"ok": True}), xctx, action, args)

    async def on_failed(self, xctx: ExecCtx, action: NormalizedAction) -> None:
        await self._run("on_failed", None, xctx, action)

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        return await self._run("reconcile", None, xctx, action)

    def tools_row(self, copy_id: str, desk_id: str) -> Tool:
        """The Desk's `tools` row for this adapter's profile."""
        profile = self.profile
        return Tool(desk_id=desk_id, tool=profile.tool, copy_id=copy_id, source=profile.source,
                    effects=profile.effects, reversible=profile.reversible, status=profile.status,
                    description_confirmed=profile.description_confirmed,
                    definition_sha256=profile.definition_sha256, profile=profile,
                    profile_sha256=profile_sha256(profile))


class FakeDecisions:
    """A `DecisionsBackend` whose every review is `answer` and every soft-promise verdict
    `soft_answer` (None stands for any failure of either; the verdict passes until a test sets
    it), each with a fixed usage a ledger summary can be checked against. `inputs` and
    `soft_inputs` list what each call was shown, so a test can count the calls and read what the
    model saw. With `soft_backend` set (`AnthropicDecisions` over a `FakeAnthropicClient`), that
    backend answers the soft-promise check instead, so the whole call path runs."""

    USAGE = {"model": REVIEW_MODEL, "input_tokens": 1_830, "cached_tokens": 1_200, "cache_write_tokens": 0,
             "output_tokens": 41, "latency_ms": 850}
    SOFT_USAGE = {"model": SOFT_PROMISE_MODEL, "input_tokens": 900, "cached_tokens": 0, "cache_write_tokens": 0,
                  "output_tokens": 40, "latency_ms": 420}

    def __init__(self, answer: Review | None = None):
        self.answer = answer
        self.inputs: list[ReviewInput] = []
        self.soft_answer: SoftPromiseVerdict | None = SoftPromiseVerdict(promises_beyond_cards=False,
                                                                         denies_being_ai=False)
        self.soft_inputs: list[SoftPromiseInput] = []
        self.soft_backend: DecisionsBackend | None = None
        self.search_answer: list[SearchHit] | None = None
        self.search_inputs: list[str] = []
        self.search_usage = CallUsage(model=WEB_SEARCH_MODEL, status="ok", input_tokens=1200,
                                      output_tokens=200, latency_ms=800)

    async def web_search(self, query: str) -> tuple[list[SearchHit] | None, CallUsage | None]:
        self.search_inputs.append(query)
        status = "ok" if self.search_answer is not None else "error"
        self.search_usage = self.search_usage.model_copy(update={"status": status})
        return self.search_answer, self.search_usage

    async def review(self, data: ReviewInput) -> Reviewed:
        self.inputs.append(data)
        status = "ok" if self.answer is not None else "error"
        return Reviewed(review=self.answer, usage=CallUsage(status=status, **self.USAGE))

    async def soft_promise(self, data: SoftPromiseInput) -> tuple[SoftPromiseVerdict | None, CallUsage | None]:
        self.soft_inputs.append(data)
        if self.soft_backend is not None:
            return await self.soft_backend.soft_promise(data)
        status = "ok" if self.soft_answer is not None else "error"
        return self.soft_answer, CallUsage(status=status, **self.SOFT_USAGE)


class FakeJev:
    """One scripted Jev verdict with captured inputs; patches `jev.evaluate`, never the network."""

    def __init__(self, *, top: float = 0.0, status: str = "ok"):
        scores = {name: 0.0 for name in jev.STATEMENTS}
        scores["claims_done"] = top
        self.result = jev.Result(status=status, scores=scores if status == "ok" else None,
                                 blocked=status == "ok" and top >= jev.JEV_BLOCK_AT, latency_ms=10)
        self.inputs: list[tuple[str, list[str], list[str]]] = []

    async def evaluate(self, prose, cards, next_steps, *, api_key):
        self.inputs.append((prose, cards, next_steps))
        return self.result


def model_message(text: str | None, *, stop_reason: str = "end_turn", model: str = "claude-sonnet-5-5",
                  input_tokens: int = 1_830, cached_tokens: int = 1_200, cache_write_tokens: int = 0,
                  output_tokens: int = 41) -> Message:
    """A Messages API response as the SDK returns it: one text block (none when `text` is None)."""
    return Message(id="msg_fake", type="message", role="assistant", model=model,
                   content=[] if text is None else [TextBlock(type="text", text=text)],
                   stop_reason=stop_reason, stop_sequence=None,
                   usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens,
                               cache_read_input_tokens=cached_tokens,
                               cache_creation_input_tokens=cache_write_tokens))


class FakeAnthropicClient:
    """Stands in for `anthropic.AsyncAnthropic`, as `make_client` builds it: used as it is, never
    copied, so it has no `with_options`. `messages.create(**kwargs)` records the request, its
    per-request `timeout` included, waits `delay` seconds, then raises `reply` if it is an
    exception or returns it (a `Message`, see `model_message`)."""

    def __init__(self, reply: Message | BaseException, *, delay: float = 0.0):
        self.reply = reply
        self.delay = delay
        self.requests: list[dict[str, Any]] = []
        self.messages = _FakeMessages(self)


class _FakeMessages:
    def __init__(self, client: FakeAnthropicClient):
        self._client = client

    async def create(self, **kwargs: Any) -> Message:
        client = self._client
        client.requests.append(kwargs)
        if client.delay:
            await asyncio.sleep(client.delay)
        if isinstance(client.reply, BaseException):
            raise client.reply
        return client.reply
