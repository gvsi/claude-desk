"""Handoffs: at most one open handoff per chat, held by the table (issue #257).

Since #238 the kernel keeps one open handoff per session in its own code, under the session row: a call-back request
closes the session's open handoffs before it opens its own, and the handoff card opens one only while none is open.
The release serving now runs that code, so no kernel still inserts a second open handoff for a session, and this
revision has the table hold the rule too: `handoffs_one_open_per_session`, a partial unique index on `(copy_id,
session_id)` over `status = 'open'`. A session ID may repeat across copies, so the copy is part of the key, and a row
with no session is no chat. `handoffs_open_by_session` (01b_2b_handoff_kind) stays: it serves each reply check's look
for the session's open handoffs, and dropping it would be a change of its own, once a query plan shows the new index
serves that look.

Rows from before #238 may still hold several open handoffs for one session, so first, in the same transaction, the
revision consolidates them (`CONSOLIDATE`):

- It keeps the session's most recent call-back request, with its details and window, or, with no call-back open, its
  most recent card handoff. Most recent is the latest `created_at` (the kernel's time, null on rows from before
  01b_2b_handoff_kind, which count as older), then the latest call-back action's `created_at` (when the kernel
  decided the request: every call-back names its action, so it orders the rows from before), then the highest handoff
  ID: random, but stable, so a rerun keeps the same row.
- The others go `superseded`, not `done`, so nothing reads them as closed by the owner: the owner's view lists only
  `open` handoffs, and a conversation's outcome counts only `done` call-backs as called back. Each names the handoff
  kept in `superseded_by`, a new nullable column, so a later kernel change can ledger each closing on the Desk's
  signed ledger. The owner's mark of done on one answers 409, as on a handoff already done.
- Only their `handoff:<id>` facts expire (`committed` to `expired`, as a call-back's closing expires them); the kept
  handoff's fact stays.

**Forced row security.** Every kernel table forces row security, with policies for desk_kernel (the rows of the
transaction's copy) and the read-only roles alone (0002_copy_isolation, 0005_kernel_ro_owner), and a managed
Postgres's admin owns the tables without being a superuser or bypassing row security, so its own SELECT or UPDATE sees
no row. The revision finds the crowded sessions across copies as the table's owner, then consolidates each copy as
desk_kernel:

- It switches `kernel.handoffs`'s forcing off while it consolidates (`NO FORCE ROW LEVEL SECURITY`), so the admin, the
  table's owner, finds the copies holding a crowded session (`CROWDED_COPIES`), and on again after, only if it was
  on, so the table ends exactly as secured as it started. This costs no lock the revision doesn't hold anyway
  (below), and no other transaction ever sees the table unforced: the change commits with the forcing back on, or
  rolls back with it.
- It consolidates each such copy as desk_kernel, under that copy's policy, with the copy set in `desk.copy_id`:
  desk_kernel is the role that writes handoffs and facts and reads actions. The admin is lent SET on desk_kernel for
  these statements only, as `_change_owner` lends SET on desk_ro_owner (0005_kernel_ro_owner), and the loan is taken
  back after, with the role and copy the transaction had before. Switching the forcing of `kernel.facts`, which every
  reply check reads, or of `kernel.actions` off instead would hold each ACCESS EXCLUSIVE until the commit.

**Locks.** `desk.ops.admin` migrates in one transaction, so `CREATE INDEX CONCURRENTLY` isn't available, and the
consolidation and the index must commit together anyway. The revision first takes `kernel.handoffs` ACCESS EXCLUSIVE,
which adding the column and switching its forcing each need; building the index needs only SHARE, which that lock
covers. So no insert can slip in between the consolidation and the index, and no lock is raised midway. Reads of the
table, the kernel's and the API's view's, wait for the commit, which is short: the table is small and only the
crowded sessions' rows change. `kernel.actions` is only read (ACCESS SHARE), and `kernel.facts` takes ROW EXCLUSIVE
with row locks on the facts it expires. Each lock waits at most `LOCK_TIMEOUT`, so behind a long transaction of the
live service the migration fails fast, the deploy stops and the previous release goes on serving, rather than
queueing the service's queries behind the wait. The revision sets the caller's lock timeout back at its end, for any
revision after it in the transaction. A failure anywhere rolls the whole migration back, every row and the table's
forcing as they were.

**Down.** The downgrade drops the index and `superseded_by`, and never reopens a superseded handoff, which could bring
the duplicates back; the release before this one reads only `open` handoffs as waiting and only `done` ones as called
back, so a `superseded` one is neither. On the live database the way back is a roll-forward (`docs/deploy.md`,
"Rollback and teardown"). Like the revisions before it, the upgrade runs again over what it added.

Revision ID: kernel_one_open_handoff
Revises: 09_business_tools_view
"""

from typing import Any

