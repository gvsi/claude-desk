"""Database schemas, roles and grants (master plan, "Data model and database roles").

These tests run against the local Postgres (`docker compose up -d db`) after
`cd backend && uv run alembic upgrade head && cd .. && make db-roles`. Introspection runs as
desk_admin; privilege checks connect as the role under test. Every write is rolled back, except
the rows `committed_copies` commits as desk_admin (another role sees only committed rows) and
removes afterwards. A migration taken down and up runs in a scratch database of its own, dropped
afterwards; the suite's database is never downgraded.
"""

import hashlib
import re
import warnings
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import get_args
from uuid import uuid4

import procrastinate
import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg.sql import SQL, Identifier
from pydantic import ValidationError
from sqlalchemy import cast, create_engine, exists, func, literal, literal_column, select, text, update
from sqlalchemy.dialects.postgresql import REGCLASS
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import DBAPIError, IntegrityError, StatementError
from sqlalchemy.orm import DeclarativeBase, Session, aliased, column_property, defer, with_expression
from sqlalchemy.pool import NullPool
from sqlalchemy.sql.elements import quoted_name
from sqlalchemy.sql.functions import Function

import desk.db
from desk.contracts import ActorKind, Assurance, Claim, DecisionState, Outcome, RenderedBlock, Review, SessionMode
from desk.contracts import PolicyVersion as PolicyVersionContract
from desk.db.models import (
    ActorSession,
    Approval,
    Base,
    Booking,
    Business,
    CalendarSlot,
    A2ATurn,
    Copy,
    Decision,
    Desk,
    Document,
    Fact,
    KnowledgeItem,
    LedgerEntry,
    Message,
    PolicyVersion,
    PriceItem,
    Quote,
    Tool,
)
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.session import (
    COPY_SETTING,
    CopySession,
    KernelRepo,
    KernelSession,
    api_engine,
    bind_copy,
    copy_ids,
    database_url,
    dispose_engines,
    get_kernel_session,
    libpq_url,
    procrastinate_connector,
    resolve_copy,
)
from desk.events import A2AResponse
from desk.db.tables import APP_TABLES, KERNEL_RO_COLUMNS, KERNEL_RO_VIEWS, KERNEL_TABLES, MOCKPAY_TABLES


ROLES = ("desk_kernel", "desk_api", "desk_mockpay")
ROLES_SQL = Path(desk.db.__file__).with_name("roles.sql")


def connect(prefix: str) -> psycopg.Connection:
    """A connection as the role in <prefix>_DATABASE_URL (ADMIN, KERNEL, API or MOCKPAY)."""
    return psycopg.connect(libpq_url(database_url(prefix)), autocommit=True)


@pytest.fixture(scope="module")
def admin():
    with connect("ADMIN") as conn:
        yield conn


def tables_in(admin: psycopg.Connection, schema: str) -> set[str]:
    rows = admin.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE'",
        (schema,),
    ).fetchall()
    return {name for (name,) in rows}


def columns(admin: psycopg.Connection, schema: str, table: str) -> list[str]:
    return list(nullable_columns(admin, schema, table))


def nullable_columns(admin: psycopg.Connection, schema: str, table: str) -> dict[str, bool]:
    """Column name -> whether it accepts NULL, in table order."""
    rows = admin.execute(
        "SELECT column_name, is_nullable = 'YES' FROM information_schema.columns"
        " WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
        (schema, table),
    ).fetchall()
    return dict(rows)


def test_all_tables_exist(admin):
    assert set(KERNEL_TABLES) <= tables_in(admin, "kernel")
    assert set(APP_TABLES) <= tables_in(admin, "app")
    assert set(MOCKPAY_TABLES) <= tables_in(admin, "mockpay")
    # models.py maps every table in the lists, column for column, nullability included
    expected = {("kernel", t) for t in KERNEL_TABLES} | {("app", t) for t in APP_TABLES} | {
        ("mockpay", t) for t in MOCKPAY_TABLES}
    assert {(t.schema, t.name) for t in Base.metadata.tables.values()} == expected
    for table in Base.metadata.tables.values():
        mapped = {c.name: c.nullable for c in table.columns}
        assert mapped == nullable_columns(admin, table.schema, table.name), table.fullname


def role_logins(admin: psycopg.Connection) -> dict[str, bool]:
    rows = admin.execute("SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY(%s)", (list(ROLES),))
    return dict(rows.fetchall())


def test_roles_migration_is_idempotent(admin):
    before = role_logins(admin)
    admin.execute(ROLES_SQL.read_text())   # 0001_core ran it once already
    assert set(role_logins(admin)) == set(ROLES)
    assert role_logins(admin) == before    # a rerun never resets a role that make db-roles let log in


@pytest.fixture(scope="module")
def api():
    with connect("API") as conn:
        yield conn


