"""Fixtures for the API's tests: the database as desk_api, FakeKernel and a visitor in a fresh Turner copy.

- `db`: the database, migrated to the one Alembic head (the run fails with the command to run when it
  isn't) and with every `app.*` table emptied before each test.
- `engine` / `api_conn`: SQLAlchemy's async engine and one connection as desk_api, with the API process's
  search_path; nothing commits unless a test does.
- `fake`: FakeKernel's `FakeKernelState`, mirrored into `fake_kernel_ro`, and `kernel_http`, the API's typed
  client pointed at it.
- `visitor` / `ids`: a visitor session on a new Turner copy: its token (memory only, as in the API) and the
  `Ids` its `/whoami` answer names.
- `clock`: a clock the test moves by hand. `api`: the API app on FakeKernel and `fake_kernel_ro`, its lifespan
  running, with that clock and `PASSCODE`'s hash; `browser(app, ip=...)`: an HTTPS client on it from one address,
  keeping its cookies as a browser would.

sse-starlette keeps a process-wide shutdown flag and a per-thread watcher bound to the event loop that
started it; both are reset before each test, since every test runs on a loop of its own. `create_app` installs the
API's link-token redaction as the process's log record factory for good (`log_redaction.install()`); the factory is
put back after each test, so a later test outside these (a kernel test logging its own `/document_links/{token}`
route) logs as it would on its own (`tests/test_log_record_factory.py`).
"""

import logging
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import psycopg
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sse_starlette import sse as sse_starlette

from desk.api.kernel_client import CredentialView, KernelHttp
from desk.api.main import create_app
from desk.api.passcode import hash_passcode
from desk.api.settings import Settings
from desk.api.store import Ids
from desk.contracts import CopyCreated
from desk.db.session import API_CONNECT_OPTIONS, database_url, libpq_url
from desk.db.tables import APP_TABLES
from desk.kernel_api import CreateCopyRequest, CreateSessionRequest
from tests.kernel_contract.fake_kernel import FakeKernelState, fake_kernel_app
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA, FakeRO, create_fake_ro

BACKEND = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def admin() -> Iterator[psycopg.Connection]:
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as conn:
        yield conn


@pytest.fixture(scope="session")
def migrated(admin: psycopg.Connection) -> None:
    heads = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini"))).get_heads()
    current = [row[0] for row in admin.execute("SELECT version_num FROM alembic_version").fetchall()]
    if sorted(current) != sorted(heads):
        pytest.fail(f"the database is at {current}, not {heads}: run `cd backend && uv run alembic upgrade head`")


@pytest.fixture
def db(admin: psycopg.Connection, migrated: None) -> psycopg.Connection:
    """desk_admin, on a migrated database whose app tables are empty."""
    admin.execute("TRUNCATE {} RESTART IDENTITY".format(", ".join(f"app.{table}" for table in APP_TABLES)))
    return admin


@pytest.fixture
async def engine(db: psycopg.Connection) -> AsyncIterator[AsyncEngine]:
    """The API process's engine (desk_api), opened on this test's event loop."""
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS},
                                 pool_size=10, max_overflow=20)
    yield engine
    await engine.dispose()


@pytest.fixture
async def api_conn(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    async with engine.connect() as conn:
        yield conn


@pytest.fixture(scope="session")
def fake_ro(admin: psycopg.Connection, migrated: None) -> FakeRO:
    return create_fake_ro(admin)


@pytest.fixture
def fake(fake_ro: FakeRO) -> FakeKernelState:
    return FakeKernelState(ro=fake_ro)


@pytest.fixture
async def kernel_http(fake: FakeKernelState) -> AsyncIterator[KernelHttp]:
    http = KernelHttp("http://fake-kernel", transport=httpx.ASGITransport(app=fake_kernel_app(fake)))
    yield http
    await http.aclose()


@dataclass(frozen=True)
class Visitor:
    """A visitor session as a request holds it: the token in memory, the IDs from `/whoami`."""

    ids: Ids
    token: str
    kernel: CredentialView
    slug: str

    def __repr__(self) -> str:
        return f"Visitor({self.ids!r})"


async def new_visitor(http: KernelHttp, fake: FakeKernelState, copy: CopyCreated | None = None) -> Visitor:
    """A visitor session on the Desk of `copy`, or of a new Turner copy."""
    copy = copy or await http.public().call("POST /copies", CreateCopyRequest())
    slug = fake.desks[copy.desk_ids[0]].slug
    created = await http.public().call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="visitor"))
    kernel = http.session(created.session_token)
    who = await kernel.whoami()
    return Visitor(ids=Ids(copy_id=who.copy_id, desk_id=who.desk_id, session_id=who.session.session_id),
                   token=created.session_token, kernel=kernel, slug=slug)


@pytest.fixture
async def visitor(kernel_http: KernelHttp, fake: FakeKernelState) -> Visitor:
    return await new_visitor(kernel_http, fake)


@pytest.fixture
def ids(visitor: Visitor) -> Ids:
    return visitor.ids


@pytest.fixture
def ro_schema() -> str:
    return FAKE_RO_SCHEMA


@pytest.fixture(autouse=True)
def _reset_sse_starlette() -> Iterator[None]:
    sse_starlette.AppStatus.should_exit = False
    sse_starlette._thread_state.__dict__.clear()
    yield
    sse_starlette.AppStatus.should_exit = False
    sse_starlette._thread_state.__dict__.clear()


@pytest.fixture(autouse=True)
def _restore_log_record_factory() -> Iterator[None]:
    factory = logging.getLogRecordFactory()
    yield
    logging.setLogRecordFactory(factory)


class Clock:
    """A clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = datetime(2026, 10, 30, 17, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> Clock:
    return Clock()


PASSCODE = "rivera-demo-passcode"
CLIENT_IP = "203.0.113.7"          # a documentation address: not loopback, so per-IP limits apply


@pytest.fixture(scope="session")
def passcode_hash() -> str:
    return hash_passcode(PASSCODE)


@pytest.fixture(autouse=True)
def _no_custom_headers(monkeypatch) -> None:
    """`ANTHROPIC_CUSTOM_HEADERS`, which a developer's shell may export, refuses every model client."""
    monkeypatch.delenv("ANTHROPIC_CUSTOM_HEADERS", raising=False)


@pytest.fixture
def api_settings(passcode_hash: str) -> Settings:
    # The model host is a closed loopback port: an app that runs a turn with no injected model gets
    # ModelUnavailable, never a network call.
    return Settings(api_database_url=database_url("API"), desk_env="test", passcode_hash=passcode_hash,
                    kernel_ro_schema=FAKE_RO_SCHEMA, anthropic_base_url="http://127.0.0.1:9")


@pytest.fixture
async def api(db: psycopg.Connection, fake: FakeKernelState, api_settings: Settings, clock: Clock) -> AsyncIterator[FastAPI]:
    """The API app on FakeKernel, its lifespan running."""
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), clock=clock,
                     jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


@pytest.fixture
async def browser() -> AsyncIterator[Callable[..., httpx.AsyncClient]]:
    """Clients on an app over HTTPS (so `Secure` cookies are kept and sent), each from one client address."""
    clients: list[httpx.AsyncClient] = []

    def open_client(app: FastAPI, ip: str = CLIENT_IP) -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(ip, 50000)),
                                   base_url="https://desk.test")
        clients.append(client)
        return client

    yield open_client
    for client in clients:
        await client.aclose()
