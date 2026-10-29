"""Proving: the startup selftest, `desk-prove` runs, the proof cache and loaded versions.

The kernel proves rule sets with `desk-prove` (SymCC and cvc5) when its startup selftest passes
(`symcc` mode) and falls back to the bounded check when it doesn't (`bounded` mode). The Rivera
seed and the starter presets are proved in CI and shipped as reports; a copy activates them only
from that cache, in either mode, and never proves inline.
"""

import dataclasses
import json
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import desk_kernel
import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import ProofReport
from desk.db.models import LedgerEntry, PolicyVersion
from desk.db.session import database_url, dispose_engines, libpq_url
from desk.kernel_service import activation, compiler
from desk.kernel_service.app import create_app
from desk.kernel_service.seed import RIVERA_CARDS

from .conftest import BACKEND
from .fakes import FrozenClock
from .helpers import kernel_ctx, make_copy_rows, rows_of
from .test_compiler import A_MIX_OF_CARDS, NATIVE, card, native_profile

STUBS = Path(__file__).parent / "stubs"


@asynccontextmanager
async def running_kernel(clock: FrozenClock) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    """A kernel app started with the environment as the test has set it, and a client for it."""
    kernel = create_app(clock=clock)
    try:
        async with kernel.router.lifespan_context(kernel):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(kernel), base_url="http://kernel") as http:
                yield kernel, http
    finally:
        await dispose_engines()


@pytest.mark.solver
async def test_selftest_pass_reports_symcc(desk_prove, app, client):
    health = (await client.get("/health")).json()
    assert health["proof_mode"] == "symcc"
    assert activation.proof_mode() == "symcc"


async def test_selftest_failure_reports_bounded(monkeypatch, frozen_clock, caplog):
    monkeypatch.setenv("DESK_PROVE", "/nonexistent")
    async with running_kernel(frozen_clock) as (kernel, http):
        assert (await http.get("/health")).json()["proof_mode"] == "bounded"
        assert kernel.state.proof_mode == activation.proof_mode() == "bounded"
    assert "proof_selftest_failed" in caplog.text


@pytest.mark.solver
async def test_prove_runs_every_obligation(desk_prove):
    inputs = activation.build_proof_inputs(A_MIX_OF_CARDS, NATIVE, compiler.desk_schema(NATIVE))
    report = await activation.prove(inputs)
    assert report.ok and report.method == "symcc" and not report.timed_out, report
    assert [check.name for check in report.checks] == list(activation.PROOF_CHECKS)
    assert {check.name for check in report.checks} == set(activation.PROOF_CHECKS) and len(activation.PROOF_CHECKS) == 7
    assert all(check.ok and check.counterexample_raw is None for check in report.checks)


def printed_report(*, ok: bool, failing: tuple[str, ...] = (), names=None) -> str:
    names = activation.PROOF_CHECKS if names is None else names
    return json.dumps({"ok": ok, "method": "symcc", "cases": None, "timed_out": False,
                       "checks": [{"name": n, "ok": n not in failing, "counterexample_plain": None,
                                   "counterexample_raw": None} for n in names]})


