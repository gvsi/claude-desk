"""Copy isolation in Postgres: row-level security on kernel tables, copy-filtered kernel_ro views.

Every kernel table gets row-level security, forced so that it binds the table owner too, with
one policy for desk_kernel: a row is visible and writable only when its copy_id equals the
transaction's `desk.copy_id` setting, which the kernel's sessions set as each transaction begins
(desk.db.session.KernelSession). A missing setting reads as NULL and a reset one as '', and
`nullif` turns both into NULL, so a transaction that set no copy matches no row: it fails closed.
The policy covers every statement shape, including UPDATE, DELETE and functions that run query
text such as `query_to_xml`. A new copy is created by setting its id first and inserting its
`copies` row under the same policy. Anything that must cross copies (startup reconciliation,
reaping old copies) sets each copy in turn, or uses a narrow SECURITY DEFINER function that
returns only copy ids.

The kernel_ro views run with their owner's rights (desk_admin, the superuser that owns kernel.*
and so isn't subject to row security), so each view filters on the same setting itself and is a
`security_barrier` view: the API's own predicates can't run on another copy's rows before the
filter does. If the views' owner were ever subject to row security, the desk_kernel-only policy
would show it nothing: that fails closed too.

Revision ID: 0002_copy_isolation
Revises: 0001_core
"""

from alembic import op

revision = "0002_copy_isolation"
down_revision = "0001_core"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# The kernel_ro views as 0001_core created them, frozen here: each view's columns, in order.
KERNEL_RO_VIEWS = {
    "businesses": "business_id, copy_id, name, owner_display_name, timezone, brand",
    "desks": "desk_id, copy_id, business_id, name, slug, hours, answering, created_at",
    "sessions": "session_id, copy_id, desk_id, kind, verified, assurance, person_id, agent_key_id, mandate_id, "
                "last_language, mode, generation, strikes, created_at, closed_at",
    "people": "person_id, copy_id, desk_id, display_name, masked_contact, notes, created_at",
    "mandates": "mandate_id, copy_id, desk_id, agent_key_id, on_behalf_of, per_charge_cents, total_cents, "
                "committed_cents, reserved_cents, expires_at",
    "documents": "document_id, copy_id, desk_id, title, record_owner_person_id, created_at",
    "leads": "lead_id, copy_id, desk_id, session_id, display_name, note, created_at",
    "tools": "copy_id, desk_id, tool, source, effects, reversible, status, description_confirmed, "
             "pending_definition_text, pending_sha256",
    "price_items": "item_id, copy_id, desk_id, title, unit_cents",
    "calendar_slots": "slot_id, copy_id, desk_id, starts_at, minutes",
    "notification_prefs": "copy_id, desk_id, now, briefing",
    "decisions": "decision_id, copy_id, desk_id, session_id, tool, effects, outcome, state, answers, policy_version, "
                 "card_ids, review, reason_plain, visitor_plain, expires_at, ledger_seq, created_at",
    "approvals": "approval_id, copy_id, decision_id, answer, expires_at, consumed_at",
    "actions": "action_id, copy_id, desk_id, session_id, generation, tool, effects, resource_kind, list_cents, "
               "discount_bp, amount_cents, recipient, starts_at, created_at",
    "policy_versions": "copy_id, desk_id, version, parent_version, cards, status, proof, cedar_sha256, schema_sha256, "
                       "baseline_sha256, profiles_sha256, invariants_sha256, review_thresholds_version, created_at",
    "facts": "fact_id, copy_id, desk_id, kind, status, claims, readers, expires_at",
    "knowledge_items": "item_id, copy_id, desk_id, source, title, text, readers",
    "quotes": "quote_id, copy_id, desk_id, session_id, items, list_cents, discount_bp, amount_cents, status, expires_at",
    "bookings": "booking_id, copy_id, desk_id, slot_id, starts_at, person_id, lead_id, status",
    "payment_links": "link_id, copy_id, desk_id, session_id, quote_id, amount_cents, state, expires_at",
    "handoffs": "handoff_id, copy_id, desk_id, session_id, reason, callback_window, status",
    "ledger_entries": "copy_id, desk_id, seq, prev_hash, created_at, event, hash, signature, key_id",
}


def _script(sql: str) -> None:
    """Run a multi-statement SQL script as-is (no parameters), inside the migration's transaction."""
    op.get_bind().connection.driver_connection.execute(sql)


def _kernel_tables() -> list[str]:
    rows = op.get_bind().exec_driver_sql(
        "SELECT relname FROM pg_class WHERE relnamespace = 'kernel'::regnamespace AND relkind = 'r' ORDER BY relname"
    )
    return [name for (name,) in rows]


def upgrade() -> None:
    for table in _kernel_tables():
        _script(f"""
            ALTER TABLE kernel.{table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE kernel.{table} FORCE ROW LEVEL SECURITY;
            CREATE POLICY copy_scope ON kernel.{table} TO desk_kernel
                USING (copy_id = {CURRENT_COPY}) WITH CHECK (copy_id = {CURRENT_COPY});
        """)
    for view, columns in KERNEL_RO_VIEWS.items():
        _script(f"""
            CREATE OR REPLACE VIEW kernel_ro.{view} WITH (security_barrier = true) AS
                SELECT {columns} FROM kernel.{view} WHERE copy_id = {CURRENT_COPY};
        """)


def downgrade() -> None:
    for view, columns in KERNEL_RO_VIEWS.items():
        _script(f"""
            CREATE OR REPLACE VIEW kernel_ro.{view} WITH (security_barrier = false) AS
                SELECT {columns} FROM kernel.{view};
            ALTER VIEW kernel_ro.{view} RESET (security_barrier);
        """)
    for table in _kernel_tables():
        _script(f"""
            DROP POLICY copy_scope ON kernel.{table};
            ALTER TABLE kernel.{table} NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE kernel.{table} DISABLE ROW LEVEL SECURITY;
        """)
