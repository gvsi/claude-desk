"""The mock payments server's app, and the command that serves it.

The kernel is its only client. Every request must carry the kernel's key in `X-Mockpay-Key`
(compared in constant time; 401 otherwise) and the copy it acts for in `X-Desk-Copy` (400
without one), except the health check, which reads no copy. MCP runs stateless with JSON
responses at `/mcp`; the provider routes sit beside it under `/provider/*`.

`python -m desk.mockpay.server --host 127.0.0.1 --port <port>` reads its key from `MOCKPAY_KEY`,
its database from `MOCKPAY_DATABASE_URL` and its environment from `DESK_ENV`, never from the
command line, and listens on loopback only. It exits with `EXIT_BIND_FAILED` when its port is
taken, and stops once the process that started it (the kernel) is gone.
"""

import argparse
import asyncio
import contextlib
import functools
import hmac
import ipaddress
import json
import os
import socket
import sys
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from typing import Annotated, Any, Literal

import mcp_types as types
import uvicorn
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from desk.db.session import database_url as configured_database_url
from desk.env import is_development
from desk.mockpay.definitions import EXIT_BIND_FAILED, MAX_CENTS, is_placeholder_key
from desk.mockpay.store import Conflict, NotFound, Store, StoreError

KEY_MIN_LENGTH = 32
LOOPBACK = "127.0.0.1"
PORT = 8702
KEY_HEADER = "x-mockpay-key"
COPY_HEADER = "x-desk-copy"
HEALTH_PATH = "/provider/health"
PARENT_CHECK_S = 0.5   # how often the served command checks that the process that started it is there


# Request bodies and tool arguments: exact fields, real integers for money (no bools, floats or
# numeric strings), every amount from 1 cent to MAX_CENTS.

Cents = Annotated[int, Field(ge=1, le=MAX_CENTS)]
Key = Annotated[str, Field(min_length=1, max_length=200)]
Words = Annotated[str, Field(min_length=1, max_length=500)]


class Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class Empty(Strict):
    pass


class CheckoutBody(Strict):
    idempotency_key: Key
    amount_cents: Cents
    title: Words
    customer_id: Key


class ChargeBody(Strict):
    idempotency_key: Key
    amount_cents: Cents
    customer_id: Key
    description: Words


class VoidBody(Strict):
    kind: Literal["checkout", "charge", "refund"]
    idempotency_key: Key


DelayOp = Literal["checkout", "complete", "charge", "refund", "tools"]


class DelayBody(Strict):
    op: DelayOp
    seconds: Annotated[float, Field(ge=0, le=10)]


class SeedCharge(Strict):
    owner_person_id: Key
    amount_cents: Cents
    description: Words
    created_at: AwareDatetime


class SeedBody(Strict):
    charges: Annotated[list[SeedCharge], Field(max_length=100)]


class ListChargesArgs(Strict):
    customer_id: Key


class RefundArgs(Strict):
    charge_id: Key
    amount_cents: Cents
    idempotency_key: Key


def create_app(database_url: str, key: str, *, env: str) -> Starlette:
    """The server for `key` over the `mockpay.*` tables at `database_url`; `env` is `DESK_ENV`.

    Raises `ValueError`, without the key in the message, for a key under 32 characters, or outside
    development (the given or the process's DESK_ENV) for a change-me placeholder such as
    `.env.example`'s."""
    if not isinstance(key, str) or len(key) < KEY_MIN_LENGTH:
        raise ValueError(f"MOCKPAY_KEY must be at least {KEY_MIN_LENGTH} characters")
    development = is_development(env) and is_development()
    if not development and is_placeholder_key(key):
        raise ValueError("MOCKPAY_KEY is a placeholder; outside development make a key of your own "
                         "(openssl rand -hex 32)")

    # the delay switch is a test hook: absent unless both the given and the process's DESK_ENV are development
    payments = MockPayments(Store(database_url), test_hooks=development)
    mcp = Server("mock-payments", on_list_tools=payments.list_tools, on_call_tool=payments.call_tool)
    app = mcp.streamable_http_app(stateless_http=True, json_response=True,
                                  custom_starlette_routes=[Route(HEALTH_PATH, health, methods=["GET"]),
                                                           *payments.routes()])
    serve_mcp = app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        try:
            async with serve_mcp(app):
                yield
        finally:
            await payments.store.close()

    app.router.lifespan_context = lifespan
    app.add_middleware(KernelOnly, key=key)
    return app


async def health(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


def _copy_of(ctx: ServerRequestContext) -> str:
    """The copy an MCP request acts for; `KernelOnly` admitted it only with one."""
    if ctx.request is None:
        raise RuntimeError("an MCP request without its HTTP request")
    return ctx.request.headers[COPY_HEADER]


def _tool_result(structured: dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(structured))],
                                structured_content=structured)


def _tool_error(text: str) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=True)


