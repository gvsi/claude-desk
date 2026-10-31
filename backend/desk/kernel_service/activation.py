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

Money caps (master plan, "Money cap"). Every version carries the money cap it is compiled and
proved at (`auto_money_cap_cents`): the most an auto rule takes or pays out in one action without
asking. The Desk's cap is its active version's (`version_cap`), so a cap changes only when the
owner confirms a draft at another cap; a draft without one keeps the active version's. The cap is
part of what a proof covers (`invariants_sha256` renders the auto invariants at it), so a version
is proved at its own cap and a report proved at another is never reused.

Versions an earlier kernel stored. A version proved under another baseline than the one this
kernel enforces (`outdated`) never loads and decides nothing. The kernel rebuilds each such active
version in place: its own cards at its own cap, checked, compiled and loaded as a draft is, and
written only with a proof of all seven obligations, from the cache (a shipped report) in either
mode or proved live in `symcc` mode. One it can't rebuild stays as stored, refusing every call
(`version_outdated`), and each attempt is ledgered and alerts the owner. First, every Desk is given
the native tools the kernel registers that it has no row for (one created before they were), so a
version is rebuilt over the tools a Desk made now has, and a seed's from its shipped report. Before
serving, startup does this from cached reports only, finding the Desks one copy at a time, within
`STARTUP_REBUILD_S` finding included (`rebuild_at_startup`); the copies and Desks it leaves, and
every version that needs a live proof, are found and rebuilt one at a time in the background while
the kernel serves (`rebuild_in_background`), and refuse until then. The owner of each version
left waiting is told so before the background starts rebuilding, at most once an hour.

Loaded versions. A stored version loads into the policy engine on its first use
(`LoadedVersions`), bounded to `MAX_LOADED_VERSIONS` per engine, least recently used out first,
and again when it was written anew under its number.

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
from collections.abc import Awaitable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from datetime import datetime, time, timedelta
from pathlib import Path
from time import monotonic
from typing import Any, Literal, NamedTuple, TypeVar

import desk_kernel
from pydantic import BaseModel, ConfigDict, StrictInt, ValidationError
from sqlalchemy import func, select

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    LedgerEvent,
    PolicyVersion,
    ProofCheck,
    ProofReport,
    RuleCard,
    ToolProfile,
    money_tool,
)
from desk.db.models import AgentKey, Person
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_service import (adapters, compiler, demo_inbox, desks, explain, ledger, reference, render,
                                 review_thresholds, seed)
