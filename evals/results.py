"""The committed tier 2 results file and the one check CI runs on it.

**The inputs key.** `GATED_PATHS` are the owner's scope (owner decision, 2026-10-30): the kernel
(the Rust crate with its Cedar policies and proofs, the kernel service with its seed and reviewer
thresholds, the kernel API and the shared contracts it decides over, and the mock payments server
behind its money tools), the prompts, the policies (setup's rule card templates, the presets and
the money cap's cards), the model settings (the Desk's model settings, the models the runner holds
a run's Desk side and kernel checks to, and the simulator with its models), and the tier 2
scenarios and judges (the scenarios, `splits.yaml`, `landed.toml`, the scenario schema, the
verdict, the oracles and the simulator's prompts). The rest of the Desk's code, its migrations and
dependencies, and the harness plumbing that decides neither a verdict nor what a visitor says (the
pass runner, the suite loader, the run artifact, the records reader, the Desk client, the tier 1
stack and the fakes) rely on tier 1 and CI, as do tests, scripts, docs and infrastructure. The code
`results-check` and the final gate run over a pass's stored rows (`evals/run.py`, `evals/gate.py`,
this module) runs at the head, so a change to it is judged there. `inputs_key(rev)` is the first
16 hex characters of the sha256 of the canonical JSON of `{path: git object id at rev, or null}`
over `GATED_PATHS`, so any change or new file under a gated path, and only such a change, moves
it, and a pass stands in for a new one (a results file, or Monday's final gate reusing Sunday's
pass) only while the key is unchanged. Every fresh paid pass needs the owner's explicit sign-off.

**Gating evidence.** A results file, a recorded rate and the final gate come only from a pass on
the Claude API with the production 5.5 models (the owner's provider decision): `gating_refusal`
refuses a pass or file unless the API's calls, the simulator's and the kernel's checks all went to
the Claude API, its `model_ids` are `PRODUCTION_MODEL_IDS` exactly, and every model that served a part
(`served_models`) is one of the three production models (`PRODUCTION_MODELS`; a refusal fallback to
another of them is allowed), and `rate_refusal` refuses a recorded rate that wasn't recorded that
way. A `--results` pass refuses to start on what of this it can know before its runs
(`planned_refusal`: the current rate and the model ids it will record), so no paid pass is wasted on
it. A pass on Bedrock is supported, and explores.

**The results file** `evals/results/<inputs>.json` (`ResultsFile`) is written by
`tier2 --suite all --split all --results` from a clean tree under `GATED_PATHS`, on the in-process
stack and the Claude API, and re-exported by `results --pass <id>` after a rate is recorded. Only a
`--results` pass is exported (`unchecked_refusal`): it alone refused to start with an uncommitted
gated change and built the kernel from that tree, while any other pass records its commit's inputs
key whatever its tree held. That is read from what the pass recorded before its runs (its config,
the uncommitted gated changes it found and whether it built the kernel: `PassResult.start`), never
from `config.results` alone, and the inputs it names must be its commit's, read from git, so a
`pass.json` edited to claim `--results` or relabelled to another commit is refused. It holds rows,
never text, codes or ids beyond scenario ids. It lists the gated map as [object id, path] pairs sorted by path
(`gated_pairs`), never as an object, so CI's secret scan reads no path and object id as a secret.

**`results-check --base <ref>`** (`make evals-results-check`), with no database, network or key:
exit 0 when `git diff --no-renames -z --name-only <ref>...HEAD` touches no gated path and leaves
`recorded_rates.json` and `evals/results/` alone (without renames, moving a gated file out lists its
old path too; `-z` keeps non-ASCII paths unquoted); otherwise, stopping at the first failure, the
committed file for the head's key exists, validates and is gating evidence, its suite hash,
held-out hash and recorded rate are the head's (a rate that is gating evidence), it holds exactly
one row per head scenario and repeat (a scenario that `requires` a plan the head's `landed.toml`
lacks is listed in `pending` with no rows), the head's rate history extends the base's unchanged and
its `landed.toml` keeps every plan the base lists, and the gate recomputed from the rows passes. The
stored `gate` is never trusted. A passing line counts the runs that skipped checks while a plan hadn't
landed, as the gate's summary line does (`gate.skipped_summary`), so such a file never reads as clean.
Every file it reads is read from git at the head and the base, never from the working tree, so the
check sees what CI sees; the scenario files are listed with `-z` too, and a listed name git can't read
fails the check, so none is left out of the suite it rebuilds. The steps that hold a file against the head (its inputs,
gating evidence, suite, hashes, rate and rows) are `reconcile(file, root, rev)`.

**The final gate** (`gate --pass <id> --final`, `final_gate`) certifies only a whole, current, local
pass: it refuses a pass of part of the suite (`--suite`, `--split` or `--only`), a dry,
null-baseline or `--base-url` pass, one that isn't gating evidence, one that wasn't a `--results`
pass by what it recorded (so nothing checked that its tree held its commit's gated inputs or built
the kernel from them), and one made at other gated inputs than the head's; it builds the pass's
results file, reconciles it with the head as `results-check` would (so it judges against the head's
committed rate), and judges the rows against the head's whole suite.

**A recorded rate** (`record-rate`, `passes.record_rate`) sets the bar every later pass is judged
against, so it comes only from a pass the final gate would accept as standing for the head: the
same checks, in the same order, are `reconcile_pass(p, rates, root, use)`, which both call. It is
appended onto the head's committed history, unchanged: `history_refusal` refuses a working tree whose
`recorded_rates.json` differs from that history in any entry, naming the first, before anything is
written. It never lowers the bar quietly: a lower bound on the same held-out set is recorded only with
`--lower-bar` and marked `lowered` (an unmarked lowering, or a mark on an entry that lowered nothing,
doesn't load), and `results-check` names each lowered rate a change adds (`lowered_notice`).
"""

