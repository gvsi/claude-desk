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
(`symcc` or `bounded`, which `/health` reports), then the database engine (role desk_kernel), then,
when it runs the mock payments server as its child (`python -m desk.kernel_service`, or
`MOCKPAY_SPAWN=1`), starts it and waits for it, then gives every Desk the native tools it was
created without and rebuilds the active rules versions an earlier kernel stored under another
baseline, within a budget that finding them counts against too, and from cached reports only
(`activation.rebuild_at_startup`), then starts the rebuild of the copies and Desks startup left,
which runs in the background while the kernel serves (`activation.rebuild_in_background`,
`app.state.rebuilding`) and is cancelled at shutdown, and last reconciles the executions and the
payment links a stopped kernel left behind (`execute.reconcile_at_startup`,
`payments.reconcile_links_at_startup`), each within `STARTUP_RECONCILE_S`, since a read settles
them too, and last starts the pass that keeps setup-made Desks' calendars open from their hours,
now and then daily, beside the kernel (`desks.keep_calendars_open`, `app.state.calendar_refresh`),
which is cancelled at shutdown too.

Every non-2xx answer is a `KernelError{code}` ("Session state responses"): a `KernelFailure`
answers its own code, request validation 422 `invalid`, the framework's own errors (an unknown
route, a wrong method) the code for their status, and anything unhandled 500 `internal`, after
the request's transaction has rolled back.
"""

import asyncio
import logging
import os
import pathlib
import re
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Annotated, Any
from urllib.parse import urlsplit

import desk_kernel
import httpx2
import uvicorn
from fastapi import APIRouter, FastAPI, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, BeforeValidator
from pydantic_core import PydanticSerializationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import desk
from desk.contracts import (DemoInboxEntry, KnowledgeItem, LedgerEntry, LedgerEvent, LedgerPage, OwnerMessageResult,
                            PolicyVersion, Probe, ProbeResult, ToolProfile)
from desk.db import logs as db_logs
from desk.db.models import Desk, Fact, Handoff
from desk.db.session import KernelSession, database_url
from desk.env import is_development
from desk.kernel_api import (CreateDeskRequest, DeskCreated, DeskUpdated, DocumentCreated, DocumentUploadRequest,
                             Health, KernelError, KnowledgeRequest, LedgerAppendRequest, LinkCancelled,
                             OwnerMessageRequest, PaymentLinkActionRequest, PaymentLinkStateResult, PaymentLinkView,
                             PolicyConfirmRequest, PolicyDraftRequest, PolicyProbeRequest, ToolConfirmed,
                             ToolsConfirmRequest, ToolsConnectRequest, ToolsSimulateChangeRequest)
from desk.kernel_service import (activation, agents, approvals, auth, business_tools, context, copies, decide, demo_inbox, desks,
                                 execute, labels, ledger, mcp_pins, payments, public, reply_check, sessions, turn,
                                 verification)
from desk.kernel_service.adapters import release_document
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.clock import Clock, SystemClock
from desk.kernel_service.decisions import DecisionsBackend, make_decisions
from desk.kernel_service.repo import (Ctx, KernelCtx, KernelFailure, KernelRuntime, kernel_transaction, log_error,
                                      route_template, storable)
from desk.kernel_service.settings import MOCKPAY_URL, KernelSettings
from desk.mockpay.definitions import EXIT_BIND_FAILED, is_placeholder_key

log = logging.getLogger("desk.kernel_service")
STARTUP_RECONCILE_S = 10.0         # startup's limit on settling the executions a stopped kernel left

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


MOCKPAY_KEY_MIN_LENGTH = 32     # the mock payments server refuses a shorter key
MOCKPAY_START_TIMEOUT_S = 10.0  # how long the kernel's start waits for the server to answer
MOCKPAY_BACKOFF_S = (1.0, 30.0)  # a restart waits 1 s, doubling to 30 s while it keeps exiting
BACKEND_ROOT = pathlib.Path(desk.__file__).resolve().parents[1]   # the child's cwd, so `desk` imports from it


class MockpayChild:
    """The mock payments server as the kernel's child process (master plan, "Payments (mocked)").

    It runs `python -m desk.mockpay.server` on MOCKPAY_URL's loopback port, in a session of its
    own with only the four variables it needs, restarts it whenever it exits (`mockpay_restarted`,
    or `mockpay_bind_failed` when something else holds the port) and stops it with the kernel.
    While it is down, every payments call fails closed: nothing else answers there with the
    kernel's key."""

    def __init__(self, url: str, key: str, database_url: str, env: str):
        parts = urlsplit(url)
        self.url = url
        self.port = parts.port
        self._key = key
        self.argv = [sys.executable, "-m", "desk.mockpay.server", "--host", parts.hostname, "--port", str(parts.port)]
        self._env = {"PATH": os.environ.get("PATH", os.defpath), "MOCKPAY_DATABASE_URL": database_url,
                     "MOCKPAY_KEY": key, "DESK_ENV": env}
        self.process: asyncio.subprocess.Process | None = None
        self._stopping = asyncio.Event()
        self._supervisor: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the child and wait up to 10 s for it to answer; a child that doesn't still leaves the
        kernel starting, and payments fail closed until it does."""
        self._supervisor = asyncio.create_task(self._supervise(), name="mockpay-supervisor")
        if not await self._answers_within(MOCKPAY_START_TIMEOUT_S):
            log.warning("mockpay_unhealthy url=%s", self.url)

    async def _answers_within(self, seconds: float) -> bool:
        deadline = asyncio.get_running_loop().time() + seconds
        async with httpx2.AsyncClient(headers={"X-Mockpay-Key": self._key}, trust_env=False, timeout=1.0) as http:
            while asyncio.get_running_loop().time() < deadline:
                try:
                    if (await http.get(f"{self.url}/provider/health")).json() == {"ok": True}:
                        return True
                except (httpx2.HTTPError, ValueError):
                    pass
                await asyncio.sleep(0.1)
        return False

    async def _supervise(self) -> None:
        loop = asyncio.get_running_loop()
        backoff = MOCKPAY_BACKOFF_S[0]
        while not self._stopping.is_set():
            started = loop.time()
            try:
                # a session of its own: a Ctrl-C at the kernel's terminal reaches the kernel alone, whose
                # shutdown stops the child (the child seeing it too read as a crash, restarted mid-shutdown)
                self.process = await asyncio.create_subprocess_exec(
                    *self.argv, cwd=BACKEND_ROOT, env=self._env, stdin=asyncio.subprocess.DEVNULL,
                    start_new_session=True)
            except Exception as exc:
                log_error(log, exc, "mockpay_spawn_failed")
            else:
                if self._stopping.is_set():   # stopped while it was starting
                    await self._terminate(self.process)
                    return
                code = await self.process.wait()
                if self._stopping.is_set():
                    return
                if loop.time() - started >= MOCKPAY_BACKOFF_S[1]:   # it ran a while: start the backoff over
                    backoff = MOCKPAY_BACKOFF_S[0]
                if code == EXIT_BIND_FAILED:   # its port is taken, most likely by an earlier server still running
                    log.warning("mockpay_bind_failed port=%s wait_s=%.0f", self.port, backoff)
                else:
                    log.warning("mockpay_restarted exit=%s wait_s=%.0f", code, backoff)
            try:
                await asyncio.wait_for(self._stopping.wait(), backoff)
            except TimeoutError:
                backoff = min(backoff * 2, MOCKPAY_BACKOFF_S[1])

    @staticmethod
    async def _terminate(process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()

    async def stop(self) -> None:
        """Stop the child and its supervisor; never raises, so the kernel's shutdown carries on."""
        self._stopping.set()
        try:
            if self.process is not None:
                await self._terminate(self.process)
            if self._supervisor is not None:
                await self._supervisor
        except Exception as exc:
            log_error(log, exc, "mockpay_stop_failed")


