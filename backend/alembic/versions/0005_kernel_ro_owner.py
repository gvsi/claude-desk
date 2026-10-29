"""The kernel_ro views run as desk_ro_owner, a role bound by row security, on any Postgres.

A view reads its tables with its owner's rights. The views belonged to desk_admin, which skips
row security only because the local migration role is a superuser; where it isn't (a managed
Postgres whose admin role has neither SUPERUSER nor BYPASSRLS), the forced row security of
0002_copy_isolation, whose only policy was desk_kernel's, would leave every view empty. The views
now belong to desk_ro_owner, a NOLOGIN role with neither attribute. It may SELECT exactly the
columns the views show, and its `copy_read` policy admits the rows of the copy the transaction set
in `desk.copy_id`: the same rule as each view's own filter, which stays, so the views behave the
same wherever they run and no longer run as a superuser.

Revision ID: 0005_kernel_ro_owner
Revises: 0004_copy_resolvers
"""

from alembic import op

revision = "0005_kernel_ro_owner"
down_revision = "0004_copy_resolvers"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# The kernel_ro views' columns, as 0001_core created them and 0002_copy_isolation kept them, frozen here.
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


def upgrade() -> None:
    # Roles are cluster-wide: created only if missing, and kept by a downgrade (as in roles.sql).
    _script("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_ro_owner') THEN
                CREATE ROLE desk_ro_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
            END IF;
        END
        $$;
        GRANT USAGE ON SCHEMA kernel TO desk_ro_owner;
    """)
    for view, columns in KERNEL_RO_VIEWS.items():
        _script(f"""
            GRANT SELECT ({columns}) ON kernel.{view} TO desk_ro_owner;
            CREATE POLICY copy_read ON kernel.{view} FOR SELECT TO desk_ro_owner USING (copy_id = {CURRENT_COPY});
            ALTER VIEW kernel_ro.{view} OWNER TO desk_ro_owner;
        """)


def downgrade() -> None:
    for view, columns in KERNEL_RO_VIEWS.items():
        _script(f"""
            ALTER VIEW kernel_ro.{view} OWNER TO CURRENT_USER;
            DROP POLICY copy_read ON kernel.{view};
            REVOKE SELECT ({columns}) ON kernel.{view} FROM desk_ro_owner;
        """)
    _script("REVOKE USAGE ON SCHEMA kernel FROM desk_ro_owner;")
