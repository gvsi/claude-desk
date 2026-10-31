"""Fixtures for the mock payments server tests.

They run against the local Postgres (`docker compose up -d db`) named in `.env`, migrated to head
once per run; the server connects as the mock payments role (MOCKPAY_DATABASE_URL). Each test gets
its own server, uvicorn on a free loopback port in a thread, with a fresh key, and works in copies
of its own (`new_copy`), so no test sees another's rows.
"""

import secrets
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from desk.db.session import database_url
from desk.mockpay.server import create_app, serve_in_thread

BACKEND = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def migrated_db() -> None:
    """The database at Alembic head. The config has no file, so alembic's env.py leaves logging alone."""
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(config, "head")


def new_key() -> str:
    """A fresh key of 32 characters, the shortest the server takes. Never printed."""
    return secrets.token_hex(16)


def new_copy() -> str:
    return f"copy_{uuid.uuid4().hex[:12]}"


@pytest.fixture
def mockpay_key() -> str:
    return new_key()


@pytest.fixture
def mockpay_url(migrated_db: None, mockpay_key: str) -> Iterator[str]:
    """The base URL of a mock payments server that takes `mockpay_key`."""
    with serve_in_thread(create_app(database_url("MOCKPAY"), mockpay_key, env="test")) as url:
        yield url