def mockpay_child(settings: KernelSettings) -> MockpayChild | None:
    """The child to start, when the kernel runs the mock payments server (`mockpay_spawn`). Without a
    key of at least 32 characters (outside development, one that isn't a change-me placeholder such
    as `.env.example`'s), a database URL for it or a loopback URL with a port, there is no child and
    payments fail closed; outside development (the settings' DESK_ENV or the process's) the kernel
    refuses to start instead."""
    if not settings.mockpay_spawn:
        return None
    # the child runs in whichever of the two environments isn't development, never a laxer one
    process_env = os.environ.get("DESK_ENV", "")
    env = process_env if is_development(settings.env) and not is_development(process_env) else settings.env
    problem, store_url = None, ""
    parts = urlsplit(settings.mockpay_url)
    try:
        port = parts.port
    except ValueError:
        port = None
    if len(settings.mockpay_key) < MOCKPAY_KEY_MIN_LENGTH:
        problem = f"MOCKPAY_KEY is missing or shorter than {MOCKPAY_KEY_MIN_LENGTH} characters"
    elif not is_development(env) and is_placeholder_key(settings.mockpay_key):
        problem = "MOCKPAY_KEY is a placeholder; outside development make a key of your own (openssl rand -hex 32)"
    elif parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost") or port is None:
        problem = "MOCKPAY_URL must be http://127.0.0.1:<port>"
    else:
        try:
            store_url = database_url("MOCKPAY")
        except RuntimeError as missing:
            problem = str(missing)
    if problem is None:
        return MockpayChild(settings.mockpay_url, settings.mockpay_key, store_url, env)
    if not is_development(env):
        raise RuntimeError(f"the mock payments server can't start: {problem}")
    log.warning("mockpay_not_started reason=%s", problem)
    return None


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
        mockpay = mockpay_child(settings)   # production refuses to start without its key
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
        rebuilding: asyncio.Task | None = None
        refreshing: asyncio.Task | None = None
        app.state.mockpay = mockpay
        try:
            if mockpay is not None:
                await mockpay.start()
            startup: activation.StartupRebuild | None = None
            try:
                # active versions an earlier kernel stored under another baseline, rebuilt and
                # proved before anything is decided under them; one that isn't decides nothing
                startup = await activation.rebuild_at_startup(app.state.kernel)
            except Exception as exc:
                # whatever went wrong, the background lists the copies and brings them up itself
                log_error(log, exc, "startup_rebuild_failed")
                startup = activation.StartupRebuild(results={}, left=[], unscanned=None)
            if startup is not None and startup.pending:
                # the Desks and copies startup left, while the kernel serves; each Desk refuses
                # until it is rebuilt. Started first, so nothing after it can keep it from starting
                rebuilding = asyncio.create_task(activation.rebuild_in_background(app.state.kernel, startup))
            app.state.rebuilding = rebuilding
            # executions and payment links a stopped kernel left behind; a read settles them too, so a
            # failure or a run past STARTUP_RECONCILE_S is logged and the kernel starts. Each has its own
            # limit, so one that hangs can't keep the other from running
            for name, reconcile in (("startup_reconcile", execute.reconcile_at_startup),
                                    ("startup_link_reconcile", payments.reconcile_links_at_startup)):
                try:
                    await asyncio.wait_for(reconcile(app.state.kernel), STARTUP_RECONCILE_S)
                except TimeoutError:
                    log.info("%s_cut_off", name)
                except Exception as exc:
                    log_error(log, exc, "%s_failed", name)
            # setup-made Desks' calendars kept open from their hours: a pass now, then one a day, beside
            # the kernel, which doesn't wait for it
            refreshing = asyncio.create_task(desks.keep_calendars_open(app.state.kernel), name="calendar-refresh")
            app.state.calendar_refresh = refreshing
            yield
        finally:
            for task in (rebuilding, refreshing):
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            if mockpay is not None:
                await mockpay.stop()
            await engine.dispose()

    app = FastAPI(title="Claude Desk kernel", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.proof_mode = "bounded"   # until the startup selftest passes
    app.state.rebuilding = None        # the background rebuild of what startup left, if anything
    app.state.calendar_refresh = None  # the daily pass that keeps setup-made Desks' calendars open
    app.state.mockpay = None           # the mock payments child, while the kernel runs one
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
    app.include_router(turn.router)
    app.include_router(reply_check.router)
    app.include_router(public.router)
    app.include_router(verification.router)
    app.include_router(agents.router)
    app.include_router(desk_router)
    app.include_router(business_tools.router)
    app.include_router(document_link_router)
    app.include_router(payment_link_router)
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
    await activation.activate_shipped(ctx, created.desk_id, desks.NEW_DESK_PRESET, 0)
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


payment_link_router = APIRouter()


@payment_link_router.get("/payment_links/{token}", response_model=PaymentLinkView)
async def get_payment_link(token: str, ctx: Ctx, response: Response) -> PaymentLinkView:
    """What the mock checkout page shows of a payment link, by its token alone
    (`payments.link_view`); 404 `not_found` for a token no link has. The API proxies it."""
    response.headers["Cache-Control"] = "no-store"
    return await payments.link_view(ctx, token)


@payment_link_router.post("/payment_links/{token}/complete", response_model=PaymentLinkStateResult)
async def complete_payment_link(token: str, body: PaymentLinkActionRequest, ctx: Ctx,
                                response: Response) -> PaymentLinkStateResult:
    """The mock checkout's pay button, by the link's token alone (`payments.complete_link`): the link
    pays once, with a signed `payment_confirmed` verdict for its session; 409 `conflict` for a link
    in no state to pay, 404 `not_found` for a token no link has. The API proxies it."""
    response.headers["Cache-Control"] = "no-store"
    return await payments.complete_link(ctx, token)


@payment_link_router.post("/payment_links/{token}/cancel", response_model=PaymentLinkStateResult)
async def cancel_payment_link(token: str, body: PaymentLinkActionRequest, ctx: Ctx,
                              response: Response) -> PaymentLinkStateResult:
    """The mock checkout's cancel button, by the link's token alone (`payments.cancel_link`); 409
    `conflict` for a link in no state to cancel. The API proxies it."""
    response.headers["Cache-Control"] = "no-store"
    return await payments.cancel_link(ctx, token)


inbox_router = APIRouter()


@inbox_router.get("/demo_inbox", response_model=list[DemoInboxEntry])
async def read_demo_inbox(ctx: Ctx, request: Request, session_id: str | None = None) -> list[DemoInboxEntry]:
    """The Demo inbox: with `session_id` (`X-Session-Token`, or an agent session's signature), the
    verification codes of the challenges the session, or a demo agent it minted, started, never
    another session's code for the same person, and nothing else; without it, every entry of the
    owner's copy (`X-Owner-Session`)."""
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
    hides those), is 404 `not_found`, logged, since there is no Desk of the copy to ledger it on.
    One on a deleted Desk, open or done, is 409 `closed`, ledgered on that Desk, as on the Desk's
    other routes: a deletion leaves its handoffs as they were.

    It is an owner's write to the Desk's data, so it holds the Desk row first (`desks.held_desk`,
    read afresh, which a deletion holds too), then the handoff, its fact and the ledger head."""
    route = route_template(request)
    owner = await desks.owner_alone(ctx, request)
    desk_id = None
    if storable(handoff_id):                          # text Postgres can't hold names no handoff
        desk_id = (await ctx.db.execute(ctx.repo.scoped(select(Handoff.desk_id).where(
            Handoff.handoff_id == handoff_id)))).scalar_one_or_none()
    if desk_id is None:
        raise AuthError(404, "not_found", "unknown_handoff", route=route)
    await desks.held_desk(ctx, request, owner, desk_id)
    handoff = (await ctx.db.scalars(ctx.repo.scoped(select(Handoff).where(Handoff.handoff_id == handoff_id)
                                                    .with_for_update()))).one()
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
    of the copy, and an entry that names a session must name the one whose token sent it. An agent
    session has no token: its entries name it and carry the agent's signature for its turn."""
    route = route_template(request)
    signed = auth.agent_signed(request)
    if signed and auth.SESSION_HEADER not in request.headers and auth.OWNER_HEADER not in request.headers:
        if body.event.session_id is None:
            raise AuthError(401, "auth", "bad_token", route=route)
        row = await auth.require_session(ctx, request, body.event.session_id)
        copy_id, session_id = row.copy_id, row.session_id
        if body.desk_id != row.desk_id:
            raise AuthError(404, "not_found", "wrong_copy", route=route,
                            named=Named(copy_id=copy_id, desk_id=row.desk_id, session_id=session_id))
    elif signed:
        raise AuthError(401, "auth", "bad_token", route=route)
    elif auth.OWNER_HEADER in request.headers and auth.SESSION_HEADER not in request.headers:
        owner = await auth.require_owner(ctx, request, desk_id=body.desk_id)
        copy_id, session_id = owner.copy_id, owner.session_id
    elif auth.SESSION_HEADER in request.headers and auth.OWNER_HEADER not in request.headers:
        # the API's record of something that already happened, answered as stored: a session that
        # closes once its token is proved still gets it, and its next read answers the close
        row = await auth.require_session_token(ctx, request, watch=False)
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


