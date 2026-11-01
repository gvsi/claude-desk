"""Expose only the configured business definition through the copy-scoped tools view.

Re-create the view with the security barrier and temporary ownership grants used by
01c_4_tool_pins. The API gains no access to the underlying profile column.
"""

from alembic import op

revision = "09_business_tools_view"
down_revision = "desk_simulated_memory"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"
BEFORE = ("copy_id, desk_id, tool, source, effects, reversible, status, description_confirmed, definition_sha256, "
          "pending_definition_text, pending_sha256, review_reason")
AFTER = f"{BEFORE}, profile -> 'business' AS business"


def _script(sql: str) -> None:
    op.get_bind().connection.driver_connection.execute(sql)


def _change_owner() -> None:
    _script("""
        GRANT desk_ro_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
        GRANT CREATE ON SCHEMA kernel_ro TO desk_ro_owner;
        ALTER VIEW kernel_ro.tools OWNER TO desk_ro_owner;
        REVOKE CREATE ON SCHEMA kernel_ro FROM desk_ro_owner;
        REVOKE desk_ro_owner FROM CURRENT_USER;
    """)


def _create_view(columns: str) -> None:
    _script(f"""
        DROP VIEW kernel_ro.tools;
        CREATE VIEW kernel_ro.tools WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.tools WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.tools TO desk_api;
    """)
    _change_owner()


def upgrade() -> None:
    _script("GRANT SELECT (profile) ON kernel.tools TO desk_ro_owner;")
    _create_view(AFTER)


def downgrade() -> None:
    _create_view(BEFORE)
    _script("REVOKE SELECT (profile) ON kernel.tools FROM desk_ro_owner;")
