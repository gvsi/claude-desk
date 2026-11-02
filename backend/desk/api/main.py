"""The API process (port 8700): `create_app` builds it, `app_factory` is uvicorn's entry point.

    uvicorn --factory desk.api.main:app_factory --host 0.0.0.0 --port 8700 --timeout-keep-alive 310

`create_app` builds the model client through `make_model` (the Claude API, or Amazon Bedrock for local evals)
before the app, so a provider without its credential, or `ANTHROPIC_CUSTOM_HEADERS` set, refuses to start. The
lifespan opens the kernel client, checks it is the production one when it must be, then opens the database engine,
the turn locks' pool, the run events listener, the turn runner, the built-in agent's client of the public A2A
endpoint and its runs (`agents.py`), the demo visitors' runs (`demo_visitors.py`), and the job queue with its two
workers (`jobs.py`), and closes them in the reverse order: the workers' jobs, setup's consent runs, the owner's rule
drafting and proving work (`proving.py`), the demo visitors' and the agent's runs and the runner's turns first, with
the model client it built (never an injected one) last. Building the app sets the job queue's loggers
(`procrastinate` and its children) to WARNING and filters them (`JobRecords`): Procrastinate names
each job with its arguments below WARNING and when a job fails, and the resume job's signed decision quotes the
visitor. It also redacts link tokens from every log record the process makes (`log_redaction`), uvicorn's access log
included. In production the app refuses to start without its secrets (the API key, the passcode hash and the public
origin, which `Settings` requires), with a Bedrock setting or credential (refused by `Settings`) and with any test
hook: `ANTHROPIC_BASE_URL` (refused by `Settings`), an injected clock, model, kernel transport or job queue connector,
or an A2A transport set on the runtime (refused when the lifespan starts). A passcode hash that isn't one refuses to
start anywhere.

Every error answer is an `ApiError` ("Errors"): a kernel refusal keeps its status with `{error: "kernel",
code}`, an unreachable kernel is 503 `{error: "kernel", code}` (`seed_unproved`, `internal`, else
`kernel_unavailable`), a limit is 429 `{error: "rate_limited", retry_after}`, and a body that doesn't fit is
422 `{error: "invalid"}`, never echoing what was sent. Two paths answer otherwise. A document link (`/api/d/…`) opens
in a browser tab no screen covers: its refusals keep their status but read as static copy unless JSON is asked for
(`proxy.document_refusal`). The A2A endpoint (`/api/a2a/…`) answers an agent, and every answer it gives says it comes
from an AI: its errors are `{code, disclosure: "ai"}` (`a2a.error_response`), whatever raised them. A visitor route
whose cookie names no open session on its Desk answers 401 `{error: "no_session"}` and clears that cookie.
"""

import asyncio
import contextlib
import functools
import logging
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starlette.exceptions import HTTPException as StarletteHTTPException

from desk.api import a2a, log_redaction
from desk.api.agents import DemoAgents, a2a_client
from desk.api.cookies import clear_visitor_cookie
from desk.api.demo_visitors import DemoVisitors, visitor_client
from desk.api.deps import ApiProblem, Runtime, runtime
from desk.api.jobs import WORKERS, JobEnv, jobs_app, run_worker
from desk.api.kernel_client import KernelFailed, KernelHttp, KernelUnavailable, assert_production_safe
from desk.api.loop import TURN_LOCK_POOL_SIZE
from desk.api.model import make_model
from desk.api.passcode import check_passcode_hash
from desk.api.ratelimit import RateLimited, RateLimiter, StreamSlots
from desk.api.routes import agents, owner, proxy, public, rules, setup
from desk.api.runner import TurnRunner
from desk.api.schemas import ApiError, DemoVisitorRun, HealthOut, operation_ids
from desk.api.settings import Settings
from desk.api.sse import Listener
from desk.api.store import Ids, append_message
from desk.db.session import API_CONNECT_OPTIONS, procrastinate_connector

logger = logging.getLogger(__name__)