Handler = Callable[[Request, str], Awaitable[dict[str, Any]]]


def _provider_route(path: str, method: str = "POST") -> Callable[[Handler], Route]:
    """A provider route: the handler gets the request and its copy and returns the JSON answer; an
    invalid body answers 422, a missing object 404 and a refused request 409."""

    def decorate(handler: Handler) -> Route:
        @functools.wraps(handler)
        async def endpoint(request: Request) -> JSONResponse:
            try:
                return JSONResponse(await handler(request, request.headers[COPY_HEADER]))
            except ValidationError:
                return _error(422, "invalid")
            except NotFound:
                return _error(404, "not_found")
            except Conflict:
                return _error(409, "conflict")

        return Route(path, endpoint, methods=[method])

    return decorate


async def _body[M: Strict](request: Request, model: type[M]) -> M:
    return model.model_validate_json(await request.body())


class MockPayments:
    """The server's handlers over one store, and the test delays, which live in memory only."""

    def __init__(self, store: Store, *, test_hooks: bool):
        self.store = store
        self.test_hooks = test_hooks
        self.delays: dict[tuple[str, DelayOp], float] = {}   # (copy, op): seconds each later call waits

    async def _delay(self, copy_id: str, op: DelayOp) -> None:
        """Wait out the copy's test delay for `op`, before the call takes any lock."""
        if seconds := self.delays.get((copy_id, op)):
            await asyncio.sleep(seconds)

    async def list_tools(self, ctx: ServerRequestContext, params: types.PaginatedRequestParams | None
                         ) -> types.ListToolsResult:
        copy_id = _copy_of(ctx)
        await self._delay(copy_id, "tools")
        listed = await self.store.definitions(copy_id)
        return types.ListToolsResult(tools=[types.Tool.model_validate(definition) for definition in listed])

    async def call_tool(self, ctx: ServerRequestContext, params: types.CallToolRequestParams) -> types.CallToolResult:
        """A tool call; bad arguments, a missing charge or a refused refund come back as `isError`."""
        copy_id = _copy_of(ctx)
        arguments = params.arguments or {}
        try:
            if params.name == "list_charges":
                args = ListChargesArgs.model_validate(arguments)
                return _tool_result({"charges": await self.store.list_charges(copy_id, args.customer_id)})
            if params.name == "create_refund":
                args = RefundArgs.model_validate(arguments)
                await self._delay(copy_id, "refund")
                return _tool_result(await self.store.create_refund(copy_id, args.charge_id, args.amount_cents,
                                                                   args.idempotency_key))
            return _tool_error(f"There is no tool named {params.name!r}.")
        except ValidationError:
            return _tool_error("The arguments don't match the tool's input schema.")
        except StoreError as refused:
            return _tool_error(str(refused))

    def routes(self) -> list[Route]:
        store, delay = self.store, self._delay

        @_provider_route("/provider/checkouts")
        async def create_checkout(request: Request, copy_id: str) -> dict[str, Any]:
            body = await _body(request, CheckoutBody)
            await delay(copy_id, "checkout")
            return {"checkout_id": await store.create_checkout(copy_id, body.idempotency_key, body.amount_cents,
                                                               body.title, body.customer_id)}

        @_provider_route("/provider/checkouts/{checkout_id}/complete")
        async def complete_checkout(request: Request, copy_id: str) -> dict[str, Any]:
            await _body(request, Empty)
            await delay(copy_id, "complete")
            charge_id = await store.complete_checkout(copy_id, request.path_params["checkout_id"])
            return {"charge_id": charge_id, "state": "succeeded"}

        @_provider_route("/provider/checkouts/{checkout_id}/cancel")
        async def cancel_checkout(request: Request, copy_id: str) -> dict[str, Any]:
            await _body(request, Empty)
            return await store.cancel_checkout(copy_id, request.path_params["checkout_id"])

        @_provider_route("/provider/charges")
        async def create_charge(request: Request, copy_id: str) -> dict[str, Any]:
            body = await _body(request, ChargeBody)
            await delay(copy_id, "charge")
            return {"charge_id": await store.create_charge(copy_id, body.idempotency_key, body.amount_cents,
                                                           body.customer_id, body.description)}

        @_provider_route("/provider/void")
        async def void(request: Request, copy_id: str) -> dict[str, Any]:
            body = await _body(request, VoidBody)
            return await store.void(copy_id, body.kind, body.idempotency_key)

        @_provider_route("/provider/seed")
        async def seed(request: Request, copy_id: str) -> dict[str, Any]:
            body = await _body(request, SeedBody)
            rows = [(c.owner_person_id, c.amount_cents, c.description, c.created_at) for c in body.charges]
            return {"charge_ids": await store.seed(copy_id, rows)}

        @_provider_route("/provider/charges/{charge_id}", method="GET")
        async def read_charge(request: Request, copy_id: str) -> dict[str, Any]:
            return await store.charge(copy_id, request.path_params["charge_id"])

        @_provider_route("/provider/tool_definitions/{name}/simulate_change")
        async def simulate_change(request: Request, copy_id: str) -> dict[str, Any]:
            await _body(request, Empty)
            return {"definition": await store.simulate_change(copy_id, request.path_params["name"])}

        @_provider_route("/provider/test/delay")
        async def set_delay(request: Request, copy_id: str) -> dict[str, Any]:
            body = await _body(request, DelayBody)
            if body.seconds:
                self.delays[(copy_id, body.op)] = body.seconds
            else:
                self.delays.pop((copy_id, body.op), None)
            return {}

        routes = [create_checkout, complete_checkout, cancel_checkout, create_charge, read_charge, void, seed,
                  simulate_change]
        return routes + [set_delay] if self.test_hooks else routes


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


