"""Activation: what has to hold before a compiled rule set may decide anything.

Proof mode. At startup the kernel runs `desk-prove --selftest` once (`run_selftest`) and keeps the
answer for the whole process (`proof_mode()`): `symcc` when the solver proves and refutes what it
should, `bounded` on any other result. In `symcc` mode a rule set is proved with `desk-prove`
(`prove`), which has to show all seven obligations of the master plan's "Proof obligations"; a
timeout, a tool error or an answer the kernel can't read rejects, with no fallback.

Shipped sets. The Rivera seed's cards and the starter presets are proved in CI and their reports
ship in `kernel/cedar/proofs/`. They seed the in-memory `ProofCache`, keyed by what a proof covers
(`VersionHashes`), and `activate_shipped` activates a set only on a hit with a passing report, in
either mode; a miss is never proved inline (503 `seed_unproved`).

Owner drafts. `draft` (`POST /policy/draft`) compiles the owner's cards, loads them (lint and
validation) and proves them in `symcc` mode, or only checks them in `bounded` mode; every failing
check reads in the owner's words (`explain.py`). `confirm` (`POST /policy/confirm`) activates a
draft only in `symcc` mode, when a SymCC proof of all seven obligations holds, its parent is still
the active version and everything it was proved against is current.

Loaded versions. A stored version loads into the policy engine on its first use
(`LoadedVersions`), bounded to `MAX_LOADED_VERSIONS` per engine, least recently used out first.

The bounded check (`bounded_check`) stands in for the SymCC proofs when `desk-prove` can't run
(the kernel's `bounded` proof mode). It evaluates requests generated on every card boundary with
the real engine and compares the compiled sets with the reference generator's, check by check, as
the proofs would. A bounded report says "checked on N cases", never "proved", and never activates
an owner's draft: it tells the owner what a proof would most likely have found.

The engine has no unload, so `drop_keys` drops a key with a load that is built to fail: the engine
drops whatever it cached under a key whose load fails.
"""

import asyncio
import hashlib
import itertools
import json
import logging
import os
import shutil
import signal
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from datetime import datetime, time
from pathlib import Path
from typing import Any, Literal, NamedTuple

import desk_kernel
from pydantic import BaseModel, ConfigDict, StrictInt, ValidationError
from sqlalchemy import func, select

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    MONEY_TOOLS,
    LedgerEvent,
    PolicyVersion,
    ProofCheck,
    ProofReport,
    RuleCard,
    ToolProfile,
)
from desk.db.models import AgentKey, Person
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_service import adapters, compiler, desks, explain, ledger, reference, review_thresholds, seed
from desk.kernel_service.auth import OwnerCtx
from desk.kernel_service.reference import RefSets
from desk.kernel_service.repo import KernelCtx, KernelFailure
from desk.presets import PRESETS

log = logging.getLogger(__name__)

ProofMode = Literal["symcc", "bounded"]

# The seven obligations every activation proves, in the master plan's order ("Proof obligations").
PROOF_CHECKS = ("never_errors", "baseline_auto", "baseline_approvable", "auto_within_cards", "review_only_narrows",
                "hold_within_cards", "money_needs_card")
PROVE_TIMEOUT_MS = 45_000          # desk-prove's own budget for a whole run (--timeout-ms)
PROVE_KILL_AFTER_S = 50.0          # the kernel's backstop: past this the process group is killed
SELFTEST_TIMEOUT_S = 30.0          # the startup selftest's backstop; desk-prove's own selftest budget is 20 s
_PROVER_PLAIN = "Your rules couldn't be checked, so nothing changed."

_proof_mode: ProofMode = "bounded"   # until a selftest passes


def proof_mode() -> ProofMode:
    """The proof mode the startup selftest picked for this process (`bounded` before it runs)."""
    return _proof_mode


def prover_path() -> str:
    """The `desk-prove` to run: `DESK_PROVE`, else `desk-prove` on `PATH`."""
    return os.environ.get("DESK_PROVE") or shutil.which("desk-prove") or "desk-prove"


async def run_selftest() -> ProofMode:
    """Runs `desk-prove --selftest` and sets the process's proof mode: `symcc` only when it exits
    0 with a report that is `ok`, by SymCC, with every check ok; `bounded` on anything else (a
    missing binary or solver, a timeout, an unreadable report)."""
    global _proof_mode
    mode: ProofMode = "bounded"
    try:
        code, stdout = await _run([prover_path(), "--selftest"], kill_after=SELFTEST_TIMEOUT_S)
        report = ProofReport.model_validate_json(stdout) if code == 0 else None
        if (report is not None and report.ok and report.method == "symcc" and not report.timed_out
                and report.checks and all(check.ok for check in report.checks)):
            mode = "symcc"
        else:
            log.warning("proof_selftest_failed exit=%s", code)
    except Exception:                    # a missing binary, an unreadable report, anything: bounded
        log.warning("proof_selftest_failed", exc_info=True)
    _proof_mode = mode
    log.info("proof_mode mode=%s", mode)
    return mode


async def _run(argv: Sequence[str], *, kill_after: float) -> tuple[int | None, bytes]:
    """Runs `argv` in its own process group and returns its exit code and output, or `None` for
    the code when it is still running after `kill_after` seconds: then the whole group is killed
    and awaited, so nothing it started (a solver, a child holding its output) outlives the call.
    The group is killed the same way when the caller is cancelled. Raises OSError when `argv`
    can't be started."""
    process = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=True)
    finished = False
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), kill_after)
        finished = True
    except TimeoutError:
        log.warning("prover_killed after_s=%s", kill_after)
        return None, b""
    finally:
        if not finished:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()
    if stderr:
        log.info("prover_stderr %s", stderr[-2000:].decode("utf-8", "replace"))
    return process.returncode, stdout


# ---- Proving with desk-prove ---------------------------------------------------------------------

@dataclass(frozen=True)
class ProofInputs:
    """What `desk-prove` proves a rule set with (the master's "Rust module surface"): the Desk's
    schema, the sets each obligation reads, the invariant files, the money tools no owner card
    covers and the checks to run."""

    schema_json: str
    sets: dict[str, str]                 # B, F, A, A0, H, R, R_hold
    always: list[str]
    auto: list[str]
    money_uncovered: list[str]
    checks: list[str]


def build_proof_inputs(cards: Sequence[RuleCard], profiles: Sequence[ToolProfile],
                       schema: Mapping[str, Any]) -> ProofInputs:
    """The proof inputs for `cards` over the enabled `profiles`: the compiler's `F`, `A`, `H` and
    `A0` (its own emission without review gates), and the reference generator's sets, each
    preceded by its never forbids (`R = never + R`, `R_hold = never + R_hold`), as the bounded
    check loads them. Raises ValueError for cards either generator can't express."""
    compiled = compiler.compile_cards(cards, profiles)
    a0 = compiler.compile_cards(cards, profiles, review=False).A
    refs = reference.reference_sets(cards, schema)
    return ProofInputs(
        schema_json=json.dumps(schema),
        sets={"B": compiler.BASELINE, "F": compiled.F, "A": compiled.A, "A0": a0, "H": compiled.H,
              "R": refs.never + "\n" + refs.R, "R_hold": refs.never + "\n" + refs.R_hold},
        always=list(compiler.INVARIANTS["always"].values()),
        auto=list(compiler.INVARIANTS["auto"].values()),
        money_uncovered=money_uncovered(cards, profiles),
        checks=list(PROOF_CHECKS),
    )


