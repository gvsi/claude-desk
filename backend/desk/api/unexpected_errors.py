"""An unexpected error in a route is logged by its type and route only (#352).

An exception no handler answers can carry owner data in its message or its traceback: a read's content, a model's
text. The app's `Exception` handler answers it `500 {"error": "internal"}`, and Starlette then raises it on to the
server, which logs it in full ("Exception in ASGI application", with the exception attached).

`UnexpectedErrors`, the app's outermost middleware, logs such an exception as "unexpected <type> on <method> <route>",
naming the route by its template, never its values, and raises it on unchanged. Answers stay the same, and so does
the exception's path to the server: a 500 before the response starts, a stream cut off where it was after.
`quiet_server_errors()` then keeps the server's own line about it and drops the exception attached to that line.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

SERVER_LOGGER = "uvicorn.error"
APP_ERROR = "Exception in ASGI application"   # uvicorn's line for an exception the app raised


class UnexpectedErrors:
    """Logs an exception the app raises by its type and route, then raises it on unchanged (module docstring)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        except Exception as error:
            route = getattr(scope.get("route"), "path", None) or "an unmatched path"
            logger.error("unexpected %s on %s %s", _innermost(error).__name__, scope.get("method", "?"), route)
            raise


def _innermost(error: BaseException) -> type:
    """The error's type, through any groups of a single error that task groups wrap it in."""
    while isinstance(error, BaseExceptionGroup) and len(error.exceptions) == 1:
        error = error.exceptions[0]
    return type(error)


class _ServerAppErrors(logging.Filter):
    """On the server's logger: its line about an exception the app raised keeps its words and drops the exception."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.exc_info is not None and str(record.msg).startswith(APP_ERROR):
            record.exc_info = record.exc_text = None
        return True


def quiet_server_errors() -> None:
    """Drop the exception from the server's line about one the app raised; once, however often it is called."""
    server = logging.getLogger(SERVER_LOGGER)
    if not any(isinstance(existing, _ServerAppErrors) for existing in server.filters):
        server.addFilter(_ServerAppErrors())
