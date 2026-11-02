"""A tier 2 pass: every selected scenario run N times on one stack, inside its budgets.

`run_pass(config, deps)` runs a pass and writes `evals/out/passes/<pass_id>/`: `pass.json` (the
config, with a `--records-dsn` password left out (`without_password`), git sha, providers and model
ids, splits, hashes, estimate, spend, pending scenarios and what it checked before its runs, `start`),
`runs.jsonl` (one `RunRow` per run), `errors.jsonl` and `transcripts/` (each run's outcome with its
secrets redacted). In order, before any run:

1. The refusal: `--results` is refused unless the pass is `--suite all --split all` on the
   in-process stack and the Claude API (`MODEL_PROVIDER=anthropic`) with no `--only`, `--dry-run`
   or `--null-baseline`. A pass on Bedrock explores: it is never gating evidence.
2. The clean tree: every pass records the uncommitted changes under the gated paths (`is_gated`,
   `evals/results.py`) it started on (`StartChecks.uncommitted`), and `--results` is refused on any.
3. What the export would refuse: `--results` is refused when `recorded_rates.json` doesn't load,
   its current rate isn't gating evidence, or the model ids the pass will record aren't the
   production ones (`results.planned_refusal`), so a bad rate never wastes a paid pass.
4. The commit that names the pass (`git_sha`) and its gated inputs are read, before the suite is
   loaded, the checks below and `make kernel`, so nothing committed later is named.
5. The suite: the scenarios, splits and `landed.toml` are loaded, then `--suite`, `--split` and
   `--only` select over the suite; a scenario that `requires` a plan `landed.toml` lacks is
   pending, listed with that plan and never run. Every run gets the landed plans (`run_scenario`'s
   `landed`), which decide what it reads and which checks its verdict runs.
6. A pass with runs to make and real models refuses to start without `ANTHROPIC_API_KEY` (the
   kernel's checks use it on every provider), on `bedrock` without `BEDROCK_BEARER_TOKEN`, and
   without list prices for every model it calls on its provider (`evals.pricing.PRICES`).
7. Budgets. The estimate is $0.40 a run until spend rows measure this provider's cost per run
   (`estimate_usd`; a calibration's rows, whose runs are single model calls, and a latency run's row, of
   no runs, measure none); over `--max-usd` it refuses. The month's Claude API spend in the shared spend
   file, every row counted (a calibration's included), plus the estimate's Claude API share must stay
   within `monthly_limit_usd − demo_reserve_usd` (`evals/budget.toml`), or it refuses and says what
   remains. The spend file is
   `<git common dir>/desk-eval-spend.csv`, shared by every worktree and never committed.

Then, with `--results` and runs to make, `make kernel` (recorded as `StartChecks.kernel_built`, so
whether a pass was a `--results` pass is read from what it did, never from `config.results` alone:
`results.unchecked_refusal`); then the runs, `--concurrency` at a time on
one stack (`load_api_target()` from the working tree, or the deployment at `--base-url`). A run
whose error is `infra` is retried once, and both attempts are recorded. Once spend reaches
`--max-usd`, no new run starts (`stopped_by_budget`). A dry run scripts every model for $0: the
Desk's on the kernel target's `FakeAnthropic` and the visitor's on its own, both on provider
`anthropic` whatever `MODEL_PROVIDER` says, recorded as provider `fake`. A `--base-url` pass
records the API's provider as `unknown`, since the deployment's setting isn't visible here. A real
pass appends one spend row (`pass_id, date, provider, runs, desk_usd, simulator_usd, claude_api_usd,
total_usd, estimated_usd`); only `claude_api_usd` counts against the monthly limit, since a Bedrock
pass bills AWS credits except for the kernel's checks. Each attempt is charged its priced usage, or a
run's estimate (listed in `estimated_spend`) when it left no usage or its usage can't be priced; an
attempt whose runner couldn't read every call (`RunArtifact.usage_unread`), or that failed before its
artifact was built and carries the usage it held (`RunOutcome.held_usage`), is charged what it read plus
a run's estimate, never less than it measured. `estimated_usd` says how much of the total is estimated,
so it never reads as measured. A pass that fails or is cancelled cancels its other runs, each charged
its estimate, and awaits them before the stack closes and the spend row is written, so the row counts
every run.

`record_rate` appends a held-out legitimate completion rate to `recorded_rates.json`, with the owner's
sign-off, only from a pass the final gate would hold to the same checks (`results.reconcile_pass`): a
whole `--results` pass, read from what it recorded, on the Claude API with the production models, at
the head's gated inputs, whose results file reconciles with the head and its committed rate history;
and only when it is clean, of three or more runs, on today's held-out set and has a run of every
held-out legitimate scenario. The bar it sets gates every later pass, so it is never lowered quietly: a
lower bound than the current rate's on the same held-out set is refused unless `--lower-bar` is given,
and then the entry is marked `lowered`, which `record-rate`, the results check and the report name.
"""

import asyncio
import csv
import fcntl
import importlib
import json
import os
import re
import secrets
import tomllib
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol, Self

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_serializer,
    field_validator,
    model_validator,
)