def test_api_role_cannot_touch_kernel_tables(api):
    for table in KERNEL_TABLES:
        for statement in (
            f"SELECT * FROM kernel.{table}",
            f"INSERT INTO kernel.{table} DEFAULT VALUES",
            f"UPDATE kernel.{table} SET copy_id = copy_id",
            f"DELETE FROM kernel.{table}",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                api.execute(statement)
    # nor through the kernel_ro views, which are simple enough for Postgres to write through
    for view in KERNEL_RO_VIEWS:
        for statement in (
            f"INSERT INTO kernel_ro.{view} DEFAULT VALUES",
            f"UPDATE kernel_ro.{view} SET copy_id = copy_id",
            f"DELETE FROM kernel_ro.{view}",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                api.execute(statement)


def test_api_role_cannot_reach_mockpay(api):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        api.execute("SELECT * FROM mockpay.charges")


def views_in(admin: psycopg.Connection, schema: str) -> set[str]:
    rows = admin.execute("SELECT table_name FROM information_schema.views WHERE table_schema = %s", (schema,))
    return {name for (name,) in rows.fetchall()}


def test_api_views_hide_secrets(admin, api):
    # each view exposes exactly the columns "Data model" lists, so nothing else can leak
    for view in KERNEL_RO_VIEWS:
        assert columns(admin, "kernel_ro", view) == list(KERNEL_RO_COLUMNS[view]), view
    assert "secret_hash" not in columns(admin, "kernel_ro", "sessions")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        api.execute("SELECT code_hash FROM kernel.verification_challenges")
    hidden = {"demo_inbox", "verification_challenges", "document_links", "agent_keys", "demo_wallet_keys"}
    assert not hidden & views_in(admin, "kernel_ro")
    assert {"body", "canary"}.isdisjoint(columns(admin, "kernel_ro", "documents"))


MASTER_PLAN = Path(__file__).resolve().parents[2] / "docs" / "plans" / "2026-10-28-00-master-plan.md"


def plan_kernel_ro_columns() -> dict[str, tuple[str, ...]]:
    """The master plan's "Data model" `| View | Columns |` table, in order, parenthetical notes dropped."""
    lines = MASTER_PLAN.read_text().splitlines()
    start = lines.index("| View | Columns |") + 2
    views: dict[str, tuple[str, ...]] = {}
    for line in lines[start:]:
        if not line.startswith("|"):
            break
        view, listed = (cell.strip() for cell in line.strip().strip("|").split("|", 1))
        listed = re.sub(r"\s*\([^()]*\)", "", listed)    # notes such as "(a public pin, not a secret)" hold commas
        views[view.strip("`")] = tuple(column.strip() for column in listed.split(","))
    return views


def test_ro_views_match_the_data_model():
    # with test_api_views_hide_secrets (live views == KERNEL_RO_COLUMNS), this ties the database to the plan
    assert list(KERNEL_RO_COLUMNS.items()) == list(plan_kernel_ro_columns().items())


def plan_model_call_columns() -> list[str]:
    """The `app.model_calls` columns the master plan's "Data model" lists, notes dropped."""
    bullet = next(line for line in MASTER_PLAN.read_text().splitlines() if line.startswith("- **`app.*` (`APP_TABLES`):**"))
    listed = bullet.split("`model_calls` (", 1)[1].split("; one row per API model call", 1)[0]
    return [column.strip() for column in re.sub(r"\s*\([^()]*\)", "", listed).replace("`", "").split(",")]


def test_model_calls_follow_the_data_model(admin, api):
    # Plan 02a's migration api_tables completes the table: its columns are exactly the plan's
    assert set(columns(admin, "app", "model_calls")) == set(plan_model_call_columns())
    key = admin.execute("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid"
                        " AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'app.model_calls'::regclass AND i.indisprimary")
    assert key.fetchall() == [("model_call_id",)]
    # created_at is the call's finish, which only the writer knows: no default stands in for it
    with pytest.raises(psycopg.errors.NotNullViolation), api.transaction(force_rollback=True):
        api.execute("INSERT INTO app.model_calls (copy_id, route, model, input_tokens, cached_tokens,"
                    " cache_write_tokens, output_tokens, latency_ms, stop_reason)"
                    " VALUES ('copy-a', 'conversation', 'claude-opus-5-5', 1200, 0, 0, 80, 2400, 'end_turn')")


def test_kernel_ro_views_carry_copy_id(admin, api):
    assert views_in(admin, "kernel_ro") == set(KERNEL_RO_VIEWS)
    for view in KERNEL_RO_VIEWS:
        assert "copy_id" in columns(admin, "kernel_ro", view), view
        api.execute(f"SELECT copy_id FROM kernel_ro.{view} LIMIT 0")   # the API reads each one, filtered by copy


@pytest.fixture
def kernel_tx():
    """An ORM session as desk_kernel, in copy "copy-a", whose writes are rolled back."""
    engine = create_engine(database_url("KERNEL"), poolclass=NullPool)
    with KernelSession(engine, info={"copy_id": "copy-a"}) as session:
        yield session
        session.rollback()
    engine.dispose()


SLOT_TIME = datetime(2026, 11, 3, 16, 0, tzinfo=UTC)


def booking(booking_id: str, desk_id: str = "desk-a", status: str = "confirmed") -> Booking:
    return Booking(booking_id=booking_id, copy_id="copy-a", desk_id=desk_id, slot_id="slot-1",
                   starts_at=SLOT_TIME, status=status)


def test_one_confirmed_booking_per_slot(kernel_tx):
    # a cancelled booking doesn't hold the slot, and slot ids repeat across Desks
    kernel_tx.add_all([booking("b-1"), booking("b-2", status="cancelled"), booking("b-3", desk_id="desk-b")])
    kernel_tx.flush()
    kernel_tx.add(booking("b-4"))
    with pytest.raises(IntegrityError):
        kernel_tx.flush()


def ledger_entry(desk_id: str, seq: int) -> LedgerEntry:
    return LedgerEntry(desk_id=desk_id, seq=seq, copy_id="copy-a", prev_hash="0" * 64,
                       created_at="2026-10-30T17:04:05.123456Z",
                       event={"kind": "session", "origin": "kernel", "summary": {}},
                       hash="a" * 64, signature="b" * 128, key_id="c" * 16, envelope_jcs="{}")


def test_ledger_seq_unique_per_desk(kernel_tx):
    kernel_tx.add_all([ledger_entry("desk-a", 1), ledger_entry("desk-b", 1)])   # each Desk has its own chain
    kernel_tx.flush()
    kernel_tx.expunge_all()
    kernel_tx.add(ledger_entry("desk-a", 1))
    with pytest.raises(IntegrityError):
        kernel_tx.flush()


@pytest.fixture
async def kernel_db():
    """An async session from get_kernel_session(), bound to no copy yet, whose writes are rolled back."""
    sessions = get_kernel_session()
    session = await anext(sessions)
    try:
        yield session
    finally:
        await session.rollback()
        await sessions.aclose()
        await dispose_engines()


async def switch_copy(session, copy_id: str) -> None:
    """Test setup only: point the open transaction at another copy, as another copy's request would."""
    await session.execute(select(func.set_config(COPY_SETTING, copy_id, True)))


async def test_kernel_repo_scopes_by_copy(kernel_db):
    copy_a, copy_b = f"copy-{uuid4().hex}", f"copy-{uuid4().hex}"
    repo = KernelRepo(copy_a)
    repo.bind(kernel_db)
    await switch_copy(kernel_db, copy_b)
    kernel_db.add_all([
        Business(business_id=f"biz-{copy_b}", copy_id=copy_b, name="Rivera Plumbing",
                 owner_display_name="Maria Rivera", timezone="America/Los_Angeles"),
        Desk(desk_id=f"desk-{copy_b}", copy_id=copy_b, business_id=f"biz-{copy_b}", name="Main line",
             slug=f"slug-{copy_b}"),
    ])
    await kernel_db.flush()
    await switch_copy(kernel_db, copy_a)
    kernel_db.add(Desk(desk_id=f"desk-{copy_a}", copy_id=copy_a, business_id=f"biz-{copy_b}", name="Main line",
                       slug=f"slug-{copy_a}"))
    await kernel_db.flush()
    desks = (await kernel_db.scalars(repo.scoped(select(Desk)))).all()
    assert [d.desk_id for d in desks] == [f"desk-{copy_a}"]
    # every kernel table in a join is scoped: copy A's Desk pointing at copy B's business finds nothing
    joined = select(Desk, Business).join(Business, Desk.business_id == Business.business_id)
    assert (await kernel_db.execute(repo.scoped(joined))).all() == []
    other = aliased(Desk)
    pairs = select(Desk.desk_id, other.desk_id).join(other, other.business_id == Desk.business_id)
    assert (await kernel_db.execute(repo.scoped(pairs))).all() == [(f"desk-{copy_a}", f"desk-{copy_a}")]
    locked = select(Desk).with_for_update().execution_options(populate_existing=True)   # the executor's pattern
    assert [d.desk_id for d in (await kernel_db.scalars(repo.scoped(locked))).all()] == [f"desk-{copy_a}"]


async def test_api_role_can_enqueue_jobs():
    jobs = procrastinate.App(connector=procrastinate_connector())

    @jobs.task(name="desk_tests.noop", queue="desk_tests")
    async def noop() -> None:
        pass

    try:
        async with jobs.open_async():
            job_id = await noop.defer_async()
            assert job_id
            jobs_path = await jobs.connector.execute_query_one_async("SHOW search_path")
            await jobs.connector.execute_query_async("DELETE FROM procrastinate_jobs WHERE id = %(id)s", id=job_id)
        async with api_engine().connect() as conn:
            api_path = (await conn.execute(text("SHOW search_path"))).scalar_one()
    finally:
        await dispose_engines()
    assert jobs_path["search_path"] == api_path == "procrastinate, app"


# Requirements of the same section that the plan's ten tests above don't reach: what KernelRepo
# refuses, the append-only ledger, each role's full privileges, the data model's unique keys,
# and JSON columns that hold contracts.


class LeakyBase(DeclarativeBase):
    pass


class DeskWithDocumentTitle(LeakyBase):
    """A Desk model with a column that reads kernel.documents unscoped (it exists only in this test)."""

    __table__ = Desk.__table__
    document_title = column_property(select(Document.title).limit(1).scalar_subquery())


class DeskSwitchingCopy(LeakyBase):
    """A Desk model with a column that points the transaction at another copy (only in this test)."""

    __table__ = Desk.__table__
    switched = column_property(func.set_config(COPY_SETTING, "copy-b", True))


def test_kernel_repo_refuses_what_it_cannot_scope():
    repo = KernelRepo(f"copy-{uuid4().hex}")
    title = select(Document.title).scalar_subquery()
    businesses = select(Business).subquery()
    nested = (
        select(Desk.desk_id, title),                                         # copy B's title beside copy A's Desk
        select(Desk).where(Desk.desk_id.in_(select(Document.desk_id))),
        select(Desk).where(exists().where(Document.desk_id == Desk.desk_id)),
        select(Desk).join(Document, Document.title == title),
        select(Desk).order_by(title),
        select(Desk).where(Desk.business_id == select(Document.title).cte().c.title),
        select(select(Desk).subquery()),
        select(Desk).join(businesses, businesses.c.business_id == Desk.business_id),
    )
    raw_sql = (
        select(text("1")),
        select(Desk).where(text("true")),
        select(Desk, literal_column("(SELECT 1)")),
        select(Desk).suffix_with("OR TRUE"),                                 # would follow the copy filter
    )
    # ORM options and execution options change the SQL after scoped() has looked at it
    options = (
        select(Desk).options(with_expression(Desk.name, title)),             # the reviewer's copy B title
        select(Desk).options(defer(Desk.hours)),
        select(Desk).execution_options(schema_translate_map={"kernel": "kernel"}),
    )
    # a mapped column that reads another table is invisible in the statement; only the compiled SQL shows it
    mapped = (select(DeskWithDocumentTitle),)
    # an outer join's missing side is NULL, so a copy filter in WHERE would drop the row: refused
    outer = (
        select(Desk.desk_id, Business.name).outerjoin(Business, Desk.business_id == Business.business_id),
        select(Desk.desk_id, Business.name).join(Business, Desk.business_id == Business.business_id, full=True),
    )
    # row-level security keys on desk.copy_id, so a statement that sets it would read as another copy
    switching = (
        select(Desk.desk_id, func.set_config(COPY_SETTING, "copy-b", True),
               func.query_to_xml("select body from kernel.documents", True, False, "")),   # the reviewer's probe
        select(Desk.desk_id).where(func.pg_catalog.SET_CONFIG(COPY_SETTING, "copy-b", True) != ""),
        select(Desk.desk_id, func.query_to_xml("select set_config('desk.copy_id', 'copy-b', true)", True, False, "")),
        select(DeskSwitchingCopy),
    )
    for unscopable in (*nested, *raw_sql, *options, *mapped, *outer, *switching):
        with pytest.raises(ValueError):
            repo.scoped(unscopable)


# The built-ins that would let a SELECT change desk.copy_id: set_config itself, and every function
# that runs query text it is given (pg_proc on Postgres 16), since that text could call set_config.
COPY_SWITCHERS = ("set_config", "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "cursor_to_xml",
                  "cursor_to_xmlschema", "ts_stat", "ts_rewrite")


def calling(n: int, call) -> type:
    """A Desk model whose mapped column makes `call`: the statement hides it, only its SQL shows it."""
    return type(f"DeskCalling{n}", (LeakyBase,), {"__table__": Desk.__table__, "called": column_property(call)})


def test_guard_refuses_set_config_calls():
    repo = KernelRepo(f"copy-{uuid4().hex}")
    calls = []
    for name in COPY_SWITCHERS:
        args = (COPY_SETTING, "copy-b", True) if name == "set_config" else ("select 1", True, False, "")
        calls += [
            getattr(func, name)(*args),                                       # plain
            getattr(func.pg_catalog, name)(*args),                            # schema-qualified
            Function(quoted_name(name, True), *args),                         # quoted, any case
            Function(quoted_name(name.upper(), True), *args),
            Function(quoted_name(name.title(), True), *args, packagenames=("pg_catalog",)),
        ]
    statements = [select(Desk.desk_id, call) for call in calls]
    statements += [select(calling(n, call)) for n, call in enumerate(calls)]
    admitted = []
    for statement in statements:
        try:
            repo.scoped(statement)
        except ValueError:
            continue
        admitted.append(str(statement).split(" FROM")[0])
    assert admitted == []


def test_guard_refuses_unicode_escape_identifiers():
    """`U&"\\0073et_config"` names set_config through a Unicode escape, which no name check reads,
    and `U&'...'` spells a string the same way. SQLAlchemy never spells either, so the guard refuses
    the spelling itself, in any case, wherever it appears: inside a string literal too, since the
    guard refuses what it would have to lex to tell apart."""
    repo = KernelRepo(f"copy-{uuid4().hex}")
    escaped = ('U&"\\0073et_config"', 'u&"\\0073et_config"', 'U&"\\0073ET_CONFIG"', 'u&"\\0073ET_CONFIG"',
               'pg_catalog.U&"\\0073et_config"')
    calls = [literal_column(f"{name}('{COPY_SETTING}', 'copy-b', true)") for name in escaped]
    calls.append(literal_column("U&'\\0073et_config'"))                                  # a string spelled that way
    statements = [select(calling(n, call)) for n, call in enumerate(calls, start=1000)]   # hidden from layer 1
    admitted = []
    for statement in statements:
        try:
            repo.scoped(statement)
        except ValueError:
            continue
        admitted.append(str(statement).split(" FROM")[0])
    assert admitted == []
    # the spelling inside a string literal is refused too: the guard doesn't read through quoting
    with pytest.raises(ValueError):
        repo.scoped(select(calling(2000, literal_column("'U&\"\\0073et_config\"'"))))


# SQL text SQLAlchemy never compiles a kernel statement to. Each can hide a call, a nested SELECT or a
# table from a check that reads the SQL as text: dollar quoting and escape strings swallow the text
# after a quote they hold, a quoted identifier or a comment can hold a quote, and a separator starts
# a second statement. A shape that hides a nested SELECT inside a dollar quote, an escape string or a
# comment is refused only by the check for that spelling, so a narrower check admits it; a
# Unicode-escaped call is refused by the escape check wherever it stands.
UNREADABLE_SHAPES = (
    "$$'$$ || U&\"\\0073et_config\"('desk.copy_id', 'copy-b', true) || $$'$$",
    "$q$'$q$ || (select coalesce(max(seq), 0) from kernel.ledger_entries)::text || $q$'$q$",
    "E'\\'' || U&\"\\0073et_config\"('desk.copy_id', 'copy-b', true) || E'\\''",
    "e'\\'' || (select coalesce(max(seq), 0) from kernel.ledger_entries)::text || e'\\''",
    "$$'$$ || (select coalesce(max(seq), 0) from kernel.ledger_entries)::text || $$'$$",
    "E'\\'' || (select coalesce(max(seq), 0) from kernel.ledger_entries)::text || E'\\''",
    "\"a'b\", U&\"\\0073et_config\"('desk.copy_id', 'copy-b', true)",
    "\"a'b\", (select coalesce(max(seq), 0) from kernel.ledger_entries), \"c'd\"",
    "1; set desk.copy_id = 'copy-b'",
    "1 /* ' */, (select coalesce(max(seq), 0) from kernel.ledger_entries) /* ' */",
    "1 -- '\n, (select coalesce(max(seq), 0) from kernel.ledger_entries) -- '\n",
)


def test_guard_refuses_quoting_it_cannot_read():
    """The guard refuses the spellings in `UNREADABLE_SHAPES` themselves, before it reads anything
    else, instead of trying to lex them: each would otherwise hide text from the checks that run on
    the SQL with its string literals dropped."""
    repo = KernelRepo(f"copy-{uuid4().hex}")
    statements = [select(calling(n, literal_column(sql))) for n, sql in enumerate(UNREADABLE_SHAPES, start=3000)]
    admitted = []
    for statement in statements:
        try:
            repo.scoped(statement)
        except ValueError:
            continue
        admitted.append(str(statement).split(" FROM")[0])
    assert admitted == []


async def test_guard_treats_bound_text_as_data(kernel_db):
    repo = KernelRepo(f"copy-{uuid4().hex}")
    repo.bind(kernel_db)
    hostile = ("set_config", "x SET_CONFIG y", "query_to_xml('select 1', true, true, '')",
               "x'; select set_config('desk.copy_id','other',false); --")
    for value in hostile:
        found = await kernel_db.execute(repo.scoped(select(Desk.desk_id).where(Desk.desk_id == value)))
        assert found.all() == [], value
    assert (await kernel_db.execute(select(func.current_setting(COPY_SETTING)))).scalar_one() == repo.copy_id


def test_kernel_role_cannot_rewrite_the_ledger():
    entry = ledger_entry("desk-a", 1)
    with connect("KERNEL") as kernel, kernel.transaction(force_rollback=True):
        kernel.execute("SELECT set_config('desk.copy_id', %s, true)", (entry.copy_id,))
        kernel.execute(
            "INSERT INTO kernel.ledger_entries (desk_id, seq, copy_id, prev_hash, created_at, event, hash, signature,"
            " key_id, envelope_jcs) VALUES (%s, %s, %s, %s, %s, '{}'::jsonb, %s, %s, %s, %s)",
            (entry.desk_id, entry.seq, entry.copy_id, entry.prev_hash, entry.created_at, entry.hash,
             entry.signature, entry.key_id, entry.envelope_jcs),
        )
        for statement in (
            "UPDATE kernel.ledger_entries SET signature = 'forged' WHERE desk_id = 'desk-a'",
            "DELETE FROM kernel.ledger_entries WHERE desk_id = 'desk-a'",
            "TRUNCATE kernel.ledger_entries",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege), kernel.transaction():
                kernel.execute(statement)


DML = ("SELECT", "INSERT", "UPDATE", "DELETE")
SCHEMA_ACCESS = {   # the table privileges each role holds on every table or view of its schemas, and no others
    "desk_kernel": {"kernel": DML},
    "desk_api": {"app": DML, "procrastinate": DML, "kernel_ro": ("SELECT",)},
    "desk_mockpay": {"mockpay": DML},
}
APPEND_ONLY = {("desk_kernel", "kernel", "ledger_entries"): ("SELECT", "INSERT")}   # ledger_heads keeps UPDATE


def has(admin: psycopg.Connection, check: str, role: str, target: str, privilege: str) -> bool:
    return admin.execute(f"SELECT {check}(%s, %s, %s)", (role, target, privilege)).fetchone()[0]


def test_each_role_reaches_only_its_own_schemas(admin):
    schemas = ("kernel", "kernel_ro", "app", "procrastinate", "mockpay")
    for role, access in SCHEMA_ACCESS.items():
        usable = {s for s in schemas if has(admin, "has_schema_privilege", role, s, "USAGE")}
        assert usable == set(access), role
        for schema, expected in access.items():
            relations = admin.execute(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                " WHERE n.nspname = %s AND c.relkind IN ('r', 'v', 'p')",
                (schema,),
            ).fetchall()
            assert relations, schema
            for (relation,) in relations:
                privileges = (*DML, "TRUNCATE", "REFERENCES", "TRIGGER")
                held = {p for p in privileges if has(admin, "has_table_privilege", role, f"{schema}.{relation}", p)}
                assert held == set(APPEND_ONLY.get((role, schema, relation), expected)), (role, schema, relation)


def per_desk_rows(desk_id: str) -> list[Base]:
    """Rows keyed by IDs a seed or owner supplies, which repeat in every Desk."""
    return [
        CalendarSlot(desk_id=desk_id, slot_id="slot-1", copy_id="copy-a", starts_at=SLOT_TIME, minutes=120),
        Fact(desk_id=desk_id, fact_id="charter:hours", copy_id="copy-a", kind="charter", status="available",
             claims=[]),
        PriceItem(desk_id=desk_id, item_id="drain", copy_id="copy-a", title="Drain clearing", unit_cents=18_000),
        KnowledgeItem(desk_id=desk_id, item_id="faq", copy_id="copy-a", source="setup", title="FAQ", text="..."),
        Tool(desk_id=desk_id, tool="native.quote", copy_id="copy-a", source="native", effects=["read"],
             reversible=True, status="enabled", description_confirmed="Quote a job"),
    ]


def decision(decision_id: str) -> Decision:
    return Decision(decision_id=decision_id, copy_id="copy-a", desk_id="desk-a", session_id="session-1",
                    generation=0, call_id="call-1", call_sha256="0" * 64, tool="native.quote", outcome="allow",
                    state="allowed", policy_version=1, reason_plain="-", visitor_plain="-", expires_at=SLOT_TIME,
                    ledger_seq=1)


def assert_second_collides(session: Session, first: Base, second: Base) -> None:
    savepoint = session.begin_nested()
    session.add(first)
    session.flush()
    session.expunge_all()
    session.add(second)
    with pytest.raises(IntegrityError):
        session.flush()
    savepoint.rollback()
    session.expunge_all()


def test_unique_keys_follow_the_data_model(kernel_tx):
    kernel_tx.add_all(per_desk_rows("desk-a") + per_desk_rows("desk-b"))
    kernel_tx.flush()
    kernel_tx.expunge_all()
    for row, again in zip(per_desk_rows("desk-c"), per_desk_rows("desk-c")):
        assert_second_collides(kernel_tx, row, again)

    def desk(desk_id: str) -> Desk:
        return Desk(desk_id=desk_id, copy_id="copy-a", business_id="biz", name="Main line",
                    slug="rivera-plumbing-abc123")

    def approval(approval_id: str) -> Approval:
        return Approval(approval_id=approval_id, copy_id="copy-a", decision_id="decision-1", answer="allow_once",
                        expires_at=SLOT_TIME)

    def session(session_id: str) -> ActorSession:
        return ActorSession(session_id=session_id, copy_id="copy-a", desk_id="desk-a", kind="visitor",
                            secret_hash="f" * 64)

    assert_second_collides(kernel_tx, desk("desk-1"), desk("desk-2"))                  # slugs are unique
    assert_second_collides(kernel_tx, decision("decision-1"), decision("decision-2"))  # one decision per call
    assert_second_collides(kernel_tx, approval("approval-1"), approval("approval-2"))  # one approval per decision
    assert_second_collides(kernel_tx, session("session-1"), session("session-2"))      # token hashes are unique


STATE_COLUMNS = {   # each kernel state column admits exactly its contract's values
    ("sessions", "kind"): ActorKind,
    ("sessions", "assurance"): Assurance,
    ("sessions", "mode"): SessionMode,
    ("policy_versions", "status"): PolicyVersionContract.model_fields["status"].annotation,
    ("decisions", "outcome"): Outcome,
    ("decisions", "state"): DecisionState,
}


def test_state_columns_admit_only_contract_values(admin):
    for (table, column), literal in STATE_COLUMNS.items():
        checks = admin.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = %s::regclass AND contype = 'c'"
            " AND pg_get_constraintdef(oid) LIKE %s",
            (f"kernel.{table}", f"CHECK (({column} = ANY %"),
        ).fetchall()
        assert len(checks) == 1, (table, column, checks)
        assert set(re.findall(r"'([^']*)'::text", checks[0][0])) == set(get_args(literal)), (table, column)


def test_one_active_policy_version_per_desk(kernel_tx):
    def version(desk_id: str, number: int, status: str) -> PolicyVersion:
        return PolicyVersion(desk_id=desk_id, version=number, copy_id="copy-a", cards=[], status=status,
                             cedar_sha256="c", schema_sha256="s", baseline_sha256="b", profiles_sha256="p",
                             invariants_sha256="i", review_thresholds_version=1)

    kernel_tx.add_all([version("desk-a", 1, "superseded"), version("desk-a", 2, "active"),
                       version("desk-b", 1, "active")])
    kernel_tx.flush()
    kernel_tx.add(version("desk-a", 3, "active"))
    with pytest.raises(IntegrityError):
        kernel_tx.flush()


def test_only_an_owner_alert_names_a_decision(kernel_tx):
    # a held request's alert links to its decision; a code, a checkpoint or an alert to anyone but the owner never
    # names one, so no session's own Demo inbox can show a decision
    def entry(entry_id: str, kind: str, to: str, decision_id: str | None) -> DemoInboxRow:
        return DemoInboxRow(entry_id=entry_id, copy_id="copy-a", desk_id="desk-a", to=to, person_id=None, kind=kind,
                            body="-", preview="-", created_at=SLOT_TIME, decision_id=decision_id)

    masked = "d•••@example.com"
    kernel_tx.add_all([entry("inbox-1", "alert", "owner", "decision-1"), entry("inbox-2", "alert", "owner", None),
                       entry("inbox-3", "verification_code", masked, None), entry("inbox-4", "head_checkpoint",
                                                                                   "owner", None)])
    kernel_tx.flush()
    for n, (kind, to) in enumerate((("verification_code", masked), ("head_checkpoint", "owner"), ("alert", masked))):
        savepoint = kernel_tx.begin_nested()
        kernel_tx.add(entry(f"inbox-named-{n}", kind, to, "decision-1"))
        with pytest.raises(IntegrityError):
            kernel_tx.flush()
        savepoint.rollback()
        kernel_tx.expunge_all()


ALEMBIC_DIR = Path(__file__).resolve().parents[1] / "alembic"


@pytest.fixture
def scratch_database(admin) -> Iterator[URL]:
    """An empty database next to the suite's, for a migration test to take up and down; its admin URL.

    The suite's own database is the one a local kernel and API run on, so no test ever downgrades it.
    Dropped afterwards, with any connection still open to it. The URL stays a `URL`, whose repr masks
    the password, and is rendered with it only where it is used, so a failure under `--showlocals`
    never prints it.
    """
    suite = make_url(database_url("ADMIN"))
    name = f"{suite.database}_migrate_{uuid4().hex[:8]}"
    admin.execute(SQL("CREATE DATABASE {}").format(Identifier(name)))
    try:
        yield suite.set(database=name)
    finally:
        admin.execute(SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(Identifier(name)))


def migrated(conn: psycopg.Connection) -> tuple[bool, bool]:
    """Whether the database behind `conn` has kernel.demo_inbox.decision_id, and whether it has its check."""
    (checks,) = conn.execute("SELECT count(*) FROM pg_constraint WHERE conrelid = 'kernel.demo_inbox'::regclass"
                             " AND conname = 'demo_inbox_decision_id_check'").fetchone()
    return "decision_id" in columns(conn, "kernel", "demo_inbox"), checks == 1


def test_inbox_decision_id_migration_goes_down_and_up(admin, scratch_database):
    # 0012_inbox_decision_id adds the column and its check; its downgrade takes both away, and head brings them back.
    # It all happens in a scratch database: the suite's own stays at head throughout
    config = Config()                                     # no file, so alembic's env.py leaves logging alone
    config.set_main_option("script_location", str(ALEMBIC_DIR))
    engine = create_engine(scratch_database, poolclass=NullPool)
    try:
        with (engine.connect() as connection,
              psycopg.connect(libpq_url(scratch_database.render_as_string(hide_password=False)),
                              autocommit=True) as scratch):
            connection.execute(text("SET lock_timeout = '5s'"))     # a lock it can't get fails the test, never hangs it
            connection.commit()
            config.attributes["connection"] = connection             # env.py migrates on this connection

            def migrate(step, revision: str) -> None:
                with connection.begin():                              # alembic runs inside it; it commits here
                    step(config, revision)

            migrate(command.upgrade, "head")
            assert migrated(scratch) == (True, True)
            migrate(command.downgrade, "0012_inbox_decision_id-1")   # to whatever 0012 revises
            assert migrated(scratch) == (False, False)
            assert migrated(admin) == (True, True)                   # the suite's own database never went down
            migrate(command.upgrade, "head")
            assert migrated(scratch) == (True, True)
            assert nullable_columns(scratch, "kernel", "demo_inbox")["decision_id"] is True
    finally:
        engine.dispose()


def assert_refused_before_the_database(session: Session, row: Base) -> None:
    savepoint = session.begin_nested()
    session.add(row)
    with pytest.raises(StatementError) as refused:
        session.flush()
    assert isinstance(refused.value.orig, (ValidationError, TypeError)), refused.value.orig
    savepoint.rollback()
    session.expunge_all()


def test_json_columns_validate_against_contracts(kernel_tx):
    def fact(claims: list) -> Fact:
        return Fact(desk_id="desk-a", fact_id="quote:q-1", copy_id="copy-a", kind="quote", status="committed",
                    claims=claims)

    def reviewed(review: dict) -> Decision:
        row = decision("decision-1")
        row.review = review
        return row

    def quote(**cents) -> Quote:
        return Quote(quote_id="quote-1", copy_id="copy-a", desk_id="desk-a", items=[], status="proposed",
                     **({"list_cents": 18_000, "discount_bp": 0, "amount_cents": 18_000} | cents))

    for row in (
        fact([{"key": "total", "kind": "money", "value": 180.5}]),            # money is integer cents
        fact([{"key": "total", "kind": "money"}]),                              # a claim needs its value
        reviewed({"within_charter_bp": 9500.0, "manipulation_bp": 0, "recommendation": "allow"}),
        reviewed({"within_charter_bp": 10_001, "manipulation_bp": 0, "recommendation": "allow"}),
        quote(amount_cents=17_999.5),
        quote(discount_bp=True),
        PriceItem(desk_id="desk-a", item_id="drain", copy_id="copy-a", title="Drain clearing", unit_cents=180.0),
    ):
        assert_refused_before_the_database(kernel_tx, row)

    review = Review(within_charter_bp=9500, manipulation_bp=500, recommendation="allow")
    claim = Claim(key="total", kind="money", value=18_000)
    kernel_tx.add_all([fact([claim]), reviewed(review.model_dump()), quote()])
    kernel_tx.flush()
    kernel_tx.expunge_all()
    assert kernel_tx.get(Fact, ("desk-a", "quote:q-1")).claims == [claim]
    assert kernel_tx.get(Decision, "decision-1").review == review
    with warnings.catch_warnings():
        warnings.simplefilter("error")   # the strict integer types take part in SQLAlchemy's statement cache
        kernel_tx.execute(select(Quote).where(Quote.amount_cents == 18_000, Quote.discount_bp == 0)).all()


@pytest.fixture
def api_tx():
    """An ORM session as desk_api whose writes are rolled back."""
    engine = create_engine(database_url("API"), poolclass=NullPool)
    with Session(engine) as session:
        yield session
        session.rollback()
    engine.dispose()


def test_visitor_payloads_validate_against_contracts(api_tx):
    block = RenderedBlock(kind="prose", text="Hi, I'm Claude, answering for Rivera Plumbing.")
    answer = A2AResponse(session_id="session-1", disclosure="ai", blocks=[block], receipts=[])

    def message(blocks) -> Message:
        return Message(message_id=f"m-{uuid4().hex}", copy_id="copy-a", desk_id="desk-a", session_id="session-1",
                       kind="delivered", author="claude", visibility="public", blocks=blocks)

    def turn(response) -> A2ATurn:
        return A2ATurn(agent_key_id="agent-1", session_id="session-1", nonce=uuid4().hex, copy_id="copy-a",
                       response=response)

    for row in (
        message([{"kind": "banner", "text": "Free plumbing for everyone"}]),   # not a block kind
        turn({"session_id": "session-1", "blocks": [block.model_dump()], "receipts": []}),   # no AI disclosure
    ):
        assert_refused_before_the_database(api_tx, row)

    sent, stored = message([block]), turn(answer)
    api_tx.add_all([sent, stored])
    api_tx.flush()
    api_tx.expunge_all()
    assert api_tx.get(Message, sent.n).blocks == [block]
    assert api_tx.get(A2ATurn, ("agent-1", "session-1", stored.nonce)).response == answer


# Copy isolation in Postgres: row-level security on every kernel table reads the copy that the
# transaction set in desk.copy_id, and the kernel_ro views filter on the same setting. A
# transaction that set no copy sees and writes nothing.


COPY_POLICY = "(copy_id = NULLIF(current_setting('desk.copy_id'::text, true), ''::text))"
# What each kernel_ro view's owner reads beyond its copy: kernel_ro.people skips removed people (01b_3_people)
COPY_READ_POLICY = {"people": f"({COPY_POLICY} AND (removed_at IS NULL))"}
# What the copy resolvers' role may read: the copy and the lookup key of each table, in every copy.
RESOLVER_READS = {"copies": {"copy_id"}, "sessions": {"copy_id", "secret_hash", "session_id"},
                  "desks": {"copy_id", "slug"}, "decisions": {"copy_id", "decision_id"}}


def test_every_kernel_table_forces_copy_row_security(admin):
    rows = admin.execute(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class"
        " WHERE relnamespace = 'kernel'::regnamespace AND relkind IN ('r', 'p')"
    ).fetchall()
    assert {name for name, _, _ in rows} == set(KERNEL_TABLES)   # every table, including ones a later revision adds
    for name, enabled, forced in rows:
        assert enabled and forced, name
    policies = admin.execute(
        "SELECT tablename, policyname, roles, cmd, permissive, qual, with_check FROM pg_policies"
        " WHERE schemaname = 'kernel'"
    ).fetchall()
    expected = {
        *((table, "copy_scope") for table in KERNEL_TABLES),
        *((view, "copy_read") for view in KERNEL_RO_VIEWS),   # for the kernel_ro views' owner
        *((table, "resolve_copy") for table in RESOLVER_READS),
    }
    assert sorted((table, name) for table, name, *_ in policies) == sorted(expected)   # and no others
    for table, name, *policy in policies:
        if name == "copy_scope":
            assert policy == [["desk_kernel"], "ALL", "PERMISSIVE", COPY_POLICY, COPY_POLICY], table
        elif name == "copy_read":
            qual = COPY_READ_POLICY.get(table, COPY_POLICY)
            assert policy == [["desk_ro_owner"], "SELECT", "PERMISSIVE", qual, None], table
        else:   # every copy, but only the columns in RESOLVER_READS (test_copy_resolvers_are_narrow)
            assert policy == [["desk_resolver"], "SELECT", "PERMISSIVE", "true", None], table


def test_kernel_ro_views_filter_by_the_transaction_copy(admin):
    for view in KERNEL_RO_VIEWS:
        options, definition = admin.execute(
            "SELECT reloptions, pg_get_viewdef(oid) FROM pg_class WHERE oid = %s::regclass", (f"kernel_ro.{view}",)
        ).fetchone()
        assert "security_barrier=true" in (options or []), view   # the API's own predicates run after the filter
        assert "NULLIF(current_setting('desk.copy_id'::text, true), ''::text)" in definition, view


def column_readers(admin: psycopg.Connection, role: str) -> dict[str, set[str]]:
    """Kernel table -> the columns `role` may SELECT."""
    readable: dict[str, set[str]] = {}
    for table in KERNEL_TABLES:
        for column in columns(admin, "kernel", table):
            if admin.execute("SELECT has_column_privilege(%s, %s, %s, 'SELECT')",
                             (role, f"kernel.{table}", column)).fetchone()[0]:
                readable.setdefault(table, set()).add(column)
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
            assert not has(admin, "has_table_privilege", role, f"kernel.{table}", privilege), (role, table)
    return readable


def test_kernel_ro_views_run_as_a_role_bound_by_row_security(admin):
    # a view runs with its owner's rights; an owner that bypasses row security (a superuser, as the
    # local migration role is) would hide whether the views work where the owner doesn't
    owners = admin.execute(
        "SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace = 'kernel_ro'::regnamespace"
    ).fetchall()
    assert owners == [("desk_ro_owner",)]
    attributes = admin.execute("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'desk_ro_owner'")
    assert attributes.fetchone() == (False, False, False)
    # it reads exactly the columns the views show, in the copy set by its copy_read policy
    assert column_readers(admin, "desk_ro_owner") == {view: set(KERNEL_RO_COLUMNS[view]) for view in KERNEL_RO_VIEWS}


def test_kernel_ro_reads_need_no_role_that_bypasses_row_security(admin):
    # as on a managed Postgres whose migration role is neither SUPERUSER nor BYPASSRLS: the table's
    # owner and the view's owner are both bound by row security, and the API still reads its copy
    copy_id = f"copy-{uuid4().hex}"
    with admin.transaction(force_rollback=True):
        admin.execute("INSERT INTO kernel.desks (desk_id, copy_id, business_id, name, slug)"
                      " VALUES (%s, %s, 'biz', 'Main line', %s)", (f"desk-{copy_id}", copy_id, f"slug-{copy_id}"))
        admin.execute("CREATE ROLE desk_test_owner NOLOGIN NOSUPERUSER NOBYPASSRLS")
        admin.execute("ALTER TABLE kernel.desks OWNER TO desk_test_owner")
        owners = admin.execute(
            "SELECT c.relname, r.rolsuper OR r.rolbypassrls FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner"
            " WHERE c.oid IN ('kernel.desks'::regclass, 'kernel_ro.desks'::regclass)"
        ).fetchall()
        assert owners == [("desks", False), ("desks", False)]
        admin.execute("SET LOCAL ROLE desk_api")
        assert visible(admin, "kernel_ro.desks", (copy_id,)) == set()
        admin.execute("SELECT set_config('desk.copy_id', %s, true)", (copy_id,))
        assert visible(admin, "kernel_ro.desks", (copy_id,)) == {copy_id}
        admin.execute("SELECT set_config('desk.copy_id', %s, true)", (f"copy-{uuid4().hex}",))
        assert visible(admin, "kernel_ro.desks", (copy_id,)) == set()


async def test_sql_functions_read_only_the_copy(kernel_db):
    # the reviewer's probe: functions that read tables by themselves. KernelRepo.scoped() refuses one that runs
    # query text, and row-level security alone keeps copy B out of it, run as it is, and out of table_to_xml
    copy_a, copy_b = f"copy-{uuid4().hex}", f"copy-{uuid4().hex}"
    repo = KernelRepo(copy_a)
    repo.bind(kernel_db)
    await switch_copy(kernel_db, copy_b)
    kernel_db.add(Document(document_id=f"doc-{copy_b}", copy_id=copy_b, desk_id=f"desk-{copy_b}",
                           title="Bob's warranty", body="copy B private body", canary="canary"))
    await kernel_db.flush()
    await switch_copy(kernel_db, copy_a)
    kernel_db.add(Desk(desk_id=f"desk-{copy_a}", copy_id=copy_a, business_id="biz", name="Main line",
                       slug=f"slug-{copy_a}"))
    await kernel_db.flush()
    query_text = select(Desk.desk_id, func.query_to_xml(
        f"select title, body from kernel.documents where copy_id = '{copy_b}'", True, False, ""))
    with pytest.raises(ValueError):
        repo.scoped(query_text)
    leaks = (
        query_text,
        repo.scoped(select(Desk.desk_id, func.table_to_xml(cast(literal("kernel.documents"), REGCLASS), True, False,
                                                            ""))),
    )
    for leak in leaks:
        rows = (await kernel_db.execute(leak)).all()
        assert [desk_id for desk_id, _ in rows] == [f"desk-{copy_a}"]
        assert "copy B private body" not in rows[0][1] and "Bob's warranty" not in rows[0][1]


async def test_kernel_writes_stay_in_their_copy(kernel_db):
    copy_a, copy_b = f"copy-{uuid4().hex}", f"copy-{uuid4().hex}"

    def hours(copy_id: str) -> Fact:
        return Fact(desk_id=f"desk-{copy_id}", fact_id="charter:hours", copy_id=copy_id, kind="charter",
                    status="available", claims=[])

    KernelRepo(copy_a).bind(kernel_db)
    await switch_copy(kernel_db, copy_b)
    kernel_db.add(hours(copy_b))
    await kernel_db.flush()
    await switch_copy(kernel_db, copy_a)
    kernel_db.add(hours(copy_a))
    await kernel_db.flush()

    async def refused(write) -> None:
        with pytest.raises(DBAPIError) as error:
            async with kernel_db.begin_nested():
                await write()
        assert isinstance(error.value.orig, psycopg.errors.InsufficientPrivilege), error.value.orig

    async def insert_into_b():
        kernel_db.add(Document(document_id=f"doc-{uuid4().hex}", copy_id=copy_b, desk_id=f"desk-{copy_b}",
                               title="Planted", body="...", canary="canary"))
        await kernel_db.flush()

    async def move_to_b():
        await kernel_db.execute(update(Fact).where(Fact.copy_id == copy_a).values(copy_id=copy_b)
                                .execution_options(synchronize_session=False))

    async def create_copy_b():
        kernel_db.add(Copy(copy_id=copy_b))
        await kernel_db.flush()

    for write in (insert_into_b, move_to_b, create_copy_b):
        await refused(write)
    # a write that forgets its copy filter reaches only this copy's rows
    unfiltered = update(Fact).where(Fact.fact_id == "charter:hours").values(status="expired")
    assert (await kernel_db.execute(unfiltered.execution_options(synchronize_session=False))).rowcount == 1
    await switch_copy(kernel_db, copy_b)
    statuses = (await kernel_db.execute(text("SELECT copy_id, status FROM kernel.facts WHERE fact_id = 'charter:hours'"
                                             " AND copy_id IN (:a, :b)"), {"a": copy_a, "b": copy_b})).all()
    assert statuses == [(copy_b, "available")]


async def test_kernel_repo_opens_sessions_in_its_copy():
    new_copy = f"copy-{uuid4().hex}"
    repo = KernelRepo(new_copy)
    try:
        async with repo.session() as session:
            # a new copy starts as its own first row: the kernel sets the new id, then inserts
            session.add_all([Copy(copy_id=new_copy), Desk(desk_id=f"desk-{new_copy}", copy_id=new_copy,
                                                         business_id="biz", name="Main line", slug=f"slug-{new_copy}")])
            await session.flush()
            assert (await session.scalars(repo.scoped(select(Desk.desk_id)))).all() == [f"desk-{new_copy}"]
            setting = (await session.execute(select(func.current_setting(COPY_SETTING)))).scalar_one()
            assert setting == new_copy
            with pytest.raises(ValueError):
                KernelRepo(f"copy-{uuid4().hex}").bind(session)   # one session, one copy
            await session.rollback()
            # every transaction the session opens sets the copy again
            assert (await session.execute(select(func.current_setting(COPY_SETTING)))).scalar_one() == new_copy
            await session.rollback()
    finally:
        await dispose_engines()


async def test_kernel_sessions_refuse_to_run_without_a_copy(kernel_db):
    with pytest.raises(RuntimeError):
        await kernel_db.execute(select(Desk.desk_id))
    engine = create_engine(database_url("KERNEL"), poolclass=NullPool)
    try:
        with KernelSession(engine) as session, pytest.raises(RuntimeError):
            session.add(Copy(copy_id=f"copy-{uuid4().hex}"))
            session.flush()
    finally:
        engine.dispose()
    with pytest.raises(ValueError):
        KernelRepo("")


def token_hash(copy_id: str) -> str:
    """The secret_hash of the visitor session `committed_copies` opens in a copy."""
    return hashlib.sha256(f"token-{copy_id}".encode()).hexdigest()


@pytest.fixture
def committed_copies(admin):
    """Two new copies, each with a Desk, a visitor session and a document, removed afterwards.

    desk_admin, the superuser that owns the tables, isn't subject to row security."""
    copies = (f"copy-{uuid4().hex}", f"copy-{uuid4().hex}")
    try:
        for copy_id in copies:
            admin.execute("INSERT INTO kernel.copies (copy_id) VALUES (%s)", (copy_id,))
            admin.execute("INSERT INTO kernel.desks (desk_id, copy_id, business_id, name, slug)"
                          " VALUES (%s, %s, 'biz', 'Main line', %s)", (f"desk-{copy_id}", copy_id, f"slug-{copy_id}"))
            admin.execute("INSERT INTO kernel.sessions (session_id, copy_id, desk_id, kind, secret_hash)"
                          " VALUES (%s, %s, %s, 'visitor', %s)",
                          (f"session-{copy_id}", copy_id, f"desk-{copy_id}", token_hash(copy_id)))
            admin.execute("INSERT INTO kernel.documents (document_id, copy_id, desk_id, title, body, canary)"
                          " VALUES (%s, %s, %s, 'Warranty', 'private body', 'canary')",
                          (f"doc-{copy_id}", copy_id, f"desk-{copy_id}"))
        yield copies
    finally:
        for table in ("decisions", "documents", "sessions", "desks", "copies"):
            admin.execute(f"DELETE FROM kernel.{table} WHERE copy_id = ANY(%s)", (list(copies),))


def visible(conn: psycopg.Connection, relation: str, copies: tuple[str, ...]) -> set[str]:
    rows = conn.execute(f"SELECT copy_id FROM {relation} WHERE copy_id = ANY(%s)", (list(copies),)).fetchall()
    return {copy_id for (copy_id,) in rows}


def test_kernel_sees_nothing_without_a_copy(committed_copies):
    copy_a, _ = committed_copies
    with connect("KERNEL") as kernel:
        assert visible(kernel, "kernel.desks", committed_copies) == set()   # never set: current_setting is NULL
        with kernel.transaction(force_rollback=True):
            kernel.execute("SELECT set_config('desk.copy_id', %s, true)", (copy_a,))
            assert visible(kernel, "kernel.desks", committed_copies) == {copy_a}
            assert visible(kernel, "kernel.documents", committed_copies) == {copy_a}
        # after a transaction that set it, the setting reads '' rather than NULL: still nothing
        assert kernel.execute("SELECT current_setting('desk.copy_id', true)").fetchone()[0] == ""
        assert visible(kernel, "kernel.desks", committed_copies) == set()
        with pytest.raises(psycopg.errors.InsufficientPrivilege), kernel.transaction():
            kernel.execute("INSERT INTO kernel.copies (copy_id) VALUES ('')")   # '' never matches a copy


def test_api_reads_kernel_ro_for_its_copy_only(committed_copies, api):
    copy_a, copy_b = committed_copies
    assert visible(api, "kernel_ro.desks", committed_copies) == set()
    for copy_id in (copy_a, copy_b):
        with api.transaction(force_rollback=True):
            api.execute("SELECT set_config('desk.copy_id', %s, true)", (copy_id,))
            for view in ("desks", "documents"):
                assert visible(api, f"kernel_ro.{view}", committed_copies) == {copy_id}, view
    # the API's sessions set the copy they're bound to (taken from /whoami) at every transaction
    engine = create_engine(database_url("API"), poolclass=NullPool)
    try:
        with CopySession(engine) as session:
            query = text("SELECT copy_id FROM kernel_ro.desks WHERE copy_id = ANY(:copies)")
            assert session.execute(query, {"copies": list(committed_copies)}).all() == []
            session.rollback()
            bind_copy(session, copy_b)
            assert session.execute(query, {"copies": list(committed_copies)}).all() == [(copy_b,)]
            session.rollback()
    finally:
        engine.dispose()


# Lookups made before the copy is known (a session token, a public slug, every copy at startup)
# go through narrow SECURITY DEFINER resolvers that return only copy ids, and only the kernel
# may call them.

COPY_RESOLVERS = ("kernel.copy_of_session(text)", "kernel.copy_of_session_id(text)",
                  "kernel.copy_of_desk_slug(text)", "kernel.copy_of_decision_id(text)", "kernel.copy_ids()")


def test_copy_resolvers_are_narrow(admin):
    for resolver in COPY_RESOLVERS:
        definer, volatility, language, config, returns, owner = admin.execute(
            "SELECT p.prosecdef, p.provolatile, l.lanname, p.proconfig, pg_get_function_result(p.oid),"
            " pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
            " WHERE p.oid = %s::regprocedure",
            (resolver,),
        ).fetchone()
        assert (definer, volatility, language) == (True, "s", "sql"), resolver
        assert config == ["search_path=pg_catalog, kernel, pg_temp"], resolver   # nothing a caller creates is found
        assert returns in ("text", "SETOF text"), resolver                       # a copy id, never a row
        assert owner == "desk_resolver", resolver
        executes = {role for role in (*ROLES, "public")
                    if has(admin, "has_function_privilege", role, resolver, "EXECUTE")}
        assert executes == {"desk_kernel"}, resolver
    # their owner reads through row security, not around it, and only the columns a lookup needs
    attributes = admin.execute("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'desk_resolver'")
    assert attributes.fetchone() == (False, False, False)
    assert column_readers(admin, "desk_resolver") == RESOLVER_READS


async def test_copy_resolvers_find_a_copy_before_it_is_bound(admin, committed_copies):
    for copy_id in committed_copies:   # a decision of each copy's visitor session
        admin.execute(
            "INSERT INTO kernel.decisions (decision_id, copy_id, desk_id, session_id, generation, call_id,"
            " call_sha256, tool, outcome, state, policy_version, reason_plain, visitor_plain, expires_at, ledger_seq)"
            " VALUES (%s, %s, %s, %s, 0, 'call-1', '', 'native.quote', 'refuse', 'refused', 1, '', '', now(), 1)",
            (f"dec-{copy_id}", copy_id, f"desk-{copy_id}", f"session-{copy_id}"))
    try:
        for copy_id in committed_copies:
            assert await resolve_copy("copy_of_session", token_hash(copy_id)) == copy_id
            assert await resolve_copy("copy_of_session_id", f"session-{copy_id}") == copy_id
            assert await resolve_copy("copy_of_desk_slug", f"slug-{copy_id}") == copy_id
            assert await resolve_copy("copy_of_decision_id", f"dec-{copy_id}") == copy_id
        assert await resolve_copy("copy_of_session", "0" * 64) is None
        assert await resolve_copy("copy_of_session_id", "no-such-session") is None
        assert await resolve_copy("copy_of_desk_slug", "no-such-desk") is None
        assert await resolve_copy("copy_of_decision_id", "no-such-decision") is None
        assert set(committed_copies) <= set(await copy_ids())
        with pytest.raises(ValueError):
            await resolve_copy("copy_of_anything", "x")
    finally:
        await dispose_engines()
    with connect("KERNEL") as kernel:
        # the same lookups made directly still find nothing: no copy is set
        assert visible(kernel, "kernel.sessions", committed_copies) == set()
        assert visible(kernel, "kernel.copies", committed_copies) == set()
        assert kernel.execute("SELECT kernel.copy_of_session(%s)", (token_hash(committed_copies[0]),)).fetchone() == (
            committed_copies[0],)


def test_only_the_kernel_runs_the_copy_resolvers(committed_copies):
    for prefix in ("API", "MOCKPAY"):
        with connect(prefix) as conn:
            for call in ("kernel.copy_of_session(%s)", "kernel.copy_of_session_id(%s)",
                         "kernel.copy_of_desk_slug(%s)", "kernel.copy_of_decision_id(%s)"):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(f"SELECT {call}", (token_hash(committed_copies[0]),))
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute("SELECT kernel.copy_ids()")
