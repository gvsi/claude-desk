"""Start-setup's idempotency key: four nullable `app.setup_interviews` columns and a partial unique index.

`POST /api/owner/setup` takes an optional client `idempotency_key`. With one, the API writes the interview's row before
it calls the model or the kernel, holding the key and the sha256 of the request's canonical body, and a unique index on
`(copy_id, idempotency_key)` lets one row in a copy hold a key: a repeat finds the row and answers that interview, so a
lost answer or a retry never makes a second Desk. Before the kernel is asked for the Desk, the start records when, in
`desk_requested_at`, committed: from then on the Desk may exist, so the row is never taken over as abandoned. A start
that fails keeps its answer in `start_error` (the status, error and code it answered with), which a repeat answers
again. Rows without a key, every row before this, leave all four null, and the index skips them.

`api_tables` is applied to the hosted database as Plan 02a left it, so it is never edited; this adds to it instead.

Revision ID: api_idempotency
Revises: api_replay
"""

from alembic import op

revision = "api_idempotency"
down_revision = "api_replay"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE app.setup_interviews
            ADD COLUMN idempotency_key text,
            ADD COLUMN request_sha256 text,
            ADD COLUMN start_error jsonb,
            ADD COLUMN desk_requested_at timestamptz,
            ADD CONSTRAINT setup_interviews_keyed CHECK ((idempotency_key IS NULL) = (request_sha256 IS NULL)),
            ADD CONSTRAINT setup_interviews_error_keyed CHECK (start_error IS NULL OR idempotency_key IS NOT NULL),
            ADD CONSTRAINT setup_interviews_requested_keyed
                CHECK (desk_requested_at IS NULL OR idempotency_key IS NOT NULL);
        CREATE UNIQUE INDEX setup_interviews_idempotency ON app.setup_interviews (copy_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX app.setup_interviews_idempotency;
        ALTER TABLE app.setup_interviews
            DROP CONSTRAINT setup_interviews_requested_keyed,
            DROP CONSTRAINT setup_interviews_error_keyed,
            DROP CONSTRAINT setup_interviews_keyed,
            DROP COLUMN desk_requested_at,
            DROP COLUMN start_error,
            DROP COLUMN request_sha256,
            DROP COLUMN idempotency_key;
    """)
