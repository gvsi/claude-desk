"""A local stand-in for the Messages API, so tier 1 runs the kernel and the API with no model calls.

`FakeAnthropic` serves `POST /v1/messages` on a free loopback port. A case scripts the replies a
model gives (`script`, `default`), and the server answers each request from the script for its
model, or fails it with 500 and records it as unscripted; `check()` fails on an unscripted call
and on a scripted reply no request used. It keeps each request body for the case to check, and
never the request's headers, so no key it was sent is stored.
"""

import asyncio
import inspect
import json
import secrets
import socket
import threading
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

# Replies


@dataclass(frozen=True)
class Usage:
    """The token counts a reply reports."""

    input_tokens: int = 100
    output_tokens: int = 20
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0

    def as_json(self) -> dict[str, int]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
        }


@dataclass(frozen=True)
class Json:
    """A text block holding `obj` as JSON, exactly as given: a wrong type reaches the client as sent."""

    obj: Any
    usage: Usage = field(default_factory=Usage)


@dataclass(frozen=True)
class Text:
    """A text block."""

    text: str
    usage: Usage = field(default_factory=Usage)


@dataclass(frozen=True)
class ToolUse:
    """A `tool_use` block; the reply stops for the tool."""

    name: str
    input: Any
    usage: Usage = field(default_factory=Usage)


class Turn:
    """Several blocks in one reply (`Text`, `Json` and `ToolUse`); it stops for a tool if any is a `ToolUse`."""

    def __init__(self, *blocks: "Json | Text | ToolUse", usage: Usage | None = None):
        if not blocks or not all(isinstance(block, (Json, Text, ToolUse)) for block in blocks):
            raise ValueError("a Turn holds one or more Text, Json or ToolUse blocks")
        self.blocks: tuple[Json | Text | ToolUse, ...] = blocks
        self.usage = usage or Usage()

    def __repr__(self) -> str:
        return f"Turn{self.blocks!r}"


@dataclass(frozen=True)
class Refusal:
    """No content, stopped with `stop_reason: "refusal"`."""

    usage: Usage = field(default_factory=Usage)


@dataclass(frozen=True)
class HttpError:
    """The API's error answer at `status`, as the SDK raises it (500 → `InternalServerError`)."""

    status: int

    def __post_init__(self) -> None:
        if not 400 <= self.status <= 599:
            raise ValueError("an HttpError is a 4xx or 5xx status")


@dataclass(frozen=True)
class Sleep:
    """Wait `seconds` before answering with `then` (for timeouts, and requests that overlap)."""

    seconds: float
    then: "Reply"


Reply = Json | Text | ToolUse | Turn | Refusal | HttpError | Sleep

# The API's error type for each status; any other 5xx is an api_error.
ERROR_TYPES = {
    400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
    413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error",
}


# The server


class _Script:
    """A model's scripted replies, used in order."""

    def __init__(self, replies: list[Reply], repeat_last: bool):
        self.replies, self.repeat_last = replies, repeat_last
        self.last: Reply | None = None

    def next(self) -> Reply | None:
        if self.replies:
            self.last = self.replies.pop(0)
            return self.last
        return self.last if self.repeat_last else None


@dataclass(frozen=True)
class _Callback:
    model: str
    schema: str | None
    callback: Callable[[dict], Any]
    loop: asyncio.AbstractEventLoop | None