# The API's pool ("Connections and state"): 20 connections, 10 more under load, 5 s to get one.
POOL_SIZE, MAX_OVERFLOW, POOL_TIMEOUT_S = 20, 10, 5
KERNEL_CODES = frozenset({"seed_unproved", "internal"})
JOB_QUEUE_LOGGER = "procrastinate"
# The workers' loggers, which don't exist until they start: their module's, where a failed job is logged, and each
# worker's own.
JOB_WORKER_LOGGERS = (f"{JOB_QUEUE_LOGGER}.worker", *(f"{JOB_QUEUE_LOGGER}.worker.{name}" for name in WORKERS))
# What a record that carries a job keeps: a record's own fields, and the action and worker Procrastinate adds.
JOB_RECORD_FIELDS = frozenset(vars(logging.LogRecord("", logging.NOTSET, "", 0, "", (), None))) | {"action", "worker"}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _job_name(job: object) -> str:
    """`task[id]`, from the log context Procrastinate puts in a record."""
    return f"{job.get('task_name')}[{job.get('id')}]" if isinstance(job, dict) else "a job"


class JobRecords(logging.Filter):
    """Reduces a job queue record that carries a job (its `job` extra, or `jobs` for a batch) to its action, each job's
    task and ID, and its error's type. Its call string (the job's arguments), `args`, other extras and the error's
    message and traceback are dropped. A record without a job passes unchanged."""

    def filter(self, record: logging.LogRecord) -> bool:
        fields = vars(record)
        if "job" in fields:
            carried = [fields["job"]]
        elif "jobs" in fields:
            carried = fields["jobs"] if isinstance(fields["jobs"], list) else [fields["jobs"]]
        else:
            return True
        action = fields.get("action") if isinstance(fields.get("action"), str) else "job"
        error = record.exc_info[0] if isinstance(record.exc_info, tuple) else None
        record.msg = f"{action}: {', '.join(_job_name(job) for job in carried)}" + (
            f" ({error.__name__})" if error is not None else "")
        record.args = ()
        record.exc_info = record.exc_text = record.stack_info = None
        for name in fields.keys() - JOB_RECORD_FIELDS:
            delattr(record, name)
        return True


JOB_RECORDS = JobRecords()


def _quiet_job_queue_logs() -> None:
    """The job queue logs only warnings and errors, since its INFO and DEBUG records name each job with its arguments,
    and `JobRecords` reduces each of its records that carries a job, so a failed job's ERROR doesn't name them either.
    A logger's filter doesn't see its children's records, so the level and the filter go on each of its loggers."""
    names = {name for name in logging.root.manager.loggerDict if name.startswith(JOB_QUEUE_LOGGER + ".")}
    for name in (JOB_QUEUE_LOGGER, *sorted(names.union(JOB_WORKER_LOGGERS))):
        job_queue = logging.getLogger(name)
        job_queue.setLevel(logging.WARNING)
        job_queue.addFilter(JOB_RECORDS)


def _refuse_test_hooks(settings: Settings, hooks: dict[str, Any]) -> None:
    if settings.production:
        for name, value in hooks.items():
            if value is not None:
                raise RuntimeError(f"an injected {name} is a test hook; production refuses it")


