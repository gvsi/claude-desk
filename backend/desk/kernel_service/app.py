"""The kernel's FastAPI app, its settings and how it is served.

The kernel binds 127.0.0.1:8701 and nothing changes that: the API process in the same task is
its only client. The lifespan first refuses the test hooks outside development (a fake model
server, a stand-in prover, an offline reviewer, a frozen clock), then builds the reviewer
(`app.state.kernel.decisions`), so a kernel with `ANTHROPIC_CUSTOM_HEADERS` set or a malformed
`ANTHROPIC_API_KEY`, or a production kernel without one, refuses to start
(`decisions.make_decisions`), and the signer, so a production kernel without `DESK_SIGNING_SEED`
refuses to start, then the policy engine over the always-on baseline
(`app.state.engine`; a baseline it can't take stops the start too) with the shipped proof reports
in its cache, then runs `desk-prove --selftest` once to pick the proof mode for the whole process
(`symcc` or `bounded`, which `/health` reports), then the database engine (role desk_kernel), and
last reconciles the executions a stopped kernel left behind (`execute.reconcile_at_startup`).

Every non-2xx answer is a `KernelError{code}` ("Session state responses"): a `KernelFailure`
answers its own code, request validation 422 `invalid`, the framework's own errors (an unknown
route, a wrong method) the code for their status, and anything unhandled 500 `internal`, after
the request's transaction has rolled back.
"""

import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Annotated, Any

import desk_kernel
import uvicorn
from fastapi import APIRouter, FastAPI, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, BeforeValidator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from desk.contracts import (DemoInboxEntry, KnowledgeItem, LedgerEntry, LedgerEvent, LedgerPage, OwnerMessageResult,
                            PolicyVersion)
from desk.db import logs as db_logs
from desk.db.models import Desk, Fact, Handoff
from desk.db.session import KernelSession, database_url
from desk.env import is_development
from desk.kernel_api import (CreateDeskRequest, DeskCreated, DeskUpdated, DocumentCreated, DocumentUploadRequest,
                             Health, KernelError, KnowledgeRequest, LedgerAppendRequest, OwnerMessageRequest,
                             PolicyConfirmRequest, PolicyDraftRequest)
from desk.kernel_service import (activation, approvals, auth, context, copies, decide, demo_inbox, desks, execute,
                                 labels, ledger, public, reply_check, sessions, verification)
from desk.kernel_service.adapters import release_document
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.clock import Clock, SystemClock
from desk.kernel_service.decisions import DecisionsBackend, make_decisions
from desk.kernel_service.repo import (Ctx, KernelCtx, KernelFailure, KernelRuntime, kernel_transaction, log_error,
                                      route_template, storable)

log = logging.getLogger("desk.kernel_service")

# A link's path carries its single-use token (`/document_links/{token}`, and Plan 01c's
# `/payment_links/{token}`); its segment is written `<redacted>` wherever it is logged.
LINK_TOKEN_PATH = re.compile(r"(/(?:document_links|payment_links)/)[^/?#\s\"]+")


def redact_link_tokens(text: str) -> str:
    return LINK_TOKEN_PATH.sub(r"\1<redacted>", text)


