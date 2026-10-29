"""Fixtures for the API's tests: the database as desk_api, FakeKernel and a visitor in a fresh Rivera copy.

- `db`: the database, migrated to the one Alembic head (the run fails with the command to run when it
  isn't) and with every `app.*` table emptied before each test.
- `engine` / `api_conn`: SQLAlchemy's async engine and one connection as desk_api, with the API process's
  search_path; nothing commits unless a test does.
- `fake`: FakeKernel's `FakeKernelState`, mirrored into `fake_kernel_ro`, and `kernel_http`, the API's typed
  client pointed at it.
- `visitor` / `ids`: a visitor session on a new Rivera copy: its token (memory only, as in the API) and the
  `Ids` its `/whoami` answer names.

sse-starlette keeps a process-wide shutdown flag and a per-thread watcher bound to the event loop that
started it; both are reset before each test, since every test runs on a loop of its own.
"""

from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx
import psycopg
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sse_starlette import sse as sse_starlette

from desk.api.kernel_client import CredentialView, KernelHttp
from desk.api.store import Ids
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


async def new_visitor(http: KernelHttp, fake: FakeKernelState) -> Visitor:
    """A new Rivera copy and a visitor session on its Desk."""
    copy = await http.public().call("POST /copies", CreateCopyRequest())
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