@policy_router.post("/tools/connect", response_model=list[ToolProfile])
async def post_tools_connect(body: ToolsConnectRequest, ctx: Ctx, request: Request) -> list[ToolProfile]:
    """Connects an MCP server to a Desk of the owner's copy (`mcp_pins.connect`): each tool it lists
    is pinned at its listing hash and waits for the owner's review; a tool already on the Desk is
    left as it is. An unreachable server is 503 `internal`."""
    await auth.require_owner(ctx, request, desk_id=body.desk_id)
    await _open_desk(ctx, request, body.desk_id)
    return [mcp_pins.owner_profile(row) for row in await mcp_pins.connect(ctx, body.desk_id, body.server)]


@policy_router.post("/tools/confirm", response_model=ToolConfirmed)
async def post_tools_confirm(body: ToolsConfirmRequest, ctx: Ctx, request: Request) -> ToolConfirmed:
    """The owner's batch confirm of a Desk's tools, each named by the hash they reviewed
    (`mcp_pins.confirm_tools`): enabling drafts one rules version to prove and confirm; disabling
    takes effect at once. Any entry that fails its check fails the whole batch, ledgered."""
    owner = await auth.require_owner(ctx, request, desk_id=body.desk_id)
    await _open_desk(ctx, request, body.desk_id)
    return await mcp_pins.confirm_tools(ctx, owner, body.desk_id, body.tools, body.enable)


