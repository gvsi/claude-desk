"""Which policies decided each decision, in its kernel_ro view.

`kernel.decisions.policy_ids` (0008_kernel_core, written by the kernel with every decision) holds the
deciding Cedar policies, as the policy engine names them: `<set>.<@id>`, such as `F.never.<card>` for
a `never` card's forbid or `B.private_data_record_owner` for one of the always-on baseline's. It is
empty when nothing was evaluated (a refusal before evaluation, or an evaluation error). It joins
`kernel_ro.decisions` last, after `created_at`, where the master plan's "Data model" table puts it,
so the owner's Safety entries can say why a refusal happened. It names rules, not secrets: the
cards behind them are already in the view's `card_ids`, and the Cedar texts stay in the kernel.

CREATE OR REPLACE VIEW can only add columns at the end, and only the view's owner may run it, so
the view is dropped (without CASCADE, so this fails if anything depends on it) and created again as
01c_4_tool_pins re-created kernel_ro.tools: a security_barrier view filtered on the transaction's
`desk.copy_id`, owned by desk_ro_owner, which may SELECT exactly the view's columns (its `copy_read`
policy on the table, from 0005_kernel_ro_owner, stays as it is), and readable by desk_api alone. Any
admin role can run this, superuser or not: every grant runs first, while the admin owns the view;
then `_change_owner` lends the admin SET on desk_ro_owner, and desk_ro_owner CREATE on kernel_ro,
for the ownership change alone, and takes both back (as 01c_2_payment_links does).

Revision ID: kernel_ro_decision_policy_ids
Revises: 01c_5_mandate_reservations
"""

from alembic import op

revision = "kernel_ro_decision_policy_ids"
down_revision = "01c_5_mandate_reservations"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

COLUMN = "policy_ids"

# The view's columns before and after this revision, frozen here.
BEFORE = ("decision_id, copy_id, desk_id, session_id, tool, effects, outcome, state, answers, policy_version, "
          "card_ids, review, reason_plain, visitor_plain, expires_at, ledger_seq, created_at")
AFTER = f"{BEFORE}, {COLUMN}"


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
    """kernel_ro.decisions over `columns`, readable by desk_api; the admin owns it until `_change_owner`
    hands it to desk_ro_owner."""
    _script(f"""
        DROP VIEW kernel_ro.decisions;
        CREATE VIEW kernel_ro.decisions WITH (security_barrier = true) AS
            SELECT {columns} FROM kernel.decisions WHERE copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.decisions TO desk_api;
    """)


def upgrade() -> None:
    _script(f"GRANT SELECT ({COLUMN}) ON kernel.decisions TO desk_ro_owner;")
    _create_view(AFTER)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.decisions OWNER TO desk_ro_owner;")


def downgrade() -> None:
    _create_view(BEFORE)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.decisions OWNER TO desk_ro_owner;")
    _script(f"REVOKE SELECT ({COLUMN}) ON kernel.decisions FROM desk_ro_owner;")
