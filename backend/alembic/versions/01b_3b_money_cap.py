"""The money cap on each rules version: the most an auto rule takes or pays out per action.

kernel.policy_versions gains `auto_money_cap_cents` (bigint, 0 to 1000000, the $10,000 platform
ceiling), the money cap each version is compiled and proved at; the Desk's cap is its active
version's, so kernel.desks gets no column. It is added with a default of 50000, so the versions that
already exist keep the $500 every Desk was held to before, and then defaults to 0, so a version
written without a cap lets no money through without asking.

The column joins kernel_ro.policy_versions after `review_thresholds_version`, where the master
plan's "Data model" table puts it. CREATE OR REPLACE VIEW can only add columns at the end, so the
view is dropped and created again as 0002_copy_isolation, 0005_kernel_ro_owner and
0006_preview_and_pins left it: a security_barrier view filtered on the transaction's
`desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the view's columns, and readable
by desk_api alone. Dropping without CASCADE fails if anything depends on it.

Any admin role can run this, superuser or not (a managed Postgres's admin isn't): the grants run
first, while the admin owns the view; the admin owns kernel_ro, so it may drop the view; then
`_change_owner` lends the admin SET on desk_ro_owner, and desk_ro_owner CREATE on the schema, for
the ownership change alone, and takes both back.

Revision ID: 01b_3b_money_cap
Revises: 01b_6_document_links
"""

from alembic import op

revision = "01b_3b_money_cap"
down_revision = "01b_6_document_links"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# The view's columns before and after this revision, frozen here.
BEFORE = ("copy_id, desk_id, version, parent_version, cards, status, proof, cedar_sha256, schema_sha256, "
          "baseline_sha256, profiles_sha256, invariants_sha256, review_thresholds_version, created_at")
AFTER = ("copy_id, desk_id, version, parent_version, cards, status, proof, cedar_sha256, schema_sha256, "
         "baseline_sha256, profiles_sha256, invariants_sha256, review_thresholds_version, auto_money_cap_cents, "
         "created_at")


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
    _script(f"""
        DROP VIEW kernel_ro.policy_versions;
        CREATE VIEW kernel_ro.policy_versions WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.policy_versions WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.policy_versions TO desk_api;
    """)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.policy_versions OWNER TO desk_ro_owner;")


def upgrade() -> None:
    # 1000000 is desk.contracts.AUTO_MONEY_HARD_CAP_CENTS, the platform ceiling, frozen here
    _script("""
        ALTER TABLE kernel.policy_versions ADD COLUMN IF NOT EXISTS auto_money_cap_cents bigint NOT NULL
            DEFAULT 50000 CONSTRAINT policy_versions_auto_money_cap_cents_range
            CHECK (auto_money_cap_cents BETWEEN 0 AND 1000000);
        ALTER TABLE kernel.policy_versions ALTER COLUMN auto_money_cap_cents SET DEFAULT 0;
        GRANT SELECT (auto_money_cap_cents) ON kernel.policy_versions TO desk_ro_owner;
    """)
    _recreate_view(AFTER)


def downgrade() -> None:
    _recreate_view(BEFORE)
    # drops its CHECK and its column grant too
    _script("ALTER TABLE kernel.policy_versions DROP COLUMN IF EXISTS auto_money_cap_cents;")
