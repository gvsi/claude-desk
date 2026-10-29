"""The API's tables, completed: transcripts, run events, setup interviews, agent turns and model calls.

0001_core created each `app.*` table with its key and `copy_id`; this adds the columns the API writes
(Plan 02a, "App tables"). No column holds a secret: tokens, keys, codes and Demo inbox bodies never
reach `app.*`.

- `messages` is the append-only transcript. `n` is the cursor; a row the model sees carries a frozen
  `model_content` and, once sent, its `model_context` and a `model_seq` unique per session. An assistant
  row records the session `generation` its tool calls were made at, which the kernel finds them by.
- `run_events` holds each session's SSE events (`seq`, gapless per session), control rows the API
  handles once (`handled_at`) and metric rows. A signed status is published once per decision and
  ledger entry, and a due decision waits in at most one unhandled control row.
- `a2a_turns` stores each agent turn's answer; the kernel binds a nonce to one session per key, so
  `(agent_key_id, nonce)` is unique too.
- `model_calls` gains the master plan's remaining usage columns.

Columns the API always writes are NOT NULL with no default: no API code wrote these tables before,
and a table that somehow holds rows fails the migration instead of getting invented values.

Revision ID: api_tables
Revises: 0007_model_call_finish
"""

from alembic import op

revision = "api_tables"
down_revision = "0007_model_call_finish"
branch_labels = None
depends_on = None

MESSAGE_KINDS = ("visitor_text", "agent_text", "delivered", "status", "owner_say", "whisper", "action_update",
                 "desk_context", "note", "context_start", "tool_change", "model_assistant", "model_tool_results",
                 "triage")
AUTHORS = ("visitor", "agent", "claude", "owner", "desk", "api")
VISIBILITIES = ("public", "owner", "model")
SSE_TYPES = ("writing", "message", "turn_end", "receipt", "held", "resolved", "owner_joined", "owner_left",
             "demo_inbox", "error")
CONTROL_TYPES = ("run_resumable", "decision_due", "decision_pending")
METRIC_TYPES = ("reveal", "turn")
SETUP_STEPS = ("questions", "tools", "rules", "situations", "safety_check", "preview", "live")
MODEL_ROUTES = ("conversation", "setup", "card_draft", "situations", "rules_chat", "visiting_agent", "triage",
                "translation")


