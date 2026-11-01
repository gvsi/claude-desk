"""The kernel app: health, startup refusals, loopback binding, columns and error answers."""

import ast
import json
import logging
import logging.config
import re
import sys
from copy import deepcopy
from pathlib import Path

import desk_kernel
import psycopg
import pytest
from fastapi.routing import APIRoute, RouteContext, iter_route_contexts
from sqlalchemy import select
from uvicorn.config import LOGGING_CONFIG

from desk import kernel_service
from desk.contracts import LedgerEvent
from desk.db.models import Desk, PriceItem
from desk.db.session import database_url, dispose_engines, libpq_url
from desk.kernel_api import KERNEL_ROUTES, LedgerAppendRequest
from desk.kernel_service import activation, compiler, ledger
from desk.kernel_service.app import KernelSettings, create_app, serve_config
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure

from .helpers import context, ledger_rows, make_copy_rows, rows_of


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
                  "context": context(record_owner_match=False, local_dow=4, local_minute=600),
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


@pytest.fixture
def restore_kernel_loggers():
    # Config also replaces uvicorn's handlers; none may retain a closed capture stream.
    saved = {name: (logger.handlers[:], logger.level, logger.propagate, logger.disabled)
             for name in (*LOGGING_CONFIG["loggers"], "desk")
             for logger in [logging.getLogger(name)]}
    try:
        yield
    finally:
        for name, (handlers, level, propagate, disabled) in saved.items():
            logger = logging.getLogger(name)
            for handler in logger.handlers:
                if handler not in handlers:
                    handler.close()
            logger.handlers = handlers
            logger.setLevel(level)
            logger.propagate, logger.disabled = propagate, disabled


def test_kernel_listens_on_loopback_only(monkeypatch, restore_kernel_loggers):
    monkeypatch.setenv("KERNEL_HOST", "0.0.0.0")
    monkeypatch.setenv("KERNEL_PORT", "80")
    config = serve_config()
    assert (config.host, config.port) == ("127.0.0.1", 8701)
    assert config.lifespan == "on"          # a lifespan that refuses to start stops the process
    assert config.app == "desk.kernel_service.app:create_app" and config.factory
    assert config.access_log is False       # raw paths can hold single-use link tokens; failures log route templates


def test_kernel_info_logs_go_to_stdout(capsys, restore_kernel_loggers):
    original = deepcopy(LOGGING_CONFIG)
    config = serve_config().log_config
    assert config["loggers"]["desk"] == {"handlers": ["desk"], "level": "INFO", "propagate": True}
    assert config["handlers"]["desk"] == {
        "class": "logging.StreamHandler", "formatter": "desk", "stream": "ext://sys.stdout"}
    assert config["formatters"]["desk"] == {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}
    assert config["disable_existing_loggers"] is False
    assert {name: value for name, value in config["loggers"].items() if name.startswith("uvicorn")} \
        == original["loggers"]
    assert LOGGING_CONFIG == original          # changes to our config never change uvicorn's defaults
    logging.config.dictConfig(config)
    logging.getLogger("desk.kernel_service.activation").info("proof_mode mode=cached")
    stdout, stderr = capsys.readouterr()
    assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} INFO "
                        r"desk\.kernel_service\.activation proof_mode mode=cached\n", stdout)
    assert stderr == ""


# Plan 01a's "Kernel columns this plan relies on", beyond the columns the kernel_ro views list, but for
# quotes.created_at and decisions.policy_ids, which kernel_ro.quotes and kernel_ro.decisions have shown since
# 0011_quote_created_at and kernel_ro_decision_policy_ids, and stay pinned here.
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
    "demo_inbox": {"entry_id", "copy_id", "desk_id", "to", "person_id", "kind", "body", "preview", "created_at",
                   "decision_id"},
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


NOTE = "Call me back at mike@riverapl.example"     # what a request carried, which no log may carry


async def test_prover_stderr_logs_only_its_size(caplog):
    # Prover diagnostics can quote policy/card text, paths, or any data from malformed inputs.
    stderr = "owner-card-caf\u00e9 visitor-note session-secret link-token 123456\nforged_event".encode()
    script = f"import sys; sys.stderr.buffer.write({stderr!r}); sys.stdout.buffer.write(b'report')"
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        result = await activation._run([sys.executable, "-c", script], kill_after=5)
    assert result == (0, b"report")
    assert [record.getMessage() for record in caplog.records] == [f"prover_stderr bytes={len(stderr)}"]