@policy_router.post("/tools/simulate_change", response_model=ToolProfile)
async def post_tools_simulate_change(body: ToolsSimulateChangeRequest, ctx: Ctx, request: Request) -> ToolProfile:
    """The demo's "Simulate a tool change" (`mcp_pins.simulate_change`): the server changes the
    copy's definition of a connected tool and the kernel re-lists at once, so the tool needs review."""
    await auth.require_owner(ctx, request, desk_id=body.desk_id)
    await _open_desk(ctx, request, body.desk_id)
    return mcp_pins.owner_profile(await mcp_pins.simulate_change(ctx, body.desk_id, body.tool))


@policy_router.get("/policy/{version}/cancelled_links", response_model=list[LinkCancelled])
async def get_cancelled_links(version: int, desk_id: str, ctx: Ctx, request: Request) -> list[LinkCancelled]:
    """The payment links a version's activation cancelled for a rule change, each with its signed
    `link_cancelled` line for the chat (`payments.cancelled_links`), with the owner's credential
    alone (a session token beside it is 401) for a Desk of its copy (another copy's is 404)."""
    route = route_template(request)
    if auth.SESSION_HEADER in request.headers:
        raise AuthError(401, "auth", "bad_token", route=route)
    if not desks.storable(desk_id):                       # text Postgres can't hold names no Desk
        await auth.require_owner(ctx, request)
        raise AuthError(404, "not_found", "wrong_copy", route=route)
    await auth.require_owner(ctx, request, desk_id=desk_id)
    return await payments.cancelled_links(ctx, desk_id, version)