import json
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from itertools import zip_longest
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    field_serializer,
    field_validator,
)

from evals.gate import SHOWN, GateInput, GateResult, RunRow, Target, coverage_problems, skipped_summary
from evals.gate import gate as gate_of
from evals.oracles.canonical import sha256_hex
from evals.tier1.harness import load_landed
from evals.tier2.runner import DESK_MODELS, KERNEL_CHECK_MODELS
from evals.tier2.schema import Provider, RecordedRate, RecordedRates
from evals.tier2.simulator import ATTACKER_MODEL, VISITOR_MODEL
from evals.tier2.suite import (
    heldout_sha256,
    load_recorded_rates,
    load_splits,
    load_suite,
    split_problems,
    suite_sha256,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = "evals/results"
RATES_PATH = "evals/recorded_rates.json"
LANDED_PATH = "evals/tier1/landed.toml"
SCENARIOS_PATH = "evals/tier2/scenarios"
SPLITS_PATH = "evals/splits.yaml"
# The owner's scope (owner decision, 2026-10-30): the kernel, the prompts, the policies, the model settings,
# and the tier 2 scenarios and judges. Everything else relies on tier 1 and CI.
GATED_PATHS = (
    # The kernel.
    "kernel",                               # the Rust crate: Cedar decisions, the policies' proofs, ledger signing
    "backend/desk/kernel_service",          # the kernel process: gateway, reply check, seed, reviewer thresholds
    "backend/desk/kernel_api.py",           # the requests the kernel decides on and the answers it gives
    "backend/desk/contracts.py",            # the cards, decisions and labels the kernel checks and renders
    "backend/desk/mockpay",                 # the payment server behind the kernel's money tools
    # The prompts.
    "backend/desk/api/prompts.py",          # every fixed string the Desk's model sees
    # The policies.
    "backend/desk/api/setup_templates.py",  # the rule card templates setup compiles into a Desk's rules
    "backend/desk/presets.py",              # the rule card presets a Desk starts from
    "backend/desk/money_cap.py",            # the money cap's rule cards
    # The model settings.
    "backend/desk/api/model.py",            # the Desk's model, effort, thinking and output limit for each call
    "evals/tier2/runner.py",                # the models a run's Desk and kernel checks must be served by, and which
                                            # runs end unscored
    "evals/tier2/simulator.py",             # the simulated visitors' models and effort, and how each turn is asked
    # The tier 2 scenarios and judges.
    "evals/tier2/prompts.py",               # the simulated visitors' prompts: what a visitor says
    "evals/tier2/scenarios",                # the scenarios: personas, goals and what each oracle expects
    "evals/splits.yaml",                    # which scenarios calibrate and which are held out
    "evals/tier1/landed.toml",              # which scenarios run and which wait for a plan
    "evals/tier2/schema.py",                # how a scenario's expectations read
    "evals/tier2/verdict.py",               # the run verdict
    "evals/oracles",                        # the oracles the verdict runs
)
KEY_LENGTH = 16


class GitError(RuntimeError):
    """A git command failed: the revision or repository isn't what the check needs."""


def git(root: Path, *args: str, stdin: str | None = None) -> str:
    done = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, input=stdin)
    if done.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed: {done.stderr.strip()[:300]}")
    return done.stdout


def gated_map(rev: str = "HEAD", root: Path = REPO_ROOT) -> dict[str, str | None]:
    """Each gated path's git object id at `rev` (a tree or a blob), or None where it doesn't exist."""
    commit = git(root, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}").strip()
    lines = git(root, "cat-file", "--batch-check=%(objectname)",
                stdin="".join(f"{commit}:{path}\n" for path in GATED_PATHS)).splitlines()
    if len(lines) != len(GATED_PATHS):
        raise GitError(f"git cat-file answered {len(lines)} lines for {len(GATED_PATHS)} gated paths")
    return {path: None if line.endswith(" missing") else line.strip()
            for path, line in zip(GATED_PATHS, lines, strict=True)}


def key_of(gated: dict[str, str | None]) -> str:
    return sha256_hex(gated)[:KEY_LENGTH]


def gated_pairs(gated: Mapping[str, str | None]) -> list[list[str | None]]:
    """The gated map as a results file and `pass.json` list it: [object id, path] pairs sorted by path. CI's secret
    scan reads a name with "api" or "key" in it, then a colon or a comma, then a long value as a secret, so a path
    that names one (`backend/desk/kernel_api.py`) is never followed by its object id: each path ends its pair."""
    return [[gated[path], path] for path in sorted(gated)]


