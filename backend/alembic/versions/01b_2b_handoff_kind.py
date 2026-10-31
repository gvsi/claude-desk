"""Handoffs: which kind each is, a call-back request or the handoff card's.

Until now only `native.request_callback` wrote a handoff. The kernel's handoff card now opens one
too (`reply_check.finalize`, the owner's decision of 2026-10-30), with no call-back window, so a
null window no longer tells the two apart. `kernel.handoffs` gains `kind`, `callback` or `card`,
NOT NULL. It defaults to `callback`, for the previous release's code, which writes call-backs
without naming a kind while it runs beside this one during a deploy; this release always names
it, and the check below keeps a default from ever passing for a card. The rows already there take
their kind from the row itself (below).

A session holds one open handoff, of either kind (`handoffs_one_open_per_session`, unique on the
session among open rows): a card shown while one is open opens none, and a call-back request makes
the open one its own. The index also serves the reply check's look for a session's open
handoffs, so no other is needed. Before this revision a session could hold several, from a
call-back request made more than once, so the upgrade first closes all but the first of them by
ID, as the owner's mark of done closes one, and expires their facts (`CLOSE_EXTRAS`). Those two
updates must see every row, which an admin under forced row security doesn't, so they run with
the force lifted on the two tables, as their owner, inside the migration's transaction, and the
force is put back before it ends: no other transaction sees the tables unforced, and a failure
rolls all of it back. The downgrade drops the index and reopens nothing.

A card's handoff has no action. `action_id` stays NOT NULL and unique: a card's names the
handoff's own id, which no action's id can equal (an action's id starts `act-`, a handoff's
`handoff-`), so a reconciliation that finds a call-back's handoff by its action never finds a
card's. A check holds the two together both ways (`handoffs_card_names_itself`): a row names
itself exactly when it is a card's, so each row's kind can always be read back from it.

The column joins kernel_ro.handoffs after `status`, as the master plan's "Data model" table lists
it, so the API and the web can tell a card's handoff from a call-back request with no time.
CREATE OR REPLACE VIEW would need the admin to own the view, so the view is dropped and created
again as 01b_3b_money_cap and 01b_5b_knowledge_view leave a view: a security_barrier view filtered
on the transaction's `desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the view's
columns, and readable by desk_api alone. Dropping without CASCADE fails if anything depends on it.

The kind is never written by an UPDATE: an UPDATE or SELECT runs under the table's forced row
security, which a managed Postgres's admin doesn't bypass, so it would see no row. The downgrade
deletes nothing, since a card's handoff written meanwhile is a valid row without the column, and
the upgrade reads every row's kind back from it: after adding the column it rewrites it (`ALTER
COLUMN ... TYPE ... USING`, `KIND_OF_ROW`), which reads each row whoever runs it, a card's being
one that names itself. Rows from before the first upgrade are call-back requests, whose
`action_id` is their action's, so they read as `callback`, and a downgrade and upgrade keep both
kinds. Refusing the downgrade while card rows exist was passed over: the admin can't see them
to count them under forced row security, and the refusal would block a rollback that loses
nothing.

Any admin role can run this, superuser or not (a managed Postgres's admin isn't): the admin owns
the tables, so it may rewrite the column and lift and put back the force on their row security;
the grants run while the admin owns the view; the admin
owns kernel_ro, so it may drop the view; then `_change_owner` lends the admin SET on
desk_ro_owner, and desk_ro_owner CREATE on the schema, for the ownership change alone, and takes
both back. Like the revisions before it, it runs again over what it added: the view, which
selects the column once the revision has run, is dropped before the column is rewritten and
created again after.

Revision ID: 01b_2b_handoff_kind
Revises: 01c_5_mandate_reservations
"""

from alembic import op

revision = "01b_2b_handoff_kind"
down_revision = "01c_5_mandate_reservations"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# The view's columns before and after this revision, frozen here.
BEFORE = "handoff_id, copy_id, desk_id, session_id, reason, callback_window, status"
AFTER = "handoff_id, copy_id, desk_id, session_id, reason, callback_window, status, kind"

# A row's kind, read back from the row: a card's handoff names itself as its action, and only a card's does.
KIND_OF_ROW = "CASE WHEN action_id = handoff_id THEN 'card' ELSE 'callback' END"

