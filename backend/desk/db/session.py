"""Database URLs, engines and sessions, one role per process.

Each process gets only its own URL: the kernel `KERNEL_DATABASE_URL` (role desk_kernel), the
API `API_DATABASE_URL` (desk_api), the mock payments server `MOCKPAY_DATABASE_URL`
(desk_mockpay); migrations use `ADMIN_DATABASE_URL` (desk_admin). Each is a SQLAlchemy URL,
`postgresql+psycopg://<user>:<password>@<host>:<port>/<db>`. Outside production, a URL missing
from the environment is read from the repository's `.env`, so local tools and tests need no
exported variables. Values are never logged.
"""

import functools
import os
import re
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import Alias, ColumnClause, FromClause, Join, Select, Table, TextClause
from sqlalchemy.dialects.postgresql import psycopg as postgresql_psycopg
from sqlalchemy.sql import visitors
from sqlalchemy.sql.selectable import SelectBase
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

if TYPE_CHECKING:
    import procrastinate

REPO_ROOT = Path(__file__).resolve().parents[3]


def _dotenv() -> dict[str, str]:
    """KEY=value lines of the repository's .env; an absent file is empty."""
    path = REPO_ROOT / ".env"
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def database_url(prefix: str) -> str:
    """The URL in `<prefix>_DATABASE_URL` (prefix ADMIN, KERNEL, API or MOCKPAY)."""
    name = f"{prefix}_DATABASE_URL"
    value = os.environ.get(name)
    if not value and os.environ.get("DESK_ENV") != "production":
        value = _dotenv().get(name)
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def libpq_url(url: str) -> str:
    """The same URL for clients that bypass SQLAlchemy (psycopg, Procrastinate)."""
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


# One engine per process and role, created on first use. Call dispose_engines() at shutdown
# (and between event loops in tests): pooled connections belong to the loop that opened them.

@functools.cache
def kernel_engine() -> AsyncEngine:
    """The kernel process's engine, as desk_kernel."""
    return create_async_engine(database_url("KERNEL"), pool_pre_ping=True)


@functools.cache
def _kernel_sessions() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(kernel_engine(), expire_on_commit=False)


async def get_kernel_session() -> AsyncIterator[AsyncSession]:
    """A kernel session (a FastAPI dependency); the caller owns its transactions."""
    async with _kernel_sessions()() as session:
        yield session


# Procrastinate's functions name their tables unqualified, so every desk_api connection, the
# job queue's included, puts schema procrastinate first; app comes next for the API's tables.
API_SEARCH_PATH = "procrastinate, app"
API_CONNECT_OPTIONS = "-c search_path=" + API_SEARCH_PATH.replace(" ", "\\ ")   # libpq options escape spaces


@functools.cache
def api_engine() -> AsyncEngine:
    """The API process's engine, as desk_api."""
    return create_async_engine(
        database_url("API"), pool_pre_ping=True, connect_args={"options": API_CONNECT_OPTIONS}
    )


@functools.cache
def _api_sessions() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(api_engine(), expire_on_commit=False)


async def get_api_session() -> AsyncIterator[AsyncSession]:
    """An API session (a FastAPI dependency); the caller owns its transactions."""
    async with _api_sessions()() as session:
        yield session


def procrastinate_connector() -> "procrastinate.PsycopgConnector":
    """The API's job queue connection, as desk_api, with api_engine()'s search_path."""
    import procrastinate   # only the API process needs the job queue

    return procrastinate.PsycopgConnector(
        conninfo=libpq_url(database_url("API")), kwargs={"options": API_CONNECT_OPTIONS}
    )


async def dispose_engines() -> None:
    """Close every pooled connection and forget the engines; the next use opens new ones."""
    for engine in (kernel_engine, api_engine):
        if engine.cache_info().currsize:
            await engine().dispose()
        engine.cache_clear()
    _kernel_sessions.cache_clear()
    _api_sessions.cache_clear()


# Execution options that never change the SQL a statement compiles to.
SAFE_EXECUTION_OPTIONS = frozenset({"populate_existing", "autoflush", "yield_per", "stream_results", "max_row_buffer"})
_POSTGRES = postgresql_psycopg.dialect()


