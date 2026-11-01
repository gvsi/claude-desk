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

`ExecCtx.recheck_version` is the rules version the execution re-check (step 6) passed under, which
`prepare`, `execute` and `on_failed` see; reconciliation runs no re-check, so it is None there.

An adapter whose `execute` writes the session's own rows (a verification start) sets
`locks_session = True` (optional, looked up with `getattr`): the execution then holds the session
row `FOR UPDATE` rather than `FOR SHARE`, so two of them in one session take turns.

`model_view_keys` are the only keys of a result's `model_view` that reach Claude.

`releases_private_data` (required, a bool every adapter class sets itself) says whether its result
gives the session data that only a verified, entitled person may see, data it reads only as its
person (a document link). It is True exactly when the profile has the `private_data` effect, which
registration checks (`adapters.register`). An approved hold of such an action runs only while its
session still stands for that person (`execute.session_ended`); every other approved hold runs for
a closed session too, as step 6 lets it. Recovered once that session no longer stands, it is still
reconciled, and nothing it answers is delivered. The execute path holds an adapter to its word: one
declared not to release private data whose result carries some is withheld, never failed, since
it may have acted outside the kernel: nothing it returned reaches the session, and the fact rows
the result names are narrowed to the owner (`execute.undeclared_private_data`).
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import select

from desk.contracts import Fact, InboxNotice, NormalizedAction, Principal, ResourceRef, ToolProfile
from desk.db.models import ActorSession, Business, Desk
from desk.kernel_service.repo import KernelCtx


class AdapterRefusal(Exception):
    """The call can't go ahead (at normalize: refused at step 1; at prepare: refused at execution).
    Its first argument, when it is a string, is the adapter's code for why (`code`): a step-1
    refusal ledgers it, through `ledger.safe_ref`, and never shows it to the visitor."""

    @property
    def code(self) -> str | None:
        return self.args[0] if self.args and isinstance(self.args[0], str) else None


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
    inbox: list[InboxNotice] = []         # a verification code's notice only; owner alerts stay in the Demo inbox


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
    recheck_version: int | None = None    # the rules version the execution re-check passed under; None in reconciliation


@runtime_checkable
class Adapter(Protocol):
    """Required members. `prepare(xctx, action)` and `on_failed(xctx, action)` are optional async
    hooks, and `locks_session` an optional flag, looked up with `getattr`."""

    profile: ToolProfile
    Args: type[BaseModel]                 # extra="forbid", strict=True
    releases_private_data: bool           # its result gives the session data it reads only as its person
    free_text_fields: frozenset[str]      # args that may carry visitor text: quoted, labelled untrusted, cut for the reviewer
    model_view_keys: frozenset[str]

    async def normalize(self, nctx: NormalizeCtx, args: BaseModel) -> Normalized: ...

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: BaseModel) -> AdapterResult: ...

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None: ...


QUOTED_CHARS = 200                        # free text quoted to the owner is cut to this
CLAUDES_NOTE = "Claude's note"            # the label on that text: Claude wrote it into the call, the visitor didn't


def quoted(text: str) -> str:
    """Text as the owner reads it: on one line, inside quotes it can't close. It stays untrusted
    text, never an instruction."""
    return "“" + " ".join(text.split()).replace("“", '"').replace("”", '"') + "”"


def claudes_note(texts: Iterable[str | None]) -> str:
    """The free text Claude wrote into a tool call, as the owner reads it in a held request's reason
    and in an alert: one "Claude's note" label, then each text that holds any, cut to
    `QUOTED_CHARS` and quoted on its own, comma-joined (`Claude's note: “a”, “b”`). Claude wrote it,
    so it is never labelled as the visitor's words, though it may repeat them. Callers pass at least
    one text."""
    return f"{CLAUDES_NOTE}: " + ", ".join(quoted(" ".join(text.split())[:QUOTED_CHARS]) for text in texts if text)


def fact_ref(value: str, kind: str) -> str:
    """The row ID an argument names when it may be copied from a fact of `kind`: `value` without
    one leading `"<kind>:"`, otherwise unchanged. Claude's context shows a document or a quote by
    its fact ID (`document:<id>`, `quote:<id>`), and passing that whole ID is an honest mistake, so
    it names the same row as the bare ID. Only that kind's prefix comes off, and only once: any
    other prefix stays, names no row, and the call is refused as before. Who may act on the row is
    checked on the row, never on how it was named."""
    return value.removeprefix(f"{kind}:")


async def business_timezone(ctx: KernelCtx, desk_row: Desk) -> ZoneInfo:
    """The time zone of the Desk's business: slots, hours and the dates in facts are read in it."""
    name = (await ctx.db.execute(ctx.repo.scoped(
        select(Business.timezone).where(Business.business_id == desk_row.business_id)))).scalar_one()
    return ZoneInfo(name)