from evals import results
from evals.credentials import mask_credentials
from evals.gate import GateInput, RunRef, RunRow, first_turn_refusal, gate, waiver_summary
from evals.results import API_ROUTES, KERNEL_ROUTES, SIMULATOR_ROUTES
from evals.tier1.harness import load_landed
from evals.tier2.runner import RunError, RunOutcome, SimulatorStats, run_scenario
from evals.tier2.schema import Provider, RecordedRate, RecordedRates, Scenario, wilson_lower_95
from evals.tier2.simulator import model_id
from evals.tier2.suite import (
    heldout_sha256,
    load_recorded_rates,
    load_splits,
    load_suite,
    split_problems,
    suite_sha256,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PER_RUN_USD = 0.40   # a run's cost until spend rows measure it (master "Model cost and latency budget")
SPEND_FILE = "desk-eval-spend.csv"
REASON_CHARS = 300   # an estimate's reason as written, cut after its credentials are masked
SPEND_COLUMNS = ("pass_id", "date", "provider", "runs", "desk_usd", "simulator_usd", "claude_api_usd", "total_usd",
                 "estimated_usd")
LEGACY_SPEND_COLUMNS = SPEND_COLUMNS[:-1]   # a spend file written before rows marked estimated spend
# A calibration's spend rows (`evals/calibration`) start their pass_id with this. Their runs are single
# model calls, not tier 2 runs, so they count against the monthly limit but never measure a run's cost.
CALIBRATION_PREFIX = "calibration-"
SUITES: tuple[Literal["attack", "legit"], ...] = ("attack", "legit")
# The model each route of a pass sends (API_ROUTES, KERNEL_ROUTES, SIMULATOR_ROUTES) is set in `evals.results`,
# beside the rule that a gating pass recorded exactly those models.
PASS_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
RECORD_MIN_RUNS = 3   # a rate is recorded only from a pass of three or more runs per scenario


class PassRefused(RuntimeError):
    """The pass, or what was asked of a finished pass, can't go ahead; the message says why."""


def without_password(dsn: str) -> str:
    """A records DSN as a pass writes it: its password replaced by `***` and any password in its query left
    out (the database driver reads both). A DSN that isn't a database URL raises ValueError, as does one with
    more than one `@`: the parser ends the password at the first `@`, so the rest of a password holding one
    would be written as the host or the database. No refusal quotes the DSN."""
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import ArgumentError

    if dsn.count("@") > 1:
        raise ValueError("--records-dsn holds more than one '@', so its password can't be told from its host: "
                         "percent-encode an '@' in its user name or password as %40")
    try:
        url = make_url(dsn)
    except (ArgumentError, ValueError):   # a ValueError's own text can quote the password (as a port, say)
        raise ValueError("--records-dsn needs a database URL (postgresql+asyncpg://user:password@host/db), the "
                         "form its records are read with") from None
    secret = [key for key in url.query if "password" in key.lower()]
    return url.difference_update_query(secret).render_as_string(hide_password=True)


class PassConfig(BaseModel):
    """What `python -m evals.run tier2` was asked for. A refusal never shows what it was given, since
    `--records-dsn` can hold a password."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    suite: Literal["attack", "legit", "all"] = "all"
    split: Literal["calibration", "heldout", "all"] = "all"
    runs: int = Field(ge=1)
    max_usd: float = Field(ge=0, allow_inf_nan=False)
    only: tuple[str, ...] = ()
    concurrency: int = Field(4, ge=1)
    dry_run: bool = False
    null_baseline: bool = False
    results: bool = False
    base_url: str | None = None
    records_dsn: str | None = None
    provider: Provider = "anthropic"          # MODEL_PROVIDER: where a real pass's API and simulator calls go
    wall_clock_s: float = Field(600, gt=0)
    turn_timeout_s: float = Field(90, gt=0)

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        if (self.base_url is None) != (self.records_dsn is None):
            raise ValueError("--base-url and --records-dsn go together: a deployment's runs are judged from its "
                             "records")
        if self.base_url is not None and self.dry_run:
            raise ValueError("--dry-run scripts the in-process stack's models; a deployment's can't be scripted")
        if self.records_dsn is not None:
            without_password(self.records_dsn)
        return self

    @field_serializer("records_dsn")
    def _without_password(self, dsn: str | None) -> str | None:
        """`pass.json`, and any other dump of the config, holds the records DSN without its password."""
        return None if dsn is None else without_password(dsn)

    def whole_pass_refusal(self) -> str | None:
        """Why this isn't a whole pass, or None when it is: every scenario (`--suite all --split all`,
        no `--only`), real (no `--dry-run` or `--null-baseline`) and on the in-process stack built from
        this tree (no `--base-url`). A results file and the final gate need one."""
        if self.suite != "all" or self.split != "all":
            return "--results needs --suite all --split all: a results file covers every scenario"
        for flag, given in (("--only", bool(self.only)), ("--dry-run", self.dry_run),
                            ("--null-baseline", self.null_baseline), ("--base-url", self.base_url is not None)):
            if given:
                return (f"--results can't come from a pass with {flag}: a results file holds full, real passes "
                        "on the in-process stack built from this tree")
        return None

    def results_refusal(self) -> str | None:
        """Why this pass can't write a results file, or None when it can: a whole pass on the Claude API."""
        if refusal := self.whole_pass_refusal():
            return refusal
        if self.provider != results.GATING_PROVIDER:
            return (f"--results needs a pass on the Claude API (MODEL_PROVIDER=anthropic), not {self.provider}: a "
                    "results file is gating evidence, from the production 5.5 models; a pass on Bedrock explores")
        return None


class Spend(BaseModel):
    """US dollars: the Desk side (the API's calls and the kernel's checks), the simulated visitor, and
    the part billed to the Claude API, which alone counts against the monthly limit; `estimated_usd` is
    the part of the total charged as an estimate because nothing could be priced, never measured."""

    model_config = ConfigDict(extra="forbid")
    desk_usd: float = 0.0
    simulator_usd: float = 0.0
    claude_api_usd: float = 0.0
    total_usd: float = 0.0
    estimated_usd: float = 0.0

    @classmethod
    def of(cls, *, desk_usd: float, simulator_usd: float, claude_api_usd: float, estimated_usd: float = 0.0) -> "Spend":
        return cls(desk_usd=desk_usd, simulator_usd=simulator_usd, claude_api_usd=claude_api_usd,
                   total_usd=desk_usd + simulator_usd, estimated_usd=estimated_usd)

    def __add__(self, other: "Spend") -> "Spend":
        return Spend.of(desk_usd=self.desk_usd + other.desk_usd, simulator_usd=self.simulator_usd + other.simulator_usd,
                        claude_api_usd=self.claude_api_usd + other.claude_api_usd,
                        estimated_usd=self.estimated_usd + other.estimated_usd)


class EstimatedSpend(BaseModel):
    """An attempt charged at a run's estimate instead of its priced usage, and why."""

    model_config = ConfigDict(extra="forbid")
    scenario_id: str
    rep: int
    attempt: int
    usd: float
    reason: str


class PassProviders(BaseModel):
    """Where each part's model calls went: `fake` on a dry run, `unknown` for a deployment's API."""

    model_config = ConfigDict(extra="forbid")
    api: Literal["anthropic", "bedrock", "fake", "unknown"]
    simulator: Literal["anthropic", "bedrock", "fake"]
    kernel_checks: Literal["anthropic", "fake"]


class StartChecks(BaseModel):
    """What a pass found and did before its first run, as every pass records it: the uncommitted changes
    under the gated paths when it started (`results.dirty_gated`, as `git status` lists them), and whether
    it rebuilt the kernel from its tree (`make kernel`) before its runs. A `--results` pass refuses to start
    on the first and, with runs to make, does the second, so whether a pass was one is read from these
    (`results.unchecked_refusal`), never from `config.results` alone."""

    model_config = ConfigDict(extra="forbid")
    uncommitted: list[str]
    kernel_built: bool


class PassResult(BaseModel):
    """A finished pass, as `pass.json` and `runs.jsonl` hold it."""

    model_config = ConfigDict(extra="forbid")
    pass_id: str
    created_at: AwareDatetime
    git_sha: str
    config: PassConfig
    providers: PassProviders
    model_ids: dict[str, str]                 # by route, the model id sent
    landed: list[str]
    splits: dict[str, list[str]]              # the ids in each split at the pass
    suite_sha256: str
    heldout_sha256: str
    inputs: str                               # the inputs key at the pass's commit
    gated: dict[str, str | None]              # each gated path's object id, listed as `results.gated_pairs`
    estimate_usd: float
    spend: Spend
    pending: dict[str, str]                   # scenario id: the plan it waits for
    runs: list[RunRow]
    errors: int                               # error lines in errors.jsonl, retried attempts included
    stopped_by_budget: bool
    served_models: dict[str, list[str]]       # by part, the models that served it
    simulator_fallbacks: dict[str, int]       # turns a fallback model served, and switches
    estimated_spend: list[EstimatedSpend] = []   # attempts in `spend` at a run's estimate, not priced
    start: StartChecks | None = None          # None in a pass.json from before passes recorded it
    # The incomplete runs the visitor simulator refused at their first turn, read from errors.jsonl and the
    # transcripts (`refused_runs`) whenever a pass is made or loaded, never from pass.json.
    refused_runs: list[RunRef] = []

    @property
    def runs_per_scenario(self) -> int:
        return self.config.runs

    @field_validator("gated", mode="before")
    @classmethod
    def _gated_from_pairs(cls, listed: Any) -> Any:
        """The gated map from the pairs `results.gated_pairs` writes (`results.gated_from_pairs`), or, in a
        pass.json from before passes listed it so, from the {path: object id} object they replaced."""
        return listed if isinstance(listed, dict) else results.gated_from_pairs(listed)

    @field_serializer("gated")
    def _gated_as_pairs(self, gated: dict[str, str | None]) -> list[list[str | None]]:
        return results.gated_pairs(gated)

    def gate_input(self) -> GateInput:
        return GateInput(runs=self.runs, pending=self.pending, runs_per_scenario=self.config.runs,
                         heldout_sha256=self.heldout_sha256, provider=self.providers.api,
                         null_baseline=self.config.null_baseline, stopped_by_budget=self.stopped_by_budget,
                         refused=frozenset((r.scenario_id, r.rep) for r in self.refused_runs))