from desk.kernel_service.auth import OwnerCtx
from desk.kernel_service.reference import RefSets
from desk.kernel_service.repo import (KernelCtx, KernelFailure, KernelRuntime, copy_ids, desks_to_bring_up,
                                     kernel_transaction, log_error)
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
                       schema: Mapping[str, Any], *, auto_money_cap_cents: int) -> ProofInputs:
    """The proof inputs for `cards` over the enabled `profiles` at a version's money cap: the
    compiler's `F`, `A`, `H` and `A0` (its own emission without review gates) and the invariants,
    all at that cap, and the reference generator's sets, each preceded by its never forbids
    (`R = never + R`, `R_hold = never + R_hold`), as the bounded check loads them. Raises
    ValueError for cards either generator can't express."""
    compiled = compiler.compile_cards(cards, profiles, auto_money_cap_cents=auto_money_cap_cents)
    a0 = compiler.compile_cards(cards, profiles, auto_money_cap_cents=auto_money_cap_cents, review=False).A
    refs = reference.reference_sets(cards, schema)
    invariants = compiler.invariants(auto_money_cap_cents)
    return ProofInputs(
        schema_json=json.dumps(schema),
        sets={"B": compiler.BASELINE, "F": compiled.F, "A": compiled.A, "A0": a0, "H": compiled.H,
              "R": refs.never + "\n" + refs.R, "R_hold": refs.never + "\n" + refs.R_hold},
        always=list(invariants["always"].values()),
        auto=list(invariants["auto"].values()),
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
                         *, key_prefix: str, auto_money_cap_cents: int) -> ProofReport:
    """What the process's proof mode can say about `cards` over the enabled `profiles` at a
    version's money cap: in `symcc` mode a `desk-prove` proof (`prove`), in `bounded` mode the
    bounded check (in a thread, under `bounded:<key_prefix>` keys, so pass a prefix unique to the
    draft). Cards the compiler or the reference generator can't express fail as a `prover` check:
    nothing is ever a pass by error. Only a `symcc` report that holds may activate anything."""
    mode = proof_mode()
    cap = auto_money_cap_cents
    try:
        schema = compiler.desk_schema(profiles)
        if mode == "symcc":
            inputs = build_proof_inputs(cards, profiles, schema, auto_money_cap_cents=cap)
        else:
            compiled = compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap)
            a0 = compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap, review=False).A
            refs = reference.reference_sets(cards, schema)
    except Exception:
        log.warning("rules_uncompilable", exc_info=True)
        return _prover_failure(mode)
    if mode == "symcc":
        return await prove(inputs)
    return await asyncio.to_thread(bounded_check, engine, key_prefix=key_prefix, schema_json=json.dumps(schema),
                                   compiled=compiled, a0=a0, refs=refs, cards=cards, profiles=profiles,
                                   auto_money_cap_cents=cap)


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
    invariants (`invariants_sha256`: rendered at the version's money cap, with the prover's
    version, so versions at different caps never share a report), and three things that come
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
    them again from the profiles, and each adds the always-on cards a set lacks from the cards
    alone), sorted by `card_id`."""
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
                   *, cards: Iterable[RuleCard], auto_money_cap_cents: int) -> VersionHashes:
    """The hashes of `compiled`, the set compiled from `cards` over the enabled `profiles` at the
    money cap `auto_money_cap_cents`. Pass the owner's cards as given to the compiler and the
    reference generator, not `compiled.cards`."""
    return VersionHashes(
        cedar_sha256=compiler.cedar_sha256(compiled),
        cards_sha256=cards_sha256(cards),
        schema_sha256=compiler.schema_sha256(dict(schema)),
        baseline_sha256=compiler.baseline_sha256(),
        profiles_sha256=profiles_sha256(profiles),
        invariants_sha256=compiler.invariants_sha256(PROOF_CHECKS, auto_money_cap_cents),
        review_thresholds_version=review_thresholds.REVIEW_THRESHOLDS_VERSION,
    )


# ---- Shipped rule sets ---------------------------------------------------------------------------
#
# The Rivera seed's cards and the starter presets are proved in CI (`make proofs` writes a report
# per set into PROOFS_DIR, `make check-presets` re-proves and compares them). Their card IDs are
# fixed and their scopes never name a person, so they compile to the same hashes in every copy.
# Each is proved at one money cap (`SHIPPED_CAPS`): the seed at its $500, the presets at 0, which
# is every new Desk's first cap. A preset drafted at another cap misses the shipped report and
# proves live like any draft.

PROOFS_DIR = compiler.CEDAR_DIR / "proofs"
SHIPPED_PRESETS: dict[str, list[RuleCard]] = {
    "rivera": seed.RIVERA_CARDS,
    "ask_first": PRESETS["ask_first"],
    "auto": PRESETS["auto"],
}
SHIPPED_CAPS: dict[str, int] = {
    "rivera": seed.RIVERA_MONEY_CAP_CENTS,
    "ask_first": 0,
    "auto": 0,
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
    both loaded. The Cedar and schema must still match the hashes they were proved under, and the
    baseline it was proved under must be the one the engine enforces (`outdated`). On any error
    neither key stays loaded, so deciding on the version refuses."""
    key = version_key(row.desk_id, row.version)
    keys = [key, key + ":approvable"]
    cedar = row.cedar or {}
    if row.schema_json is None or any(not isinstance(cedar.get(name), str) for name in ("F", "A", "H")):
        errors = ["the version has no compiled Cedar or schema"]
    elif outdated(row):
        errors = ["the version was proved under another baseline"]
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
    (read at each use). Only this class loads or drops `<desk_id>:<version>` keys. Each key
    remembers the Cedar and schema hashes it was loaded with, so a version written again under its
    number (a rebuild, `rebuild_version`) loads again on its next use."""

    def __init__(self, engine: desk_kernel.PolicyEngine):
        self.engine = engine
        self._recent: OrderedDict[str, tuple[str, str]] = OrderedDict()
        self._lock = threading.Lock()

    def use(self, row: PolicyVersionRow) -> list[str]:
        """Makes sure `row` is loaded and marks it most recent; returns the load errors (empty
        means its keys decide). Loading past the cap drops the least recently used version."""
        key = version_key(row.desk_id, row.version)
        loaded = (row.cedar_sha256, row.schema_sha256)
        with self._lock:
            if self._recent.get(key) == loaded:
                self._recent.move_to_end(key)
                return []
            errors = load_version(self.engine, row)       # replaces what the keys held, or drops them
            if errors:
                self._recent.pop(key, None)
                return errors
            self._recent[key] = loaded
            self._recent.move_to_end(key)
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
                auto_money_cap_cents: int, status: str, proof: ProofReport | None, created_at: datetime,
                preset: str | None = None, draft_key_sha256: str | None = None) -> PolicyVersionRow:
    """A `policy_versions` row for a compiled version: its cards with defaults, its Cedar (`F`,
    `A`, `H` and `A0`), its schema as loaded, the money cap it was compiled at and the hashes its
    proof covers (`cards_sha256` among them, from `version_hashes` at that cap); an owner's draft
    also carries its `draft_key_sha256`."""
    return PolicyVersionRow(
        desk_id=desk_id, version=version, copy_id=copy_id, parent_version=parent_version, cards=compiled.cards,
        status=status, proof=proof, **hashes._asdict(), auto_money_cap_cents=auto_money_cap_cents,
        created_at=created_at, cedar={**compiled.sets(), "A0": a0}, schema_json=json.dumps(schema), preset=preset,
        draft_key_sha256=draft_key_sha256)


def version_contract(row: PolicyVersionRow) -> PolicyVersion:
    return PolicyVersion(desk_id=row.desk_id, version=row.version, parent_version=row.parent_version,
                         cards=row.cards, cedar_sha256=row.cedar_sha256, schema_sha256=row.schema_sha256,
                         baseline_sha256=row.baseline_sha256, profiles_sha256=row.profiles_sha256,
                         invariants_sha256=row.invariants_sha256,
                         review_thresholds_version=row.review_thresholds_version,
                         auto_money_cap_cents=row.auto_money_cap_cents, status=row.status, proof=row.proof)


def version_cap(row: PolicyVersionRow | None) -> int:
    """The money cap a version is evaluated at, `min(its cap, AUTO_MONEY_HARD_CAP_CENTS)`: what the
    request builder sets as `context.auto_money_cap_cents` for every evaluation of that version.
    0 for no version, or a cap that isn't a whole number of cents from 0, so nothing moves money."""
    if row is None:
        return 0
    try:
        return compiler.capped(row.auto_money_cap_cents)
    except ValueError:
        log.error("version_cap_unreadable desk_id=%s version=%s", row.desk_id, row.version)
        return 0


