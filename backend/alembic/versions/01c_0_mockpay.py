"""Mock payments columns: what the mock payments server stores beyond the keys 0001_core created.

Checkouts, charges and refunds each carry the idempotency key the kernel sent, unique per copy
and table, so a repeated request finds its first answer and a key the kernel voided (a row in
state `voided`, with no amount) makes every later request with it fail. A checkout's charge uses
the key `<checkout key>:charge`. A charge names the person it belongs to (`owner_person_id`, for a
`person:` customer) and how much of it has been refunded; a refund names its charge. Tool
definitions hold a copy's changed MCP tool entry. Every amount is a whole number of cents from 1
to 1,000,000, and refunds never exceed their charge.

The tables are empty before this revision (nothing wrote them), so NOT NULL needs no default. A
downgrade deletes the mock provider's rows with their columns, since a row left with only its key
means nothing, so upgrading again starts from empty tables as the first upgrade did. The server's
role, desk_mockpay, already holds DML on every mockpay table (0001_core), and no other role may
use the schema. Nothing here changes an owner, so any admin role can run it.

Revision ID: 01c_0_mockpay
Revises: 01b_1b_inbox_challenge
"""

from alembic import op

revision = "01c_0_mockpay"
down_revision = "01b_1b_inbox_challenge"
branch_labels = None
depends_on = None

COLUMNS = {   # table: [(column, definition)]
    "checkouts": [("idempotency_key", "text NOT NULL"), ("amount_cents", "bigint"), ("title", "text"),
                  ("customer_id", "text"), ("state", "text NOT NULL"), ("charge_id", "text")],
    "charges": [("owner_person_id", "text"), ("customer_id", "text"), ("amount_cents", "bigint"),
                ("description", "text"), ("idempotency_key", "text NOT NULL"), ("state", "text NOT NULL"),
                ("refunded_cents", "bigint NOT NULL DEFAULT 0"), ("created_at", "timestamptz NOT NULL DEFAULT now()")],
    "refunds": [("charge_id", "text"), ("amount_cents", "bigint"), ("idempotency_key", "text NOT NULL"),
                ("state", "text NOT NULL")],
    "tool_definitions": [("definition", "jsonb NOT NULL")],
}

AMOUNT = "amount_cents BETWEEN 1 AND 1000000"
CHECKS = {   # name: (table, condition)
    "checkouts_state_check": ("checkouts", "state IN ('open', 'succeeded', 'cancelled', 'voided')"),
    "checkouts_filled_check": ("checkouts", f"state = 'voided' OR ({AMOUNT} AND title IS NOT NULL"
                                            " AND customer_id IS NOT NULL)"),
    "checkouts_charge_check": ("checkouts", "(state = 'succeeded') = (charge_id IS NOT NULL)"),
    "charges_state_check": ("charges", "state IN ('succeeded', 'voided')"),
    "charges_filled_check": ("charges", f"state = 'voided' OR ({AMOUNT} AND customer_id IS NOT NULL"
                                        " AND description IS NOT NULL)"),
    "charges_refunded_check": ("charges", "refunded_cents >= 0 AND refunded_cents <= coalesce(amount_cents, 0)"),
    "refunds_state_check": ("refunds", "state IN ('succeeded', 'voided')"),
    "refunds_filled_check": ("refunds", f"state = 'voided' OR ({AMOUNT} AND charge_id IS NOT NULL)"),
}

INDEXES = {   # name: (table, columns, unique)
    "checkouts_copy_key": ("checkouts", "copy_id, idempotency_key", True),
    "charges_copy_key": ("charges", "copy_id, idempotency_key", True),
    "refunds_copy_key": ("refunds", "copy_id, idempotency_key", True),
    "charges_copy_customer": ("charges", "copy_id, customer_id", False),   # list_charges
}


def upgrade() -> None:
    for table, columns in COLUMNS.items():
        additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in columns)
        op.execute(f"ALTER TABLE mockpay.{table} {additions}")
    for name, (table, condition) in CHECKS.items():
        op.execute(f"ALTER TABLE mockpay.{table} DROP CONSTRAINT IF EXISTS {name},"
                   f" ADD CONSTRAINT {name} CHECK ({condition})")
    for name, (table, columns, unique) in INDEXES.items():
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX IF NOT EXISTS {name} ON mockpay.{table} ({columns})")


def downgrade() -> None:
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS mockpay.{name}")
    for name, (table, _) in CHECKS.items():
        op.execute(f"ALTER TABLE mockpay.{table} DROP CONSTRAINT IF EXISTS {name}")
    for table, columns in COLUMNS.items():
        drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in columns)
        op.execute(f"DELETE FROM mockpay.{table}")
        op.execute(f"ALTER TABLE mockpay.{table} {drops}")