@dataclass
class Stack:
    """What a pass runs on: an `ApiTarget` (or a deployment standing in for one) and a simulator per suite."""

    target: Any
    simulators: Mapping[str, Any]


@dataclass
class PassDeps:
    """What `run_pass` reaches outside itself, so a test can stand in for any of it."""

    root: Path = REPO_ROOT
    stack: Callable[[PassConfig], AbstractAsyncContextManager[Stack]] | None = None
    run_one: Callable[..., Any] = run_scenario
    cost: Callable[[RunOutcome, PassProviders], Spend | None] | None = None
    prices: Callable[[], Mapping[str, Mapping[str, Any]]] | None = None
    credential: Callable[[str], str | None] | None = None
    build_kernel: Callable[[], None] | None = None
    spend_file: Path | None = None
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        self.credential = self.credential or (lambda name: credential(name, self.root))
        self.stack = self.stack or (lambda config: default_stack(config, self.credential))
        self.cost = self.cost or priced_spend
        self.prices = self.prices or load_prices
        self.build_kernel = self.build_kernel or (lambda: make_kernel(self.root))
        self.spend_file = self.spend_file or shared_spend_file(self.root)


# Paths

def evals_path(root: Path, *parts: str) -> Path:
    return root.joinpath("evals", *parts)


def pass_dir(root: Path, pass_id: str) -> Path:
    if not PASS_ID.fullmatch(pass_id):
        raise PassRefused(f"{pass_id!r} isn't a pass id")
    return evals_path(root, "out", "passes", pass_id)


# Budgets

def estimate_usd(runs: int, measured_per_run: float | None) -> float:
    """What `runs` runs should cost: the measured cost per run, else $0.40 (to the millionth of a dollar)."""
    return round(runs * (DEFAULT_PER_RUN_USD if measured_per_run is None else measured_per_run), 6)


def shared_spend_file(root: Path) -> Path:
    """`<git common dir>/desk-eval-spend.csv`: one file for every worktree of the repository."""
    common = Path(results.git(root, "rev-parse", "--git-common-dir").strip())
    return (common if common.is_absolute() else root / common).resolve() / SPEND_FILE


def read_spend(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def append_spend(path: Path, row: Mapping[str, Any]) -> None:
    """Append one row under an exclusive lock, writing the header when the file is new. A file whose
    header predates `estimated_usd` gets that column in its header first, in place, so the new row's
    mark lines up; its earlier rows read the mark as missing. A row missing a column is refused before
    the file is touched (`KeyError`), never written as zero."""
    line = {column: row[column] for column in SPEND_COLUMNS}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", newline="") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            handle.seek(0)
            if next(csv.reader([handle.readline()]), None) == list(LEGACY_SPEND_COLUMNS):
                _add_estimated_column(path)
            handle.seek(0, os.SEEK_END)
            writer = csv.DictWriter(handle, fieldnames=SPEND_COLUMNS)
            if handle.tell() == 0:
                writer.writeheader()
            writer.writerow(line)
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _add_estimated_column(path: Path) -> None:
    """Rewrite the spend file's header with `estimated_usd`, in the same file (never a replacement, which
    another worktree waiting on the lock would miss), its rows left as they were. The caller holds the
    file's lock."""
    with path.open("r+", newline="") as handle:
        header, _, rest = handle.read().partition("\n")
        handle.seek(0)
        handle.write(",".join(SPEND_COLUMNS) + ("\r\n" if header.endswith("\r") else "\n") + rest)
        handle.truncate()


def month_rows(rows: list[dict[str, str]], now: datetime) -> list[dict[str, str]]:
    """This UTC month's spend rows, which a report copies into `evals/reports/spend.csv`."""
    month = now.astimezone(UTC).strftime("%Y-%m")
    return [row for row in rows if row.get("date", "").startswith(month)]


def write_month_spend(destination: Path, *, root: Path = REPO_ROOT, now: datetime | None = None) -> int:
    """Copy this month's rows of the shared spend file to `destination`; returns how many."""
    rows = month_rows(read_spend(shared_spend_file(root)), now or datetime.now(UTC))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SPEND_COLUMNS)
        writer.writeheader()
        writer.writerows({column: row.get(column, "") for column in SPEND_COLUMNS} for row in rows)
    return len(rows)


def measured_per_run(rows: list[dict[str, str]], provider: str, column: str = "total_usd") -> float | None:
    """This provider's spend per run in `column` over the spend rows of tier 2 runs (a calibration's rows
    aside, `CALIBRATION_PREFIX`), or None before any run was measured. A row of no runs (a latency run's)
    is left out: its dollars count against the month (`within_the_month`) but were spent on no run."""
    runs = spent = 0.0
    for row in rows:
        if (row.get("provider") == provider and not (row.get("pass_id") or "").startswith(CALIBRATION_PREFIX)
                and (row_runs := float(row.get("runs") or 0))):
            runs += row_runs
            spent += float(row.get(column) or 0)
    return spent / runs if runs else None


def load_budget(root: Path) -> tuple[float, float]:
    """`monthly_limit_usd` and `demo_reserve_usd` from `evals/budget.toml`; anything else refuses."""
    path = evals_path(root, "budget.toml")
    try:
        budget = tomllib.loads(path.read_text())
        limit, reserve = budget["monthly_limit_usd"], budget["demo_reserve_usd"]
    except (OSError, tomllib.TOMLDecodeError, KeyError) as error:
        raise PassRefused(f"evals/budget.toml can't be read ({type(error).__name__}); no pass runs without "
                          "it") from None
    if not all(isinstance(v, int | float) and not isinstance(v, bool) and v >= 0 for v in (limit, reserve)):
        raise PassRefused("evals/budget.toml needs monthly_limit_usd and demo_reserve_usd as numbers")
    return float(limit), float(reserve)


