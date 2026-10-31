"""Payment links: why a link was cancelled, and by which rules version.

kernel.payment_links gains `cancel_reason` (null, or one of `rules_changed`, `person_removed`,
`mandate_expired` and `amount_mismatch`) and `cancelled_by_version`, the rules version whose
activation moved the link. A link the visitor cancels, or one cancelled with its Desk, has no
reason. Neither column is in a kernel_ro view, so no grant changes: desk_kernel already writes every
column of the table.

Revision ID: 01c_3_link_cancellation
Revises: 01c_2_payment_links
"""

from alembic import op

revision = "01c_3_link_cancellation"
down_revision = "01c_2_payment_links"
branch_labels = None
depends_on = None

REASONS = "'rules_changed', 'person_removed', 'mandate_expired', 'amount_mismatch'"


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.payment_links ADD COLUMN IF NOT EXISTS cancel_reason text,"
               " ADD COLUMN IF NOT EXISTS cancelled_by_version integer")
    op.execute("ALTER TABLE kernel.payment_links DROP CONSTRAINT IF EXISTS payment_links_cancel_reason_check,"
               f" ADD CONSTRAINT payment_links_cancel_reason_check CHECK (cancel_reason IN ({REASONS}))")


def downgrade() -> None:
    op.execute("ALTER TABLE kernel.payment_links DROP CONSTRAINT IF EXISTS payment_links_cancel_reason_check")
    op.execute("ALTER TABLE kernel.payment_links DROP COLUMN IF EXISTS cancelled_by_version,"
               " DROP COLUMN IF EXISTS cancel_reason")
