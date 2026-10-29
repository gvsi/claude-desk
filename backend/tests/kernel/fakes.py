"""Test doubles for the kernel service: a frozen clock and a scriptable adapter."""

import inspect
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, ConfigDict

from desk.contracts import MCP_TOOLS, Effect, NormalizedAction, ResourceRef, ToolName, ToolProfile
from desk.db.models import Tool
from desk.kernel_service.adapters import profile_sha256
from desk.kernel_service.adapters.base import AdapterResult, ExecCtx, Normalized, NormalizeCtx


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
    hooks run, in order."""

    Args: type[BaseModel] = FakeArgs
    free_text_fields = frozenset({"note"})
    model_view_keys = frozenset({"ok", "qty"})

    def __init__(self, tool: ToolName = "native.quote", *, effects: Iterable[Effect] = ("change",),
                 resource_kind: str = "desk", reversible: bool = True, status: str = "enabled"):
        mcp = tool in MCP_TOOLS
        self.profile = ToolProfile(
            tool=tool, source="mcp" if mcp else "native", effects=list(effects), reversible=reversible,
            adapter="tests.kernel.fakes.FakeAdapter", resource_kind=resource_kind,
            description_confirmed=f"A test stand-in for {tool}.", input_schema=FakeArgs.model_json_schema(),
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