class RedactLinkTokens(logging.Filter):
    """On the `uvicorn.access` logger: a request line's link token, in its message or its
    arguments, becomes `<redacted>`. `serve_config` keeps the access log off; this covers a kernel
    run with it on (uvicorn's command line turns it on by default)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_link_tokens(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_link_tokens(arg) if isinstance(arg, str) else arg for arg in record.args)
        return True


ACCESS_LOG_FILTER = RedactLinkTokens()


@dataclass(frozen=True)
class KernelSettings:
    database_url: str = field(repr=False)   # carries the role's password
    env: str = "dev"                        # DESK_ENV
    decisions: str = "anthropic"            # DESK_DECISIONS: "anthropic", or "offline" (a test hook)

    @classmethod
    def from_env(cls) -> "KernelSettings":
        return cls(database_url=database_url("KERNEL"), env=os.environ.get("DESK_ENV", "dev"),
                   decisions=os.environ.get("DESK_DECISIONS", "anthropic"))


TEST_HOOK_VARIABLES = ("ANTHROPIC_BASE_URL", "DESK_PROVE")   # a fake model server; a stand-in prover


def refuse_test_hooks(settings: KernelSettings, clock: Clock, decisions: DecisionsBackend | None) -> None:
    """Outside development (the settings' DESK_ENV or the process's), a test hook stops the kernel
    from starting: either variable above set at all, a decisions backend other than `anthropic`
    (named or passed in) or a clock other than `SystemClock`."""
    if is_development(settings.env) and is_development():
        return
    hooks = [name for name in TEST_HOOK_VARIABLES if name in os.environ]
    if settings.decisions != "anthropic":
        hooks.append("DESK_DECISIONS")
    if decisions is not None:
        hooks.append("a decisions backend passed to create_app")
    if type(clock) is not SystemClock:
        hooks.append("a clock other than SystemClock")
    if hooks:
        env = settings.env if not is_development(settings.env) else os.environ.get("DESK_ENV", "")
        raise RuntimeError(f"test hooks can't run with DESK_ENV={env!r}: {', '.join(hooks)}")


def create_app(settings: KernelSettings | None = None, clock: Clock | None = None,
               decisions: DecisionsBackend | None = None) -> FastAPI:
    """The kernel app. `clock` and `decisions` are test hooks (the reviewer by default comes from
    `DESK_DECISIONS`); the lifespan refuses them outside development."""
    settings = settings or KernelSettings.from_env()
    clock = clock or SystemClock()
    logging.getLogger("uvicorn.access").addFilter(ACCESS_LOG_FILTER)   # once: the same filter isn't added twice
    db_logs.install()                     # a database error is logged without its text; once, too

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        refuse_test_hooks(settings, clock, decisions)
        reviewer = decisions if decisions is not None else make_decisions(settings)
        signer = desk_kernel.Signer.from_env()   # raises without a seed outside development
        if signer.dev_key and not is_development(settings.env):
            # the process environment and the settings each name the environment; either one
            # that isn't development refuses the public dev key
            raise RuntimeError(f"DESK_SIGNING_SEED is required: the kernel settings name DESK_ENV={settings.env!r}")
        policies = activation.PolicyRuntime.start(app.state.unproved_seeds)   # raises on a baseline it can't take
        app.state.engine, app.state.loaded_versions = policies.engine, policies.versions
        app.state.proof_mode = await activation.run_selftest()               # symcc or bounded, for the whole process
        # a failed statement's error names no bound value (some carry a code or a token); what
        # Postgres's own text says is kept out of the log by `db_logs`
        engine = create_async_engine(settings.database_url, pool_pre_ping=True, hide_parameters=True)
        factory = async_sessionmaker(engine, expire_on_commit=False, sync_session_class=KernelSession)
        app.state.kernel = KernelRuntime(settings=settings, clock=clock, signer=signer, engine=engine,
                                         sessions=factory, policies=policies, decisions=reviewer)
        try:
            try:
                # executions a stopped kernel left behind; a read settles them too, so a failure
                # here is logged and the kernel starts
                await execute.reconcile_at_startup(app.state.kernel)
            except Exception as exc:
                log_error(log, exc, "startup_reconcile_failed")
            yield
        finally:
            await engine.dispose()

    app = FastAPI(title="Claude Desk kernel", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.proof_mode = "bounded"   # until the startup selftest passes
    app.state.unproved_seeds = set()   # shipped rule sets that couldn't activate for want of a report
    app.add_exception_handler(KernelFailure, _kernel_failure)
    app.add_exception_handler(RequestValidationError, _invalid_request)
    app.add_exception_handler(StarletteHTTPException, _framework_error)
    app.add_middleware(InternalErrors)
    app.include_router(sessions.router)
    app.include_router(copies.router)
    app.include_router(decide.router)
    app.include_router(execute.router)
    app.include_router(approvals.router)
    app.include_router(context.router)
    app.include_router(reply_check.router)
    app.include_router(public.router)
    app.include_router(verification.router)
    app.include_router(desk_router)
    app.include_router(document_link_router)
    app.include_router(inbox_router)
    app.include_router(handoff_router)
    app.include_router(owner_router)
    app.include_router(ledger_router)
    app.include_router(policy_router)

    @app.get("/health", response_model=Health)
    async def health(request: Request) -> Health:
        signer = request.app.state.kernel.signer
        return Health(version=desk_kernel.version(), proof_mode=request.app.state.proof_mode,
                      dev_signing_key=signer.dev_key, public_key_hex=signer.public_key_hex(),
                      key_id=signer.key_id(), unproved_seeds=sorted(request.app.state.unproved_seeds))

    return app


desk_router = APIRouter()


@desk_router.post("/desks", response_model=DeskCreated)
async def post_desk(body: CreateDeskRequest, ctx: Ctx, request: Request) -> DeskCreated:
    """A new Desk in the owner's copy, with the starter preset (`ask_first`) active from its shipped
    report at a money cap of 0, in one transaction: a preset with no report for the Desk's tools is
    503 `seed_unproved` and creates nothing. A new Desk connects no MCP server (`/tools/connect`
    does), and its first cap is 0, every charge and payout asking ("Money cap"): a nonzero
    `auto_money_cap_cents` is 422 `invalid`, since the presets are proved at 0; the owner raises it
    with a draft they confirm."""
    owner = await desks.owner_alone(ctx, request)
    if body.desk.connections:
        raise KernelFailure(422, "invalid", "desk_connections")
    if body.desk.auto_money_cap_cents != 0:
        raise KernelFailure(422, "invalid", "desk_money_cap")
    created = await desks.create_desk(ctx, owner.copy_id, body.business, body.desk)
    await activation.activate_shipped(ctx, created.desk_id, "ask_first", 0)
    return created


@desk_router.delete("/desks/{id}", status_code=204)
async def delete_desk(desk_id: Annotated[str, Path(alias="id")], ctx: Ctx, request: Request) -> Response:
    """Deletes a Desk of the owner's copy (`desks.delete_desk`); its ledger stays readable."""
    await desks.delete_desk(ctx, await desks.owner_desk(ctx, request, desk_id))
    return Response(status_code=204)