async def activate_shipped(ctx: KernelCtx, desk_id: str, preset: str, auto_money_cap_cents: int) -> PolicyVersion:
    """Makes a shipped rule set (`SHIPPED_PRESETS`) version 1 of a new Desk at the money cap
    `auto_money_cap_cents` (its `DeskSeed`'s), `active`, in the caller's transaction, ledgered
    `policy` `{version, status: "active", preset, activated: true, from: null,
    auto_money_cap_cents}`, so it reads like a confirm's. The set is compiled over the Desk's
    enabled profiles at that cap and activates only on a cache hit with a passing SymCC report, in
    either proof mode; nothing is proved here, so only the cap the set was proved at in CI
    (`SHIPPED_CAPS`) hits. A miss raises `SeedUnproved` (503, so the caller's transaction and
    everything in it roll back), lists the preset in `Health.unproved_seeds` and logs
    `seed_unproved` with the hashes, since there may be no Desk left to ledger on."""
    cards = SHIPPED_PRESETS[preset]
    cap = auto_money_cap_cents
    profiles = await desks.enabled_profiles(ctx, desk_id)
    schema = compiler.desk_schema(profiles)
    compiled = compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap)
    hashes = version_hashes(compiled, schema, profiles, cards=cards, auto_money_cap_cents=cap)
    report = ctx.policies.cache.get(hashes)
    if report is None or not proved(report):
        ctx.policies.unproved_seeds.add(preset)
        log.error("seed_unproved preset=%s %s", preset,
                  " ".join(f"{field}={value}" for field, value in hashes._asdict().items()))
        raise SeedUnproved(preset)
    row = version_row(copy_id=ctx.copy_id, desk_id=desk_id, version=1, parent_version=None, compiled=compiled,
                      a0=compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap, review=False).A,
                      schema=schema, hashes=hashes, auto_money_cap_cents=cap, status="active", proof=report,
                      created_at=ctx.clock.now(), preset=preset)
    ctx.db.add(row)
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel", summary={"version": 1, "status": "active", "preset": preset,
                                                 "activated": True, "from": None, "auto_money_cap_cents": cap}))
    return version_contract(row)


async def active_version(ctx: KernelCtx, desk_id: str) -> PolicyVersionRow | None:
    """The Desk's active version, if it has one (the caller's copy must be bound)."""
    return (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.status == "active")))).one_or_none()


# ---- Versions an earlier kernel stored -----------------------------------------------------------
#
# A version is proved against the baseline the kernel enforces with it (`baseline_auto` and
# `baseline_approvable` read `B`), so one stored by an earlier kernel, under another baseline, isn't
# proved for this one, and may not even load: the kernel core's versions have a schema without
# `context.auto_money_cap_cents`, which this baseline reads, so strict validation refuses the whole
# version. The kernel rebuilds each active version stored under another baseline: from its own
# cards, at the money cap it keeps (the money cap revision gave the kernel core's versions their
# $500), over the Desk's enabled profiles, checked as a draft is, compiled, and written in place of
# the stored one only with a proof of all seven obligations. The version keeps its number, status
# and cap, so nothing the owner chose changes. Before that, each Desk without a native tool the
# kernel registers is given it (`desks.add_native_tools`), so the profiles a version is rebuilt
# over are those a Desk made now has. Startup does what it can from cached reports within its
# budget, finding the Desks included, before the kernel serves (`rebuild_at_startup`); the rest,
# finding and live proofs included, goes on in the background (`rebuild_in_background`), and a
# version not yet rebuilt refuses meanwhile, its owner told so (`WAITING_ALERT`).

# What a rebuild rewrites: the compiled sets, what they were proved against and the proof.
_REBUILT_COLUMNS = ("cards", "cedar", "schema_json", *VersionHashes._fields, "proof")
# How long startup starts finding and bringing Desks up to date before the kernel serves
# (`rebuild_at_startup`). It proves nothing live, so it ends within this and one copy's lookup or
# one Desk's compile: with the selftest's 30 s backstop, inside the kernel container's 60 s health
# check start period.
STARTUP_REBUILD_S = 15.0
# A rebuild startup leaves to the background, since only a live proof would answer it.
NEEDS_PROOF = "needs_proof"
FAILED = "failed"                  # `_bring_up` hit an error: the Desk is tried again, as a failed lookup is
# The owner's alert when a version can't be rebuilt (owner-only, in English, like every alert).
REBUILD_ALERT = ("After an update, Claude couldn't check your rules again, so it won't act on any request until "
                 "they're checked. Confirm your rules again to turn them back on.")
# The owner's alert while a version waits for the background rebuild, under the same preview. Its
# own words, since `REBUILD_ALERT`'s would say the check failed and ask for a confirm it doesn't
# need; at most once an hour per Desk, so a kernel that restarts often doesn't repeat it each time.
WAITING_ALERT = ("After an update, Claude is checking your rules again, so it won't act on any request until "
                 "they're checked. You don't need to do anything.")
WAITING_ALERT_EVERY = timedelta(hours=1)


def outdated(row: PolicyVersionRow) -> bool:
    """Was the version stored under a baseline other than the one this kernel enforces?"""
    return row.baseline_sha256 != compiler.baseline_sha256()


Rebuilt = dict[tuple[str, int], str | None]   # (desk_id, version): None when rebuilt, else why not


