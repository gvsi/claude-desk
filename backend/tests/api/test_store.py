"""The transcript store: the app tables, append-only model input, wrappers and copy-scoped kernel reads."""

import psycopg
import pytest
from sqlalchemy import text

from desk.api.ro import KernelRO
from tests.api.conftest import new_visitor

APP_COLUMNS = {
    "messages": {"n", "message_id", "copy_id", "desk_id", "session_id", "kind", "author", "text", "blocks", "language",
                 "owner_translation", "visibility", "wake", "model_context", "model_seq", "model_content", "ref_id",
                 "call_id", "event_seq", "created_at"},
    "run_events": {"id", "copy_id", "desk_id", "session_id", "kind", "seq", "type", "payload", "handled_at",
                   "created_at"},
    "setup_interviews": {"interview_id", "copy_id", "desk_id", "business_type", "step", "consent", "answers",
                         "transcript", "draft_cards", "draft_version", "created_at", "updated_at"},
    "a2a_turns": {"agent_key_id", "session_id", "nonce", "copy_id", "desk_id", "status", "http_status", "response",
                  "through_seq", "created_at", "updated_at"},
    "model_calls": {"model_call_id", "copy_id", "session_id", "route", "model", "input_tokens", "cached_tokens",
                    "cache_write_tokens", "output_tokens", "latency_ms", "stop_reason", "created_at"},
}


def columns(conn: psycopg.Connection, table: str) -> set[str]:
    rows = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'app'"
                        " AND table_name = %s", (table,)).fetchall()
    return {name for (name,) in rows}


def index_definitions(conn: psycopg.Connection, table: str) -> list[str]:
    rows = conn.execute("SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename = %s", (table,))
    return [definition for (definition,) in rows.fetchall()]


def unique_index(conn: psycopg.Connection, table: str, *fragments: str) -> bool:
    return any(definition.startswith("CREATE UNIQUE INDEX") and all(fragment in definition for fragment in fragments)
               for definition in index_definitions(conn, table))


def test_migration_sets_app_columns(db):
    for table, expected in APP_COLUMNS.items():
        assert columns(db, table) == expected, table
    assert unique_index(db, "messages", "(session_id, model_seq)")
    assert unique_index(db, "run_events", "(session_id, seq)")
    assert unique_index(db, "a2a_turns", "(agent_key_id, nonce)")
    # a status is published once per decision and ledger entry; a due decision waits in one control row
    assert unique_index(db, "run_events", "(payload ->> 'decision_id'::text)", "(payload ->> 'ledger_seq'::text)",
                        "'receipt'::text", "'held'::text", "'resolved'::text")
    assert unique_index(db, "run_events", "(payload ->> 'decision_id'::text)", "'decision_due'::text",
                        "handled_at IS NULL")
    # the columns admit only the plan's values
    for statement in (
        "INSERT INTO app.messages (message_id, copy_id, session_id, kind, author, visibility)"
        " VALUES ('m-1', 'c-1', 's-1', 'shout', 'visitor', 'public')",
        "INSERT INTO app.messages (message_id, copy_id, session_id, kind, author, visibility)"
        " VALUES ('m-1', 'c-1', 's-1', 'visitor_text', 'stranger', 'public')",
        "INSERT INTO app.run_events (copy_id, session_id, kind, type, payload) VALUES ('c-1', 's-1', 'sse', 'writing', '{}')",
        "INSERT INTO app.run_events (copy_id, session_id, kind, seq, type, payload)"
        " VALUES ('c-1', 's-1', 'control', 1, 'run_resumable', '{}')",
        "INSERT INTO app.model_calls (copy_id, route, model, input_tokens, cached_tokens, cache_write_tokens,"
        " output_tokens, latency_ms, stop_reason, created_at)"
        " VALUES ('c-1', 'chat', 'claude-opus-5-5', 1, 0, 0, 1, 1, 'end_turn', now())",
    ):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction(force_rollback=True):
            db.execute(statement)


async def test_ro_reads_are_copy_scoped(api_conn, kernel_http, fake, visitor, ro_schema):
    other = await new_visitor(kernel_http, fake)
    ro = KernelRO(api_conn, visitor.ids.copy_id, ro_schema)

    assert [desk["desk_id"] for desk in await ro.desks()] == [visitor.ids.desk_id]
    session = await ro.session(visitor.ids.session_id)
    assert (session["session_id"], session["generation"], session["mode"]) == (visitor.ids.session_id, 0, "ai")
    # another copy's rows are out of reach, by key or by listing
    assert await ro.session(other.ids.session_id) is None
    assert await ro.one("desks", desk_id=other.ids.desk_id) is None
    assert {row["copy_id"] for row in await ro.rows("decisions")} == {visitor.ids.copy_id}
    assert {row["copy_id"] for row in await KernelRO(api_conn, other.ids.copy_id, ro_schema).rows("decisions")} == {
        other.ids.copy_id}
    # several values for a column read as IN; only the master's views and their columns can be named
    items = await ro.rows("price_items", item_id=["drain", "leak"], desk_id=visitor.ids.desk_id)
    assert sorted(row["title"] for row in items) == ["Drain clearing", "Leak repair"]
    with pytest.raises(ValueError):
        await ro.rows("verification_challenges")
    with pytest.raises(ValueError):
        await ro.rows("sessions", secret_hash="x")
    with pytest.raises(ValueError):
        KernelRO(api_conn, visitor.ids.copy_id, "kernel; DROP SCHEMA app")
    with pytest.raises(ValueError):
        KernelRO(api_conn, "", ro_schema)
    # the copy is the transaction's, set for each read: a read with no copy set finds nothing
    await api_conn.rollback()
    assert (await api_conn.execute(text(f"SELECT count(*) FROM {ro_schema}.sessions"))).scalar_one() == 0
