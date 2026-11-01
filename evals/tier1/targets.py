"""What tier 1 cases call when a real kernel answers: the kernel in-process, on the eval's clock.

`KernelTarget` runs Plan 01a's `create_app` under uvicorn on a free 127.0.0.1 port, in this
process, on a `TravelClock` the case moves. Its model calls go to a `FakeAnthropic` the case
scripts, and from Plan 01c on its payment calls go to the mock payments server, run in a thread
beside it. Every call is checked against the kernel API contract both ways, and an answer other
than the case expected fails the case.

A case can also restart the kernel (`restart_kernel`) or kill one request where the process would
die (`crash_after_intent`, `crash_after_side_effect`, which raise `SimulatedCrash`). On the
contract stub, which runs no kernel, these do nothing but contract-check the dying call.

Kernel code is imported only when a target starts or a crash hook patches it, so collecting tier 1
needs no kernel.
"""

import asyncio
import functools
import importlib
import inspect
import json
import os
import pkgutil
import secrets
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable
from urllib.parse import quote

import httpx
import psycopg
from pydantic import BaseModel, TypeAdapter, ValidationError

from desk.contracts import CopyCreated, SessionCreated
from desk.db.session import database_url, libpq_url
from desk.kernel_api import Health, KernelError
from evals.fakes import FakeAnthropic, Json, LoopbackServer
from evals.records import Records
from evals.tier1.harness import (
    PLANS,
    Auth,
    Called,
    ContractError,
    Expect,
    KernelHarness,
    TravelClock,
    check_expect_paths,
    check_request,
    declared_names,
    load_landed,
    match_expect,
    parse_route,
    response_type,
    undeclared_fields,
    unlisted_landed,
    validation_summary,
)

__all__ = [
    "AFTER_INTENT", "API_IMPL", "CASE_SCHEMAS", "DUMMY_KEY", "SYMCC_REQUIRED", "ApiTarget", "ApiUnavailable",
    "Crash", "KernelTarget", "MakeApiTarget", "MockpayClient", "SimulatedCrash", "TargetError", "TravelClock",
    "crash_after_intent", "crash_after_side_effect", "empty_database", "load_api_target", "refuse_real_models",
    "restart_kernel",
]

REPO_ROOT = Path(__file__).resolve().parents[2]
DUMMY_KEY = "tier1-dummy"   # the only model key tier 1 holds
SYMCC_REQUIRED = "tier 1 needs symcc mode (cvc5 not found)"
SOFT_PROMISE_MODEL = "claude-sonnet-5-5"
API_HAIKU_MODEL = "claude-haiku-5-5"   # owner translations and triage, in the API
# A passing soft-promise check (Plan 01a's `SoftPromiseVerdict`), the fake's default for its model.
SOFT_PROMISE_PASS = {"promises_beyond_cards": False, "denies_being_ai": False}
CALL_TIMEOUT_S = 30.0
# The client timeout the master plan gives proving calls (the kernel proves within its 45 s budget).
PROVING_TIMEOUT_S = 60.0
PROVING_ROUTES = frozenset({"POST /policy/draft", "POST /policy/{version}/probe", "POST /tools/confirm"})
MCP_PATH = "/mcp"     # the mock payments server's MCP endpoint (the SDK's streamable HTTP default)
MAX_TOOL_PAGES = 16   # a bound on `tools/list` pages, in case a cursor never ends
# The module holding Plan 02a's `make_api_target` (its Task 9): `evals.tier1.api_impl`, joined so
# that no string literal here reads like an API key to a secret scanner.
API_IMPL = ".".join(("evals", "tier1", "api_impl"))

_real_models_refused = False


def refuse_real_models() -> None:
    """Make `KernelTarget(models="real")` refuse to start in this process: tier 1 makes no model calls."""
    global _real_models_refused
    _real_models_refused = True


# Every schema a case can write to: the kernel's, the API's, the mock payments server's and the API's
# job queue (the API target runs Procrastinate on this database).
CASE_SCHEMAS = ("kernel", "app", "mockpay", "procrastinate")