def within_the_month(claude_api_usd: float, rows: list[dict[str, str]], now: datetime, root: Path, *,
                     what: str = "pass") -> None:
    """This month's Claude API spend in the spend rows, every row's dollars counted, runs or none, plus
    `claude_api_usd` must stay within `monthly_limit_usd − demo_reserve_usd`, or it refuses and says
    what remains."""
    limit, reserve = load_budget(root)
    allowed = limit - reserve
    spent = sum(float(row.get("claude_api_usd") or 0) for row in month_rows(rows, now))
    if spent + claude_api_usd > allowed:
        raise PassRefused(
            f"this {what}'s ${claude_api_usd:.2f} of Claude API spend would take this month's eval spend past "
            f"${allowed:.2f} (the ${limit:.0f} monthly limit less the ${reserve:.0f} demo reserve): "
            f"${max(allowed - spent, 0):.2f} remains")


# Credentials and prices

def credential(name: str, root: Path = REPO_ROOT) -> str | None:
    """A credential from the environment, else from the repository's `.env`; never printed."""
    if value := os.environ.get(name):
        return value
    path = root / ".env"
    if path.is_file():
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == name:
                return value.strip().strip("'\"") or None
    return None


def load_prices() -> Mapping[str, Mapping[str, Any]]:
    """`evals.pricing.PRICES` (each provider's list prices by model), or none before that module exists."""
    try:
        module = importlib.import_module("evals.pricing")
    except ModuleNotFoundError as error:
        if error.name != "evals.pricing":
            raise
        return {}
    return getattr(module, "PRICES", {})


def require_credentials(provider: Provider, credential: Callable[[str], str | None], *, what: str = "pass") -> None:
    """Real model calls need `ANTHROPIC_API_KEY`, which the kernel's checks use on every provider, and on
    Bedrock `BEDROCK_BEARER_TOKEN`."""
    needed = ["ANTHROPIC_API_KEY"] + (["BEDROCK_BEARER_TOKEN"] if provider == "bedrock" else [])
    if missing := [name for name in needed if not credential(name)]:
        raise PassRefused(f"a real {what} on {provider} needs {' and '.join(missing)} (the kernel's checks use "
                          "ANTHROPIC_API_KEY on every provider); set it in .env")


def require_prices(prices: Mapping[str, Mapping[str, Any]], provider: str, *, on_provider: Iterable[str],
                   on_claude_api: Iterable[str], what: str = "pass") -> None:
    """A list price for every model, by production name, called on the provider and on the Claude API."""
    missing = sorted({f"{provider} {name}" for name in on_provider if not _priced(prices, provider, name)}
                     | {f"anthropic {name}" for name in on_claude_api if not _priced(prices, "anthropic", name)})
    if missing:
        raise PassRefused(f"no list prices for {', '.join(missing)} in evals.pricing.PRICES; a {what} on a provider "
                          "without prices doesn't start")


def _priced(prices: Mapping[str, Mapping[str, Any]], provider: str, name: str) -> bool:
    rows = prices.get(provider) or {}
    return bool(rows.get(name) or rows.get(model_id(provider, name)))   # type: ignore[arg-type]


def priced_spend(outcome: RunOutcome, providers: PassProviders, *,
                 cost_usd: Callable[[Mapping[str, int], str, str], float] | None = None) -> Spend | None:
    """A run's spend from its usage at each provider's list prices (`evals.pricing.cost_usd`): its
    artifact's, or for a run that failed before its artifact was built the usage it held (`held_usage`),
    or None when the run left no usage to price (the pass then charges a run's estimate instead)."""
    if providers.api == "fake":
        return Spend()
    held = outcome.artifact if outcome.artifact is not None else outcome.held_usage
    if held is None:
        return None
    cost_usd = cost_usd or importlib.import_module("evals.pricing").cost_usd
    api_provider = "anthropic" if providers.api == "unknown" else providers.api   # a deployment runs on the Claude API
    api = kernel = simulator = 0.0
    for usage in held.usage:
        if usage.get("part") == "api":
            api += cost_usd(_tokens(usage), str(usage.get("model")), api_provider)
        else:
            kernel += cost_usd(_tokens(usage), str(usage.get("model")), "anthropic")
    for usage in held.simulator_usage:
        simulator += cost_usd(_tokens(usage), str(usage.get("model")), providers.simulator)
    claude_api = kernel + (api if api_provider == "anthropic" else 0) + (
        simulator if providers.simulator == "anthropic" else 0)
    return Spend.of(desk_usd=api + kernel, simulator_usd=simulator, claude_api_usd=claude_api)


def _tokens(usage: Mapping[str, Any]) -> dict[str, int]:
    """Token counts in the SDK's names, from an SDK usage or an `app.model_calls` row."""
    def count(*names: str) -> int:
        return int(next((usage[name] for name in names if usage.get(name) is not None), 0))

    return {"input_tokens": count("input_tokens"),
            "cache_read_input_tokens": count("cache_read_input_tokens", "cached_tokens"),
            "cache_creation_input_tokens": count("cache_creation_input_tokens", "cache_write_tokens"),
            "output_tokens": count("output_tokens")}


# Providers and model ids

def pass_providers(config: PassConfig) -> PassProviders:
    if config.dry_run:
        return PassProviders(api="fake", simulator="fake", kernel_checks="fake")
    return PassProviders(api="unknown" if config.base_url else config.provider, simulator=config.provider,
                         kernel_checks="anthropic")


def pass_model_ids(config: PassConfig) -> dict[str, str]:
    """By route, the model id each part sends: the provider's id for the API's and the simulator's
    routes (the production names on a dry run, which sends them to the fakes), the production names
    for the kernel's checks, and `unknown` for a deployment's API."""
    sent: Provider = "anthropic" if config.dry_run else config.provider
    ids = {route: "unknown" if config.base_url else model_id(sent, name) for route, name in API_ROUTES.items()}
    ids |= dict(KERNEL_ROUTES)
    ids |= {route: model_id(sent, name) for route, name in SIMULATOR_ROUTES.items()}
    return ids


# The pass

async def run_pass(config: PassConfig, deps: PassDeps | None = None) -> PassResult:
    """Run the pass `config` asks for and write it to `evals/out/passes/<pass_id>/`; see the module docstring."""
    return await _Pass(config, deps or PassDeps()).run()


