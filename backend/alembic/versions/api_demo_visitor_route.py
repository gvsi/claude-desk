"""The demo visitor: `app.model_calls.route` may also be `demo_visitor`, and `app.messages.kind` may too.

The demo visitor (`desk.api.demo_visitors`) is an AI that plays a customer in a visitor chat on the owner's own Desk.
Each of its model calls is recorded like any other, under a route of its own, so its cost stays apart from the Desk's
own and from the built-in visiting agent's. The chat it opens is marked by a `demo_visitor` row in that chat's
transcript, written before it says anything, so the owner's reads label the chat as a demo visitor's after the
process that ran it is gone (its runs live in memory only). Each check is widened by dropping it and adding it again
with the new value (NOT VALID, then validated): the migration runs in one transaction, so re-adding and validating the
checks briefly locks both tables, which is acceptable at their size and before the new API takes traffic. The previous
release never writes either value, so it runs unchanged beside this one during a deploy.
A partial index over the marks alone lets the owner's reads find a Desk's demo visitor chats; the downgrade drops it.

The downgrade puts the narrower checks back as NOT VALID: rows already written stay (the usage records count toward
the day's spend, and the marks keep labelling the chats they mark), while no new row may name either one.

Revision ID: api_demo_visitor_route
Revises: 09_business_tools_view
"""

from alembic import op

revision = "api_demo_visitor_route"
down_revision = "09_business_tools_view"
branch_labels = None
depends_on = None

# The routes and the transcript's kinds before and after this revision, frozen here (the kinds as `api_owner` left
# them).
BEFORE = ("conversation", "setup", "card_draft", "situations", "rules_chat", "visiting_agent", "triage", "translation")
AFTER = (*BEFORE, "demo_visitor")
KINDS_BEFORE = ("visitor_text", "agent_text", "delivered", "status", "owner_say", "whisper", "action_update",
                "desk_context", "note", "context_start", "tool_change", "model_assistant", "model_tool_results",
                "triage", "annotation", "owner_joined", "owner_left", "stopped_draft")
KINDS_AFTER = (*KINDS_BEFORE, "demo_visitor")


def _in(values: tuple[str, ...]) -> str:
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    op.execute(f"""
        ALTER TABLE app.model_calls
            DROP CONSTRAINT IF EXISTS model_calls_route,
            ADD CONSTRAINT model_calls_route CHECK (route IN {_in(AFTER)}) NOT VALID;
        ALTER TABLE app.model_calls VALIDATE CONSTRAINT model_calls_route;
        ALTER TABLE app.messages
            DROP CONSTRAINT IF EXISTS messages_kind,
            ADD CONSTRAINT messages_kind CHECK (kind IN {_in(KINDS_AFTER)}) NOT VALID;
        ALTER TABLE app.messages VALIDATE CONSTRAINT messages_kind;
        CREATE INDEX IF NOT EXISTS messages_demo_visitor ON app.messages (copy_id, desk_id) WHERE kind = 'demo_visitor';
    """)


def downgrade() -> None:
    op.execute(f"""
        DROP INDEX IF EXISTS app.messages_demo_visitor;
        ALTER TABLE app.messages
            DROP CONSTRAINT IF EXISTS messages_kind,
            ADD CONSTRAINT messages_kind CHECK (kind IN {_in(KINDS_BEFORE)}) NOT VALID;
        ALTER TABLE app.model_calls
            DROP CONSTRAINT IF EXISTS model_calls_route,
            ADD CONSTRAINT model_calls_route CHECK (route IN {_in(BEFORE)}) NOT VALID;
    """)
