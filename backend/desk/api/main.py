"""The API process (port 8700): `create_app` builds it, `app_factory` is uvicorn's entry point.

    uvicorn --factory desk.api.main:app_factory --host 0.0.0.0 --port 8700 --timeout-keep-alive 310

`create_app` builds the model client through `make_model` (the Claude API, or Amazon Bedrock for local evals)
before the app, so a provider without its credential, or `ANTHROPIC_CUSTOM_HEADERS` set, refuses to start. The
lifespan opens the kernel client, checks it is the production one when it must be, then opens the database engine,
the turn locks' pool, the run events listener and the turn runner, and closes them in the reverse order, the
runner's turns first, with the model client it built (never an injected one) last. In production the app refuses
to start without its secrets (the API key, the passcode hash and the public origin, which `Settings` requires),
with a Bedrock setting or credential (refused by `Settings`) and with any test hook: `ANTHROPIC_BASE_URL` (refused
by `Settings`), an injected clock, model or kernel transport. A passcode hash that isn't one refuses to start
anywhere.

Every error answer is an `ApiError` ("Errors"): a kernel refusal keeps its status with `{error: "kernel",
code}`, an unreachable kernel is 503 `{error: "kernel", code}` (`seed_unproved`, `internal`, else
`kernel_unavailable`), a limit is 429 `{error: "rate_limited", retry_after}`, and a body that doesn't fit is
422 `{error: "invalid"}`, never echoing what was sent.
"""

import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import create_async_engine
from starlette.exceptions import HTTPException as StarletteHTTPException

from desk.api.deps import ApiProblem, Runtime, runtime
from desk.api.kernel_client import KernelFailed, KernelHttp, KernelUnavailable, assert_production_safe
from desk.api.loop import TURN_LOCK_POOL_SIZE
from desk.api.model import make_model
from desk.api.passcode import check_passcode_hash
from desk.api.ratelimit import RateLimited, RateLimiter, StreamSlots
from desk.api.routes import owner, public
from desk.api.runner import TurnRunner
from desk.api.schemas import ApiError, HealthOut, operation_ids
from desk.api.settings import Settings
from desk.api.sse import Listener
from desk.db.session import API_CONNECT_OPTIONS

logger = logging.getLogger(__name__)

# The API's pool ("Connections and state"): 20 connections, 10 more under load, 5 s to get one.
POOL_SIZE, MAX_OVERFLOW, POOL_TIMEOUT_S = 20, 10, 5
KERNEL_CODES = frozenset({"seed_unproved", "internal"})


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _refuse_test_hooks(settings: Settings, hooks: dict[str, Any]) -> None:
    if settings.production:
        for name, value in hooks.items():
            if value is not None:
                raise RuntimeError(f"an injected {name} is a test hook; production refuses it")


def _error(status: int, error: str, *, code: str | None = None, retry_after: int | None = None,
           headers: dict[str, str] | None = None) -> JSONResponse:
    body = ApiError(error=error, code=code, retry_after=retry_after).model_dump(exclude_none=True)
    return JSONResponse(body, status_code=status, headers=headers)


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiProblem)
    async def api_problem(request: Request, problem: ApiProblem) -> JSONResponse:
        return _error(problem.status, problem.error, code=problem.code, retry_after=problem.retry_after)

    @app.exception_handler(RateLimited)
    async def rate_limited(request: Request, limited: RateLimited) -> JSONResponse:
        return _error(429, "rate_limited", retry_after=limited.retry_after,
                      headers={"Retry-After": str(limited.retry_after)})

    @app.exception_handler(KernelFailed)
    async def kernel_failed(request: Request, failure: KernelFailed) -> JSONResponse:
        return _error(failure.status, "kernel", code=failure.code)

    @app.exception_handler(KernelUnavailable)
    async def kernel_unavailable(request: Request, failure: KernelUnavailable) -> JSONResponse:
        return _error(503, "kernel", code=failure.code if failure.code in KERNEL_CODES else "kernel_unavailable")

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, error: RequestValidationError) -> JSONResponse:
        return _error(422, "invalid")

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        name = {404: "not_found", 405: "method_not_allowed"}.get(error.status_code, "http_error")
        return _error(error.status_code, name, headers=getattr(error, "headers", None))

    @app.exception_handler(Exception)
    async def internal(request: Request, error: Exception) -> JSONResponse:
        return _error(500, "internal")


