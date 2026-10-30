"""Kernel core columns: what the kernel service needs beyond the columns 0001_core created.

Plan 01a's "Kernel columns this plan relies on": token and contact columns, tool profiles,
compiled policy versions, normalized actions, signed decisions, approval bindings, execution
intents, fact provenance, the Demo inbox, and the keys and indexes those tables need. This
revision adds columns and indexes only; the per-Desk keys, the ledger and its constraints come
from 0001_core and 0003_state_checks.

A column is NOT NULL where every row has a value and no earlier revision's tests write the
table: people's contact columns, actions, executions and the Demo inbox. Elsewhere it is
nullable, so rows written before this revision (the database tests write decisions, approvals,
tools, facts, quotes, bookings, documents and sessions) stay valid; the kernel's writers always
set them. No column defaults to Postgres `now()`: every time comes from the kernel's clock.
None of these columns joins a kernel_ro view, and desk_ro_owner and desk_resolver get no grant
on them, so the API can't read them.

Revision ID: 0008_kernel_core
Revises: 0007_model_call_finish
"""

from alembic import op

revision = "0008_kernel_core"
down_revision = "0007_model_call_finish"
branch_labels = None
depends_on = None

COLUMNS = {   # table: [(column, definition)]
    "desks": [("deleted_at", "timestamptz")],
    "people": [("ref", "text NOT NULL"), ("contact", "text NOT NULL"), ("contact_norm", "text NOT NULL")],
    "sessions": [("last_seen_at", "timestamptz")],
    "tools": [("profile", "jsonb"), ("profile_sha256", "text")],
    "policy_versions": [("cards_sha256", "text"), ("draft_key_sha256", "text"), ("cedar", "jsonb"),
                        ("schema_json", "text"), ("preset", "text")],
    "actions": [("args_json", "jsonb NOT NULL"), ("args_sha256", "text NOT NULL"),
                ("profile_sha256", "text NOT NULL"), ("resource", "jsonb NOT NULL")],
    "decisions": [("action_id", "text"), ("policy_ids", "jsonb NOT NULL DEFAULT '[]'::jsonb"), ("signature", "text"),
                  ("updated_at", "timestamptz")],
    "approvals": [("nonce", "text"), ("binding_sha256", "text"), ("policy_version", "integer"),
                  ("created_at", "timestamptz")],
    "executions": [("decision_id", "text NOT NULL"), ("state", "text NOT NULL"), ("result", "jsonb"),
                   ("started_at", "timestamptz NOT NULL"), ("finished_at", "timestamptz")],
    "facts": [("session_id", "text"), ("action_id", "text"), ("source", "text"), ("record_owner", "text"),
              ("created_at", "timestamptz")],
    "quotes": [("action_id", "text"), ("created_at", "timestamptz")],
    "bookings": [("action_id", "text"), ("session_id", "text")],
    "documents": [("ref", "text")],
    "demo_inbox": [("desk_id", "text NOT NULL"), ('"to"', "text NOT NULL"), ("person_id", "text"),
                   ("kind", "text NOT NULL"), ("body", "text NOT NULL"), ("preview", "text NOT NULL"),
                   ("created_at", "timestamptz NOT NULL")],
}

INDEXES = {   # name: (table, columns, unique)
    "people_desk_ref": ("people", "desk_id, ref", True),                     # seed refs are stable per Desk
    "people_desk_contact_norm": ("people", "desk_id, contact_norm", False),  # verification finds the contact on record
    "policy_versions_desk_draft_key": ("policy_versions", "desk_id, draft_key_sha256", True),   # idempotent drafts
    "facts_action": ("facts", "action_id", False),
    "quotes_action": ("quotes", "action_id", True),                          # one quote per action
    "bookings_action": ("bookings", "action_id", True),                      # one booking per action
}


def upgrade() -> None:
    for table, columns in COLUMNS.items():
        additions = ", ".join(f"ADD COLUMN IF NOT EXISTS {column} {definition}" for column, definition in columns)
        op.execute(f"ALTER TABLE kernel.{table} {additions}")
    for name, (table, columns, unique) in INDEXES.items():
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX IF NOT EXISTS {name} ON kernel.{table} ({columns})")


def downgrade() -> None:
    for name in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS kernel.{name}")
    for table, columns in COLUMNS.items():
        drops = ", ".join(f"DROP COLUMN IF EXISTS {column}" for column, _ in columns)
        op.execute(f"ALTER TABLE kernel.{table} {drops}")