async def test_prover_tool_error_rejects(monkeypatch, tmp_path):
    inputs = activation.build_proof_inputs(A_MIX_OF_CARDS, NATIVE, compiler.desk_schema(NATIVE))
    monkeypatch.setenv("DESK_PROVE", str(STUBS / "desk_prove_exit2.sh"))
    report = await activation.prove(inputs)
    assert not report.ok and report.timed_out and report.method == "symcc"
    assert [(c.name, c.ok, c.counterexample_raw) for c in report.checks] == [
        (name, False, None) for name in activation.PROOF_CHECKS]

    # a prover that can't be started is a tool error too: "Rules can't be checked right now"
    monkeypatch.setenv("DESK_PROVE", str(tmp_path / "missing"))
    assert (await activation.prove(inputs)).timed_out

    # an answer the kernel can't trust rejects, saying nothing changed, never as a pass
    untrusted = {
        "unreadable": ("echo 'all good'", 0),
        "a check missing": (f"echo '{printed_report(ok=True, names=activation.PROOF_CHECKS[1:])}'", 0),
        "a check repeated": (f"echo '{printed_report(ok=True, names=(*activation.PROOF_CHECKS, 'never_errors'))}'", 0),
        "exit 0 with a check not ok": (f"echo '{printed_report(ok=True, failing=('baseline_auto',))}'", 0),
        "exit 1 with every check ok": (f"echo '{printed_report(ok=False)}'", 1),
        "an exit code it doesn't use": (f"echo '{printed_report(ok=True)}'", 3),
    }
    for case, (output, code) in untrusted.items():
        stub = tmp_path / "desk_prove_untrusted.sh"
        stub.write_text(f"#!/bin/sh\n{output}\nexit {code}\n")
        stub.chmod(0o755)
        monkeypatch.setenv("DESK_PROVE", str(stub))
        report = await activation.prove(inputs)
        assert (report.ok, report.timed_out, report.method) == (False, False, "symcc"), case
        assert [(c.name, c.ok, c.counterexample_plain) for c in report.checks] == [
            ("prover", False, "Your rules couldn't be checked, so nothing changed.")], case
    # while the same stub printing a held proof with exit 0 is read as printed
    stub.write_text(f"#!/bin/sh\necho '{printed_report(ok=True)}'\nexit 0\n")
    assert (await activation.prove(inputs)).ok


async def test_prover_timeout_rejects_and_kills(monkeypatch):
    monkeypatch.setenv("DESK_PROVE", str(STUBS / "desk_prove_sleep.sh"))
    monkeypatch.setattr(activation, "PROVE_KILL_AFTER_S", 0.5)
    inputs = activation.build_proof_inputs(A_MIX_OF_CARDS, NATIVE, compiler.desk_schema(NATIVE))
    started = time.monotonic()
    report = await activation.prove(inputs)
    assert time.monotonic() - started < 3
    assert not report.ok and report.timed_out and report.method == "symcc"
    assert all(not c.ok and c.counterexample_raw is None for c in report.checks)
    # the stub and its child are gone: the whole process group was killed and awaited
    assert subprocess.run(["pgrep", "-f", "desk_prove_sleep"], capture_output=True).returncode == 1


def test_shipped_reports_match_the_current_build():
    """A change to the seed or preset cards, the adapter profiles, the schema, baseline,
    invariants, compiler output or thresholds must regenerate the reports (`make proofs`) in the
    same commit: here every shipped report has to match what the kernel compiles today."""
    profiles = activation.shipped_profiles()
    assert set(activation.SHIPPED_PRESETS) == {"rivera", "ask_first", "auto"}
    for preset, cards in activation.SHIPPED_PRESETS.items():
        schema = compiler.desk_schema(profiles)
        hashes = activation.version_hashes(compiler.compile_cards(cards, profiles), schema, profiles)
        shipped = json.loads((activation.PROOFS_DIR / f"{preset}.json").read_text())
        assert shipped["preset"] == preset
        assert {field: shipped[field] for field in hashes._fields} == hashes._asdict(), preset
        proof = ProofReport.model_validate(shipped["proof"])
        assert proof.ok and proof.method == "symcc" and not proof.timed_out, preset
        assert [(c.name, c.ok) for c in proof.checks] == [(name, True) for name in activation.PROOF_CHECKS], preset


@pytest.fixture
def outside_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A working directory outside the repo, entered before the kernel starts."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


