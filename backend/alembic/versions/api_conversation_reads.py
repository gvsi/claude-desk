"""The owner's read markers: `app.conversation_reads`, one row per conversation the owner has opened.

A conversation is unread while a visitor or a visiting agent wrote a message (`visitor_text`, `agent_text`) after the
transcript cursor the owner has seen (`read_through_n`, an `app.messages.n`), or wrote any and the owner never opened
it. Each copy has one owner, so the key is the copy and the session. The marker only moves forward, and never past the
session's newest message (`desk.api.conversation_reads`). It holds no secret, only IDs, a cursor and times: when the
marker last moved (`read_at`) and when it was first set (`created_at`, which every `app.*` table has).

`messages_said` indexes the visitors' and agents' words by copy, Desk and session, so the unread reads the owner's
pages poll (the conversations list, and the count for each Desk in the Desk switcher) read only those rows.

The API's role reads and writes the table as it does every `app.*` table: the schema's default privileges grant it,
and the grant here says so outright. The kernel's and the mock payments server's roles have no access to `app`.
Like the revisions before it, it runs again over what it added (a test stamps below an earlier revision and upgrades).

Revision ID: api_conversation_reads
Revises: 09_business_tools_view
"""

from alembic import op

revision = "api_conversation_reads"
# Chains after kernel_one_open_handoff once that revision lands on main.
down_revision = "09_business_tools_view"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS app.conversation_reads (
            copy_id text NOT NULL,
            desk_id text NOT NULL,
            session_id text NOT NULL,
            read_through_n bigint NOT NULL,
            read_at timestamptz NOT NULL DEFAULT now(),
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (copy_id, session_id),
            CONSTRAINT conversation_reads_cursor CHECK (read_through_n >= 0)
        );
        GRANT SELECT, INSERT, UPDATE, DELETE ON app.conversation_reads TO desk_api;
        CREATE INDEX IF NOT EXISTS messages_said ON app.messages (copy_id, desk_id, session_id, n)
            WHERE kind IN ('visitor_text', 'agent_text');
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX IF EXISTS app.messages_said;
        DROP TABLE IF EXISTS app.conversation_reads;
    """)
