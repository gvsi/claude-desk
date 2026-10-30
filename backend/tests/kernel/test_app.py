"""The kernel app: health, startup refusals, loopback binding, columns and error answers."""

import json
import re

import desk_kernel
import psycopg
import pytest

from sqlalchemy import select

from desk.contracts import LedgerEvent
from desk.db.models import Desk, PriceItem
from desk.db.session import database_url, dispose_engines, libpq_url
from desk.kernel_api import LedgerAppendRequest
from desk.kernel_service import compiler, ledger
from desk.kernel_service.app import KernelSettings, create_app, serve_config
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure

from .helpers import ledger_rows, make_copy_rows, rows_of


async def test_health_reports_proof_mode_and_key(app, client):
    response = await client.get("/health")
    assert response.status_code == 200
    health = response.json()
    signer = app.state.kernel.signer
    assert health["dev_signing_key"] is True                     # no DESK_SIGNING_SEED in a development env
    assert re.fullmatch(r"[0-9a-f]{64}", health["public_key_hex"])
    assert health["public_key_hex"] == signer.public_key_hex()
    assert health["key_id"] == signer.key_id()
    assert health["proof_mode"] == "bounded"                     # until the startup selftest passes
    assert health["unproved_seeds"] == []
    assert health["version"] == desk_kernel.version()


async def test_startup_loads_the_baseline_engine(app, monkeypatch):
    engine = app.state.engine
    assert isinstance(engine, desk_kernel.PolicyEngine)
    permit_all = {"F": "", "H": "",
                  "A": '@id("all") @card("test") @tier("auto") @applies_to("native.find_slots")\n'
                       'permit (principal, action, resource);'}
    assert engine.load("desk-test:1", json.dumps(compiler.BASE_SCHEMA), json.dumps(permit_all)) == []
    visitor = {"uid": {"type": "Visitor", "id": "s-1"}, "attrs": {"verified": False, "assurance": "none",
                                                                  "copy": "copy-1"}, "parents": []}
    desk = {"uid": {"type": "Desk", "id": "d-1"}, "attrs": {"copy": "copy-2"}, "parents": []}
    other_copy = {"principal": visitor["uid"], "action": "native.find_slots", "resource": desk["uid"],
                  "context": {"record_owner_match": False, "local_dow": 4, "local_minute": 600},
                  "entities": [visitor, desk]}
    verdict = json.loads(engine.decide("desk-test:1", json.dumps(other_copy), "final"))
    assert verdict["outcome"] == "refuse" and verdict["policy_ids"] == ["B.same_copy"]   # the real baseline

    # a baseline the engine can't take stops the kernel from starting
    monkeypatch.setattr(compiler, "BASELINE", '@id("open") permit (principal, action, resource);')
    kernel = create_app(clock=app.state.kernel.clock)
    with pytest.raises(ValueError, match="only forbids"):
        async with kernel.router.lifespan_context(kernel):
            pass


async def test_production_without_seed_refuses_to_start(monkeypatch):
    url = database_url("KERNEL")
    monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
    for hook in ("DESK_DECISIONS", "ANTHROPIC_BASE_URL", "DESK_PROVE"):   # test hooks a shell may export
        monkeypatch.delenv(hook, raising=False)
    monkeypatch.setenv("KERNEL_DATABASE_URL", url)   # outside development there is no .env fallback
    monkeypatch.setenv("ANTHROPIC_API_KEY", "key-for-tests")   # production needs the model key too
    monkeypatch.setenv("DESK_ENV", "production")
    kernel = create_app()
    assert kernel.state.proof_mode == "bounded"
    with pytest.raises(ValueError, match="DESK_SIGNING_SEED"):
        async with kernel.router.lifespan_context(kernel):
            pass
    # settings that name production refuse the dev key too, whatever the process environment says
    monkeypatch.delenv("DESK_ENV")
    kernel = create_app(KernelSettings(database_url=url, env="production"))
    with pytest.raises(RuntimeError, match="DESK_SIGNING_SEED"):
        async with kernel.router.lifespan_context(kernel):
            pass
    # with a seed, production starts and signs with it
    monkeypatch.setenv("DESK_ENV", "production")
    monkeypatch.setenv("DESK_SIGNING_SEED", "11" * 32)
    kernel = create_app()
    try:
        async with kernel.router.lifespan_context(kernel):
            assert kernel.state.kernel.signer.dev_key is False
    finally:
        await dispose_engines()


