"""Agent columns: signed visiting agents, their nonces, the demo wallet and the mandates it signs.

An agent key keeps only its public half (`public_key_hex`), the Desk it was minted for, where it
came from (`source`, `demo` for now) and who minted it (`minted_by`: a session ID, or `owner`).
A nonce row binds one signed turn to its session and the sha256 of the A2A body it signs, with
when it was first used, how many reply checks it has had and when the turn ended. Each copy has
one demo wallet, the trusted issuer of its mandates, whose key the kernel holds. A mandate keeps
the session that presented it, its issuer and nonce (unique per copy, so a mandate opens one
session) and the whole signed envelope; its amounts stay within its own limits.

The tables are empty before this revision (nothing wrote them), so NOT NULL needs no default.
None of these columns joins a kernel_ro view, and desk_ro_owner and desk_resolver get no grant on
them: the API can read neither key, nonce nor envelope. desk_kernel already holds DML on every
kernel table (0001_core), and nothing here changes an owner, so any admin role can run it.

Revision ID: 01c_1_agents
Revises: 01c_0_mockpay
"""

from alembic import op

revision = "01c_1_agents"
down_revision = "01c_0_mockpay"
branch_labels = None
depends_on = None

COLUMNS = {   # table: [(column, definition)]
    "agent_keys": [("desk_id", "text NOT NULL"), ("public_key_hex", "text NOT NULL"), ("source", "text NOT NULL"),
                   ("minted_by", "text NOT NULL"), ("created_at", "timestamptz NOT NULL")],
    "agent_nonces": [("session_id", "text NOT NULL"), ("body_sha256", "text NOT NULL"),
                     ("first_used_at", "timestamptz NOT NULL"), ("check_replies", "integer NOT NULL DEFAULT 0"),
                     ("spent_at", "timestamptz")],
    "demo_wallet_keys": [("public_key_hex", "text NOT NULL"), ("private_key_hex", "text NOT NULL")],
    "mandates": [("session_id", "text NOT NULL"), ("issuer", "text NOT NULL"), ("nonce", "text NOT NULL"),
                 ("envelope", "jsonb NOT NULL")],
}

HEX32 = "'^[0-9a-f]{64}$'"
CHECKS = {   # name: (table, condition)
    "agent_keys_source_check": ("agent_keys", "source IN ('demo')"),
    "agent_keys_public_key_check": ("agent_keys", f"public_key_hex ~ {HEX32}"),
    "agent_nonces_body_check": ("agent_nonces", f"body_sha256 ~ {HEX32}"),
    "agent_nonces_replies_check": ("agent_nonces", "check_replies >= 0"),
    "demo_wallet_keys_hex_check": ("demo_wallet_keys", f"public_key_hex ~ {HEX32} AND private_key_hex ~ {HEX32}"),
    "mandates_amounts_check": ("mandates", "per_charge_cents >= 1 AND per_charge_cents <= total_cents"
                                           " AND committed_cents >= 0 AND reserved_cents >= 0"
                                           " AND committed_cents + reserved_cents <= total_cents"),
}

INDEXES = {   # name: (table, columns, unique)
    "demo_wallet_keys_copy": ("demo_wallet_keys", "copy_id", True),          # one demo wallet per copy
    "mandates_copy_nonce": ("mandates", "copy_id, nonce", True),             # a mandate opens one session
    "agent_keys_copy_minted": ("agent_keys", "copy_id, source, created_at", False),   # the hourly mint limit
}


def upgrade() -> None:
    for table, columns in COLUMNS.items():
        additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in columns)
        op.execute(f"ALTER TABLE kernel.{table} {additions}")
    for name, (table, condition) in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.{table} DROP CONSTRAINT IF EXISTS {name},"
                   f" ADD CONSTRAINT {name} CHECK ({condition})")
    for name, (table, columns, unique) in INDEXES.items():
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX IF NOT EXISTS {name} ON kernel.{table} ({columns})")


def downgrade() -> None:
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    for name, (table, _) in CHECKS.items():
        op.execute(f"ALTER TABLE kernel.{table} DROP CONSTRAINT IF EXISTS {name}")
    for table, columns in COLUMNS.items():
        drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in columns)
        # a row left with only its key means nothing (a key with no public half, a mandate with no envelope),
        # and would keep the upgrade from adding its NOT NULL columns back; TRUNCATE, unlike DELETE, isn't
        # held back by row security, which every kernel table forces on its owner too, so any admin empties it
        op.execute(f"TRUNCATE kernel.{table}")
        op.execute(f"ALTER TABLE kernel.{table} {drops}")
