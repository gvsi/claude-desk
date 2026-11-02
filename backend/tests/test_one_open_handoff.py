"""At most one open handoff per chat, held by the database (revision `kernel_one_open_handoff`, issue #257).

The kernel has kept one open handoff per session in its own code since #238; this revision makes the table hold the
rule too, with a partial unique index on `(copy_id, session_id)` over open rows, after consolidating the sessions
that rows from before #238 left holding several. Each test runs in a scratch database of the module's own, next to the
suite's (`tests.test_db.new_scratch`), and leaves it at head.
"""

import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from desk.db.session import libpq_url
from tests.test_db import Scratch, alembic_config, columns, connect, new_scratch

REVISION = "kernel_one_open_handoff"
INDEX = "handoffs_one_open_per_session"
BEFORE = ScriptDirectory.from_config(alembic_config()).get_revision(REVISION).down_revision
T0 = datetime(2026, 10, 29, 9, tzinfo=UTC)
COPIES = ("copy-merge-a", "copy-merge-b")


@pytest.fixture(scope="module")
def scratch() -> Iterator[Scratch]:
    with connect("ADMIN") as admin, new_scratch(admin) as made:
        made.migrate(command.upgrade, "head")
        yield made


def handoff(conn: psycopg.Connection, handoff_id: str, copy_id: str, session_id: str | None, *,
            kind: str = "callback", status: str = "open", created_at: datetime | None = None,
            action_id: str | None = None) -> None:
    """A handoff row: a call-back names its action (`act-<handoff_id>` unless given), a card names itself."""
    action_id = handoff_id if kind == "card" else action_id or f"act-{handoff_id}"
    conn.execute("INSERT INTO kernel.handoffs (handoff_id, copy_id, desk_id, session_id, reason, status, kind,"
                 " action_id, created_at) VALUES (%s, %s, %s, %s, 'Sam Lee', %s, %s, %s, %s)",
                 (handoff_id, copy_id, f"desk-{copy_id}", session_id, status, kind, action_id, created_at))


def test_a_chat_holds_at_most_one_open_handoff(scratch):
    """The table refuses a second open handoff for a session of a copy. The same session ID in another copy is
    another chat, a handoff no longer open leaves room for the next, and a row with no session is no chat."""
    admin = scratch.conn
    assert admin.execute("SELECT indexdef FROM pg_indexes WHERE schemaname = 'kernel' AND indexname = %s",
                         (INDEX,)).fetchone() == (
        f"CREATE UNIQUE INDEX {INDEX} ON kernel.handoffs USING btree (copy_id, session_id)"
        " WHERE (status = 'open'::text)",)
    try:
        handoff(admin, "handoff-first", "copy-index-a", "session-1")
        with pytest.raises(psycopg.errors.UniqueViolation):
            handoff(admin, "handoff-second", "copy-index-a", "session-1", kind="card")
        handoff(admin, "handoff-elsewhere", "copy-index-b", "session-1")          # another copy's chat
        for status in ("done", "superseded"):
            handoff(admin, f"handoff-{status}", "copy-index-a", "session-1", status=status)
        admin.execute("UPDATE kernel.handoffs SET status = 'done' WHERE handoff_id = 'handoff-first'")
        handoff(admin, "handoff-next", "copy-index-a", "session-1")               # once the first is closed
        handoff(admin, "handoff-no-chat-1", "copy-index-a", None)
        handoff(admin, "handoff-no-chat-2", "copy-index-a", None)
    finally:
        admin.execute("DELETE FROM kernel.handoffs WHERE copy_id LIKE 'copy-index-%'")


@dataclass(frozen=True)
class Legacy:
    """A handoff written before the revision, and what its upgrade leaves of it."""

    handoff_id: str
    session_id: str | None
    kind: str = "callback"
    created: int | None = None       # its `created_at`, minutes after T0; None on a row from before that column
    asked: int | None = None         # a call-back's action's `created_at`, minutes after T0; None for no action row
    fact: str | None = None          # its `handoff:<id>` fact's status, if it has one
    status: str = "open"
    copy_id: str = "copy-merge-a"
    kept: str | None = None          # the handoff the upgrade supersedes it by, if it does
    fact_after: str | None = None    # its fact's status after the upgrade, when that changes


