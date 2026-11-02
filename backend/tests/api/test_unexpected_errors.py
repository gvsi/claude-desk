"""An unexpected error in a route is logged by its type and route only (#352): its message and traceback can carry
owner data, such as a read's content or a model's text. Its answer and the exception's path to the server don't change:
a 500 `{"error": "internal"}` before the response starts, a stream cut off where it was after."""

import asyncio
import logging

import httpx
import pytest

from desk.api import sse
from desk.api.routes import owner as owner_routes
from tests.api.test_public_chat import Stream, cookie, events_path, new_slug, open_session
from tests.api.test_take_over import OWNER_IP, mode_change, new_chat

PRIVATE = "Dana's refund note: card ending 4242"


def logged(caplog) -> str:
    """Everything the records say, as a handler would write it, tracebacks included."""
    formatter = logging.Formatter("%(name)s %(message)s")
    return "\n".join(formatter.format(record) for record in caplog.records)


def unexpected(caplog) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.name == "desk.api.unexpected_errors"]


async def test_an_unexpected_error_answers_500_and_logs_only_its_type_and_route(api, browser, fake, kernel_http,
                                                                               monkeypatch, caplog):
    chat = await new_chat(api, browser, kernel_http, fake)
    assert (await mode_change(chat, "takeover", 0)).status_code == 200

    async def failing_emit(conn, ids, event):
        raise RuntimeError(PRIVATE)

    monkeypatch.setattr(owner_routes, "emit", failing_emit)
    caplog.set_level(logging.DEBUG)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api, client=(OWNER_IP, 50000),
                                                               raise_app_exceptions=False),
                                 base_url="https://desk.test", cookies=chat.owner.cookies) as owner:
        failed = await owner.post(chat.path("typing"), json={"generation": 1})

    assert (failed.status_code, failed.content) == (500, b'{"error":"internal"}')
    assert unexpected(caplog) == ["unexpected RuntimeError on POST /api/owner/conversations/{session_id}/typing"]
    assert PRIVATE not in logged(caplog)
    assert chat.session_id not in "\n".join(unexpected(caplog))       # the route's template, never its values


async def test_a_stream_that_fails_part_way_logs_only_its_type_and_route(api, browser, fake, kernel_http,
                                                                         monkeypatch, caplog):
    slug = await new_slug(kernel_http, fake)
    _, token, _ = await open_session(api, browser, slug)

    async def failing_wait(self, timeout: float) -> bool:
        raise RuntimeError(PRIVATE)

    monkeypatch.setattr(sse.Wakeup, "wait", failing_wait)
    caplog.set_level(logging.DEBUG)
    stream = Stream(api, events_path(slug), headers=[cookie(token)])
    await stream.open()
    assert stream.status == 200
    # The error still reaches the server unchanged, which cuts the stream off where it was, as before.
    with pytest.raises(Exception) as raised:
        await asyncio.wait_for(stream._task, 5)
    assert "refund note" in repr(raised.value.exceptions if isinstance(raised.value, ExceptionGroup) else raised.value)

    assert unexpected(caplog) == ["unexpected RuntimeError on GET /api/public/desks/{slug}/events"]
    assert PRIVATE not in logged(caplog)


async def test_the_servers_own_record_of_an_app_error_drops_the_exception(api, caplog):
    """uvicorn logs an exception the app raised as "Exception in ASGI application" with the exception attached
    (uvicorn/protocols/http/h11_impl.py and httptools_impl.py). Building the app keeps that line and drops the
    exception; the API's own line has already named its type and route. Its other records keep their exceptions."""
    caplog.set_level(logging.DEBUG)
    server = logging.getLogger("uvicorn.error")
    server.error("Exception in ASGI application\n", exc_info=RuntimeError(PRIVATE))
    assert [record.getMessage() for record in caplog.records] == ["Exception in ASGI application\n"]
    assert PRIVATE not in logged(caplog)

    # A traceback that also names a link has had its token redacted into formatted text by then: dropped too.
    caplog.clear()
    server.error("Exception in ASGI application\n", exc_info=RuntimeError(f"{PRIVATE} at /api/d/a-link-token"))
    assert [(record.exc_info, record.exc_text) for record in caplog.records] == [(None, None)]
    assert PRIVATE not in logged(caplog)

    caplog.clear()
    server.error("Exception in 'lifespan' protocol\n", exc_info=RuntimeError("the kernel refused to start"))
    assert "the kernel refused to start" in logged(caplog)
