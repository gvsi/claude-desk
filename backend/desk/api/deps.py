"""What the API's routes depend on: the process's runtime, the caller and the errors routes raise.

`runtime(request)` is the app's `Runtime`: settings, clock, rate limits, the job queue and, once the lifespan has
started, the kernel client, the database engine, the run events listener, the turn runner, the built-in agent's runs
and the demo visitors' runs. `owner_ctx` is the owner's copy and `visitor_ctx` the visitor's session, each taken from
the kernel's `GET /whoami` answer for its cookie; `client_ip` and `public_origin` follow Plan 06b's seam ("Client IP
and public origin"); `require_model_budget` guards the model routes.
"""

import contextlib
import ipaddress
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import procrastinate
from fastapi import Request, Response
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.agents import DemoAgents
from desk.api.demo_visitors import DemoVisitors
from desk.api.turn_runs import TurnRuns
from desk.api.cookies import OWNER_COOKIE, VISITOR_COOKIE, set_visitor_cookie
from desk.api.kernel_client import CredentialView, KernelFailed, KernelHttp, KernelUnavailable
from desk.api.metrics import over_daily_budget
from desk.api.presence import Presence
from desk.api.proving import Proving
from desk.api.ratelimit import RateLimited, RateLimiter, RateLimitLedger, StreamSlots
from desk.api.ro import KernelRO
from desk.api.runner import TurnRunner
from desk.api.settings import Settings
from desk.api.sse import Listener
from desk.api.store import Ids
from desk.api.tools import Caller
from desk.contracts import SessionState


class ApiProblem(Exception):
    """An error answer: `status` with `ApiError{error, code, retry_after}`. `clear_visitor` names the Desk slug whose
    visitor cookie the answer clears (its session is gone)."""

    def __init__(self, status: int, error: str, *, code: str | None = None, retry_after: int | None = None,
                 clear_visitor: str | None = None):
        super().__init__(f"{status} {error}")
        self.status, self.error, self.code, self.retry_after = status, error, code, retry_after
        self.clear_visitor = clear_visitor


def proving_work() -> Proving:
    """The proving routes' work, whose errors the app answers with (an `ApiError`) aren't logged as failures."""
    return Proving(answers=(ApiProblem, RateLimited, KernelFailed, KernelUnavailable))


@dataclass
class Runtime:
    """The process's state. `kernel`, `engine`, `listener`, `runner`, `agents` and `demo_visitors` are opened by the
    lifespan, which also builds the model client unless a test injected one, and opens the job queue (`jobs`) and runs
    its worker. `a2a_transport` is a test hook the lifespan refuses in production: the transport of the built-in
    agent's client of the public A2A endpoint and of each demo visitor's client of the public visitor endpoints (the
    app itself, in process), set on the runtime before the lifespan starts."""

    settings: Settings
    clock: Callable[[], datetime]
    limiter: RateLimiter
    stream_slots: StreamSlots
    jobs: procrastinate.App | None = None   # the job queue (Task 8): resume jobs and the periodic ones
    model: Any = None                     # the model client (Task 4); a test may inject one
    kernel_transport: Any = field(default=None, repr=False)   # tests only: FakeKernel in process
    kernel: KernelHttp | None = None
    engine: AsyncEngine | None = None
    listener: Listener | None = None
    runner: TurnRunner | None = None      # the session turns this process runs (Task 7)
    agents: DemoAgents | None = None      # the built-in visiting agent's runs (Plan 02b)
    demo_visitors: DemoVisitors | None = None     # the demo visitors' runs (`demo_visitors.py`)
    a2a_transport: Any = field(default=None, repr=False)      # tests only: the agent's and demo visitors' loopback
    presence: Presence = field(default_factory=Presence)      # who is typing, in this process's memory (Plan 02b)
    proving: Proving = field(default_factory=proving_work)    # the proving routes' running work (Plan 02b)
    turn_runs: TurnRuns = field(default_factory=TurnRuns)

    def database(self) -> AsyncEngine:
        if self.engine is None:
            raise RuntimeError("the API's lifespan hasn't started")
        return self.engine

    def started(self) -> "Runtime":
        if (self.kernel is None or self.engine is None or self.listener is None or self.runner is None
                or self.agents is None or self.demo_visitors is None or self.jobs is None):
            raise RuntimeError("the API's lifespan hasn't started")
        return self