def write_prove_files(inputs: ProofInputs, directory: Path) -> tuple[Path, Path, Path]:
    """Writes `desk-prove`'s `--schema`, `--sets` and `--checks` files into `directory`."""
    schema, sets, checks = directory / "schema.json", directory / "sets.json", directory / "checks.json"
    schema.write_text(inputs.schema_json)
    sets.write_text(json.dumps({**inputs.sets, "always": inputs.always, "auto": inputs.auto}))
    checks.write_text(json.dumps({"checks": inputs.checks, "money_uncovered": inputs.money_uncovered}))
    return schema, sets, checks


async def prove(inputs: ProofInputs) -> ProofReport:
    """Proves `inputs` with `desk-prove` (`prover_path()`), giving it `PROVE_TIMEOUT_MS` and
    killing its process group at `PROVE_KILL_AFTER_S`. Never raises for a prover problem:

    - exit 0 with every check ok: the report as printed (`ok`);
    - exit 1: the report as printed, not `ok` (each failing check's counterexample is a request);
    - exit 2, a timeout, or a prover that can't be started: `timed_out`, every check not ok and
      no counterexample (the owner sees "Rules can't be checked right now");
    - anything else (an unreadable report, a check missing or repeated, an exit 0 with a check
      not ok, another exit code): not `ok`, one `prover` check saying nothing changed.

    A report that comes back lists the seven checks in `PROOF_CHECKS` order."""
    try:
        with tempfile.TemporaryDirectory(prefix="desk-prove-") as directory:
            schema, sets, checks = write_prove_files(inputs, Path(directory))
            argv = [prover_path(), "--schema", str(schema), "--sets", str(sets), "--checks", str(checks),
                    "--timeout-ms", str(PROVE_TIMEOUT_MS)]
            code, stdout = await _run(argv, kill_after=PROVE_KILL_AFTER_S)
        if code is None or code == 2:
            return _timed_out()
        return _read_report(code, stdout)
    except OSError:                      # no prover to start, or no room for its inputs: try again later
        log.warning("prover_unavailable", exc_info=True)
        return _timed_out()
    except Exception:
        log.exception("prover_failed")
        return _prover_failure()


async def prove_or_check(engine: desk_kernel.PolicyEngine, cards: Sequence[RuleCard], profiles: Sequence[ToolProfile],
                         *, key_prefix: str) -> ProofReport:
    """What the process's proof mode can say about `cards` over the enabled `profiles`: in
    `symcc` mode a `desk-prove` proof (`prove`), in `bounded` mode the bounded check (in a thread,
    under `bounded:<key_prefix>` keys, so pass a prefix unique to the draft). Cards the compiler
    or the reference generator can't express fail as a `prover` check: nothing is ever a pass by
    error. Only a `symcc` report that holds may activate anything."""
    mode = proof_mode()
    try:
        schema = compiler.desk_schema(profiles)
        if mode == "symcc":
            inputs = build_proof_inputs(cards, profiles, schema)
        else:
            compiled = compiler.compile_cards(cards, profiles)
            a0 = compiler.compile_cards(cards, profiles, review=False).A
            refs = reference.reference_sets(cards, schema)
    except Exception:
        log.warning("rules_uncompilable", exc_info=True)
        return _prover_failure(mode)
    if mode == "symcc":
        return await prove(inputs)
    return await asyncio.to_thread(bounded_check, engine, key_prefix=key_prefix, schema_json=json.dumps(schema),
                                   compiled=compiled, a0=a0, refs=refs, cards=cards, profiles=profiles)


def _timed_out() -> ProofReport:
    return ProofReport(ok=False, method="symcc", timed_out=True,
                       checks=[ProofCheck(name=name, ok=False) for name in PROOF_CHECKS])


def _prover_failure(method: ProofMode = "symcc") -> ProofReport:
    return ProofReport(ok=False, method=method, cases=0 if method == "bounded" else None,
                       checks=[ProofCheck(name="prover", ok=False, counterexample_plain=_PROVER_PLAIN)])


def _read_report(code: int, stdout: bytes) -> ProofReport:
    """The report `desk-prove` printed with exit 0 or 1, if it is one the kernel can trust."""
    if code not in (0, 1):
        log.warning("prover_failed exit=%s", code)
        return _prover_failure()
    try:
        printed = ProofReport.model_validate_json(stdout)
    except ValidationError:
        log.warning("prover_report_unreadable exit=%s", code)
        return _prover_failure()
    by_name = {check.name: check for check in printed.checks}
    if printed.method != "symcc" or printed.timed_out or len(by_name) != len(printed.checks) \
            or set(by_name) != set(PROOF_CHECKS):
        log.warning("prover_report_incomplete exit=%s checks=%s", code, sorted(by_name))
        return _prover_failure()
    checks = [by_name[name] for name in PROOF_CHECKS]
    held = all(check.ok for check in checks)
    if (code == 0) != held or (code == 0) != printed.ok:   # exit 0 iff every check holds
        log.warning("prover_report_inconsistent exit=%s", code)
        return _prover_failure()
    return ProofReport(ok=held, method="symcc", checks=checks)


# ---- What a proof covers -------------------------------------------------------------------------

class VersionHashes(NamedTuple):
    """What a proof of a compiled version was proved against, all of it the proof cache's key.

    `desk-prove` reads the compiled Cedar (`cedar_sha256`), the schema, the baseline and the
    invariant files (`invariants_sha256`, with the prover's version), and three things that come
    from the owner's cards rather than from the Cedar: the reference generator's `R` and `R_hold`,
    the compiler's `A0` and the money tools no card covers. `cards_sha256` stands for those: it
    hashes the cards the reference generator reads, never the compiler's output, so cards that
    compile to the same Cedar (as a compiler that drops a never card would make them) never share
    a report. The enabled profiles, with their pinned definitions, and the review thresholds'
    version complete it. Within one build these fix every input `desk-prove` reads; across builds,
    `make check-presets` proves the shipped sets again."""

    cedar_sha256: str
    cards_sha256: str
    schema_sha256: str
    baseline_sha256: str
    profiles_sha256: str
    invariants_sha256: str
    review_thresholds_version: int


def cards_sha256(cards: Iterable[RuleCard]) -> str:
    """sha256 of `canonical_json` of the owner's cards (defaults left out: both generators derive
    them again from the profiles), sorted by `card_id`."""
    owned = sorted((card for card in cards if not card.is_default), key=lambda card: card.card_id)
    dumped = [card.model_dump(mode="json") for card in owned]
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(dumped)).encode()).hexdigest()


def profiles_sha256(profiles: Iterable[ToolProfile]) -> str:
    """sha256 of `canonical_json({tool: profile})` over the enabled profiles, each without its
    status and pending fields, so a pinned `definition_sha256` is covered and an enable or disable
    alone isn't."""
    by_tool: dict[str, Any] = {}
    for profile in profiles:
        if profile.tool in by_tool:
            raise ValueError(f"{profile.tool} is enabled twice")
        by_tool[profile.tool] = profile.model_dump(mode="json", exclude=set(adapters.UNHASHED_PROFILE_FIELDS))
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(by_tool)).encode()).hexdigest()


def version_hashes(compiled: compiler.CompiledSets, schema: Mapping[str, Any], profiles: Iterable[ToolProfile],
                   *, cards: Iterable[RuleCard]) -> VersionHashes:
    """The hashes of `compiled`, the set compiled from `cards` over the enabled `profiles`. Pass
    the owner's cards as given to the compiler and the reference generator, not `compiled.cards`."""
    return VersionHashes(
        cedar_sha256=compiler.cedar_sha256(compiled),
        cards_sha256=cards_sha256(cards),
        schema_sha256=compiler.schema_sha256(dict(schema)),
        baseline_sha256=compiler.baseline_sha256(),
        profiles_sha256=profiles_sha256(profiles),
        invariants_sha256=compiler.invariants_sha256(PROOF_CHECKS),
        review_thresholds_version=review_thresholds.REVIEW_THRESHOLDS_VERSION,
    )


