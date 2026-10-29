"""People: removing a person from the record, and one live person per contact.

The owner removes a person with `PUT /desks/{id}/people`; the row stays, for the ledger and the
facts that name them, with the time it was removed (`removed_at`, from the kernel's clock), and a
removed person is never on record again. Among a Desk's live people a contact is on record at most
once (a partial unique index on the normalized contact), so a verification code always has one
person to go to.

The API's `kernel_ro.people` skips removed people, with the same columns. The view runs as
desk_ro_owner (0005_kernel_ro_owner), which may SELECT exactly the columns the views show, so the
filter goes in desk_ro_owner's `copy_read` row policy on `kernel.people`, beside the copy rule: a
policy's condition needs no column grant, so `removed_at` stays out of desk_ro_owner's reach and no
view, owner or grant changes. The table belongs to the migration role, which alters its policy
without being a superuser.

Revision ID: 01b_3_people
Revises: 01b_2_handoffs
"""

from alembic import op

revision = "01b_3_people"
down_revision = "01b_2_handoffs"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"


def upgrade() -> None:
    op.execute("ALTER TABLE kernel.people ADD COLUMN IF NOT EXISTS removed_at timestamptz")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS people_desk_live_contact ON kernel.people (desk_id, contact_norm)"
               " WHERE removed_at IS NULL")
    op.execute(f"ALTER POLICY copy_read ON kernel.people USING (copy_id = {CURRENT_COPY} AND removed_at IS NULL)")


def downgrade() -> None:
    op.execute(f"ALTER POLICY copy_read ON kernel.people USING (copy_id = {CURRENT_COPY})")
    op.execute("DROP INDEX IF EXISTS kernel.people_desk_live_contact")
    op.execute("ALTER TABLE kernel.people DROP COLUMN IF EXISTS removed_at")