def test_kernel_listens_on_loopback_only(monkeypatch):
    monkeypatch.setenv("KERNEL_HOST", "0.0.0.0")
    monkeypatch.setenv("KERNEL_PORT", "80")
    config = serve_config()
    assert (config.host, config.port) == ("127.0.0.1", 8701)
    assert config.lifespan == "on"          # a lifespan that refuses to start stops the process
    assert config.app == "desk.kernel_service.app:create_app" and config.factory
    assert config.access_log is False       # raw paths can hold single-use link tokens; failures log route templates


# Plan 01a's "Kernel columns this plan relies on", beyond the columns the kernel_ro views list.
KERNEL_COLUMNS = {
    "copies": {"copy_id", "created_at"},
    "desks": {"deleted_at"},
    "people": {"ref", "contact", "contact_norm"},
    "sessions": {"secret_hash", "last_seen_at"},
    "tools": {"profile", "profile_sha256"},
    "policy_versions": {"cards_sha256", "draft_key_sha256", "cedar", "schema_json", "invariants_sha256",
                        "review_thresholds_version", "preset"},
    "actions": {"args_json", "args_sha256", "profile_sha256", "resource"},
    "decisions": {"generation", "call_id", "call_sha256", "action_id", "policy_ids", "signature", "updated_at"},
    "approvals": {"nonce", "binding_sha256", "policy_version", "created_at"},
    "executions": {"action_id", "copy_id", "decision_id", "state", "result", "started_at", "finished_at"},
    "facts": {"session_id", "action_id", "source", "record_owner", "created_at"},
    "calendar_slots": {"desk_id", "slot_id"},
    "quotes": {"action_id", "created_at"},
    "bookings": {"action_id", "session_id"},
    "documents": {"ref", "body", "canary"},
    "demo_inbox": {"entry_id", "copy_id", "desk_id", "to", "person_id", "kind", "body", "preview", "created_at"},
    "ledger_heads": {"desk_id", "copy_id", "seq", "head"},
    "ledger_entries": {"envelope_jcs"},
}
JSONB_COLUMNS = {("tools", "profile"), ("policy_versions", "cedar"), ("actions", "args_json"),
                 ("actions", "resource"), ("executions", "result")}
# (table, columns, unique): the keys and indexes the same table names, by their columns
KERNEL_KEYS = {
    ("people", ("desk_id", "ref"), True), ("people", ("desk_id", "contact_norm"), False),
    ("sessions", ("secret_hash",), True),
    ("policy_versions", ("desk_id", "version"), True), ("policy_versions", ("desk_id", "draft_key_sha256"), True),
    ("decisions", ("session_id", "generation", "call_id"), True),
    ("approvals", ("decision_id",), True),
    ("executions", ("action_id",), True),
    ("facts", ("desk_id", "fact_id"), True), ("facts", ("action_id",), False),
    ("calendar_slots", ("desk_id", "slot_id"), True),
    ("quotes", ("action_id",), True), ("bookings", ("action_id",), True),
    ("ledger_heads", ("desk_id",), True), ("ledger_entries", ("desk_id", "seq"), True),
}
PARTIAL_KEYS = {   # unique only among the rows the predicate admits
    ("policy_versions", ("desk_id",), "(status = 'active'::text)"),
    ("bookings", ("desk_id", "slot_id"), "(status = 'confirmed'::text)"),
}


def test_kernel_columns_exist():
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        types = {(table, column): data_type for table, column, data_type in admin.execute(
            "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'kernel'")}
        indexes = admin.execute(
            "SELECT t.relname, i.indisunique, pg_get_expr(i.indpred, i.indrelid),"
            " array(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)"
            "       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.n)"
            " FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid"
            " WHERE t.relnamespace = 'kernel'::regnamespace").fetchall()
    for table, expected in KERNEL_COLUMNS.items():
        assert expected <= {column for t, column in types if t == table}, (table, expected)
    for table, column in JSONB_COLUMNS:
        assert types[(table, column)] == "jsonb", (table, column)
    keys = {(table, tuple(cols), unique) for table, unique, predicate, cols in indexes if predicate is None}
    partial = {(table, tuple(cols), predicate) for table, unique, predicate, cols in indexes if unique and predicate}
    assert KERNEL_KEYS <= keys
    assert PARTIAL_KEYS <= partial


