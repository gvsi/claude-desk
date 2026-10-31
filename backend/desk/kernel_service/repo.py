"""Request context: one database transaction per request, bound to one copy.

`KernelCtx` is what every kernel function takes: the request's database session plus the
clock, signer and settings. The session is a `KernelSession`, which refuses to run anything
until a copy is bound (`ctx.bind(copy_id)`), and row-level security then admits only that copy's
rows. A route takes it as `ctx: Ctx`: the transaction commits after the route returns and before
the answer is sent, so a failed commit answers 500, and it rolls back on any exception.

Row locks are taken in one order, so no two kernel transactions wait on each other:

1. the session row: `FOR UPDATE` by a decision (`auth.lock_session`, held until it commits; the
   breaker's strike writes it under that lock), by a take-over or hand-back, by a verification
   route, in T2 by the execution of an adapter that writes the session's own rows
   (`locks_session`, a verification start) on either path, and by the owner's writes that close
   sessions (`desks.verified_sessions` when a person is removed or given another contact, a
   Desk's deletion); `FOR SHARE` by an allow's execution in T1, and in T2 by the execution of any
   other adapter, on either path, so a Desk's deletion, which closes the session `FOR UPDATE`,
   commits before T2 takes the row or waits until T2 commits; written by a visitor's or agent's
   own requests (`last_seen_at`, `last_language`), the reply check's only at its end, just before
   its ledger entry, so it holds no lock on the row while the soft-promise check runs;
2. the decision row, `FOR UPDATE`: lazy expiry, an answer, a cancel, each step of an execution,
   reconciliation;
3. the execution row: inserted with the intent, `FOR UPDATE` in T2, T3 and reconciliation;
4. the Desk's active `policy_versions` row, `FOR SHARE`, which issuing a payment link takes
   (Plan 01c);
5. people, `FOR UPDATE` in ID order: by a verification route or a verification start's T2 (as its
   adapter's own rows), and by the owner's write to them (`desks.put_people`);
6. their live verification challenges, after the people (a Desk's deletion, which locks no
   person, takes its live codes after its sessions);
7. a payment link (Plan 01c);
8. document links: an open marks its link in one UPDATE, and a person's removal or new contact,
   or a Desk's deletion, voids theirs in one;
9. documents, which a person's removal takes `FOR UPDATE` in ID order, and knowledge items, which
   `POST /knowledge` upserts;
10. an adapter's own rows, which its hooks lock or write (a booking and the calendar slot it
    books, which its T2 takes `FOR SHARE`; a handoff; Plan 01c's mandates), after whatever of steps
    4 to 9 the same transaction takes;
11. facts: an open expires its link's, voiding expires the links', a removal relabels its
    person's documents', a right code relabels the session's (`labels.relabel_on_verify`), closing
    a handoff expires its own, an hours write rewrites the Desk's;
12. the Desk's ledger head (`ledger.append`, `FOR UPDATE`, where every entry ends; `ledger.page`
    reads it `FOR SHARE`).

Every owner's write to a Desk's data holds the Desk row `FOR UPDATE` (`desks.owner_desk`) before
any of these, and a write to the business its row after the Desk's. The calendar write then takes
the Desk's slots `FOR UPDATE` in ID order (step 10) before it checks which are booked, so a booking
of a slot it drops or moves either commits first or waits for it. Closing a handoff does too: it
reads which Desk the handoff is on without a lock, holds that Desk's row (`desks.held_desk`), then
takes the handoff (step 10), its fact and the ledger head. Nothing that holds one of the rows above
asks for a Desk or business row.

A transaction that holds a later lock never asks for an earlier one: a refusal's `persist` locks
the decision before it appends, nothing holds a payment link and then asks for the policy row,
and every step runs its adapter's hooks before it appends (T1 `prepare`, T2 `execute`, T3
`on_failed`, reconciliation `reconcile` and then `on_failed`, activation its `ON_ACTIVATE`
hooks), so a hook may wait for the rows it locks like any other step. An insert under a fresh key
waits for nothing, so it may come after a later step: T1 and an approved answer run `prepare`
(step 10) before they insert the intent row (step 3), since a new `action_id` could wait only on
another uncommitted insert of the same action, which the decision's lock (step 2) rules out, and
Plan 01c's new payment link (step 7) may follow a mandate reservation (step 10). A row is taken
the first time in the strongest mode the transaction will need, since going from `FOR SHARE` to
`FOR UPDATE` waits like a new lock. Reading a row without a lock (the session a decision names,
say) waits for nothing and can come at any point. Reconciliation takes the decision and the
execution `SKIP LOCKED`, so it skips an execution that is running rather than wait for it.

A decision holds the session row through its review on purpose: the closed, generation and mode
checks then hold for the whole decision, and a take-over or hand-back comes before it (409) or
after it commits, never during it. So a take-over that arrives while the reviewer runs waits for
the decision to commit, up to the review's timeout (`decisions.REVIEW_TIMEOUT_S`, 4 s), then
bumps the generation, and an allow from the old generation expires at `/execute`. No other
kernel call holds the row across a model call.

A person's removal or new contact (`desks.put_people`) is the one step that may ask for an
earlier row, and only for a session a check verified as the person after the write's session
step and before it held their row: it takes that session too once it holds the people, so the
session closes with the rest. That waits on nothing that waits on the write, since the check has
committed and nothing that holds a verified session's row asks for a Desk row, another session, a
person or a challenge.

Activation (`activation.confirm`) holds no session, decision or execution row and starts at step
4: the Desk's `versions` advisory lock, then its `policy_versions` rows `FOR UPDATE`, then the
payment links its `ON_ACTIVATE` hooks lock and move (Plan 01c; a hook appends nothing), then the
ledger head: its own `policy` entry first, then the hooks' `payment` events. A draft takes its
key's advisory lock before the `versions` lock. The startup rebuild of a version an earlier kernel
stored (`activation.rebuild_version`) takes the same `versions` lock and active row `FOR UPDATE`,
then the ledger head; the owner alert it writes when it can't rebuild is an insert under a fresh
key. An owner write refused for a document canary (`desks.refuse_public_canaries`) appends in its
`persist` alone, holding nothing else, to each Desk it names in ID order, and one refused past a
Desk's cap of documents or knowledge items (`labels.refuse_past_cap`, counted without a lock under
the Desk row's) to its Desk likewise; the public page's owner
alert when it withholds a field is an insert under a fresh key, in a read that locks nothing.

A session's read is answered only if the session still stands once the read is done. Most routes
check the session on the row as they read it, without a lock, and the owner may close it meanwhile
(a person's removal or new contact, the Desk's deletion). Every session whose token a request
proves is watched (`auth.watch_session`), and after the request's last read, as its last
statements before it answers, `auth.still_open` reads the session, its person and its Desk afresh:
closed, or no longer the person it read as, is 409 `closed`, and nothing the request read is
answered. Those reads lock nothing, so they wait for nothing and add no step to the order above.
They run in `KernelCtx.commit`, which a commit that ends what a request answers goes through (a
repeated execution's stored result), and when the request's transaction ends having read anything
since its last commit. A commit that records what an adapter did runs none: a rollback can't undo
an act on the world, so an execution's T2 asks the same of its session (`auth.session_stands`)
before the adapter runs, under the session row it holds until that commit, and records what ran
whatever happens to the session after; the session's next read answers that. The API's own ledger
entries (`POST /ledger/append`) are records too, and their session isn't watched.

A route refuses with `KernelFailure`. Its answer is always a `KernelError{code}`; when the refusal
must be on record (a ledgered auth failure, an allow that expired), `persist` writes that record
in a fresh transaction after the request's own has rolled back. An error that isn't a refusal is
logged with `log_error`, by its kind and the frames it rose through, never its text.
"""

