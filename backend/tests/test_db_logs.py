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


class OddError(Exception):
    """An error whose `exceptions` attribute is no list of members, as an exception group's is."""

    exceptions = None


def test_only_an_exception_groups_members_are_read_as_its_members(caplog):
    """A group's members are looked through for a database error; another error's `exceptions`
    attribute is not, and never stops its chain from being read."""
    logs.install()
    caplog.set_level(logging.INFO)
    log = logging.getLogger("desk.test")
    try:
        raise ExceptionGroup("while saving", [ValueError("other"), refused()])
    except ExceptionGroup:
        log.exception("group_failed")
    try:
        raise OddError("while saving") from refused()
    except OddError:
        log.exception("odd_failed")
    assert SECRET not in caplog.text and "Key (" not in caplog.text
    group, odd = (record.exc_info[1] for record in caplog.records)
    assert (type(group), str(group)) == (logs.RedactedError, "ExceptionGroup")
    assert (str(odd), str(odd.__cause__)) == ("OddError", "IntegrityError sqlstate=23505 constraint=-")


def test_a_redaction_that_fails_leaves_a_fixed_message_and_the_caller_goes_on(caplog, monkeypatch):
    """A log call never raises because of the redaction: the record says `log_redaction_failed`,
    with none of the message's arguments and no exception, and the code after the call runs."""
    logs.install()
    caplog.set_level(logging.INFO)

    def fails(record: logging.LogRecord) -> None:
        raise RuntimeError("the redaction failed")

    monkeypatch.setattr(logs, "redact", fails)
    rolled_back = False
    try:
        raise refused()
    except Exception as error:
        logging.getLogger("desk.test").exception("save_failed error=%s", error)
        rolled_back = True
    assert rolled_back
    [record] = caplog.records
    assert (record.getMessage(), record.args, record.exc_info, record.exc_text) == ("log_redaction_failed", (), None,
                                                                                   None)
    assert SECRET not in caplog.text