_GATED_PAIRS = TypeAdapter(list[tuple[str | None, str]])


def gated_from_pairs(listed: Any) -> dict[str, str | None]:
    """The gated map from its [object id, path] pairs, each path once and in sorted order, as `gated_pairs` writes
    them; any other shape, the JSON object it replaced among them, is refused."""
    if not isinstance(listed, list):
        raise ValueError("the gated map is a list of [object id, path] pairs sorted by path")
    pairs = _GATED_PAIRS.validate_python(listed)
    paths = [path for _, path in pairs]
    if paths != sorted(set(paths)):
        raise ValueError("the gated map's pairs list each path once, sorted by path")
    return {path: object_id for object_id, path in pairs}


def inputs_key(rev: str = "HEAD", root: Path = REPO_ROOT) -> str:
    """The inputs key at `rev`: what `make evals-key` prints and the results file is named by."""
    return key_of(gated_map(rev, root))


def dirty_gated(root: Path = REPO_ROOT) -> list[str]:
    """Uncommitted changes under the gated paths, untracked files included, as `git status` lists them."""
    return git(root, "status", "--porcelain", "--untracked-files=all", "--", *GATED_PATHS).splitlines()


def is_gated(path: str) -> bool:
    return any(path == gated or path.startswith(gated + "/") for gated in GATED_PATHS)


def show(root: Path, rev: str, path: str) -> bytes | None:
    """The bytes of `path` at `rev`, or None when it isn't there."""
    done = subprocess.run(["git", "-C", str(root), "show", f"{rev}:{path}"], capture_output=True)
    if done.returncode != 0:
        if subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"],
                          capture_output=True).returncode != 0:
            raise GitError(f"{rev} isn't a commit here")
        return None
    return done.stdout


# Gating evidence

GATING_PROVIDER: Provider = "anthropic"
# The model each route of a pass sends, by production name: the API's routes a run reaches, the kernel's
# checks (always on the Claude API) and the simulated visitor of each suite. On the Claude API a pass sends
# these names as they are, so they are also the model ids a gating pass records.
API_ROUTES = dict(DESK_MODELS)
KERNEL_ROUTES = {"reviewer": KERNEL_CHECK_MODELS["review"], "soft_promise": KERNEL_CHECK_MODELS["reply"]}
SIMULATOR_ROUTES = {"attacker": ATTACKER_MODEL, "visitor": VISITOR_MODEL}
PRODUCTION_MODEL_IDS = {**API_ROUTES, **KERNEL_ROUTES, **SIMULATOR_ROUTES}
# A recorded rate names the API's and the simulated visitor's models too (`record_rate`).
RATE_MODEL_IDS = {"api": API_ROUTES["conversation"], "simulator": SIMULATOR_ROUTES["visitor"], **PRODUCTION_MODEL_IDS}
# The three production models: what may serve any part of a gating pass (`served_models`), a refusal fallback to
# another of them included.
PRODUCTION_MODELS = frozenset(PRODUCTION_MODEL_IDS.values())
_PARTS = {"api": "the API", "simulator": "the simulator", "kernel_checks": "the kernel's checks"}
_SERVED = {"api": "the API was", "simulator": "the simulator was", "kernel_checks": "the kernel's checks were"}
_GATING = ("a results file, a recorded rate and the final gate come only from a pass on the Claude API with the "
           "production 5.5 models; a pass on Bedrock explores and is never exported")


def gating_refusal(p: Any) -> str | None:
    """Why a finished pass (`PassResult`) or a results file isn't gating evidence, or None when it is:
    every part's calls went to the Claude API, its `model_ids` are `PRODUCTION_MODEL_IDS`, route by
    route, with none missing and none added, and every model that served a part (`served_models`) is
    one of `PRODUCTION_MODELS`, for a part the production configuration has."""
    providers = p.providers.model_dump()
    if off := [f"{label} on {providers[part]}" for part, label in _PARTS.items() if providers[part] != GATING_PROVIDER]:
        return f"pass {p.pass_id} isn't gating evidence: it ran {', '.join(off)}; {_GATING}"
    if wrong := _model_id_problems(p.model_ids, PRODUCTION_MODEL_IDS):
        return f"pass {p.pass_id} isn't gating evidence: it recorded {'; '.join(wrong)}; {_GATING}"
    if wrong := _served_problems(p.served_models):
        return f"pass {p.pass_id} isn't gating evidence: {'; '.join(wrong)}; {_GATING}"
    return None


def rate_refusal(rate: RecordedRate | None) -> str | None:
    """Why a recorded rate can't be the bar a gating pass is judged against, or None when it can (or
    there is none): it was recorded from a pass on the Claude API with the production models."""
    if rate is None:
        return None
    if rate.provider != GATING_PROVIDER:
        return (f"the recorded rate from pass {rate.run_id} isn't gating evidence: it was recorded on {rate.provider}; "
                f"{_GATING}")
    if wrong := _model_id_problems(rate.model_ids, RATE_MODEL_IDS):
        return (f"the recorded rate from pass {rate.run_id} isn't gating evidence: it recorded {'; '.join(wrong)}; "
                f"{_GATING}")
    return None