def _error(request: Request, status: int, error: str, *, code: str | None = None, retry_after: int | None = None,
           headers: dict[str, str] | None = None) -> Response:
    """The error answer: an `ApiError`, on a document link the static copy a browser tab shows, and on the A2A endpoint
    an `A2AError`, which says the answer comes from an AI."""
    if request.url.path.startswith(a2a.A2A_PATH):
        return a2a.error_response(status, code or error, headers=headers)
    body = ApiError(error=error, code=code, retry_after=retry_after)
    refusal = proxy.document_refusal(request, status, body, headers)
    if refusal is not None:
        return refusal
    return JSONResponse(body.model_dump(exclude_none=True), status_code=status, headers=headers)


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiProblem)
    async def api_problem(request: Request, problem: ApiProblem) -> Response:
        response = _error(request, problem.status, problem.error, code=problem.code, retry_after=problem.retry_after)
        if problem.clear_visitor is not None:
            clear_visitor_cookie(response, problem.clear_visitor)
        return response

    @app.exception_handler(RateLimited)
    async def rate_limited(request: Request, limited: RateLimited) -> Response:
        return _error(request, 429, "rate_limited", retry_after=limited.retry_after,
                      headers={"Retry-After": str(limited.retry_after)})

    @app.exception_handler(KernelFailed)
    async def kernel_failed(request: Request, failure: KernelFailed) -> Response:
        return _error(request, failure.status, "kernel", code=failure.code)

    @app.exception_handler(KernelUnavailable)
    async def kernel_unavailable(request: Request, failure: KernelUnavailable) -> Response:
        return _error(request, 503, "kernel",
                      code=failure.code if failure.code in KERNEL_CODES else "kernel_unavailable")

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, error: RequestValidationError) -> Response:
        return _error(request, 422, "invalid")

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> Response:
        name = {404: "not_found", 405: "method_not_allowed"}.get(error.status_code, "http_error")
        return _error(request, error.status_code, name, headers=getattr(error, "headers", None))

    @app.exception_handler(Exception)
    async def internal(request: Request, error: Exception) -> Response:
        return _error(request, 500, "internal")


system = APIRouter(generate_unique_id_function=operation_ids("system"))


@system.get("/api/health", response_model=HealthOut, responses={503: {"model": HealthOut}})
async def health(request: Request) -> HealthOut | JSONResponse:
    """The kernel's health, for the load balancer and the smoke checks; no cookie is read."""
    try:
        kernel = await runtime(request).started().kernel.public().call("GET /health")
    except (KernelFailed, KernelUnavailable):
        return JSONResponse(HealthOut(ok=False, kernel=None).model_dump(mode="json"), status_code=503)
    return HealthOut(ok=True, kernel=kernel)


async def _mark_demo_visitor(engine: AsyncEngine, ids: Ids, run: DemoVisitorRun) -> None:
    """Mark a demo visitor's chat in its transcript (a `demo_visitor` row naming its persona), once its session is open
    and before it says anything, so the owner's reads label the chat after this process is gone. A failure here ends
    the run before it writes (`DemoVisitors`' `on_open`), so no demo visitor chats unmarked."""
    async with engine.connect() as conn:
        await append_message(conn, ids, "demo_visitor", text=run.first_name)
        await conn.commit()