from alembic import op

revision = "kernel_one_open_handoff"
down_revision = "09_business_tools_view"
branch_labels = None
depends_on = None

LOCK_TIMEOUT = "5s"          # the longest any lock of this revision's waits
INDEX = "handoffs_one_open_per_session"

# The copies holding a session with several open handoffs, read as the table's owner with its forcing off.
CROWDED_COPIES = """
    SELECT DISTINCT copy_id FROM kernel.handoffs WHERE status = 'open' AND session_id IS NOT NULL
    GROUP BY copy_id, session_id HAVING count(*) > 1 ORDER BY copy_id
"""

# In one copy, as desk_kernel under its policy: each session's open handoffs, the one to keep first; the others
# superseded, naming it; and only their committed facts expired.
CONSOLIDATE = """
    WITH ranked AS (
        SELECT h.handoff_id, first_value(h.handoff_id) OVER chat AS kept, row_number() OVER chat AS place
        FROM kernel.handoffs h
        LEFT JOIN kernel.actions a ON h.kind = 'callback' AND a.action_id = h.action_id
        WHERE h.status = 'open' AND h.session_id IS NOT NULL
        WINDOW chat AS (PARTITION BY h.copy_id, h.session_id
                        ORDER BY h.kind = 'callback' DESC, h.created_at DESC NULLS LAST, a.created_at DESC NULLS LAST,
                                 h.handoff_id DESC)
    ), superseded AS (
        UPDATE kernel.handoffs h SET status = 'superseded', superseded_by = ranked.kept
        FROM ranked WHERE h.handoff_id = ranked.handoff_id AND ranked.place > 1
        RETURNING h.desk_id, h.handoff_id
    )
    UPDATE kernel.facts f SET status = 'expired'
    FROM superseded WHERE f.desk_id = superseded.desk_id AND f.fact_id = 'handoff:' || superseded.handoff_id
        AND f.status = 'committed'
"""


def _driver() -> Any:
    """The migration's connection (psycopg), inside its transaction."""
    return op.get_bind().connection.driver_connection


def _run(sql: str, params: tuple[str, ...] | None = None) -> list[tuple]:
    """One statement with parameters, or a script of several without; the rows it returns, if any."""
    cursor = _driver().execute(sql, params)
    return cursor.fetchall() if cursor.description else []


def _setting(name: str) -> str:
    """The transaction's value of a setting; '' for a custom one never set."""
    return _run("SELECT coalesce(current_setting(%s, true), '')", (name,))[0][0]


def _set(name: str, value: str) -> None:
    """A setting for the rest of the transaction (`SET LOCAL`), which a rollback takes back."""
    _run("SELECT set_config(%s, %s, true)", (name, value))


def _consolidate() -> None:
    """Supersedes every crowded session's open handoffs but one, in every copy (the module docstring)."""
    [(forced,)] = _run("SELECT relforcerowsecurity FROM pg_class WHERE oid = 'kernel.handoffs'::regclass")
    if forced:
        _run("ALTER TABLE kernel.handoffs NO FORCE ROW LEVEL SECURITY")
    copies = [copy_id for (copy_id,) in _run(CROWDED_COPIES)]
    if copies:
        role, copy = _setting("role"), _setting("desk.copy_id")
        _run("GRANT desk_kernel TO CURRENT_USER WITH INHERIT FALSE, SET TRUE")
        _set("role", "desk_kernel")
        for copy_id in copies:
            _set("desk.copy_id", copy_id)
            _run(CONSOLIDATE)
        _set("role", role)
        _set("desk.copy_id", copy)
        _run("REVOKE desk_kernel FROM CURRENT_USER")
    if forced:
        _run("ALTER TABLE kernel.handoffs FORCE ROW LEVEL SECURITY")


def upgrade() -> None:
    timeout = _setting("lock_timeout")
    _set("lock_timeout", LOCK_TIMEOUT)
    _run("LOCK TABLE kernel.handoffs IN ACCESS EXCLUSIVE MODE")
    _run("ALTER TABLE kernel.handoffs ADD COLUMN IF NOT EXISTS superseded_by text")
    _consolidate()
    _run(f"CREATE UNIQUE INDEX IF NOT EXISTS {INDEX} ON kernel.handoffs (copy_id, session_id) WHERE status = 'open'")
    _set("lock_timeout", timeout)


def downgrade() -> None:
    timeout = _setting("lock_timeout")
    _set("lock_timeout", LOCK_TIMEOUT)
    _run("LOCK TABLE kernel.handoffs IN ACCESS EXCLUSIVE MODE")
    _run(f"DROP INDEX IF EXISTS kernel.{INDEX}")
    _run("ALTER TABLE kernel.handoffs DROP COLUMN IF EXISTS superseded_by")
    _set("lock_timeout", timeout)
