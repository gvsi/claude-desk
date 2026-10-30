"""The money cap's edges: a hold keeps the standing it was decided with.

`allow_person` needs a verified person or an agent key and, on a money tool, an amount within the
active version's money cap. Every read of a held money decision recomputes its answers at the
active cap, and it used to read the asker's standing again too, so a hold a stranger asked for
gained `allow_person` once the session confirmed who it was. `kernel.decisions` gains
`allow_person_eligible`, whether the asker was a verified person or an agent key when the decision
was made, and a read recomputes the answers from it and the active cap alone.

The column is added NOT NULL with a default of false, so a decision made before this revision is
taken as one whose asker could not be given `allow_person`: a held money decision from then loses
the option on its next read, and the owner can still allow it once. Nothing is updated in place
(an UPDATE would run under the tables' forced row security, which a managed Postgres's admin
doesn't bypass). The column joins no kernel_ro view, and desk_ro_owner and desk_resolver get no
grant on it, so the views stay as they are.

Revision ID: 01b_3e_money_cap_edges
Revises: 01b_5b_knowledge_view
"""

from alembic import op

revision = "01b_3e_money_cap_edges"
down_revision = "01b_5b_knowledge_view"
branch_labels = None
depends_on = None

COLUMNS = {   # table: [(column, definition)]
    "decisions": [("allow_person_eligible", "boolean NOT NULL DEFAULT false")],
}


def upgrade() -> None:
    for table, columns in COLUMNS.items():
        additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in columns)
        op.execute(f"ALTER TABLE kernel.{table} {additions}")


def downgrade() -> None:
    for table, columns in COLUMNS.items():
        drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in columns)
        op.execute(f"ALTER TABLE kernel.{table} {drops}")