def planned_refusal(model_ids: dict[str, str], rates: RecordedRates) -> str | None:
    """What the export of a `--results` pass that would send `model_ids`, judged against `rates`, would
    refuse that is known before any run, or None: the current rate isn't gating evidence (`rate_refusal`),
    or the model ids it would record aren't `PRODUCTION_MODEL_IDS`. (Its providers and whole selection
    are `PassConfig.results_refusal`'s, its clean tree `dirty_gated`'s; only its coverage and the models
    that served it wait for the runs.) The pass refuses to start on it, so it never wastes a paid pass."""
    if refusal := rate_refusal(rates.current):
        return refusal
    if wrong := _model_id_problems(model_ids, PRODUCTION_MODEL_IDS):
        return f"the pass would record {'; '.join(wrong)}; {_GATING}"
    return None


def unchecked_refusal(p: Any, root: Path = REPO_ROOT) -> str | None:
    """Why a finished pass (`PassResult`) can't stand for its commit's gated inputs, or None when it can:
    only a `--results` pass refused to start with an uncommitted change under `GATED_PATHS` and built the
    kernel from that tree (`make kernel`). Any other pass records its commit's inputs key whatever its
    working tree held or whichever kernel build it ran. Whether it was a `--results` pass is read from what
    it recorded, never from `config.results` alone: its config could have been one (`results_refusal`),
    it found no uncommitted gated change when it started, and with runs it built the kernel before them
    (`PassResult.start`). So a `pass.json` edited to claim `--results` over another pass is refused. And
    the gated inputs it names (`inputs`, `gated`) must be those of the commit it started on, read from git
    (`gated_map(git_sha)`), so a `pass.json` relabelled to another commit's inputs is refused too."""
    if not p.config.results:
        return (f"pass {p.pass_id} wasn't made with --results, so nothing checked that its tree held its commit's "
                "gated inputs, and nothing built the kernel from them; run tier2 --suite all --split all --results")
    claimed = f"pass {p.pass_id}'s pass.json says it was made with --results, but "
    if refusal := p.config.results_refusal():
        return claimed + f"its config couldn't have been one: {refusal}"
    if (start := p.start) is None:
        return claimed + ("it doesn't record what it checked before its runs; run tier2 --suite all --split all "
                          "--results")
    if start.uncommitted:
        shown = "; ".join(start.uncommitted[:10]) + (f"; and {len(start.uncommitted) - 10} more"
                                                     if len(start.uncommitted) > 10 else "")
        return claimed + f"its tree had uncommitted changes under the gated paths when it started: {shown}"
    if p.runs and not start.kernel_built:
        return claimed + "it didn't build the kernel before its runs"
    try:
        gated = gated_map(p.git_sha, root)
    except GitError:
        return (f"pass {p.pass_id}'s commit {p.git_sha[:12]} isn't a commit in this repository, so the gated inputs "
                "it ran on can't be read")
    if p.gated != gated or p.inputs != key_of(gated):
        return (f"pass {p.pass_id}'s pass.json names other gated inputs than its commit {p.git_sha[:12]} holds (it "
                f"names {p.inputs}, the commit's are {key_of(gated)}); run a new pass")
    return None


def _model_id_problems(recorded: dict[str, str], expected: dict[str, str]) -> list[str]:
    problems = [f"{route} on {recorded[route]}, not {name}" if route in recorded else f"no model id for {route}"
                for route, name in expected.items() if recorded.get(route) != name]
    return problems + [f"{route} on {model}, a route the production configuration doesn't have"
                       for route, model in recorded.items() if route not in expected]


def _served_problems(served: dict[str, list[str]]) -> list[str]:
    names = ", ".join(sorted(PRODUCTION_MODELS))
    problems = [f"models served {part}, a part the production configuration doesn't have"
                for part in served if part not in _SERVED]
    return problems + [f"{_SERVED[part]} served by {model}, not one of the production models ({names})"
                       for part, models in served.items() if part in _SERVED
                       for model in models if model not in PRODUCTION_MODELS]


# The results file

Hex16 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{16}$")]
Hex40 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
Hex64 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class ResultsRefused(RuntimeError):
    """A results file can't be written from this pass, or now."""


class ResultsProviders(BaseModel):
    """Where each part's calls went in the pass: a results file comes only from a real in-process pass."""

    model_config = ConfigDict(extra="forbid")
    api: Provider
    simulator: Provider
    kernel_checks: Literal["anthropic"]


class RateRef(BaseModel):
    """The recorded rate a results file was judged against."""

    model_config = ConfigDict(extra="forbid")
    run_id: str
    completion_lower_95: float
    provider: Provider


