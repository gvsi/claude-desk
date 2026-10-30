"""Database errors in log records: their class, SQLSTATE and constraint name, never their text."""

import logging

import psycopg
from sqlalchemy.exc import IntegrityError

from desk.db import logs

SECRET = "token-0123456789"


def refused() -> IntegrityError:
    """A unique violation as SQLAlchemy raises it, its text holding the key it refused."""
    driver = psycopg.errors.UniqueViolation(f'duplicate key value\nDETAIL:  Key (token)=({SECRET}) already exists.')
    return IntegrityError("INSERT INTO kernel.document_links ...", None, driver)


def test_a_database_error_anywhere_in_a_record_is_logged_without_its_text(caplog):
    logs.install()
    logs.install()                                    # once is enough; a second call changes nothing
    caplog.set_level(logging.INFO)
    log = logging.getLogger("desk.test")
    try:
        try:
            raise refused()
        except IntegrityError as error:
            raise RuntimeError(f"while saving: {error}") from error
    except RuntimeError as error:
        log.exception("save_failed")                  # the chain: the error, and one raised from it
        log.warning("save_failed error=%s outer=%s", error.__cause__, error)    # as arguments
        log.warning("save_failed error=%(error)s", {"error": error.__cause__})  # as named arguments
        log.warning(error.__cause__)                  # as the message
    assert SECRET not in caplog.text and "Key (" not in caplog.text
    assert [record.getMessage() for record in caplog.records] == [
        "save_failed",
        "save_failed error=IntegrityError sqlstate=23505 constraint=- outer=RuntimeError",
        "save_failed error=IntegrityError sqlstate=23505 constraint=-",
        "IntegrityError sqlstate=23505 constraint=-"]
    shown = caplog.records[0].exc_info[1]
    assert (type(shown), str(shown), str(shown.__cause__)) == (
        logs.RedactedError, "RuntimeError", "IntegrityError sqlstate=23505 constraint=-")
    assert shown.__traceback__ is not None            # the frames stay

    # a record that holds no database error is left as it was
    try:
        raise ValueError("a value it may show")
    except ValueError:
        log.exception("other_failure")
    assert caplog.records[-1].exc_info[0] is ValueError
