"""Handoffs: which kind each is, a call-back request or the handoff card's.

Until now only `native.request_callback` wrote a handoff. The kernel's handoff card now opens one
too (`reply_check.finalize`, the owner's decision of 2026-10-30), with no call-back window, so a
null window no longer tells the two apart. `kernel.handoffs` gains `kind`, `callback` or `card`,
NOT NULL. It is added with a default of `callback`, which the rows already written take (each was a
call-back request), and then has none, so every row written from now on names its kind.

A card's handoff has no action. `action_id` stays NOT NULL and unique: a card's names the
handoff's own id, which no action's id can equal (an action's id starts `act-`, a handoff's
`handoff-`), and a check holds every card to that, so a reconciliation that finds a call-back's
handoff by its action never finds a card's.

The column joins kernel_ro.handoffs after `status`, as the master plan's "Data model" table lists
it, so the API and the web can tell a card's handoff from a call-back request with no time.
CREATE OR REPLACE VIEW would need the admin to own the view, so the view is dropped and created
again as 01b_3b_money_cap and 01b_5b_knowledge_view leave a view: a security_barrier view filtered
on the transaction's `desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the view's
columns, and readable by desk_api alone. Dropping without CASCADE fails if anything depends on it.

Nothing is updated in place (an UPDATE would run under the table's forced row security, which a
managed Postgres's admin doesn't bypass), and the downgrade deletes nothing: a card's handoff
written meanwhile is a valid row without the column, and an upgrade after it reads that row as a
call-back request, as it reads every row from before it.

Any admin role can run this, superuser or not (a managed Postgres's admin isn't): the grants run
first, while the admin owns the view; the admin owns kernel_ro, so it may drop the view; then
`_change_owner` lends the admin SET on desk_ro_owner, and desk_ro_owner CREATE on the schema, for
the ownership change alone, and takes both back. Like the revisions before it, it runs again over
what it added.

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

CHECKS = {   # name: condition
    "handoffs_card_names_itself": "kind <> 'card' OR action_id = handoff_id",
}


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


def _recreate_view(columns: str) -> None:
    _script(f"""
        DROP VIEW kernel_ro.handoffs;
        CREATE VIEW kernel_ro.handoffs WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.handoffs WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.handoffs TO desk_api;
    """)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.handoffs OWNER TO desk_ro_owner;")


def upgrade() -> None:
    _script("""
        ALTER TABLE kernel.handoffs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'callback'
            CONSTRAINT handoffs_kind_check CHECK (kind IN ('callback', 'card'));
        ALTER TABLE kernel.handoffs ALTER COLUMN kind DROP DEFAULT;
        GRANT SELECT (kind) ON kernel.handoffs TO desk_ro_owner;
    """)
    for name, condition in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.handoffs DROP CONSTRAINT IF EXISTS {name},"
                   f" ADD CONSTRAINT {name} CHECK ({condition})")
    _recreate_view(AFTER)


def downgrade() -> None:
    _recreate_view(BEFORE)
    for name in CHECKS:
        op.execute(f"ALTER TABLE kernel.handoffs DROP CONSTRAINT IF EXISTS {name}")
    # drops its CHECK and its column grant too
    _script("ALTER TABLE kernel.handoffs DROP COLUMN IF EXISTS kind;")
