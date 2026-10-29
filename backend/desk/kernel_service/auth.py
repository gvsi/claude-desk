"""Who is calling: session tokens, owner tokens and the session-state checks.

No call names its principal. A visitor sends `X-Session-Token`, which must hash to the
`secret_hash` of the session the call names; the owner sends `X-Owner-Session`, which must hash
to an open owner session of the copy the call touches. Tokens are 256-bit CSPRNG values, stored
only as their sha256, and session IDs are 128-bit.

Every refusal is an `AuthError`: the answer is a bare `KernelError{code}`, and the attempt goes
on the ledger of the session or Desk the request named as an `auth` entry `{route, reason}` (the
route template and a fixed reason code, never a token). A request that names no existing session
or Desk has no ledger to go on, so it is logged as one `auth_unattributed` line instead.
"""

import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial

from fastapi import Request
from sqlalchemy import select

from desk.contracts import LedgerEvent
from desk.db.models import ActorSession, Desk
from desk.kernel_service import ledger, repo
from desk.kernel_service.repo import KernelCtx, KernelFailure, route_template

SessionRow = ActorSession

log = logging.getLogger("desk.kernel_service")

SESSION_HEADER = "X-Session-Token"
OWNER_HEADER = "X-Owner-Session"
IDLE_LIMIT = timedelta(hours=24)          # visitor and agent sessions close after this long idle

REASONS = frozenset({
    "unknown_session", "bad_token", "wrong_copy", "closed", "stale_generation", "bad_owner_token",
    "agent_auth_unavailable", "preview_unavailable", "wrong_session", "mode_owner", "mode_paused", "call_conflict",
    "unknown_decision",
})


def new_token() -> str:
    """A session or owner token (256 bits, URL-safe), shown once and stored only as `hash_token`."""
    return secrets.token_urlsafe(32)


def new_session_id() -> str:
    return secrets.token_urlsafe(16)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True)
class Named:
    """The existing session or Desk a refused request named: its Desk's ledger records the refusal.
    A session found only by its copy (`desk_id` None) has its Desk read when the refusal is written."""

    copy_id: str
    desk_id: str | None = None
    session_id: str | None = None


@dataclass(frozen=True)
class OwnerCtx:
    copy_id: str
    session_id: str


class AuthError(KernelFailure):
    """A refused credential or session state, ledgered on `named`'s Desk, or logged when `named` is None."""

    def __init__(self, status: int, code: str, reason: str, *, route: str, named: Named | None = None):
        if reason not in REASONS:
            raise ValueError(f"{reason!r} is not an auth reason")
        persist = None if named is None else partial(_ledger_refusal, named=named, route=route, reason=reason)
        super().__init__(status, code, reason, persist=persist)
        self.route = route
        self.named = named


async def _ledger_refusal(ctx: KernelCtx, *, named: Named, route: str, reason: str) -> None:
    """The refusal's `auth` entry, in the fresh transaction `KernelFailure.persist` runs in."""
    copy = ctx.bind(named.copy_id)
    desk_id = named.desk_id
    if desk_id is None and named.session_id is not None:
        desk_id = (await ctx.db.execute(copy.scoped(
            select(SessionRow.desk_id).where(SessionRow.session_id == named.session_id)))).scalar_one_or_none()
    if desk_id is None:   # an owner session of another copy: it belongs to the copy and has no Desk ledger
        log.warning("auth_unattributed route=%s reason=%s", route, reason)
        return
    await ledger.append(ctx, copy_id=named.copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="auth", origin="kernel", session_id=named.session_id,
                                          summary={"route": route, "reason": reason}))


async def require_session(ctx: KernelCtx, request: Request, session_id: str, *, generation: int | None = None,
                          desk_id: str | None = None) -> SessionRow:
    """The visitor or agent session `session_id`, once `X-Session-Token` proves it ("Session state
    responses", first four rows in order). Binds the request's transaction to the session's copy."""
    route = route_template(request)
    copy_id = await repo.copy_of_session_id(ctx, session_id)
    if copy_id is None:
        raise AuthError(401, "auth", "unknown_session", route=route)
    copy = ctx.bind(copy_id)
    row = (await ctx.db.scalars(copy.scoped(select(SessionRow).where(SessionRow.session_id == session_id)))).one()
    named = Named(copy_id=copy_id, desk_id=row.desk_id, session_id=row.session_id) if row.desk_id else None
    token = request.headers.get(SESSION_HEADER)
    # owner sessions authenticate only with X-Owner-Session (require_owner)
    if row.kind == "owner" or not token or not hmac.compare_digest(row.secret_hash or "", hash_token(token)):
        raise AuthError(401, "auth", "bad_token", route=route, named=named)
    if desk_id is not None and desk_id != row.desk_id:
        raise AuthError(404, "not_found", "wrong_copy", route=route, named=named)
    require_open(ctx, request, row, generation=generation)
    row.last_seen_at = ctx.clock.now()
    return row


