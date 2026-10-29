"""Core schemas, tables, kernel_ro views, roles and grants.

Implements the master plan's "Data model and database roles": the three process roles (created
without login; `make db-roles` sets their passwords), schemas kernel, app, mockpay, kernel_ro and
procrastinate owned by desk_admin, and each table with its key, copy_id and the columns the
kernel_ro views and the database tests name. Later revisions add the rest of each table with
`ADD COLUMN IF NOT EXISTS`. A downgrade drops the schemas and keeps the roles, which are
cluster-wide.

Revision ID: 0001_core
Revises:
"""

from pathlib import Path

from alembic import op

import desk.db

revision = "0001_core"
down_revision = None
branch_labels = None
depends_on = None

SCHEMAS = ("kernel", "app", "mockpay", "kernel_ro", "procrastinate")
ROLES_SQL = Path(desk.db.__file__).with_name("roles.sql")
PROCRASTINATE_SQL = Path(__file__).with_name("0001_procrastinate_schema.sql")

KERNEL_TABLES_SQL = """
CREATE TABLE kernel.copies (
    copy_id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel.businesses (
    business_id text PRIMARY KEY,
    copy_id text NOT NULL,
    name text NOT NULL,
    owner_display_name text NOT NULL,
    timezone text NOT NULL,
    brand jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE kernel.desks (
    desk_id text PRIMARY KEY,
    copy_id text NOT NULL,
    business_id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    hours jsonb NOT NULL DEFAULT '[]'::jsonb,
    answering boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel.people (
    person_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    display_name text NOT NULL,
    masked_contact text NOT NULL,
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel.leads (
    lead_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    session_id text,
    display_name text,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel.sessions (
    session_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text,
    kind text NOT NULL,
    secret_hash text UNIQUE,
    verified boolean NOT NULL DEFAULT false,
    assurance text NOT NULL DEFAULT 'none',
    person_id text,
    agent_key_id text,
    mandate_id text,
    last_language text,
    mode text NOT NULL DEFAULT 'ai',
    generation integer NOT NULL DEFAULT 0,
    strikes integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz
);
CREATE TABLE kernel.verification_challenges (
    challenge_id text PRIMARY KEY,
    copy_id text NOT NULL,
    code_hash text NOT NULL
);
CREATE TABLE kernel.agent_keys (
    copy_id text NOT NULL,
    agent_key_id text NOT NULL,
    PRIMARY KEY (copy_id, agent_key_id)
);
CREATE TABLE kernel.agent_nonces (
    copy_id text NOT NULL,
    agent_key_id text NOT NULL,
    nonce text NOT NULL,
    PRIMARY KEY (copy_id, agent_key_id, nonce)
);
CREATE TABLE kernel.demo_wallet_keys (
    copy_id text NOT NULL,
    key_id text NOT NULL,
    PRIMARY KEY (copy_id, key_id)
);
CREATE TABLE kernel.mandates (
    mandate_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    agent_key_id text NOT NULL,
    on_behalf_of text,
    per_charge_cents bigint NOT NULL,
    total_cents bigint NOT NULL,
    committed_cents bigint NOT NULL DEFAULT 0,
    reserved_cents bigint NOT NULL DEFAULT 0,
    expires_at text NOT NULL
);
CREATE TABLE kernel.mandate_reservations (
    reservation_id text PRIMARY KEY,
    copy_id text NOT NULL
);
CREATE TABLE kernel.tools (
    desk_id text NOT NULL,
    tool text NOT NULL,
    copy_id text NOT NULL,
    source text NOT NULL,
    effects jsonb NOT NULL,
    reversible boolean NOT NULL,
    status text NOT NULL,
    description_confirmed text NOT NULL,
    pending_definition_text text,
    pending_sha256 text,
    PRIMARY KEY (desk_id, tool)
);
CREATE TABLE kernel.policy_versions (
    desk_id text NOT NULL,
    version integer NOT NULL,
    copy_id text NOT NULL,
    parent_version integer,
    cards jsonb NOT NULL,
    status text NOT NULL,
    proof jsonb,
    cedar_sha256 text NOT NULL,
    schema_sha256 text NOT NULL,
    baseline_sha256 text NOT NULL,
    profiles_sha256 text NOT NULL,
    invariants_sha256 text NOT NULL,
    review_thresholds_version integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (desk_id, version)
);
CREATE TABLE kernel.actions (
    action_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    session_id text NOT NULL,
    generation integer NOT NULL,
    tool text NOT NULL,
    effects jsonb NOT NULL,
    resource_kind text NOT NULL,
    list_cents bigint,
    discount_bp integer,
    amount_cents bigint,
    recipient text,
    starts_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel.decisions (
    decision_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    session_id text NOT NULL,
    generation integer NOT NULL,
    call_id text NOT NULL,
    call_sha256 text NOT NULL,
    tool text NOT NULL,
    effects jsonb NOT NULL DEFAULT '[]'::jsonb,
    outcome text NOT NULL,
    state text NOT NULL,
    answers jsonb NOT NULL DEFAULT '[]'::jsonb,
    policy_version integer NOT NULL,
    card_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    review jsonb,
    reason_plain text NOT NULL,
    visitor_plain text NOT NULL,
    expires_at timestamptz NOT NULL,
    ledger_seq bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, generation, call_id)
);
CREATE TABLE kernel.approvals (
    approval_id text PRIMARY KEY,
    copy_id text NOT NULL,
    decision_id text NOT NULL UNIQUE,
    answer text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE TABLE kernel.executions (
    action_id text PRIMARY KEY,
    copy_id text NOT NULL
);
CREATE TABLE kernel.facts (
    desk_id text NOT NULL,
    fact_id text NOT NULL,
    copy_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    claims jsonb NOT NULL,
    readers jsonb NOT NULL DEFAULT '["owner"]'::jsonb,
    expires_at timestamptz,
    PRIMARY KEY (desk_id, fact_id)
);
CREATE TABLE kernel.knowledge_items (
    desk_id text NOT NULL,
    item_id text NOT NULL,
    copy_id text NOT NULL,
    source text NOT NULL,
    title text NOT NULL,
    text text NOT NULL,
    readers jsonb NOT NULL DEFAULT '["owner"]'::jsonb,
    PRIMARY KEY (desk_id, item_id)
);
CREATE TABLE kernel.price_items (
    desk_id text NOT NULL,
    item_id text NOT NULL,
    copy_id text NOT NULL,
    title text NOT NULL,
    unit_cents bigint NOT NULL,
    PRIMARY KEY (desk_id, item_id)
);
CREATE TABLE kernel.quotes (
    quote_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    session_id text,
    items jsonb NOT NULL,
    list_cents bigint NOT NULL,
    discount_bp integer NOT NULL,
    amount_cents bigint NOT NULL,
    status text NOT NULL,
    expires_at timestamptz
);
CREATE TABLE kernel.calendar_slots (
    desk_id text NOT NULL,
    slot_id text NOT NULL,
    copy_id text NOT NULL,
    starts_at timestamptz NOT NULL,
    minutes integer NOT NULL,
    PRIMARY KEY (desk_id, slot_id)
);
CREATE TABLE kernel.bookings (
    booking_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    slot_id text NOT NULL,
    starts_at timestamptz NOT NULL,
    person_id text,
    lead_id text,
    status text NOT NULL
);
-- one confirmed booking per slot; slot ids repeat across Desks
CREATE UNIQUE INDEX bookings_one_confirmed_per_slot ON kernel.bookings (desk_id, slot_id) WHERE status = 'confirmed';
CREATE TABLE kernel.documents (
    document_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    title text NOT NULL,
    record_owner_person_id text,
    body text NOT NULL,
    canary text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel.document_links (
    link_id text PRIMARY KEY,
    copy_id text NOT NULL
);
CREATE TABLE kernel.payment_links (
    link_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    session_id text,
    quote_id text,
    amount_cents bigint NOT NULL,
    state text NOT NULL,
    expires_at timestamptz
);
CREATE TABLE kernel.handoffs (
    handoff_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text NOT NULL,
    session_id text,
    reason text,
    callback_window text,
    status text NOT NULL DEFAULT 'open'
);
CREATE TABLE kernel.notification_prefs (
    desk_id text PRIMARY KEY,
    copy_id text NOT NULL,
    now jsonb NOT NULL DEFAULT '[]'::jsonb,
    briefing jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE kernel.demo_inbox (
    entry_id text PRIMARY KEY,
    copy_id text NOT NULL
);
CREATE TABLE kernel.ledger_heads (
    desk_id text PRIMARY KEY,
    copy_id text NOT NULL,
    seq bigint NOT NULL,
    head text NOT NULL
);
CREATE TABLE kernel.ledger_entries (
    desk_id text NOT NULL,
    seq bigint NOT NULL,
    copy_id text NOT NULL,
    prev_hash text NOT NULL,
    created_at text NOT NULL,
    event jsonb NOT NULL,
    hash text NOT NULL,
    signature text NOT NULL,
    key_id text NOT NULL,
    envelope_jcs text NOT NULL,
    PRIMARY KEY (desk_id, seq)
);
"""