# ---- Shipped rule sets ---------------------------------------------------------------------------
#
# The Rivera seed's cards and the starter presets are proved in CI (`make proofs` writes a report
# per set into PROOFS_DIR, `make check-presets` re-proves and compares them). Their card IDs are
# fixed and their scopes never name a person, so they compile to the same hashes in every copy.

PROOFS_DIR = compiler.CEDAR_DIR / "proofs"
SHIPPED_PRESETS: dict[str, list[RuleCard]] = {
    "rivera": seed.RIVERA_CARDS,
    "ask_first": PRESETS["ask_first"],
    "auto": PRESETS["auto"],
}


def shipped_profiles() -> list[ToolProfile]:
    """The profiles a new Desk enables (`desks.create_desk`): the registered native adapters'."""
    return adapters.registered_profiles(source="native")


class ShippedReport(BaseModel):
    """A file in PROOFS_DIR: the proof of one shipped rule set and the hashes it covers."""

    model_config = ConfigDict(extra="forbid")

    preset: str
    cedar_sha256: str
    cards_sha256: str
    schema_sha256: str
    baseline_sha256: str
    profiles_sha256: str
    invariants_sha256: str
    review_thresholds_version: StrictInt
    proof: ProofReport

    @property
    def hashes(self) -> VersionHashes:
        return VersionHashes(*(getattr(self, field) for field in VersionHashes._fields))


def shipped_report(preset: str, hashes: VersionHashes, proof: ProofReport) -> ShippedReport:
    return ShippedReport(preset=preset, **hashes._asdict(), proof=proof)


def report_text(report: ShippedReport) -> str:
    """A report file's exact text: sorted, indented JSON, so a regenerated report diffs cleanly."""
    return json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"


# ---- The proof cache -----------------------------------------------------------------------------

def proved(report: ProofReport) -> bool:
    """A SymCC report in which all seven obligations hold: the only kind that activates."""
    return (report.ok and report.method == "symcc" and not report.timed_out
            and [(c.name, c.ok) for c in report.checks] == [(name, True) for name in PROOF_CHECKS])


def conclusive(report: ProofReport) -> bool:
    """A SymCC report that answered every obligation, held or not (no timeout, no prover failure)."""
    return (report.method == "symcc" and not report.timed_out
            and [c.name for c in report.checks] == list(PROOF_CHECKS))


class ProofCache:
    """Proof reports in memory, by everything they were proved against (`VersionHashes`, cards and
    thresholds version included), so every copy of a rule set reuses one report while other cards
    never do: the shipped reports, loaded at startup, and every conclusive live SymCC proof the
    kernel adds."""

    def __init__(self) -> None:
        self._entries: dict[VersionHashes, ProofReport] = {}
        self._lock = threading.Lock()

    @classmethod
    def shipped(cls) -> "ProofCache":
        """A cache holding the shipped reports in PROOFS_DIR. A file that isn't a report is logged
        and left out: what it would have activated answers `seed_unproved`. With no report at all
        (a missing or empty directory) every shipped set will, so that is logged as an error."""
        cache = cls()
        for path in sorted(PROOFS_DIR.glob("*.json")):
            try:
                report = ShippedReport.model_validate_json(path.read_bytes())
            except (OSError, ValidationError):
                log.warning("proof_report_unreadable file=%s", path.name)
                continue
            if not cache.put(report.hashes, report.proof):
                log.warning("proof_report_inconclusive file=%s", path.name)
        if not len(cache):
            log.error("proof_reports_missing dir=%s", PROOFS_DIR)
        return cache

    def put(self, hashes: VersionHashes, report: ProofReport) -> bool:
        """Keeps a conclusive SymCC report for `hashes`; anything else (a bounded check, a timeout,
        a prover failure) is no answer and isn't kept. A failed proof is never replaced by a
        passing one for the same hashes. Returns whether the report is kept."""
        if not conclusive(report):
            return False
        with self._lock:
            current = self._entries.get(hashes)
            if current is not None and not current.ok and report.ok:
                log.warning("proof_cache_conflict cedar_sha256=%s cards_sha256=%s", hashes.cedar_sha256,
                            hashes.cards_sha256)
                return False
            self._entries[hashes] = report
        return True

    def get(self, hashes: VersionHashes) -> ProofReport | None:
        """The report proved against exactly `hashes`, if there is one."""
        with self._lock:
            return self._entries.get(hashes)

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


# ---- Loaded versions -----------------------------------------------------------------------------
#
# The engine caches every key it loads and has no unload, and every copy has its own Desk, so the
# loaded versions are bounded here: an LRU of versions (active or draft), each loaded under
# `<desk_id>:<version>` (F, A, H) and `<desk_id>:<version>:approvable` (F, H). A version loads on
# its first use; past the cap the least recently used is dropped and reloads on its next use. A
# decide that races an eviction gets the engine's "not loaded" refusal, so it fails closed.

MAX_LOADED_VERSIONS = 256


def version_key(desk_id: str, version: int) -> str:
    return f"{desk_id}:{version}"


def load_version(engine: desk_kernel.PolicyEngine, row: PolicyVersionRow) -> list[str]:
    """Loads a stored version into `engine` under its two keys and returns the errors; empty means
    both loaded. The Cedar and schema must still match the hashes they were proved under. On any
    error neither key stays loaded, so deciding on the version refuses."""
    key = version_key(row.desk_id, row.version)
    keys = [key, key + ":approvable"]
    cedar = row.cedar or {}
    if row.schema_json is None or any(not isinstance(cedar.get(name), str) for name in ("F", "A", "H")):
        errors = ["the version has no compiled Cedar or schema"]
    elif compiler.cedar_sha256(cedar) != row.cedar_sha256:
        errors = ["the version's Cedar doesn't match its cedar_sha256"]
    elif _schema_hash(row.schema_json) != row.schema_sha256:
        errors = ["the version's schema doesn't match its schema_sha256"]
    else:
        errors = engine.load(key, row.schema_json, json.dumps({"F": cedar["F"], "A": cedar["A"], "H": cedar["H"]}))
        if not errors:
            errors = engine.load(keys[1], row.schema_json, json.dumps({"F": cedar["F"], "A": "", "H": cedar["H"]}))
    if errors:
        drop_keys(engine, keys)
        log.warning("version_unloadable key=%s errors=%d", key, len(errors))
    return list(errors)


def _schema_hash(schema_json: str) -> str | None:
    try:
        return compiler.schema_sha256(json.loads(schema_json))
    except ValueError:
        return None


class LoadedVersions:
    """The versions loaded in one engine, least recently used first, at most `MAX_LOADED_VERSIONS`
    (read at each use). Only this class loads or drops `<desk_id>:<version>` keys."""

    def __init__(self, engine: desk_kernel.PolicyEngine):
        self.engine = engine
        self._recent: OrderedDict[str, None] = OrderedDict()
        self._lock = threading.Lock()

    def use(self, row: PolicyVersionRow) -> list[str]:
        """Makes sure `row` is loaded and marks it most recent; returns the load errors (empty
        means its keys decide). Loading past the cap drops the least recently used version."""
        key = version_key(row.desk_id, row.version)
        with self._lock:
            if key in self._recent:
                self._recent.move_to_end(key)
                return []
            errors = load_version(self.engine, row)
            if errors:
                return errors
            self._recent[key] = None
            while len(self._recent) > MAX_LOADED_VERSIONS:
                evicted, _ = self._recent.popitem(last=False)
                drop_keys(self.engine, [evicted, evicted + ":approvable"])
            return []

    def __contains__(self, key: object) -> bool:
        with self._lock:
            return key in self._recent

    def __len__(self) -> int:
        with self._lock:
            return len(self._recent)