class FakeAnthropic:
    """The fake Messages API. Script it, start it, point a client's base URL at `url`."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scripts: dict[tuple[str, str | None], _Script] = {}
        self._defaults: dict[tuple[str, str | None], Reply] = {}
        self._calls: list[dict] = []
        self._unscripted: list[dict] = []
        self._callbacks: list[_Callback] = []
        self._errors: list[BaseException] = []
        self._server: LoopbackServer | None = None

    # Lifecycle

    def start(self) -> "FakeAnthropic":
        app = Starlette(routes=[
            Route("/v1/messages", self._messages, methods=["POST"]),
            Route("/{path:path}", self._elsewhere, methods=["GET", "POST", "PUT", "PATCH", "DELETE"]),
        ])
        self._server = LoopbackServer(app, name="fake model server", graceful_shutdown_s=0.5)
        self._server.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.stop()
            self._server = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("the fake model server isn't running; start() it first")
        return self._server.url

    # Scripts

    def script(self, model: str, *replies: Reply, repeat_last: bool = False, schema: str | None = None) -> None:
        """The replies `model`'s next requests get, in order, replacing any earlier script for the
        same model and schema; with `repeat_last`, the last one answers every request after it.

        `schema` names a structured-output schema (the `title` of `output_config.format`'s JSON
        schema): a request goes to the script for its model and schema, else to its model's
        schema-less script. A script that has run out hands over to `default`."""
        if not replies:
            raise ValueError("a script needs at least one reply")
        with self._lock:
            self._scripts[(model, schema)] = _Script(list(replies), repeat_last)

    def default(self, model: str, reply: Reply, schema: str | None = None) -> None:
        """The reply `model` gives (for requests with `schema`, if given) once its script has run out."""
        with self._lock:
            self._defaults[(model, schema)] = reply

    def on_request(self, model: str, callback: Callable[[dict], Any], schema: str | None = None) -> None:
        """Run `callback(body)` as each request for `model` arrives, before its reply is chosen.

        A coroutine function runs on the event loop that registered it, so it can use the case's
        own clients while the request waits; a plain function runs in a worker thread. A callback
        that raises fails the request with 500, and `check()` raises its error."""
        try:
            loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        with self._lock:
            self._callbacks.append(_Callback(model, schema, callback, loop))

    def calls(self, model: str | None = None, schema: str | None = None) -> list[dict]:
        """Each request body so far, oldest first, optionally only those for `model` or with `schema`."""
        with self._lock:
            return [
                json.loads(json.dumps(body)) for body in self._calls
                if model in (None, body.get("model")) and schema in (None, schema_of(body))
            ]

    def unscripted(self) -> list[dict]:
        """The bodies of requests no script answered (each got a 500), oldest first."""
        with self._lock:
            return [json.loads(json.dumps(body)) for body in self._unscripted]

    def unused(self) -> dict[tuple[str, str | None], int]:
        """How many scripted replies no request has used yet, by model and schema. A default is
        never counted: it answers only if a request comes."""
        with self._lock:
            return {key: len(script.replies) for key, script in sorted(self._scripts.items(), key=_by_model)
                    if script.replies}

    def check(self) -> None:
        """Fail when any request went unscripted, a scripted reply was never used or an
        `on_request` callback failed: every model call a case causes is one it scripted, and every
        reply it scripted is one a call it expects used."""
        problems = []
        if unscripted := self.unscripted():
            models = ", ".join(str(body.get("model")) for body in unscripted)
            problems.append(f"{len(unscripted)} unscripted model calls reached the fake model server ({models})")
        if unused := self.unused():
            left = ", ".join(f"{model}{f' with schema {schema}' if schema else ''}: {n}"
                             for (model, schema), n in unused.items())
            problems.append(f"{sum(unused.values())} scripted replies were never used ({left})")
        with self._lock:
            problems += [f"an on_request callback failed: {error!r}" for error in self._errors]
        if problems:
            raise AssertionError("; ".join(problems))

    # Serving

    def _next(self, model: str, schema: str | None) -> Reply | None:
        """The reply for a request: from the script for its model and schema, else from its model's
        schema-less one; within each, the next scripted reply, else the default. Holds the lock."""
        for key in ([(model, schema)] if schema is not None else []) + [(model, None)]:
            script = self._scripts.get(key)
            if script and (reply := script.next()) is not None:
                return reply
            if key in self._defaults:
                return self._defaults[key]
        return None

    async def _run_callbacks(self, model: str, schema: str | None, body: dict) -> bool:
        """Run the callbacks matching the request; False when one failed."""
        with self._lock:
            callbacks = [cb for cb in self._callbacks if cb.model == model and cb.schema in (None, schema)]
        for cb in callbacks:
            sent = json.loads(json.dumps(body))
            try:
                if not inspect.iscoroutinefunction(cb.callback):
                    await asyncio.to_thread(cb.callback, sent)
                elif cb.loop is None or cb.loop is asyncio.get_running_loop():
                    await cb.callback(sent)
                else:
                    await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(cb.callback(sent), cb.loop))
            except Exception as error:
                with self._lock:
                    self._errors.append(error)
                return False
        return True

    async def _elsewhere(self, request: Request) -> Response:
        """Any other endpoint is an unscripted call: kept (its body and path) and failed with 500."""
        try:
            body = await request.json()
        except ValueError:
            body = None
        kept = {**(body if isinstance(body, dict) else {}), "method": request.method, "path": request.url.path}
        with self._lock:
            self._calls.append(kept)
            self._unscripted.append(kept)
        return _error(500, f"unscripted call to {request.url.path}: the fake model server serves only /v1/messages")

    async def _messages(self, request: Request) -> Response:
        body = await request.json()
        model, schema = body.get("model"), schema_of(body)
        with self._lock:
            self._calls.append(body)
        if not await self._run_callbacks(model, schema, body):
            return _error(500, "an on_request callback failed")
        with self._lock:
            reply = self._next(model, schema)
            if reply is None:
                self._unscripted.append(body)
        if reply is None:
            return _error(500, f"unscripted call to {model!r}: the fake model server has no reply for it")
        while isinstance(reply, Sleep):
            await asyncio.sleep(reply.seconds)
            reply = reply.then
        if isinstance(reply, HttpError):
            return _error(reply.status, "scripted error")
        message = _message(reply, model)
        if body.get("stream") is True:
            return StreamingResponse(_stream(message), media_type="text/event-stream")
        return JSONResponse(message)


def _by_model(item: tuple[tuple[str, str | None], Any]) -> tuple[str, str]:
    (model, schema), _ = item
    return model, schema or ""


def schema_of(body: dict) -> str | None:
    """The `title` of a request's structured-output schema (`output_config.format.schema`), if any."""
    node: Any = body
    for key in ("output_config", "format", "schema", "title"):
        node = node.get(key) if isinstance(node, dict) else None
    return node if isinstance(node, str) else None


