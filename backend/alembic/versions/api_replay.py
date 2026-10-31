"""Recorded history in the API's tables: `replay_id` on transcripts and run events.

Each demo copy can open on a recorded night the kernel replays into it (Plan 01d). The API stores the replayed
messages, replies and receipts it is given as ordinary `app.messages` rows and `app.run_events` events, each stamped
with the copy's `replay_id` (the recording the kernel's replayed rows carry too), so the owner's reads can tell
recorded history from live activity. Live rows leave it null.

Revision ID: api_replay
Revises: api_owner
"""

from alembic import op

revision = "api_replay"
down_revision = "api_owner"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE app.messages ADD COLUMN replay_id text;
        ALTER TABLE app.run_events ADD COLUMN replay_id text;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE app.run_events DROP COLUMN replay_id;
        ALTER TABLE app.messages DROP COLUMN replay_id;
    """)
