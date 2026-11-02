"""Options shared by every backend test session, including the real kernel contract run, and the log record factory
each test puts back: building the API app (`create_app`) installs its link-token redaction as the process's record
factory for good (`desk.api.log_redaction.install()`), so a later test logging a kernel route template such as
`/document_links/{token}` would read it redacted (`tests/test_log_record_factory.py`)."""

import logging
from collections.abc import Iterator

import pytest

pytest_plugins = ["desk.pytest_shard", "desk.pytest_hangs"]


@pytest.fixture(autouse=True)
def _restore_log_record_factory() -> Iterator[None]:
    factory = logging.getLogRecordFactory()
    yield
    logging.setLogRecordFactory(factory)
