"""Database errors in log records: their class, SQLSTATE and constraint name, never their text.

The kernel's engines hide bound values (`hide_parameters`), but Postgres writes values into its
own messages: a message can quote the input it couldn't read (`invalid input syntax for type
...: "..."`), and a constraint violation's DETAIL can hold the failing row ("Failing row contains
(...)") or key ("Key (token)=(...)"), which Postgres leaves out only while row-level security
applies to the table. A kernel row can hold a verification code or a link token, so a log record
must never carry that text.

`install()` wraps the process's log record factory, once, so every record is checked as it is
made, whichever logger or handler it goes to. A record whose exception, or an exception it was
raised from or during, is a database error (SQLAlchemy's `StatementError`, `DBAPIError` among
them, or the driver's own `psycopg.Error`) is logged with that chain redacted: each exception is
shown by its class alone, a database error with its SQLSTATE and constraint name too
(`describe`), and the traceback keeps its frames, which hold code, not values. A database error
passed as the message or an argument is written as `describe` writes it.
"""

import logging
from collections.abc import Iterator, Mapping
from typing import Any

import psycopg
from sqlalchemy.exc import StatementError

INSTALLED = "_desk_redacts_database_errors"     # marks the factory `install` made


class RedactedError(Exception):
    """An exception of a chain that holds a database error, as a log record shows it."""


def is_database_error(exc: BaseException) -> bool:
    return isinstance(exc, (StatementError, psycopg.Error))


def describe(exc: BaseException) -> str:
    """`<class> sqlstate=<SQLSTATE> constraint=<name>`, with `-` for what the error doesn't say."""
    driver = exc.orig if isinstance(exc, StatementError) else exc
    diag = driver.diag if isinstance(driver, psycopg.Error) else None
    sqlstate = (driver.sqlstate if isinstance(driver, psycopg.Error) else None) or "-"
    constraint = (diag.constraint_name if diag is not None else None) or "-"
    return f"{type(exc).__name__} sqlstate={sqlstate} constraint={constraint}"


def _linked(exc: BaseException) -> Iterator[BaseException]:
    """The exceptions `exc` was raised from, during or with (an exception group's members)."""
    for linked in (exc.__cause__, exc.__context__, *getattr(exc, "exceptions", ())):
        if isinstance(linked, BaseException):
            yield linked


def holds_database_error(exc: BaseException) -> bool:
    seen: set[int] = set()
    pending = [exc]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if is_database_error(current):
            return True
        pending.extend(_linked(current))
    return False


def _redacted(exc: BaseException, made: dict[int, RedactedError]) -> RedactedError:
    """`exc`'s chain as a chain of `RedactedError`s with the same frames."""
    if id(exc) in made:
        return made[id(exc)]
    shown = RedactedError(describe(exc) if is_database_error(exc) else type(exc).__name__)
    made[id(exc)] = shown
    shown.__traceback__ = exc.__traceback__
    shown.__cause__ = _redacted(exc.__cause__, made) if exc.__cause__ is not None else None
    shown.__context__ = _redacted(exc.__context__, made) if exc.__context__ is not None else None
    shown.__suppress_context__ = exc.__suppress_context__
    return shown


def _shown(value: Any) -> Any:
    if isinstance(value, BaseException) and holds_database_error(value):
        return describe(value) if is_database_error(value) else type(value).__name__
    return value


def redact(record: logging.LogRecord) -> None:
    """Takes the text of every database error out of `record` (see the module docstring)."""
    exc_info = record.exc_info
    if exc_info and exc_info[1] is not None and holds_database_error(exc_info[1]):
        shown = _redacted(exc_info[1], {})
        record.exc_info, record.exc_text = (RedactedError, shown, shown.__traceback__), None
    record.msg = _shown(record.msg)
    if isinstance(record.args, tuple):
        record.args = tuple(_shown(arg) for arg in record.args)
    elif isinstance(record.args, Mapping):
        record.args = {key: _shown(value) for key, value in record.args.items()}


def install() -> None:
    """Redacts every log record the process makes from now on; a second call changes nothing."""
    made = logging.getLogRecordFactory()
    if getattr(made, INSTALLED, False):
        return

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = made(*args, **kwargs)
        redact(record)
        return record

    setattr(factory, INSTALLED, True)
    logging.setLogRecordFactory(factory)