async def require_session_token(ctx: KernelCtx, request: Request) -> SessionRow:
    """The open visitor or agent session `X-Session-Token` hashes to (`GET /whoami`, which names no
    session). Binds the request's transaction to the session's copy."""
    route = route_template(request)
    token = request.headers.get(SESSION_HEADER)
    token_hash = hash_token(token) if token else None
    copy_id = await repo.copy_of_session_token(ctx, token_hash) if token_hash else None
    if copy_id is None:
        raise AuthError(401, "auth", "bad_token", route=route)
    copy = ctx.bind(copy_id)
    row = (await ctx.db.scalars(copy.scoped(select(SessionRow).where(SessionRow.secret_hash == token_hash)))).one()
    if row.kind == "owner" or not hmac.compare_digest(row.secret_hash, token_hash):
        raise AuthError(401, "auth", "bad_token", route=route)      # the owner token goes in X-Owner-Session
    require_open(ctx, request, row)
    row.last_seen_at = ctx.clock.now()
    return row


def is_closed(row: SessionRow, now: datetime) -> bool:
    """Closed by the kernel, or a visitor or agent session idle for more than `IDLE_LIMIT`; owner
    sessions last as long as the copy."""
    if row.closed_at is not None:
        return True
    return row.kind != "owner" and now - (row.last_seen_at or row.created_at) > IDLE_LIMIT


def require_open(ctx: KernelCtx, request: Request, row: SessionRow, *, generation: int | None = None) -> None:
    """The last two session-state rows for a session already authenticated: open, then (when the
    call carries one) at the session's current generation."""
    named = Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id) if row.desk_id else None
    if is_closed(row, ctx.clock.now()):
        raise AuthError(409, "closed", "closed", route=route_template(request), named=named)
    if generation is not None and generation != row.generation:
        raise AuthError(409, "stale_generation", "stale_generation", route=route_template(request), named=named)


async def require_owner(ctx: KernelCtx, request: Request, *, desk_id: str | None = None,
                        session_id: str | None = None) -> OwnerCtx:
    """The owner session `X-Owner-Session` proves and the copy it owns ("Session state responses",
    first two rows): the Desk `desk_id`, or the session `session_id`, must belong to that copy.
    Binds the request's transaction to the owner's copy."""
    route = route_template(request)
    # the session a call names is found first, so a refusal goes on its ledger, whatever copy it is in
    target_copy = await repo.copy_of_session_id(ctx, session_id) if session_id is not None else None
    named = Named(copy_id=target_copy, session_id=session_id) if target_copy is not None else None
    token = request.headers.get(OWNER_HEADER)
    token_hash = hash_token(token) if token else None
    copy_id = await repo.copy_of_session_token(ctx, token_hash) if token_hash else None
    if copy_id is None:
        raise AuthError(401, "auth", "bad_owner_token", route=route, named=named)
    copy = ctx.bind(copy_id)
    row = (await ctx.db.scalars(copy.scoped(select(SessionRow).where(SessionRow.secret_hash == token_hash)))).one()
    if row.kind != "owner" or row.closed_at is not None or not hmac.compare_digest(row.secret_hash, token_hash):
        raise AuthError(401, "auth", "bad_owner_token", route=route, named=named)
    if session_id is not None and target_copy != copy_id:
        raise AuthError(404, "not_found", "wrong_copy" if named else "unknown_session", route=route, named=named)
    if desk_id is not None:
        found = (await ctx.db.execute(copy.scoped(select(Desk.desk_id).where(Desk.desk_id == desk_id)))).first()
        if found is None:   # no Desk of this copy; one of another copy isn't looked up
            raise AuthError(404, "not_found", "wrong_copy", route=route)
    return OwnerCtx(copy_id=copy_id, session_id=row.session_id)