APP_TABLES_SQL = """
CREATE TABLE app.messages (
    n bigserial PRIMARY KEY,
    message_id text NOT NULL UNIQUE,
    copy_id text NOT NULL,
    desk_id text,
    session_id text,
    blocks jsonb,
    language text,
    owner_translation text,
    visibility text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.run_events (
    id bigserial PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text,
    session_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.setup_interviews (
    interview_id text PRIMARY KEY,
    copy_id text NOT NULL,
    desk_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.a2a_turns (
    agent_key_id text NOT NULL,
    session_id text NOT NULL,
    nonce text NOT NULL,
    copy_id text NOT NULL,
    desk_id text,
    status text NOT NULL DEFAULT 'running',
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_key_id, session_id, nonce)
);
CREATE TABLE app.model_calls (
    id bigserial PRIMARY KEY,
    copy_id text NOT NULL,
    session_id text,
    route text NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL,
    cached_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    latency_ms integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
"""

MOCKPAY_TABLES_SQL = """
CREATE TABLE mockpay.checkouts (
    copy_id text NOT NULL,
    checkout_id text NOT NULL,
    PRIMARY KEY (copy_id, checkout_id)
);
CREATE TABLE mockpay.charges (
    copy_id text NOT NULL,
    charge_id text NOT NULL,
    PRIMARY KEY (copy_id, charge_id)
);
CREATE TABLE mockpay.refunds (
    copy_id text NOT NULL,
    refund_id text NOT NULL,
    PRIMARY KEY (copy_id, refund_id)
);
CREATE TABLE mockpay.tool_definitions (
    copy_id text NOT NULL,
    name text NOT NULL,
    PRIMARY KEY (copy_id, name)
);
"""