@dataclass(frozen=True)
class PolicyRuntime:
    """What deciding and activating share for the kernel's lifetime: the policy engine (over the
    always-on baseline), its loaded versions, the proof cache, and the shipped sets that failed to
    activate for want of a report (`Health.unproved_seeds`)."""

    engine: desk_kernel.PolicyEngine
    versions: LoadedVersions
    cache: ProofCache
    unproved_seeds: set[str]

    @classmethod
    def start(cls, unproved_seeds: set[str] | None = None) -> "PolicyRuntime":
        """A fresh engine over `compiler.BASELINE` (raises on a baseline it can't take) and the
        shipped reports."""
        engine = desk_kernel.PolicyEngine(compiler.BASELINE)
        return cls(engine=engine, versions=LoadedVersions(engine), cache=ProofCache.shipped(),
                   unproved_seeds=unproved_seeds if unproved_seeds is not None else set())


# ---- Activating a shipped set --------------------------------------------------------------------

class SeedUnproved(KernelFailure):
    """A shipped rule set compiled to hashes no shipped report proved: 503 `seed_unproved`."""

    def __init__(self, preset: str):
        super().__init__(503, "seed_unproved", f"seed_unproved:{preset}")
        self.preset = preset


def version_row(*, copy_id: str, desk_id: str, version: int, parent_version: int | None,
                compiled: compiler.CompiledSets, a0: str, schema: Mapping[str, Any], hashes: VersionHashes,
                status: str, proof: ProofReport | None, created_at: datetime,
                preset: str | None = None, draft_key_sha256: str | None = None) -> PolicyVersionRow:
    """A `policy_versions` row for a compiled version: its cards with defaults, its Cedar (`F`,
    `A`, `H` and `A0`), its schema as loaded and the hashes its proof covers (`cards_sha256`
    among them, from `version_hashes`); an owner's draft also carries its `draft_key_sha256`."""
    return PolicyVersionRow(
        desk_id=desk_id, version=version, copy_id=copy_id, parent_version=parent_version, cards=compiled.cards,
        status=status, proof=proof, **hashes._asdict(), created_at=created_at,
        cedar={**compiled.sets(), "A0": a0}, schema_json=json.dumps(schema), preset=preset,
        draft_key_sha256=draft_key_sha256)


def version_contract(row: PolicyVersionRow) -> PolicyVersion:
    return PolicyVersion(desk_id=row.desk_id, version=row.version, parent_version=row.parent_version,
                         cards=row.cards, cedar_sha256=row.cedar_sha256, schema_sha256=row.schema_sha256,
                         baseline_sha256=row.baseline_sha256, profiles_sha256=row.profiles_sha256,
                         invariants_sha256=row.invariants_sha256,
                         review_thresholds_version=row.review_thresholds_version, status=row.status, proof=row.proof)


async def activate_shipped(ctx: KernelCtx, desk_id: str, preset: str) -> PolicyVersion:
    """Makes a shipped rule set (`SHIPPED_PRESETS`) version 1 of a new Desk, `active`, in the
    caller's transaction, ledgered `policy` `{version, status: "active", preset}`. The set is
    compiled over the Desk's enabled profiles and activates only on a cache hit with a passing
    SymCC report, in either proof mode; nothing is proved here. A miss raises `SeedUnproved` (503,
    so the caller's transaction and everything in it roll back), lists the preset in
    `Health.unproved_seeds` and logs `seed_unproved` with the hashes, since there may be no Desk
    left to ledger on."""
    cards = SHIPPED_PRESETS[preset]
    profiles = await desks.enabled_profiles(ctx, desk_id)
    schema = compiler.desk_schema(profiles)
    compiled = compiler.compile_cards(cards, profiles)
    hashes = version_hashes(compiled, schema, profiles, cards=cards)
    report = ctx.policies.cache.get(hashes)
    if report is None or not proved(report):
        ctx.policies.unproved_seeds.add(preset)
        log.error("seed_unproved preset=%s %s", preset,
                  " ".join(f"{field}={value}" for field, value in hashes._asdict().items()))
        raise SeedUnproved(preset)
    row = version_row(copy_id=ctx.copy_id, desk_id=desk_id, version=1, parent_version=None, compiled=compiled,
                      a0=compiler.compile_cards(cards, profiles, review=False).A, schema=schema, hashes=hashes,
                      status="active", proof=report, created_at=ctx.clock.now(), preset=preset)
    ctx.db.add(row)
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel", summary={"version": 1, "status": "active", "preset": preset}))
    return version_contract(row)


async def active_version(ctx: KernelCtx, desk_id: str) -> PolicyVersionRow | None:
    """The Desk's active version, if it has one (the caller's copy must be bound)."""
    return (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.status == "active")))).one_or_none()


# ---- Owner drafts --------------------------------------------------------------------------------
#
# `POST /policy/draft` turns the owner's cards into a stored version that can't decide anything
# yet: compiled, loaded (lint and validation), then proved in `symcc` mode (a cached report for
# the same cards and hashes stands in for a run) or checked in `bounded` mode, which never
# activates. It is idempotent on a key over the parent and everything the proof covers, so a
# re-post (the API's poll after its 25 s answer) waits for the running proof and gets its version.

class Hashes(NamedTuple):
    """What a version is proved against besides its own cards and Cedar: the Desk's schema, the
    baseline, the enabled profiles, the invariants (with the check list and the prover's version)
    and the review thresholds' version. Confirm needs a version's to be the current ones."""

    schema_sha256: str
    baseline_sha256: str
    profiles_sha256: str
    invariants_sha256: str
    review_thresholds_version: int


def _hashes(profiles: Sequence[ToolProfile], schema: Mapping[str, Any]) -> Hashes:
    return Hashes(schema_sha256=compiler.schema_sha256(dict(schema)), baseline_sha256=compiler.baseline_sha256(),
                  profiles_sha256=profiles_sha256(profiles), invariants_sha256=compiler.invariants_sha256(PROOF_CHECKS),
                  review_thresholds_version=review_thresholds.REVIEW_THRESHOLDS_VERSION)


async def current_hashes(ctx: KernelCtx, desk_id: str) -> Hashes:
    """The hashes a version of the Desk would be proved against now, from its enabled profiles."""
    profiles = await desks.enabled_profiles(ctx, desk_id)
    return _hashes(profiles, compiler.desk_schema(profiles))


def draft_key_sha256(parent_version: int | None, cards: Iterable[RuleCard], hashes: Hashes) -> str:
    """sha256 of `canonical_json({parent_version, cards_sha256, schema_sha256, baseline_sha256,
    profiles_sha256, invariants_sha256, review_thresholds_version})`: the same cards on the same
    parent, proved against the same things, are the same draft."""
    key = {"parent_version": parent_version, "cards_sha256": cards_sha256(cards), **hashes._asdict()}
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(key)).encode()).hexdigest()


