"""Database URLs, engines and sessions, one role per process.

Each process gets only its own URL: the kernel `KERNEL_DATABASE_URL` (role desk_kernel), the
API `API_DATABASE_URL` (desk_api), the mock payments server `MOCKPAY_DATABASE_URL`
(desk_mockpay); migrations use `ADMIN_DATABASE_URL` (desk_admin). Each is a SQLAlchemy URL,
`postgresql+psycopg://<user>:<password>@<host>:<port>/<db>`. In a development environment
(`desk.env.is_development()`), a URL missing from the environment is read from the repository's
`.env`, so local tools and tests need no exported variables; anywhere else it must be set. Values
are never logged.
"""

import contextlib
import functools
import os
import re
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Literal, get_args

from sqlalchemy import Alias, ColumnClause, Connection, FromClause, Join, Select, Table, TextClause, event, func, select
from sqlalchemy.dialects.postgresql import psycopg as postgresql_psycopg
from sqlalchemy.orm import Session, SessionTransaction
from sqlalchemy.sql import visitors
from sqlalchemy.sql.functions import FunctionElement
from sqlalchemy.sql.selectable import SelectBase
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from desk.env import is_development

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
    if not value and is_development():
        value = _dotenv().get(name)
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def libpq_url(url: str) -> str:
    """The same URL for clients that bypass SQLAlchemy (psycopg, Procrastinate)."""
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


# Copy isolation. Row-level security on every kernel table admits only rows whose copy_id equals
# the transaction's desk.copy_id setting, and the kernel_ro views filter on the same setting
# (migration 0002_copy_isolation) and run as desk_ro_owner, which the same rule binds
# (0005_kernel_ro_owner). A transaction that set no copy reads and writes no rows.
COPY_SETTING = "desk.copy_id"


class CopySession(Session):
    """A session whose every transaction runs as the copy bound to it (`bind_copy`).

    The copy goes into `desk.copy_id` with `set_config(..., is_local => true)` as each
    transaction begins, so it ends with the transaction and never outlives it on a pooled
    connection. An unbound session sets nothing, and kernel_ro reads find no rows.
    """

    copy_required = False


class KernelSession(CopySession):
    """A kernel session: a transaction is refused until a copy is bound."""

    copy_required = True


@event.listens_for(CopySession, "after_begin")
def _set_transaction_copy(session: Session, transaction: SessionTransaction, connection: Connection) -> None:
    copy_id = session.info.get("copy_id")
    if copy_id:
        connection.execute(select(func.set_config(COPY_SETTING, copy_id, True)))
    elif getattr(session, "copy_required", False):
        raise RuntimeError("a kernel transaction needs a copy: bind one first (KernelRepo(copy_id).bind(session))")


def bind_copy(session: Session | AsyncSession, copy_id: str) -> None:
    """Run every transaction of `session` as `copy_id`. Bind before the first query; one copy per session."""
    if not copy_id:
        raise ValueError("bind_copy needs a copy_id")
    bound = session.info.get("copy_id")
    if bound == copy_id:
        return
    if bound is not None:
        raise ValueError("this session is bound to another copy; open a new session for it")
    if session.in_transaction():
        raise ValueError("bind the copy before the session's first query")
    session.info["copy_id"] = copy_id


# One engine per process and role, created on first use. Call dispose_engines() at shutdown
# (and between event loops in tests): pooled connections belong to the loop that opened them.

@functools.cache
def kernel_engine() -> AsyncEngine:
    """The kernel process's engine, as desk_kernel. A failed statement's error leaves out its bound
    values (`hide_parameters`), since some carry a verification code or a link token. That alone
    doesn't keep them out of a log: Postgres's own message can quote a value it couldn't read, so
    the kernel logs a database error by its class, SQLSTATE and constraint name (`desk.db.logs`)."""
    return create_async_engine(database_url("KERNEL"), pool_pre_ping=True, hide_parameters=True)


@functools.cache
def _kernel_sessions() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(kernel_engine(), expire_on_commit=False, sync_session_class=KernelSession)


async def get_kernel_session() -> AsyncIterator[AsyncSession]:
    """A kernel session (a FastAPI dependency); the caller owns its transactions.

    It is bound to no copy: bind one (`KernelRepo(copy_id).bind(session)`) before the first query,
    or every transaction is refused. A request that knows only a credential finds its copy with
    `resolve_copy` first.
    """
    async with _kernel_sessions()() as session:
        yield session


# Lookups made before the copy is known. Each resolver is a SECURITY DEFINER function in schema
# kernel that returns only a copy id (migrations 0004_copy_resolvers, 0009, 0010, 01b_6); only
# desk_kernel may call them. Each looks up a hash or an ID that is no secret, never a token. They
# run on their own kernel connection, outside every KernelSession, so nothing else runs with them.
CopyResolver = Literal["copy_of_session", "copy_of_session_id", "copy_of_desk_slug", "copy_of_decision_id",
                       "copy_of_document_link", "copy_of_payment_link"]