class KernelOnly:
    """Admits a request only with the kernel's key, and with a copy unless it is the health check."""

    def __init__(self, app: ASGIApp, key: str):
        self.app = app
        self._key = key.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":   # nothing here speaks websockets: refuse before accepting
            await send({"type": "websocket.close", "code": 1008})
            return
        headers = Headers(scope=scope)
        keys = headers.getlist(KEY_HEADER)
        given = keys[0].encode("latin-1") if len(keys) == 1 else b""
        if not hmac.compare_digest(given, self._key):
            await _error(401, "auth")(scope, receive, send)
            return
        copies = headers.getlist(COPY_HEADER)
        if scope["path"] != HEALTH_PATH and (len(copies) != 1 or not copies[0].strip()):
            await _error(400, "copy")(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _uvicorn_config(app: ASGIApp, host: str, port: int, **options) -> uvicorn.Config:
    # No access log or server header; the paths carry no secrets, but nothing reads them either.
    return uvicorn.Config(app, host=host, port=port, lifespan="on", access_log=False, server_header=False,
                          proxy_headers=False, **options)


@contextlib.contextmanager
def serve_in_thread(app: ASGIApp, host: str = LOOPBACK) -> Iterator[str]:
    """Serve `app` on a free port of `host` in a daemon thread, for tests and in-process eval
    targets; yields the base URL and stops the server on exit."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind((host, 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(_uvicorn_config(app, host, port, log_config=None))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, name=f"mockpay-{port}", daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    try:
        while not server.started:
            if not thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("the mock payments server didn't start")
            time.sleep(0.01)
        yield f"http://{host}:{port}"
    finally:
        server.should_exit = True
        thread.join(10)
        sock.close()


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m desk.mockpay.server",
                                     description="The mock payments server (no money moves).")
    parser.add_argument("--host", default=LOOPBACK)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args(argv)
    if not _loopback(args.host):
        parser.error("the mock payments server listens on loopback only")
    try:
        app = create_app(configured_database_url("MOCKPAY"), os.environ.get("MOCKPAY_KEY", ""),
                         env=os.environ.get("DESK_ENV", ""))
    except (ValueError, RuntimeError) as refused:
        sys.exit(f"mock payments server: {refused}")
    sock = _bound_socket(args.host, args.port)
    server = uvicorn.Server(_uvicorn_config(app, args.host, args.port))
    _stop_with_parent(server)
    server.run(sockets=[sock])


def _bound_socket(host: str, port: int) -> socket.socket:
    """The server's socket, bound before uvicorn starts, so that a port another process holds exits
    with EXIT_BIND_FAILED, which the kernel tells apart from a crash."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # as uvicorn binds; a listener still refuses it
    try:
        sock.bind((host, port))
    except OSError as error:
        sock.close()
        shown = f"[{host}]" if family == socket.AF_INET6 else host
        _say(f"can't listen on {shown}:{port}: {error.strerror or error}")
        sys.exit(EXIT_BIND_FAILED)
    return sock


def _say(message: str) -> None:
    """One line on stderr, written straight to its descriptor and never raising, so that neither the
    stop nor the exit code depends on it. A closed terminal fails every write: a print would raise,
    or leave the line buffered for the interpreter's last flush, which then fails and exits 120."""
    with contextlib.suppress(OSError):
        os.write(2, f"mock payments server: {message}\n".encode())


def _stop_with_parent(server: uvicorn.Server) -> None:
    """Stop `server` once the process that started it is gone, which re-parents it. The kernel runs
    the server in a session of its own, so a kernel that dies without its shutdown (SIGKILL, a
    closed terminal) would otherwise leave it on the port, answering with the old key."""
    parent = os.getppid()

    def watch() -> None:
        while not server.should_exit:
            if os.getppid() != parent:
                server.should_exit = True   # before the message: a closed terminal fails it
                _say("the process that started it is gone; stopping")
                return
            time.sleep(PARENT_CHECK_S)

    threading.Thread(target=watch, name="mockpay-parent", daemon=True).start()


if __name__ == "__main__":
    main()