def spy_on_proving(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replaces `prove` and `bounded_check` with spies that record every call and fail it."""
    calls: list[str] = []

    async def prove(inputs):
        calls.append("prove")
        raise AssertionError("a shipped rule set was proved inline")

    def bounded_check(*args, **kwargs):
        calls.append("bounded_check")
        raise AssertionError("a shipped rule set was checked inline")

    monkeypatch.setattr(activation, "prove", prove)
    monkeypatch.setattr(activation, "bounded_check", bounded_check)
    return calls


async def post_copy(client: httpx.AsyncClient) -> dict:
    response = await client.post("/copies", json={})
    assert response.status_code == 200, response.text
    return response.json()


def shipped(preset: str) -> activation.ShippedReport:
    return activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / f"{preset}.json").read_text())


async def test_copy_activates_from_the_cache_without_proving(outside_repo, app, client, monkeypatch):
    calls = spy_on_proving(monkeypatch)
    created = await post_copy(client)
    copy_id, [desk_id] = created["copy_id"], created["desk_ids"]
    [row] = await rows_of(app, copy_id, select(PolicyVersion))
    assert (row.desk_id, row.version, row.parent_version, row.status, row.preset) == (desk_id, 1, None, "active",
                                                                                      "rivera")
    report = shipped("rivera")
    assert row.proof == report.proof and row.proof.ok and row.proof.method == "symcc"
    assert activation.VersionHashes(*(getattr(row, f) for f in activation.VersionHashes._fields)) == report.hashes
    profiles = activation.shipped_profiles()
    compiled = compiler.compile_cards(RIVERA_CARDS, profiles)
    assert row.cards == compiled.cards
    assert row.cedar == {**compiled.sets(), "A0": compiler.compile_cards(RIVERA_CARDS, profiles, review=False).A}
    assert json.loads(row.schema_json) == compiler.desk_schema(profiles)
    assert row.created_at == app.state.kernel.clock.now()
    assert calls == []                                            # activated from the shipped report alone
    entries = [e for e in await rows_of(app, copy_id, select(LedgerEntry)) if e.event.kind == "policy"]
    assert [(e.desk_id, e.event.summary) for e in entries] == [(desk_id, {"version": 1, "status": "active",
                                                                          "preset": "rivera"})]
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        active = await activation.active_version(ctx, desk_id)
    assert (active.desk_id, active.version) == (desk_id, 1)


def hashes_of(row: PolicyVersion) -> activation.VersionHashes:
    return activation.VersionHashes(*(getattr(row, field) for field in activation.VersionHashes._fields))


async def test_two_copies_share_one_cached_report(app, client, monkeypatch):
    calls = spy_on_proving(monkeypatch)
    cache = app.state.kernel.policies.cache
    entries = len(cache)
    rows = []
    for _ in range(2):
        created = await post_copy(client)
        rows += await rows_of(app, created["copy_id"], select(PolicyVersion))
    first, second = rows
    assert first.desk_id != second.desk_id
    assert hashes_of(first) == hashes_of(second) == shipped("rivera").hashes   # the same Cedar in every copy
    assert first.cards == second.cards and first.cedar == second.cedar
    assert len(cache) == entries == len({shipped(p).hashes.key for p in activation.SHIPPED_PRESETS})
    assert cache.get(hashes_of(first)) is cache.get(hashes_of(second)) == first.proof == second.proof
    assert calls == []


def force_mode(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    """The startup selftest answers `mode`, whatever is installed."""
    async def run_selftest():
        monkeypatch.setattr(activation, "_proof_mode", mode)
        return mode

    monkeypatch.setattr(activation, "run_selftest", run_selftest)


def kernel_row_counts(*tables: str) -> dict[str, int]:
    """Rows in each kernel table across every copy, as desk_admin sees them."""
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        return {table: admin.execute(f"SELECT count(*) FROM kernel.{table}").fetchone()[0] for table in tables}


async def test_an_uncached_seed_is_503_in_either_mode(monkeypatch, frozen_clock, tmp_path, caplog):
    compiled = shipped("rivera").cedar_sha256                     # what the kernel compiles Rivera's cards to
    # the shipped reports, each with one hash patched, so nothing the kernel compiles has a report
    for preset in activation.SHIPPED_PRESETS:
        report = shipped(preset).model_copy(update={"cedar_sha256": "0" * 64})
        (tmp_path / f"{preset}.json").write_text(activation.report_text(report))
    monkeypatch.setattr(activation, "PROOFS_DIR", tmp_path)
    calls = spy_on_proving(monkeypatch)
    for mode in ("symcc", "bounded"):
        force_mode(monkeypatch, mode)
        caplog.clear()
        async with running_kernel(frozen_clock) as (kernel, http):
            health = (await http.get("/health")).json()
            assert (health["proof_mode"], health["unproved_seeds"]) == (mode, [])
            response = await http.post("/copies", json={})
            assert (response.status_code, response.json()) == (503, {"code": "seed_unproved"}), mode
            assert (await http.get("/health")).json()["unproved_seeds"] == ["rivera"]
        # the copy rolled back with everything in it, and the miss is logged with its hashes
        assert kernel_row_counts("copies", "desks", "sessions", "policy_versions", "ledger_entries") == {
            "copies": 0, "desks": 0, "sessions": 0, "policy_versions": 0, "ledger_entries": 0}
        [line] = [r.getMessage() for r in caplog.records if r.getMessage().startswith("seed_unproved ")]
        assert "preset=rivera" in line and f"cedar_sha256={compiled}" in line
    assert calls == []                                            # never proved inline


async def test_cached_seeds_activate_in_bounded_mode(app, client, monkeypatch):
    calls = spy_on_proving(monkeypatch)
    assert (await client.get("/health")).json()["proof_mode"] == activation.proof_mode() == "bounded"
    created = await post_copy(client)
    [row] = await rows_of(app, created["copy_id"], select(PolicyVersion))
    assert (row.version, row.status, row.preset) == (1, "active", "rivera")
    assert row.proof == shipped("rivera").proof and row.proof.method == "symcc"   # the CI proof, not a bounded check
    assert (await client.get("/health")).json()["unproved_seeds"] == []
    assert calls == []


def slots_request(copy_id: str, desk_id: str) -> str:
    """A stranger asking for open times on the copy's Desk, as a request_json."""
    visitor, desk = {"type": "Visitor", "id": "session-1"}, {"type": "Desk", "id": desk_id}
    return json.dumps({"principal": visitor, "action": "native.find_slots", "resource": desk,
                       "context": {"record_owner_match": False, "local_dow": 1, "local_minute": 600},
                       "entities": [{"uid": visitor, "attrs": {"verified": False, "assurance": "none", "copy": copy_id},
                                     "parents": []},
                                    {"uid": desk, "attrs": {"copy": copy_id}, "parents": []}]})


def verdict(engine, key: str, request: str) -> dict:
    return json.loads(engine.decide(key, request, "final"))


def not_loaded(engine, key: str, request: str) -> bool:
    found = verdict(engine, key, request)
    return found["outcome"] == "refuse" and any("not loaded" in error for error in found["errors"])


def detached(row: PolicyVersion, **changes) -> PolicyVersion:
    """A copy of a version row, changed, that is never stored."""
    columns = {column.key: getattr(row, column.key) for column in PolicyVersion.__table__.columns}
    return PolicyVersion(**{**columns, **changes})


async def test_versions_load_lazily_and_report_errors(app, client):
    engine, versions = app.state.engine, app.state.loaded_versions
    created = await post_copy(client)
    copy_id, [desk_id] = created["copy_id"], created["desk_ids"]
    request = slots_request(copy_id, desk_id)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        row = await activation.active_version(ctx, desk_id)
    key = f"{desk_id}:1"
    # activating stored the version; nothing is loaded until it is first used
    assert key not in versions and len(versions) == 0
    assert not_loaded(engine, key, request) and not_loaded(engine, key + ":approvable", request)
    assert versions.use(row) == [] and key in versions
    for loaded in (key, key + ":approvable"):
        assert verdict(engine, loaded, request)["errors"] == [], loaded
    assert versions.use(row) == [] and len(versions) == 1                    # used again, not loaded twice

    # a version the engine can't load reports why, and its keys decide nothing
    unannotated = {**row.cedar, "A": "permit (principal, action, resource);"}
    broken = detached(row, version=2, cedar=unannotated, cedar_sha256=compiler.cedar_sha256(unannotated))
    errors = versions.use(broken)
    assert errors and f"{desk_id}:2" not in versions
    assert not_loaded(engine, f"{desk_id}:2", request) and not_loaded(engine, f"{desk_id}:2:approvable", request)
    # and so does one whose Cedar or schema isn't what its hashes say was proved
    for changed in ({"cedar": {**row.cedar, "A": row.cedar["A"] + "\n"}},
                    {"schema_json": json.dumps({"": {"entityTypes": {}, "actions": {}}})}, {"cedar": None}):
        errors = versions.use(detached(row, version=3, **changed))
        assert errors, changed
        assert not_loaded(engine, f"{desk_id}:3", request), changed
    assert len(versions) == 1 and verdict(engine, key, request)["errors"] == []


async def store_active_version(app: FastAPI, rows, cards, profiles) -> None:
    """Version 1 of the copy's Desk, active, compiled from `cards` over `profiles`, with no proof."""
    schema = compiler.desk_schema(profiles)
    compiled = compiler.compile_cards(cards, profiles)
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        ctx.db.add(activation.version_row(
            copy_id=rows.copy_id, desk_id=rows.desk_id, version=1, parent_version=None, cards=cards, compiled=compiled,
            a0=compiler.compile_cards(cards, profiles, review=False).A, schema=schema,
            hashes=activation.version_hashes(compiled, schema, profiles), status="active", proof=None,
            created_at=ctx.clock.now()))


async def decide_on_active(app: FastAPI, rows, request: str) -> dict:
    """What deciding on the copy's active version does: load it on first use, then decide."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        row = await activation.active_version(ctx, rows.desk_id)
    assert app.state.loaded_versions.use(row) == []
    return verdict(app.state.engine, f"{rows.desk_id}:1", request)


async def test_loaded_versions_are_capped(app, monkeypatch):
    monkeypatch.setattr(activation, "MAX_LOADED_VERSIONS", 2)
    engine, versions = app.state.engine, app.state.loaded_versions
    slots = [native_profile("native.find_slots")]
    copies = [await make_copy_rows(app) for _ in range(3)]
    for rows in copies:
        await store_active_version(app, rows, [card("slots", "native.find_slots")], slots)
    requests = [slots_request(rows.copy_id, rows.desk_id) for rows in copies]
    for rows, request in zip(copies, requests, strict=True):                  # three copies decide in turn
        assert (await decide_on_active(app, rows, request))["outcome"] == "allow"
    first, second, third = (f"{rows.desk_id}:1" for rows in copies)
    # the first copy's version was the least recently used: both its keys were dropped
    assert len(versions) == 2 and first not in versions and second in versions and third in versions
    assert not_loaded(engine, first, requests[0]) and not_loaded(engine, first + ":approvable", requests[0])
    # its next decision loads it again and allows; now the second copy's is the one dropped
    assert (await decide_on_active(app, copies[0], requests[0]))["outcome"] == "allow"
    assert first in versions and second not in versions and len(versions) == 2
    assert not_loaded(engine, second, requests[1])
    assert verdict(engine, third, requests[2])["outcome"] == "allow"


@pytest.mark.solver
def test_prove_presets_check_passes(desk_prove):
    """What CI runs (`make check-presets`): every shipped set proves again to its shipped report."""
    run = subprocess.run([sys.executable, "-m", "scripts.prove_presets", "--check"], cwd=BACKEND, capture_output=True,
                         text=True, timeout=300)
    assert run.returncode == 0, run.stderr
    assert sorted(run.stdout.splitlines()) == sorted(f"{preset}: proved, and {preset}.json matches"
                                                     for preset in activation.SHIPPED_PRESETS)


@pytest.mark.parametrize("mode", [pytest.param("symcc", marks=pytest.mark.solver), "bounded"])
async def test_dropped_never_card_is_rejected_by_proof(mode, monkeypatch, request):
    if mode == "symcc":
        request.getfixturevalue("desk_prove")
    monkeypatch.setattr(activation, "_proof_mode", mode)                    # as the startup selftest left it
    cards = [card("no-changes", "effect:change", mode="never"), card("book", "native.book")]
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    control = await activation.prove_or_check(engine, cards, NATIVE, key_prefix="desk-test:control")
    assert control.ok and control.method == mode, control                  # as compiled, the never card wins

    # a compiler that emits no forbid for the never card: the booking it should stop is auto-allowed
    compile_cards = compiler.compile_cards
    monkeypatch.setattr(compiler, "compile_cards", lambda *a, **k: dataclasses.replace(compile_cards(*a, **k), F=""))
    report = await activation.prove_or_check(engine, cards, NATIVE, key_prefix="desk-test:dropped")
    assert not report.ok and report.method == mode and not report.timed_out
    failing = {c.name: c for c in report.checks if not c.ok}
    assert {"auto_within_cards", "hold_within_cards"} <= set(failing), report
    for name in ("auto_within_cards", "hold_within_cards"):
        assert failing[name].counterexample_raw["action"] == "native.book", name