from __future__ import annotations

import base64
import logging
import re
import secrets
import traceback
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, get_args

import desk_kernel
from fastapi import Depends, Request
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from desk.db import logs as db_logs
from desk.db.models import Execution, PolicyVersion
from desk.db.session import CopyResolver, KernelRepo, resolve_copy
from desk.kernel_api import KernelError
from desk.kernel_service.clock import Clock

if TYPE_CHECKING:
    from desk.kernel_service.activation import PolicyRuntime
    from desk.kernel_service.app import KernelSettings
    from desk.kernel_service.decisions import DecisionsBackend

ErrorCode = KernelError.model_fields["code"].annotation
ERROR_CODES = frozenset(get_args(ErrorCode))


def new_id(prefix: str) -> str:
    """`<prefix>-<16 lowercase base32 characters>` from 10 CSPRNG bytes; lowercase, so IDs fit card IDs."""
    if not re.fullmatch(r"[a-z][a-z0-9]*", prefix):
        raise ValueError("an id prefix is lowercase letters and digits")
    return f"{prefix}-{base64.b32encode(secrets.token_bytes(10)).decode().lower()}"


REF = re.compile(r"[A-Za-z0-9_-]{1,64}")   # an owner's ref or knowledge ID, as `desk_data` entries carry it


def storable(text: str) -> bool:
    """Text Postgres can hold: valid UTF-8, without NUL. Text that isn't names no row, so a lookup
    by it finds nothing and a write of it is refused before the database sees it."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return "\0" not in text


@dataclass(frozen=True)
class KernelRuntime:
    """What the app holds for its lifetime (`app.state.kernel`), built by the lifespan."""

    settings: KernelSettings
    clock: Clock
    signer: desk_kernel.Signer
    engine: AsyncEngine
    sessions: async_sessionmaker[AsyncSession]
    policies: PolicyRuntime               # the policy engine, its loaded versions and the proof cache
    decisions: DecisionsBackend           # the auto reviewer


@dataclass
class KernelCtx:
    db: AsyncSession
    clock: Clock
    signer: desk_kernel.Signer
    settings: KernelSettings
    engine: AsyncEngine                   # for the credential lookups below, on their own connection
    policies: PolicyRuntime               # the policy engine, its loaded versions and the proof cache
    decisions: DecisionsBackend           # the auto reviewer
    # what must still hold when the request's reads are done (`auth.watch_session`), by key
    rechecks: dict[str, Callable[[], Awaitable[None]]] = field(default_factory=dict)

    async def recheck(self) -> None:
        """Runs the request's rechecks, each reading afresh what the request read its rows under (the
        session it acts for still open, as the same person): one that no longer holds raises its
        refusal, so the request answers nothing it read."""
        for check in list(self.rechecks.values()):
            await check()

    async def commit(self) -> None:
        """Commits the transaction once the request's rechecks pass. A commit that ends what a request
        answers with, data a session reads, comes through here, and so does the end of every request
        transaction (`kernel_transaction`). `db.commit()` is kept for a refusal's own record, which
        answers nothing read, and for the record of what an adapter did, which no recheck may undo
        (tests/kernel/test_session_recheck.py lists each)."""
        await self.recheck()
        await self.db.commit()

    def bind(self, copy_id: str) -> KernelRepo:
        """Run this context's transaction as `copy_id`. Binding again to the same copy is a no-op;
        another copy, or a first bind after the transaction began, raises."""
        repo = KernelRepo(copy_id)
        repo.bind(self.db)
        return repo

    @property
    def copy_id(self) -> str:
        copy_id = self.db.info.get("copy_id")
        if not copy_id:
            raise RuntimeError("no copy is bound to this context")
        return copy_id

    @property
    def repo(self) -> KernelRepo:
        return KernelRepo(self.copy_id)


@asynccontextmanager
async def kernel_transaction(runtime: KernelRuntime) -> AsyncIterator[KernelCtx]:
    """A `KernelCtx` on a new session: committed when the block ends, rolled back on an exception.
    When the block has read anything since its last commit, its rechecks (`KernelCtx.recheck`) run
    first, as the last statements before the request answers: one that fails rolls it back and
    raises its refusal. A request whose last statement was a `KernelCtx.commit` ran them there."""
    async with runtime.sessions() as db:
        ctx = KernelCtx(db=db, clock=runtime.clock, signer=runtime.signer, settings=runtime.settings,
                        engine=runtime.engine, policies=runtime.policies, decisions=runtime.decisions)
        try:
            yield ctx
            if db.in_transaction():
                await ctx.recheck()
        except Exception:
            await db.rollback()
            raise
        await db.commit()


async def get_ctx(request: Request) -> AsyncIterator[KernelCtx]:
    """The request's context: one transaction, committed after the route returns."""
    async with kernel_transaction(request.app.state.kernel) as ctx:
        yield ctx