async def test_errors_use_kernel_error_codes(app, client):
    rows = await make_copy_rows(app)

    @app.post("/test/echo")
    async def echo(body: LedgerAppendRequest) -> dict:
        return {"desk_id": body.desk_id}

    @app.post("/test/raises")
    async def raises(ctx: Ctx) -> dict:
        ctx.bind(rows.copy_id)
        ctx.db.add(PriceItem(desk_id=rows.desk_id, item_id="drain", copy_id=rows.copy_id, title="Drain clearing",
                             unit_cents=18_000))
        await ctx.db.flush()
        raise RuntimeError("a bug after the insert")

    for malformed in ({"content": b"{not json", "headers": {"content-type": "application/json"}},
                      {"json": {"desk_id": rows.desk_id}},                       # no event
                      {"json": {"desk_id": rows.desk_id, "event": {"kind": "decide", "origin": "api", "summary": {}},
                                "principal": "owner"}}):                       # an unknown field is refused
        response = await client.post("/test/echo", **malformed)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), malformed
    response = await client.post("/test/raises")
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert await rows_of(app, rows.copy_id, select(PriceItem)) == []           # the insert rolled back

    @app.post("/test/commit_fails")
    async def commit_fails(ctx: Ctx) -> dict:
        ctx.bind(rows.copy_id)
        ctx.db.add(Desk(desk_id=rows.desk_id, copy_id=rows.copy_id, business_id=rows.business_id, name="Again",
                        slug="again"))                                         # unflushed: the commit meets the duplicate
        return {"ok": True}

    response = await client.post("/test/commit_fails")
    assert (response.status_code, response.json()) == (500, {"code": "internal"})   # the commit precedes the answer
    # the framework's own answers carry a KernelError too
    response = await client.get("/no/such/route")
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    response = await client.delete("/health")
    assert (response.status_code, response.json()) == (405, {"code": "invalid"})


async def test_error_answers_commit_their_ledger_entry(app, client):
    rows = await make_copy_rows(app)
    contexts = []

    async def record_conflict(ctx: KernelCtx) -> None:
        contexts.append(ctx)
        await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id,
                            event=LedgerEvent(kind="auth", origin="kernel",
                                              summary={"route": "POST /test/conflict", "reason": "conflict"}))

    async def unrecordable(ctx: KernelCtx) -> None:
        await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id,
                            event=LedgerEvent(kind="auth", origin="kernel", summary={"token": "leaked"}))

    @app.post("/test/conflict")
    async def conflict(ctx: Ctx, unrecorded: bool = False) -> dict:
        contexts.append(ctx)
        ctx.bind(rows.copy_id)
        ctx.db.add(PriceItem(desk_id=rows.desk_id, item_id="drain", copy_id=rows.copy_id, title="Drain clearing",
                             unit_cents=18_000))
        await ctx.db.flush()
        raise KernelFailure(409, "conflict", persist=unrecordable if unrecorded else record_conflict)

    response = await client.post("/test/conflict")
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert await rows_of(app, rows.copy_id, select(PriceItem)) == []           # the request's own write rolled back
    [entry] = await ledger_rows(app, rows)                                      # the persisted entry committed
    assert (entry.seq, entry.event.kind, entry.event.summary["reason"]) == (1, "auth", "conflict")
    request_ctx, persist_ctx = contexts
    assert persist_ctx.db is not request_ctx.db                                 # in a fresh transaction
    # a refusal whose record can't be written is not answered as a plain refusal
    response = await client.post("/test/conflict", params={"unrecorded": True})
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert len(await ledger_rows(app, rows)) == 1
    with pytest.raises(ValueError):
        KernelFailure(409, "busy")                                              # only KernelError codes