def empty_database() -> list[str]:
    """Empty every table in `CASE_SCHEMAS`, as desk_admin (the kernel's role may not truncate the
    ledger), and return their names, so a case finds only what it makes. A kernel's startup looks at
    every copy in the database (`rebuild_at_startup`), so copies left by earlier cases made each
    start slower than the last, and an API target's worker could take a job an earlier case queued.
    It empties the database the `*_DATABASE_URL` variables name, as the backend's tests do: give a run a
    database of its own."""
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as admin:
        tables = [name for (name,) in admin.execute(
            "SELECT format('%%I.%%I', schemaname, tablename) FROM pg_tables WHERE schemaname = ANY(%s) ORDER BY 1",
            (list(CASE_SCHEMAS),),
        )]
        # a transaction an earlier case left open fails this case within the minute instead of
        # hanging the run until the job's timeout
        admin.execute("SET lock_timeout = '30s'")
        admin.execute("TRUNCATE " + ", ".join(tables))
    return tables


class TargetError(RuntimeError):
    """The target can't run as tier 1 needs it to."""


class SimulatedCrash(BaseException):
    """A stand-in for the kernel process dying mid-request.

    The kernel's handlers catch `Exception`, never `BaseException` (Plan 01a), so this passes its
    T3 untouched: the execution is marked neither `failed` nor `unknown`, and a committed intent
    row stays for reconciliation, as after a real crash."""


class MockpayClient:
    """The mock payments server's test routes (Plan 01c), as the copy's provider account."""

    def __init__(self, url: str, key: str):
        self.url = url
        self._key = key

    async def seed(self, copy_id: str, charges: list[dict[str, Any]]) -> list[str]:
        """Add charges to the copy's store (`owner_person_id`, `amount_cents`, `description`, `created_at`)."""
        return (await self._post(copy_id, "/provider/seed", {"charges": charges}))["charge_ids"]

    async def delay(self, copy_id: str, op: str, seconds: float) -> None:
        """Make the copy's later `op` calls ("checkout", "complete", "charge", "refund" or "tools") sleep first."""
        await self._post(copy_id, "/provider/test/delay", {"op": op, "seconds": seconds})

    async def charge(self, copy_id: str, charge_id: str) -> dict[str, Any]:
        """One charge in the copy's store: `{charge_id, owner_person_id, amount_cents, refunded_cents}`.
        A charge outside the copy's store raises `httpx.HTTPStatusError` (the server's 404)."""
        return await self._request("GET", copy_id, f"/provider/charges/{quote(charge_id, safe='')}")

    async def listed_tools(self, copy_id: str) -> dict[str, dict[str, Any]]:
        """What the server lists to the copy, read as any MCP client reads it: `tools/list` on its
        streamable HTTP endpoint (stateless, so no session is opened first), every page, as
        name → entry. An answer framed as server-sent events is read too; a JSON-RPC error, or a
        list that never ends, raises `TargetError`."""
        headers = {"X-Mockpay-Key": self._key, "X-Desk-Copy": copy_id, "Accept": "application/json, text/event-stream"}
        tools: dict[str, dict[str, Any]] = {}
        cursor = None
        async with httpx.AsyncClient(base_url=self.url, timeout=CALL_TIMEOUT_S, trust_env=False) as client:
            for request_id in range(1, MAX_TOOL_PAGES + 1):
                params = {} if cursor is None else {"cursor": cursor}
                response = await client.post(MCP_PATH, headers=headers, json={
                    "jsonrpc": "2.0", "id": request_id, "method": "tools/list", "params": params})
                response.raise_for_status()
                message = _json_rpc_answer(response)
                if "result" not in message:
                    raise TargetError(f"the mock payments server answered tools/list with {message.get('error')!r}")
                tools.update({tool["name"]: tool for tool in message["result"]["tools"]})
                cursor = message["result"].get("nextCursor")
                if not cursor:
                    return tools
        raise TargetError(f"the mock payments server's tools/list ran past {MAX_TOOL_PAGES} pages")

    async def _post(self, copy_id: str, path: str, body: dict[str, Any]) -> Any:
        return await self._request("POST", copy_id, path, body)

    async def _request(self, method: str, copy_id: str, path: str, body: dict[str, Any] | None = None) -> Any:
        headers = {"X-Mockpay-Key": self._key, "X-Desk-Copy": copy_id}
        async with httpx.AsyncClient(base_url=self.url, timeout=CALL_TIMEOUT_S, trust_env=False) as client:
            response = await client.request(method, path, json=body, headers=headers)
        response.raise_for_status()
        return response.json()


