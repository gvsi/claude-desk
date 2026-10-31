"""Payment links: a quote's single-use link to the mock checkout.

0001_core created `kernel.payment_links` with its key, copy, Desk, session, quote, amount, state and
expiry. This adds the rest a link needs: the action that issued it (unique, so one action makes one
link), its title, its token (unique) and the token's sha256 (unique), the provider's checkout, the
customer the checkout names (`person:<id>` or `session:<id>`), an agent link's mandate, when a
completion started, and when it was made and last changed. Every time comes from the kernel's clock,
so no column defaults to Postgres `now()`. The table has had no writer before this revision, so its
new columns are NOT NULL where a link always has a value. A link's state is one of the master plan's
`PaymentLinkState`s and its amount a whole number of cents from 1 to $10,000.

The token lives only in this table: no kernel_ro view shows it or its hash, and desk_ro_owner gets
no grant on either. A link is read by its token alone (`GET /payment_links/{token}`), before any copy
is bound, so this adds a copy resolver beside 0004_copy_resolvers's, on the same terms (`LANGUAGE sql
STABLE SECURITY DEFINER`, a pinned `search_path`, owned by desk_resolver, callable only by
desk_kernel, returning only a copy id), which looks the link up by the token's sha256: desk_resolver
may read `payment_links.copy_id` and `.token_sha256`, in every copy, by its own SELECT policy, and
never a plaintext token.

    kernel.copy_of_payment_link(token_sha256 text) -> text   the copy of the link with that token hash

kernel_ro.payment_links gains `action_id` (not a secret) after `quote_id`, where the master plan's
"Data model" table puts it, so a read can join a link to its action, decision and approval.
CREATE OR REPLACE VIEW can only add columns at the end, so the view is dropped and created again as
0002_copy_isolation and 0005_kernel_ro_owner left it: a security_barrier view filtered on the
transaction's `desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the view's columns,
and readable by desk_api alone.

Any admin role can run this, superuser or not (a managed Postgres's admin isn't): every grant and
revoke runs first, while the admin owns the function and the view; then `_change_owner` lends the
admin SET on desk_resolver and desk_ro_owner in turn, and each CREATE on its schema, for its
ownership change alone, and takes both back.

Revision ID: 01c_2_payment_links
Revises: 01c_1_agents
"""

from alembic import op

revision = "01c_2_payment_links"
down_revision = "01c_1_agents"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

COLUMNS = [   # (column, definition)
    ("action_id", "text NOT NULL"),
    ("title", "text NOT NULL"),
    ("token", "text NOT NULL"),
    ("token_sha256", "text NOT NULL"),
    ("provider_checkout_id", "text NOT NULL"),
    ("customer_id", "text NOT NULL"),
    ("mandate_id", "text"),
    ("completion_started_at", "timestamptz"),
    ("created_at", "timestamptz NOT NULL"),
    ("updated_at", "timestamptz NOT NULL"),
]

CHECKS = {   # name: condition; 1000000 is desk.contracts.AUTO_MONEY_HARD_CAP_CENTS, frozen here
    "payment_links_state_check": "state IN ('issued', 'paid', 'expired', 'cancelled', 'unknown')",
    "payment_links_amount_check": "amount_cents BETWEEN 1 AND 1000000",
    "payment_links_token_sha256_check": "token_sha256 ~ '^[0-9a-f]{64}$'",
}

INDEXES = {   # name: columns; each unique
    "payment_links_action": "action_id",             # one action issues one link
    "payment_links_token": "token",                  # a token opens one link
    "payment_links_token_sha256": "token_sha256",    # and so does its hash, which the resolver reads
}

SIGNATURE = "kernel.copy_of_payment_link(text)"

# The view's columns before and after this revision, frozen here.
BEFORE = "link_id, copy_id, desk_id, session_id, quote_id, amount_cents, state, expires_at"
AFTER = "link_id, copy_id, desk_id, session_id, quote_id, action_id, amount_cents, state, expires_at"


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
    """kernel_ro.payment_links over `columns`, readable by desk_api; the admin owns it until
    `_change_owner` hands it to desk_ro_owner."""
    _script(f"""
        DROP VIEW kernel_ro.payment_links;
        CREATE VIEW kernel_ro.payment_links WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.payment_links WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.payment_links TO desk_api;
    """)


def upgrade() -> None:
    additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in COLUMNS)
    op.execute(f"ALTER TABLE kernel.payment_links {additions}")
    for name, condition in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.payment_links DROP CONSTRAINT IF EXISTS {name},"
                   f" ADD CONSTRAINT {name} CHECK ({condition})")
    for name, columns in INDEXES.items():
        op.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS {name} ON kernel.payment_links ({columns})")
    # Every grant and revoke first, while the admin owns the function and the view: once it doesn't,
    # a non-superuser admin's REVOKE would only warn, and leave PUBLIC its EXECUTE.
    _script(f"""
        GRANT SELECT (copy_id, token_sha256) ON kernel.payment_links TO desk_resolver;
        CREATE POLICY resolve_copy ON kernel.payment_links FOR SELECT TO desk_resolver USING (true);
        CREATE FUNCTION kernel.copy_of_payment_link(token_sha256 text) RETURNS text
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kernel, pg_temp
            AS $body$ SELECT l.copy_id FROM kernel.payment_links l
                      WHERE l.token_sha256 = copy_of_payment_link.token_sha256 $body$;
        REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION {SIGNATURE} TO desk_kernel;
        GRANT SELECT (action_id) ON kernel.payment_links TO desk_ro_owner;
    """)
    _create_view(AFTER)
    _change_owner("desk_resolver", "kernel", f"ALTER FUNCTION {SIGNATURE} OWNER TO desk_resolver;")
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.payment_links OWNER TO desk_ro_owner;")


def downgrade() -> None:
    _create_view(BEFORE)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.payment_links OWNER TO desk_ro_owner;")
    _script(f"""
        REVOKE SELECT (action_id) ON kernel.payment_links FROM desk_ro_owner;
        DROP FUNCTION {SIGNATURE};
        DROP POLICY resolve_copy ON kernel.payment_links;
        REVOKE SELECT (copy_id, token_sha256) ON kernel.payment_links FROM desk_resolver;
    """)
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    for name in CHECKS:
        op.execute(f"ALTER TABLE kernel.payment_links DROP CONSTRAINT IF EXISTS {name}")
    # a link left with only its first columns means nothing (no token, no checkout); TRUNCATE, unlike
    # DELETE, isn't held back by row security, so any admin empties the table
    op.execute("TRUNCATE kernel.payment_links")
    drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in COLUMNS)
    op.execute(f"ALTER TABLE kernel.payment_links {drops}")
