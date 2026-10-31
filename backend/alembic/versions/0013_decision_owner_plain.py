"""Why a decision was refused at execution, for the owner alone.

`kernel.decisions.owner_plain` holds the owner's line for a decision refused at execution (the
person's session ended, the Desk was deleted, the rules changed, or a line that names no cause),
which the kernel writes from fixed templates in the same transaction as the state change and
returns only on the owner's reads (`Decision.owner_plain`). Every other state leaves it NULL, and so
does every row written before this revision: an old refusal reads as having none.

The table is the kernel's alone (desk_kernel's table grants cover the new column), the column joins
no kernel_ro view, and desk_ro_owner and desk_resolver get no grant on it, so the API reads it only
through the owner's kernel reads. Nothing is updated in place, so any admin role can run this,
superuser or not, and it runs again over a database that already has the column.

Revision ID: 0013_decision_owner_plain
Revises: 01c_5_mandate_reservations
"""

from alembic import op

revision = "0013_decision_owner_plain"
down_revision = "01c_5_mandate_reservations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.decisions ADD COLUMN IF NOT EXISTS owner_plain text")


def downgrade() -> None:
    op.execute("ALTER TABLE kernel.decisions DROP COLUMN IF EXISTS owner_plain")
