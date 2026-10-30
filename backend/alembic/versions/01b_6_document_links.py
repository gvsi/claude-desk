"""Document links: a document released to its record owner, opened once by a single-use token.

0001_core created `kernel.document_links` with its key and copy only. This adds the rest: the
Desk, the document, the session that asked and the person it was released to, the token (unique)
and the token's sha256 (unique, 64 lowercase hex digits), when it was made and when it expires,
and when it was opened (`consumed_at`) or voided (`voided_at`, when its Desk is deleted or its
person removed). Every time comes from the kernel's clock, so no column defaults to Postgres
`now()`. The table has had no writer before this revision, so its new columns are NOT NULL where a
link always has a value.

The token lives only here: no kernel_ro view shows the table, and desk_ro_owner gets no grant on
it. A link is opened by its token alone (`GET /document_links/{token}`), before any copy is bound,
so this adds a copy resolver beside 0004_copy_resolvers's, on the same terms (`LANGUAGE sql STABLE
SECURITY DEFINER`, a pinned `search_path`, owned by desk_resolver, callable only by desk_kernel,
returning only a copy id), which looks the link up by the token's sha256, as a session is looked up
by its token's: desk_resolver may read `document_links.copy_id` and `.token_sha256`, in every copy,
by its own SELECT policy, and never a token. The token itself is read only in its own copy, where
the kernel puts it in the link's card.

    kernel.copy_of_document_link(token_sha256 text) -> text   the copy of the link with that token hash

Any admin role can run this, superuser or not (a managed Postgres's admin isn't): the function's
grants are set while the admin still owns it, then `_change_owner` lends the admin SET on
desk_resolver, and desk_resolver CREATE on the schema, for the ownership change alone, and takes
both back.

Revision ID: 01b_6_document_links
Revises: 01b_5_knowledge
"""

from alembic import op

revision = "01b_6_document_links"
down_revision = "01b_5_knowledge"
branch_labels = None
depends_on = None

COLUMNS = [   # (column, definition)
    ("desk_id", "text NOT NULL"),
    ("document_id", "text NOT NULL"),
    ("session_id", "text NOT NULL"),
    ("person_id", "text NOT NULL"),
    ("token", "text NOT NULL"),
    ("token_sha256", "text NOT NULL"),
    ("created_at", "timestamptz NOT NULL"),
    ("expires_at", "timestamptz NOT NULL"),
    ("consumed_at", "timestamptz"),
    ("voided_at", "timestamptz"),
]

CHECKS = {   # name: condition
    "document_links_token_sha256_check": "token_sha256 ~ '^[0-9a-f]{64}$'",
}

INDEXES = {   # name: (columns, unique)
    "document_links_token": ("token", True),                 # a token opens one link
    "document_links_token_sha256": ("token_sha256", True),   # and so does its hash, which the resolver reads
}

SIGNATURE = "kernel.copy_of_document_link(text)"


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
    additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in COLUMNS)
    op.execute(f"ALTER TABLE kernel.document_links {additions}")
    for name, condition in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.document_links DROP CONSTRAINT IF EXISTS {name},"
                   f" ADD CONSTRAINT {name} CHECK ({condition})")
    for name, (columns, unique) in INDEXES.items():
        kind = "UNIQUE INDEX" if unique else "INDEX"
        op.execute(f"CREATE {kind} IF NOT EXISTS {name} ON kernel.document_links ({columns})")
    # Grants first, while the admin owns the function: once it doesn't, a non-superuser admin's
    # REVOKE would only warn, and leave PUBLIC its EXECUTE.
    _script(f"""
        GRANT SELECT (copy_id, token_sha256) ON kernel.document_links TO desk_resolver;
        CREATE POLICY resolve_copy ON kernel.document_links FOR SELECT TO desk_resolver USING (true);
        CREATE FUNCTION kernel.copy_of_document_link(token_sha256 text) RETURNS text
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kernel, pg_temp
            AS $body$ SELECT l.copy_id FROM kernel.document_links l
                      WHERE l.token_sha256 = copy_of_document_link.token_sha256 $body$;
        REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION {SIGNATURE} TO desk_kernel;
    """)
    _change_owner("desk_resolver", "kernel", f"ALTER FUNCTION {SIGNATURE} OWNER TO desk_resolver;")


def downgrade() -> None:
    _script(f"""
        DROP FUNCTION {SIGNATURE};
        DROP POLICY resolve_copy ON kernel.document_links;
        REVOKE SELECT (copy_id, token_sha256) ON kernel.document_links FROM desk_resolver;
    """)
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    for name in CHECKS:
        op.execute(f"ALTER TABLE kernel.document_links DROP CONSTRAINT IF EXISTS {name}")
    # A link left with only its key and copy means nothing, and would stop the upgrade's NOT NULL
    # columns from coming back; TRUNCATE, unlike DELETE, isn't held back by row security, so any
    # admin empties the table.
    op.execute("TRUNCATE kernel.document_links")
    drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in COLUMNS)
    op.execute(f"ALTER TABLE kernel.document_links {drops}")
