"""State columns admit only their contract values; one active policy version per Desk.

The session, policy version and decision state machines are plain text columns, so without
these checks the database would accept any string. The value lists are the contract Literals
(desk.contracts: ActorKind, Assurance, SessionMode, PolicyVersion.status, Outcome,
DecisionState), frozen here; test_state_columns_admit_only_contract_values compares them with
the contracts. The partial unique index makes two concurrent confirms unable to leave a Desk
with two active versions.

Revision ID: 0003_state_checks
Revises: 0002_copy_isolation
"""

from alembic import op

revision = "0003_state_checks"
down_revision = "0002_copy_isolation"
branch_labels = None
depends_on = None

STATE_COLUMNS = {
    ("sessions", "kind"): ("visitor", "agent", "owner"),
    ("sessions", "assurance"): ("none", "demo_code", "owner_session"),
    ("sessions", "mode"): ("ai", "owner", "paused"),
    ("policy_versions", "status"): ("draft", "proved", "rejected", "active", "superseded"),
    ("decisions", "outcome"): ("allow", "hold", "refuse"),
    ("decisions", "state"): ("allowed", "held", "refused", "approved", "denied", "expired", "cancelled",
                             "executed", "failed", "unknown", "refused_at_execution"),
}


def upgrade() -> None:
    for (table, column), values in STATE_COLUMNS.items():
        allowed = ", ".join(f"'{value}'" for value in values)
        op.execute(f"ALTER TABLE kernel.{table} ADD CONSTRAINT {table}_{column}_check CHECK ({column} IN ({allowed}))")
    op.execute(
        "CREATE UNIQUE INDEX policy_versions_one_active ON kernel.policy_versions (desk_id) WHERE status = 'active'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX kernel.policy_versions_one_active")
    for table, column in STATE_COLUMNS:
        op.execute(f"ALTER TABLE kernel.{table} DROP CONSTRAINT {table}_{column}_check")