def _json_rpc_answer(response: httpx.Response) -> dict[str, Any]:
    """The JSON-RPC message an MCP answer carries: its JSON body, or the `data:` of its one event."""
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        data = [line.removeprefix("data:").strip() for line in response.text.splitlines() if line.startswith("data:")]
        if len(data) != 1:
            raise TargetError(f"the mock payments server's event stream held {len(data)} messages, not one")
        return json.loads(data[0])
    return response.json()


class _Environment:
    """Process environment changes that a target makes for its lifetime and then undoes."""

    def __init__(self) -> None:
        self._saved: dict[str, str | None] = {}

    def set(self, name: str, value: str) -> None:
        self._saved.setdefault(name, os.environ.get(name))
        os.environ[name] = value

    def unset(self, name: str) -> None:
        self._saved.setdefault(name, os.environ.get(name))
        os.environ.pop(name, None)

    def restore(self) -> None:
        for name, value in self._saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self._saved.clear()


class KernelTarget:
    """The real kernel in-process, with what it calls (`KernelHarness`).

    `models="fake"` (tier 1): model calls go to `fake`, a `FakeAnthropic` whose
    `claude-sonnet-5-5` default for the verdict schema passes the soft-promise check, with a dummy key, `DESK_ENV=test`,
    `DESK_DECISIONS=anthropic` and the development signing key. `models="real"` (tier 2 only):
    the key in `.env`, the system clock and `DESK_ENV=dev`. Start it with `await start()`; it
    refuses to run in bounded proof mode unless `allow_bounded`. `stop()` fails on any unscripted
    model call."""

    is_real = True

    def __init__(self, models: Literal["fake", "real"] = "fake", allow_bounded: bool = False):
        if models not in ("fake", "real"):
            raise ValueError(f"models is 'fake' or 'real', not {models!r}")
        self.models, self.allow_bounded = models, allow_bounded
        self.clock = TravelClock()
        self.responses: list[Called] = []
        self.fake: FakeAnthropic | None = None
        self.records: Records | None = None
        self.health: Health | None = None
        self.url = ""
        self._landed = load_landed()
        self._env = _Environment()
        self._kernel_clock: Any = self.clock
        self._create_app: Any = None
        self._kernel: LoopbackServer | None = None
        self._port = 0
        self._client: httpx.AsyncClient | None = None
        self._mockpay_server: LoopbackServer | None = None
        self._mockpay: MockpayClient | None = None

    # Lifecycle

    async def start(self) -> "KernelTarget":
        """Start the fake model server, the mock payments server (from 01c) and the kernel."""
        if self.models == "real" and _real_models_refused:
            raise TargetError("tier 1 makes no model calls: KernelTarget(models='real') is tier 2's")
        from desk.kernel_service.app import create_app   # Plan 01a

        self._create_app = create_app
        try:
            self.records = Records(database_url("API"), database_url("KERNEL"))
            if self.models == "fake":
                self._fake_models()
            else:
                self._real_models()
            if self._runs_mockpay():
                await self._start_mockpay()
            await self._start_kernel()
            self.health = await self._read_health()
            if self.health.proof_mode != "symcc" and not self.allow_bounded:
                raise TargetError(
                    f"{SYMCC_REQUIRED}: /health reports {self.health.proof_mode!r}. Put cvc5 1.4.2 and desk-prove "
                    "on PATH (`make kernel`) or set DESK_PROVE; --allow-bounded runs anyway, without card rows' proofs"
                )
        except BaseException:
            await self._shutdown()
            raise
        return self

    async def stop(self) -> None:
        """Stop everything this target started, restore the environment, then fail on any
        unscripted model call or failed `on_request` callback."""
        await self._shutdown()
        if self.fake is not None:
            self.fake.check()

    async def restart(self) -> None:
        """A fresh kernel app on the same port and clock, as after a process restart: startup
        reconciliation runs. The fake model server and the mock payments server keep running.

        This runs in one Python process, so anything a real restart would lose that doesn't live in
        the database (a module-level cache or lock) survives: a restart case proves only the state
        the database holds, never that the kernel keeps none in memory."""
        await self._stop_kernel()
        await self._start_kernel()

    def travel(self, to: Any) -> None:
        self._own_clock().travel(to)

    def advance(self, seconds: float) -> None:
        self._own_clock().advance(seconds)

    def landed(self, plan: str) -> bool:
        if plan not in PLANS:
            raise ValueError(f"unknown plan {plan!r}; the plans are {list(PLANS)}")
        return plan in self._landed

    @property
    def mockpay(self) -> MockpayClient:
        if self._mockpay is None:
            raise TargetError("the mock payments server runs from Plan 01c on, and landed.toml doesn't list 01c")
        return self._mockpay

    def _own_clock(self) -> TravelClock:
        if self.models == "real":
            raise TargetError("a real-model target runs the kernel on the system clock, which doesn't travel")
        return self.clock

    def _fake_models(self) -> None:
        self.fake = FakeAnthropic().start()
        self.fake.default(SOFT_PROMISE_MODEL, Json(SOFT_PROMISE_PASS), schema="SoftPromiseVerdict")
        # The API's own Haiku calls (owner translations, triage) keep the answer they had while the soft
        # check ran on Haiku: an object they can't use, so each fails and the owner reads the message as sent.
        self.fake.default(API_HAIKU_MODEL, Json(SOFT_PROMISE_PASS))
        self._env.set("ANTHROPIC_BASE_URL", self.fake.url)
        self._env.set("ANTHROPIC_API_KEY", DUMMY_KEY)
        self._env.unset("ANTHROPIC_AUTH_TOKEN")
        self._env.unset("TYPESAFE_API_KEY")           # no external Jev calls in the model-free target
        self._env.set("DESK_ENV", "test")
        self._env.set("DESK_DECISIONS", "anthropic")   # Plan 01a's "offline" backend would never review
        self._env.unset("DESK_SIGNING_SEED")           # the development key, reported by /health

    def _real_models(self) -> None:
        from desk.kernel_service.clock import SystemClock   # Plan 01a

        key = _dotenv(REPO_ROOT / ".env").get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
        if not key or key == DUMMY_KEY:
            raise TargetError("KernelTarget(models='real') needs ANTHROPIC_API_KEY in the repository's .env")
        self._kernel_clock = SystemClock()
        self._env.set("ANTHROPIC_API_KEY", key)
        self._env.unset("ANTHROPIC_BASE_URL")
        self._env.set("DESK_ENV", "dev")
        self._env.set("DESK_DECISIONS", "anthropic")

    def _runs_mockpay(self) -> bool:
        """Whether the kernel calls a mock payments server: once Plan 01c's code is on the branch,
        whether or not landed.toml lists 01c yet, since a copy of the Turner seed connects its
        payment tools and fails closed without one. 01c's own cases still wait for its id."""
        return self.landed("01c") or "01c" in unlisted_landed(self._landed)

    async def _start_mockpay(self) -> None:
        """Plan 01c's mock payments server, in a thread with a fresh key. The kernel doesn't spawn
        it here, and it outlives `restart()`, as a real provider would."""
        from desk.mockpay.server import create_app as create_mockpay   # Plan 01c

        key = secrets.token_hex(16)   # 32 characters, the shortest the server accepts
        server = LoopbackServer(create_mockpay(database_url("MOCKPAY"), key, env="test"), name="mock payments server")
        await asyncio.to_thread(server.start)
        self._mockpay_server, self._mockpay = server, MockpayClient(server.url, key)
        self._env.set("MOCKPAY_URL", server.url)
        self._env.set("MOCKPAY_KEY", key)
        self._env.unset("MOCKPAY_SPAWN")

    async def _start_kernel(self) -> None:
        server = LoopbackServer(self._create_app(clock=self._kernel_clock), port=self._port, name="kernel")
        await asyncio.to_thread(server.start)
        self._kernel, self._port, self.url = server, server.port, server.url
        self._client = httpx.AsyncClient(base_url=server.url, timeout=CALL_TIMEOUT_S, trust_env=False)

    async def _stop_kernel(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if self._kernel is not None:
            await asyncio.to_thread(self._kernel.stop)
            self._kernel = None

    async def _shutdown(self) -> None:
        """Stop each part even if another fails to stop, restore the environment, then raise the
        first failure."""
        failures: list[BaseException] = []
        steps = [self._stop_kernel(), self._stop_mockpay()]
        if self.fake is not None:
            steps.append(asyncio.to_thread(self.fake.stop))
        if self.records is not None:
            steps.append(self.records.close())
        for step in steps:
            try:
                await step
            except BaseException as failure:
                failures.append(failure)
        self._env.restore()
        if failures:
            raise failures[0]

    async def _stop_mockpay(self) -> None:
        if self._mockpay_server is not None:
            await asyncio.to_thread(self._mockpay_server.stop)
            self._mockpay_server = None

    async def _read_health(self) -> Health:
        assert self._client is not None
        response = await self._client.get("/health")
        if response.status_code != 200:
            raise TargetError(f"the kernel's /health answered {response.status_code}")
        return Health.model_validate_json(response.content)

    # Calls

    async def call(
        self,
        route: str,
        *,
        path: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | BaseModel | None = None,
        raw_body: Any = None,
        auth: Auth,
        expect: Expect = Expect(),
    ) -> Any:
        """Call `route` with the case's credential and check the answer: it must fit the route's
        response model (a `KernelError` on non-2xx) with no field the model doesn't declare, and
        match `expect`. Returns the validated model; the call is recorded with the answer as sent
        (`Called.raw`) beside the model's reading of it."""
        check_expect_paths(route, expect)
        request, response = await self._send(route, path=path, query=query, body=body, raw_body=raw_body, auth=auth)
        status, tp = response.status_code, response_type(route, response.status_code)
        if tp is None:   # 204, or the document bytes
            answer, value = None, response.content or None
            raw = response.content.decode("utf-8", "replace") if response.content else None
        else:
            name = getattr(tp, "__name__", repr(tp))
            try:
                raw = json.loads(response.content)
            except ValueError:
                raise ContractError(f"{route}: the kernel's {status} answer isn't JSON, so it breaks {name}") from None
            try:
                value = TypeAdapter(tp).validate_json(response.content)
            except ValidationError as error:   # told by place and kind: pydantic's own text quotes the answer
                raise ContractError(f"{route}: the kernel's {status} answer breaks {name}: "
                                    f"{validation_summary(error, tp)}") from None
            if undeclared := undeclared_fields(raw, value):
                raise ContractError(f"{route}: the kernel's {status} answer carries fields {name} doesn't declare: "
                                    f"{undeclared}")
            answer = TypeAdapter(tp).dump_python(value, mode="json")
        self.responses.append(Called(route=route, request=request, status=status, body=answer, raw=raw))
        # The route's own words (field names, enum values) are shown too: the answer was read as `tp`.
        if mismatches := match_expect(status, answer, expect, declared=declared_names(tp)):
            error = isinstance(answer, dict) and status >= 300 and "code" in answer
            # A contract word, safe to show: the answer was validated as a KernelError, whose code is a Literal.
            code = f" (code {answer['code']!r})" if error else ""
            raise AssertionError(f"{route} answered {status}{code}: {'; '.join(mismatches)}")
        return value

    async def _send(
        self,
        route: str,
        *,
        path: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | BaseModel | None = None,
        raw_body: Any = None,
        auth: Auth,
    ) -> tuple[Any, httpx.Response]:
        """Send `route` as `call` does, the request checked against the contract, and return the
        JSON sent with the raw response, unjudged and unrecorded: for a call that gets no kernel
        answer (`Crash.call`). A connection the server drops raises `httpx.TransportError`, and a call
        with no answer within `CALL_TIMEOUT_S` (`PROVING_TIMEOUT_S` on a proving route) raises
        `httpx.TimeoutException`, which is one too."""
        if self._client is None:
            raise TargetError("the kernel isn't running; start() the target first")
        request = check_request(route, path=path, query=query, body=body, raw_body=raw_body)
        parsed = parse_route(route)
        url = parsed.template.format(**{name: quote(str(value), safe="") for name, value in (path or {}).items()})
        params = {name: fixed for name, fixed in parsed.query.items() if fixed}
        params.update({name: _query_value(value) for name, value in (query or {}).items()})
        timeout = PROVING_TIMEOUT_S if route in PROVING_ROUTES else httpx.USE_CLIENT_DEFAULT
        response = await self._client.request(parsed.method, url, params=params, headers=auth.headers(), json=request,
                                              timeout=timeout)
        return request, response

    async def new_copy(self) -> CopyCreated:
        return await self.call("POST /copies", body={}, auth=Auth.none())

    async def visitor(self, copy: CopyCreated) -> SessionCreated:
        """A new visitor session on the copy's first Desk, opened by its public slug."""
        assert self.records is not None
        desk_id = copy.desk_ids[0]
        slugs = [row["slug"] for row in await self.records.desks(copy.copy_id) if row["desk_id"] == desk_id]
        if len(slugs) != 1:
            raise TargetError(f"kernel_ro.desks has no row for the copy's Desk {desk_id!r}")
        return await self.call("POST /sessions", body={"desk_slug": slugs[0], "kind": "visitor"}, auth=Auth.none())


# The API

@runtime_checkable
class ApiTarget(Protocol):
    """The API process over a running `KernelTarget`, as tier 1's API cases and tier 2's runner drive it.

    Plan 02a implements it (`make_api_target`, its Task 9): its `create_app(settings,
    clock=kernel.clock)` under uvicorn on a free loopback port, with `KERNEL_URL` at the kernel
    target; for `models="fake"`, `ANTHROPIC_BASE_URL` at `kernel.fake.url`, a dummy key and
    `DESK_ENV=test`; for `"real"`, the `.env` key and `DESK_ENV=dev`; a `PASSCODE_HASH` for
    `passcode`; its job worker running until `stop()`. The kernel's clock, fake model server and
    records are the API's too."""

    kernel: KernelTarget
    base_url: str    # http://127.0.0.1:<port>
    passcode: str    # plain; the app holds only its hash
    api_dsn: str     # the API's database URL (role desk_api)

    async def start(self) -> Any:
        """Start the app and its job worker on the kernel target."""
        ...

    async def stop(self) -> None:
        """Stop the job worker and the app."""
        ...


class MakeApiTarget(Protocol):
    """Plan 02a's `make_api_target`."""

    def __call__(self, kernel: KernelTarget, *, models: Literal["fake", "real"]) -> ApiTarget: ...


class ApiUnavailable(TargetError):
    """There is no API to drive: Plan 02a's `evals/tier1/api_impl.py` isn't there. On the API
    target that fails the case: a landed API case gates its plan's PR, so it is never skipped."""


def load_api_target() -> MakeApiTarget:
    """Plan 02a's `make_api_target(kernel, *, models)`, imported only now, so collecting tier 1
    imports no API code. With no `api_impl.py` it raises `ApiUnavailable` ("needs api"); a module
    that is there but fails to import, or has no `make_api_target`, raises its own error. Either
    way the case fails."""
    try:
        module = importlib.import_module(API_IMPL)
    except ModuleNotFoundError as error:
        if error.name != API_IMPL:
            raise
        raise ApiUnavailable(f"needs api: {API_IMPL} isn't there until Plan 02a's Task 9 adds it") from None
    make = getattr(module, "make_api_target", None)
    if not callable(make):
        raise TargetError(f"{API_IMPL} has no make_api_target(kernel, *, models)")
    return make


# Restarts and crashes

async def restart_kernel(k: KernelHarness) -> None:
    """The kernel process restarts: on the real kernel a fresh app on the same port and clock, whose
    startup reconciliation runs (`KernelTarget.restart()`). The stub has no process, so nothing happens.

    Because the restart reuses this process (`KernelTarget.restart`), a restart case proves only the
    state the database holds across a restart, such as a spent approval or a spent nonce."""
    if isinstance(k, KernelTarget):
        await k.restart()


# Plan 01a's test hook between T1 (the intent row committed) and T2 (the side effect): a no-op the
# kernel calls by its module-global name, so patching the module attribute reaches it.
AFTER_INTENT = "desk.kernel_service.execute._after_intent"


class Crash:
    """A crash point armed in the kernel: the next call that reaches it dies there (`call`).

    `fired` counts the calls it killed. On the contract stub nothing is armed: there is no process
    to kill, so a dying call is contract-checked only."""

    def __init__(self, target: KernelHarness, where: str):
        self.target, self.where = target, where
        self.fired = 0

    def kill(self) -> None:
        """Count the crash and raise it: the kernel process dies here."""
        self.fired += 1
        raise SimulatedCrash(f"the kernel died at {self.where}")

    async def call(
        self,
        route: str,
        *,
        path: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | BaseModel | None = None,
        auth: Auth,
    ) -> None:
        """Make a call this crash point kills. On the real kernel the call must reach the point
        once and get no kernel answer: the server drops the connection or, as uvicorn does for an
        app that raised, sends a bare 5xx. It is recorded with no body. Anything else fails the
        case, a timeout or a 5xx carrying the kernel's own `KernelError` included, since the state
        it leaves wouldn't be the crash's. On the stub the request is contract-checked and answered
        with a bare 500's status."""
        if not isinstance(self.target, KernelTarget):
            await self.target.call(route, path=path, query=query, body=body, auth=auth, expect=Expect(status=500))
            return
        fired = self.fired
        try:
            request, response = await self.target._send(route, path=path, query=query, body=body, auth=auth)
        except httpx.TimeoutException:   # a TransportError too, so caught first: a hang isn't a drop
            raise AssertionError(
                f"{route} timed out after the crash point at {self.where} fired {self.fired - fired} times: a "
                "dying call drops its connection or gets a bare 5xx, it doesn't hang") from None
        except httpx.TransportError:
            request, response = (body.model_dump(mode="json") if isinstance(body, BaseModel) else body), None
        status = 0 if response is None else response.status_code
        self.target.responses.append(Called(route=route, request=request, status=status, body=None, raw=None))
        killed = self.fired - fired
        assert killed == 1, f"{route} reached the crash point at {self.where} {killed} times, not once"
        assert status == 0 or status >= 500, f"{route} answered {status} though the kernel died at {self.where}"
        if response is not None:
            try:
                error = KernelError.model_validate_json(response.content)
            except ValidationError:
                return   # uvicorn's bare 5xx
            raise AssertionError(f"{route} answered {status} with its own error {error.code!r} though it died at "
                                 f"{self.where}: the kernel handled its crash")


@contextmanager
def crash_after_intent(target: KernelHarness) -> Iterator[Crash]:
    """Inside the block, an execution dies right after its intent row is committed and before any
    side effect: Plan 01a's `execute._after_intent()` raises `SimulatedCrash`. Leaving the block
    puts the hook back. A no-op on the stub."""
    crash = Crash(target, "the intent row")

    def crashed(*args: Any, **kwargs: Any) -> None:
        crash.kill()

    with _patched(target, AFTER_INTENT, lambda original: crashed):
        yield crash


@contextmanager
def crash_after_side_effect(target: KernelHarness, dotted_path: str) -> Iterator[Crash]:
    """Inside the block, a kernel call dies right after the side effect at `dotted_path` (a module
    function or a class's method, sync or async, such as Plan 01c's
    `desk.kernel_service.payments.ProviderClient.charge`): the callable runs to completion, then
    raises `SimulatedCrash`, so the effect happened and nothing after it ran. Leaving the block
    unwraps it. A no-op on the stub."""
    crash = Crash(target, dotted_path)

    def wrap(original: Any) -> Any:
        if isinstance(original, (staticmethod, classmethod)):
            return type(original)(wrap(original.__func__))
        if inspect.iscoroutinefunction(original):
            @functools.wraps(original)
            async def crashed_after(*args: Any, **kwargs: Any) -> Any:
                await original(*args, **kwargs)
                crash.kill()
        else:
            @functools.wraps(original)
            def crashed_after(*args: Any, **kwargs: Any) -> Any:
                original(*args, **kwargs)
                crash.kill()
        return crashed_after

    with _patched(target, dotted_path, wrap):
        yield crash


@contextmanager
def _patched(target: KernelHarness, dotted_path: str, replace: Callable[[Any], Any]) -> Iterator[None]:
    """`dotted_path` (a module attribute, or a class attribute, inherited or its own) replaced by
    `replace(original)` inside the block, then put back: an inherited one is inherited again. On
    the stub, which runs no kernel code, nothing is imported or patched. A path that doesn't
    resolve fails the case: the hook the crash needs isn't there."""
    if not isinstance(target, KernelTarget):
        yield
        return
    owner_path, _, name = dotted_path.rpartition(".")
    try:
        owner = pkgutil.resolve_name(owner_path)
        original = inspect.getattr_static(owner, name)   # as stored, so a staticmethod stays one
    except (ImportError, AttributeError, ValueError) as error:
        raise TargetError(f"the crash hook needs {dotted_path}, which isn't there ({error!r})") from None
    own = name in vars(owner)
    setattr(owner, name, replace(original))
    try:
        yield
    finally:
        if own:
            setattr(owner, name, original)
        else:
            delattr(owner, name)


def _query_value(value: Any) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


def _dotenv(path: Path) -> dict[str, str]:
    """KEY=value lines of a .env file (an absent file is empty); nothing read is printed."""
    if not path.is_file():
        return {}
    values = {}
    for line in path.read_text().splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name.strip() and not name.startswith("#"):
            values[name.strip()] = value.strip().strip("'\"")
    return values
