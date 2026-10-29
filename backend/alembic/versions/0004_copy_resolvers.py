"""Copy resolvers: find the copy a credential belongs to before any copy is bound.

Row-level security shows desk_kernel no row until a transaction sets `desk.copy_id`
(0002_copy_isolation), but a request arrives with a session token or a public slug, not a copy,
and startup work must visit every copy. These SECURITY DEFINER functions answer those lookups
and return only a copy id:

    kernel.copy_of_session(secret_hash text) -> text     the copy of the session with that token hash
    kernel.copy_of_desk_slug(slug text)      -> text     the copy of the Desk with that slug
    kernel.copy_ids()                        -> setof text   every copy

Each is `LANGUAGE sql STABLE`, pins `search_path` (pg_temp last, so nothing a caller creates is
found first), and is callable only by desk_kernel. They run as desk_resolver, a NOLOGIN role with
neither SUPERUSER nor BYPASSRLS: it reads through row security by its own SELECT policy on the
three tables it needs, and its column grants admit only the copy and the lookup key. The single-use
link tables don't carry a token hash yet; the plan that adds one adds its resolver beside it.

Any admin role can run this, superuser or not (a managed Postgres's admin isn't). Without
SUPERUSER, Postgres 16 changes an object's owner only for a role that may SET ROLE to the new owner,
which must have CREATE on the object's schema: `_change_owner` lends both for the change and takes
them back. Each function's grants are set while the admin still owns it.

Revision ID: 0004_copy_resolvers
Revises: 0003_state_checks
"""

from alembic import op

revision = "0004_copy_resolvers"
down_revision = "0003_state_checks"
branch_labels = None
depends_on = None

# What desk_resolver may read: the copy and the lookup key of each table, in every copy.
RESOLVER_READS = {"copies": ("copy_id",), "sessions": ("copy_id", "secret_hash"), "desks": ("copy_id", "slug")}

RESOLVERS = {
    "copy_of_session(secret_hash text)": (
        "text", "SELECT s.copy_id FROM kernel.sessions s WHERE s.secret_hash = copy_of_session.secret_hash"),
    "copy_of_desk_slug(slug text)": (
        "text", "SELECT d.copy_id FROM kernel.desks d WHERE d.slug = copy_of_desk_slug.slug"),
    "copy_ids()": ("SETOF text", "SELECT c.copy_id FROM kernel.copies c ORDER BY c.copy_id"),
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


def _signature(resolver: str) -> str:
    """`copy_of_session(secret_hash text)` -> `kernel.copy_of_session(text)`."""
    name, _, args = resolver.partition("(")
    types = [arg.split()[-1] for arg in args.rstrip(")").split(",") if arg.strip()]
    return f"kernel.{name}({', '.join(types)})"


def upgrade() -> None:
    # Roles are cluster-wide: created only if missing, and kept by a downgrade (as in roles.sql).
    _script("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_resolver') THEN
                CREATE ROLE desk_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
            END IF;
        END
        $$;
        GRANT USAGE ON SCHEMA kernel TO desk_resolver;
    """)
    for table, columns in RESOLVER_READS.items():
        _script(f"""
            GRANT SELECT ({', '.join(columns)}) ON kernel.{table} TO desk_resolver;
            CREATE POLICY resolve_copy ON kernel.{table} FOR SELECT TO desk_resolver USING (true);
        """)
    for resolver, (returns, body) in RESOLVERS.items():
        signature = _signature(resolver)
        # Grants first, while the admin owns the function: once it doesn't, a non-superuser admin's
        # REVOKE would only warn, and leave PUBLIC its EXECUTE.
        _script(f"""
            CREATE FUNCTION kernel.{resolver} RETURNS {returns}
                LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kernel, pg_temp
                AS $body$ {body} $body$;
            REVOKE ALL ON FUNCTION {signature} FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION {signature} TO desk_kernel;
        """)
    _change_owner("desk_resolver", "kernel", "".join(
        f"ALTER FUNCTION {_signature(resolver)} OWNER TO desk_resolver;" for resolver in RESOLVERS))


def downgrade() -> None:
    for resolver in RESOLVERS:
        _script(f"DROP FUNCTION {_signature(resolver)};")
    for table, columns in RESOLVER_READS.items():
        _script(f"""
            DROP POLICY resolve_copy ON kernel.{table};
            REVOKE SELECT ({', '.join(columns)}) ON kernel.{table} FROM desk_resolver;
        """)
    _script("REVOKE USAGE ON SCHEMA kernel FROM desk_resolver;")