@desk_router.post("/documents", response_model=DocumentCreated)
async def post_document(body: DocumentUploadRequest, ctx: Ctx, request: Request) -> DocumentCreated:
    """A document on a Desk of the owner's copy, with a fresh canary (`desks.upload_document`)."""
    return await desks.upload_document(ctx, await desks.owner_desk(ctx, request, body.desk_id), body.document)


@desk_router.post("/knowledge", response_model=KnowledgeItem)
async def post_knowledge(body: KnowledgeRequest, ctx: Ctx, request: Request) -> KnowledgeItem:
    """A knowledge item on a Desk of the owner's copy (`labels.store_knowledge`)."""
    desk_row = await desks.owner_desk(ctx, request, body.desk_id)
    return await labels.store_knowledge(ctx, desk_row.desk_id, body.item)


def _put_route(part: str, model: type[BaseModel]) -> None:
    """`PUT /desks/{id}/<part>` with that part's body model (`desks.PARTS`)."""

    async def put(desk_id: Annotated[str, Path(alias="id")], body: model, ctx: Ctx,   # type: ignore[valid-type]
                  request: Request) -> DeskUpdated:
        return await desks.put_part(ctx, request, desk_id, part, body)

    desk_router.put(f"/desks/{{id}}/{part}", response_model=DeskUpdated, name=f"put_desk_{part}")(put)


for _part, (_model, _) in desks.PARTS.items():
    _put_route(_part, _model)


