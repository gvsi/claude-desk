"""The money cap's edges: a hold keeps the standing it was decided with, and an execution the
version it was checked under.

`allow_person` needs a verified person or an agent key and, on a money tool, an amount within the
active version's money cap. Every read of a held money decision recomputes its answers at the
active cap, and it used to read the asker's standing again too, so a hold a stranger asked for
gained `allow_person` once the session confirmed who it was. `kernel.decisions` gains
`allow_person_eligible`, whether the asker was a verified person or an agent key when the decision
was made, and a read recomputes the answers from it and the active cap alone. It is added NOT NULL
with a default of false, so a decision made before this revision is taken as one whose asker could
not be given `allow_person`: a held money decision from then loses the option on its next read,
and the owner can still allow it once.

Every `execute` entry names the rules version and money cap its execution's re-check ran under, so
each can be judged by its own version. Reconciliation runs later, often after another version is
active, so `kernel.executions` gains `policy_version` and `auto_money_cap_cents`, written with the
intent row in T1, which reconciliation's entries name. Both are null on a row written before this
revision (its entries name no version, as before), and never one without the other; the cap is
held to the range `kernel.policy_versions` holds it to.

Nothing is updated in place (an UPDATE would run under the tables' forced row security, which a
managed Postgres's admin doesn't bypass). No column joins a kernel_ro view, and desk_ro_owner and
desk_resolver get no grant on them, so the views stay as they are.

Revision ID: 01b_3e_money_cap_edges
Revises: 01b_5b_knowledge_view
"""

from alembic import op

revision = "01b_3e_money_cap_edges"
down_revision = "01b_5b_knowledge_view"
branch_labels = None
depends_on = None

# 1000000 is desk.contracts.AUTO_MONEY_HARD_CAP_CENTS, the platform ceiling, frozen here
COLUMNS = {   # table: [(column, definition)]
    "decisions": [("allow_person_eligible", "boolean NOT NULL DEFAULT false")],
    "executions": [
        ("policy_version", "integer"),
        ("auto_money_cap_cents", ("bigint CONSTRAINT executions_auto_money_cap_cents_range"
                                  " CHECK (auto_money_cap_cents BETWEEN 0 AND 1000000)")),
    ],
}
CHECKS = {   # table: {name: condition}
    "executions": {"executions_checked_pair": "(policy_version IS NULL) = (auto_money_cap_cents IS NULL)"},
}


def upgrade() -> None:
    for table, columns in COLUMNS.items():
        additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in columns)
        op.execute(f"ALTER TABLE kernel.{table} {additions}")
    for table, checks in CHECKS.items():
        for name, condition in checks.items():
            op.execute(f"ALTER TABLE kernel.{table} DROP CONSTRAINT IF EXISTS {name},"
                       f" ADD CONSTRAINT {name} CHECK ({condition})")


def downgrade() -> None:
    # dropping the columns drops their checks too
    for table, columns in COLUMNS.items():
        drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in columns)
        op.execute(f"ALTER TABLE kernel.{table} {drops}")
