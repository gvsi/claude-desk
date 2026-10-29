"""Test helpers: kernel rows and contexts outside a request."""

from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass

from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import NotificationDefaults
from desk.db.models import ActorSession, Business, Copy, Desk, LedgerEntry, NotificationPref
from desk.kernel_service import auth
from desk.kernel_service.repo import KernelCtx, kernel_transaction, new_id

NOTIFICATIONS = NotificationDefaults(now=["approval", "emergency", "breaker"], briefing=["lead", "callback", "booking"])


@dataclass(frozen=True)
class CopyRows:
    copy_id: str
    business_id: str
    desk_id: str
    slug: str
    owner_session_id: str
    owner_token: str                      # sent as X-Owner-Session

    @property
    def owner(self) -> dict[str, str]:
        return {auth.OWNER_HEADER: self.owner_token}


def kernel_ctx(app: FastAPI) -> AbstractAsyncContextManager[KernelCtx]:
    """A context on a new transaction, committed at the end of the block (rolled back on an exception)."""
    return kernel_transaction(app.state.kernel)


async def make_copy_rows(app: FastAPI, *, notifications: NotificationDefaults = NOTIFICATIONS) -> CopyRows:
    """A committed copy with a business, one Desk, its notification defaults and the copy's owner
    session (as `POST /copies` opens it), whose token the rows carry."""
    copy_id, desk_id = new_id("copy"), new_id("desk")
    rows = CopyRows(copy_id=copy_id, business_id=new_id("biz"), desk_id=desk_id, slug=f"rivera-plumbing-{desk_id[-6:]}",
                    owner_session_id=auth.new_session_id(), owner_token=auth.new_token())
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        now = ctx.clock.now()
        ctx.db.add_all([
            Copy(copy_id=rows.copy_id, created_at=now),
            Business(business_id=rows.business_id, copy_id=rows.copy_id, name="Rivera Plumbing",
                     owner_display_name="Maria Rivera", timezone="America/Los_Angeles"),
            Desk(desk_id=rows.desk_id, copy_id=rows.copy_id, business_id=rows.business_id, name="Main line",
                 slug=rows.slug, created_at=now),
            NotificationPref(desk_id=rows.desk_id, copy_id=rows.copy_id, now=notifications.now,
                             briefing=notifications.briefing),
            ActorSession(session_id=rows.owner_session_id, copy_id=rows.copy_id, desk_id=None, kind="owner",
                         secret_hash=auth.hash_token(rows.owner_token), verified=True, assurance="owner_session",
                         created_at=now, last_seen_at=now),
        ])
    return rows


async def rows_of(app: FastAPI, copy_id: str, stmt) -> list:
    """The committed rows a SELECT finds in a copy, through KernelRepo.scoped()."""
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy_id)
        return list((await ctx.db.scalars(repo.scoped(stmt))).all())


async def ledger_rows(app: FastAPI, rows: CopyRows) -> list[LedgerEntry]:
    return await rows_of(app, rows.copy_id,
                         select(LedgerEntry).where(LedgerEntry.desk_id == rows.desk_id).order_by(LedgerEntry.seq))
