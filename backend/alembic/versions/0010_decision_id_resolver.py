"""Copy resolver for a decision named by its ID.

`GET /decisions/{id}` names its session through the decision: a session's token must hash to the
decision's own session, and a refused read goes on that session's ledger even when the token
belongs to another session or another copy ("Kernel HTTP API v2", Credentials). So the kernel must
find a decision's copy from its ID before any copy is bound. This adds that resolver beside
0004_copy_resolvers's and 0009's, on the same terms: `LANGUAGE sql STABLE SECURITY DEFINER`, a
pinned `search_path`, owned by desk_resolver, callable only by desk_kernel, returning only a copy
id. desk_resolver may read `decisions.decision_id` and `decisions.copy_id`, in every copy, by its
own SELECT policy, as on the three tables 0004 opened to it. Any admin role can run it, superuser or
not: the function's grants are set while the admin owns it, and `_change_owner` lends what the
owner change needs for that change only (as in 0004).

    kernel.copy_of_decision_id(decision_id text) -> text   the copy of the decision with that ID

Revision ID: 0010_decision_id_resolver
Revises: 0009_session_id_resolver
"""

from alembic import op

revision = "0010_decision_id_resolver"
down_revision = "0009_session_id_resolver"
branch_labels = None
depends_on = None

SIGNATURE = "kernel.copy_of_decision_id(text)"


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
        GRANT SELECT (copy_id, decision_id) ON kernel.decisions TO desk_resolver;
        CREATE POLICY resolve_copy ON kernel.decisions FOR SELECT TO desk_resolver USING (true);
        CREATE FUNCTION kernel.copy_of_decision_id(decision_id text) RETURNS text
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kernel, pg_temp
            AS $body$ SELECT d.copy_id FROM kernel.decisions d WHERE d.decision_id = copy_of_decision_id.decision_id $body$;
        REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION {SIGNATURE} TO desk_kernel;
    """)
    # Grants first, while the admin owns the function: once it doesn't, a non-superuser admin's
    # REVOKE would only warn, and leave PUBLIC its EXECUTE.
    _change_owner("desk_resolver", "kernel", f"ALTER FUNCTION {SIGNATURE} OWNER TO desk_resolver;")


def downgrade() -> None:
    _script(f"""
        DROP FUNCTION {SIGNATURE};
        DROP POLICY resolve_copy ON kernel.decisions;
        REVOKE SELECT (copy_id, decision_id) ON kernel.decisions FROM desk_resolver;
    """)