# The API's only window on kernel data. Each view lists its columns explicitly (no `*`), so a
# column a later revision adds to a kernel table never appears here by accident; the list is
# frozen in this revision and checked against desk.db.tables.KERNEL_RO_COLUMNS by the tests.
KERNEL_RO_VIEWS_SQL = """
CREATE VIEW kernel_ro.businesses AS
    SELECT business_id, copy_id, name, owner_display_name, timezone, brand FROM kernel.businesses;
CREATE VIEW kernel_ro.desks AS
    SELECT desk_id, copy_id, business_id, name, slug, hours, answering, created_at FROM kernel.desks;
CREATE VIEW kernel_ro.sessions AS
    SELECT session_id, copy_id, desk_id, kind, verified, assurance, person_id, agent_key_id, mandate_id,
           last_language, mode, generation, strikes, created_at, closed_at
    FROM kernel.sessions;
CREATE VIEW kernel_ro.people AS
    SELECT person_id, copy_id, desk_id, display_name, masked_contact, notes, created_at FROM kernel.people;
CREATE VIEW kernel_ro.mandates AS
    SELECT mandate_id, copy_id, desk_id, agent_key_id, on_behalf_of, per_charge_cents, total_cents,
           committed_cents, reserved_cents, expires_at
    FROM kernel.mandates;
CREATE VIEW kernel_ro.documents AS
    SELECT document_id, copy_id, desk_id, title, record_owner_person_id, created_at FROM kernel.documents;
CREATE VIEW kernel_ro.leads AS
    SELECT lead_id, copy_id, desk_id, session_id, display_name, note, created_at FROM kernel.leads;
CREATE VIEW kernel_ro.tools AS
    SELECT copy_id, desk_id, tool, source, effects, reversible, status, description_confirmed,
           pending_definition_text, pending_sha256
    FROM kernel.tools;
CREATE VIEW kernel_ro.price_items AS
    SELECT item_id, copy_id, desk_id, title, unit_cents FROM kernel.price_items;
CREATE VIEW kernel_ro.calendar_slots AS
    SELECT slot_id, copy_id, desk_id, starts_at, minutes FROM kernel.calendar_slots;
CREATE VIEW kernel_ro.notification_prefs AS
    SELECT copy_id, desk_id, now, briefing FROM kernel.notification_prefs;
CREATE VIEW kernel_ro.decisions AS
    SELECT decision_id, copy_id, desk_id, session_id, tool, effects, outcome, state, answers, policy_version,
           card_ids, review, reason_plain, visitor_plain, expires_at, ledger_seq, created_at
    FROM kernel.decisions;
CREATE VIEW kernel_ro.approvals AS
    SELECT approval_id, copy_id, decision_id, answer, expires_at, consumed_at FROM kernel.approvals;
CREATE VIEW kernel_ro.actions AS
    SELECT action_id, copy_id, desk_id, session_id, generation, tool, effects, resource_kind, list_cents,
           discount_bp, amount_cents, recipient, starts_at, created_at
    FROM kernel.actions;
CREATE VIEW kernel_ro.policy_versions AS
    SELECT copy_id, desk_id, version, parent_version, cards, status, proof, cedar_sha256, schema_sha256,
           baseline_sha256, profiles_sha256, invariants_sha256, review_thresholds_version, created_at
    FROM kernel.policy_versions;
CREATE VIEW kernel_ro.facts AS
    SELECT fact_id, copy_id, desk_id, kind, status, claims, readers, expires_at FROM kernel.facts;
CREATE VIEW kernel_ro.knowledge_items AS
    SELECT item_id, copy_id, desk_id, source, title, text, readers FROM kernel.knowledge_items;
CREATE VIEW kernel_ro.quotes AS
    SELECT quote_id, copy_id, desk_id, session_id, items, list_cents, discount_bp, amount_cents, status, expires_at
    FROM kernel.quotes;
CREATE VIEW kernel_ro.bookings AS
    SELECT booking_id, copy_id, desk_id, slot_id, starts_at, person_id, lead_id, status FROM kernel.bookings;
CREATE VIEW kernel_ro.payment_links AS
    SELECT link_id, copy_id, desk_id, session_id, quote_id, amount_cents, state, expires_at FROM kernel.payment_links;
CREATE VIEW kernel_ro.handoffs AS
    SELECT handoff_id, copy_id, desk_id, session_id, reason, callback_window, status FROM kernel.handoffs;
CREATE VIEW kernel_ro.ledger_entries AS
    SELECT copy_id, desk_id, seq, prev_hash, created_at, event, hash, signature, key_id FROM kernel.ledger_entries;
"""