class KernelRepo:
    """One copy's view of the kernel tables: every kernel query goes through `scoped()`.

    `scoped(stmt)` supports one shape: a SELECT over kernel tables, their aliases and inner joins
    of them, and adds `copy_id = <copy>` for each of those tables. It fails closed in two layers:

    1. An allowlist on the statement. It refuses ORM options of any kind (loader options,
       `with_expression`), execution options other than `SAFE_EXECUTION_OPTIONS`, raw SQL
       (`text()`, `literal_column()`, prefixes, suffixes, hints), a nested SELECT anywhere (scalar,
       IN and EXISTS subqueries, derived tables, CTEs), outer joins (a copy filter on the missing
       side would drop the row) and FROM items that aren't kernel tables.
    2. A check on the SQL itself. The scoped statement is compiled for Postgres and refused unless
       it holds exactly one SELECT and reads no kernel table it didn't filter, which catches what
       the statement hides, such as a mapped column that reads another table.

    Execute the returned statement as it is: options added afterwards aren't checked. A later
    plan can widen the supported shapes.
    """

    def __init__(self, copy_id: str):
        if not copy_id:
            raise ValueError("KernelRepo needs a copy_id")
        self.copy_id = copy_id

    def scoped(self, stmt: Select) -> Select:
        _check_allowed(stmt)
        tables = [table for clause in stmt.get_final_froms() for table in _kernel_tables(clause)]
        if not tables:
            raise ValueError("the statement reads no kernel table")
        scoped = stmt.where(*(table.c.copy_id == self.copy_id for table in tables))
        _check_compiled(scoped, {(t.element if isinstance(t, Alias) else t).name for t in tables})
        return scoped


def _check_allowed(stmt: Select) -> None:
    """Layer 1: refuse every statement feature outside the supported shape."""
    if not isinstance(stmt, Select):
        raise ValueError(f"KernelRepo scopes only SELECT statements, not {type(stmt).__name__}")
    # Private Select attributes, read without defaults: if SQLAlchemy renames one, this raises
    # instead of skipping the check.
    if stmt._with_options:
        raise ValueError("KernelRepo can't scope a statement with ORM options")
    if set(stmt.get_execution_options()) - SAFE_EXECUTION_OPTIONS:
        raise ValueError("KernelRepo can't scope a statement with execution options that change its SQL")
    if stmt._prefixes or stmt._suffixes or stmt._hints or stmt._statement_hints:
        raise ValueError("KernelRepo can't scope raw SQL text")
    if stmt._independent_ctes:
        raise ValueError("KernelRepo can't scope a nested SELECT; query each table through scoped()")
    for element in visitors.iterate(stmt):
        if element is stmt:
            continue
        if isinstance(element, SelectBase):
            raise ValueError("KernelRepo can't scope a nested SELECT; query each table through scoped()")
        if isinstance(element, TextClause) or (isinstance(element, ColumnClause) and element.is_literal):
            raise ValueError("KernelRepo can't scope raw SQL text")


def _check_compiled(stmt: Select, scoped_tables: set[str]) -> None:
    """Layer 2: the compiled SQL holds one SELECT and reads only kernel tables it filters."""
    sql = re.sub(r"'(?:[^']|'')*'", "''", str(stmt.compile(dialect=_POSTGRES)))   # drop string literals
    keywords = re.sub(r'"(?:[^"]|"")*"', '""', sql)                              # and quoted identifiers
    if len(re.findall(r"\bselect\b", keywords, flags=re.IGNORECASE)) != 1:
        raise ValueError("KernelRepo refused a statement whose SQL holds a nested SELECT")
    read = set(re.findall(r"\bkernel\.(\w+)", sql.replace('"', "")))
    if unscoped := read - scoped_tables:
        raise ValueError(f"KernelRepo refused a statement that reads kernel tables it can't scope: {sorted(unscoped)}")


def _kernel_tables(clause: FromClause) -> Iterator[FromClause]:
    """The kernel tables (or their aliases) a FROM item reads; anything else can't be scoped."""
    if isinstance(clause, Join):
        if clause.isouter or clause.full:
            raise ValueError("KernelRepo can't scope an outer join; query the optional side separately")
        yield from _kernel_tables(clause.left)
        yield from _kernel_tables(clause.right)
        return
    table = clause.element if isinstance(clause, Alias) else clause
    if not isinstance(table, Table) or table.schema != "kernel" or "copy_id" not in table.c:
        raise ValueError(f"KernelRepo can't scope a query that reads from {clause!r}")
    yield clause
