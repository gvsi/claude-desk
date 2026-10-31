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
from typing import Literal

from fastapi import Request
from sqlalchemy import select

from desk.contracts import LedgerEvent
from desk.db.models import ActorSession, Desk, Person
from desk.db.models import Decision as DecisionRow
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
    "unknown_decision", "unknown_handoff",
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
    A session found only by its copy (`desk_id` None) has its Desk read when the refusal is written.
    A decision (`decision_id`) names its own session ("Kernel HTTP API v2", Credentials), whose
    session and Desk are read then too."""

    copy_id: str
    desk_id: str | None = None
    session_id: str | None = None
    decision_id: str | None = None


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
    desk_id, session_id = named.desk_id, named.session_id
    if named.decision_id is not None:
        found = (await ctx.db.execute(copy.scoped(select(DecisionRow.desk_id, DecisionRow.session_id).where(
            DecisionRow.decision_id == named.decision_id)))).first()
        desk_id, session_id = found if found is not None else (None, None)
    if desk_id is None and session_id is not None:
        desk_id = (await ctx.db.execute(copy.scoped(
            select(SessionRow.desk_id).where(SessionRow.session_id == session_id)))).scalar_one_or_none()
    if desk_id is None:   # an owner session of another copy: it belongs to the copy and has no Desk ledger
        log.warning("auth_unattributed route=%s reason=%s", route, reason)
        return
    await ledger.append(ctx, copy_id=named.copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="auth", origin="kernel", session_id=session_id,
                                          summary={"route": route, "reason": reason}))


async def named_session(ctx: KernelCtx, session_id: str | None, *, copy_id: str | None = None) -> Named | None:
    """The existing session a request names by ID, whose Desk's ledger records its refusal; None
    when no session has that ID. `copy_id` is the session's copy when the request's transaction has
    already read it there (see `authenticate_session`), and then no resolver is asked."""
    if copy_id is None and session_id is not None:
        copy_id = await repo.copy_of_session_id(ctx, session_id)
    return Named(copy_id=copy_id, session_id=session_id) if copy_id is not None else None


async def caller(ctx: KernelCtx, request: Request, session_id: str | None, *,
                 copy_id: str | None = None) -> Literal["owner", "session"]:
    """Which credential a call that takes either carries: the owner's or a session's. Neither, or
    both, is 401, ledgered on the session the call names (`session_id`, of the copy `copy_id` when
    the request's transaction has already read it there), as any refusal is."""
    owner, session = OWNER_HEADER in request.headers, SESSION_HEADER in request.headers
    if owner != session:
        return "owner" if owner else "session"
    raise AuthError(401, "auth", "bad_token", route=route_template(request),
                    named=await named_session(ctx, session_id, copy_id=copy_id))


async def require_session(ctx: KernelCtx, request: Request, session_id: str, *, generation: int | None = None,
                          desk_id: str | None = None, copy_id: str | None = None, seen: bool = True) -> SessionRow:
    """The visitor or agent session `session_id`, once `X-Session-Token` proves it ("Session state
    responses", first four rows in order). Binds the request's transaction to the session's copy
    (`copy_id`: see `authenticate_session`). The session is seen now (`last_seen_at`), a write
    the transaction's next statement sends, which locks the row until it commits; a route that
    calls a model before it commits passes `seen=False` and writes it at its end instead
    (`/check_reply`, in `reply_check.finalize`), so a take-over never waits for the model."""
    row = await authenticate_session(ctx, request, session_id, desk_id=desk_id, copy_id=copy_id)
    require_open(ctx, request, row, generation=generation)
    if seen:
        row.last_seen_at = ctx.clock.now()
    return row


async def authenticate_session(ctx: KernelCtx, request: Request, session_id: str, *,
                               desk_id: str | None = None, copy_id: str | None = None) -> SessionRow:
    """The first two session-state rows for the visitor or agent session `session_id`:
    `X-Session-Token` proves it, and it belongs to `desk_id` when the call names one. Binds the
    request's transaction to the session's copy and returns the row as read, unlocked and with its
    state unchecked: `require_session` runs the open and generation checks on it, and
    `check_caller` (for `/decide`, after `lock_session`) runs them itself, so that from here on a
    failure can be ledgered on the session.

    The session's copy comes from its resolver, which runs on a connection of its own and so only
    before the request's transaction has taken one (`repo.py`). A route whose transaction has
    already read the session's copy (`GET /decisions/{id}`, which finds the session through its
    decision) passes that copy as `copy_id`, a value from the row it read and never from the
    request: the session is looked up there, and no request holds one connection while it waits
    for another. A session that copy doesn't hold is unknown, as for the resolver."""
    route = route_template(request)
    if copy_id is None:
        copy_id = await repo.copy_of_session_id(ctx, session_id)
    if copy_id is None:
        raise AuthError(401, "auth", "unknown_session", route=route)
    copy = ctx.bind(copy_id)
    row = (await ctx.db.scalars(copy.scoped(select(SessionRow).where(
        SessionRow.session_id == session_id)))).one_or_none()
    if row is None:
        raise AuthError(401, "auth", "unknown_session", route=route)
    named = Named(copy_id=copy_id, desk_id=row.desk_id, session_id=row.session_id) if row.desk_id else None
    token = request.headers.get(SESSION_HEADER)
    # owner sessions authenticate only with X-Owner-Session (require_owner)
    if row.kind == "owner" or not token or not hmac.compare_digest(row.secret_hash or "", hash_token(token)):
        raise AuthError(401, "auth", "bad_token", route=route, named=named)
    if desk_id is not None and desk_id != row.desk_id:
        raise AuthError(404, "not_found", "wrong_copy", route=route, named=named)
    await watch_session(ctx, request, row)
    return row


async def lock_session(ctx: KernelCtx, session_id: str) -> SessionRow:
    """The session's row read again under `FOR UPDATE` and held until the transaction ends. A
    take-over or hand-back locks the same row, so one that committed first shows its generation and
    mode here, and one that comes later waits for this transaction. Take it only once the caller's
    token is proved, so a request without the token can't hold up a take-over."""
    return (await ctx.db.scalars(ctx.repo.scoped(
        select(SessionRow).where(SessionRow.session_id == session_id).with_for_update()
        .execution_options(populate_existing=True)))).one()


async def require_session_token(ctx: KernelCtx, request: Request, *, watch: bool = True) -> SessionRow:
    """The open visitor or agent session `X-Session-Token` hashes to (`GET /whoami`, which names no
    session). Binds the request's transaction to the session's copy. The session is watched
    (`watch_session`) unless `watch` is False, which only a route that records something already
    done and answers nothing else passes (`POST /ledger/append`): no recheck may take a record back."""
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
    if watch:
        await watch_session(ctx, request, row)
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


async def watch_session(ctx: KernelCtx, request: Request, row: SessionRow) -> None:
    """Has the request check the visitor or agent session `row` again once its reads are done
    (`still_open`, which `KernelCtx.commit` and the end of the request's transaction run). Each
    route checks the session's state on the row as it read it, most without a lock, and reads what
    the session may see by the person it read it verified as; the owner may close the session in
    between (a contact change or removal, the Desk's deletion), and the request then answers
    nothing it read. Called wherever a session's token is proved (`authenticate_session`,
    `require_session_token`), so every route a session calls is watched."""
    ctx.rechecks.setdefault(f"session:{row.session_id}", partial(
        still_open, ctx, request, Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id),
        row.person_id))