document_link_router = APIRouter()


# A released document is stored by no one who passes it on, read as plain text and nothing else,
# sends no Referer with its token to anywhere it is followed from, and is shown rather than saved.
DOCUMENT_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}


@document_link_router.get("/document_links/{token}")
async def get_document_link(token: str, ctx: Ctx) -> Response:
    """A released document, by its link's token alone (`release_document.open_document_link`):
    the bytes on the link's first open within a day, under `DOCUMENT_HEADERS` and a file name made
    from its title (never from the request), and 404 `not_found` for every other link. The API
    proxies it at `/api/d/{token}` with these headers as they are."""
    document = await release_document.open_document_link(ctx, token)
    return Response(content=document.body, media_type=document.media_type, headers={
        **DOCUMENT_HEADERS, "Content-Disposition": f'inline; filename="{document.filename}"'})


inbox_router = APIRouter()


@inbox_router.get("/demo_inbox", response_model=list[DemoInboxEntry])
async def read_demo_inbox(ctx: Ctx, request: Request, session_id: str | None = None) -> list[DemoInboxEntry]:
    """The Demo inbox: with `session_id` (`X-Session-Token`), the verification codes of the people
    the session asked to verify as, including codes another session asked for them, and nothing
    else; without it, every entry of the owner's copy (`X-Owner-Session`)."""
    if session_id is None:
        await auth.require_owner(ctx, request)
        return await demo_inbox.owner_entries(ctx)
    row = await auth.require_session(ctx, request, session_id)
    await auth.require_desk(ctx, request, row, row.desk_id)
    return await demo_inbox.session_entries(ctx, row)


handoff_router = APIRouter()


@handoff_router.post("/handoffs/{handoff_id}/done", response_model=DeskUpdated)
async def close_handoff(handoff_id: str, ctx: Ctx, request: Request) -> DeskUpdated:
    """The owner has called the visitor back: the handoff goes from `open` to `done` under its
    row's lock, and its `handoff:<id>` fact to `expired` (a callback that happened can't be
    promised again), ledgered `desk_data` `{part: "handoffs", refs: [handoff_id]}` in the same
    transaction, with the owner's credential alone. One already done is 409 `conflict`, changing
    nothing. One the owner's copy doesn't have, unknown or another copy's (row-level security
    hides those), is 404 `not_found`, logged, since there is no Desk of the copy to ledger it on."""
    route = route_template(request)
    if auth.SESSION_HEADER in request.headers:
        raise AuthError(401, "auth", "bad_token", route=route)
    await auth.require_owner(ctx, request)
    handoff = None
    if storable(handoff_id):                          # text Postgres can't hold names no handoff
        handoff = (await ctx.db.scalars(ctx.repo.scoped(select(Handoff).where(Handoff.handoff_id == handoff_id)
                                                        .with_for_update()))).one_or_none()
    if handoff is None:
        raise AuthError(404, "not_found", "unknown_handoff", route=route)
    if handoff.status != "open":
        raise KernelFailure(409, "conflict", "handoff_done")
    handoff.status = "done"
    fact = (await ctx.db.scalars(ctx.repo.scoped(select(Fact).where(
        Fact.desk_id == handoff.desk_id, Fact.fact_id == f"handoff:{handoff.handoff_id}")
        .with_for_update()))).one_or_none()
    if fact is not None:
        fact.status = "expired"
    await ledger.append(ctx, copy_id=handoff.copy_id, desk_id=handoff.desk_id, event=LedgerEvent(
        kind="desk_data", origin="kernel", summary={"part": "handoffs", "refs": [handoff.handoff_id]}))
    return DeskUpdated(desk_id=handoff.desk_id, updated_at=ctx.clock.now())


owner_router = APIRouter()