async def resolve_copy(resolver: CopyResolver, key: str, *, engine: AsyncEngine | None = None) -> str | None:
    """The copy a credential belongs to: a session token's hash (`copy_of_session`), a session's
    ID (`copy_of_session_id`, migration 0009), a Desk's public slug (`copy_of_desk_slug`), a
    decision's ID (`copy_of_decision_id`, migration 0010, which names its session), a document
    link token's sha256 (`copy_of_document_link`, migration 01b_6_document_links) or a payment
    link token's sha256 (`copy_of_payment_link`, migration 01c_2_payment_links); None when nothing
    matches. Bind the answer to a kernel session, then authenticate the credential in that copy as
    usual. `engine` is the kernel engine to ask on (the kernel app passes its own), else
    `kernel_engine()`."""
    if resolver not in get_args(CopyResolver):
        raise ValueError(f"no copy resolver named {resolver!r}")
    async with (engine or kernel_engine()).connect() as conn:
        return (await conn.execute(select(getattr(func.kernel, resolver)(key)))).scalar_one()


async def copy_ids() -> list[str]:
    """Every copy's id, for work that visits each copy in turn (startup reconciliation, reaping):
    open one `KernelRepo(copy_id).session()` per copy."""
    async with kernel_engine().connect() as conn:
        return list((await conn.scalars(select(func.kernel.copy_ids()))).all())


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
    return async_sessionmaker(api_engine(), expire_on_commit=False, sync_session_class=CopySession)


async def get_api_session() -> AsyncIterator[AsyncSession]:
    """An API session (a FastAPI dependency); the caller owns its transactions.

    kernel_ro reads find rows only once the copy from `GET /whoami` is bound (`bind_copy`).
    """
    async with _api_sessions()() as session:
        yield session


JOB_QUEUE_POOL_MAX = 5   # the job queue's own pool (Plan 02a, "Connections and state")


def procrastinate_connector(url: str | None = None) -> "procrastinate.PsycopgConnector":
    """The API's job queue connections, as desk_api, with api_engine()'s search_path, in a small pool of their own:
    to `url` (a SQLAlchemy URL, as `Settings.api_database_url` holds it), else `API_DATABASE_URL`. Procrastinate
    bypasses SQLAlchemy, so it gets the plain `postgresql://` form (`libpq_url`)."""
    import procrastinate   # only the API process needs the job queue

    return procrastinate.PsycopgConnector(
        conninfo=libpq_url(url if url is not None else database_url("API")),
        kwargs={"options": API_CONNECT_OPTIONS}, min_size=1, max_size=JOB_QUEUE_POOL_MAX,
    )


async def dispose_engines() -> None:
    """Close every pooled connection and forget the engines; the next use opens new ones."""
    for engine in (kernel_engine, api_engine):
        if engine.cache_info().currsize:
            await engine().dispose()
        engine.cache_clear()
    _kernel_sessions.cache_clear()
    _api_sessions.cache_clear()


# set_config changes a setting mid-transaction; on desk.copy_id it would switch the copy. The other
# built-ins here run query text they are given (found in pg_proc on Postgres 16), and that text could
# call set_config. A bound value reaches SQL only through one of them, so refusing them keeps every
# bound value data.
REFUSED_FUNCTIONS = frozenset({
    "set_config",
    "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "cursor_to_xml", "cursor_to_xmlschema",
    "ts_stat", "ts_rewrite",
})
# One of them named as a whole identifier: Postgres identifiers run on letters, digits, _ and $.
_CALLS_REFUSED = re.compile(r"(?<![\w$])(?:" + "|".join(sorted(REFUSED_FUNCTIONS)) + r")(?![\w$])")
SETS_THE_COPY = ("KernelRepo refused a statement that calls set_config or runs query text; only a session's copy"
                 " binding sets desk.copy_id")
# SQL spellings no SQLAlchemy statement over the kernel tables compiles to. Each could hide a call, a
# SELECT or a table from a check that reads the SQL as text, so the spelling itself is refused, on the
# raw SQL, before anything is read: Unicode escapes (U&"\0073et_config" is set_config, and U&'...' a
# string spelled by code point), dollar quoting ($$...$$ or $tag$...$tag$; no kernel identifier holds a
# $), escape strings (E'...', where \' doesn't end the string), comments and statement separators.
# The escape-string test refuses any e or E followed by a quote at a token start (after anything but
# a letter, digit, _ or $), so a one-letter literal 'e' is refused too: kernel statements bind their
# values and never inline a literal, so that only refuses more.
_UNICODE_ESCAPES = re.compile(r"u&[\"']", flags=re.IGNORECASE)
_UNREADABLE_SQL = re.compile(r"\$|(?<![\w$])[eE]'|--|/\*|;")
SPELLING_REFUSED = ("KernelRepo refused a statement whose SQL is spelled in a way it doesn't read: Unicode escapes,"
                    " dollar quoting, an escape string, a comment or a statement separator")
