"""Handoffs: the callbacks visitors ask for, with the window the kernel picked.

0001_core created `kernel.handoffs` with the reason, the window as text (`callback_window`, ISO
8601 `<start>/<end>`, which `kernel_ro.handoffs` serves) and the status. This adds the action
that wrote each one, one handoff per action, so an execution whose outcome is unknown can be
reconciled by its action, and the window's start and end as times, both null when no hour was
open.

The table has had no writer before this revision, so `action_id` is NOT NULL. None of these
columns joins a kernel_ro view, and desk_ro_owner and desk_resolver get no grant on them, so the
view stays as it is.

Revision ID: 01b_2_handoffs
Revises: 01b_1_verification
"""

from alembic import op

revision = "01b_2_handoffs"
down_revision = "01b_1_verification"
branch_labels = None
depends_on = None

COLUMNS = [   # (column, definition)
    ("action_id", "text NOT NULL"),
    ("window_start", "timestamptz"),
    ("window_end", "timestamptz"),
]

INDEXES = {   # name: (columns, unique)
    "handoffs_action": ("action_id", True),         # one handoff per action
}


def upgrade() -> None:
    additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in COLUMNS)
    op.execute(f"ALTER TABLE kernel.handoffs {additions}")
    for name, (columns, unique) in INDEXES.items():
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX IF NOT EXISTS {name} ON kernel.handoffs ({columns})")


def downgrade() -> None:
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in COLUMNS)
    op.execute(f"ALTER TABLE kernel.handoffs {drops}")