@dataclass(frozen=True)
class StartupRebuild:
    """What startup did before the kernel served (`rebuild_at_startup`), and what it left for
    `rebuild_in_background`."""

    results: Rebuilt                   # each outdated version it rebuilt, or refused to
    left: list[tuple[str, str]]        # the Desks, `(copy_id, desk_id)`, it found and didn't bring up
    unscanned: list[str] | None = field(default_factory=list)   # the copies it didn't look at, in order; None
                                       # when it couldn't list them, so the background lists them too

    @property
    def pending(self) -> bool:
        """Whether it left anything for `rebuild_in_background`."""
        return bool(self.left) or self.unscanned is None or bool(self.unscanned)


async def rebuild_at_startup(runtime: KernelRuntime) -> StartupRebuild:
    """Brings the Desks that need it up to date before the kernel serves: each Desk without a
    native tool the kernel registers, and each whose active version an earlier kernel stored under
    another baseline (`_bring_up`). It looks at the copies one at a time, in ID order, finding a
    copy's Desks (`repo.desks_to_bring_up`) and bringing them up, in ID order, and it starts a copy
    or a Desk only within `STARTUP_REBUILD_S` of its own start, finding included. It rebuilds a
    version only from a cached report, leaving one that needs a live proof (`NEEDS_PROOF`), so the
    kernel serves within the budget and one copy's lookup or one Desk's compile, however many
    copies and Desks there are; a copy's lookup gets only what is left of the budget and is cut off
    when it runs out. What it doesn't reach is left, in order, for `rebuild_in_background`: the
    Desks it found and the copies it didn't look at, and one whose lookup failed or was cut off; when
    listing the copies fails or runs past the budget, it leaves all of it (`unscanned=None`). Until then a version left as stored refuses every call (`version_outdated`)."""
    started = monotonic()

    def spent() -> bool:
        return monotonic() - started >= STARTUP_REBUILD_S

    results: Rebuilt = {}
    left: list[tuple[str, str]] = []
    unscanned: list[str] = []
    try:                                      # listing the copies counts against the budget too
        copies = await asyncio.wait_for(copy_ids(runtime), STARTUP_REBUILD_S)
    except TimeoutError:
        log.info("rebuild_copies_cut_off")
        return StartupRebuild(results={}, left=[], unscanned=None)
    except Exception as exc:
        log_error(log, exc, "rebuild_copies_failed")
        return StartupRebuild(results={}, left=[], unscanned=None)
    for n, copy_id in enumerate(copies):
        if spent():
            unscanned += copies[n:]
            break
        try:                                  # the lookup gets only what is left of the budget
            desk_ids = await asyncio.wait_for(_desks_of(runtime, copy_id),
                                              STARTUP_REBUILD_S - (monotonic() - started))
        except TimeoutError:
            log.info("rebuild_lookup_cut_off copy_id=%s", copy_id)
            unscanned += copies[n:]           # the budget is spent: the background looks at the rest
            break
        if desk_ids is None:                  # its lookup failed: the background looks again
            unscanned.append(copy_id)
            continue
        for desk_id in desk_ids:
            if spent():
                left.append((copy_id, desk_id))
                continue
            done = await _bring_up(runtime, copy_id, desk_id, prove=False)
            if done == FAILED or (done is not None and done[1] == NEEDS_PROOF):
                left.append((copy_id, desk_id))
            elif done is not None:
                results[(desk_id, done[0])] = done[1]
    if left or unscanned:
        log.info("startup_rebuild_left desks=%s copies=%s", len(left), len(unscanned))
    return StartupRebuild(results=results, left=left, unscanned=unscanned)


T = TypeVar("T")
RETRY_WAITS_S = (5.0, 30.0, 60.0)    # a failed lookup's wait before the next; the last one repeats
BACKGROUND_LOOKUP_S = 10.0           # the background's limit on one listing or one copy's lookup


async def wait_to_retry(seconds: float) -> None:
    """The background rebuild's wait before it looks again at copies whose lookup failed."""
    await asyncio.sleep(seconds)


async def rebuild_in_background(runtime: KernelRuntime, startup: StartupRebuild) -> Rebuilt:
    """Finishes what startup left (`StartupRebuild`) while the kernel serves. Each pass lists the
    copies if startup couldn't, finds the Desks of the copies it is to look at, tells the owner of
    each Desk whose version waits that it refuses until it is checked (`_alert_waiting`), then
    brings them up one at a time, proving live in `symcc` mode. A copy whose lookup fails, or a
    listing that fails, doesn't hold the others up: after the pass it waits (`RETRY_WAITS_S`,
    longer each time) and looks at only those again, until none are left or it is cancelled, so no
    copy is lost until the next start; each listing or lookup is cut off at `BACKGROUND_LOOKUP_S`
    and retried the same way, so a blocked query holds up no other copy. The owners of the Desks
    startup found are told before anything else, and every owner found in a pass before that
    pass's first rebuild starts. As at startup, a version it can't rebuild is ledgered and alerts the owner, and
    one it hasn't reached yet keeps refusing. The app cancels it at shutdown: the Desk in hand rolls
    back, its prover is killed, and the next start takes it up again."""
    results: Rebuilt = {}
    work: list[tuple[str, str]] = list(startup.left)
    for copy_id, desk_id in work:             # the Desks startup found: their owners are told first
        await _alert_waiting(runtime, copy_id, desk_id)
    pending: list[str] | None = startup.unscanned
    attempt = 0
    while True:
        if pending is None:                   # the copies weren't listed yet
            pending = await _copies(runtime)
        failed: list[str] | None = None if pending is None else []
        found: list[tuple[str, str]] = []
        for copy_id in pending or []:
            desk_ids = await _bounded(_desks_of(runtime, copy_id), "rebuild_lookup_cut_off copy_id=" + copy_id)
            if desk_ids is None:
                failed.append(copy_id)
            else:
                found += [(copy_id, desk_id) for desk_id in desk_ids]
        for copy_id, desk_id in found:
            await _alert_waiting(runtime, copy_id, desk_id)
        work += found
        again: list[tuple[str, str]] = []
        for copy_id, desk_id in work:
            done = await _bring_up(runtime, copy_id, desk_id, prove=True)
            if done == FAILED:
                again.append((copy_id, desk_id))
            elif done is not None:
                results[(desk_id, done[0])] = done[1]
        if failed == [] and not again:
            break
        attempt += 1
        log.info("rebuild_retry attempt=%s copies=%s desks=%s", attempt,
                 "unlisted" if failed is None else len(failed), len(again))
        await wait_to_retry(RETRY_WAITS_S[min(attempt, len(RETRY_WAITS_S)) - 1])
        pending, work = failed, again
    log.info("background_rebuild_done desks=%s", len(results))
    return results