async def still_open(ctx: KernelCtx, request: Request, named: Named, person_id: str | None) -> None:
    """The session `named` still stands (`session_stands`), or 409 `closed`, ledgered on the session
    as `require_open` ledgers it."""
    if not await session_stands(ctx, named, person_id):
        raise AuthError(409, "closed", "closed", route=route_template(request), named=named)


async def session_stands(ctx: KernelCtx, named: Named, person_id: str | None) -> bool:
    """Whether the session `named`, as the database has it now, read afresh in the request's
    transaction, is open, verified as `person_id` when it was so when its token was proved (a
    session that a right code verifies in this request gains a person, which is never changed or
    dropped), that person still on record, and its Desk not deleted. An execution's T2 asks it too,
    before its adapter runs (`execute._side_effect`)."""
    session = (await ctx.db.execute(ctx.repo.scoped(select(SessionRow.closed_at, SessionRow.person_id).where(
        SessionRow.session_id == named.session_id)))).one_or_none()
    if session is None or session.closed_at is not None or person_id not in (None, session.person_id):
        return False
    if session.person_id is not None:
        person = (await ctx.db.execute(ctx.repo.scoped(select(Person.removed_at).where(
            Person.person_id == session.person_id)))).one_or_none()
        if person is None or person.removed_at is not None:
            return False
    desk = (await ctx.db.execute(ctx.repo.scoped(select(Desk.deleted_at).where(
        Desk.desk_id == named.desk_id)))).one_or_none()
    return desk is not None and desk.deleted_at is None


async def owner_session(ctx: KernelCtx, request: Request, copy_id: str | None = None) -> SessionRow | None:
    """The open owner session `X-Owner-Session` proves, or None: the one owner check, for the
    owner's routes (`require_owner`) and the owner's preview. With `copy_id`, only an owner session
    of that copy counts. Binds the request's transaction to the owner's copy once the token names
    one (and, with `copy_id`, only when it is that copy)."""
    token = request.headers.get(OWNER_HEADER)
    token_hash = hash_token(token) if token else None
    owner_copy = await repo.copy_of_session_token(ctx, token_hash) if token_hash else None
    if owner_copy is None or copy_id not in (None, owner_copy):
        return None
    row = (await ctx.db.scalars(ctx.bind(owner_copy).scoped(
        select(SessionRow).where(SessionRow.secret_hash == token_hash)))).one_or_none()
    if row is None or row.kind != "owner" or row.closed_at is not None:
        return None
    return row if hmac.compare_digest(row.secret_hash, token_hash) else None


