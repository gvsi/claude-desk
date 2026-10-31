"""When each knowledge item was first added, in the API's read-only view.

Append the kernel's existing timestamp without changing the title/text masking from
01b_5b_knowledge_view. The view keeps its security barrier, transaction-copy filter and
desk_ro_owner ownership; desk_api receives only SELECT on the view. Drop without CASCADE
so unexpected dependencies fail atomically, as in kernel_ro_decision_policy_ids.

Revision ID: kernel_ro_knowledge_created_at
Revises: kernel_ro_decision_policy_ids
"""

from alembic import op

revision = "kernel_ro_knowledge_created_at"
down_revision = "kernel_ro_decision_policy_ids"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# Frozen from 01b_5b_knowledge_view: show text only if the latest ledger entry says it is safe.
SHOWN = """(SELECT e.event #> '{summary,owner_only_forced}' FROM kernel.ledger_entries e
            WHERE e.desk_id = k.desk_id AND e.copy_id = k.copy_id
              AND e.event @> jsonb_build_object('kind', 'desk_data', 'summary',
                                                jsonb_build_object('part', 'knowledge', 'item_id', k.item_id))
            ORDER BY e.seq DESC LIMIT 1) = 'false'::jsonb"""

# The view's select lists before and after this revision, frozen here.
BEFORE = (f"k.item_id, k.copy_id, k.desk_id, k.source, CASE WHEN {SHOWN} THEN k.title END AS title,"
          f" CASE WHEN {SHOWN} THEN k.text END AS text, k.readers")
AFTER = f"{BEFORE}, k.created_at"


def _script(sql: str) -> None:
    """Run a multi-statement script inside the migration's transaction."""
    op.get_bind().connection.driver_connection.execute(sql)


def _change_owner(role: str, schema: str, statements: str) -> None:
    """Lend an admin SET on the owner and the owner CREATE on the schema only for the ownership change."""
    _script(f"""
        GRANT {role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
        GRANT CREATE ON SCHEMA {schema} TO {role};
        {statements}
        REVOKE CREATE ON SCHEMA {schema} FROM {role};
        REVOKE {role} FROM CURRENT_USER;
    """)


def _recreate_view(select_list: str) -> None:
    _script(f"""
        DROP VIEW kernel_ro.knowledge_items;
        CREATE VIEW kernel_ro.knowledge_items WITH (security_barrier = true) AS
            SELECT {select_list} FROM kernel.knowledge_items k WHERE k.copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.knowledge_items TO desk_api;
    """)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.knowledge_items OWNER TO desk_ro_owner;")


def upgrade() -> None:
    _script("GRANT SELECT (created_at) ON kernel.knowledge_items TO desk_ro_owner;")
    _recreate_view(AFTER)


def downgrade() -> None:
    _recreate_view(BEFORE)
    _script("REVOKE SELECT (created_at) ON kernel.knowledge_items FROM desk_ro_owner;")
