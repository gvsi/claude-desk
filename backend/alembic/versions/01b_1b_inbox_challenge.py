"""The challenge a Demo inbox code belongs to.

A session reads the verification codes of the challenges it started, and no others. It used to
read every code sent to a person it had asked about, so a session that once typed someone's
contact read the codes other sessions asked for them later, and with each one the contact it went
to, masked, even after the owner had changed it. `kernel.demo_inbox.challenge_id` names the
challenge a `verification_code` entry was sent for, written with the challenge in one transaction,
and a session's read joins it to the challenges the session started.

Every code entry from now on names its challenge and no other entry names one. The check is added
NOT VALID: a code entry written before this revision keeps NULL, so no session's read finds it
(each had a ten-minute code, long expired), while the owner's still lists it. Nothing is updated in
place (an UPDATE would run under the table's forced row security, which a managed Postgres's admin
doesn't bypass). The table is the kernel's alone (desk_kernel's table grants cover the new column),
it joins no kernel_ro view, and desk_ro_owner and desk_resolver get no grant on it.

Revision ID: 01b_1b_inbox_challenge
Revises: 01b_3e_money_cap_edges
"""

from alembic import op

revision = "01b_1b_inbox_challenge"
down_revision = "01b_3e_money_cap_edges"
branch_labels = None
depends_on = None

CHECK = "demo_inbox_challenge_id_check"


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.demo_inbox ADD COLUMN IF NOT EXISTS challenge_id text")
    op.execute(f"""ALTER TABLE kernel.demo_inbox DROP CONSTRAINT IF EXISTS {CHECK},
                   ADD CONSTRAINT {CHECK} CHECK ((challenge_id IS NOT NULL) = (kind = 'verification_code'))
                   NOT VALID""")


def downgrade() -> None:
    # dropping the column drops its check too
    op.execute("ALTER TABLE kernel.demo_inbox DROP COLUMN IF EXISTS challenge_id")