# The upgrade's steps on the table, and the downgrade's: neither reads rows through row security.
ADD_KIND = f"""
    ALTER TABLE kernel.handoffs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'callback'
        CONSTRAINT handoffs_kind_check CHECK (kind IN ('callback', 'card'));
    ALTER TABLE kernel.handoffs ALTER COLUMN kind TYPE text USING ({KIND_OF_ROW});
    ALTER TABLE kernel.handoffs ALTER COLUMN kind SET DEFAULT 'callback';
    ALTER TABLE kernel.handoffs DROP CONSTRAINT IF EXISTS handoffs_card_names_itself,
        ADD CONSTRAINT handoffs_card_names_itself CHECK ((kind = 'card') = (action_id = handoff_id));
"""
DROP_KIND = """
    ALTER TABLE kernel.handoffs DROP CONSTRAINT IF EXISTS handoffs_card_names_itself;
    ALTER TABLE kernel.handoffs DROP COLUMN IF EXISTS kind;
"""

# All but the first, by ID, of a session's open handoffs closed, as the owner's mark of done closes
# one, with their facts expired; run as the tables' owner with their row security's force lifted for
# these statements alone, and put back.
CLOSE_EXTRAS = """
    ALTER TABLE kernel.handoffs NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE kernel.facts NO FORCE ROW LEVEL SECURITY;
    WITH closed AS (
        UPDATE kernel.handoffs AS extra SET status = 'done'
        WHERE extra.status = 'open' AND extra.session_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM kernel.handoffs AS kept WHERE kept.session_id = extra.session_id
                AND kept.status = 'open' AND kept.handoff_id < extra.handoff_id)
        RETURNING extra.desk_id, extra.handoff_id)
    UPDATE kernel.facts AS fact SET status = 'expired' FROM closed
        WHERE fact.desk_id = closed.desk_id AND fact.fact_id = 'handoff:' || closed.handoff_id;
    ALTER TABLE kernel.facts FORCE ROW LEVEL SECURITY;
    ALTER TABLE kernel.handoffs FORCE ROW LEVEL SECURITY;
"""
ONE_OPEN = ("CREATE UNIQUE INDEX IF NOT EXISTS handoffs_one_open_per_session ON kernel.handoffs (session_id)"
            " WHERE status = 'open';")


def _script(sql: str) -> None:
    """Run a multi-statement SQL script as-is (no parameters), inside the migration's transaction."""
    op.get_bind().connection.driver_connection.execute(sql)


def _change_owner(role: str, schema: str, statements: str) -> None:
    """Run `statements`, which make `role` the owner of objects in `schema`, as any admin role.

    A superuser may change an owner as it is. Any other admin (one with CREATEROLE, which Postgres 16
    gives ADMIN OPTION on the roles it creates, but not SET) is lent SET on `role`, and `role` CREATE
    on `schema`, for these statements only. Both are taken back after, so the admin and `role` end
    as a superuser's run leaves them.
    """
    _script(f"""
        GRANT {role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
        GRANT CREATE ON SCHEMA {schema} TO {role};
        {statements}
        REVOKE CREATE ON SCHEMA {schema} FROM {role};
        REVOKE {role} FROM CURRENT_USER;
    """)


def _create_view(columns: str) -> None:
    _script(f"""
        CREATE VIEW kernel_ro.handoffs WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.handoffs WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.handoffs TO desk_api;
    """)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.handoffs OWNER TO desk_ro_owner;")


def upgrade() -> None:
    _script("DROP VIEW kernel_ro.handoffs;")
    _script(ADD_KIND)
    _script("GRANT SELECT (kind) ON kernel.handoffs TO desk_ro_owner;")
    _script(CLOSE_EXTRAS)
    _script(ONE_OPEN)
    _create_view(AFTER)


def downgrade() -> None:
    _script("DROP INDEX IF EXISTS kernel.handoffs_one_open_per_session;")
    _script("DROP VIEW kernel_ro.handoffs;")
    _script(DROP_KIND)                    # dropping the column drops its CHECK and its column grant too
    _create_view(BEFORE)
