"""The kernel's FastAPI app, its settings and how it is served.

The kernel binds 127.0.0.1:8701 and nothing changes that: the API process in the same task is
its only client. The lifespan first refuses the test hooks outside development (a fake model
server, a stand-in prover, an offline reviewer, a frozen clock), then builds the reviewer
(`app.state.kernel.decisions`) and the signer, so a production kernel without
`DESK_SIGNING_SEED` refuses to start, then the policy engine over the always-on baseline
(`app.state.engine`; a baseline it can't take stops the start too) with the shipped proof reports
in its cache, then runs `desk-prove --selftest` once to pick the proof mode for the whole process
(`symcc` or `bounded`, which `/health` reports), then the database engine (role desk_kernel).

Every non-2xx answer is a `KernelError{code}` ("Session state responses"): a `KernelFailure`
answers its own code, request validation 422 `invalid`, the framework's own errors (an unknown
route, a wrong method) the code for their status, and anything unhandled 500 `internal`, after
the request's transaction has rolled back.
"""

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Annotated, Any

import desk_kernel
import uvicorn
from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BeforeValidator
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from desk.contracts import LedgerEntry, LedgerPage, PolicyVersion
from desk.db.session import KernelSession, database_url
from desk.env import is_development
from desk.kernel_api import Health, KernelError, LedgerAppendRequest, PolicyConfirmRequest, PolicyDraftRequest
from desk.kernel_service import activation, auth, copies, decide, ledger, sessions
from desk.kernel_service.auth import AuthError, Named
from desk.kernel_service.clock import Clock, SystemClock
from desk.kernel_service.decisions import DecisionsBackend, make_decisions
from desk.kernel_service.repo import Ctx, KernelFailure, KernelRuntime, kernel_transaction, route_template

log = logging.getLogger("desk.kernel_service")


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
        engine = create_async_engine(settings.database_url, pool_pre_ping=True)
        factory = async_sessionmaker(engine, expire_on_commit=False, sync_session_class=KernelSession)
        app.state.kernel = KernelRuntime(settings=settings, clock=clock, signer=signer, engine=engine,
                                         sessions=factory, policies=policies, decisions=reviewer)
        try:
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
    app.include_router(ledger_router)
    app.include_router(policy_router)

    @app.get("/health", response_model=Health)
    async def health(request: Request) -> Health:
        signer = request.app.state.kernel.signer
        return Health(version=desk_kernel.version(), proof_mode=request.app.state.proof_mode,
                      dev_signing_key=signer.dev_key, public_key_hex=signer.public_key_hex(),
                      key_id=signer.key_id(), unproved_seeds=sorted(request.app.state.unproved_seeds))

    return app


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
    """The owner's cards as a draft version, proved (or, in `bounded` mode, checked) before it
    answers; idempotent, so a re-post waits for the running proof and gets the same version."""
    owner = await auth.require_owner(ctx, request, desk_id=body.desk_id)
    return await activation.draft(ctx, owner, body.desk_id, body.cards, body.expected_parent)


@policy_router.post("/policy/confirm", response_model=PolicyVersion)
async def post_policy_confirm(body: PolicyConfirmRequest, ctx: Ctx, request: Request) -> PolicyVersion:
    """Activates a proved draft while its parent is still active and what it was proved against
    is current; 409 `conflict` otherwise, ledgered with the reason."""
    await auth.require_owner(ctx, request, desk_id=body.desk_id)
    return await activation.confirm(ctx, body.desk_id, body.version)


def error_response(status: int, code: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(KernelError(code=code).model_dump(), status_code=status, headers=headers)


async def _kernel_failure(request: Request, exc: KernelFailure) -> JSONResponse:
    if exc.persist is not None:
        try:
            async with kernel_transaction(request.app.state.kernel) as ctx:
                await exc.persist(ctx)
        except Exception:
            log.exception("kernel_failure_unrecorded route=%s code=%s reason=%s", route_template(request), exc.code,
                          exc.reason)
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
        except Exception:
            route = scope.get("route")
            log.exception("internal_error route=%s %s", scope.get("method"), getattr(route, "path", "<unmatched>"))
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
