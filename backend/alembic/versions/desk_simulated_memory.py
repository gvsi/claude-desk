"""Private simulated setup memory on each Desk.

The nullable JSON column is written only through the kernel's owner route. Existing Desks keep
NULL; only the Turner seed falls back to its fixture. No kernel_ro view or column grant changes.
ALTER TABLE runs as the table's admin owner without SUPERUSER or BYPASSRLS.

Revision ID: desk_simulated_memory
Revises: 0013_decision_owner_plain
"""

from alembic import op

revision = "desk_simulated_memory"
down_revision = "0013_decision_owner_plain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.desks ADD COLUMN IF NOT EXISTS simulated_memory jsonb")


def downgrade() -> None:
    op.execute("ALTER TABLE kernel.desks DROP COLUMN IF EXISTS simulated_memory")
