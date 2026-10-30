"""Copy resolver for a session named by its ID.

A session call names its session by ID next to its token, and a refused call goes on that
session's ledger even when the token is wrong or belongs to another copy, so the kernel must find
a session's copy from its ID before any copy is bound. This adds that resolver beside
0004_copy_resolvers's, on the same terms: `LANGUAGE sql STABLE SECURITY DEFINER`, a pinned
`search_path`, owned by desk_resolver, callable only by desk_kernel, returning only a copy id.
desk_resolver may now read `sessions.session_id` as well (not a secret: the kernel_ro view shows it).
Any admin role can run it, superuser or not: the function's grants are set while the admin owns it,
and `_change_owner` lends what the owner change needs for that change only (as in 0004).

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


def upgrade() -> None:
    _script(f"""
        GRANT SELECT (session_id) ON kernel.sessions TO desk_resolver;
        CREATE FUNCTION kernel.copy_of_session_id(session_id text) RETURNS text
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kernel, pg_temp
            AS $body$ SELECT s.copy_id FROM kernel.sessions s WHERE s.session_id = copy_of_session_id.session_id $body$;
        REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION {SIGNATURE} TO desk_kernel;
    """)
    # Grants first, while the admin owns the function: once it doesn't, a non-superuser admin's
    # REVOKE would only warn, and leave PUBLIC its EXECUTE.
    _change_owner("desk_resolver", "kernel", f"ALTER FUNCTION {SIGNATURE} OWNER TO desk_resolver;")


def downgrade() -> None:
    _script(f"""
        DROP FUNCTION {SIGNATURE};
        REVOKE SELECT (session_id) ON kernel.sessions FROM desk_resolver;
    """)
