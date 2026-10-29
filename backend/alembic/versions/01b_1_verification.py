"""Verification challenges: what a demo code is checked against.

0001_core created `kernel.verification_challenges` with its key, copy and code hash only. This
adds the rest: the Desk, the session that asked and the person on record the code went to, the
challenge's status (`live`, then `consumed`, `cancelled`, `expired` or `failed`), one `failed_at`
time per wrong code (a person's failures in the last hour lock their contact), its expiry and
when it was made. At most one challenge is live per person and per session, so a new code always
cancels the old one, even under concurrent requests.

The table has had no writer before this revision, so its new columns are NOT NULL. No column
defaults to Postgres `now()`: every time comes from the kernel's clock. The table joins no
kernel_ro view, and desk_ro_owner and desk_resolver get no grant on it, so the API can't read it.

Revision ID: 01b_1_verification
Revises: 0009_session_id_resolver
"""

from alembic import op

revision = "01b_1_verification"
down_revision = "0009_session_id_resolver"
branch_labels = None
depends_on = None

STATUSES = ("live", "consumed", "cancelled", "expired", "failed")

COLUMNS = [   # (column, definition)
    ("desk_id", "text NOT NULL"),
    ("session_id", "text NOT NULL"),
    ("person_id", "text NOT NULL"),
    ("status", "text NOT NULL CONSTRAINT verification_challenges_status_check CHECK (status IN ("
               + ", ".join(f"'{status}'" for status in STATUSES) + "))"),
    ("failed_at", "timestamptz[] NOT NULL DEFAULT '{}'"),
    ("expires_at", "timestamptz NOT NULL"),
    ("created_at", "timestamptz NOT NULL"),
]

INDEXES = {   # name: (columns, unique, predicate)
    "verification_challenges_live_person": ("person_id", True, "status = 'live'"),     # one live code per person
    "verification_challenges_live_session": ("session_id", True, "status = 'live'"),   # and per session
    "verification_challenges_person_created": ("person_id, created_at", False, None),  # the hourly limits
}


def upgrade() -> None:
    additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in COLUMNS)
    op.execute(f"ALTER TABLE kernel.verification_challenges {additions}")
    for name, (columns, unique, predicate) in INDEXES.items():
        where = f" WHERE {predicate}" if predicate else ""
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX IF NOT EXISTS {name}"
                   f" ON kernel.verification_challenges ({columns}){where}")


def downgrade() -> None:
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in COLUMNS)
    op.execute(f"ALTER TABLE kernel.verification_challenges {drops}")
