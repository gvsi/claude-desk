"""Knowledge: when the owner first added each item.

`POST /knowledge` writes the owner's knowledge items (`labels.store_knowledge`), one per item ID,
replacing an item posted again. `created_at` (from the kernel's clock) is when the item was first
added and stays when it is replaced, so `/context` lists items in the order the owner added them.
Rows written before this revision have none.

No kernel_ro view shows it, and desk_ro_owner gets no grant on it, so `kernel_ro.knowledge_items`
stays as it is.

Revision ID: 01b_5_knowledge
Revises: 01b_3_people
"""

from alembic import op

revision = "01b_5_knowledge"
down_revision = "01b_3_people"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.knowledge_items ADD COLUMN IF NOT EXISTS created_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE kernel.knowledge_items DROP COLUMN IF EXISTS created_at")
