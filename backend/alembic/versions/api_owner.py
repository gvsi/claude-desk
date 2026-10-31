"""The owner tools' rows in the API's transcripts (Plan 02b): four more `app.messages` kinds.

`api_tables` is applied to the hosted database as Plan 02a left it, so it is never edited; this widens its
`messages_kind` check instead. Every row the check admitted before still passes it.

- An `annotation` row marks a translation or triage written later onto an earlier row, so an owner polling with the
  cursor sees it.
- An `owner_joined` or `owner_left` row keeps a take-over or a hand-back in the transcript, holding the event the
  visitor's stream got (`event_seq`).
- A `stopped_draft` row keeps a draft of Claude's the kernel's reply check stopped, and why, for the owner alone.

The downgrade puts back the narrower check, so a table that holds any of these rows fails it instead of losing them.

Revision ID: api_owner
Revises: 0012_inbox_decision_id
"""

from alembic import op

revision = "api_owner"
down_revision = "0012_inbox_decision_id"
branch_labels = None
depends_on = None

# `api_tables`' kinds, as it applied them, and the ones the owner tools add.
API_TABLES_KINDS = ("visitor_text", "agent_text", "delivered", "status", "owner_say", "whisper", "action_update",
                    "desk_context", "note", "context_start", "tool_change", "model_assistant", "model_tool_results",
                    "triage")
OWNER_KINDS = ("annotation", "owner_joined", "owner_left", "stopped_draft")


def _kind_check(kinds: tuple[str, ...]) -> str:
    listed = ", ".join(f"'{kind}'" for kind in kinds)
    return f"""
        ALTER TABLE app.messages
            DROP CONSTRAINT messages_kind,
            ADD CONSTRAINT messages_kind CHECK (kind IN ({listed}));
    """


def upgrade() -> None:
    op.execute(_kind_check((*API_TABLES_KINDS, *OWNER_KINDS)))


def downgrade() -> None:
    op.execute(_kind_check(API_TABLES_KINDS))