LEGACY = (
    # a call-back request beats a newer card handoff
    Legacy("handoff-callback-older", "session-card", created=10, asked=9, fact="committed"),
    Legacy("handoff-card-newer", "session-card", kind="card", created=20, kept="handoff-callback-older"),
    # the newest call-back wins, and only the superseded one's fact expires
    Legacy("handoff-callback-1", "session-two", created=10, asked=9, fact="committed", kept="handoff-callback-2",
           fact_after="expired"),
    Legacy("handoff-callback-2", "session-two", created=20, asked=19, fact="committed"),
    # a row from before `created_at` counts as older, however late its action
    Legacy("handoff-undated", "session-undated", asked=30, fact="committed", kept="handoff-dated",
           fact_after="expired"),
    Legacy("handoff-dated", "session-undated", created=10, asked=9, fact="committed"),
    # between rows from before `created_at`, the later request wins whatever the IDs; a fact already expired stays so
    Legacy("handoff-z-asked-first", "session-asked", asked=1, fact="expired", kept="handoff-a-asked-last"),
    Legacy("handoff-a-asked-last", "session-asked", asked=2, fact="committed"),
    # two card handoffs of the same time: the higher ID
    Legacy("handoff-card-a", "session-tie", kind="card", created=10, kept="handoff-card-b"),
    Legacy("handoff-card-b", "session-tie", kind="card", created=10),
    # three open: both others name the one kept
    Legacy("handoff-three-card-1", "session-three", kind="card", created=1, kept="handoff-three-callback"),
    Legacy("handoff-three-card-2", "session-three", kind="card", created=2, kept="handoff-three-callback"),
    Legacy("handoff-three-callback", "session-three", asked=0, fact="committed"),
    # one open and one done: nothing to consolidate
    Legacy("handoff-alone", "session-alone", created=1, asked=0, fact="committed"),
    Legacy("handoff-done", "session-alone", created=5, asked=4, fact="expired", status="done"),
    # rows with no session are no chat
    Legacy("handoff-no-chat-1", None, kind="card", created=1),
    Legacy("handoff-no-chat-2", None, kind="card", created=2),
    # another copy: a crowded session of its own is consolidated, and its one open handoff in a session ID copy A
    # crowds is left alone
    Legacy("handoff-b-older", "session-b", created=1, asked=0, fact="committed", copy_id="copy-merge-b",
           kept="handoff-b-newer", fact_after="expired"),
    Legacy("handoff-b-newer", "session-b", created=2, asked=1, fact="committed", copy_id="copy-merge-b"),
    Legacy("handoff-b-single", "session-two", created=1, asked=0, fact="committed", copy_id="copy-merge-b"),
)


def minutes(offset: int | None) -> datetime | None:
    return None if offset is None else T0 + timedelta(minutes=offset)


def write_legacy(conn: psycopg.Connection) -> None:
    """`LEGACY`'s rows, their actions and facts, and a fact of the Desk's no handoff names."""
    for row in LEGACY:
        handoff(conn, row.handoff_id, row.copy_id, row.session_id, kind=row.kind, status=row.status,
                created_at=minutes(row.created))
        desk_id = f"desk-{row.copy_id}"
        if row.asked is not None:
            conn.execute("INSERT INTO kernel.actions (action_id, copy_id, desk_id, session_id, generation, tool,"
                         " effects, resource_kind, created_at, args_json, args_sha256, profile_sha256, resource)"
                         " VALUES (%s, %s, %s, %s, 0, 'native.request_callback', '[\"change\"]', 'desk', %s, '{}',"
                         " 'a', 'p', %s)", (f"act-{row.handoff_id}", row.copy_id, desk_id, row.session_id,
                                            minutes(row.asked), f'{{"kind": "desk", "id": "{desk_id}"}}'))
        if row.fact is not None:
            conn.execute("INSERT INTO kernel.facts (desk_id, fact_id, copy_id, kind, status, claims)"
                         " VALUES (%s, %s, %s, 'handoff', %s, '[]')",
                         (desk_id, f"handoff:{row.handoff_id}", row.copy_id, row.fact))
    conn.execute("INSERT INTO kernel.facts (desk_id, fact_id, copy_id, kind, status, claims)"
                 " VALUES ('desk-copy-merge-a', 'charter:hours', 'copy-merge-a', 'charter', 'committed', '[]')")