class ResultsFile(BaseModel):
    """`evals/results/<inputs>.json`: a full pass's rows at a commit's gated inputs. No text or codes."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    schema_version: Literal[1] = Field(alias="schema")
    inputs: Hex16
    gated: dict[str, str | None]                 # each gated path's git object id, which `inputs` hashes; the
                                                 # file lists it as `gated_pairs`, and only that shape reads
    git_sha: Hex40
    created_at: AwareDatetime
    pass_id: str
    runs_per_scenario: StrictInt = Field(ge=1)
    served_models: dict[str, list[str]]
    providers: ResultsProviders
    model_ids: dict[str, str]
    landed: list[str]
    suite_sha256: Hex64
    heldout_sha256: Hex64
    recorded_rate: RateRef | None
    runs: list[RunRow]
    pending: dict[str, str]
    gate: GateResult                             # as the pass judged it; results-check recomputes it

    @field_validator("gated", mode="before")
    @classmethod
    def _gated_from_pairs(cls, listed: Any) -> dict[str, str | None]:
        """Only the pairs `gated_pairs` writes read (`gated_from_pairs`); the JSON object they replaced is refused."""
        return gated_from_pairs(listed)

    @field_serializer("gated")
    def _gated_as_pairs(self, gated: dict[str, str | None]) -> list[list[str | None]]:
        return gated_pairs(gated)

    def gate_input(self) -> GateInput:
        return GateInput(runs=self.runs, pending=self.pending, runs_per_scenario=self.runs_per_scenario,
                         heldout_sha256=self.heldout_sha256, provider=self.providers.api)

    def dumps(self) -> str:
        return json.dumps(self.model_dump(mode="json", by_alias=True), indent=1) + "\n"


def rate_ref(rates: RecordedRates) -> RateRef | None:
    current = rates.current
    return None if current is None else RateRef(run_id=current.run_id, completion_lower_95=current.completion_lower_95,
                                                provider=current.provider)


def results_file(p: Any, rates: RecordedRates, *, root: Path = REPO_ROOT) -> ResultsFile:
    """The results file of a finished pass (`PassResult`), judged against `rates`' current rate. Refused
    unless the pass and that rate are gating evidence (`gating_refusal`, `rate_refusal`), the pass was
    a `--results` pass by what it recorded, at its commit's gated inputs (`unchecked_refusal`), and it
    covers the whole suite at its commit (`pass_target`, `coverage_problems`)."""
    if refusal := (p.config.results_refusal() or gating_refusal(p) or rate_refusal(rates.current)
                   or unchecked_refusal(p, root)):
        raise ResultsRefused(refusal)
    if problems := coverage_problems(p.gate_input(), pass_target(p, root)):
        raise ResultsRefused(f"pass {p.pass_id} doesn't cover the suite: " + "; ".join(problems))
    return ResultsFile(
        schema=1, inputs=p.inputs, gated=gated_pairs(p.gated), git_sha=p.git_sha, created_at=p.created_at,
        pass_id=p.pass_id, runs_per_scenario=p.config.runs, served_models=p.served_models,
        providers=ResultsProviders(api=p.providers.api, simulator=p.providers.simulator, kernel_checks="anthropic"),
        model_ids=p.model_ids, landed=list(p.landed), suite_sha256=p.suite_sha256, heldout_sha256=p.heldout_sha256,
        recorded_rate=rate_ref(rates), runs=list(p.runs), pending=dict(p.pending), gate=gate_of(p, rates),
    )


def write_results(p: Any, rates: RecordedRates, *, root: Path = REPO_ROOT) -> Path:
    """Write the pass's results file as `evals/results/<inputs>.json`. Refused when `results_file` refuses
    (a pass that wasn't a `--results` pass among them) and when the gated paths have uncommitted changes or
    moved since the pass, so the file always names the inputs it was run on."""
    file = results_file(p, rates, root=root)
    if dirty := dirty_gated(root):
        raise ResultsRefused("a results file needs every gated path committed; uncommitted: "
                             + "; ".join(line.strip() for line in dirty[:10]))
    if (head := inputs_key("HEAD", root)) != p.inputs:
        raise ResultsRefused(f"the gated inputs moved since pass {p.pass_id} ({p.inputs}, now {head}); run a new pass")
    path = root / RESULTS_DIR / f"{p.inputs}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(file.dumps())
    return path


# The whole suite a pass is reconciled with

def pass_target(p: Any, root: Path = REPO_ROOT) -> Target:
    """The full suite of a finished pass (`PassResult`): every scenario at the pass's commit, read from
    git, under that commit's landed plans. Refused when the pass ran another suite or other landed plans
    than its commit holds (a tree with uncommitted eval files), since nothing then says what it covered."""
    try:
        git(root, "rev-parse", "--verify", "--quiet", f"{p.git_sha}^{{commit}}")
    except GitError:
        raise ResultsRefused(f"pass {p.pass_id}'s commit {p.git_sha[:12]} isn't a commit in this repository, so "
                             "its suite can't be read") from None
    with tempfile.TemporaryDirectory() as tmp:
        try:
            at = _materialize(root, p.git_sha, Path(tmp))
            suite = load_suite(at / SCENARIOS_PATH)
            splits = load_splits(at / SPLITS_PATH)
            landed = load_landed(at / LANDED_PATH)
        except (GitError, OSError, ValueError) as error:
            raise ResultsRefused(f"pass {p.pass_id}'s commit holds eval files that don't load: {error}") from None
    if problems := split_problems(suite, splits):
        raise ResultsRefused(f"pass {p.pass_id}'s commit has splits that don't hold its suite: " + "; ".join(problems))
    if suite_sha256(suite, splits) != p.suite_sha256 or list(landed) != list(p.landed):
        raise ResultsRefused(f"pass {p.pass_id} ran another suite or other landed plans than its commit "
                             f"{p.git_sha[:12]} holds, so its coverage can't be reconciled; run a pass from a "
                             "clean tree")
    return Target.of(suite, splits, landed)


def selection_problems(p: Any, root: Path = REPO_ROOT) -> list[str]:
    """Why a finished pass (`PassResult`) doesn't hold one judged run of every scenario and repetition
    its config selected, or an empty list when it does. Its rows and pending scenarios are reconciled
    (`coverage_problems`) with the suite at its commit, read from git (`pass_target`), narrowed to what its
    `--suite`, `--split` and `--only` select: one row per selected scenario and run `1..runs`, none for
    anything else, each selected scenario waiting for an unlanded plan listed in `pending` with no rows;
    and every row is scored, never incomplete. The rows are reconciled one by one, never counted, so a row
    removed from `runs.jsonl` or written twice is named. A commit or suite that can't be read is a problem,
    never a pass. Calibration and the latest report rely on it."""
    try:
        target = pass_target(p, root)
    except ResultsRefused as refused:
        return [str(refused)]
    config = p.config
    selected = Target(scenarios={sid: scenario for sid, scenario in target.scenarios.items()
                                 if config.suite in ("all", scenario.suite) and config.split in ("all", scenario.split)
                                 and (not config.only or sid in config.only)}, landed=target.landed)
    problems = coverage_problems(p.gate_input(), selected)
    if unjudged := [f"{r.scenario_id} run {r.rep}" for r in p.runs if r.status != "scored"]:
        shown = ", ".join(unjudged[:SHOWN]) + (f" and {len(unjudged) - SHOWN} more" if len(unjudged) > SHOWN else "")
        problems.append(f"{len(unjudged)} runs weren't judged (an error, or records the verdict couldn't read): "
                        f"{shown}")
    return problems


# Reconciling a results file with a commit

class CheckFailed(Exception):
    """The first reason a results file doesn't reconcile with a commit, or the results check fails."""


@dataclass(frozen=True)
class Reconciled:
    """What a results file was reconciled with at a commit: its rate history, landed plans and whole suite."""

    rates: RecordedRates
    landed: tuple[str, ...]
    target: Target


def reconcile(file: ResultsFile, root: Path = REPO_ROOT, rev: str = "HEAD", *, name: str | None = None) -> Reconciled:
    """Whether a validated results file is evidence for `rev`, read from git as CI reads it, raising
    `CheckFailed` with the first reason it isn't: it names `rev`'s gated inputs and is gating evidence;
    `rev`'s splits hold its suite, and the file's landed plans, suite hash, held-out hash and recorded
    rate are `rev`'s (a rate that is gating evidence); and its rows cover `rev`'s whole suite
    (`coverage_problems`). `name` is how a reason names the file. `results-check` and the final gate
    both reconcile through it."""
    name = name or f"{RESULTS_DIR}/{file.inputs}.json"
    whose = "the head's" if rev == "HEAD" else f"{rev}'s"
    gated = gated_map(rev, root)
    if file.inputs != key_of(gated) or file.gated != gated:
        raise CheckFailed(f"{name} names other gated inputs than {whose}")
    if refusal := gating_refusal(file):
        raise CheckFailed(f"{name}: {refusal}")
    with tempfile.TemporaryDirectory() as tmp:
        tree = _materialize(root, rev, Path(tmp))
        try:
            suite = load_suite(tree / SCENARIOS_PATH)
            splits = load_splits(tree / SPLITS_PATH)
            rates = load_recorded_rates(tree / RATES_PATH) if (tree / RATES_PATH).exists() \
                else RecordedRates(history=[])
            landed = load_landed(tree / LANDED_PATH)
        except ValueError as error:
            raise CheckFailed(f"{whose} eval files don't load: {error}") from None
    if problems := split_problems(suite, splits):
        raise CheckFailed(f"{whose} splits don't hold its suite: " + "; ".join(problems))
    if file.landed != list(landed):
        raise CheckFailed(f"{name} lists landed plans {file.landed}, {whose} landed.toml {list(landed)}")
    if file.suite_sha256 != suite_sha256(suite, splits):
        raise CheckFailed(f"{name} was run on another suite than {whose} (suite_sha256 differs)")
    if file.heldout_sha256 != heldout_sha256(suite, splits):
        raise CheckFailed(f"{name} was run on another held-out set than {whose} (heldout_sha256 differs)")
    if file.recorded_rate != rate_ref(rates):
        raise CheckFailed(f"{name} was judged against recorded rate {_rate(file.recorded_rate)}, {whose} is "
                          f"{_rate(rate_ref(rates))} (commit any newly recorded rate, then re-export it with results "
                          f"--pass {file.pass_id})")
    if refusal := rate_refusal(rates.current):
        raise CheckFailed(refusal)
    target = Target.of(suite, splits, landed)
    if problems := coverage_problems(file.gate_input(), target):
        raise CheckFailed(f"the rows don't cover {whose} suite: {problems[0]}")
    return Reconciled(rates=rates, landed=landed, target=target)


# What a pass that stands for the head is held to: the final gate's and a recorded rate's words for it.
_USES = {
    "final gate": ("the final gate", "the final gate certifies only",
                   "the final gate certifies only a pass at the inputs it ships"),
    "recorded rate": ("record-rate", "a rate is recorded only from",
                      "a rate is recorded only from a pass at the head's gated inputs"),
}


def reconcile_pass(p: Any, rates: RecordedRates, *, root: Path = REPO_ROOT,
                   use: Literal["final gate", "recorded rate"]) -> Reconciled:
    """Whether a finished pass (`PassResult`) stands for the head, as the final gate and a recorded rate
    both need, judged against `rates` (the working tree's): returns what its results file was reconciled
    with at the head, or raises `ResultsRefused` with the first reason it doesn't, in this order. The pass
    is whole (`whole_pass_refusal`: every scenario, with no `--only`, `--dry-run`, `--null-baseline` or
    `--base-url`); it and the current rate are gating evidence (`gating_refusal`, `rate_refusal`); it was
    a `--results` pass (`unchecked_refusal`), so its tree held its commit's gated inputs and its kernel
    was built from them; it ran at the head's gated inputs, so what it ran is what the head holds; its
    results file can be written (`results_file`, which reconciles it with the whole suite at its commit);
    and that file reconciles with the head as `results-check` would (`reconcile`, so `rates` must name the
    head's current rate; `record_rate` also holds the whole of `rates` to the returned history with
    `history_refusal`). `use` names the caller in the reasons."""
    who, lead, at_inputs = _USES[use]
    if refusal := p.config.whole_pass_refusal():
        raise ResultsRefused(f"{lead} a pass that could write the results file, and pass {p.pass_id} couldn't: "
                             f"{refusal}")
    if refusal := gating_refusal(p) or rate_refusal(rates.current) or unchecked_refusal(p, root):
        raise ResultsRefused(refusal)
    try:
        if (head := inputs_key("HEAD", root)) != p.inputs:
            raise ResultsRefused(f"pass {p.pass_id} ran at gated inputs {p.inputs}, and the head's are {head}: "
                                 f"{at_inputs}; run a new pass")
        file = results_file(p, rates, root=root)
        return reconcile(file, root, "HEAD", name=f"pass {p.pass_id}'s results file")
    except CheckFailed as failure:
        raise ResultsRefused(str(failure)) from None
    except GitError as failure:
        raise ResultsRefused(f"{who} can't read the repository: {failure}") from None


def history_refusal(history: list[RecordedRate], committed: list[RecordedRate]) -> str | None:
    """Why a rate history (the working tree's `recorded_rates.json`) isn't `committed` (the head's, as
    `reconcile_pass` returns it) unchanged, naming the first entry that differs, or None when it is.
    `reconcile` holds only the current rate's reference (run, lower bound, provider) to the head's, so
    without this an uncommitted edit that deletes or rewrites an older entry, or changes any other
    field of the current one, would be carried into the history a new rate is appended to."""
    ours = [entry.model_dump(mode="json") for entry in history]
    theirs = [entry.model_dump(mode="json") for entry in committed]
    for number, (mine, head) in enumerate(zip_longest(ours, theirs), start=1):
        if mine == head:
            continue
        if mine is None:
            what = f"it has no entry {number}, the head's is run {head['run_id']}"
        elif head is None:
            what = f"its entry {number}, run {mine['run_id']}, isn't in the head's"
        elif mine["run_id"] != head["run_id"]:
            what = f"its entry {number} is run {mine['run_id']}, the head's is run {head['run_id']}"
        else:
            fields = ", ".join(field for field in head if mine.get(field) != head[field])
            what = f"its entry {number}, run {mine['run_id']}, differs from the head's in {fields}"
        return (f"recorded_rates.json isn't the head's committed rate history: {what}; a rate is appended only onto "
                "the head's committed history, unchanged, so commit or restore recorded_rates.json first")
    return None


def lowered_notice(rate: RecordedRate) -> str | None:
    """A recorded rate that lowered the completion bar on the same held-out set (`lowered`, which only
    `record-rate --lower-bar` writes), in plain words with who signed it off and why, or None for any other.
    `record-rate` prints it, `results-check` names each such rate a change adds, and the report names the
    current one."""
    if not rate.lowered:
        return None
    return (f"the completion bar was lowered on the same held-out set, signed off by {rate.signed_off_by}: "
            f"{rate.completion_lower_95:.3f} from pass {rate.run_id} (reason: {rate.reason})")


def final_gate(p: Any, rates: RecordedRates, *, root: Path = REPO_ROOT) -> GateResult:
    """`gate --pass <id> --final`: whether a finished pass certifies the head, the commit that ships.
    Refused unless the pass stands for the head (`reconcile_pass`, the checks a recorded rate shares);
    then its rows are judged against the head's committed rate and whole suite."""
    at_head = reconcile_pass(p, rates, root=root, use="final gate")
    return gate_of(p, at_head.rates, final=True, target=at_head.target)


# The check CI runs

def results_check(base: str, root: Path = REPO_ROOT) -> tuple[bool, str]:
    """`make evals-results-check BASE=<ref>`: (passed, the reason). See the module docstring for the order."""
    try:
        return True, _check(base, root)
    except CheckFailed as failure:
        return False, str(failure)
    except GitError as failure:
        return False, f"results check: {failure}"
    except ValueError as failure:   # a base whose eval files don't load
        return False, f"results check: the base's eval files don't load: {failure}"


def _check(base: str, root: Path) -> str:
    # Without renames a move lists both its paths, and -z keeps non-ASCII paths unquoted.
    changed = [path for path in git(root, "diff", "--no-renames", "-z", "--name-only", f"{base}...HEAD").split("\0")
               if path]
    if not any(is_gated(path) or path == RATES_PATH or path.startswith(RESULTS_DIR + "/") for path in changed):
        return f"no gated path, recorded rate or results file changed since {base}; no results file needed"
    name = f"{RESULTS_DIR}/{inputs_key('HEAD', root)}.json"
    raw = show(root, "HEAD", name)
    if raw is None:
        raise CheckFailed(f"{name} isn't committed: the head's gated inputs have no results file "
                          "(run make evals-tier2 and commit what it writes)")
    try:
        file = ResultsFile.model_validate_json(raw)
    except ValidationError as error:
        raise CheckFailed(f"{name} doesn't validate: {_first_error(error)}") from None
    head = reconcile(file, root, "HEAD", name=name)
    with tempfile.TemporaryDirectory() as tmp:
        base_dir = _materialize(root, base, Path(tmp), only=(RATES_PATH, LANDED_PATH))
        base_rates = load_recorded_rates(base_dir / RATES_PATH) if (base_dir / RATES_PATH).exists() \
            else RecordedRates(history=[])
        base_landed = load_landed(base_dir / LANDED_PATH) if (base_dir / LANDED_PATH).exists() else ()
    before = [entry.model_dump(mode="json") for entry in base_rates.history]
    after = [entry.model_dump(mode="json") for entry in head.rates.history]
    if after[:len(before)] != before:
        raise CheckFailed(f"recorded_rates.json rewrites the history {base} holds; it only grows at its end")
    if dropped := [plan for plan in base_landed if plan not in head.landed]:
        raise CheckFailed(f"landed.toml drops plans {base} lists: {', '.join(dropped)}")
    result = gate_of(file, head.rates)
    if not result.passed:
        raise CheckFailed(f"the gate recomputed from {name}'s rows fails: {result.reasons[0]}")
    # Runs that skipped checks while a plan hadn't landed are counted as the gate's summary line counts them, so
    # a file whose rows were made before that plan never reads as clean.
    skipped = [skipped_summary(len(result.skipped_runs), result.skipped_checks)] if result.skipped_runs else []
    lowered = [notice for entry in head.rates.history[len(before):] if (notice := lowered_notice(entry))]
    return "; ".join([f"{name} passes: {len(file.runs)} runs, {len(file.pending)} scenarios pending, "
                      f"recorded rate {_rate(file.recorded_rate)}", *skipped, *lowered])


def _materialize(root: Path, rev: str, into: Path, only: tuple[str, ...] | None = None) -> Path:
    """The eval files at `rev` written under `into`: the scenarios, splits, landed plans and rates. Every
    name in the scenarios tree is listed with `-z`, so a non-ASCII name is read as it is, and one that git
    lists but can't show (a submodule) raises `GitError`, so no scenario file is left out."""
    paths = list(only or (SPLITS_PATH, LANDED_PATH, RATES_PATH))
    scenarios: list[str] = []
    if only is None:
        listed = git(root, "ls-tree", "-z", "--name-only", f"{rev}:{SCENARIOS_PATH}") if show(
            root, rev, SCENARIOS_PATH) is not None else ""
        (into / SCENARIOS_PATH).mkdir(parents=True, exist_ok=True)
        scenarios = [f"{SCENARIOS_PATH}/{name}" for name in listed.split("\0") if name]
    for path in paths + scenarios:
        raw = show(root, rev, path)
        if raw is None and path in scenarios:
            raise GitError(f"git ls-tree lists {path} at {rev}, but it can't be read as a file")
        if raw is not None:
            (into / path).parent.mkdir(parents=True, exist_ok=True)
            (into / path).write_bytes(raw)
    return into


def _first_error(error: ValidationError) -> str:
    first = error.errors()[0]
    return f"{'.'.join(str(part) for part in first['loc'])}: {first['msg']}"


def _rate(ref: RateRef | None) -> str:
    return "none" if ref is None else f"{ref.completion_lower_95:.3f} from {ref.run_id} ({ref.provider})"


__all__ = [
    "API_ROUTES", "GATED_PATHS", "GATING_PROVIDER", "KERNEL_ROUTES", "PRODUCTION_MODEL_IDS", "PRODUCTION_MODELS",
    "RATE_MODEL_IDS", "RESULTS_DIR", "SIMULATOR_ROUTES", "CheckFailed", "RateRef", "Reconciled", "ResultsFile",
    "ResultsProviders", "ResultsRefused", "dirty_gated", "final_gate", "gated_from_pairs", "gated_map", "gated_pairs",
    "gating_refusal", "inputs_key", "history_refusal", "is_gated", "key_of", "lowered_notice", "pass_target",
    "rate_refusal", "reconcile", "reconcile_pass", "results_check", "results_file", "selection_problems",
    "unchecked_refusal", "write_results",
]
