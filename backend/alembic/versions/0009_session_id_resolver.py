"""Copy resolver for a session named by its ID.

A session call names its session by ID next to its token, and a refused call goes on that
session's ledger even when the token is wrong or belongs to another copy, so the kernel must find
a session's copy from its ID before any copy is bound. This adds that resolver beside
0004_copy_resolvers's, on the same terms: `LANGUAGE sql STABLE SECURITY DEFINER`, a pinned
`search_path`, owned by desk_resolver, callable only by desk_kernel, returning only a copy id.
desk_resolver may now read `sessions.session_id` as well (not a secret: the kernel_ro view shows it).

    kernel.copy_of_session_id(session_id text) -> text   the copy of the session with that ID

Revision ID: 0009_session_id_resolver
Revises: 0008_kernel_core
"""

from alembic import op

revision = "0009_session_id_resolver"
down_revision = "0008_kernel_core"
branch_labels = None
depends_on = None

SIGNATURE = "kernel.copy_of_session_id(text)"


def _script(sql: str) -> None:
    """Run a multi-statement SQL script as-is (no parameters), inside the migration's transaction."""
    op.get_bind().connection.driver_connection.execute(sql)


def upgrade() -> None:
    _script(f"""
        GRANT SELECT (session_id) ON kernel.sessions TO desk_resolver;
        CREATE FUNCTION kernel.copy_of_session_id(session_id text) RETURNS text
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kernel, pg_temp
            AS $body$ SELECT s.copy_id FROM kernel.sessions s WHERE s.session_id = copy_of_session_id.session_id $body$;
        ALTER FUNCTION {SIGNATURE} OWNER TO desk_resolver;
        REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION {SIGNATURE} TO desk_kernel;
    """)


def downgrade() -> None:
    _script(f"""
        DROP FUNCTION {SIGNATURE};
        REVOKE SELECT (session_id) ON kernel.sessions FROM desk_resolver;
    """)