async def _copies(runtime: KernelRuntime) -> list[str] | None:
    """Every copy's ID (`repo.copy_ids`), or None when listing them failed or outlasted
    `BACKGROUND_LOOKUP_S`, which is logged."""
    try:
        return await _bounded(copy_ids(runtime), "rebuild_copies_cut_off")
    except Exception as exc:
        log_error(log, exc, "rebuild_copies_failed")
        return None


async def _bounded(lookup: Awaitable[T], cut_off: str) -> T | None:
    """The background's lookup, or None when it outlasts `BACKGROUND_LOOKUP_S` (logged as `cut_off`),
    so one blocked query holds up no other copy and is looked at again after a wait."""
    try:
        return await asyncio.wait_for(lookup, BACKGROUND_LOOKUP_S)
    except TimeoutError:
        log.info(cut_off)
        return None


async def _desks_of(runtime: KernelRuntime, copy_id: str) -> list[str] | None:
    """The copy's Desks to bring up (`repo.desks_to_bring_up`), or None when the lookup failed,
    which is logged; a Desk it would have found keeps refusing until a later pass finds it."""
    native = [profile.tool for profile in adapters.registered_profiles(source="native")]
    try:
        return await desks_to_bring_up(runtime, copy_id, native, compiler.baseline_sha256())
    except Exception as exc:
        log_error(log, exc, "rebuild_lookup_failed copy_id=%s", copy_id)
        return None


async def _alert_waiting(runtime: KernelRuntime, copy_id: str, desk_id: str) -> None:
    """Tells the owner, in the Demo inbox whatever their notification defaults, that the Desk's
    active version, stored by an earlier kernel and left to the background rebuild, refuses every
    call until it is checked (`WAITING_ALERT`), unless it did within `WAITING_ALERT_EVERY`. Nothing
    is written for a Desk whose version is current, which refuses nothing meanwhile. In a
    transaction of its own, which first takes the Desk's `waiting-alert` advisory lock, so two
    kernels starting at once check and write one after the other and the owner is told once; a
    failure is logged, and the version refuses all the same."""
    try:
        async with kernel_transaction(runtime) as ctx:
            ctx.bind(copy_id)
            await _lock(ctx, "waiting-alert", desk_id)
            row = await active_version(ctx, desk_id)
            if row is None or not outdated(row):
                return
            preview, now = render.owner_preview("rules"), ctx.clock.now()
            recent = await ctx.db.scalars(ctx.repo.scoped(select(DemoInboxRow.entry_id).where(
                DemoInboxRow.desk_id == desk_id, DemoInboxRow.to == "owner", DemoInboxRow.kind == "alert",
                DemoInboxRow.preview == preview, DemoInboxRow.body == WAITING_ALERT,
                DemoInboxRow.created_at > now - WAITING_ALERT_EVERY).limit(1)))
            if recent.first() is not None:
                return
            await demo_inbox.deliver(ctx, copy_id=copy_id, desk_id=desk_id, to="owner", person_id=None,
                                     kind="alert", body=WAITING_ALERT, preview=preview)
    except Exception as exc:
        log_error(log, exc, "rebuild_alert_failed copy_id=%s desk_id=%s", copy_id, desk_id)


async def _bring_up(runtime: KernelRuntime, copy_id: str, desk_id: str, *,
                    prove: bool) -> tuple[int, str | None] | str | None:
    """Gives the Desk the native tools it has no row for (`desks.add_native_tools`), then rebuilds
    its active version if it is outdated (`rebuild_version`, proving live only when `prove`), each
    in a transaction of its own. Returns the outdated version and what became of it, None when the
    Desk's version is current, or `FAILED` when either step raised: that is logged, the Desk is left
    as it was (without a tool, it can't be called on it; with a version left as stored, it decides
    nothing), and its callers try it again. A Desk that couldn't be given its tools isn't rebuilt
    over the old ones."""
    try:
        async with kernel_transaction(runtime) as ctx:
            ctx.bind(copy_id)
            await desks.add_native_tools(ctx, desk_id)
    except Exception as exc:
        log_error(log, exc, "native_tools_failed copy_id=%s desk_id=%s", copy_id, desk_id)
        return FAILED
    version = None
    try:
        async with kernel_transaction(runtime) as ctx:
            ctx.bind(copy_id)
            row = await active_version(ctx, desk_id)
            if row is None or not outdated(row):
                return None
            version = row.version
            done = version, await rebuild_version(ctx, desk_id, version, prove=prove)
        return done
    except Exception as exc:
        log_error(log, exc, "version_rebuild_failed copy_id=%s desk_id=%s version=%s", copy_id, desk_id, version)
        return FAILED


