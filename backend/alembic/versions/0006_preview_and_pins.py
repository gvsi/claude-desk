"""Session previews and MCP pins, in the kernel tables and their kernel_ro views.

kernel.sessions gains `preview` (boolean, default false): the visitor session an owner opens to try
a Desk as a customer before Answering is on (POST /sessions with `preview: true`). kernel.tools
gains `definition_sha256`, an MCP tool's pinned definition hash (a public pin, not a secret; null
for native tools). Each joins its kernel_ro view where the master plan's "Data model" table puts
it: `preview` after `strikes`, `definition_sha256` after `description_confirmed`.

CREATE OR REPLACE VIEW can only add columns at the end, so the two views are dropped and created
again as 0002_copy_isolation and 0005_kernel_ro_owner left them: a security_barrier view filtered on
the transaction's `desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the view's
columns, and readable by desk_api alone. Dropping without CASCADE fails if anything depends on them.
The admin owns kernel_ro, so it may drop them; giving them back to desk_ro_owner needs no superuser
either (`_change_owner`, as in 0004_copy_resolvers).

Revision ID: 0006_preview_and_pins
Revises: 0005_kernel_ro_owner
"""

from alembic import op

revision = "0006_preview_and_pins"
down_revision = "0005_kernel_ro_owner"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

NEW_COLUMNS = {   # table: (column, definition)
    "sessions": ("preview", "boolean NOT NULL DEFAULT false"),
    "tools": ("definition_sha256", "text"),
}

# The two views' columns before and after this revision, frozen here.
VIEWS = {
    "sessions": (
        "session_id, copy_id, desk_id, kind, verified, assurance, person_id, agent_key_id, mandate_id, "
        "last_language, mode, generation, strikes, created_at, closed_at",
        "session_id, copy_id, desk_id, kind, verified, assurance, person_id, agent_key_id, mandate_id, "
        "last_language, mode, generation, strikes, preview, created_at, closed_at",
    ),
    "tools": (
        "copy_id, desk_id, tool, source, effects, reversible, status, description_confirmed, "
        "pending_definition_text, pending_sha256",
        "copy_id, desk_id, tool, source, effects, reversible, status, description_confirmed, definition_sha256, "
        "pending_definition_text, pending_sha256",
    ),
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


def _recreate_views(views: dict[str, str]) -> None:
    """Drop and create each view (name: columns) again, then give them all to desk_ro_owner."""
    for view, columns in views.items():
        _script(f"""
            DROP VIEW kernel_ro.{view};
            CREATE VIEW kernel_ro.{view} WITH (security_barrier = true) AS
                SELECT {columns} FROM kernel.{view} WHERE copy_id = {CURRENT_COPY};
            GRANT SELECT ON kernel_ro.{view} TO desk_api;
        """)
    _change_owner("desk_ro_owner", "kernel_ro", "".join(
        f"ALTER VIEW kernel_ro.{view} OWNER TO desk_ro_owner;" for view in views))


def upgrade() -> None:
    for table, (column, definition) in NEW_COLUMNS.items():
        _script(f"""
            ALTER TABLE kernel.{table} ADD COLUMN {column} {definition};
            GRANT SELECT ({column}) ON kernel.{table} TO desk_ro_owner;
        """)
    _recreate_views({view: columns for view, (_, columns) in VIEWS.items()})


def downgrade() -> None:
    _recreate_views({view: columns for view, (columns, _) in VIEWS.items()})
    for table, (column, _) in NEW_COLUMNS.items():
        _script(f"ALTER TABLE kernel.{table} DROP COLUMN {column};")   # drops its column grant too
