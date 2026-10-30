"""The decision a Demo inbox alert is about.

`kernel.demo_inbox.decision_id` holds the decision's own id on the owner's alert for a held request, so
the owner's Demo inbox can link to that request (`DemoInboxEntry.decision_id`). The kernel writes it
from the decision it just stored, never from model or visitor text, and every other entry leaves it
NULL. A check keeps it on owner alerts only: a verification code, a head checkpoint or an alert to
anyone but the owner can't carry one, so no session's own Demo inbox can show a decision.

The table is the kernel's alone (desk_kernel's table grants cover the new column), it joins no kernel_ro
view, and desk_ro_owner and desk_resolver get no grant on it, so the API can't read it. Rows written before
this revision get NULL, which the check admits.

Revision ID: 0012_inbox_decision_id
Revises: api_tables
"""

from alembic import op

revision = "0012_inbox_decision_id"
down_revision = "api_tables"
branch_labels = None
depends_on = None

CHECK = "demo_inbox_decision_id_check"


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.demo_inbox ADD COLUMN decision_id text")
    op.execute(f"""ALTER TABLE kernel.demo_inbox ADD CONSTRAINT {CHECK}
                   CHECK (decision_id IS NULL OR (kind = 'alert' AND "to" = 'owner'))""")


def downgrade() -> None:
    op.execute(f"ALTER TABLE kernel.demo_inbox DROP CONSTRAINT {CHECK}")
    op.execute("ALTER TABLE kernel.demo_inbox DROP COLUMN decision_id")