async def require_owner(ctx: KernelCtx, request: Request, *, desk_id: str | None = None,
                        session_id: str | None = None, named: Named | None = None) -> OwnerCtx:
    """The owner session `X-Owner-Session` proves and the copy it owns ("Session state responses",
    first two rows): the Desk `desk_id`, or the session `session_id`, must belong to that copy.
    Binds the request's transaction to the owner's copy. A refused token goes on the ledger of the
    session `session_id` names, or of `named` when the call names its session another way (the
    decision `GET /decisions/{id}` reads), and is logged when there is none. A call passes one of
    the two, never both (`ValueError`)."""
    if session_id is not None and named is not None:
        raise ValueError("require_owner takes session_id or named, not both")
    route = route_template(request)
    # the session a call names is found first, so a refusal goes on its ledger, whatever copy it is in
    target_copy = await repo.copy_of_session_id(ctx, session_id) if session_id is not None else None
    if session_id is not None:
        named = Named(copy_id=target_copy, session_id=session_id) if target_copy is not None else None
    row = await owner_session(ctx, request)
    if row is None:
        raise AuthError(401, "auth", "bad_owner_token", route=route, named=named)
    copy_id, copy = row.copy_id, ctx.repo
    if session_id is not None and target_copy != copy_id:
        raise AuthError(404, "not_found", "wrong_copy" if named else "unknown_session", route=route, named=named)
    if desk_id is not None:
        found = (await ctx.db.execute(copy.scoped(select(Desk.desk_id).where(Desk.desk_id == desk_id)))).first()
        if found is None:   # no Desk of this copy; one of another copy isn't looked up
            raise AuthError(404, "not_found", "wrong_copy", route=route)
    return OwnerCtx(copy_id=copy_id, session_id=row.session_id)


async def authenticate_caller(ctx: KernelCtx, request: Request, session_id: str, desk_id: str | None) -> Named:
    """The first session-state rows for a call that takes either credential ("Session state
    responses"): a session's own token, on its own Desk; or the owner's token, for the owner's own
    session and a Desk of its copy. Binds the request's transaction to the caller's copy and
    returns the session and Desk the call acts for, with the session's state unchecked:
    `check_caller` runs the rest, so that from here on a failure can be ledgered on the session.

    The owner must name its Desk, and a request that doesn't is 422 only once the caller is
    known, so a bad token is always 401 and acting as another session is always ledgered."""
    route = route_template(request)
    if await caller(ctx, request, session_id) == "owner":
        owner = await require_owner(ctx, request, desk_id=desk_id, session_id=session_id)
        if session_id != owner.session_id:
            raise AuthError(404, "not_found", "wrong_session", route=route,
                            named=Named(copy_id=owner.copy_id, session_id=session_id))
        if desk_id is None:
            raise KernelFailure(422, "invalid", "owner_names_no_desk")
        return Named(copy_id=owner.copy_id, desk_id=desk_id, session_id=owner.session_id)
    row = await authenticate_session(ctx, request, session_id, desk_id=desk_id)
    return Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id)


async def check_caller(ctx: KernelCtx, request: Request, named: Named, *, generation: int | None = None,
                       lock: bool = False) -> tuple[SessionRow, Desk]:
    """The rest of the session-state rows for a caller `authenticate_caller` proved: its session
    open, at `generation` when the call carries one, on a Desk not deleted (409 `closed`); a
    visitor's or agent's session is seen now. With `lock`, the checks run on the session's row as
    `lock_session` reads it, held until the transaction ends."""
    if lock:
        row = await lock_session(ctx, named.session_id)
    else:
        row = (await ctx.db.scalars(ctx.repo.scoped(
            select(SessionRow).where(SessionRow.session_id == named.session_id)))).one()
    require_open(ctx, request, row, generation=generation)
    if row.kind != "owner":
        row.last_seen_at = ctx.clock.now()        # visitor and agent sessions idle out (`is_closed`)
    return row, await require_desk(ctx, request, row, named.desk_id)


async def require_caller(ctx: KernelCtx, request: Request, session_id: str, desk_id: str | None, *,
                         generation: int | None = None) -> tuple[SessionRow, Desk]:
    """The session a call that takes either credential acts for, and the Desk it acts on, once
    every session-state row passes (`authenticate_caller`, then `check_caller`)."""
    named = await authenticate_caller(ctx, request, session_id, desk_id)
    return await check_caller(ctx, request, named, generation=generation)


async def require_desk(ctx: KernelCtx, request: Request, row: SessionRow, desk_id: str) -> Desk:
    """The Desk an authenticated session's call acts on, of the session's copy, read afresh; a
    deleted Desk closes its sessions and the owner's work on it (409 `closed`)."""
    desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id)
                                                     .execution_options(populate_existing=True)))).one()
    if desk_row.deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route_template(request),
                        named=Named(copy_id=row.copy_id, desk_id=desk_row.desk_id, session_id=row.session_id))
    return desk_row