@policy_router.post("/policy/{version}/probe", response_model=list[ProbeResult])
async def post_policy_probe(version: int, body: PolicyProbeRequest, ctx: Ctx, request: Request) -> list[ProbeResult]:
    """Setup safety probes: what version `version` of a Desk's rules, in any status, would decide
    for each hypothetical caller, with nothing resolved, executed or activated
    (`activation.probe_version`). The owner of the Desk's copy only; a Desk the copy doesn't have
    is 404, a deleted one 409 `closed`. Every probe gets a result; only a malformed body is 422
    `invalid`: more than `MAX_PROBES` probes, or text the answer couldn't carry back."""
    await auth.require_owner(ctx, request, desk_id=body.desk_id)
    await _open_desk(ctx, request, body.desk_id)
    if len(body.probes) > activation.MAX_PROBES or not _answerable(body.probes):
        raise KernelFailure(422, "invalid", "malformed_probes")
    return await activation.probe_version(ctx, body.desk_id, version, body.probes)


def _answerable(probes: list[Probe]) -> bool:
    """Every probe can go back in the answer as JSON (`ProbeResult.probe`): no text a JSON answer
    can't carry, such as a lone surrogate the request escaped."""
    try:
        for probe in probes:
            probe.model_dump_json()
    except PydanticSerializationError:
        return False
    return True