class _Pass:
    def __init__(self, config: PassConfig, deps: PassDeps):
        self.config, self.deps, self.root = config, deps, deps.root
        self.providers = pass_providers(config)
        self.spend = Spend()
        self.attempts = 0
        self.errors = 0
        self.stopped = False
        self.rows: list[RunRow] = []
        self.served: dict[str, set[str]] = {"api": set(), "simulator": set(), "kernel_checks": set()}
        self.fallbacks = {"turns": 0, "switches": 0}
        self.per_run = DEFAULT_PER_RUN_USD
        self.estimated: list[EstimatedSpend] = []

    async def run(self) -> PassResult:
        config, root = self.config, self.root
        if config.results and (refusal := config.results_refusal()):
            raise PassRefused(refusal)
        # Every pass records the uncommitted gated changes it started on (`StartChecks`); --results refuses them.
        uncommitted = [line.strip() for line in results.dirty_gated(root)]
        if config.results and uncommitted:
            raise PassRefused("--results needs every gated path committed; uncommitted: " + "; ".join(uncommitted[:10]))
        if config.results:
            self._refuse_unexportable()
        # One commit names the pass, read before the suite, splits and landed plans are loaded (with --results the
        # gated paths are clean, so they are this commit's) and before the kernel build, so nothing committed
        # during the build or the runs is named.
        git_sha = results.git(root, "rev-parse", "--verify", "HEAD^{commit}").strip()
        gated = results.gated_map(git_sha, root)
        suite = load_suite(evals_path(root, "tier2", "scenarios"))
        splits = load_splits(evals_path(root, "splits.yaml"))
        if problems := split_problems(suite, splits):
            raise PassRefused("the splits don't hold the suite: " + "; ".join(problems))
        landed = load_landed(evals_path(root, "tier1", "landed.toml"))
        self.landed = list(landed)   # each run gets them: what it reads and which checks run follow them
        selected = self._select(suite.scenarios, splits)
        pending = {s.id: plan for s in selected if (plan := next((p for p in s.requires if p not in landed), None))}
        todo = [(s, rep) for s in selected if s.id not in pending for rep in range(1, config.runs + 1)]
        self.split_of = {sid: splits.split_of(sid) for sid in suite.scenarios}
        real = bool(todo) and not config.dry_run
        if real:
            self._require_credentials()
            self._require_prices()
        estimate = self._budget(len(todo)) if real else 0.0
        kernel_built = bool(config.results and todo)
        if kernel_built:
            self.deps.build_kernel()
        now = self.deps.now()
        self.pass_id = f"{now.astimezone(UTC):%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"
        self.out = pass_dir(root, self.pass_id)
        (self.out / "transcripts").mkdir(parents=True, exist_ok=True)
        (self.out / "errors.jsonl").touch()
        try:
            if todo:
                async with self.deps.stack(config) as stack:
                    await self._run_all(stack, todo)
        finally:
            if self.attempts and not config.dry_run:
                append_spend(self.deps.spend_file, {
                    "pass_id": self.pass_id, "date": now.astimezone(UTC).date().isoformat(),
                    "provider": config.provider, "runs": self.attempts,
                    **{name: f"{getattr(self.spend, name):.4f}" for name in SPEND_COLUMNS[4:]},
                })
        result = PassResult(
            pass_id=self.pass_id, created_at=now, git_sha=git_sha,
            config=config, providers=self.providers, model_ids=pass_model_ids(config), landed=list(landed),
            splits={"calibration": list(splits.calibration), "heldout": list(splits.heldout)},
            suite_sha256=suite_sha256(suite, splits), heldout_sha256=heldout_sha256(suite, splits),
            inputs=results.key_of(gated), gated=gated, estimate_usd=round(estimate, 4), spend=self.spend,
            pending=pending, runs=sorted(self.rows, key=lambda r: (r.scenario_id, r.rep)), errors=self.errors,
            stopped_by_budget=self.stopped,
            served_models={part: sorted(models) for part, models in self.served.items()},
            simulator_fallbacks=self.fallbacks,
            estimated_spend=sorted(self.estimated, key=lambda e: (e.scenario_id, e.rep, e.attempt)),
            start=StartChecks(uncommitted=uncommitted, kernel_built=kernel_built),
            refused_runs=[RunRef(scenario_id=sid, rep=rep) for sid, rep in sorted(refused_runs(self.out, self.rows))],
        )
        write_pass(result, self.out)
        return result

    def _refuse_unexportable(self) -> None:
        """Before the kernel build and any run, a `--results` pass refuses what its export would refuse that
        is known now (`results.planned_refusal`): the recorded rates must load, their current rate be gating
        evidence and the model ids it will record be the production ones."""
        try:
            rates = load_recorded_rates(evals_path(self.root, "recorded_rates.json"))
        except (OSError, ValueError) as error:
            raise PassRefused(f"--results judges the pass against evals/recorded_rates.json, which doesn't load: "
                              f"{error}"[:600]) from None
        if refusal := results.planned_refusal(pass_model_ids(self.config), rates):
            raise PassRefused(f"--results would be refused at export, so the pass doesn't start: {refusal}")

    def _select(self, scenarios: Mapping[str, Scenario], splits: Any) -> list[Scenario]:
        config = self.config
        if unknown := [sid for sid in config.only if sid not in scenarios]:
            raise PassRefused(f"--only names scenarios the suite doesn't hold: {', '.join(unknown)}")
        return [s for sid, s in scenarios.items()
                if (not config.only or sid in config.only) and config.suite in ("all", s.suite)
                and config.split in ("all", splits.split_of(sid))]

    def _require_credentials(self) -> None:
        require_credentials(self.config.provider, self.deps.credential)

    def _require_prices(self) -> None:
        require_prices(self.deps.prices(), self.config.provider,
                       on_provider={*SIMULATOR_ROUTES.values(), *([] if self.config.base_url else API_ROUTES.values())},
                       on_claude_api={*KERNEL_ROUTES.values(), *(API_ROUTES.values() if self.config.base_url else [])})

    def _budget(self, runs: int) -> float:
        config = self.config
        rows = read_spend(self.deps.spend_file)
        measured = measured_per_run(rows, config.provider)
        self.per_run = DEFAULT_PER_RUN_USD if measured is None else measured
        estimate = estimate_usd(runs, measured)
        if estimate > config.max_usd:
            raise PassRefused(f"the estimate ${estimate:.2f} for {runs} runs is over --max-usd ${config.max_usd:.2f}")
        claude_api = estimate if config.provider == "anthropic" else estimate_usd(
            runs, measured_per_run(rows, config.provider, "claude_api_usd"))
        within_the_month(claude_api, rows, self.deps.now(), self.root)
        return estimate

    # Runs

    async def _run_all(self, stack: Stack, todo: list[tuple[Scenario, int]]) -> None:
        gate = asyncio.Semaphore(self.config.concurrency)

        async def one(scenario: Scenario, rep: int) -> None:
            async with gate:
                if self._spent_out():
                    self.stopped = True
                    return
                outcome = await self._attempt(stack, scenario, rep, 1)
                if outcome.error is not None and outcome.error.kind == "infra":
                    retry = not self._spent_out()
                    self._record_error(outcome, 1, retried=retry)
                    if retry:   # the first attempt's transcript is kept beside the retry's
                        transcript = self._transcript(scenario, rep)
                        transcript.rename(transcript.with_name(f"{transcript.stem}-try1.json"))
                        outcome = await self._attempt(stack, scenario, rep, 2)
                        if outcome.error is not None:
                            self._record_error(outcome, 2, retried=False)
                    else:
                        self.stopped = True
                elif outcome.error is not None:
                    self._record_error(outcome, 1, retried=False)
                self.rows.append(self._row(scenario, rep, outcome))

        tasks = [asyncio.create_task(one(scenario, rep)) for scenario, rep in todo]
        try:
            await asyncio.gather(*tasks)
        finally:
            # On a failure, or the pass's own cancellation, no run outlives the stack or the spend row: the
            # others are cancelled (a run cut short is charged its estimate) and awaited before either closes.
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def _spent_out(self) -> bool:
        return not self.config.dry_run and self.spend.total_usd >= self.config.max_usd

    def _transcript(self, scenario: Scenario, rep: int) -> Path:
        return self.out / "transcripts" / f"{scenario.id}-{rep}.json"

    async def _attempt(self, stack: Stack, scenario: Scenario, rep: int, attempt: int) -> RunOutcome:
        run_as = scenario
        if self.config.null_baseline and scenario.suite == "legit":
            run_as = scenario.model_copy(update={"setup": scenario.setup.model_copy(update={"answering": False})})
        target = _Provided(stack.target, "anthropic" if self.config.dry_run else self.config.provider)
        simulator = stack.simulators[scenario.suite]
        self.attempts += 1
        try:
            outcome = await self.deps.run_one(run_as, rep, target, simulator, pass_id=self.pass_id,
                                              wall_clock_s=self.config.wall_clock_s,
                                              turn_timeout_s=self.config.turn_timeout_s, landed=self.landed)
        except asyncio.CancelledError:   # cut short with its usage unread: charged its estimate
            if not self.config.dry_run:
                self.spend += self._estimate(scenario.id, rep, attempt, "the pass stopped it before it ended")
            raise
        except Exception as failure:   # run_scenario records its own errors; this is the harness failing
            outcome = RunOutcome(
                scenario_id=scenario.id, suite=scenario.suite, rep=rep, pass_id=self.pass_id,
                error=RunError(kind="infra", detail=f"{type(failure).__name__}: {failure}"),   # masked, then cut
                simulator=SimulatorStats(provider=self.providers.simulator, model="", turns=0, fallback_turns=0,
                                         switches=0, served_models=[]))
        self.spend = self.spend + self._cost(outcome, attempt)
        self._note_served(outcome)
        self._transcript(scenario, rep).write_text(json.dumps(outcome.redacted(), indent=1) + "\n")
        return outcome

    def _cost(self, outcome: RunOutcome, attempt: int) -> Spend:
        """The attempt's priced spend, plus a run's estimate when the runner couldn't read all its calls
        or the run failed before its artifact was built (`held_usage`), else a run's estimate: an attempt
        that left no usage to price, or whose usage can't be priced, is never charged nothing, and one
        whose usage couldn't all be read, or that was cut short, never less than it measured."""
        if self.config.dry_run:
            return Spend()
        try:
            spend = self.deps.cost(outcome, self.providers)
        except Exception as failure:
            return self._estimate(outcome.scenario_id, outcome.rep, attempt,
                                  f"its usage couldn't be priced ({type(failure).__name__}: {failure})")
        if spend is None:
            return self._estimate(outcome.scenario_id, outcome.rep, attempt, "it left no usage to price")
        if outcome.artifact is not None and (unread := outcome.artifact.usage_unread):
            spend = spend + self._estimate(outcome.scenario_id, outcome.rep, attempt,
                                           f"part of its usage couldn't be read ({'; '.join(unread)})")
        elif outcome.artifact is None and (held := outcome.held_usage) is not None:
            kind = outcome.error.kind if outcome.error is not None else "infra"
            why = "; ".join([f"it ended before its artifact was built ({kind}), so part of its usage may be unread",
                             *held.usage_unread])
            spend = spend + self._estimate(outcome.scenario_id, outcome.rep, attempt, why)
        return spend

    def _estimate(self, scenario_id: str, rep: int, attempt: int, reason: str) -> Spend:
        """A run's estimate, all of it on the Claude API so no budget undercounts, noted as estimated in
        `estimated_spend` and marked in `estimated_usd`, so it never reads as measured. Its reason can quote an
        error, so its credentials are masked before it is cut to `REASON_CHARS`."""
        self.estimated.append(EstimatedSpend(scenario_id=scenario_id, rep=rep, attempt=attempt, usd=self.per_run,
                                             reason=mask_credentials(reason)[:REASON_CHARS]))
        return Spend.of(desk_usd=self.per_run, simulator_usd=0.0, claude_api_usd=self.per_run,
                        estimated_usd=self.per_run)

    def _note_served(self, outcome: RunOutcome) -> None:
        held = outcome.artifact if outcome.artifact is not None else outcome.held_usage
        if held is not None:
            for part, models in held.served_models.items():
                self.served.setdefault(part, set()).update(models)
        self.served["simulator"].update(outcome.simulator.served_models)
        self.fallbacks["turns"] += outcome.simulator.fallback_turns
        self.fallbacks["switches"] += outcome.simulator.switches

    def _record_error(self, outcome: RunOutcome, attempt: int, *, retried: bool) -> None:
        assert outcome.error is not None
        self.errors += 1
        line = {"scenario_id": outcome.scenario_id, "rep": outcome.rep, "attempt": attempt,
                "kind": outcome.error.kind, "detail": outcome.error.detail, "retried": retried}
        with (self.out / "errors.jsonl").open("a") as handle:
            handle.write(json.dumps(line) + "\n")

    def _row(self, scenario: Scenario, rep: int, outcome: RunOutcome) -> RunRow:
        base = {"scenario_id": scenario.id, "suite": scenario.suite, "split": self.split_of[scenario.id], "rep": rep}
        incomplete = RunRow(**base, status="incomplete", violations=[], success=None, false_holds=0, expected_allow=0)
        verdict = outcome.verdict
        if outcome.error is not None or verdict is None:
            return incomplete
        try:
            return RunRow(**base, status="scored", violations=[v.oracle for v in verdict.violations],
                          success=verdict.success, false_holds=verdict.false_holds,
                          expected_allow=verdict.expected_allow, skipped=list(verdict.skipped))
        except ValidationError as error:   # a verdict that doesn't fit a row is never counted as clean
            self.errors += 1
            failed = RunError(kind="infra", detail=f"the verdict doesn't fit a results row: {error.errors()[:3]}")
            with (self.out / "errors.jsonl").open("a") as handle:
                handle.write(json.dumps({"scenario_id": scenario.id, "rep": rep, "attempt": 0, "kind": failed.kind,
                                         "detail": failed.detail, "retried": False}) + "\n")
            return incomplete


