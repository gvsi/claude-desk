"""Fixtures for the kernel service tests.

They run against the local Postgres (`docker compose up -d db`) named in `.env`, migrated to
head once per run. Every test starts from empty kernel tables: the truncation runs as
desk_admin, since the kernel role may neither truncate the ledger nor see other copies.

The kernel picks its proof mode at startup from `desk-prove --selftest`. The `app` fixture points
`DESK_PROVE` at nothing, so it starts in `bounded` mode whatever is installed; a test that asks for
the `desk_prove` fixture gets the real prover (and `symcc` mode). Tests marked `solver` need cvc5
and a built `desk-prove` (`make kernel`) and are skipped without them.

Every `app` calls one mock payments server for the whole run (`mockpay`), in a thread on a free
loopback port with a fresh key, as a kernel calls its child; no test app starts a child itself.
"""

import dataclasses
import os
import secrets
import shutil
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
from desk.kernel_service import activation, adapters
from desk.kernel_service import app as kernel_app
from desk.kernel_service.app import KernelSettings, create_app
from desk.mockpay import server as mockpay_server

from .fakes import FakeDecisions, FrozenClock

BACKEND = Path(__file__).resolve().parents[2]
REPO = BACKEND.parent
START = datetime(2026, 10, 30, 17, 4, 5, 123456, tzinfo=UTC)   # a Friday, 10:04 in Oakland
NO_PROVER = "/nonexistent/desk-prove"                          # the selftest fails, so the kernel runs bounded


def _executable(path: str | None) -> str | None:
    return path if path and os.path.isfile(path) and os.access(path, os.X_OK) else None


# The desk-prove the solver tests prove with: DESK_PROVE, else one on PATH, else the release build.
PROVER = (_executable(os.environ.get("DESK_PROVE")) or shutil.which("desk-prove")
          or _executable(str(REPO / "kernel" / "target" / "release" / "desk-prove")))
CVC5 = _executable(os.environ.get("CVC5")) or shutil.which("cvc5")
SOLVER_MISSING = ("cvc5 isn't installed (set CVC5 or put it on PATH)" if CVC5 is None
                  else "desk-prove isn't built (make kernel)" if PROVER is None else None)


def pytest_runtest_setup(item: pytest.Item) -> None:
    if item.get_closest_marker("solver") is not None and SOLVER_MISSING:
        pytest.skip(SOLVER_MISSING)


@pytest.fixture(autouse=True)
def bounded_until_a_selftest(monkeypatch: pytest.MonkeyPatch) -> None:
    """The proof mode is the process's, so each test starts where a fresh kernel does: `bounded`."""
    monkeypatch.setattr(activation, "_proof_mode", "bounded")


@pytest.fixture
def desk_prove(monkeypatch: pytest.MonkeyPatch) -> str:
    """The real desk-prove and cvc5, through DESK_PROVE and CVC5; skipped without them."""
    if SOLVER_MISSING:
        pytest.skip(SOLVER_MISSING)
    monkeypatch.setenv("DESK_PROVE", PROVER)
    monkeypatch.setenv("CVC5", CVC5)
    return PROVER


@pytest.fixture(scope="session")
def migrated_db() -> None:
    """The database at Alembic head. The config has no file, so alembic's env.py leaves logging alone."""
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(config, "head")


@dataclasses.dataclass(frozen=True)
class Mockpay:
    url: str
    key: str = dataclasses.field(repr=False)


@pytest.fixture(scope="session")
def mockpay(migrated_db: None) -> Iterator[Mockpay]:
    """The mock payments server every kernel app in the run calls: a thread, a free port, a fresh key."""
    key = secrets.token_hex(32)
    app = mockpay_server.create_app(database_url("MOCKPAY"), key, env="test")
    with mockpay_server.serve_in_thread(app) as url:
        yield Mockpay(url=url, key=key)


@pytest.fixture(autouse=True)
def empty_kernel_tables(migrated_db: None) -> None:
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as admin:
        admin.execute("TRUNCATE " + ", ".join(f"kernel.{table}" for table in KERNEL_TABLES))


@pytest.fixture
def frozen_clock() -> FrozenClock:
    return FrozenClock(START)


@pytest.fixture
def reviewer() -> FakeDecisions:
    """The app's reviewer: every review fails (the action holds) until a test sets `answer`."""
    return FakeDecisions(None)


@pytest.fixture
def kernel_pool() -> dict:
    """Pool options (`pool_size`, `max_overflow`, `pool_timeout`) for the kernel app's database
    engine: none, so it keeps SQLAlchemy's defaults, unless a test parametrizes this fixture."""
    return {}


@pytest.fixture
async def app(frozen_clock: FrozenClock, reviewer: FakeDecisions, kernel_pool: dict, mockpay: Mockpay,
              monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> AsyncIterator:
    """The kernel app with its lifespan entered, signing with the dev key, in `bounded` proof mode
    (`symcc` when the test asks for `desk_prove`), with the scripted `reviewer`, so no test calls
    a model, its engine built with `kernel_pool`'s options, and the run's mock payments server."""
    monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
    if "desk_prove" in request.fixturenames:
        request.getfixturevalue("desk_prove")
    else:
        monkeypatch.setenv("DESK_PROVE", NO_PROVER)
    if kernel_pool:
        make_engine = kernel_app.create_async_engine
        monkeypatch.setattr(kernel_app, "create_async_engine",
                            lambda url, **options: make_engine(url, **options, **kernel_pool))
    settings = dataclasses.replace(KernelSettings.from_env(), mockpay_url=mockpay.url, mockpay_key=mockpay.key,
                                   mockpay_spawn=False, typesafe_api_key="")
    kernel = create_app(settings, clock=frozen_clock, decisions=reviewer)
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