async def _open_desk(ctx: KernelCtx, request: Request, desk_id: str) -> None:
    """A deleted Desk's rules don't change (409 `closed`, ledgered on it)."""
    deleted_at = (await ctx.db.execute(ctx.repo.scoped(select(Desk.deleted_at).where(
        Desk.desk_id == desk_id)))).scalar_one()
    if deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route_template(request),
                        named=Named(copy_id=ctx.copy_id, desk_id=desk_id))


def error_response(status: int, code: str, headers: dict[str, str] | None = None, *,
                   detail: dict[str, list[str]] | None = None) -> JSONResponse:
    return JSONResponse(KernelError(code=code, detail=detail).model_dump(exclude_none=True),
                        status_code=status, headers=headers)


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
    return error_response(exc.status, exc.code, detail=exc.detail)


async def _invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    if route_template(request) == "PUT /desks/{id}/business_tools":
        try:
            async with kernel_transaction(request.app.state.kernel) as ctx:
                await business_tools.refuse_invalid_request(ctx, request)
        except KernelFailure as failure:
            return await _kernel_failure(request, failure)
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
    log_config = deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["disable_existing_loggers"] = False
    log_config["formatters"]["desk"] = {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}
    log_config["handlers"]["desk"] = {
        "class": "logging.StreamHandler", "formatter": "desk", "stream": "ext://sys.stdout"}
    # caplog listens at root; production has no root handler, so propagation prints no duplicate.
    log_config["loggers"]["desk"] = {"handlers": ["desk"], "level": "INFO", "propagate": True}
    return uvicorn.Config("desk.kernel_service.app:create_app", factory=True, host=HOST, port=PORT,
                          lifespan="on", proxy_headers=False, server_header=False, access_log=False,
                          log_config=log_config)
