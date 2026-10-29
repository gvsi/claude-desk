"""Fixtures for the kernel service tests.

They run against the local Postgres (`docker compose up -d db`) named in `.env`, migrated to
head once per run. Every test starts from empty kernel tables: the truncation runs as
desk_admin, since the kernel role may neither truncate the ledger nor see other copies.
"""

from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import psycopg
import pytest
from alembic import command
from alembic.config import Config

from desk.db.session import database_url, dispose_engines, libpq_url
from desk.db.tables import KERNEL_TABLES
from desk.kernel_service import adapters
from desk.kernel_service.app import create_app

from .fakes import FrozenClock

BACKEND = Path(__file__).resolve().parents[2]
START = datetime(2026, 10, 30, 17, 4, 5, 123456, tzinfo=UTC)   # a Friday, 10:04 in Oakland


@pytest.fixture(scope="session")
def migrated_db() -> None:
    """The database at Alembic head. The config has no file, so alembic's env.py leaves logging alone."""
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(config, "head")


@pytest.fixture(autouse=True)
def empty_kernel_tables(migrated_db: None) -> None:
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as admin:
        admin.execute("TRUNCATE " + ", ".join(f"kernel.{table}" for table in KERNEL_TABLES))


@pytest.fixture
def frozen_clock() -> FrozenClock:
    return FrozenClock(START)


@pytest.fixture
async def app(frozen_clock: FrozenClock, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator:
    """The kernel app with its lifespan entered, signing with the dev key."""
    monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
    kernel = create_app(clock=frozen_clock)
    try:
        async with kernel.router.lifespan_context(kernel):
            yield kernel
    finally:
        await dispose_engines()


@pytest.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://kernel") as http:
        yield http


@pytest.fixture
def registry() -> Iterator[dict]:
    """The adapter registry, restored after the test."""
    saved = dict(adapters.ADAPTERS)
    try:
        yield adapters.ADAPTERS
    finally:
        adapters.ADAPTERS.clear()
        adapters.ADAPTERS.update(saved)
