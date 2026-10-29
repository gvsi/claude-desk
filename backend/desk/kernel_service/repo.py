"""Request context: one database transaction per request, bound to one copy.

`KernelCtx` is what every kernel function takes: the request's database session plus the
clock, signer and settings. The session is a `KernelSession`, which refuses to run anything
until a copy is bound (`ctx.bind(copy_id)`), and row-level security then admits only that copy's
rows. A route takes it as `ctx: Ctx`: the transaction commits after the route returns and before
the answer is sent, so a failed commit answers 500, and it rolls back on any exception.

A route refuses with `KernelFailure`. Its answer is always a `KernelError{code}`; when the refusal
must be on record (a ledgered auth failure, an allow that expired), `persist` writes that record
in a fresh transaction after the request's own has rolled back.
"""

from __future__ import annotations

import base64
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, get_args

import desk_kernel
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from desk.db.session import KernelRepo
from desk.kernel_api import KernelError
from desk.kernel_service.clock import Clock

if TYPE_CHECKING:
    from desk.kernel_service.app import KernelSettings

ErrorCode = KernelError.model_fields["code"].annotation
ERROR_CODES = frozenset(get_args(ErrorCode))


def new_id(prefix: str) -> str:
    """`<prefix>-<16 lowercase base32 characters>` from 10 CSPRNG bytes; lowercase, so IDs fit card IDs."""
    if not re.fullmatch(r"[a-z][a-z0-9]*", prefix):
        raise ValueError("an id prefix is lowercase letters and digits")
    return f"{prefix}-{base64.b32encode(secrets.token_bytes(10)).decode().lower()}"


@dataclass(frozen=True)
class KernelRuntime:
    """What the app holds for its lifetime (`app.state.kernel`), built by the lifespan."""

    settings: KernelSettings
    clock: Clock
    signer: desk_kernel.Signer
    sessions: async_sessionmaker[AsyncSession]


@dataclass
class KernelCtx:
    db: AsyncSession
    clock: Clock
    signer: desk_kernel.Signer
    settings: KernelSettings

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
    """A `KernelCtx` on a new session: committed when the block ends, rolled back on an exception."""
    async with runtime.sessions() as db:
        ctx = KernelCtx(db=db, clock=runtime.clock, signer=runtime.signer, settings=runtime.settings)
        try:
            yield ctx
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