# scope="function" ends the dependency (the commit) before the answer is sent, not after. A
# dependency with yield that takes a Ctx must be scope="function" too (FastAPI enforces it).
Ctx = Annotated[KernelCtx, Depends(get_ctx, scope="function")]

Persist = Callable[[KernelCtx], Awaitable[object]]


class KernelFailure(Exception):
    """A refusal answered with `status` and `KernelError{code}`.

    `reason` is internal, for the kernel's log (never a token or contact). `persist`, when given,
    runs in a fresh transaction after the request's transaction has rolled back and before the
    answer; if it fails, the answer is 500 `internal` instead, since the attempt went unrecorded.
    """

    def __init__(self, status: int, code: str, reason: str | None = None, persist: Persist | None = None):
        if code not in ERROR_CODES:
            raise ValueError(f"{code!r} is not a KernelError code")
        if not 400 <= status <= 599:
            raise ValueError("a KernelFailure answers with a 4xx or 5xx status")
        super().__init__(reason or code)
        self.status = status
        self.code = code
        self.reason = reason or code
        self.persist = persist


def log_error(logger: logging.Logger, exc: BaseException, message: str, *args: object) -> None:
    """Logs `exc` at ERROR as `message` (a fixed event name and kernel-built values, %-formatted
    with `args`), then `kind=<its class>` and the frames it rose through, never its text: an
    error's message can quote what a visitor typed (an adapter's error its arguments, a validation
    error the input it refused, a driver error a statement's parameters). A database error's kind
    adds its SQLSTATE and constraint name (`db_logs.describe`), which hold no value. Used in place
    of `logger.exception` wherever a request or an execution can fail."""
    kind = db_logs.describe(exc) if db_logs.is_database_error(exc) else type(exc).__name__
    logger.error(f"{message} kind=%s\n%s", *args, kind, "".join(traceback.format_tb(exc.__traceback__)),
                 stacklevel=2)


