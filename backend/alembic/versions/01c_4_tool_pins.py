"""Tool pins: why a connected tool waits for review, and which tools a rules draft turns on.

kernel.tools gains `review_reason`, set only while a tool's status is `needs_review`: `new` for a
connect the owner hasn't confirmed, `changed` when its definition changed (`pending_sha256` set),
`delisted` when its server stopped listing it. A check keeps it null for any other status, so an
owner-disabled tool has none. It is no secret, so kernel_ro.tools shows it, after `pending_sha256`,
where the master plan's "Data model" table puts it.

kernel.policy_versions gains `enables`: the tools a `/tools/confirm` draft turns on, each with the
definition hash it was proved with (`[{tool, definition_sha256}]`), empty for every other version.
It isn't in a kernel_ro view.

CREATE OR REPLACE VIEW can only add columns at the end, and only the view's owner may run it, so
the view is dropped and created again as 0006_preview_and_pins left it: a security_barrier view
filtered on the transaction's `desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the
view's columns, and readable by desk_api alone. Any admin role can run this, superuser or not:
every grant runs first, while the admin owns the view; then `_change_owner` lends the admin SET on
desk_ro_owner, and desk_ro_owner CREATE on kernel_ro, for the ownership change alone, and takes both
back (as 01c_2_payment_links does).

Revision ID: 01c_4_tool_pins
Revises: 01c_3_link_cancellation
"""

from alembic import op

revision = "01c_4_tool_pins"
down_revision = "01c_3_link_cancellation"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

REASONS = "'new', 'changed', 'delisted'"
CHECKS = {   # name: condition
    "tools_review_reason_check": f"review_reason IN ({REASONS})",
    "tools_review_reason_status_check": "review_reason IS NULL OR status = 'needs_review'",
}

# The view's columns before and after this revision, frozen here.
BEFORE = ("copy_id, desk_id, tool, source, effects, reversible, status, description_confirmed, definition_sha256, "
          "pending_definition_text, pending_sha256")
AFTER = f"{BEFORE}, review_reason"


def _script(sql: str) -> None:
    """Run a multi-statement SQL script as-is (no parameters), inside the migration's transaction."""
    op.get_bind().connection.driver_connection.execute(sql)


def _change_owner(role: str, schema: str, statements: str) -> None:
    """Run `statements`, which make `role` the owner of objects in `schema`, as any admin role: a
    non-superuser admin is lent SET on `role`, and `role` CREATE on `schema`, for these statements
    only, and both are taken back after (01c_2_payment_links)."""
    _script(f"""
        GRANT {role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
        GRANT CREATE ON SCHEMA {schema} TO {role};
        {statements}
        REVOKE CREATE ON SCHEMA {schema} FROM {role};
        REVOKE {role} FROM CURRENT_USER;
    """)


def _create_view(columns: str) -> None:
    """kernel_ro.tools over `columns`, readable by desk_api; the admin owns it until `_change_owner`
    hands it to desk_ro_owner."""
    _script(f"""
        DROP VIEW kernel_ro.tools;
        CREATE VIEW kernel_ro.tools WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.tools WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.tools TO desk_api;
    """)


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.tools ADD COLUMN IF NOT EXISTS review_reason text")
    for name, condition in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.tools DROP CONSTRAINT IF EXISTS {name}, ADD CONSTRAINT {name} CHECK ({condition})")
    op.execute("ALTER TABLE kernel.policy_versions ADD COLUMN IF NOT EXISTS enables jsonb NOT NULL DEFAULT '[]'::jsonb")
    _script("GRANT SELECT (review_reason) ON kernel.tools TO desk_ro_owner;")
    _create_view(AFTER)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.tools OWNER TO desk_ro_owner;")


def downgrade() -> None:
    _create_view(BEFORE)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.tools OWNER TO desk_ro_owner;")
    _script("REVOKE SELECT (review_reason) ON kernel.tools FROM desk_ro_owner;")
    op.execute("ALTER TABLE kernel.policy_versions DROP COLUMN IF EXISTS enables")
    for name in CHECKS:
        op.execute(f"ALTER TABLE kernel.tools DROP CONSTRAINT IF EXISTS {name}")
    op.execute("ALTER TABLE kernel.tools DROP COLUMN IF EXISTS review_reason")
