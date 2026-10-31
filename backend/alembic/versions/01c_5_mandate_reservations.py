"""Mandate reservations: what an agent's money action holds on its mandate until it settles.

0001_core created `kernel.mandate_reservations` with its key and copy. This adds the rest: the
mandate it holds money on, the action that holds it (unique, so one action holds one reservation),
the amount, its state (`reserved` while the action's outcome is open, then `committed` once money
moved or `released` once it can't), and when it was made and last changed. The mandate's own
`reserved_cents` and `committed_cents` are the sums of its reservations in those states, kept in
step under the mandate row's lock. Every time comes from the kernel's clock, so no column defaults
to Postgres `now()`. Nothing wrote the table before this revision, so NOT NULL needs no default, and
an amount is a whole number of cents from 0 to $10,000.

No kernel_ro view shows the table and no grant changes: desk_kernel already holds DML on every
kernel table (0001_core), and nothing here changes an owner, so any admin role can run it.

Revision ID: 01c_5_mandate_reservations
Revises: 01c_4_tool_pins
"""

from alembic import op

revision = "01c_5_mandate_reservations"
down_revision = "01c_4_tool_pins"
branch_labels = None
depends_on = None

COLUMNS = [   # (column, definition)
    ("mandate_id", "text NOT NULL"),
    ("action_id", "text NOT NULL"),
    ("amount_cents", "bigint NOT NULL"),
    ("state", "text NOT NULL"),
    ("created_at", "timestamptz NOT NULL"),
    ("updated_at", "timestamptz NOT NULL"),
]

CHECKS = {   # name: condition; 1000000 is desk.contracts.AUTO_MONEY_HARD_CAP_CENTS, frozen here
    "mandate_reservations_state_check": "state IN ('reserved', 'committed', 'released')",
    "mandate_reservations_amount_check": "amount_cents BETWEEN 0 AND 1000000",
}

INDEXES = {   # name: (columns, unique)
    "mandate_reservations_action": ("action_id", True),         # one action holds one reservation
    "mandate_reservations_mandate": ("copy_id, mandate_id", False),
}


def upgrade() -> None:
    additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in COLUMNS)
    op.execute(f"ALTER TABLE kernel.mandate_reservations {additions}")
    for name, condition in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.mandate_reservations DROP CONSTRAINT IF EXISTS {name},"
                   f" ADD CONSTRAINT {name} CHECK ({condition})")
    for name, (columns, unique) in INDEXES.items():
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX IF NOT EXISTS {name}"
                   f" ON kernel.mandate_reservations ({columns})")


def downgrade() -> None:
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    for name in CHECKS:
        op.execute(f"ALTER TABLE kernel.mandate_reservations DROP CONSTRAINT IF EXISTS {name}")
    # a reservation left with only its key holds nothing, and would keep the upgrade from adding its NOT
    # NULL columns back; TRUNCATE, unlike DELETE, isn't held back by row security, which every kernel table
    # forces on its owner too, so any admin empties it
    op.execute("TRUNCATE kernel.mandate_reservations")
    drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in COLUMNS)
    op.execute(f"ALTER TABLE kernel.mandate_reservations {drops}")