def remove_legacy(conn: psycopg.Connection) -> None:
    for table in ("handoffs", "actions", "facts"):
        conn.execute(f"DELETE FROM kernel.{table} WHERE copy_id = ANY(%s)", (list(COPIES),))


def handoffs_now(conn: psycopg.Connection) -> dict[str, tuple]:
    """Each of `LEGACY`'s handoffs: its status and, once the column exists, the handoff it is superseded by."""
    has_column = conn.execute("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'kernel'"
                              " AND table_name = 'handoffs' AND column_name = 'superseded_by'").fetchone() == (1,)
    kept = "superseded_by" if has_column else "NULL"
    rows = conn.execute(f"SELECT handoff_id, status, {kept} FROM kernel.handoffs WHERE copy_id = ANY(%s)",
                        (list(COPIES),)).fetchall()
    return {handoff_id: (status, superseded_by) for handoff_id, status, superseded_by in rows}


def facts_now(conn: psycopg.Connection) -> dict[str, str]:
    return dict(conn.execute("SELECT fact_id, status FROM kernel.facts WHERE copy_id = ANY(%s)",
                             (list(COPIES),)).fetchall())


def as_written() -> tuple[dict[str, tuple], dict[str, str]]:
    return ({row.handoff_id: (row.status, None) for row in LEGACY},
            {**{f"handoff:{row.handoff_id}": row.fact for row in LEGACY if row.fact}, "charter:hours": "committed"})


def consolidated() -> tuple[dict[str, tuple], dict[str, str]]:
    """What the upgrade leaves of `LEGACY`: each crowded session's kept handoff open, the others superseded by it."""
    return ({row.handoff_id: ("superseded", row.kept) if row.kept else (row.status, None) for row in LEGACY},
            {**{f"handoff:{row.handoff_id}": row.fact_after or row.fact for row in LEGACY if row.fact},
             "charter:hours": "committed"})


def security(conn: psycopg.Connection) -> tuple[list, list, list]:
    """How the tables the revision touches are secured: their row security, their policies, and who may act as
    desk_kernel."""
    tables = ["handoffs", "facts", "actions"]
    forced = conn.execute("SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner)"
                          " FROM pg_class WHERE relnamespace = 'kernel'::regnamespace AND relname = ANY(%s)"
                          " ORDER BY relname", (tables,)).fetchall()
    policies = conn.execute("SELECT tablename, policyname, roles, cmd, permissive, qual, with_check FROM pg_policies"
                            " WHERE schemaname = 'kernel' AND tablename = ANY(%s) ORDER BY tablename, policyname",
                            (tables,)).fetchall()
    members = conn.execute("SELECT member::regrole::text, admin_option, inherit_option, set_option"
                           " FROM pg_auth_members WHERE roleid = 'desk_kernel'::regrole ORDER BY 1").fetchall()
    return forced, policies, members


def test_the_upgrade_leaves_one_open_handoff_per_chat(scratch):
    """Each session that rows from before hold several open handoffs in keeps one: its most recent call-back request,
    else its most recent card handoff, by `created_at`, rows from before it counting as older, then by when the
    call-back was requested, then by ID. The others are superseded, each naming the one kept, and only their facts
    expire. Other copies, done rows and rows with no session are left as they were, and the tables end as secured as
    they started."""
    admin = scratch.conn
    scratch.migrate(command.downgrade, BEFORE)
    try:
        write_legacy(admin)
        secured = security(admin)
        scratch.migrate(command.upgrade, "head")
        assert (handoffs_now(admin), facts_now(admin)) == consolidated()
        assert security(admin) == secured
    finally:
        remove_legacy(admin)
        scratch.migrate(command.upgrade, "head")