@owner_router.post("/owner/messages", response_model=OwnerMessageResult)
async def post_owner_message(body: OwnerMessageRequest, ctx: Ctx, request: Request) -> OwnerMessageResult:
    """The owner says something in a conversation, or whispers to Claude in it
    (`reply_check.owner_message`), with the owner's credential alone (a session token beside it is
    401). The session must be a visitor's or an agent's of the owner's copy (another copy's is 404,
    the owner's own session 422 `invalid`), open and on a Desk not deleted (409 `closed`), in any
    mode, a take-over and a pause included; each refusal of the session is ledgered on its Desk.
    Its row is held `FOR SHARE` until the answer commits, so a take-over running alongside is seen
    whole and the verdict carries the generation the conversation is at."""
    route = route_template(request)
    if auth.SESSION_HEADER in request.headers:
        raise AuthError(401, "auth", "bad_token", route=route, named=await auth.named_session(ctx, body.session_id))
    owner = await auth.require_owner(ctx, request, session_id=body.session_id)
    row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
        SessionRow.session_id == body.session_id).with_for_update(read=True)
        .execution_options(populate_existing=True)))).one()
    if row.kind == "owner":
        raise KernelFailure(422, "invalid", "owner_session")
    auth.require_open(ctx, request, row)
    await auth.require_desk(ctx, request, row, row.desk_id)
    return await reply_check.owner_message(ctx, owner, row, body)


ledger_router = APIRouter()


def _as_reported(body: Any) -> Any:
    """Whatever origin the API's event claims, the kernel records it as `api`: reported, not verified."""
    if isinstance(body, dict) and isinstance(body.get("event"), dict):
        return {**body, "event": {**body["event"], "origin": "api"}}
    return body


ApiEntry = Annotated[LedgerAppendRequest, BeforeValidator(_as_reported)]


@ledger_router.post("/ledger/append", response_model=LedgerEntry)
async def append_api_entry(body: ApiEntry, ctx: Ctx, request: Request) -> LedgerEntry:
    """The API's own `session`, `rate_limit` and `agent_auth` entries (the request model refuses any
    other kind). A visitor's token may write only to its session's Desk, the owner's only to a Desk
    of the copy, and an entry that names a session must name the one whose token sent it."""
    route = route_template(request)
    if auth.OWNER_HEADER in request.headers and auth.SESSION_HEADER not in request.headers:
        owner = await auth.require_owner(ctx, request, desk_id=body.desk_id)
        copy_id, session_id = owner.copy_id, owner.session_id
    elif auth.SESSION_HEADER in request.headers and auth.OWNER_HEADER not in request.headers:
        row = await auth.require_session_token(ctx, request)
        copy_id, session_id = row.copy_id, row.session_id
        if body.desk_id != row.desk_id:
            raise AuthError(404, "not_found", "wrong_copy", route=route,
                            named=Named(copy_id=copy_id, desk_id=row.desk_id, session_id=session_id))
    else:
        raise AuthError(401, "auth", "bad_token", route=route)
    if body.event.session_id not in (None, session_id):
        raise AuthError(404, "not_found", "wrong_session", route=route,
                        named=Named(copy_id=copy_id, desk_id=body.desk_id, session_id=session_id))
    try:
        ledger.check_reported(body.event)
    except ledger.UnsafeSummary:
        raise KernelFailure(422, "invalid", "unsafe_api_entry") from None
    return await ledger.append(ctx, copy_id=copy_id, desk_id=body.desk_id, event=body.event)


@ledger_router.get("/ledger/{desk_id}", response_model=LedgerPage)
async def read_ledger(desk_id: str, ctx: Ctx, request: Request) -> LedgerPage:
    """The owner's view of a Desk's safety ledger. It always verifies the chain, whatever the
    `verify` flag of the documented route (`?verify=true`) says."""
    await auth.require_owner(ctx, request, desk_id=desk_id)
    return await ledger.page(ctx, desk_id)


policy_router = APIRouter()