async def _stop(task: asyncio.Task) -> None:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def create_app(settings: Settings, *, kernel_transport: Any = None, model: Any = None,
               clock: Callable[[], datetime] | None = None, jobs_connector: Any = None) -> FastAPI:
    """The API app. `kernel_transport`, `model`, `clock` and `jobs_connector` are test hooks, refused in production.
    With no model injected, the client `settings` names is built here, so a provider without its credential never
    starts. An injected job queue connector (Procrastinate's `InMemoryConnector`) runs no periodic jobs: tests run
    them."""
    _refuse_test_hooks(settings, {"kernel transport": kernel_transport, "model": model, "clock": clock,
                                  "job queue connector": jobs_connector})
    _quiet_job_queue_logs()
    log_redaction.install()
    if settings.passcode_hash is not None:
        try:
            check_passcode_hash(settings.passcode_hash)
        except ValueError as malformed:
            raise RuntimeError(str(malformed)) from None    # the message names the variable, never its value
    now = clock or _utc_now
    built = make_model(settings, clock=now) if model is None else None   # closed by the lifespan; an injected one isn't
    jobs = (jobs_app(procrastinate_connector(settings.api_database_url)) if jobs_connector is None
            else jobs_app(jobs_connector, schedule=False))
    state = Runtime(settings=settings, clock=now, limiter=RateLimiter(now), stream_slots=StreamSlots(),
                    model=model if model is not None else built, kernel_transport=kernel_transport, jobs=jobs)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        kernel = KernelHttp(settings.kernel_url, transport=state.kernel_transport)
        async with contextlib.AsyncExitStack() as stack:
            if built is not None:
                stack.push_async_callback(built.aclose)
            stack.push_async_callback(kernel.aclose)
            assert_production_safe(settings, kernel)
            # Neither pool puts a statement's parameters in its errors: a route's failure is logged by the server.
            engine = create_async_engine(settings.api_database_url, connect_args={"options": API_CONNECT_OPTIONS},
                                         pool_size=POOL_SIZE, max_overflow=MAX_OVERFLOW, pool_timeout=POOL_TIMEOUT_S,
                                         pool_pre_ping=True, hide_parameters=True)
            stack.push_async_callback(engine.dispose)
            # The turn locks' own pool: each running turn holds its session's lock on one of these connections.
            lock_engine = create_async_engine(settings.api_database_url,
                                              connect_args={"options": API_CONNECT_OPTIONS},
                                              pool_size=TURN_LOCK_POOL_SIZE, max_overflow=0,
                                              pool_timeout=POOL_TIMEOUT_S, pool_pre_ping=True, hide_parameters=True)
            stack.push_async_callback(lock_engine.dispose)
            listener = await stack.enter_async_context(Listener(settings.api_database_url))
            runner = TurnRunner(state.model, engine=engine, lock_engine=lock_engine, production=settings.production,
                                clock=state.clock, jobs=jobs, limiter=state.limiter)
            stack.push_async_callback(runner.close)        # no turn outlives the pools it runs on
            agent_client = a2a_client(settings, state.a2a_transport)
            stack.push_async_callback(agent_client.aclose)
            agents = DemoAgents(state.model, a2a=agent_client, engine=engine, clock=state.clock,
                                production=settings.production)
            stack.push_async_callback(agents.close)        # before its client, the runner and the pools
            # Each demo visitor's own client of the public visitor endpoints, made when its run starts.
            visitors = DemoVisitors(state.model, client=lambda: visitor_client(settings, state.a2a_transport),
                                    engine=engine, clock=state.clock, production=settings.production,
                                    on_open=functools.partial(_mark_demo_visitor, engine))
            stack.push_async_callback(visitors.close)      # before the runner and the pools
            stack.push_async_callback(state.proving.close)  # no proving work outlives the pools it runs on
            stack.push_async_callback(state.turn_runs.close)
            await stack.enter_async_context(jobs.open_async())
            worker = asyncio.create_task(run_worker(jobs, JobEnv(engine=engine, ro_schema=settings.kernel_ro_schema,
                                                                 clock=state.clock, model=state.model,
                                                                 production=settings.production)),
                                         name="desk-jobs-worker")
            stack.push_async_callback(_stop, worker)        # first out: no job outlives the pools it runs on
            state.kernel, state.engine, state.listener, state.runner = kernel, engine, listener, runner
            state.agents, state.demo_visitors = agents, visitors
            if settings.passcode_hash is None:
                logger.warning("PASSCODE_HASH is not set, so no passcode creates a copy "
                               "(make one with: cd backend && uv run python scripts/hash_passcode.py)")
            try:
                yield
            finally:
                state.kernel = state.engine = state.listener = state.runner = state.agents = None
                state.demo_visitors = None

    app = FastAPI(title="Claude Desk API", version="0.1.0", lifespan=lifespan, openapi_url=None, docs_url=None,
                  redoc_url=None)
    app.state.runtime = state
    _install_error_handlers(app)
    app.include_router(system)
    app.include_router(owner.router)
    app.include_router(setup.router)
    app.include_router(public.router)
    app.include_router(proxy.router)
    app.include_router(agents.router)
    app.include_router(setup.policy_router)
    app.include_router(rules.router)
    app.include_router(rules.policy_router)

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = agents.with_request_schemas(FastAPI.openapi(app))
        return app.openapi_schema

    app.openapi = openapi
    return app


def app_factory() -> FastAPI:
    """uvicorn's entry point: the app from the process environment."""
    return create_app(Settings.from_env())