MIGRATOR = "desk_test_handoffs_migrator"
SETTINGS = ("role", "lock_timeout", "desk.copy_id")


def settings(conn: psycopg.Connection) -> list[str | None]:
    return [conn.execute("SELECT current_setting(%s, true)", (name,)).fetchone()[0] for name in SETTINGS]


def test_the_consolidation_runs_as_an_owner_bound_by_row_security(scratch, monkeypatch):
    """On a managed Postgres the admin owns the kernel tables but is neither SUPERUSER nor BYPASSRLS, so under their
    forced row security its own reads see no row. Run as such an owner, which may grant desk_kernel as the admin that
    created it may, the revision still consolidates every copy, takes back the desk_kernel it lent itself, and leaves
    the table forced and the transaction's role, lock timeout and copy as they were. It all runs in a transaction
    that is rolled back, the stand-in owner included."""
    module = ScriptDirectory.from_config(alembic_config()).get_revision(REVISION).module
    admin = scratch.conn
    monkeypatch.setattr(module, "_driver", lambda: admin)
    scratch.migrate(command.downgrade, BEFORE)
    try:
        with admin.transaction(force_rollback=True):
            write_legacy(admin)
            secured = security(admin)
            admin.execute(f"CREATE ROLE {MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS")
            admin.execute(f"GRANT USAGE, CREATE ON SCHEMA kernel TO {MIGRATOR}")     # the admin owns the schema
            # what Postgres 16 gives a CREATEROLE admin on the roles it creates: ADMIN, without INHERIT or SET
            admin.execute(f"GRANT desk_kernel TO {MIGRATOR} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE")
            admin.execute(f"ALTER TABLE kernel.handoffs OWNER TO {MIGRATOR}")
            admin.execute(f"SET LOCAL ROLE {MIGRATOR}")
            admin.execute("SET LOCAL lock_timeout = '17s'")
            admin.execute("SELECT set_config('desk.copy_id', 'copy-elsewhere', true)")
            assert admin.execute("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
                                 ).fetchone() == (False, False)
            assert admin.execute("SELECT count(*) FROM kernel.handoffs").fetchone() == (0,)   # it sees no row
            before = settings(admin)
            module.upgrade()
            assert settings(admin) == before == [MIGRATOR, "17s", "copy-elsewhere"]
            admin.execute("RESET ROLE")
            assert (handoffs_now(admin), facts_now(admin)) == consolidated()
            forced, policies, members = security(admin)
            assert [row[:3] for row in forced] == [row[:3] for row in secured[0]]        # still forced
            assert [owner for *_, owner in forced] == ["desk_admin", "desk_admin", MIGRATOR]
            assert policies == secured[1]
            assert [member for member in members if member[0] == MIGRATOR] == [(MIGRATOR, True, False, False)]
    finally:
        scratch.migrate(command.upgrade, "head")


def revision_now(conn: psycopg.Connection) -> list[tuple]:
    return conn.execute("SELECT version_num FROM alembic_version").fetchall()


def index_count(conn: psycopg.Connection) -> int:
    return conn.execute("SELECT count(*) FROM pg_indexes WHERE schemaname = 'kernel' AND indexname = %s",
                        (INDEX,)).fetchone()[0]


