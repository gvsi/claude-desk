"""The demo visitor's model calls: `app.model_calls.route` may also be `demo_visitor`.

The demo visitor (`desk.api.demo_visitors`) is an AI that plays a customer in a visitor chat on the owner's own Desk.
Each of its model calls is recorded like any other, under a route of its own, so its cost stays apart from the Desk's
own and from the built-in visiting agent's. The route check is widened by dropping it and adding it again with the
new route; the previous release never writes the new route, so it runs unchanged beside this one during a deploy.

The downgrade puts the narrower check back as NOT VALID: rows the demo visitor already wrote stay (they are usage
records, and deleting them would undercount the day's spend), while no new row may name the route.

Revision ID: api_demo_visitor_route
Revises: 09_business_tools_view
"""

from alembic import op

revision = "api_demo_visitor_route"
down_revision = "09_business_tools_view"
branch_labels = None
depends_on = None

# The routes before and after this revision, frozen here.
BEFORE = ("conversation", "setup", "card_draft", "situations", "rules_chat", "visiting_agent", "triage", "translation")
AFTER = (*BEFORE, "demo_visitor")


def _in(values: tuple[str, ...]) -> str:
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    op.execute(f"""
        ALTER TABLE app.model_calls
            DROP CONSTRAINT IF EXISTS model_calls_route,
            ADD CONSTRAINT model_calls_route CHECK (route IN {_in(AFTER)});
    """)


def downgrade() -> None:
    op.execute(f"""
        ALTER TABLE app.model_calls
            DROP CONSTRAINT IF EXISTS model_calls_route,
            ADD CONSTRAINT model_calls_route CHECK (route IN {_in(BEFORE)}) NOT VALID;
    """)