def route_template(request: Request) -> str:
    """The route template ("POST /decide"), never the raw path, which may hold a token."""
    route = request.scope.get("route")
    return f"{request.method} {getattr(route, 'path', '<unmatched>')}"


# Credential lookups. A request names a session token, a session ID, a decision ID (whose session
# `GET /decisions/{id}` names), a public slug or a document link's token, not a copy; these find
# the copy it belongs to (a token by its sha256, never the token itself) through the database's
# copy resolvers (SECURITY DEFINER functions that return only a copy id), on their own connection,
# so the caller can bind the request's transaction to that copy and read the rows through
# KernelRepo as usual. Only auth.py, GET /whoami, GET /decisions/{id}, POST /sessions,
# GET /public/{desk_slug} and GET /document_links/{token} use them, and they run before the
# request's transaction has run anything: a request that held its transaction's connection while it
# waited for a resolver's would, with as many such requests at once as the pool has connections,
# wait until checkout timed out. Asked later, a resolver raises (500 `internal`) instead.

async def _resolve(ctx: KernelCtx, resolver: CopyResolver, key: str) -> str | None:
    if ctx.db.in_transaction():
        raise RuntimeError("a copy resolver runs only before the request's transaction takes its connection")
    return await resolve_copy(resolver, key, engine=ctx.engine)


async def copy_of_desk_slug(ctx: KernelCtx, slug: str) -> str | None:
    return await _resolve(ctx, "copy_of_desk_slug", slug)


async def copy_of_session_id(ctx: KernelCtx, session_id: str) -> str | None:
    return await _resolve(ctx, "copy_of_session_id", session_id)


async def copy_of_session_token(ctx: KernelCtx, token_hash: str) -> str | None:
    return await _resolve(ctx, "copy_of_session", token_hash)


async def copy_of_decision_id(ctx: KernelCtx, decision_id: str) -> str | None:
    """The copy of a decision, whose session is the one `GET /decisions/{id}` names."""
    return await _resolve(ctx, "copy_of_decision_id", decision_id)


async def copy_of_document_link(ctx: KernelCtx, token_sha256: str) -> str | None:
    """The copy of the document link whose token has this sha256 (`release_document.token_sha256`):
    the resolver reads hashes, never a link's token."""
    return await _resolve(ctx, "copy_of_document_link", token_sha256)


# Startup's two lookups across copies: which copies hold an execution to settle, and which hold an
# active rules version an earlier kernel stored, to rebuild.

async def orphan_intents(runtime: KernelRuntime, older_than: datetime) -> list[tuple[str, str]]:
    """`(copy_id, action_id)` of every execution startup reconciliation must settle: an intent
    started before `older_than`, or one left `unknown`. Used only by startup reconciliation, which
    then works through each copy's `KernelRepo`. It visits every copy (`kernel.copy_ids()`) and
    reads each through its own `KernelRepo`, so row-level security still holds every read to one
    copy."""
    async with runtime.engine.connect() as conn:
        copy_ids = list((await conn.scalars(select(func.kernel.copy_ids()))).all())
    found: list[tuple[str, str]] = []
    for copy_id in copy_ids:
        copy = KernelRepo(copy_id)
        async with runtime.sessions() as db:
            copy.bind(db)
            rows = await db.scalars(copy.scoped(select(Execution.action_id).where(or_(
                and_(Execution.state == "intent", Execution.started_at < older_than),
                Execution.state == "unknown")).order_by(Execution.action_id)))
            found += [(copy_id, action_id) for action_id in rows]
    return found


async def outdated_versions(runtime: KernelRuntime, baseline_sha256: str) -> list[tuple[str, str, int]]:
    """`(copy_id, desk_id, version)` of every active rules version stored under a baseline other
    than `baseline_sha256`, the one the kernel enforces. Used only by the startup rebuild
    (`activation.rebuild_at_startup`), which then works through each copy's `KernelRepo`. It visits
    every copy (`kernel.copy_ids()`) and reads each through its own `KernelRepo`, as
    `orphan_intents` does."""
    async with runtime.engine.connect() as conn:
        copy_ids = list((await conn.scalars(select(func.kernel.copy_ids()))).all())
    found: list[tuple[str, str, int]] = []
    for copy_id in copy_ids:
        copy = KernelRepo(copy_id)
        async with runtime.sessions() as db:
            copy.bind(db)
            rows = await db.execute(copy.scoped(select(PolicyVersion.desk_id, PolicyVersion.version).where(
                PolicyVersion.status == "active", PolicyVersion.baseline_sha256 != baseline_sha256)
                .order_by(PolicyVersion.desk_id)))
            found += [(copy_id, desk_id, version) for desk_id, version in rows]
    return found