def test_a_failure_mid_migration_leaves_everything_as_it_was(scratch):
    """A failure partway through, here the first expiry of a superseded handoff's fact, once the column is added,
    the table's forcing switched off and desk_kernel lent, rolls the whole upgrade back: every row as written, no
    column or index, the tables as secured as before, and the database still at the revision before."""
    admin = scratch.conn
    scratch.migrate(command.downgrade, BEFORE)
    try:
        write_legacy(admin)
        secured = security(admin)
        admin.execute("CREATE FUNCTION public.fail_handoff_migration() RETURNS trigger LANGUAGE plpgsql"
                      " AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$")
        admin.execute("CREATE TRIGGER fail_handoff_migration BEFORE UPDATE ON kernel.facts"
                      " FOR EACH ROW EXECUTE FUNCTION public.fail_handoff_migration()")
        with pytest.raises(psycopg.errors.RaiseException, match="injected failure"):
            scratch.migrate(command.upgrade, "head")
        assert revision_now(admin) == [(BEFORE,)]
        assert (handoffs_now(admin), facts_now(admin)) == as_written()
        assert "superseded_by" not in columns(admin, "kernel", "handoffs") and index_count(admin) == 0
        assert security(admin) == secured
    finally:
        admin.execute("DROP TRIGGER IF EXISTS fail_handoff_migration ON kernel.facts")
        admin.execute("DROP FUNCTION IF EXISTS public.fail_handoff_migration()")
        remove_legacy(admin)
        scratch.migrate(command.upgrade, "head")


def test_a_downgrade_reopens_nothing_and_the_upgrade_runs_again_clean(scratch):
    """The downgrade drops the index and `superseded_by`, and leaves each superseded handoff superseded, so no
    duplicate comes back. The upgrade then runs again over what the first one left, consolidating only a session
    crowded since, and runs again over what it added."""
    admin = scratch.conn
    scratch.migrate(command.downgrade, BEFORE)
    try:
        write_legacy(admin)
        scratch.migrate(command.upgrade, "head")
        left, facts = consolidated()
        scratch.migrate(command.downgrade, BEFORE)
        assert "superseded_by" not in columns(admin, "kernel", "handoffs") and index_count(admin) == 0
        assert handoffs_now(admin) == {handoff_id: (status, None) for handoff_id, (status, _) in left.items()}
        assert facts_now(admin) == facts
        # crowded again while down, as the release before could never make it
        handoff(admin, "handoff-callback-3", "copy-merge-a", "session-two", created_at=minutes(30))
        scratch.migrate(command.upgrade, "head")
        again = {handoff_id: (status, None) for handoff_id, (status, _) in left.items()}
        again |= {"handoff-callback-2": ("superseded", "handoff-callback-3"), "handoff-callback-3": ("open", None)}
        assert handoffs_now(admin) == again
        assert facts_now(admin) == {**facts, "handoff:handoff-callback-2": "expired"}
        scratch.migrate(command.stamp, BEFORE)                    # again, over its own column and index
        scratch.migrate(command.upgrade, "head")
        assert handoffs_now(admin) == again and index_count(admin) == 1
    finally:
        remove_legacy(admin)
        scratch.migrate(command.upgrade, "head")


def test_a_lock_the_live_service_holds_fails_the_upgrade_fast(scratch):
    """Behind a transaction that holds `kernel.handoffs`, the upgrade gives up after its own short lock timeout,
    however long the caller would wait, and rolls back, rather than queueing the service's queries behind it. Were
    the timeout gone, the stray would be ended after `IDLE_STRAY` and the upgrade would pass, failing this test
    rather than hanging the run."""
    admin = scratch.conn
    scratch.migrate(command.downgrade, BEFORE)
    try:
        with psycopg.connect(libpq_url(scratch.url.render_as_string(hide_password=False))) as stray:
            stray.execute("SET idle_in_transaction_session_timeout = '30s'")
            stray.execute("LOCK TABLE kernel.handoffs IN ACCESS SHARE MODE")
            started = time.monotonic()
            with pytest.raises(psycopg.errors.LockNotAvailable, match="lock timeout"):
                migrate_waiting(scratch, "0")                        # the caller would wait for ever
            assert time.monotonic() - started < 20
            stray.rollback()
        assert revision_now(admin) == [(BEFORE,)]
    finally:
        scratch.migrate(command.upgrade, "head")


def migrate_waiting(scratch: Scratch, lock_timeout: str) -> None:
    """`Scratch.migrate` to head with the caller's lock timeout `lock_timeout`, in one transaction."""
    engine = create_engine(scratch.url, poolclass=NullPool)
    try:
        with engine.begin() as connection:
            connection.execute(text(f"SET LOCAL lock_timeout = '{lock_timeout}'"))
            config = alembic_config()
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
    finally:
        engine.dispose()