class _Provided:
    """An `ApiTarget` that says which provider its API was built for, so each run's artifact records it."""

    def __init__(self, target: Any, provider: str):
        self._target, self.provider = target, provider

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)


# Writing and reading a pass

def write_pass(result: PassResult, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "pass.json").write_text(result.model_dump_json(indent=1, exclude={"runs", "refused_runs"}) + "\n")
    (out / "runs.jsonl").write_text("".join(row.model_dump_json() + "\n" for row in result.runs))


def load_pass(pass_id: str, root: Path = REPO_ROOT) -> PassResult:
    """A finished pass from `evals/out/passes/<pass_id>/`."""
    out = pass_dir(root, pass_id)
    if not (out / "pass.json").is_file():
        raise PassRefused(f"no finished pass {pass_id} in evals/out/passes")
    data = json.loads((out / "pass.json").read_text())
    data["runs"] = [json.loads(line) for line in (out / "runs.jsonl").read_text().splitlines() if line.strip()]
    rows = [RunRow.model_validate(row) for row in data["runs"]]
    data["refused_runs"] = [{"scenario_id": sid, "rep": rep} for sid, rep in sorted(refused_runs(out, rows))]
    return PassResult.model_validate(data)


def refused_runs(out: Path, rows: Iterable[RunRow]) -> frozenset[tuple[str, int]]:
    """The incomplete runs of the pass in `out` that its own records show the visitor simulator refused at
    their first turn (`gate.first_turn_refusal`), by (scenario id, rep), read from `errors.jsonl` and each
    run's final transcript, so a pass recorded before this was read is judged the same way. An
    `errors.jsonl` that can't be read names none; a transcript that can't be read leaves its run incomplete."""
    try:
        lines = [json.loads(line) for line in (out / "errors.jsonl").read_text().splitlines() if line.strip()]
        by_run: dict[tuple[str, int], list[dict[str, Any]]] = {}
        for line in lines:
            by_run.setdefault((line["scenario_id"], line["rep"]), []).append(line)
    except (OSError, ValueError, KeyError, TypeError):
        return frozenset()
    found = set()
    for row in rows:
        if row.status != "incomplete":
            continue
        try:
            transcript = json.loads((out / "transcripts" / f"{row.scenario_id}-{row.rep}.json").read_text())
        except (OSError, ValueError):
            transcript = None
        if (isinstance(transcript, dict) and (transcript.get("scenario_id"), transcript.get("rep")) == (
                row.scenario_id, row.rep) and first_turn_refusal(by_run.get((row.scenario_id, row.rep), []),
                                                                  transcript)):
            found.add((row.scenario_id, row.rep))
    return frozenset(found)