def runtime(request: Request) -> Runtime:
    return request.app.state.runtime


# Client IP and public origin (Plan 06b's seam; no other header is trusted) ------------------------------

SHARED_BUCKET = "shared"      # not an address, so it never shares a window with a real one


def _address(text: str | None) -> str | None:
    try:
        return str(ipaddress.ip_address((text or "").strip()))
    except ValueError:
        return None


def client_ip(request: Request) -> str | None:
    """The client's address for per-IP limits, or None for a caller exempt from them.

    With `TRUSTED_PROXY_HOPS = n > 0` it is the n-th entry from the right of `X-Forwarded-For` (CloudFront
    appends the viewer, the load balancer appends CloudFront, so the entries an attacker writes are further
    left); with fewer entries or an invalid one, every such request shares one bucket. With 0 it is the socket
    peer. A loopback peer sending no `X-Forwarded-For` (the built-in agent) is exempt, and outside production
    so is every loopback peer.
    """
    settings = runtime(request).settings
    peer = _address(request.client.host if request.client else None)
    forwarded = request.headers.getlist("x-forwarded-for")
    if peer is not None and ipaddress.ip_address(peer).is_loopback and (not forwarded or not settings.production):
        return None
    hops = settings.trusted_proxy_hops
    if hops == 0:
        return peer or SHARED_BUCKET
    entries = [entry for value in forwarded for entry in value.split(",")]
    if len(entries) < hops:
        return SHARED_BUCKET
    return _address(entries[-hops]) or SHARED_BUCKET


def public_origin(request: Request) -> str:
    """The origin public links are built from: `PUBLIC_ORIGIN`, never the request's `Host` or forwarded headers."""
    return runtime(request).settings.public_origin


# The owner ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class OwnerCtx:
    """An owner request's copy, from the kernel's `GET /whoami` answer for the owner cookie: its Desks, the owner
    session and its generation (an owner's own tool calls, setup's, are decided at it), the owner's kernel view and
    the copy's kernel_ro reads. The browser never names any of them."""

    copy_id: str
    desk_ids: tuple[str, ...]
    owner_session_id: str
    owner_generation: int
    kernel: CredentialView = field(repr=False)
    ro: KernelRO = field(repr=False)

    def desk(self, desk_id: str) -> str:
        """`desk_id` when it is one of this copy's Desks; any other ID is 404, whether or not it exists."""
        if desk_id not in self.desk_ids:
            raise ApiProblem(404, "not_found")
        return desk_id

    def ledger(self) -> RateLimitLedger | None:
        """The owner's credential for ledgering a refusal, on the copy's first Desk."""
        if not self.desk_ids:
            return None
        return RateLimitLedger(self.kernel, desk_id=self.desk_ids[0], session_id=self.owner_session_id)


@contextlib.asynccontextmanager
async def owner_context(state: Runtime, token: str) -> AsyncIterator[OwnerCtx]:
    """The owner context for `token`, read with `GET /whoami` once; 401 `no_owner_session` when the kernel says the
    token names no open owner session. Holds one database connection for the copy's reads, which never commit."""
    try:
        kernel = state.kernel.owner(token)
        who = await kernel.whoami()
    except ValueError:                                   # not a header value a kernel token could be
        raise ApiProblem(401, "no_owner_session") from None
    except KernelFailed as failure:
        if failure.ends_session:
            raise ApiProblem(401, "no_owner_session") from None
        raise
    if who.kind != "owner" or who.session is None:
        raise ApiProblem(401, "no_owner_session")
    async with state.engine.connect() as conn:
        yield OwnerCtx(copy_id=who.copy_id, desk_ids=tuple(who.desk_ids), owner_session_id=who.session.session_id,
                       owner_generation=who.session.generation,
                       kernel=kernel, ro=KernelRO(conn, who.copy_id, state.settings.kernel_ro_schema))


