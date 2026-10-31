"""Link tokens out of every log line (Plan 02b, "Credentials at rest").

A single-use link's token is its only credential, and it travels in a path: the API's `/api/d/{token}` and
`/api/pay/{token}` (with `/complete` and `/cancel`), the kernel's `/document_links/{token}` and
`/payment_links/{token}` routes, and the `/pay/{token}` page a link card opens. `install()` wraps the process's log
record factory, so every record, from any logger (uvicorn's access log and httpx's request lines included), has the
token in each such path replaced with `<redacted>` as it is made, before a filter, handler or formatter sees it.

A record's arguments are redacted one by one and keep their shape, since uvicorn's access formatter unpacks them; a
token that only the message and its arguments form together is redacted in the formatted message, and one in an
exception's traceback or a stack in the formatted text. A record that can't be checked is replaced by a fixed line.
Fields added with `extra=` are set after the record is made, so they aren't covered: the API never logs a path there.
"""

import logging
import re
from collections.abc import Mapping
from typing import Any

REDACTED = "<redacted>"
_TOKEN_PATH = re.compile(r"(/api/d/|/pay/|/document_links/|/payment_links/)[^/?#\s\"'<>\\]+")
_UNCHECKED = "a log record that couldn't be checked for link tokens was replaced"
_MARK = "_desk_redacts_link_tokens"


def redact(text: str) -> str:
    """`text` with the token in each link path replaced."""
    return _TOKEN_PATH.sub(lambda found: found.group(1) + REDACTED, text)


def _redacted(value: Any) -> Any:
    """The value unchanged unless its text holds a link token, else that text redacted."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = value if isinstance(value, str) else str(value)
    clean = redact(text)
    return value if clean == text else clean


def redact_record(record: logging.LogRecord) -> logging.LogRecord:
    """The record with every link token it carries redacted (module docstring)."""
    try:
        if isinstance(record.args, Mapping):
            record.args = {key: _redacted(value) for key, value in record.args.items()}
        elif isinstance(record.args, tuple):
            record.args = tuple(_redacted(value) for value in record.args)
        message = record.getMessage()
        if redact(message) != message:
            record.msg, record.args = redact(message), ()
        if isinstance(record.exc_info, tuple) and record.exc_info[0] is not None:
            traceback = logging.Formatter().formatException(record.exc_info)
            if redact(traceback) != traceback:      # formatters use exc_text when it is set, and exc_info is gone
                record.exc_info, record.exc_text = None, redact(traceback)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
    except Exception:
        record.msg, record.args = _UNCHECKED, ()
        record.exc_info = record.exc_text = record.stack_info = None
    return record


def install() -> None:
    """Redact link tokens from every log record the process makes from now on; once, however often it is called."""
    current = logging.getLogRecordFactory()
    if getattr(current, _MARK, False):
        return

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        return redact_record(current(*args, **kwargs))

    setattr(factory, _MARK, True)
    logging.setLogRecordFactory(factory)