# The stack

def default_stack(config: PassConfig, credential: Callable[[str], str | None]) -> AbstractAsyncContextManager[Stack]:
    return external_stack(config, credential) if config.base_url else in_process_stack(config)


class StackChoice(Protocol):
    """What building the in-process stack reads of a pass's or a latency run's config."""

    @property
    def dry_run(self) -> bool: ...

    @property
    def provider(self) -> Provider: ...


def stack_models(config: StackChoice) -> tuple[Literal["fake", "real"], Provider]:
    """The models and provider the in-process stack is built with: scripted on `anthropic` for a dry run,
    whatever `MODEL_PROVIDER` says (the fakes speak the Claude API), else real on the config's provider."""
    return ("fake", "anthropic") if config.dry_run else ("real", config.provider)


@asynccontextmanager
async def in_process_api(config: StackChoice, *, kernel_target: Callable[..., Any] | None = None,
                         make_api_target: Callable[..., Any] | None = None,
                         check: Callable[..., Any] | None = None) -> AsyncIterator[Any]:
    """The kernel and the API in this process, built from the working tree (`load_api_target()`), handed
    over once the preflight passes: the Desk's models scripted on a dry run (`script_desk`), else real
    on the config's provider. The API stops before the kernel. A tier 2 pass and a latency run both
    build on it; the keyword arguments stand in for the kernel target, Plan 02a's `make_api_target`
    and the preflight in tests."""
    from evals.tier1.targets import KernelTarget, load_api_target

    make = make_api_target or load_api_target()
    models, provider = stack_models(config)
    kernel = (kernel_target or KernelTarget)(models=models)
    api = None
    try:
        await kernel.start()
        if config.dry_run:
            script_desk(kernel.fake)
        api = make(kernel, models=models, provider=provider)
        await api.start()
        await (check or preflight)(api, kernel_health=kernel.health)
        yield api
    finally:
        if api is not None:
            await api.stop()
        await kernel.stop()


@asynccontextmanager
async def in_process_stack(config: PassConfig, *, kernel_target: Callable[..., Any] | None = None,
                           make_api_target: Callable[..., Any] | None = None,
                           simulator: Callable[..., Any] | None = None,
                           fake_server: Callable[[], Any] | None = None,
                           check: Callable[..., Any] | None = None) -> AsyncIterator[Stack]:
    """The kernel and the API in this process (`in_process_api`) and a simulator per suite: every model
    scripted on a dry run, the simulated visitor's on a fake model server of its own (`script_visitor`),
    else real on the pass's provider. The keyword arguments stand in for the kernel target, Plan 02a's
    `make_api_target`, the simulator, the visitor's fake model server and the preflight in tests."""
    from evals.fakes import FakeAnthropic
    from evals.tier2.simulator import Simulator

    _, provider = stack_models(config)
    visitor_fake, simulators = None, {}
    try:
        if config.dry_run:
            visitor_fake = (fake_server or FakeAnthropic)().start()
            script_visitor(visitor_fake)
        async with in_process_api(config, kernel_target=kernel_target, make_api_target=make_api_target,
                                  check=check) as api:
            try:
                simulators = {suite: (simulator or Simulator.for_suite)(
                    suite, provider, fake_url=visitor_fake.url if visitor_fake is not None else None)
                    for suite in SUITES}
                yield Stack(target=api, simulators=simulators)
            finally:
                for built in simulators.values():
                    await built.aclose()
    finally:
        if visitor_fake is not None:
            visitor_fake.stop()
            visitor_fake.check()


def script_desk(desk_fake: Any) -> None:
    """The Desk's models on a dry run: it replies in plain prose and the reviewer passes. Nothing in it
    is a number or a commitment."""
    from evals.fakes import Json, ToolUse
    from evals.tier1.golden_desk import REVIEW_PASS, REVIEWER_MODEL

    desk_fake.default(API_ROUTES["conversation"],
                      ToolUse("send_reply", {"prose": "Thanks for your message. How can I help?", "clauses": []}))
    desk_fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))


def script_visitor(visitor_fake: Any) -> None:
    """The simulated visitor's models on a dry run: a plain question each turn."""
    from evals.fakes import Json

    turn = Json({"message": "Hello, what can you help me with?", "verify_contact": None, "verify_code": None,
                 "done": False})
    for model in SIMULATOR_ROUTES.values():
        visitor_fake.default(model, turn)


@dataclass
class _ExternalKernel:
    records: Any
    health: Any
    clock: Any


class _SystemClock:
    @staticmethod
    def now() -> datetime:
        return datetime.now(UTC)


@dataclass
class _ExternalTarget:
    kernel: _ExternalKernel
    base_url: str
    passcode: str
    api_dsn: str


@asynccontextmanager
async def external_stack(config: PassConfig, credential: Callable[[str], str | None]) -> AsyncIterator[Stack]:
    """A deployment at `--base-url`, judged from the records `--records-dsn` reads (as desk_api), with the
    owner's passcode from `DESK_PASSCODE`. Its kernel answers only through the API's health check."""
    from desk.kernel_api import Health
    from evals.client import DeskClient
    from evals.records import Records
    from evals.tier2.simulator import Simulator

    assert config.base_url is not None and config.records_dsn is not None
    passcode = credential("DESK_PASSCODE")
    if not passcode:
        raise PassRefused("a --base-url pass enters the deployment as its owner: set DESK_PASSCODE in .env")
    records, simulators = Records(config.records_dsn), {}
    try:
        async with DeskClient(config.base_url, passcode) as client:
            health = await client.health()
        if not (isinstance(health, dict) and health.get("ok") and isinstance(health.get("kernel"), dict)):
            raise PassRefused("the deployment's health check doesn't report a healthy API and kernel")
        target = _ExternalTarget(kernel=_ExternalKernel(records=records, health=Health.model_validate(health["kernel"]),
                                                        clock=_SystemClock()),
                                 base_url=config.base_url, passcode=passcode, api_dsn=config.records_dsn)
        await preflight(target)
        simulators = {suite: Simulator.for_suite(suite, config.provider) for suite in SUITES}
        yield Stack(target=target, simulators=simulators)
    finally:
        for simulator in simulators.values():
            await simulator.aclose()
        await records.close()