def _lock_id(*parts: str) -> int:
    """A Postgres advisory lock ID (a signed 64-bit integer) for `parts`, apart from other locks."""
    digest = hashlib.sha256("\0".join(("desk-policy", *parts)).encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


async def _lock(ctx: KernelCtx, *parts: str) -> None:
    """Takes the transaction's advisory lock on `parts`, waiting for whoever holds it to commit."""
    await ctx.db.execute(select(func.pg_advisory_xact_lock(_lock_id(*parts))))


async def desk_people(ctx: KernelCtx, desk_id: str) -> dict[str, str]:
    """The Desk's people, display name by person ID."""
    rows = await ctx.db.execute(ctx.repo.scoped(
        select(Person.person_id, Person.display_name).where(Person.desk_id == desk_id)))
    return {person_id: name for person_id, name in rows}


async def _agent_keys(ctx: KernelCtx) -> set[str]:
    return set((await ctx.db.scalars(ctx.repo.scoped(select(AgentKey.agent_key_id)))).all())


def load_draft(engine: desk_kernel.PolicyEngine, *, key: str, schema_json: str,
               compiled: compiler.CompiledSets) -> list[str]:
    """Loads a draft the way its version will load (`F`, `A`, `H` to decide, and `F`, `H` for
    approvals) under `key` and `key:approvable`, then drops both, and returns the lint and
    validation errors: empty means the draft loads."""
    keys = [key, key + ":approvable"]
    try:
        errors = engine.load(keys[0], schema_json, json.dumps(compiled.sets()))
        if not errors:
            errors = engine.load(keys[1], schema_json, json.dumps({"F": compiled.F, "A": "", "H": compiled.H}))
    finally:
        drop_keys(engine, keys)
    return list(errors)


async def _check_draft(ctx: KernelCtx, *, key: str, schema: Mapping[str, Any], cards: Sequence[RuleCard],
                       profiles: Sequence[ToolProfile], compiled: compiler.CompiledSets,
                       hashes: VersionHashes) -> ProofReport:
    """What the process's proof mode says about a draft that loads; a draft that doesn't is
    rejected by its `lint` check before anything is proved. In `symcc` mode a cached report for
    exactly these hashes stands in for a run, and every conclusive run is cached."""
    mode = proof_mode()
    errors = load_draft(ctx.policies.engine, key=f"draft:{key}", schema_json=json.dumps(schema), compiled=compiled)
    if errors:
        log.warning("draft_unloadable errors=%d", len(errors))
        return ProofReport(ok=False, method=mode, cases=0 if mode == "bounded" else None,
                           checks=[ProofCheck(name="lint", ok=False)])
    if mode == "symcc" and (cached := ctx.policies.cache.get(hashes)) is not None:
        return cached
    report = await prove_or_check(ctx.policies.engine, cards, profiles, key_prefix=key)
    if report.method == "symcc":
        ctx.policies.cache.put(hashes, report)
    return report


def _draft_status(report: ProofReport) -> str:
    """`proved` only for a SymCC proof of all seven obligations; a bounded check that holds leaves
    a `draft`, which never activates; anything else is `rejected`."""
    if report.method == "symcc":
        return "proved" if proved(report) else "rejected"
    return "draft" if report.ok else "rejected"


# What proving a draft again rewrites: its compiled sets, what they were proved against and the verdict.
_PROVED_COLUMNS = ("cards", "cedar", "schema_json", *VersionHashes._fields, "status", "proof")


def _proves_again(row: PolicyVersionRow) -> bool:
    """An unconfirmed draft whose report answered nothing proves again when it is posted again: a
    timeout or a prover that couldn't run, or a bounded check now that SymCC can run."""
    proof = row.proof
    return row.status in ("draft", "rejected") and (
        proof is None or proof.timed_out or (proof.method == "bounded" and proof_mode() == "symcc"))


async def draft(ctx: KernelCtx, owner: OwnerCtx, desk_id: str, cards: Sequence[RuleCard],
                expected_parent: int | None) -> PolicyVersion:
    """The owner's `cards` as a new version of the Desk, proved or checked, in the caller's
    transaction (`POST /policy/draft`), ledgered `policy` `{version, status, method}`.

    Cards `validate_cards` refuses are 422 `invalid`, and a parent that isn't the active version
    409 `conflict`. Default asks are dropped and derived again. A draft with the same key (the
    parent, the cards and the hashes they are proved against) is returned as it is, unless its
    report answered nothing (`_proves_again`): then it is proved again in place. The key's advisory
    lock is held until commit, so a re-post waits for the running proof; the version number is
    allocated under the Desk's lock just before the insert. Every failing check of the report
    reads in the owner's words."""
    owned = [card for card in cards if not card.is_default]
    people = await desk_people(ctx, desk_id)
    if compiler.validate_cards(owned, people=people.keys(), agent_keys=await _agent_keys(ctx)):
        raise KernelFailure(422, "invalid", "invalid_cards")
    active = await active_version(ctx, desk_id)
    if (active.version if active is not None else None) != expected_parent:
        raise KernelFailure(409, "conflict", "parent_not_active")
    profiles = await desks.enabled_profiles(ctx, desk_id)
    schema = compiler.desk_schema(profiles)
    key = draft_key_sha256(expected_parent, owned, _hashes(profiles, schema))
    await _lock(ctx, "draft", desk_id, key)
    existing = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.draft_key_sha256 == key)))).one_or_none()
    if existing is not None and not _proves_again(existing):
        return version_contract(existing)
    try:
        compiled = compiler.compile_cards(owned, profiles)
        a0 = compiler.compile_cards(owned, profiles, review=False).A
    except ValueError:
        raise KernelFailure(422, "invalid", "uncompilable_cards") from None
    hashes = version_hashes(compiled, schema, profiles, cards=owned)
    report = await _check_draft(ctx, key=f"{desk_id}:{key}", schema=schema, cards=owned, profiles=profiles,
                                compiled=compiled, hashes=hashes)
    report = explain.explain_report(report, people)
    status = _draft_status(report)
    if existing is None:
        await _lock(ctx, "versions", desk_id)
        version = await _next_version(ctx, desk_id)
    else:
        version = existing.version
    row = version_row(copy_id=owner.copy_id, desk_id=desk_id, version=version, parent_version=expected_parent,
                      compiled=compiled, a0=a0, schema=schema, hashes=hashes, status=status, proof=report,
                      created_at=ctx.clock.now(), draft_key_sha256=key)
    if existing is None:
        ctx.db.add(row)
    else:
        # proved again in place: the row takes the Cedar this run proved, which a newer compiler
        # may have emitted differently from the first run, so a report never covers other Cedar
        for column in _PROVED_COLUMNS:
            setattr(existing, column, getattr(row, column))
        row = existing
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=owner.copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel", summary={"version": row.version, "status": status, "method": report.method}))
    return version_contract(row)


async def _next_version(ctx: KernelCtx, desk_id: str) -> int:
    """The Desk's next version number; call it holding the Desk's `versions` lock."""
    latest = (await ctx.db.scalars(ctx.repo.scoped(
        select(func.max(PolicyVersionRow.version)).where(PolicyVersionRow.desk_id == desk_id)))).one()
    return (latest or 0) + 1


# ---- Confirm -------------------------------------------------------------------------------------

ConfirmRefusal = Literal["not_proved", "parent_changed", "hash_changed"]


class ConfirmConflict(KernelFailure):
    """A version that can't be activated now: 409 `conflict`, ledgered `policy` `{version,
    refused: <reason>}` after the request's transaction has rolled back."""

    def __init__(self, copy_id: str, desk_id: str, version: int, refused: ConfirmRefusal):
        super().__init__(409, "conflict", f"confirm_{refused}",
                         persist=partial(_ledger_refusal, copy_id=copy_id, desk_id=desk_id, version=version,
                                         refused=refused))
        self.refused = refused


