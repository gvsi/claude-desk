"""app.model_calls is keyed by model_call_id and records each call's finish.

The master plan's "Data model" names the key `model_call_id`, and defines `created_at` as the
call's finish, which the API writes from the model response right after the call. The default of
now() would record when the row was inserted instead, so it is dropped: a writer that leaves
`created_at` out is refused rather than stamped with another time. Plan 02a's migration adds the
remaining usage columns.

Revision ID: 0007_model_call_finish
Revises: 0006_preview_and_pins
"""

from alembic import op

revision = "0007_model_call_finish"
down_revision = "0006_preview_and_pins"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE app.model_calls RENAME COLUMN id TO model_call_id")
    op.execute("ALTER SEQUENCE app.model_calls_id_seq RENAME TO model_calls_model_call_id_seq")
    op.execute("ALTER TABLE app.model_calls ALTER COLUMN created_at DROP DEFAULT")


def downgrade() -> None:
    op.execute("ALTER TABLE app.model_calls ALTER COLUMN created_at SET DEFAULT now()")
    op.execute("ALTER SEQUENCE app.model_calls_model_call_id_seq RENAME TO model_calls_id_seq")
    op.execute("ALTER TABLE app.model_calls RENAME COLUMN model_call_id TO id")
