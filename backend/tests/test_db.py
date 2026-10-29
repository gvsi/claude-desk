"""Database schemas, roles and grants (master plan, "Data model and database roles").

These tests run against the local Postgres (`docker compose up -d db`) after
`cd backend && uv run alembic upgrade head && cd .. && make db-roles`. Introspection runs as
desk_admin; privilege checks connect as the role under test. Every write is rolled back.
"""

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import procrastinate
import psycopg
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import IntegrityError, StatementError
from sqlalchemy.orm import Session, aliased
from sqlalchemy.pool import NullPool

import desk.db
from desk.contracts import Claim, Review
from desk.db.models import (
    ActorSession,
    Approval,
    Base,
    Booking,
    Business,
    CalendarSlot,
    Decision,
    Desk,
    Fact,
    KnowledgeItem,
    LedgerEntry,
    PriceItem,
    Quote,
    Tool,
)
from desk.db.session import (
    KernelRepo,
    api_engine,
    database_url,
    dispose_engines,
    get_kernel_session,
    libpq_url,
    procrastinate_connector,
)
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


def test_kernel_ro_views_carry_copy_id(admin, api):
    assert views_in(admin, "kernel_ro") == set(KERNEL_RO_VIEWS)
    for view in KERNEL_RO_VIEWS:
        assert "copy_id" in columns(admin, "kernel_ro", view), view
        api.execute(f"SELECT copy_id FROM kernel_ro.{view} LIMIT 0")   # the API reads each one, filtered by copy


@pytest.fixture
def kernel_tx():
    """An ORM session as desk_kernel whose writes are rolled back."""
    engine = create_engine(database_url("KERNEL"), poolclass=NullPool)
    with Session(engine) as session:
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
    """An async session from get_kernel_session() whose writes are rolled back."""
    sessions = get_kernel_session()
    session = await anext(sessions)
    try:
        yield session
    finally:
        await session.rollback()
        await sessions.aclose()
        await dispose_engines()


async def test_kernel_repo_scopes_by_copy(kernel_db):
    copy_a, copy_b = f"copy-{uuid4().hex}", f"copy-{uuid4().hex}"
    kernel_db.add_all([
        Business(business_id=f"biz-{copy_b}", copy_id=copy_b, name="Rivera Plumbing",
                 owner_display_name="Maria Rivera", timezone="America/Los_Angeles"),
        Desk(desk_id=f"desk-{copy_a}", copy_id=copy_a, business_id=f"biz-{copy_b}", name="Main line",
             slug=f"slug-{copy_a}"),
        Desk(desk_id=f"desk-{copy_b}", copy_id=copy_b, business_id=f"biz-{copy_b}", name="Main line",
             slug=f"slug-{copy_b}"),
    ])
    await kernel_db.flush()
    repo = KernelRepo(copy_a)
    desks = (await kernel_db.scalars(repo.scoped(select(Desk)))).all()
    assert [d.desk_id for d in desks] == [f"desk-{copy_a}"]
    # every kernel table in a join is scoped: copy A's Desk pointing at copy B's business finds nothing
    joined = select(Desk, Business).join(Business, Desk.business_id == Business.business_id)
    assert (await kernel_db.execute(repo.scoped(joined))).all() == []
    other = aliased(Desk)
    pairs = select(Desk.desk_id, other.desk_id).join(other, other.business_id == Desk.business_id)
    assert (await kernel_db.execute(repo.scoped(pairs))).all() == [(f"desk-{copy_a}", f"desk-{copy_a}")]
    # and it fails closed on what it can't scope
    for unscopable in (
        select(text("1")),                                                   # no kernel table
        select(select(Desk).subquery()),                                     # a subquery
        select(Desk).join(select(Business).subquery(), text("true")),        # a kernel table joined to one
    ):
        with pytest.raises(ValueError):
            repo.scoped(unscopable)


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


# Requirements of the same section that the ten tests above don't reach: each role's full
# privileges, the data model's unique keys, and JSON columns that hold contracts.

DML = ("SELECT", "INSERT", "UPDATE", "DELETE")
SCHEMA_ACCESS = {   # the table privileges each role holds on every table or view of its schemas, and no others
    "desk_kernel": {"kernel": DML},
    "desk_api": {"app": DML, "procrastinate": DML, "kernel_ro": ("SELECT",)},
    "desk_mockpay": {"mockpay": DML},
}


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
                assert held == set(expected), (role, schema, relation)


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