@pytest.mark.parametrize(("code", "timed_out"), [(0, False), (2, False), (2, True), (None, True)])
async def test_selftest_failure_logs_checks_and_timeout(monkeypatch, caplog, code, timed_out):
    canary = "selftest-diagnostic-never-log-this"
    payload = json.dumps({
        "ok": False, "method": "symcc", "timed_out": timed_out,
        "checks": [{"name": name, "ok": ok, "counterexample_plain": canary}
                   for name, ok in [("selftest.gated_implies_ungated", True),
                                    ("selftest.or_gate_counterexample", False)]]}).encode()
    run = activation._run

    async def selftest(argv, *, kill_after):
        assert argv[-1] == "--selftest"
        if code is None:                    # the process-level backstop killed the prover
            return None, b""
        script = (f"import sys; sys.stdout.buffer.write({payload!r}); "
                  f"sys.stderr.write({canary!r}); sys.exit({code})")
        return await run([sys.executable, "-c", script], kill_after=kill_after)

    monkeypatch.setattr(activation, "_run", selftest)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        assert await activation.run_selftest() == "bounded"
    checks = "unavailable" if code is None else "selftest.or_gate_counterexample"
    messages = [record.getMessage() for record in caplog.records]
    assert f"proof_selftest_failed exit={code} checks={checks} timed_out={timed_out}" in messages
    assert all(canary not in message for message in messages)
    assert messages[-1] == "proof_mode mode=bounded"


async def test_error_logs_carry_no_request_text(app, client, caplog):
    """An error that isn't a refusal can quote what the request carried (a visitor's arguments, a
    statement's parameters). The kernel logs its kind and the frames it rose through, never its
    text."""

    @app.post("/test/raises")
    async def raises(body: dict) -> dict:
        raise RuntimeError(f"a bug that quotes {body['note']!r}")

    @app.post("/test/unrecorded")
    async def unrecorded(body: dict) -> dict:
        async def fails(ctx: KernelCtx) -> None:
            raise RuntimeError(f"a record that quotes {body['note']!r}")

        raise KernelFailure(409, "conflict", persist=fails)

    with caplog.at_level(logging.INFO, logger="desk.kernel_service"):
        responses = [await client.post(path, json={"note": NOTE}) for path in ("/test/raises", "/test/unrecorded")]
    assert [(response.status_code, response.json()) for response in responses] == [(500, {"code": "internal"})] * 2
    assert "internal_error route=POST /test/raises kind=RuntimeError\n" in caplog.text
    assert ("kernel_failure_unrecorded route=POST /test/unrecorded code=conflict reason=conflict kind=RuntimeError\n"
            in caplog.text)
    assert "mike@riverapl.example" not in caplog.text


PRINTS_ERROR_TEXT = {"exception", "format_exc", "print_exc", "format_exception", "print_exception"}


def test_kernel_logs_never_print_an_errors_text():
    """On a request's or an execution's path, the kernel logs an error with `repo.log_error` only:
    a `logger.exception`, an `exc_info` or a formatted exception would print its text, which can
    quote a visitor. Activation's own logs are left out: their errors come from the prover and the
    owner's own cards, at startup or in the owner's draft."""
    package = Path(kernel_service.__file__).parent
    found = []
    for path in sorted(package.rglob("*.py")):
        if path.name == "activation.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and (
                    (isinstance(node.func, ast.Attribute) and node.func.attr in PRINTS_ERROR_TEXT)
                    or any(keyword.arg == "exc_info" for keyword in node.keywords)):
                found.append(f"{path.relative_to(package)}:{node.lineno}")
    assert found == []


# The KERNEL_ROUTES rows the later kernel plans serve, as each plan's "Produced" list names them. A
# plan takes its rows out of here in the commit that serves them, since the test below fails until then.
LATER_ROUTES: dict[str, set[str]] = {}


def dispatched(routes: list[RouteContext], key: str) -> RouteContext | None:
    """The route the kernel runs for the `KERNEL_ROUTES` key `key`, its path parameters filled in and
    its query left out: the first route that matches, as the router tries them."""
    method, path = key.split(" ", 1)
    path = re.sub(r"\{[^}]*\}", "p-1", path.split("?", 1)[0])
    return next((route for route in routes if method in route.methods and route.path_regex.match(path)), None)


def test_the_kernel_serves_its_routes_as_the_contract_says():
    """Every route the kernel serves runs a `KERNEL_ROUTES` key, with the contract's request and
    response models, and every key is served but the rows a later kernel plan serves; so the API's
    client, built from `KERNEL_ROUTES`, and the kernel can't drift apart unnoticed."""
    app = create_app(KernelSettings(database_url="postgresql+asyncpg://unused/unused"))
    routes = list(iter_route_contexts(app.routes))
    assert all(isinstance(route.original_route, APIRoute) for route in routes)     # no mount or bare route
    later = set().union(*LATER_ROUTES.values())
    assert later <= set(KERNEL_ROUTES)
    ran = []
    for key, (request, response) in KERNEL_ROUTES.items():
        route = dispatched(routes, key)
        if key in later:
            assert route is None, f"{key} is served now: take it out of LATER_ROUTES"
            continue
        assert route is not None, f"{key} is not served"
        bodies = [param.field_info.annotation for param in route.dependant.body_params]
        assert (bodies or [None], route.response_model) == ([request], response), key
        ran.append(route.original_route)
    assert [route.path for route in routes if route.original_route not in ran] == []   # every route runs a key