async def rebuild_version(ctx: KernelCtx, desk_id: str, version: int, *, prove: bool = True) -> str | None:
    """Rebuilds the Desk's active version `version`, stored under another baseline, in the
    caller's transaction, under the Desk's `versions` lock with the row `FOR UPDATE`, as a confirm
    takes them. Returns None when it is rebuilt, or when it is no longer active or outdated;
    otherwise why it can't be. A rebuilt version is ledgered `policy` `{version, status: "active",
    rebuilt: true, auto_money_cap_cents, cedar_sha256, from_cedar_sha256}`. One that can't be is
    left as stored, so it keeps refusing; the attempt is ledgered `policy` `{version, rebuilt:
    false, refused: <why>}` and alerts the owner in the Demo inbox whatever their notification
    defaults, since the Desk acts on nothing until it is fixed. Without `prove`, a version only a
    live proof would answer in `symcc` mode is `NEEDS_PROOF`, with nothing written."""
    await _lock(ctx, "versions", desk_id)
    row = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.version == version,
        PolicyVersionRow.status == "active").with_for_update()))).one_or_none()
    if row is None or not outdated(row):
        return None
    rebuilt = await _rebuilt(ctx, row, prove=prove)
    if rebuilt == NEEDS_PROOF:            # nothing written: the background proves it
        return NEEDS_PROOF
    if isinstance(rebuilt, str):
        log.warning("version_not_rebuilt desk_id=%s version=%s reason=%s", desk_id, version, rebuilt)
        await demo_inbox.deliver(ctx, copy_id=ctx.copy_id, desk_id=desk_id, to="owner", person_id=None, kind="alert",
                                 body=REBUILD_ALERT, preview=render.owner_preview("rules"))
        await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id, event=LedgerEvent(
            kind="policy", origin="kernel", summary={"version": version, "rebuilt": False, "refused": rebuilt}))
        return rebuilt
    stored = row.cedar_sha256
    for column in _REBUILT_COLUMNS:
        setattr(row, column, getattr(rebuilt, column))
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel",
        summary={"version": version, "status": "active", "rebuilt": True,
                 "auto_money_cap_cents": row.auto_money_cap_cents, "cedar_sha256": row.cedar_sha256,
                 "from_cedar_sha256": stored}))
    return None


async def _rebuilt(ctx: KernelCtx, row: PolicyVersionRow, *, prove: bool) -> PolicyVersionRow | str:
    """`row` compiled again as a draft of its own cards would be, at its own cap, over the Desk's
    enabled profiles, with a proof of all seven obligations; or why it can't be (`NEEDS_PROOF`
    when only a live proof would answer and `prove` is false)."""
    desk_id, cap = row.desk_id, row.auto_money_cap_cents
    if type(cap) is not int or not 0 <= cap <= AUTO_MONEY_HARD_CAP_CENTS:
        return "invalid_money_cap"
    owned = [card for card in row.cards if not card.is_default]
    people = await desk_people(ctx, desk_id)
    if compiler.validate_cards(owned, people=people.keys(), agent_keys=await _agent_keys(ctx),
                               auto_money_cap_cents=cap):
        return compiler.ABOVE_MONEY_CAP if compiler.above_money_cap(owned, cap) else "invalid_cards"
    profiles = await desks.enabled_profiles(ctx, desk_id)
    try:
        schema = compiler.desk_schema(profiles)
        compiled = compiler.compile_cards(owned, profiles, auto_money_cap_cents=cap)
        a0 = compiler.compile_cards(owned, profiles, auto_money_cap_cents=cap, review=False).A
        hashes = version_hashes(compiled, schema, profiles, cards=owned, auto_money_cap_cents=cap)
    except ValueError:
        return "uncompilable_cards"
    if load_draft(ctx.policies.engine, key=f"rebuild:{desk_id}:{row.version}", schema_json=json.dumps(schema),
                  compiled=compiled):
        return "unloadable"
    report = ctx.policies.cache.get(hashes)               # a shipped report, or one this process proved
    if report is None and proof_mode() == "symcc":
        if not prove:
            return NEEDS_PROOF
        report = await prove_or_check(ctx.policies.engine, owned, profiles, key_prefix=f"rebuild:{desk_id}",
                                      auto_money_cap_cents=cap)
        ctx.policies.cache.put(hashes, report)
    if report is None or not proved(report):
        return "not_proved"
    return version_row(copy_id=row.copy_id, desk_id=desk_id, version=row.version, parent_version=row.parent_version,
                       compiled=compiled, a0=a0, schema=schema, hashes=hashes, auto_money_cap_cents=cap,
                       status=row.status, proof=report, created_at=row.created_at, preset=row.preset,
                       draft_key_sha256=row.draft_key_sha256)


# ---- Owner drafts --------------------------------------------------------------------------------
#
# `POST /policy/draft` turns the owner's cards into a stored version that can't decide anything
# yet: compiled, loaded (lint and validation), then proved in `symcc` mode (a cached report for
# the same cards and hashes stands in for a run) or checked in `bounded` mode, which never
# activates. It is idempotent on a key over the parent and everything the proof covers, so a
# re-post (the API's poll after its 25 s answer) waits for the running proof and gets its version.