def _error(status: int, message: str) -> JSONResponse:
    kind = ERROR_TYPES.get(status, "api_error" if status >= 500 else "invalid_request_error")
    return JSONResponse({"type": "error", "error": {"type": kind, "message": message}}, status_code=status)


def _message(reply: Reply, model: str) -> dict:
    """The Messages API's answer for a reply, naming the model the request named."""
    blocks = () if isinstance(reply, Refusal) else reply.blocks if isinstance(reply, Turn) else (reply,)
    if isinstance(reply, Refusal):
        stop, details = "refusal", {"type": "refusal", "category": None, "explanation": None}
    else:
        stop, details = ("tool_use" if any(isinstance(block, ToolUse) for block in blocks) else "end_turn"), None
    return {
        "id": f"msg_{secrets.token_hex(12)}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [_block(block) for block in blocks],
        "stop_reason": stop,
        "stop_sequence": None,
        "stop_details": details,
        "usage": reply.usage.as_json(),
    }


def _block(block: Json | Text | ToolUse) -> dict:
    if isinstance(block, Json):
        return {"type": "text", "text": json.dumps(block.obj)}
    if isinstance(block, Text):
        return {"type": "text", "text": block.text}
    return {"type": "tool_use", "id": f"toolu_{secrets.token_hex(12)}", "name": block.name, "input": block.input}