# Each role reaches only its own schemas. Default privileges cover tables later revisions add
# (desk_admin creates them), so a new kernel table is the kernel's and nobody else's without a
# grant in that revision. The kernel_ro views run with desk_admin's rights over kernel.*, and
# desk_api gets only SELECT on them, so it can't write through them either.
GRANTS_SQL = """
GRANT USAGE ON SCHEMA kernel TO desk_kernel;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kernel TO desk_kernel;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA kernel TO desk_kernel;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO desk_kernel;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT USAGE, SELECT ON SEQUENCES TO desk_kernel;
-- The ledger is append-only for the kernel: a kernel bug can't rewrite or erase history. Test
-- cleanup and anything else that must remove ledger rows runs as desk_admin. ledger_heads keeps
-- UPDATE, since appending moves the head.
REVOKE UPDATE, DELETE, TRUNCATE ON kernel.ledger_entries FROM desk_kernel;

GRANT USAGE ON SCHEMA kernel_ro TO desk_api;
GRANT SELECT ON ALL TABLES IN SCHEMA kernel_ro TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel_ro GRANT SELECT ON TABLES TO desk_api;

GRANT USAGE ON SCHEMA app TO desk_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO desk_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO desk_api;

GRANT USAGE ON SCHEMA procrastinate TO desk_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA procrastinate TO desk_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA procrastinate TO desk_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA procrastinate TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA procrastinate GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA procrastinate GRANT USAGE, SELECT ON SEQUENCES TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA procrastinate GRANT EXECUTE ON FUNCTIONS TO desk_api;

GRANT USAGE ON SCHEMA mockpay TO desk_mockpay;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mockpay TO desk_mockpay;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mockpay TO desk_mockpay;
ALTER DEFAULT PRIVILEGES IN SCHEMA mockpay GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO desk_mockpay;
ALTER DEFAULT PRIVILEGES IN SCHEMA mockpay GRANT USAGE, SELECT ON SEQUENCES TO desk_mockpay;
"""


def _script(sql: str) -> None:
    """Run a multi-statement SQL script as-is, inside the migration's transaction.

    It goes to psycopg with no parameters at all, so `%` is never parsed as a placeholder and
    several statements may share one call.
    """
    op.get_bind().connection.driver_connection.execute(sql)


def upgrade() -> None:
    _script(ROLES_SQL.read_text())
    for schema in SCHEMAS:
        _script(f"CREATE SCHEMA {schema}")
    _script(KERNEL_TABLES_SQL)
    _script(APP_TABLES_SQL)
    _script(MOCKPAY_TABLES_SQL)
    _create_procrastinate_schema()
    _script(KERNEL_RO_VIEWS_SQL)
    _script(GRANTS_SQL)


def _create_procrastinate_schema() -> None:
    """Procrastinate's own schema script, with its objects created in schema procrastinate."""
    bind = op.get_bind()
    search_path = bind.exec_driver_sql("SHOW search_path").scalar_one()
    _script("SET LOCAL search_path TO procrastinate")
    _script(PROCRASTINATE_SQL.read_text())
    _script(f"SET LOCAL search_path TO {search_path}")   # later revisions in this transaction see the usual path


def downgrade() -> None:
    _script("DROP SCHEMA IF EXISTS " + ", ".join(reversed(SCHEMAS)) + " CASCADE")