class Hashes(NamedTuple):
    """What a version is proved against besides its own cards and Cedar: the Desk's schema, the
    baseline, the enabled profiles, the invariants (rendered at the version's money cap, with the
    check list and the prover's version) and the review thresholds' version. Confirm needs a
    version's to be the current ones at its cap."""

    schema_sha256: str
    baseline_sha256: str
    profiles_sha256: str
    invariants_sha256: str
    review_thresholds_version: int


def _hashes(profiles: Sequence[ToolProfile], schema: Mapping[str, Any], auto_money_cap_cents: int) -> Hashes:
    return Hashes(schema_sha256=compiler.schema_sha256(dict(schema)), baseline_sha256=compiler.baseline_sha256(),
                  profiles_sha256=profiles_sha256(profiles),
                  invariants_sha256=compiler.invariants_sha256(PROOF_CHECKS, auto_money_cap_cents),
                  review_thresholds_version=review_thresholds.REVIEW_THRESHOLDS_VERSION)


async def current_hashes(ctx: KernelCtx, desk_id: str, auto_money_cap_cents: int) -> Hashes:
    """The hashes a version of the Desk at the money cap `auto_money_cap_cents` would be proved
    against now, from its enabled profiles and the invariants rendered at that cap."""
    profiles = await desks.enabled_profiles(ctx, desk_id)
    return _hashes(profiles, compiler.desk_schema(profiles), auto_money_cap_cents)


def draft_key_sha256(parent_version: int | None, cards: Iterable[RuleCard], hashes: Hashes) -> str:
    """sha256 of `canonical_json({parent_version, cards_sha256, schema_sha256, baseline_sha256,
    profiles_sha256, invariants_sha256, review_thresholds_version})`: the same cards on the same
    parent, proved against the same things, are the same draft. `invariants_sha256` renders the
    invariants at the draft's money cap, so the same cards at another cap are another draft."""
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
                       hashes: VersionHashes, auto_money_cap_cents: int) -> ProofReport:
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
    report = await prove_or_check(ctx.policies.engine, cards, profiles, key_prefix=key,
                                  auto_money_cap_cents=auto_money_cap_cents)
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
                expected_parent: int | None, auto_money_cap_cents: int | None = None) -> PolicyVersion:
    """The owner's `cards` as a new version of the Desk at the money cap `auto_money_cap_cents`
    (None takes the parent's, the active version's), proved or checked, in the caller's
    transaction (`POST /policy/draft`), ledgered `policy` `{version, status, method}`.

    In order: a parent that isn't the active version is 409 `conflict`; cards `validate_cards`
    refuses at the draft's cap (an auto money card above it among them) are 422 `invalid`, with
    nothing written either way; then the cards are compiled and proved at that cap, and the
    version stores it. A draft writes nothing else: the active version and its cap stay in force
    until the owner confirms. Default asks are dropped and derived again, and the always-on cards
    the owner's cards lack are added (`compiler.with_defaults`), so the version lists them and a
    start of verification never asks. A draft with the same key (the parent, the cards and the
    hashes they are proved against, the cap among them) is returned as it is, unless its report
    answered nothing (`_proves_again`): then it is proved again in place. The key's advisory lock
    is held until commit, so a re-post waits for the running proof; the version number is
    allocated under the Desk's lock just before the insert. Every failing check of the report
    reads in the owner's words."""
    owned = [card for card in cards if not card.is_default]
    active = await active_version(ctx, desk_id)
    if (active.version if active is not None else None) != expected_parent:
        raise KernelFailure(409, "conflict", "parent_not_active")
    cap = auto_money_cap_cents if auto_money_cap_cents is not None else version_cap(active)
    if type(cap) is not int or not 0 <= cap <= AUTO_MONEY_HARD_CAP_CENTS:
        raise KernelFailure(422, "invalid", "invalid_money_cap")
    people = await desk_people(ctx, desk_id)
    if compiler.validate_cards(owned, people=people.keys(), agent_keys=await _agent_keys(ctx),
                               auto_money_cap_cents=cap):
        # the log's reason is read from the cards, never from the wording of the errors
        above = bool(compiler.above_money_cap(owned, cap))
        raise KernelFailure(422, "invalid", compiler.ABOVE_MONEY_CAP if above else "invalid_cards")
    profiles = await desks.enabled_profiles(ctx, desk_id)
    schema = compiler.desk_schema(profiles)
    key = draft_key_sha256(expected_parent, owned, _hashes(profiles, schema, cap))
    await _lock(ctx, "draft", desk_id, key)
    existing = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.draft_key_sha256 == key)))).one_or_none()
    if existing is not None and not _proves_again(existing):
        return version_contract(existing)
    try:
        compiled = compiler.compile_cards(owned, profiles, auto_money_cap_cents=cap)
        a0 = compiler.compile_cards(owned, profiles, auto_money_cap_cents=cap, review=False).A
    except ValueError:
        raise KernelFailure(422, "invalid", "uncompilable_cards") from None
    hashes = version_hashes(compiled, schema, profiles, cards=owned, auto_money_cap_cents=cap)
    report = await _check_draft(ctx, key=f"{desk_id}:{key}", schema=schema, cards=owned, profiles=profiles,
                                compiled=compiled, hashes=hashes, auto_money_cap_cents=cap)
    report = explain.explain_report(report, people)
    status = _draft_status(report)
    if existing is None:
        await _lock(ctx, "versions", desk_id)
        version = await _next_version(ctx, desk_id)
    else:
        version = existing.version
    row = version_row(copy_id=owner.copy_id, desk_id=desk_id, version=version, parent_version=expected_parent,
                      compiled=compiled, a0=a0, schema=schema, hashes=hashes, auto_money_cap_cents=cap, status=status,
                      proof=report, created_at=ctx.clock.now(), draft_key_sha256=key)
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