async def _ledger_refusal(ctx: KernelCtx, *, copy_id: str, desk_id: str, version: int, refused: str) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel", summary={"version": version, "refused": refused}))


def _proved_against(row: PolicyVersionRow) -> Hashes:
    return Hashes(*(getattr(row, field) for field in Hashes._fields))


async def confirm(ctx: KernelCtx, desk_id: str, version: int) -> PolicyVersion:
    """Activates a proved version (`POST /policy/confirm`) in the caller's transaction: it becomes
    `active`, the version it replaces `superseded`, ledgered `policy` `{version, activated: true,
    from: <old>}`. Confirms on the Desk are serialized by its `versions` lock, and the active row
    is locked `FOR UPDATE`. A version the Desk doesn't have is 404 `not_found`, with nothing
    ledgered; one it has is refused, in this order, with `ConfirmConflict`:

    - `not_proved`, before the other conflicts: the process runs in `bounded` mode, where no owner
      draft activates, even one SymCC proved before a restart;
    - `not_proved`: the version isn't `proved` by a SymCC proof of all seven obligations (a
      bounded check, a rejection, or a version already active or superseded);
    - `parent_changed`: the version it was drafted on is no longer the active one;
    - `hash_changed`: the schema, baseline, enabled profiles, invariants or review thresholds it
      was proved against aren't the current ones (`current_hashes`)."""
    copy_id = ctx.copy_id
    await _lock(ctx, "versions", desk_id)
    active = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.status == "active").with_for_update()))).one_or_none()
    row = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.version == version).with_for_update()))).one_or_none()
    if row is None:
        raise KernelFailure(404, "not_found", "unknown_version")
    if proof_mode() != "symcc":
        raise ConfirmConflict(copy_id, desk_id, version, "not_proved")
    if row.status != "proved" or row.proof is None or not proved(row.proof):
        raise ConfirmConflict(copy_id, desk_id, version, "not_proved")
    if row.parent_version != (active.version if active is not None else None):
        raise ConfirmConflict(copy_id, desk_id, version, "parent_changed")
    if _proved_against(row) != await current_hashes(ctx, desk_id):
        raise ConfirmConflict(copy_id, desk_id, version, "hash_changed")
    if active is not None:
        active.status = "superseded"
        await ctx.db.flush()              # one active version per Desk, even between the two updates
    row.status = "active"
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel",
        summary={"version": version, "activated": True, "from": active.version if active is not None else None}))
    return version_contract(row)


# The bounded checks, in the order a report lists them. Each holds when, on every case:
# - auto_within_cards: `:policy` auto-allows => `:R` auto-allows;
# - review_only_narrows: `:policy` auto-allows => `:a0` auto-allows;
# - hold_within_cards: `:approvable` holds => `:R_hold` holds;
# - money_needs_card: for a money tool no non-default card covers, `:policy` never auto-allows;
# - never_errors: no evaluation on any key returns errors.
BOUNDED_CHECKS = ("auto_within_cards", "review_only_narrows", "hold_within_cards", "money_needs_card", "never_errors")
MAX_BOUNDED_CASES = 5000
# What each bounded key loads, as (F, A, H) from the compiled sets, A0 and the reference sets.
_BOUNDED_SETS = ("policy", "approvable", "a0", "R", "R_hold")
_MONEY_EFFECTS = frozenset({"charge", "pay_out"})

_in_use: set[str] = set()
_in_use_lock = threading.Lock()


def bounded_keys(key_prefix: str) -> list[str]:
    """The engine keys a bounded check of `key_prefix` loads, in `_BOUNDED_SETS` order. They live
    under `bounded:`, apart from the `<desk_id>:<version>` keys of loaded versions, so dropping them
    can never evict a version that is deciding."""
    return [f"bounded:{key_prefix}:{name}" for name in _BOUNDED_SETS]


def drop_keys(engine: desk_kernel.PolicyEngine, keys: Iterable[str]) -> None:
    """Drops each key from `engine` with a load that fails (an empty sets object doesn't lint), so
    deciding on it refuses as "not loaded". Raises if a load ever succeeds instead."""
    for key in keys:
        if not engine.load(key, "{}", "{}"):
            raise RuntimeError("a load built to fail was accepted, so a key wasn't dropped")


def money_uncovered(cards: Iterable[RuleCard], profiles: Sequence[ToolProfile]) -> list[str]:
    """The enabled money tools (a `charge` or `pay_out` effect, or in `MONEY_TOOLS`) that no
    non-default card covers: `money_needs_card` requires the auto set never to allow them."""
    owned = [card for card in cards if not card.is_default]
    return sorted(p.tool for p in profiles
                  if _is_money(p.tool, frozenset(p.effects))
                  and not any(compiler.covers(card, p.tool, profiles, owned) for card in owned))


def bounded_check(engine: desk_kernel.PolicyEngine, *, key_prefix: str, schema_json: str,
                  compiled: compiler.CompiledSets, a0: str, refs: RefSets, cards: Sequence[RuleCard],
                  profiles: Sequence[ToolProfile]) -> ProofReport:
    """Checks `compiled` (with `a0`, the auto set compiled without review gates) against the
    reference sets on the requests `bounded_cases` generates, and returns a `method="bounded"`
    report whose `cases` is how many it evaluated. Synchronous: call it through
    `asyncio.to_thread`. It loads five keys (`bounded_keys(key_prefix)`):

    - `:policy` (`F`, `A`, `H`), `:approvable` (`F`, empty, `H`), `:a0` (`F`, `A0`, `H`);
    - `:R` (the reference's never forbids, `R`, empty) and `:R_hold` (never, empty, `R_hold`);

    and drops all five when done, whatever happens. A load error fails the `lint` check and
    nothing is evaluated; any other error fails a `prover` check. Each failing check carries the
    first failing request in `counterexample_raw`. A key prefix can be checked once at a time."""
    keys = bounded_keys(key_prefix)
    with _in_use_lock:
        if key_prefix in _in_use:
            raise RuntimeError("a bounded check of this key prefix is already running")
        _in_use.add(key_prefix)
    try:
        sets = {
            "policy": (compiled.F, compiled.A, compiled.H),
            "approvable": (compiled.F, "", compiled.H),
            "a0": (compiled.F, a0, compiled.H),
            "R": (refs.never, refs.R, ""),
            "R_hold": (refs.never, "", refs.R_hold),
        }
        for name, key in zip(_BOUNDED_SETS, keys, strict=True):
            f, a, h = sets[name]
            errors = engine.load(key, schema_json, json.dumps({"F": f, "A": a, "H": h}))
            if errors:
                log.warning("bounded check: %s doesn't load: %s", name, errors)
                return ProofReport(ok=False, method="bounded", cases=0, checks=[ProofCheck(name="lint", ok=False)])
        try:
            cases = bounded_cases(cards, profiles, json.loads(schema_json))
            failures = _evaluate(engine, dict(zip(_BOUNDED_SETS, keys, strict=True)), cases,
                                 set(money_uncovered(cards, profiles)))
        except Exception:
            log.exception("bounded check failed to run")
            return _prover_failure("bounded")
        checks = [ProofCheck(name=name, ok=name not in failures, counterexample_raw=failures.get(name))
                  for name in BOUNDED_CHECKS]
        return ProofReport(ok=all(c.ok for c in checks), method="bounded", cases=len(cases), checks=checks)
    finally:
        try:
            drop_keys(engine, keys)
        finally:
            with _in_use_lock:
                _in_use.discard(key_prefix)