# A string literal ('...', a quote inside doubled) or a quoted identifier ("...", likewise), read left to
# right, so a quote inside one kind of token is part of that token and never starts the other kind.
_LITERAL_OR_IDENTIFIER = re.compile(r"'(?:[^']|'')*'|(\"(?:[^\"]|\"\")*\")")
# Execution options that never change the SQL a statement compiles to.
SAFE_EXECUTION_OPTIONS = frozenset({"populate_existing", "autoflush", "yield_per", "stream_results", "max_row_buffer"})
_POSTGRES = postgresql_psycopg.dialect()


class KernelRepo:
    """One copy's view of the kernel tables.

    Postgres enforces the copy: `session()` and `bind()` make every transaction of a kernel
    session run as this copy, and row-level security then admits only this copy's rows to the
    reads and writes a slip makes: a missing copy filter, an UPDATE or DELETE, query text that a
    function such as `query_to_xml` runs. Row security keys on the `desk.copy_id` setting, which SQL
    can change too: a statement that calls `set_config` on it reads and writes as another copy.
    Only `CopySession` sets it, as each transaction begins; kernel code never does.
    A lookup made before the copy is known (a session token, a public slug) goes through
    `resolve_copy`, and work across copies visits each id from `copy_ids()` with its own session.

    `scoped(stmt)` is a second layer for SELECTs, which catches mistakes in the statements kernel
    code builds. It supports one shape: a SELECT over kernel tables, their aliases and inner joins
    of them, and adds `copy_id = <copy>` for each of those tables. It refuses what it can't scope
    in two checks:

    1. An allowlist on the statement. It refuses ORM options of any kind (loader options,
       `with_expression`), execution options other than `SAFE_EXECUTION_OPTIONS`, raw SQL
       (`text()`, `literal_column()`, prefixes, suffixes, hints), a nested SELECT anywhere (scalar,
       IN and EXISTS subqueries, derived tables, CTEs), outer joins (a copy filter on the missing
       side would drop the row), FROM items that aren't kernel tables, and calls to
       `REFUSED_FUNCTIONS` (`set_config` and the built-ins that run query text they are given).
    2. A check on the SQL itself, for what the statement hides from the first, such as a mapped
       column that reads another table. The scoped statement is compiled for Postgres and refused
       unless it is spelled the way SQLAlchemy spells a statement over the kernel tables (no
       Unicode escapes, dollar quoting, escape strings, comments or statement separators, each of
       which could hide text from a check that reads SQL), holds exactly one SELECT, reads no kernel
       table it didn't filter and calls none of `REFUSED_FUNCTIONS` (its string literals and quoted
       identifiers included).

    The isolation that holds against hostile input is row-level security, not these checks. A
    bound value is data: it could reach SQL only as query text for one of `REFUSED_FUNCTIONS`,
    which both layers refuse, so a hostile value (a call ID that reads "set_config") is looked up
    like any other. Execute the returned statement as it is: options added afterwards aren't
    checked.
    """

    def __init__(self, copy_id: str):
        if not copy_id:
            raise ValueError("KernelRepo needs a copy_id")
        self.copy_id = copy_id

    def bind(self, session: Session | AsyncSession) -> None:
        """Run every transaction of a kernel session (from `get_kernel_session()`) as this copy."""
        bind_copy(session, self.copy_id)

    @contextlib.asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        """A new kernel session bound to this copy; the caller owns its transactions."""
        async with _kernel_sessions()() as session:
            self.bind(session)
            yield session

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
        if isinstance(element, FunctionElement) and getattr(element, "name", "").lower() in REFUSED_FUNCTIONS:
            raise ValueError(SETS_THE_COPY)


def _check_compiled(stmt: Select, scoped_tables: set[str]) -> None:
    """Layer 2: the compiled SQL is spelled the way SQLAlchemy spells it (no `_UNICODE_ESCAPES` or
    `_UNREADABLE_SQL`), holds one SELECT, reads only kernel tables it filters and calls none of
    `REFUSED_FUNCTIONS`."""
    raw = str(stmt.compile(dialect=_POSTGRES))
    # Spellings are refused on the raw text, before string literals are told apart: each could hide what follows.
    if _UNICODE_ESCAPES.search(raw) or _UNREADABLE_SQL.search(raw):
        raise ValueError(SPELLING_REFUSED)
    sql = _LITERAL_OR_IDENTIFIER.sub(lambda m: m.group(1) or "''", raw)   # drop string literals, keep identifiers
    keywords = re.sub(r'"(?:[^"]|"")*"', '""', sql)                        # and drop quoted identifiers
    if len(re.findall(r"\bselect\b", keywords, flags=re.IGNORECASE)) != 1:
        raise ValueError("KernelRepo refused a statement whose SQL holds a nested SELECT")
    read = set(re.findall(r"\bkernel\.(\w+)", sql.replace('"', "")))
    if unscoped := read - scoped_tables:
        raise ValueError(f"KernelRepo refused a statement that reads kernel tables it can't scope: {sorted(unscoped)}")
    # string literals and quoted identifiers included; a quote ends an identifier as a space would.
    # Bound values aren't in this text: they are data.
    if _CALLS_REFUSED.search(raw.replace('"', " ").lower()):
        raise ValueError(SETS_THE_COPY)


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