ConfirmRefusal = Literal["not_proved", "parent_changed", "hash_changed", "above_money_cap"]


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
    `active`, and with it its money cap becomes the Desk's; the version it replaces is
    `superseded`. Ledgered `policy` `{version, activated: true, from: <old>,
    auto_money_cap_cents}`. Confirms on the Desk are serialized by its `versions` lock, and the
    active row is locked `FOR UPDATE`. A version the Desk doesn't have is 404 `not_found`, with
    nothing ledgered; one it has is refused, in this order, with `ConfirmConflict`:

    - `not_proved`, before the other conflicts: the process runs in `bounded` mode, where no owner
      draft activates, even one SymCC proved before a restart;
    - `not_proved`: the version isn't `proved` by a SymCC proof of all seven obligations (a
      bounded check, a rejection, or a version already active or superseded);
    - `parent_changed`: the version it was drafted on is no longer the active one;
    - `hash_changed`: the schema, baseline, enabled profiles, invariants (at the version's cap) or
      review thresholds it was proved against aren't the current ones (`current_hashes`);
    - `above_money_cap`: the version holds an auto money card above its own cap, which only a
      draft that bypassed `validate_cards` could."""
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
    if _proved_against(row) != await current_hashes(ctx, desk_id, row.auto_money_cap_cents):
        raise ConfirmConflict(copy_id, desk_id, version, "hash_changed")
    if compiler.above_money_cap(row.cards, row.auto_money_cap_cents):
        raise ConfirmConflict(copy_id, desk_id, version, "above_money_cap")
    if active is not None:
        active.status = "superseded"
        await ctx.db.flush()              # one active version per Desk, even between the two updates
    row.status = "active"
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="policy", origin="kernel",
        summary={"version": version, "activated": True, "from": active.version if active is not None else None,
                 "auto_money_cap_cents": row.auto_money_cap_cents}))
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
    """The enabled money tools (`desk.contracts.money_tool`: in `MONEY_TOOLS`, or with an effect in
    `MONEY_EFFECTS`) that no non-default card covers: `money_needs_card` requires the auto set never
    to allow them."""
    owned = [card for card in cards if not card.is_default]
    return sorted(p.tool for p in profiles
                  if money_tool(p.tool, p.effects)
                  and not any(compiler.covers(card, p.tool, profiles, owned) for card in owned))


def bounded_check(engine: desk_kernel.PolicyEngine, *, key_prefix: str, schema_json: str,
                  compiled: compiler.CompiledSets, a0: str, refs: RefSets, cards: Sequence[RuleCard],
                  profiles: Sequence[ToolProfile], auto_money_cap_cents: int) -> ProofReport:
    """Checks `compiled` (with `a0`, the auto set compiled without review gates), both compiled at
    the money cap `auto_money_cap_cents`, against the reference sets on the requests
    `bounded_cases` generates at that cap, and returns a `method="bounded"`
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
            cases = bounded_cases(cards, profiles, json.loads(schema_json), auto_money_cap_cents=auto_money_cap_cents)
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
# - amounts {each limit and limit + 1, absent, 0, the cap and cap + 1, 1000000} (always on money
#   tools), the cap being the version's money cap, which every case carries in its context;
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


def bounded_cases(cards: Iterable[RuleCard], profiles: Iterable[ToolProfile], schema: Mapping[str, Any], *,
                  auto_money_cap_cents: int) -> list[dict]:
    """The bounded check's requests (`request_json`s) for `cards` over the enabled `profiles` at
    the money cap `auto_money_cap_cents` (`context.auto_money_cap_cents` in every case),
    deduplicated, boundary values first and capped at `MAX_BOUNDED_CASES`. A profile whose tool
    the schema doesn't declare gets none (its policies couldn't load)."""
    cap = compiler.capped(auto_money_cap_cents)
    owned = [card for card in cards if not card.is_default]
    persons = _named([card.person_id for card in owned if card.who == "person"], _OTHER_PERSON)
    agents = _named([card.agent_key_id for card in owned if card.who == "agent"], _OTHER_AGENT)
    actions = schema.get("", {}).get("actions", {})
    passes = [_tool_passes(p, actions[p.tool], owned, persons, agents, cap)
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
                 agents: Sequence[str], cap: int) -> tuple[Iterator[dict], Iterator[dict], Iterator[dict]]:
    """The tool's cases in the three passes: boundaries, each value alone, every combination."""
    tool, effects = profile.tool, frozenset(profile.effects)
    on_tool = [card for card in owned if card.applies_to == tool
               or (card.applies_to.startswith("effect:") and card.applies_to.removeprefix("effect:") in effects)]
    autos = [card for card in on_tool if card.mode == "auto"]
    dimensions = [_amounts(autos, money=money_tool(tool, effects), cap=cap), _discounts(autos), _times(autos),
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
                           recipient=recipient, cap=cap)

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


def _amounts(autos: Sequence[RuleCard], *, money: bool, cap: int) -> list[int | None]:
    limits = sorted({card.max_amount_cents for card in autos if card.max_amount_cents is not None})
    if not (money or limits):
        return [_ABSENT]
    values = [*itertools.chain.from_iterable((limit, limit + 1) for limit in limits), _ABSENT, 0, cap, cap + 1,
              AUTO_MONEY_HARD_CAP_CENTS]
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
             review: tuple[int, int] | None, recipient: str | None, cap: int) -> dict:
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
                               "local_minute": minute, "auto_money_cap_cents": cap}
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