def _auto_allows(verdict: Mapping[str, Any]) -> bool:
    """Did the auto evaluation (`B ∪ F ∪ A`) allow? An allow, or a hold decided by an `A.` permit
    (decision step 5 holds money no owner card covers): the proofs compare Cedar's answers, before
    step 5, so the bounded check does too."""
    return verdict["outcome"] == "allow" or (
        verdict["outcome"] == "hold" and any(policy_id.startswith("A.") for policy_id in verdict["policy_ids"]))


def _evaluate(engine: desk_kernel.PolicyEngine, keys: Mapping[str, str], cases: Sequence[dict],
              uncovered: set[str]) -> dict[str, dict]:
    """The first failing case of each check that fails, by check name."""
    failures: dict[str, dict] = {}

    def fail(name: str, case: dict) -> None:
        failures.setdefault(name, case)

    for case in cases:
        text = json.dumps(case)
        verdict = {name: json.loads(engine.decide(key, text, "final")) for name, key in keys.items()}
        if any(v["errors"] for v in verdict.values()):
            fail("never_errors", case)
        policy_allows = _auto_allows(verdict["policy"])
        if policy_allows and not _auto_allows(verdict["R"]):
            fail("auto_within_cards", case)
        if policy_allows and not _auto_allows(verdict["a0"]):
            fail("review_only_narrows", case)
        if verdict["approvable"]["outcome"] == "hold" and verdict["R_hold"]["outcome"] != "hold":
            fail("hold_within_cards", case)
        if policy_allows and case["action"] in uncovered:
            fail("money_needs_card", case)
    return failures


# ---- The cases ----------------------------------------------------------------------------------
#
# Per enabled tool: the principal kinds it applies to × unverified, verified and record-owner
# standings × no person, each person named in cards and one other × for agents, each agent key
# named in cards and one other, and on charge tools with and without mandate room; crossed with
# amounts, discounts, times and reviews, each only where an auto card on the tool limits it:
#
# - amounts {each limit and limit + 1, absent, 0, 50000, 50001, 1000000} (always on money tools);
# - discounts {each limit and limit + 1, absent, 10000} (every auto card has a discount limit);
# - times {each window's start, start - 1, end - 1, end, and its start on each day outside it};
# - reviews {the tool's thresholds and each ± 1, absent, (10000, 0), (0, 10000)}.
#
# Each list starts with a value inside the limits. Boundary values come first, in three passes,
# and the whole product follows:
#
# 1. boundaries: every principal with the first value of each list; then each auto card's own
#    boundaries, for the principals the card is for: inside all its limits, then one limit at a
#    time just past it (its amount and discount + 1, its window's edges and outside days, each
#    other review value);
# 2. every principal with each value of each list alone (the rest at their first);
# 3. every principal with every other combination, by the sum of the values' positions.
#
# Each pass runs for every tool before the next starts, the tools taking turns, so the cap cuts
# the least likely combinations first and never one tool's boundaries for another's. The result
# is deduplicated and capped at MAX_BOUNDED_CASES.

_ABSENT = None
_COPY = "case-copy"
_SESSION = "case-session"
_RESOURCE = "case-resource"
_OTHER_PERSON = "case-other-person"
_OTHER_AGENT = "case-other-agent"
_NO_HOURS = (1, 600)                                 # Tuesday 10:00, where no card has hours
_MANDATE_ROOM = 1_000_000
_STANDINGS = ("unverified", "verified", "record_owner")
_DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


class _Principal(NamedTuple):
    kind: str                                        # the Cedar principal type
    resource: str                                    # the Cedar resource type
    standing: str                                    # unverified, verified or record_owner
    person: str | None
    agent: str | None
    mandate: int | None


def bounded_cases(cards: Iterable[RuleCard], profiles: Iterable[ToolProfile], schema: Mapping[str, Any]) -> list[dict]:
    """The bounded check's requests (`request_json`s) for `cards` over the enabled `profiles`,
    deduplicated, boundary values first and capped at `MAX_BOUNDED_CASES`. A profile whose tool
    the schema doesn't declare gets none (its policies couldn't load)."""
    owned = [card for card in cards if not card.is_default]
    persons = _named([card.person_id for card in owned if card.who == "person"], _OTHER_PERSON)
    agents = _named([card.agent_key_id for card in owned if card.who == "agent"], _OTHER_AGENT)
    actions = schema.get("", {}).get("actions", {})
    passes = [_tool_passes(p, actions[p.tool], owned, persons, agents)
              for p in sorted(profiles, key=lambda p: p.tool) if "appliesTo" in actions.get(p.tool, {})]
    cases: list[dict] = []
    seen: set[str] = set()
    for streams in (list(tool_passes) for tool_passes in zip(*passes, strict=True)):   # a pass at a time, all tools
        while streams and len(cases) < MAX_BOUNDED_CASES:
            for stream in list(streams):
                case = next(stream, None)
                if case is None:
                    streams.remove(stream)
                    continue
                key = json.dumps(case, sort_keys=True)
                if key not in seen:
                    seen.add(key)
                    cases.append(case)
                    if len(cases) == MAX_BOUNDED_CASES:
                        return cases
    return cases


def _is_money(tool: str, effects: frozenset[str]) -> bool:
    return tool in MONEY_TOOLS or bool(effects & _MONEY_EFFECTS)


def _named(values: Iterable[str | None], other: str) -> list[str]:
    """The named values, sorted, then one more that is none of them (the last)."""
    named = sorted({value for value in values if value})
    while other in named:
        other += "-x"
    return [*named, other]