async def _stream(message: dict) -> AsyncIterator[str]:
    """The message as the documented server-sent events: text in `text_delta`s, tool input in
    `input_json_delta`s, each split in pieces, and the usage on `message_start` and `message_delta`."""
    usage = message["usage"]
    yield _event("message_start", {"message": {
        **message, "content": [], "stop_reason": None, "stop_sequence": None, "stop_details": None,
        "usage": {**usage, "output_tokens": 1},
    }})
    yield _event("ping", {})
    for index, block in enumerate(message["content"]):
        if block["type"] == "text":
            yield _event("content_block_start", {"index": index, "content_block": {"type": "text", "text": ""}})
            for piece in _pieces(block["text"]):
                yield _event("content_block_delta", {"index": index, "delta": {"type": "text_delta", "text": piece}})
        else:
            yield _event("content_block_start", {"index": index, "content_block": {**block, "input": {}}})
            for piece in _pieces(json.dumps(block["input"])):
                delta = {"type": "input_json_delta", "partial_json": piece}
                yield _event("content_block_delta", {"index": index, "delta": delta})
        yield _event("content_block_stop", {"index": index})
    yield _event("message_delta", {
        "delta": {key: message[key] for key in ("stop_reason", "stop_sequence", "stop_details")}, "usage": usage,
    })
    yield _event("message_stop", {})


def _event(kind: str, data: dict) -> str:
    return f"event: {kind}\ndata: {json.dumps({'type': kind, **data})}\n\n"


def _pieces(text: str, count: int = 3) -> list[str]:
    """`text` in up to `count` pieces, so a client has to put deltas back together."""
    size = max(1, -(-len(text) // count))
    return [text[start:start + size] for start in range(0, len(text), size)]


class LoopbackServer:
    """An ASGI app under uvicorn in a daemon thread, listening on 127.0.0.1.

    `port=0` takes a free port; passing the port it had lets a restarted app keep its address.
    Startup and shutdown run the app's lifespan; a startup that fails raises with the cause."""

    def __init__(self, app: Any, *, port: int = 0, name: str = "server", graceful_shutdown_s: float = 2.0):
        self.app, self.name, self.port = app, name, port
        self._graceful_shutdown_s = graceful_shutdown_s
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._error: BaseException | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout_s: float = 30.0) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # The socket is this method's to close until the thread has started; from then on `_run`
        # closes it. A Thread.start() that raises never ran `_run`, unless the start was interrupted.
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", self.port))
            self.port = sock.getsockname()[1]
            config = uvicorn.Config(
                self.app, lifespan="on", loop="asyncio", http="h11", ws="none", log_config=None,
                log_level="warning", access_log=False, timeout_graceful_shutdown=self._graceful_shutdown_s,
            )
            self._server, self._error = uvicorn.Server(config), None
            self._thread = threading.Thread(target=self._run, args=(self._server, sock), name=self.name, daemon=True)
            self._thread.start()
        except BaseException:   # a port in use, say: close it, so a retry on another port leaves none open
            self._server = self._thread = None   # nothing started, so a later stop() does nothing
            sock.close()
            raise
        deadline = time.monotonic() + timeout_s
        while not self._server.started:
            if not self._thread.is_alive():
                cause = f" ({self._error!r})" if self._error else ""
                raise RuntimeError(f"the {self.name} failed to start{cause}; its log above has the cause")
            if time.monotonic() > deadline:
                self.stop()
                raise TimeoutError(f"the {self.name} didn't start within {timeout_s} s")
            time.sleep(0.01)

    def _run(self, server: uvicorn.Server, sock: socket.socket) -> None:
        try:
            server.run(sockets=[sock])
        except BaseException as error:   # SystemExit when the app's lifespan startup fails
            self._error = error
        finally:
            sock.close()

    def stop(self, timeout_s: float = 30.0) -> None:
        if self._server is None or self._thread is None:
            return
        self._server.should_exit = True
        self._thread.join(timeout_s)
        if self._thread.is_alive():
            self._server.force_exit = True
            self._thread.join(5)
        if self._thread.is_alive():
            raise TimeoutError(f"the {self.name} didn't stop within {timeout_s} s")
        self._server = self._thread = None


__all__ = [
    "FakeAnthropic", "HttpError", "Json", "LoopbackServer", "Refusal", "Reply", "Sleep", "Text", "ToolUse", "Turn",
    "Usage", "schema_of",
]
