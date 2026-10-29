"""When each quote was made, in its kernel_ro view.

`kernel.quotes.created_at` (0008_kernel_core, set by the kernel's clock when the quote is made) joins
`kernel_ro.quotes` where the master plan's "Data model" table puts it, after `expires_at`, so the
owner's reads can tell when a quote was given. It is the quote's time, not a secret.

CREATE OR REPLACE VIEW can only add columns at the end, and the view is created again as
0006_preview_and_pins re-created its two: dropped (without CASCADE, so this fails if anything depends
on it) and created as a security_barrier view filtered on the transaction's `desk.copy_id`, readable
by desk_api alone, then given to desk_ro_owner, which may SELECT exactly the view's columns and whose
`copy_read` policy on the table (0005_kernel_ro_owner) stays as it is. Grants come first, while the
admin owns the view; `_change_owner` then lends what the owner change needs, so any admin role can
run this, superuser or not (as in 0004_copy_resolvers).

Revision ID: 0011_quote_created_at
Revises: 0010_decision_id_resolver
"""

from alembic import op

revision = "0011_quote_created_at"
down_revision = "0010_decision_id_resolver"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

COLUMN = "created_at"

# The view's columns before and after this revision, frozen here.
BEFORE = "quote_id, copy_id, desk_id, session_id, items, list_cents, discount_bp, amount_cents, status, expires_at"
AFTER = f"{BEFORE}, {COLUMN}"


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
    """Drop kernel_ro.quotes and create it again with `columns`, then give it to desk_ro_owner."""
    _script(f"""
        DROP VIEW kernel_ro.quotes;
        CREATE VIEW kernel_ro.quotes WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.quotes WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.quotes TO desk_api;
    """)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.quotes OWNER TO desk_ro_owner;")


def upgrade() -> None:
    _script(f"GRANT SELECT ({COLUMN}) ON kernel.quotes TO desk_ro_owner;")
    _recreate_view(AFTER)


def downgrade() -> None:
    _recreate_view(BEFORE)
    _script(f"REVOKE SELECT ({COLUMN}) ON kernel.quotes FROM desk_ro_owner;")
