"""The adapter protocol: the trusted code between a tool call Claude proposed and its effect.

No adapter, no tool. An adapter declares its `ToolProfile` and the strict pydantic model of the
args it accepts (`Args`, whose JSON Schema is the profile's `input_schema`). The kernel calls its
hooks in this order:

- `normalize(nctx, args)`, at `/decide` and again at execution: the resource, its owner and every
  price come from kernel rows, never from args; `AdapterRefusal` refuses the call at step 1.
- `prepare(xctx, action)`, optional: after the execution re-check, in the transaction that writes
  the intent row (a spend reservation, say); `AdapterRefusal` ends in `refused_at_execution`.
- `execute(xctx, action, args)`: after the intent row has committed, under its lock. Raise
  `AdapterFailure` only before any external side effect (`failed`); `AdapterUnknown` or any other
  exception is `unknown`. Its database writes roll back on any exception, so state that must
  survive one belongs in `prepare`.
- `on_failed(xctx, action)`, optional: in the `failed` transaction, undoing `prepare`.
- `reconcile(xctx, action)`: for an `unknown` action, by `action_id`: a result means it executed,
  None that it failed, `AdapterUnknown` that it is still unknown.

`model_view_keys` are the only keys of a result's `model_view` that reach Claude.
"""

from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import select

from desk.contracts import Fact, InboxNotice, NormalizedAction, Principal, ResourceRef, ToolProfile
from desk.db.models import ActorSession, Business, Desk
from desk.kernel_service.repo import KernelCtx


class AdapterRefusal(Exception):
    """The call can't go ahead (at normalize: refused at step 1; at prepare: refused at execution)."""


class AdapterFailure(Exception):
    """Execution failed before any external side effect; the action is `failed`."""


class AdapterUnknown(Exception):
    """The outcome isn't known; the action is `unknown` until reconciled, never retried blindly."""


class Normalized(BaseModel):
    """What `normalize` resolves from kernel rows; numbers are checked here, at the seam."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    resource: ResourceRef
    list_cents: StrictInt | None = Field(None, ge=0)
    discount_bp: StrictInt | None = Field(None, ge=0, le=10_000)
    amount_cents: StrictInt | None = Field(None, ge=0, le=1_000_000)
    recipient: Literal["owner", "verified_contact"] | None = None
    starts_at: AwareDatetime | None = None


class AdapterResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    facts: list[Fact] = []
    model_view: dict[str, Any] = {}       # filtered to model_view_keys and the session's readers before Claude sees it
    inbox: list[InboxNotice] = []


@dataclass(frozen=True)
class NormalizeCtx:
    ctx: KernelCtx
    desk_row: Desk
    principal: Principal


@dataclass(frozen=True)
class ExecCtx:
    ctx: KernelCtx
    desk_row: Desk
    session_row: ActorSession
    principal: Principal


@runtime_checkable
class Adapter(Protocol):
    """Required members. `prepare(xctx, action)` and `on_failed(xctx, action)` are optional async
    hooks, looked up with `getattr`."""

    profile: ToolProfile
    Args: type[BaseModel]                 # extra="forbid", strict=True
    free_text_fields: frozenset[str]      # args that may carry visitor text: quoted, labelled untrusted, cut for the reviewer
    model_view_keys: frozenset[str]

    async def normalize(self, nctx: NormalizeCtx, args: BaseModel) -> Normalized: ...

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: BaseModel) -> AdapterResult: ...

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None: ...


async def business_timezone(ctx: KernelCtx, desk_row: Desk) -> ZoneInfo:
    """The time zone of the Desk's business: slots, hours and the dates in facts are read in it."""
    name = (await ctx.db.execute(ctx.repo.scoped(
        select(Business.timezone).where(Business.business_id == desk_row.business_id)))).scalar_one()
    return ZoneInfo(name)