@policy_router.post("/policy/draft", response_model=PolicyVersion)
async def post_policy_draft(body: PolicyDraftRequest, ctx: Ctx, request: Request) -> PolicyVersion:
    """The owner's cards as a draft version at a money cap (absent: the active version's), proved
    (or, in `bounded` mode, checked) before it answers; idempotent, so a re-post waits for the
    running proof and gets the same version. Nothing changes until the owner confirms it."""
    owner = await auth.require_owner(ctx, request, desk_id=body.desk_id)
    await _open_desk(ctx, request, body.desk_id)
    return await activation.draft(ctx, owner, body.desk_id, body.cards, body.expected_parent,
                                  body.auto_money_cap_cents)


@policy_router.post("/policy/confirm", response_model=PolicyVersion)
async def post_policy_confirm(body: PolicyConfirmRequest, ctx: Ctx, request: Request) -> PolicyVersion:
    """Activates a proved draft while its parent is still active and what it was proved against
    is current; 409 `conflict` otherwise, ledgered with the reason."""
    await auth.require_owner(ctx, request, desk_id=body.desk_id)
    await _open_desk(ctx, request, body.desk_id)
    return await activation.confirm(ctx, body.desk_id, body.version)


async def _open_desk(ctx: KernelCtx, request: Request, desk_id: str) -> None:
    """A deleted Desk's rules don't change (409 `closed`, ledgered on it)."""
    deleted_at = (await ctx.db.execute(ctx.repo.scoped(select(Desk.deleted_at).where(
        Desk.desk_id == desk_id)))).scalar_one()
    if deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route_template(request),
                        named=Named(copy_id=ctx.copy_id, desk_id=desk_id))


def error_response(status: int, code: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(KernelError(code=code).model_dump(), status_code=status, headers=headers)


async def _kernel_failure(request: Request, exc: KernelFailure) -> JSONResponse:
    if exc.persist is not None:
        try:
            async with kernel_transaction(request.app.state.kernel) as ctx:
                await exc.persist(ctx)
        except Exception as failure:
            log_error(log, failure, "kernel_failure_unrecorded route=%s code=%s reason=%s", route_template(request),
                      exc.code, exc.reason)
            return error_response(500, "internal")
    if isinstance(exc, AuthError) and exc.named is None:
        # a request naming no existing session or Desk has no ledger to go on
        log.warning("auth_unattributed route=%s reason=%s", route_template(request), exc.reason)
    else:
        log.info("kernel_failure route=%s status=%d code=%s reason=%s", route_template(request), exc.status,
                 exc.code, exc.reason)
    return error_response(exc.status, exc.code)


async def _invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    return error_response(422, "invalid")


STATUS_CODES = {401: "auth", 404: "not_found", 409: "conflict", 429: "rate_limited"}


async def _framework_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    status = exc.status_code
    code = "internal" if status >= 500 else STATUS_CODES.get(status, "invalid")
    return error_response(status, code, headers=exc.headers)


class InternalErrors:
    """Answers an unhandled exception with 500 `internal` (the request's transaction has already
    rolled back) and logs it. It sits inside Starlette's error middleware, which would answer
    with its own body and raise the exception again."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_tracking(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_tracking)
        except Exception as exc:
            route = scope.get("route")
            path = getattr(route, "path", "<unmatched>")
            log_error(log, exc, "internal_error route=%s %s", scope.get("method"), path)
            if started:
                raise
            await error_response(500, "internal")(scope, receive, send)


HOST = "127.0.0.1"   # loopback only: no setting changes it
PORT = 8701


def serve_config() -> uvicorn.Config:
    """How `python -m desk.kernel_service` serves the app. The app is built when the server starts,
    and a lifespan that fails (a production kernel without its signing seed) stops the process.
    There is no access log: a raw path can hold a single-use link token, so the kernel logs its
    refusals and errors itself, by route template."""
    return uvicorn.Config("desk.kernel_service.app:create_app", factory=True, host=HOST, port=PORT,
                          lifespan="on", proxy_headers=False, server_header=False, access_log=False)
