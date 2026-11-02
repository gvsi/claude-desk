"""The database's tables and views, by schema (master plan, "Data model and database roles").

`kernel.*` belongs to the kernel process (role desk_kernel), `app.*` and `procrastinate.*` to
the API process (desk_api), `mockpay.*` to the mock payments server (desk_mockpay). The API
reads kernel data only through the `kernel_ro.*` views, which leave out every secret. Every
kernel table and view admits only the copy that the transaction set in `desk.copy_id`
(migration 0002_copy_isolation).
"""

KERNEL_TABLES: tuple[str, ...] = (
    "copies", "businesses", "desks", "people", "leads", "sessions", "verification_challenges",
    "agent_keys", "agent_nonces", "demo_wallet_keys", "mandates", "mandate_reservations", "tools",
    "policy_versions", "actions", "decisions", "approvals", "executions", "facts", "knowledge_items",
    "price_items", "quotes", "calendar_slots", "bookings", "documents", "document_links",
    "payment_links", "handoffs", "notification_prefs", "demo_inbox", "ledger_heads", "ledger_entries",
)

APP_TABLES: tuple[str, ...] = ("messages", "run_events", "setup_interviews", "a2a_turns", "model_calls",
                              "conversation_reads")

MOCKPAY_TABLES: tuple[str, ...] = ("checkouts", "charges", "refunds", "tool_definitions")

# Each kernel_ro view selects these columns, in this order, from the kernel table of the same
# name: the master plan's "Data model" table, which tests/test_db.py compares with this one. No
# view exposes secret hashes, codes, Demo inbox entries, document bodies or canaries, agent or
# wallet keys, approval nonces or raw args. A view's column may be NULL where its table's isn't:
# the knowledge view blanks the title and text of an item the kernel stored owner-only because it
# held a document's canary.
KERNEL_RO_COLUMNS: dict[str, tuple[str, ...]] = {
    "businesses": ("business_id", "copy_id", "name", "owner_display_name", "timezone", "brand"),
    "desks": ("desk_id", "copy_id", "business_id", "name", "slug", "hours", "answering", "created_at"),
    "sessions": ("session_id", "copy_id", "desk_id", "kind", "verified", "assurance", "person_id", "agent_key_id",
                 "mandate_id", "last_language", "mode", "generation", "strikes", "preview", "created_at", "closed_at"),
    "people": ("person_id", "copy_id", "desk_id", "display_name", "masked_contact", "notes", "created_at"),
    "mandates": ("mandate_id", "copy_id", "desk_id", "agent_key_id", "on_behalf_of", "per_charge_cents",
                 "total_cents", "committed_cents", "reserved_cents", "expires_at"),
    "documents": ("document_id", "copy_id", "desk_id", "title", "record_owner_person_id", "created_at"),
    "leads": ("lead_id", "copy_id", "desk_id", "session_id", "display_name", "note", "created_at"),
    "tools": ("copy_id", "desk_id", "tool", "source", "effects", "reversible", "status", "description_confirmed",
              "definition_sha256", "pending_definition_text", "pending_sha256", "review_reason", "business"),   # the pin is public
    "price_items": ("item_id", "copy_id", "desk_id", "title", "unit_cents"),
    "calendar_slots": ("slot_id", "copy_id", "desk_id", "starts_at", "minutes"),
    "notification_prefs": ("copy_id", "desk_id", "now", "briefing"),
    "decisions": ("decision_id", "copy_id", "desk_id", "session_id", "tool", "effects", "outcome", "state",
                  "answers", "policy_version", "card_ids", "review", "reason_plain", "visitor_plain",
                  "expires_at", "ledger_seq", "created_at", "policy_ids"),   # the deciding Cedar policies
    "approvals": ("approval_id", "copy_id", "decision_id", "answer", "expires_at", "consumed_at"),
    "actions": ("action_id", "copy_id", "desk_id", "session_id", "generation", "tool", "effects", "resource_kind",
                "list_cents", "discount_bp", "amount_cents", "recipient", "starts_at", "created_at"),
    "policy_versions": ("copy_id", "desk_id", "version", "parent_version", "cards", "status", "proof",
                        "cedar_sha256", "schema_sha256", "baseline_sha256", "profiles_sha256", "invariants_sha256",
                        "review_thresholds_version", "auto_money_cap_cents", "created_at"),
    "facts": ("fact_id", "copy_id", "desk_id", "kind", "status", "claims", "readers", "expires_at"),
    "knowledge_items": ("item_id", "copy_id", "desk_id", "source", "title", "text", "readers", "created_at"),
    "quotes": ("quote_id", "copy_id", "desk_id", "session_id", "items", "list_cents", "discount_bp",
               "amount_cents", "status", "expires_at", "created_at"),
    "bookings": ("booking_id", "copy_id", "desk_id", "slot_id", "starts_at", "person_id", "lead_id", "status"),
    "payment_links": ("link_id", "copy_id", "desk_id", "session_id", "quote_id", "action_id", "amount_cents",
                      "state", "expires_at"),
    "handoffs": ("handoff_id", "copy_id", "desk_id", "session_id", "reason", "callback_window", "status", "kind"),
    "ledger_entries": ("copy_id", "desk_id", "seq", "prev_hash", "created_at", "event", "hash", "signature",
                       "key_id"),
}

KERNEL_RO_VIEWS: tuple[str, ...] = tuple(KERNEL_RO_COLUMNS)