async def owner_ctx(request: Request) -> AsyncIterator[OwnerCtx]:
    """The owner context for the request's `desk_owner` cookie (a dependency, so once per request)."""
    token = request.cookies.get(OWNER_COOKIE)
    if not token:
        raise ApiProblem(401, "no_owner_session")
    async with owner_context(runtime(request).started(), token) as ctx:
        yield ctx


# The visitor -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class VisitorCtx:
    """A visitor request's session, from the kernel's `GET /whoami` answer for the `desk_visitor` cookie: its IDs,
    the caller a turn acts for (holding the token in memory only), the copy's kernel_ro reads on the request's
    database connection, and the session's state. The browser never names any of them."""

    ids: Ids
    caller: Caller = field(repr=False)
    ro: KernelRO = field(repr=False)
    state: SessionState

    @property
    def conn(self) -> AsyncConnection:
        """The request's database connection (the one `ro` reads on)."""
        return self.ro.conn

    def ledger(self) -> RateLimitLedger:
        """The visitor's own credential, for ledgering a refusal on the session's Desk."""
        return RateLimitLedger(self.caller.kernel, desk_id=self.ids.desk_id, session_id=self.ids.session_id)


@contextlib.asynccontextmanager
async def visitor_context(state: Runtime, token: str | None, slug: str) -> AsyncIterator[VisitorCtx]:
    """The visitor context for `token`, read with `GET /whoami` once; 401 `no_session` unless the kernel says it
    names an open visitor session on the slug's Desk. A token that names none is a session gone, and that answer
    also clears the cookie it came in (Plan 02a, "API fail-closed rules"). Holds one database connection for the
    request."""
    if not token:
        raise ApiProblem(401, "no_session")
    gone = ApiProblem(401, "no_session", clear_visitor=slug)
    try:
        kernel = state.kernel.session(token)
        who = await kernel.whoami()
    except ValueError:                                   # not a header value a kernel token could be
        raise gone from None
    except KernelFailed as failure:
        if failure.ends_session:
            raise gone from None
        raise
    if who.kind != "visitor" or who.session is None or who.desk_id is None:
        raise gone
    async with state.engine.connect() as conn:
        ro = KernelRO(conn, who.copy_id, state.settings.kernel_ro_schema)
        desk = await ro.one("desks", desk_id=who.desk_id)
        if desk is None or desk["slug"] != slug:         # a session of another Desk: not this route's
            raise gone
        ids = Ids(copy_id=who.copy_id, desk_id=who.desk_id, session_id=who.session.session_id)
        caller = Caller(copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id, kind="visitor",
                        kernel=kernel, ro_schema=state.settings.kernel_ro_schema)
        yield VisitorCtx(ids=ids, caller=caller, ro=ro, state=who.session)


async def visitor_ctx(request: Request, response: Response, slug: str) -> AsyncIterator[VisitorCtx]:
    """The visitor context for the request's `desk_visitor` cookie (a dependency, so once per request); the cookie
    is renewed on the answer, since the kernel closes a session after 24 hours idle."""
    token = request.cookies.get(VISITOR_COOKIE)
    async with visitor_context(runtime(request).started(), token, slug) as ctx:
        set_visitor_cookie(response, slug, token)
        yield ctx


# The daily model budget -------------------------------------------------------------------------------------


async def require_model_budget(request: Request) -> None:
    """On every model route but the conversation (whose turns hand off instead): in production, 503 `demo_budget`
    once today's model spend has reached the daily budget."""
    state = runtime(request)
    if not state.settings.production:
        return
    async with state.database().connect() as conn:
        if await over_daily_budget(conn, state.clock):
            raise ApiProblem(503, "demo_budget")