system = APIRouter(generate_unique_id_function=operation_ids("system"))


@system.get("/api/health", response_model=HealthOut, responses={503: {"model": HealthOut}})
async def health(request: Request) -> HealthOut | JSONResponse:
    """The kernel's health, for the load balancer and the smoke checks; no cookie is read."""
    try:
        kernel = await runtime(request).started().kernel.public().call("GET /health")
    except (KernelFailed, KernelUnavailable):
        return JSONResponse(HealthOut(ok=False, kernel=None).model_dump(mode="json"), status_code=503)
    return HealthOut(ok=True, kernel=kernel)


def create_app(settings: Settings, *, kernel_transport: Any = None, model: Any = None,
               clock: Callable[[], datetime] | None = None) -> FastAPI:
    """The API app. `kernel_transport`, `model` and `clock` are test hooks, refused in production. With no model
    injected, the client `settings` names is built here, so a provider without its credential never starts."""
    _refuse_test_hooks(settings, {"kernel transport": kernel_transport, "model": model, "clock": clock})
    if settings.passcode_hash is not None:
        try:
            check_passcode_hash(settings.passcode_hash)
        except ValueError as malformed:
            raise RuntimeError(str(malformed)) from None    # the message names the variable, never its value
    now = clock or _utc_now
    built = make_model(settings, clock=now) if model is None else None   # closed by the lifespan; an injected one isn't
    state = Runtime(settings=settings, clock=now, limiter=RateLimiter(now), stream_slots=StreamSlots(),
                    model=model if model is not None else built, kernel_transport=kernel_transport)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        kernel = KernelHttp(settings.kernel_url, transport=state.kernel_transport)
        async with contextlib.AsyncExitStack() as stack:
            if built is not None:
                stack.push_async_callback(built.aclose)
            stack.push_async_callback(kernel.aclose)
            assert_production_safe(settings, kernel)
            engine = create_async_engine(settings.api_database_url, connect_args={"options": API_CONNECT_OPTIONS},
                                         pool_size=POOL_SIZE, max_overflow=MAX_OVERFLOW, pool_timeout=POOL_TIMEOUT_S,
                                         pool_pre_ping=True)
            stack.push_async_callback(engine.dispose)
            # The turn locks' own pool: each running turn holds its session's lock on one of these connections.
            lock_engine = create_async_engine(settings.api_database_url,
                                              connect_args={"options": API_CONNECT_OPTIONS},
                                              pool_size=TURN_LOCK_POOL_SIZE, max_overflow=0,
                                              pool_timeout=POOL_TIMEOUT_S, pool_pre_ping=True)
            stack.push_async_callback(lock_engine.dispose)
            listener = await stack.enter_async_context(Listener(settings.api_database_url))
            runner = TurnRunner(state.model, engine=engine, lock_engine=lock_engine, production=settings.production,
                                clock=state.clock)
            stack.push_async_callback(runner.close)        # first out: no turn outlives the pools it runs on
            state.kernel, state.engine, state.listener, state.runner = kernel, engine, listener, runner
            if settings.passcode_hash is None:
                logger.warning("PASSCODE_HASH is not set, so no passcode creates a copy "
                               "(make one with: cd backend && uv run python scripts/hash_passcode.py)")
            try:
                yield
            finally:
                state.kernel = state.engine = state.listener = state.runner = None

    app = FastAPI(title="Claude Desk API", version="0.1.0", lifespan=lifespan, openapi_url=None, docs_url=None,
                  redoc_url=None)
    app.state.runtime = state
    _install_error_handlers(app)
    app.include_router(system)
    app.include_router(owner.router)
    app.include_router(public.router)
    return app


def app_factory() -> FastAPI:
    """uvicorn's entry point: the app from the process environment."""
    return create_app(Settings.from_env())