def _dedup(values: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for value in values:
        if value not in out:
            out.append(value)
    return out


def _tool_passes(profile: ToolProfile, action: Mapping[str, Any], owned: Sequence[RuleCard], persons: Sequence[str],
                 agents: Sequence[str]) -> tuple[Iterator[dict], Iterator[dict], Iterator[dict]]:
    """The tool's cases in the three passes: boundaries, each value alone, every combination."""
    tool, effects = profile.tool, frozenset(profile.effects)
    on_tool = [card for card in owned if card.applies_to == tool
               or (card.applies_to.startswith("effect:") and card.applies_to.removeprefix("effect:") in effects)]
    autos = [card for card in on_tool if card.mode == "auto"]
    dimensions = [_amounts(autos, money=_is_money(tool, effects)), _discounts(autos), _times(autos),
                  _reviews(autos, effects)]
    principals = [_Principal(kind, resource, standing, person, agent, mandate)
                  for kind in action["appliesTo"]["principalTypes"]
                  for resource in action["appliesTo"]["resourceTypes"]
                  for standing in _STANDINGS
                  for person in (_ABSENT, *persons)
                  for agent in (agents if kind == "Agent" else (_ABSENT,))
                  for mandate in ((_ABSENT, _MANDATE_ROOM) if kind == "Agent" and "charge" in effects else (_ABSENT,))]
    recipient = "verified_contact" if "send_message" in effects else _ABSENT

    def requests(values: tuple, who: Sequence[_Principal]) -> Iterator[dict]:
        amount, discount, (dow, minute), review = values
        for principal in who:
            yield _request(tool, principal, amount=amount, discount=discount, dow=dow, minute=minute, review=review,
                           recipient=recipient)

    def at(positions: tuple[int, ...]) -> tuple:
        return tuple(values[i] for values, i in zip(dimensions, positions, strict=True))

    def boundaries() -> Iterator[dict]:
        first = at(tuple(0 for _ in dimensions))
        yield from requests(first, principals)
        for card in autos:
            for values in _card_boundaries(card, first, dimensions):
                yield from requests(values, _for_card(card, principals, persons[-1], agents[-1]))

    def alone() -> Iterator[dict]:
        for positions in _alone([len(values) for values in dimensions]):
            yield from requests(at(positions), principals)

    def combined() -> Iterator[dict]:
        for positions in _combined([len(values) for values in dimensions]):
            yield from requests(at(positions), principals)

    return boundaries(), alone(), combined()


def _for_card(card: RuleCard, principals: Sequence[_Principal], other_person: str,
              other_agent: str) -> list[_Principal]:
    """The principals a card is for: those it names, or, for a card for a kind of principal, one
    of each kind and standing it takes (no person, or someone it doesn't name)."""
    def plain(p: _Principal) -> bool:
        return p.person in (_ABSENT, other_person) and p.agent in (_ABSENT, other_agent)

    match card.who:
        case "anyone":
            return [p for p in principals if plain(p)]
        case "verified":
            return [p for p in principals if plain(p) and p.standing != "unverified"]
        case "record_owner":
            return [p for p in principals if plain(p) and p.standing == "record_owner"]
        case "person":
            return [p for p in principals
                    if p.person == card.person_id and p.agent in (_ABSENT, other_agent) and p.standing != "unverified"]
        case "agent":
            return [p for p in principals
                    if p.kind == "Agent" and p.agent == card.agent_key_id and p.person in (_ABSENT, other_person)]
    return []


def _card_boundaries(card: RuleCard, first: tuple, dimensions: Sequence[list]) -> Iterator[tuple]:
    """Values inside all of `card`'s limits, then each of its limits just past (or on) its edge."""
    amount, discount, when, review = first
    if card.max_amount_cents is not None:
        amount = card.max_amount_cents
    discount = card.max_discount_bp
    window = _times([card]) if card.hours is not None else [when]
    when = window[0]
    inside = (amount, discount, when, review)
    yield inside
    if card.max_amount_cents is not None:
        yield (card.max_amount_cents + 1, discount, when, review)
    if card.max_discount_bp < 10_000:
        yield (amount, card.max_discount_bp + 1, when, review)
    for edge in window[1:]:
        yield (amount, discount, edge, review)
    if card.review:
        for other in dimensions[3][1:]:
            yield (amount, discount, when, other)


def _alone(sizes: Sequence[int]) -> Iterator[tuple[int, ...]]:
    """Positions into lists of `sizes` with one list past its first value, by position."""
    for position in range(1, max(sizes, default=1)):
        for dimension, size in enumerate(sizes):
            if position < size:
                yield tuple(position if d == dimension else 0 for d in range(len(sizes)))


def _combined(sizes: Sequence[int]) -> Iterator[tuple[int, ...]]:
    """Positions with two or more lists past their first value, by the sum of the positions.
    Lazy: the cap stops it long before the end of a large product."""
    for level in range(2, sum(size - 1 for size in sizes) + 1):
        for positions in _with_sum(level, sizes):
            if sum(1 for p in positions if p) >= 2:
                yield positions


def _with_sum(level: int, sizes: Sequence[int]) -> Iterator[tuple[int, ...]]:
    if not sizes:
        if level == 0:
            yield ()
        return
    rest = sum(size - 1 for size in sizes[1:])
    for position in range(max(0, level - rest), min(sizes[0] - 1, level) + 1):
        for tail in _with_sum(level - position, sizes[1:]):
            yield (position, *tail)


def _amounts(autos: Sequence[RuleCard], *, money: bool) -> list[int | None]:
    limits = sorted({card.max_amount_cents for card in autos if card.max_amount_cents is not None})
    if not (money or limits):
        return [_ABSENT]
    values = [*itertools.chain.from_iterable((limit, limit + 1) for limit in limits), _ABSENT, 0,
              AUTO_MONEY_HARD_CAP_CENTS, AUTO_MONEY_HARD_CAP_CENTS + 1, 1_000_000]
    return _dedup(v for v in values if v is _ABSENT or 0 <= v <= 1_000_000)


def _discounts(autos: Sequence[RuleCard]) -> list[int | None]:
    if not autos:
        return [_ABSENT]
    limits = sorted({card.max_discount_bp for card in autos})
    values = [*itertools.chain.from_iterable((limit, limit + 1) for limit in limits), _ABSENT, 10_000]
    return _dedup(v for v in values if v is _ABSENT or 0 <= v <= 10_000)


def _local(day: int, minute: int) -> tuple[int, int]:
    """A day and minute, carried into the day before or after when the minute falls outside it."""
    return ((day + minute // 1440) % 7, minute % 1440)


def _minute(value: time) -> int:
    return value.hour * 60 + value.minute


def _times(autos: Sequence[RuleCard]) -> list[tuple[int, int]]:
    windows = _dedup((tuple(card.hours.days), card.hours.start, card.hours.end) for card in autos if card.hours)
    if not windows:
        return [_NO_HOURS]
    values = []
    for days, start_time, end_time in windows:
        numbers = sorted({_DAYS[day] for day in days})
        start, end = _minute(start_time), _minute(end_time) or 1440        # an end of 00:00 is midnight
        values += [_local(numbers[0], start), _local(numbers[0], start - 1), _local(numbers[0], end - 1),
                   _local(numbers[0], end)]
        values += [(day, start) for day in range(7) if day not in numbers]
    return _dedup(values)


def _reviews(autos: Sequence[RuleCard], effects: frozenset[str]) -> list[tuple[int, int] | None]:
    if not any(card.review for card in autos):
        return [_ABSENT]
    row = review_thresholds.thresholds_for(sorted(effects))
    within, manipulation = row.min_within_charter_bp, row.max_manipulation_bp
    values = [(within, manipulation), (within - 1, manipulation), (within, manipulation + 1),
              (within + 1, manipulation), (within, manipulation - 1), _ABSENT, (10_000, 0), (0, 10_000)]
    return _dedup(v for v in values if v is _ABSENT or (0 <= v[0] <= 10_000 and 0 <= v[1] <= 10_000))


def _request(tool: str, principal: _Principal, *, amount: int | None, discount: int | None, dow: int, minute: int,
             review: tuple[int, int] | None, recipient: str | None) -> dict:
    principal_type, resource_type, standing, person, agent, mandate = principal
    verified = standing != "unverified"
    attrs: dict[str, Any] = {"verified": verified, "assurance": "demo_code" if verified else "none", "copy": _COPY}
    if person is not None:
        attrs["person_id"] = person
    if principal_type == "Agent":
        attrs["agent_key_id"] = agent
        if mandate is not None:
            attrs["mandate_remaining_cents"] = mandate
    context: dict[str, Any] = {"record_owner_match": standing == "record_owner", "local_dow": dow,
                               "local_minute": minute}
    if amount is not None:
        context["amount_cents"] = amount
    if discount is not None:
        context["discount_bp"] = discount
    if recipient is not None:
        context["recipient"] = recipient
    if review is not None:
        context["review"] = {"within_charter_bp": review[0], "manipulation_bp": review[1]}
    principal_uid = {"type": principal_type, "id": _SESSION}
    resource_uid = {"type": resource_type, "id": _RESOURCE}
    return {"principal": principal_uid, "action": tool, "resource": resource_uid, "context": context,
            "entities": [{"uid": principal_uid, "attrs": attrs, "parents": []},
                         {"uid": resource_uid, "attrs": {"copy": _COPY}, "parents": []}]}