async def preflight(target: Any, *, kernel_health: Any = None) -> None:
    """The API's health check reports the kernel (the same kernel as the target's own `/health`, when
    there is one), and the records see a copy created through the API, so runs are judged from the
    stack they drive."""
    from evals.client import DeskClient

    async with DeskClient(target.base_url, target.passcode) as client:
        health = await client.health()
        if not (isinstance(health, dict) and health.get("ok") and isinstance(health.get("kernel"), dict)):
            raise PassRefused("the API's health check doesn't report a healthy kernel")
        if kernel_health is not None and health["kernel"].get("public_key_hex") != kernel_health.public_key_hex:
            raise PassRefused("the API's health check reports another kernel than the target's own /health")
        copy = await client.enter()
    if not await target.kernel.records.desks(copy["copy_id"]):
        raise PassRefused("the records don't see the copy the API just created; check --records-dsn")


def make_kernel(root: Path) -> None:
    """`make kernel`: the kernel module and proof binary rebuilt from this tree before a results pass."""
    import subprocess

    done = subprocess.run(["make", "-C", str(root), "kernel"])
    if done.returncode != 0:
        raise PassRefused("make kernel failed; a results file is written only from the kernel this tree builds")


# Recording a rate

def record_rate(result: PassResult, *, signed_off_by: str, reason: str, lower_bar: bool = False,
                root: Path = REPO_ROOT, now: datetime | None = None) -> RecordedRate:
    """Append the pass's held-out legitimate completion rate to `recorded_rates.json`, with the owner's
    sign-off. The rate is the bar every later pass is judged against, so it comes only from a pass that
    stands for the head as the final gate requires (`results.reconcile_pass`): whole (no `--suite`,
    `--split`, `--only`, `--dry-run`, `--null-baseline` or `--base-url`), gating evidence, a `--results`
    pass by what it recorded (`results.unchecked_refusal`, never `config.results` alone), at the head's
    gated inputs, with a results file that reconciles with the head (its suite, landed plans, held-out
    set, committed rate and coverage). It is appended onto the head's committed history, unchanged: the
    working tree's `recorded_rates.json` must hold exactly that history (`results.history_refusal` names
    the first entry that differs), so no uncommitted edit is carried forward. Then refused unless it is of
    three or more runs, no incomplete run, unwaived violation, check skipped while a plan hadn't landed,
    or budget stop, on today's held-out set, and
    has a run of every held-out legitimate scenario, of which there is at least one. Last, the bar is
    never lowered quietly: a Wilson lower bound below the current rate's on the same held-out set
    (`heldout_sha256`) is refused unless `lower_bar` (`--lower-bar`) is given, and then the entry records
    `lowered: true` (`results.lowered_notice` says it in plain words). Raising or keeping the bar, or
    recording on a changed held-out set, needs no flag. A refused rate writes nothing."""
    if not signed_off_by.strip() or not reason.strip():
        raise PassRefused("a rate is recorded with the owner's sign-off: --signed-off-by and --reason")
    config = result.config
    rates_file = evals_path(root, "recorded_rates.json")
    history = load_recorded_rates(rates_file).history
    try:
        at_head = results.reconcile_pass(result, RecordedRates(history=history), root=root,
                                         use="recorded rate")
    except results.ResultsRefused as refused:
        raise PassRefused(str(refused)) from None
    committed = at_head.rates.history
    if refusal := results.history_refusal(history, committed):
        raise PassRefused(refusal)
    if config.runs < RECORD_MIN_RUNS:
        raise PassRefused(f"a rate is recorded from a pass of {RECORD_MIN_RUNS} or more runs per scenario, "
                          f"not {config.runs}")
    # Judge safety through the gate's sole waiver-matching path. Completion's lower-bar rule stays below.
    judged = gate(result, RecordedRates(history=[]), waivers=at_head.waivers)
    # A run the simulator refused at its first turn passes the gate but is still incomplete, so no rate comes of it.
    if not judged.passed or judged.skipped_runs or judged.refused_runs:
        raise PassRefused("a rate is recorded only from a clean pass: no incomplete run, violation, skipped check or "
                          "budget stop")
    suite = load_suite(evals_path(root, "tier2", "scenarios"))
    splits = load_splits(evals_path(root, "splits.yaml"))
    if result.heldout_sha256 != heldout_sha256(suite, splits):
        raise PassRefused("the held-out set changed since the pass; run a pass on today's set")
    wanted = {(sid, rep) for sid in splits.heldout if suite.scenarios[sid].suite == "legit"
              for rep in range(1, config.runs + 1)}
    rows = [r for r in result.runs if r.suite == "legit" and r.split == "heldout"]
    if missing := sorted(wanted - {(r.scenario_id, r.rep) for r in rows}):
        raise PassRefused(f"the pass doesn't cover the held-out legitimate suite: {len(missing)} runs missing, "
                          f"from {missing[0][0]}")
    if not rows:
        raise PassRefused(f"pass {result.pass_id} has no held-out legitimate run, so it has no rate to record")
    successes, trials = sum(bool(r.success) for r in rows), len(rows)
    lower = round(wilson_lower_95(successes, trials), 3)
    current = committed[-1] if committed else None
    lowered = current is not None and current.heldout_sha256 == result.heldout_sha256 \
        and lower < current.completion_lower_95
    if lowered and not lower_bar:
        raise PassRefused(f"pass {result.pass_id} would lower the completion bar on the same held-out set, from "
                          f"{current.completion_lower_95:.3f} (pass {current.run_id}) to {lower:.3f}: a miss is fixed "
                          "in the Desk, not by lowering its bar; only record-rate --lower-bar lowers it, and the entry "
                          "then says it was lowered")
    rate = RecordedRate(
        run_id=result.pass_id, recorded_at=now or datetime.now(UTC),
        completion_point=round(successes / trials, 3), completion_lower_95=lower,
        trials=trials, heldout_sha256=result.heldout_sha256, provider=result.providers.api,
        model_ids={"api": result.model_ids["conversation"], "simulator": result.model_ids["visitor"],
                   **result.model_ids},
        report=f"evals/reports/{result.created_at.astimezone(UTC):%Y-%m-%d}-{result.pass_id}.md",
        reason=(f"{reason.strip()} ({waiver_summary(judged)})" if judged.waived_violations else reason.strip()),
        signed_off_by=signed_off_by.strip(), lowered=lowered,
    )
    updated = RecordedRates(history=[*committed, rate])
    rates_file.write_text(json.dumps(updated.model_dump(mode="json"), indent=2) + "\n")
    return rate


__all__ = [
    "CALIBRATION_PREFIX", "DEFAULT_PER_RUN_USD", "EstimatedSpend", "PassConfig", "PassDeps", "PassProviders",
    "PassRefused", "PassResult", "Spend", "Stack", "StackChoice", "StartChecks", "append_spend", "estimate_usd",
    "in_process_api", "in_process_stack", "load_pass", "measured_per_run", "month_rows", "pass_model_ids",
    "pass_providers", "read_spend", "record_rate", "require_credentials", "require_prices", "run_pass",
    "script_desk", "script_visitor", "shared_spend_file", "stack_models", "within_the_month", "write_month_spend",
]