def _in(values: tuple[str, ...]) -> str:
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    op.execute(f"""
        ALTER TABLE app.messages
            ADD COLUMN IF NOT EXISTS kind text NOT NULL,
            ADD COLUMN IF NOT EXISTS author text NOT NULL,
            ADD COLUMN IF NOT EXISTS text text,
            ADD COLUMN IF NOT EXISTS wake boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS model_context integer,
            ADD COLUMN IF NOT EXISTS model_seq integer,
            ADD COLUMN IF NOT EXISTS model_content jsonb,
            ADD COLUMN IF NOT EXISTS ref_id text,
            ADD COLUMN IF NOT EXISTS call_id text,
            ADD COLUMN IF NOT EXISTS event_seq bigint,
            ADD COLUMN IF NOT EXISTS generation integer,
            ALTER COLUMN visibility SET NOT NULL,
            ADD CONSTRAINT messages_kind CHECK (kind IN {_in(MESSAGE_KINDS)}),
            ADD CONSTRAINT messages_author CHECK (author IN {_in(AUTHORS)}),
            ADD CONSTRAINT messages_visibility CHECK (visibility IN {_in(VISIBILITIES)}),
            ADD CONSTRAINT messages_model_place CHECK ((model_seq IS NULL) = (model_context IS NULL)),
            ADD CONSTRAINT messages_generation CHECK ((generation IS NOT NULL) = (kind = 'model_assistant'));
        CREATE UNIQUE INDEX messages_model_seq ON app.messages (session_id, model_seq);
        CREATE INDEX messages_session ON app.messages (session_id, n);
        CREATE INDEX messages_pending ON app.messages (session_id, n) WHERE model_seq IS NULL;
    """)
    op.execute(f"""
        ALTER TABLE app.run_events
            ADD COLUMN IF NOT EXISTS kind text NOT NULL,
            ADD COLUMN IF NOT EXISTS seq bigint,
            ADD COLUMN IF NOT EXISTS type text NOT NULL,
            ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL,
            ADD COLUMN IF NOT EXISTS handled_at timestamptz,
            ADD CONSTRAINT run_events_kind CHECK (
                (kind = 'sse' AND type IN {_in(SSE_TYPES)})
                OR (kind = 'control' AND type IN {_in(CONTROL_TYPES)})
                OR (kind = 'metric' AND type IN {_in(METRIC_TYPES)})),
            ADD CONSTRAINT run_events_seq_only_sse CHECK ((kind = 'sse') = (seq IS NOT NULL)),
            ADD CONSTRAINT run_events_handled_only_control CHECK (handled_at IS NULL OR kind = 'control');
        CREATE UNIQUE INDEX run_events_seq ON app.run_events (session_id, seq);
        CREATE UNIQUE INDEX run_events_status_once ON app.run_events
            (session_id, (payload ->> 'decision_id'), (payload ->> 'ledger_seq'))
            WHERE kind = 'sse' AND type IN ('receipt', 'held', 'resolved');
        CREATE UNIQUE INDEX run_events_due_once ON app.run_events (session_id, (payload ->> 'decision_id'))
            WHERE kind = 'control' AND type = 'decision_due' AND handled_at IS NULL;
        CREATE INDEX run_events_unhandled ON app.run_events (session_id, id)
            WHERE kind = 'control' AND handled_at IS NULL;
    """)
    op.execute(f"""
        ALTER TABLE app.setup_interviews
            ADD COLUMN IF NOT EXISTS business_type text,
            ADD COLUMN IF NOT EXISTS step text NOT NULL DEFAULT 'questions',
            ADD COLUMN IF NOT EXISTS consent boolean,
            ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{{}}'::jsonb,
            ADD COLUMN IF NOT EXISTS transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS draft_cards jsonb NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS draft_version integer,
            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
            ADD CONSTRAINT setup_interviews_step CHECK (step IN {_in(SETUP_STEPS)});
    """)
    op.execute("""
        ALTER TABLE app.a2a_turns
            ADD COLUMN IF NOT EXISTS http_status integer,
            ADD COLUMN IF NOT EXISTS through_seq bigint,
            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
            ADD CONSTRAINT a2a_turns_status CHECK (status IN ('running', 'done')),
            ADD CONSTRAINT a2a_turns_nonce UNIQUE (agent_key_id, nonce);
    """)
    op.execute(f"""
        ALTER TABLE app.model_calls
            ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL,
            ADD COLUMN IF NOT EXISTS stop_reason text NOT NULL,
            ADD CONSTRAINT model_calls_route CHECK (route IN {_in(MODEL_ROUTES)});
        CREATE INDEX model_calls_created_at ON app.model_calls (created_at);
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX app.model_calls_created_at;
        ALTER TABLE app.model_calls
            DROP CONSTRAINT model_calls_route,
            DROP COLUMN stop_reason,
            DROP COLUMN cache_write_tokens;
        ALTER TABLE app.a2a_turns
            DROP CONSTRAINT a2a_turns_nonce,
            DROP CONSTRAINT a2a_turns_status,
            DROP COLUMN updated_at,
            DROP COLUMN through_seq,
            DROP COLUMN http_status;
        ALTER TABLE app.setup_interviews
            DROP CONSTRAINT setup_interviews_step,
            DROP COLUMN updated_at,
            DROP COLUMN draft_version,
            DROP COLUMN draft_cards,
            DROP COLUMN transcript,
            DROP COLUMN answers,
            DROP COLUMN consent,
            DROP COLUMN step,
            DROP COLUMN business_type;
        DROP INDEX app.run_events_unhandled;
        DROP INDEX app.run_events_due_once;
        DROP INDEX app.run_events_status_once;
        DROP INDEX app.run_events_seq;
        ALTER TABLE app.run_events
            DROP CONSTRAINT run_events_handled_only_control,
            DROP CONSTRAINT run_events_seq_only_sse,
            DROP CONSTRAINT run_events_kind,
            DROP COLUMN handled_at,
            DROP COLUMN payload,
            DROP COLUMN type,
            DROP COLUMN seq,
            DROP COLUMN kind;
        DROP INDEX app.messages_pending;
        DROP INDEX app.messages_session;
        DROP INDEX app.messages_model_seq;
        ALTER TABLE app.messages
            DROP CONSTRAINT messages_generation,
            DROP CONSTRAINT messages_model_place,
            DROP CONSTRAINT messages_visibility,
            DROP CONSTRAINT messages_author,
            DROP CONSTRAINT messages_kind,
            ALTER COLUMN visibility DROP NOT NULL,
            DROP COLUMN generation,
            DROP COLUMN event_seq,
            DROP COLUMN call_id,
            DROP COLUMN ref_id,
            DROP COLUMN model_content,
            DROP COLUMN model_seq,
            DROP COLUMN model_context,
            DROP COLUMN wake,
            DROP COLUMN text,
            DROP COLUMN author,
            DROP COLUMN kind;
    """)
