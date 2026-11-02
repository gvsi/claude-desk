"""The demo visitor's way to the app in tests: the app itself, reached in process from the loopback address with no
forwarded address, each answer streamed as the app sends it. httpx's own in-process transport waits for a whole body,
which an event stream never ends, so a demo visitor's run needs this one."""

import asyncio
import contextlib
from collections.abc import AsyncIterator

import httpx
from fastapi import FastAPI

LOOPBACK_PEER = ("127.0.0.1", 50002)


class _Body(httpx.AsyncByteStream):
    """A response body as the app sends it, chunk by chunk; closing it hangs up, as a browser leaving does."""

    def __init__(self, chunks: asyncio.Queue, hang_up: asyncio.Event, task: asyncio.Task):
        self.chunks, self.hang_up, self.task = chunks, hang_up, task

    async def __aiter__(self) -> AsyncIterator[bytes]:
        while (chunk := await self.chunks.get()) is not None:
            yield chunk

    async def aclose(self) -> None:
        self.hang_up.set()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(self.task), 5)


class StreamingLoopback(httpx.AsyncBaseTransport):
    """The app itself, as the demo visitor reaches the public visitor endpoints from 127.0.0.1 with no forwarded
    address, each answer streamed as the app sends it, recording each request sent through it."""

    def __init__(self, app: FastAPI):
        self.app = app
        self.sent: list[httpx.Request] = []
        self.tasks: list[asyncio.Task] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        self.sent.append(request)
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": request.method,
                 "scheme": request.url.scheme, "path": request.url.path,
                 "raw_path": request.url.raw_path.split(b"?")[0], "query_string": request.url.query,
                 "root_path": "", "server": (request.url.host, request.url.port or 80), "client": LOOPBACK_PEER,
                 "headers": [(name.lower(), value) for name, value in request.headers.raw]}
        started: asyncio.Future = asyncio.get_running_loop().create_future()
        chunks: asyncio.Queue = asyncio.Queue()
        hang_up = asyncio.Event()
        requested = False

        async def receive() -> dict:
            nonlocal requested
            if not requested:
                requested = True
                return {"type": "http.request", "body": body, "more_body": False}
            await hang_up.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.start":
                started.set_result((message["status"], message.get("headers", [])))
            elif message["type"] == "http.response.body":
                if message.get("body"):
                    chunks.put_nowait(message["body"])
                if not message.get("more_body", False):
                    chunks.put_nowait(None)

        async def run() -> None:
            try:
                await self.app(scope, receive, send)
            except BaseException as error:
                if not started.done():
                    started.set_exception(error if isinstance(error, Exception) else RuntimeError("app stopped"))
                raise
            finally:
                chunks.put_nowait(None)

        task = asyncio.create_task(run())
        self.tasks.append(task)
        status, headers = await started
        return httpx.Response(status, headers=headers, stream=_Body(chunks, hang_up, task), request=request)

    def paths(self) -> list[tuple[str, str]]:
        return [(request.method, request.url.path) for request in self.sent]
