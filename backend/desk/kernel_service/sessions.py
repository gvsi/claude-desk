"""Sessions: opening one, /whoami and the owner's take-over.

A session's state and principal are built from the kernel's own rows, never from a request.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Request
from sqlalchemy import select

from desk.contracts import LedgerEvent, Principal, SessionCreated, SessionState
from desk.db.models import Desk
from desk.kernel_api import CreateSessionRequest, ModeRequest, WhoAmI
from desk.kernel_service import auth, ledger, repo
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, route_template

router = APIRouter()


def verified(kind: str, assurance: str, person_id: str | None) -> bool:
    """An owner session, or a session /verify/check bound to a person (one per session). Cedar's
    `verified` attribute (`decide.cedar_request`) is the same rule."""
    return assurance != "none" and (kind == "owner" or person_id is not None)


def session_state(row: SessionRow) -> SessionState:
    return SessionState(session_id=row.session_id, kind=row.kind,
                        verified=verified(row.kind, row.assurance, row.person_id),
                        assurance=row.assurance, mode=row.mode, generation=row.generation)


def principal_for(row: SessionRow, *, desk_id: str | None = None) -> Principal:
    """The principal a decision sees, from the session's row alone. A visitor's or agent's Desk is
    its session's; an owner session belongs to the copy, so an owner call names the Desk it acts on
    (`desk_id`, which `auth.require_owner` has checked against the copy)."""
    if row.desk_id is not None and desk_id not in (None, row.desk_id):
        raise ValueError("a visitor or agent session acts only on its own Desk")
    desk = row.desk_id or desk_id
    if desk is None:
        raise ValueError("an owner principal acts on the Desk its call names")
    return Principal(kind=row.kind, session_id=row.session_id, copy_id=row.copy_id, desk_id=desk,
                     person_id=row.person_id, agent_key_id=row.agent_key_id, assurance=row.assurance,
                     mandate_id=row.mandate_id)


@router.post("/sessions", response_model=SessionCreated)
async def create_session(body: CreateSessionRequest, ctx: Ctx, request: Request) -> SessionCreated:
    """A visitor session on the Desk the slug names. A preview (`preview: true`) is the owner trying
    the Desk as a customer, so it needs `X-Owner-Session` of the slug's copy (else 401 `auth`,
    ledgered on the Desk); it gets a visitor's tools even while Answering is off. The owner's token
    is resolved with the slug, before the transaction reads the Desk (`repo.py`), and refused only
    where an owner check always is, after the agent check."""
    copy_id = await repo.copy_of_desk_slug(ctx, body.desk_slug)
    if copy_id is None:
        raise KernelFailure(404, "not_found", "unknown_desk")
    owner = await auth.owner_session(ctx, request, copy_id) if body.preview else None
    copy = ctx.bind(copy_id)
    desk = (await ctx.db.scalars(copy.scoped(select(Desk).where(Desk.slug == body.desk_slug)))).one()
    named = Named(copy_id=copy_id, desk_id=desk.desk_id)
    if body.kind == "agent":
        raise AuthError(401, "auth", "agent_auth_unavailable", route=route_template(request), named=named)
    if body.preview and owner is None:
        raise AuthError(401, "auth", "preview_unavailable", route=route_template(request), named=named)
    if desk.deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route_template(request), named=named)
    row, token = await open_visitor(ctx, copy_id, desk.desk_id, preview=body.preview)
    return SessionCreated(state=session_state(row), session_token=token)


async def open_visitor(ctx: KernelCtx, copy_id: str, desk_id: str, *, preview: bool = False
                       ) -> tuple[SessionRow, str]:
    """A new, unverified visitor session on the Desk and its token (stored only as its hash), with
    its `session` ledger entry, in the caller's transaction; the owner's preview is marked
    `preview` in its row and its entry."""
    now = ctx.clock.now()
    token = auth.new_token()
    row = SessionRow(session_id=auth.new_session_id(), copy_id=copy_id, desk_id=desk_id, kind="visitor",
                     secret_hash=auth.hash_token(token), verified=False, assurance="none", mode="ai", generation=0,
                     strikes=0, preview=preview, created_at=now, last_seen_at=now)
    ctx.db.add(row)
    await ctx.db.flush()
    summary = {"session_id": row.session_id, "kind": row.kind} | ({"preview": True} if preview else {})
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="session", origin="kernel", session_id=row.session_id,
                                          summary=summary))
    return row, token


@router.get("/whoami", response_model=WhoAmI)
async def whoami(ctx: Ctx, request: Request) -> WhoAmI:
    """The API's only source for the copy, session and generation: a visitor's `X-Session-Token`
    or the owner's `X-Owner-Session`, never both."""
    if auth.OWNER_HEADER in request.headers and auth.SESSION_HEADER not in request.headers:
        owner = await auth.require_owner(ctx, request)
        row = (await ctx.db.scalars(ctx.repo.scoped(
            select(SessionRow).where(SessionRow.session_id == owner.session_id)))).one()
        desk_ids = (await ctx.db.scalars(ctx.repo.scoped(
            select(Desk.desk_id).where(Desk.deleted_at.is_(None)).order_by(Desk.created_at, Desk.desk_id)))).all()
        return WhoAmI(kind="owner", copy_id=owner.copy_id, desk_id=None, desk_ids=list(desk_ids),
                      session=session_state(row))
    if auth.SESSION_HEADER in request.headers and auth.OWNER_HEADER not in request.headers:
        row = await auth.require_session_token(ctx, request)
        return WhoAmI(kind=row.kind, copy_id=row.copy_id, desk_id=row.desk_id, desk_ids=[row.desk_id],
                      session=session_state(row))
    raise AuthError(401, "auth", "bad_token", route=route_template(request))


@router.post("/sessions/{id}/mode", response_model=SessionState)
async def set_mode(session_id: Annotated[str, Path(alias="id")], body: ModeRequest, ctx: Ctx,
                   request: Request) -> SessionState:
    """The owner takes a conversation over or hands it back. The session row stays locked until the
    change commits, so a call that holds it (an execution's re-check) sees the old generation or
    the new one, never half of the change."""
    await auth.require_owner(ctx, request, session_id=session_id)
    row = (await ctx.db.scalars(ctx.repo.scoped(
        select(SessionRow).where(SessionRow.session_id == session_id).with_for_update()))).one()
    auth.require_open(ctx, request, row, generation=body.generation)
    if body.mode == "paused" or row.kind == "owner":
        # only the breaker pauses a session, and the owner's own session has no mode to set
        raise KernelFailure(422, "invalid", "mode_not_settable")
    if body.mode == row.mode:
        return session_state(row)
    previous = row.mode
    row.mode = body.mode
    row.generation += 1
    if previous == "paused":
        row.strikes = 0                   # the breaker starts over
    await ctx.db.flush()
    if (previous, row.mode) == ("paused", "ai"):
        kind, summary = "breaker", {"resumed": True}
    else:
        kind, summary = "takeover", {"from": previous, "to": row.mode, "generation": row.generation}
    await ledger.append(ctx, copy_id=row.copy_id, desk_id=row.desk_id,
                        event=LedgerEvent(kind=kind, origin="kernel", session_id=row.session_id, summary=summary))
    return session_state(row)
