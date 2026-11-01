"""The pass runner: which runs a pass makes, what it may spend, and how a rate is recorded.

Each case runs `run_pass` in a throwaway repository (`eval_repo`) with a stand-in stack and a
scripted `run_one`, so no model, database or API is involved: the runs' outcomes are fixtures.
"""

import asyncio
import csv
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from evals.tests.eval_repo import make_repo
from evals.tier2.passes import PassConfig, PassDeps, PassRefused, Spend, Stack, estimate_usd, run_pass
from evals.tier2.runner import RunError, RunOutcome, SimulatorStats
from evals.tier2.verdict import RunVerdict, RunViolation

NOW = datetime(2026, 10, 30, 21, 0, tzinfo=UTC)
ALL_MODELS = {model: {"input": 1.0} for model in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")}
PRICES = {"anthropic": ALL_MODELS, "bedrock": ALL_MODELS}
KEYS = {"ANTHROPIC_API_KEY": "kernel-check-key", "BEDROCK_BEARER_TOKEN": "bedrock-token"}


@dataclass
class Scripted:
    """`run_one` for a pass: each (scenario, rep) gets its scripted outcomes in order, else a clean run."""

    errors: dict[tuple[str, int], list[str]] = field(default_factory=dict)   # error kinds, attempt by attempt
    calls: list[tuple[str, int]] = field(default_factory=list)

    async def __call__(self, scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        self.calls.append((scenario.id, rep))
        kinds = self.errors.get((scenario.id, rep), [])
        attempt = sum(1 for call in self.calls if call == (scenario.id, rep))
        kind = kinds[attempt - 1] if attempt <= len(kinds) else None
        return outcome(scenario, rep, kwargs.get("pass_id", "p"), error=kind)


def outcome(scenario: Any, rep: int, pass_id: str = "p", *, error: str | None = None,
            violations: tuple[str, ...] = (), success: bool | None = None,
            skipped: tuple[str, ...] = ()) -> RunOutcome:
    verdict = None
    if error is None:
        legit = scenario.suite == "legit"
        verdict = RunVerdict(
            violations=[RunViolation(category="money", oracle=o, detail="d", evidence="e") for o in violations],
            success=(not violations if success is None else success) if legit else None, unmet=[],
            false_holds=0, expected_allow=1 if legit else 0, reviewed=[], skipped=list(skipped))
    return RunOutcome(
        scenario_id=scenario.id, suite=scenario.suite, rep=rep, pass_id=pass_id, verdict=verdict,
        error=RunError(kind=error, detail=f"{error} in {scenario.id}") if error else None,
        simulator=SimulatorStats(provider="anthropic", model="claude-sonnet-5-5", turns=2, fallback_turns=0,
                                 switches=0, served_models=["claude-sonnet-5-5"] * 2),
    )


@asynccontextmanager
async def stand_in_stack(config: PassConfig) -> AsyncIterator[Stack]:
    yield Stack(target=object(), simulators={"attack": object(), "legit": object()})


def deps(root: Path, run_one: Any = None, *, cost_usd: float = 0.10, prices: Any = PRICES,
         keys: dict[str, str] = KEYS, **changes: Any) -> PassDeps:
    """A pass's dependencies in `root`: the stand-in stack, `run_one` (a clean `Scripted` by default),
    each run costing `cost_usd` on the Claude API, and a spend file of its own."""
    fields: dict[str, Any] = {
        "root": root, "stack": stand_in_stack, "run_one": run_one or Scripted(),
        "cost": lambda outcome, providers: Spend.of(desk_usd=cost_usd / 2, simulator_usd=cost_usd / 2,
                                                    claude_api_usd=cost_usd),
        "prices": lambda: prices, "credential": keys.get, "build_kernel": lambda: None,
        "spend_file": root / "spend.csv", "now": lambda: NOW,
    }
    return PassDeps(**{**fields, **changes})


def config(**changes: Any) -> PassConfig:
    return PassConfig.model_validate({"runs": 1, "max_usd": 10.0, "concurrency": 1, **changes})


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return make_repo(tmp_path / "repo")


async def test_estimate_over_budget_refuses_to_start(repo):
    assert estimate_usd(6, None) == pytest.approx(2.40)       # $0.40 a run until measured
    assert estimate_usd(6, 0.25) == pytest.approx(1.50)
    run_one = Scripted()
    with pytest.raises(PassRefused, match=r"estimate \$2\.40 .* over --max-usd \$2\.00"):
        await run_pass(config(runs=3, max_usd=2.0, suite="all", split="heldout"), deps(repo, run_one))
    assert run_one.calls == []
    result = await run_pass(config(runs=3, max_usd=2.4, split="heldout"), deps(repo, run_one))
    assert len(result.runs) == 6 and result.estimate_usd == pytest.approx(2.40)


async def test_spend_reaching_the_budget_stops_new_runs(repo):
    run_one = Scripted()
    result = await run_pass(config(runs=2, max_usd=1.6, split="heldout"), deps(repo, run_one, cost_usd=0.9))
    assert len(run_one.calls) == 2 and len(result.runs) == 2   # $1.80 spent after two runs: no third starts
    assert result.stopped_by_budget and result.spend.total_usd == pytest.approx(1.8)
    from evals.gate import gate
    from evals.tier2.schema import RecordedRates

    assert not gate(result, RecordedRates(history=[])).passed
    # The spend row measured $0.90 a run, so the same pass is now estimated at $3.60.
    with pytest.raises(PassRefused, match=r"estimate \$3\.60"):
        await run_pass(config(runs=2, max_usd=1.6, split="heldout"), deps(repo, Scripted(), cost_usd=0.1))
    unstopped = await run_pass(config(runs=2, max_usd=1.6, split="heldout"),
                               deps(repo, Scripted(), cost_usd=0.1, spend_file=repo / "other-spend.csv"))
    assert not unstopped.stopped_by_budget and len(unstopped.runs) == 4


def stand_in_runs(*soft_promises: Any, attempts: list[str] | None = None,
                  first_turn_usage: dict[str, Any] | None = None, calls_fail: bool = False, ends: bool = True) -> Any:
    """`run_one` for a pass that drives the real runner on the runner tests' stand-in Desk: each run's
    ledger holds one checked reply per entry of `soft_promises` (its soft-promise call, null, or one that
    can't be read), after the reply the visitor saw. Each attempt's scenario id goes in `attempts`. The
    simulated visitor's first turn reports `first_turn_usage` when given, with `calls_fail` the query for
    each session's `app.model_calls` fails, as a database read that fails does, and without `ends` the
    Desk never ends a turn."""
    from evals.tests.test_runner import CallsUnreadable, Client, Desk, Visitor, chat, checked_reply, seed, target
    from evals.tier2.runner import run_scenario
    from evals.tier2.simulator import ServedTurn

    class Paying(Visitor):
        async def next_turn(self, scenario: Any, observations: Any, run: Any, **kwargs: Any) -> Any:
            turn = await super().next_turn(scenario, observations, run, **kwargs)
            if first_turn_usage is not None and len(run.turns) == 1:
                run.turns[0] = ServedTurn(model=run.turns[0].model, fallback=False, switched=False,
                                          usage=first_turn_usage)
            return turn

    async def run_one(scenario: Any, rep: int, _target: Any, _simulator: Any, **options: Any) -> RunOutcome:
        if attempts is not None:
            attempts.append(scenario.id)
        run = chat(scenario, 1)
        for call in soft_promises:
            checked_reply(run, call)
        desk = Desk(run, ends=ends)
        on = target(desk)
        if calls_fail:
            on.kernel.records = CallsUnreadable(desk, desk.chat_session)
        return await run_scenario(scenario, rep, on, Paying(desk), new_client=lambda: Client(desk),
                                  seed=seed, **options)
    return run_one


async def test_the_kernels_soft_promise_spend_alone_stops_a_pass_at_its_budget(repo):
    """Each run is the real runner on the stand-in Desk, priced at list prices, and its checked reply's
    soft-promise call on Sonnet is nested in its `reply` ledger entry as the kernel writes it. That spend
    takes the pass to --max-usd and no new run starts, as any other spend does; the same runs without
    the call spend a fraction of the cap and all four run."""
    from evals.pricing import cost_usd
    from evals.tests.test_usage_and_latency import SONNET, call_usage
    from evals.tier2.passes import priced_spend

    soft = call_usage(SONNET, input_tokens=200_000, cached=0, output=50_000)   # outsized: $0.90 a check
    result = await run_pass(config(runs=2, max_usd=1.6, split="heldout"),
                            deps(repo, stand_in_runs(soft), cost=priced_spend))
    assert [row.status for row in result.runs] == ["scored", "scored"] and result.estimated_spend == []
    assert result.stopped_by_budget and result.served_models["kernel_checks"] == [SONNET]
    checks = 2 * cost_usd(soft, SONNET, "anthropic")
    assert result.spend.total_usd >= 1.6 > result.spend.total_usd - checks   # the checks took it past the cap
    unchecked = await run_pass(config(runs=2, max_usd=1.6, split="heldout"),
                               deps(repo, stand_in_runs(None), cost=priced_spend, spend_file=repo / "other-spend.csv"))
    assert not unchecked.stopped_by_budget and len(unchecked.runs) == 4 and unchecked.spend.total_usd < 0.1


async def test_a_run_whose_usage_cant_all_be_read_is_charged_what_it_read_and_the_estimate(repo):
    """A run whose reply check spent $0.90 on Sonnet and whose next `reply` entry can't be read fails as
    `infra`. It is charged everything it read plus a run's estimate for what it couldn't, never less, keeps
    the models it read, and the estimated part is listed and marked. That figure crosses --max-usd, where
    the $0.90 alone wouldn't, so the run isn't retried and no new run starts."""
    from evals.pricing import cost_usd
    from evals.tests.test_usage_and_latency import SONNET, call_usage
    from evals.tier2.passes import priced_spend

    soft = call_usage(SONNET, input_tokens=200_000, cached=0, output=50_000)   # $0.90
    attempts: list[str] = []
    result = await run_pass(config(runs=1, max_usd=1.2, split="heldout"),   # two runs, estimated at $0.80
                            deps(repo, stand_in_runs(soft, {**soft, "output_tokens": None}, attempts=attempts),
                                 cost=priced_spend))
    assert attempts == ["atk-held"] and result.stopped_by_budget   # neither retried nor followed
    assert [row.status for row in result.runs] == ["incomplete"] and result.errors == 1
    measured = cost_usd(soft, SONNET, "anthropic")
    assert result.spend.total_usd >= measured + 0.40 > 1.2 > measured
    assert result.spend.estimated_usd == pytest.approx(0.40)
    [estimated] = result.estimated_spend
    assert (estimated.scenario_id, estimated.attempt, estimated.usd) == ("atk-held", 1, pytest.approx(0.40))
    assert "couldn't be read" in estimated.reason and "output_tokens" in estimated.reason
    assert result.served_models["kernel_checks"] == [SONNET]
    row = spend_row(repo)
    assert row["runs"] == "1" and float(row["total_usd"]) == pytest.approx(result.spend.total_usd, abs=1e-4)
    assert float(row["estimated_usd"]) == pytest.approx(0.40)   # the row is written to four decimals


async def test_a_run_whose_usage_query_fails_is_charged_what_it_read_and_the_estimate(repo):
    """A run whose simulated visitor spent $1.00 and whose `app.model_calls` query then fails ends as
    `infra`, and the pass still charges the $1.00 it knows plus a run's estimate for what it couldn't
    read, never the estimate alone. That figure crosses --max-usd, where the $1.00 alone wouldn't, so the
    run isn't retried and no new run starts; the estimated part is listed, naming the failed query."""
    from evals.pricing import cost_usd
    from evals.tier2.passes import pass_dir, priced_spend

    opus = "claude-opus-5-5"
    usage = {"model": opus, "input_tokens": 250_000, "output_tokens": 0}       # $1.00 at Opus 5.5's list price
    measured = cost_usd(usage, opus, "anthropic")
    assert measured == pytest.approx(1.00)
    attempts: list[str] = []
    result = await run_pass(config(runs=1, max_usd=1.3, split="heldout"),   # two runs, estimated at $0.80
                            deps(repo, stand_in_runs(attempts=attempts, first_turn_usage=usage, calls_fail=True),
                                 cost=priced_spend))
    assert attempts == ["atk-held"] and result.stopped_by_budget   # neither retried nor followed
    assert [row.status for row in result.runs] == ["incomplete"] and result.errors == 1
    assert result.spend.total_usd >= measured + 0.40 > 1.3 > measured
    assert result.spend.simulator_usd == pytest.approx(measured)
    assert result.spend.estimated_usd == pytest.approx(0.40)
    [estimated] = result.estimated_spend
    assert (estimated.scenario_id, estimated.attempt, estimated.usd) == ("atk-held", 1, pytest.approx(0.40))
    assert "couldn't be read" in estimated.reason and "app.model_calls query for session" in estimated.reason
    errors = (pass_dir(repo, result.pass_id) / "errors.jsonl").read_text().splitlines()
    [error] = [json.loads(line) for line in errors]
    assert error["kind"] == "infra" and "app.model_calls query for session" in error["detail"]
    row = spend_row(repo)
    assert row["runs"] == "1" and float(row["total_usd"]) == pytest.approx(result.spend.total_usd, abs=1e-4)


async def test_a_run_that_times_out_is_charged_its_known_usage_and_the_estimate(repo):
    """A run whose simulated visitor spent $1.00 and whose turn then never ends times out before its
    artifact is built. It still carries the usage it holds, so the pass charges the $1.00 (and the API's
    call it read) plus a run's estimate, never the estimate alone. That figure crosses --max-usd, where
    the $1.00 alone wouldn't, so no new run starts; the estimated part is listed, naming the timeout."""
    from evals.pricing import cost_usd
    from evals.tier2.passes import priced_spend

    opus = "claude-opus-5-5"
    usage = {"model": opus, "input_tokens": 250_000, "output_tokens": 0}       # $1.00 at Opus 5.5's list price
    measured = cost_usd(usage, opus, "anthropic")
    attempts: list[str] = []
    result = await run_pass(config(runs=1, max_usd=1.3, split="heldout", turn_timeout_s=0.2),   # estimated $0.80
                            deps(repo, stand_in_runs(attempts=attempts, first_turn_usage=usage, ends=False),
                                 cost=priced_spend))
    assert attempts == ["atk-held"] and result.stopped_by_budget   # a timeout isn't retried; no new run starts
    assert [row.status for row in result.runs] == ["incomplete"] and result.errors == 1
    assert result.spend.total_usd >= measured + 0.40 > 1.3 > measured
    assert result.spend.simulator_usd == pytest.approx(measured)
    assert result.spend.estimated_usd == pytest.approx(0.40)
    [estimated] = result.estimated_spend
    assert (estimated.scenario_id, estimated.attempt, estimated.usd) == ("atk-held", 1, pytest.approx(0.40))
    assert "before its artifact was built (timeout)" in estimated.reason
    assert result.served_models["api"] == [opus]   # the models it read are recorded, as a judged run's are


async def test_a_harness_error_is_written_with_its_passwords_masked(repo):
    """A run whose harness fails with a DSN in its message (here, the stand-in `run_one` itself) is
    written to its transcript and `errors.jsonl` with the URL's password and any `password=` parameter
    masked, since every run error's detail is built in one place (`RunError`)."""
    from evals.tier2.passes import pass_dir

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        raise ConnectionError("could not connect to postgresql://desk_api:s3cret-pass@db.example.invalid/desk"
                              "?password=query-secret")

    result = await run_pass(config(runs=1, split="heldout"), deps(repo, run_one))
    out = pass_dir(repo, result.pass_id)
    written = "".join(path.read_text() for path in sorted(out.rglob("*")) if path.is_file())
    assert "s3cret-pass" not in written and "query-secret" not in written
    errors = [json.loads(line) for line in (out / "errors.jsonl").read_text().splitlines()]
    assert len(errors) == 4 and {error["kind"] for error in errors} == {"infra"}
    assert all("postgresql://desk_api:***@db.example.invalid/desk?password=***" in error["detail"]
               for error in errors)


async def test_a_harness_error_is_masked_before_it_is_cut(repo):
    """A harness error whose DSN crosses the 500-character cut of an error's detail is written with no
    part of its password, since the detail is cut only after it is masked."""
    from evals.tier2.passes import pass_dir

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        # "ConnectionError: " (17) + 456 + "postgresql://desk_api:" (22) puts the cut 5 characters into the password.
        raise ConnectionError("x" * 456 + "postgresql://desk_api:Zq9xKw7vRt3Lm@db.example.invalid/desk")

    result = await run_pass(config(runs=1, split="heldout"), deps(repo, run_one))
    out = pass_dir(repo, result.pass_id)
    written = "".join(path.read_text() for path in sorted(out.rglob("*")) if path.is_file())
    assert "Zq9" not in written
    errors = [json.loads(line) for line in (out / "errors.jsonl").read_text().splitlines()]
    assert errors and all(len(error["detail"]) <= 500 for error in errors)


async def test_a_quoted_password_is_written_masked_whole(repo):
    """A connection string's quoted password, in single or double quotes and holding spaces and escaped
    quotes, is masked whole in the run's transcript and `errors.jsonl`, never cut at its first space or
    quote with the rest written."""
    from evals.tier2.passes import pass_dir

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        raise ConnectionError(r"host=db password='fake-review-secret' dbname=desk; "
                              r"host=db password='fake single \'quoted\' secret' dbname=desk; "
                              r'host=db password="fake double \"quoted\" secret" dbname=desk')

    result = await run_pass(config(runs=1, split="heldout"), deps(repo, run_one))
    out = pass_dir(repo, result.pass_id)
    transcripts = list((out / "transcripts").glob("*.json"))
    assert transcripts
    written = "".join(path.read_text() for path in [out / "errors.jsonl", *transcripts])
    assert not {"fake", "review", "single", "double", "quoted", "secret"} & set(re.findall(r"[a-z]+", written))
    errors = [json.loads(line) for line in (out / "errors.jsonl").read_text().splitlines()]
    assert errors and all(error["detail"] == ("ConnectionError: host=db password='***' dbname=desk; "
                                              "host=db password='***' dbname=desk; "
                                              'host=db password="***" dbname=desk') for error in errors)


def spend_rows(path: Path, *rows: tuple[str, str, int, float, float]) -> None:
    """Spend rows (date, provider, runs, claude_api_usd, total_usd), as earlier passes appended them."""
    from evals.tier2.passes import append_spend

    for i, (date, provider, runs, claude_api, total) in enumerate(rows):
        append_spend(path, {"pass_id": f"earlier-{i}", "date": date, "provider": provider, "runs": runs,
                            "desk_usd": total / 2, "simulator_usd": total / 2, "claude_api_usd": claude_api,
                            "total_usd": total, "estimated_usd": 0.0})


async def test_cumulative_budget_refuses_a_pass(repo):
    spend = repo / "spend.csv"
    # This month: $599.50 of the $600 the demo reserve leaves (at $0.40 a run, the rows' own rate);
    # last month's $500 doesn't count.
    spend_rows(spend, ("2026-10-02", "anthropic", 1000, 400.0, 400.0), ("2026-10-29", "anthropic", 498, 199.5, 199.5),
               ("2026-09-30", "anthropic", 1250, 500.0, 500.0))
    run_one = Scripted()
    with pytest.raises(PassRefused, match=r"past \$600\.00 .* \$0\.50 remains"):
        await run_pass(config(runs=1, split="heldout"), deps(repo, run_one))   # two runs, $0.80
    assert run_one.calls == []
    assert len((await run_pass(config(runs=1, split="heldout", only=("atk-held",)), deps(repo, run_one))).runs) == 1


async def test_cumulative_budget_counts_claude_api_spend_only(repo):
    spend = repo / "spend.csv"
    # A Bedrock pass this month cost $500, of which $5 billed the Claude API (the kernel's checks).
    spend_rows(spend, ("2026-10-20", "bedrock", 1000, 5.0, 500.0), ("2026-10-21", "anthropic", 1485, 594.0, 594.0))
    # $1.00 remains, not nothing: an anthropic pass of two runs at the measured $0.40 a run fits.
    result = await run_pass(config(runs=1, split="heldout"), deps(repo, Scripted()))
    assert len(result.runs) == 2
    # With $0.80 left, a Bedrock pass estimated at $1.00 ($0.50 a run) starts: the guard counts its
    # measured Claude API share, $0.005 a run, not its whole cost.
    bedrock = await run_pass(config(runs=1, split="heldout", provider="bedrock", max_usd=10),
                             deps(repo, Scripted()))
    assert bedrock.estimate_usd == pytest.approx(1.0) and len(bedrock.runs) == 2
    rows = list(csv.DictReader(spend.open()))
    assert [row["provider"] for row in rows[-2:]] == ["anthropic", "bedrock"]
    with pytest.raises(PassRefused, match="remains"):     # the anthropic pass's $0.40 a run no longer fits
        await run_pass(config(runs=8, split="heldout"), deps(repo, Scripted()))


async def test_a_calibrations_spend_counts_against_the_month_but_measures_no_run(repo):
    from evals.tier2.passes import CALIBRATION_PREFIX, append_spend, measured_per_run, read_spend

    spend = repo / "spend.csv"
    # tier 2 passes measured $0.40 a run; a calibration's 300 model calls then cost $0.90
    spend_rows(spend, ("2026-10-02", "anthropic", 1497, 598.8, 598.8))
    append_spend(spend, {"pass_id": f"{CALIBRATION_PREFIX}soft-promise-tree-20261030-120000", "date": "2026-10-30",
                         "provider": "anthropic", "runs": 300, "desk_usd": 0.9, "simulator_usd": 0,
                         "claude_api_usd": 0.9, "total_usd": 0.9, "estimated_usd": 0})
    assert measured_per_run(read_spend(spend), "anthropic") == pytest.approx(0.40)   # not $0.33 a "run"
    # the calibration's $0.90 counts against the month: $0.30 remains, so two runs at $0.40 don't fit
    run_one = Scripted()
    with pytest.raises(PassRefused, match=r"this pass's \$0\.80 .* \$0\.30 remains"):
        await run_pass(config(runs=1, split="heldout"), deps(repo, run_one))
    assert run_one.calls == []


async def test_a_latency_row_counts_against_the_month_but_not_per_run(repo):
    """A latency run's spend row holds no tier 2 runs: the cost per run measured on either provider, in
    either column, leaves it out, so it moves no pass's estimate, but its dollars still count against
    this month's limit, for a pass and for the next latency run."""
    from evals.tier2.passes import append_spend, measured_per_run, read_spend, within_the_month

    spend = repo / "spend.csv"
    # Passes this month: anthropic at $0.40 a run; Bedrock at $0.50 a run, $0.005 of it the Claude API's.
    spend_rows(spend, ("2026-10-02", "anthropic", 1490, 596.0, 596.0), ("2026-10-03", "bedrock", 100, 0.5, 50.0))
    passes_only = read_spend(spend)
    for provider, claude_api, total in (("anthropic", 2.0, 2.0), ("bedrock", 0.5, 1.5)):
        append_spend(spend, {"pass_id": f"latency-20261029-120000-{provider[:6]}", "date": "2026-10-29",
                             "provider": provider, "runs": 0, "desk_usd": total, "simulator_usd": 0.0,
                             "claude_api_usd": claude_api, "total_usd": total, "estimated_usd": 0.0})
    rows = read_spend(spend)
    for provider, column, per_run in (("anthropic", "total_usd", 0.40), ("anthropic", "claude_api_usd", 0.40),
                                      ("bedrock", "total_usd", 0.50), ("bedrock", "claude_api_usd", 0.005)):
        assert measured_per_run(passes_only, provider, column) == pytest.approx(per_run)
        assert measured_per_run(rows, provider, column) == pytest.approx(per_run), (provider, column)
    assert measured_per_run(rows[2:], "anthropic") is None   # a latency row alone measures no run

    # The month: $596.50 of passes and $2.50 of latency runs, so $1.00 of the $600 remains.
    run_one = Scripted()
    with pytest.raises(PassRefused, match=r"this pass's \$1\.60 .* \$1\.00 remains"):   # four runs at $0.40
        await run_pass(config(runs=2, split="heldout"), deps(repo, run_one))
    assert run_one.calls == []
    with pytest.raises(PassRefused, match=r"this latency run's \$1\.05 .* \$1\.00 remains"):
        within_the_month(1.05, rows, NOW, repo, what="latency run")
    result = await run_pass(config(runs=1, split="heldout"), deps(repo, run_one))
    assert result.estimate_usd == pytest.approx(0.80) and len(result.runs) == 2   # two runs at $0.40


async def test_spend_is_shared_across_worktrees(repo, tmp_path):
    from evals.tests.eval_repo import git
    from evals.tier2.passes import shared_spend_file

    other = tmp_path / "other-worktree"
    git(repo, "worktree", "add", "-q", "-b", "plan/other", str(other))
    assert shared_spend_file(other) == shared_spend_file(repo) == (repo / ".git" / "desk-eval-spend.csv").resolve()
    shared = {key: value for key, value in vars(deps(repo)).items() if key != "spend_file"}
    await run_pass(config(runs=1, split="heldout"), PassDeps(**{**shared, "root": other, "spend_file": None}))
    rows = list(csv.DictReader(shared_spend_file(repo).open()))
    assert len(rows) == 1 and rows[0]["runs"] == "2" and float(rows[0]["claude_api_usd"]) == pytest.approx(0.2)
    spend_rows(shared_spend_file(repo), ("2026-10-29", "anthropic", 1497, 599.6, 599.6))
    with pytest.raises(PassRefused, match="remains"):   # a pass in the main checkout sees the worktree's spend
        await run_pass(config(runs=1, split="heldout"), PassDeps(**{**shared, "spend_file": None}))


async def test_infra_error_retried_once_and_recorded(repo):
    import json

    run_one = Scripted(errors={("atk-held", 1): ["infra"], ("leg-held", 1): ["infra", "infra"],
                               ("atk-cal", 1): ["timeout"]})
    result = await run_pass(config(runs=1), deps(repo, run_one))
    assert sorted(run_one.calls) == [("atk-cal", 1), ("atk-held", 1), ("atk-held", 1), ("leg-cal", 1),
                                     ("leg-held", 1), ("leg-held", 1)]   # a timeout is not retried
    status = {r.scenario_id: r.status for r in result.runs}
    assert status == {"atk-cal": "incomplete", "atk-held": "scored", "leg-cal": "scored", "leg-held": "incomplete"}
    out = repo / "evals" / "out" / "passes" / result.pass_id
    errors = [json.loads(line) for line in (out / "errors.jsonl").read_text().splitlines()]
    assert sorted((e["scenario_id"], e["attempt"], e["kind"], e["retried"]) for e in errors) == [
        ("atk-cal", 1, "timeout", False), ("atk-held", 1, "infra", True), ("leg-held", 1, "infra", True),
        ("leg-held", 2, "infra", False)]
    assert result.errors == 4
    transcripts = sorted(path.name for path in (out / "transcripts").iterdir())
    assert "atk-held-1-try1.json" in transcripts and "atk-held-1.json" in transcripts
    assert result.spend.total_usd == pytest.approx(0.6)   # every attempt is paid for


def watched_stack(events: list[str]) -> Any:
    """The stand-in stack, noting in `events` when it closes."""
    @asynccontextmanager
    async def stack(config: PassConfig) -> AsyncIterator[Stack]:
        try:
            yield Stack(target=object(), simulators={"attack": object(), "legit": object()})
        finally:
            events.append("stack closed")

    return stack


def spend_row(repo: Path) -> dict[str, str]:
    [row] = list(csv.DictReader((repo / "spend.csv").open()))
    return row


async def test_a_pricing_failure_is_charged_its_estimate_and_no_run_outlives_the_stack(repo):
    events: list[str] = []

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        # Four attempts at once, finishing out of order; the first to finish can't be priced.
        await asyncio.sleep({"atk-cal": 0, "leg-cal": 0.01, "atk-held": 0.02, "leg-held": 0.04}[scenario.id])
        events.append(f"finished {scenario.id}")
        return outcome(scenario, rep, kwargs["pass_id"])

    def cost(run: RunOutcome, providers: Any) -> Spend:
        if run.scenario_id == "atk-cal":
            raise KeyError("no price for this usage")
        return Spend.of(desk_usd=0.05, simulator_usd=0.05, claude_api_usd=0.10)

    result = await run_pass(config(runs=1, concurrency=4), deps(repo, run_one, cost=cost, stack=watched_stack(events)))
    assert events[-1] == "stack closed"
    assert sorted(events[:-1]) == ["finished atk-cal", "finished atk-held", "finished leg-cal", "finished leg-held"]
    row = spend_row(repo)   # three runs priced at $0.10 and the one that couldn't be, at the $0.40 estimate
    assert row["runs"] == "4" and float(row["total_usd"]) == pytest.approx(0.70)
    assert float(row["claude_api_usd"]) == pytest.approx(0.70) and float(row["desk_usd"]) == pytest.approx(0.55)
    assert result.spend.total_usd == pytest.approx(0.70)
    [estimated] = result.estimated_spend
    assert (estimated.scenario_id, estimated.rep, estimated.attempt, estimated.usd) == ("atk-cal", 1, 1, 0.40)
    assert "KeyError" in estimated.reason
    assert sorted((r.scenario_id, r.status) for r in result.runs) == [
        ("atk-cal", "scored"), ("atk-held", "scored"), ("leg-cal", "scored"), ("leg-held", "scored")]


async def test_a_run_with_no_usage_to_price_is_listed_as_estimated(repo):
    # A run that errored before its records were read leaves nothing to price: charged a run's estimate.
    def cost(run: RunOutcome, providers: Any) -> Spend | None:
        return None if run.scenario_id == "leg-held" else Spend.of(desk_usd=0.1, simulator_usd=0, claude_api_usd=0.1)

    result = await run_pass(config(runs=1), deps(repo, Scripted(errors={("leg-held", 1): ["timeout"]}), cost=cost))
    assert result.spend.total_usd == pytest.approx(0.70)
    assert [(e.scenario_id, e.attempt, e.usd, e.reason) for e in result.estimated_spend] == [
        ("leg-held", 1, 0.40, "it left no usage to price")]
    from evals.tier2.passes import load_pass

    assert load_pass(result.pass_id, repo).estimated_spend == result.estimated_spend


async def test_a_failing_pass_cancels_and_awaits_its_runs_before_the_stack_closes(repo):
    events: list[str] = []

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        if scenario.id == "atk-cal":
            # A directory stands where this run's transcript goes, so writing it fails: the harness fails mid-pass.
            transcripts = repo / "evals" / "out" / "passes" / kwargs["pass_id"] / "transcripts"
            (transcripts / f"{scenario.id}-{rep}.json").mkdir()
            return outcome(scenario, rep, kwargs["pass_id"])
        try:
            await asyncio.sleep(30)   # still running when atk-cal fails
        except asyncio.CancelledError:
            events.append(f"cancelled {scenario.id}")
            raise
        return outcome(scenario, rep, kwargs["pass_id"])

    with pytest.raises(IsADirectoryError):
        await run_pass(config(runs=1, concurrency=4), deps(repo, run_one, stack=watched_stack(events)))
    assert events[-1] == "stack closed"
    assert sorted(events[:-1]) == ["cancelled atk-held", "cancelled leg-cal", "cancelled leg-held"]
    row = spend_row(repo)   # atk-cal priced at $0.10 before it failed; the three cut short at the $0.40 estimate
    assert row["runs"] == "4" and float(row["total_usd"]) == pytest.approx(1.30)
    assert float(row["claude_api_usd"]) == pytest.approx(1.30)


async def test_spend_charged_as_an_estimate_is_marked(repo):
    """A run that left no usage to price is charged a run's estimate, and the pass's spend and its spend
    row say how much of the figure is that estimate (`estimated_usd`), so it never reads as measured; a
    pass whose runs were all priced marks none."""
    from evals.tier2.passes import read_spend

    unpriced = await run_pass(config(split="heldout"), deps(repo, cost=lambda outcome, providers: None))
    assert unpriced.spend.total_usd == pytest.approx(0.80) and unpriced.spend.estimated_usd == pytest.approx(0.80)
    priced = await run_pass(config(split="heldout"), deps(repo))
    assert priced.spend.estimated_usd == 0
    rows = read_spend(repo / "spend.csv")
    assert [(row["pass_id"], row["total_usd"], row["estimated_usd"]) for row in rows] == [
        (unpriced.pass_id, "0.8000", "0.8000"), (priced.pass_id, "0.2000", "0.0000")]


async def test_an_estimates_reason_is_masked_before_it_is_cut(repo):
    """A run whose usage can't be priced is charged its estimate with a reason that quotes the pricing
    error: its credentials are masked before the reason is cut to 300 characters, so a DSN crossing
    the cut is written with no part of its password."""
    from evals.tier2.passes import pass_dir

    def cost(outcome: RunOutcome, providers: Any) -> Spend:
        # The reason's opening (40) + 240 + "postgresql://u:" (15) puts the cut 5 characters into the password.
        raise ValueError("x" * 240 + "postgresql://u:Zq9xKw7vRt3Lm@db.example.invalid/prices")

    result = await run_pass(config(runs=1, split="heldout"), deps(repo, cost=cost))
    assert result.estimated_spend and all(len(row.reason) <= 300 for row in result.estimated_spend)
    assert all("Zq9" not in row.reason for row in result.estimated_spend)
    out = pass_dir(repo, result.pass_id)
    assert "Zq9" not in "".join(path.read_text() for path in sorted(out.rglob("*")) if path.is_file())


def test_a_spend_file_from_before_the_mark_gains_its_column(tmp_path):
    """A spend file whose header predates `estimated_usd` gets the column in place, under the lock,
    before the next row is appended, so the new row's mark lines up with its header; the rows written
    before say nothing about estimates, and every row's dollars still count."""
    from evals.tier2.passes import append_spend, read_spend

    spend = tmp_path / "desk-eval-spend.csv"
    spend.write_bytes(b"pass_id,date,provider,runs,desk_usd,simulator_usd,claude_api_usd,total_usd\r\n"   # as csv
                      b"earlier,2026-10-29,anthropic,240,60.0,36.0,96.0,96.0\r\n")                     # writes it
    append_spend(spend, {"pass_id": "later", "date": "2026-10-30", "provider": "anthropic", "runs": 2,
                         "desk_usd": "0.8000", "simulator_usd": "0.0000", "claude_api_usd": "0.8000",
                         "total_usd": "0.8000", "estimated_usd": "0.8000"})
    assert spend.read_bytes().split(b"\r\n")[0] == (
        b"pass_id,date,provider,runs,desk_usd,simulator_usd,claude_api_usd,total_usd,estimated_usd")
    earlier, later = read_spend(spend)
    assert earlier["total_usd"] == "96.0" and earlier["estimated_usd"] is None
    assert later["total_usd"] == "0.8000" and later["estimated_usd"] == "0.8000"


def test_a_spend_row_without_its_estimated_mark_is_refused_and_writes_nothing(tmp_path):
    """A row missing a column fails closed: never read as zero, and the file is left as it was."""
    from evals.tier2.passes import append_spend

    spend = tmp_path / "desk-eval-spend.csv"
    with pytest.raises(KeyError, match="estimated_usd"):
        append_spend(spend, {"pass_id": "p", "date": "2026-10-30", "provider": "anthropic", "runs": 1,
                             "desk_usd": 0.4, "simulator_usd": 0, "claude_api_usd": 0.4, "total_usd": 0.4})
    assert not spend.exists()


async def test_pending_scenarios_skipped_and_listed(tmp_path):
    from evals.tests.eval_repo import make_repo as repo_with

    repo = repo_with(tmp_path / "repo", landed=("master", "01a"))
    run_one = Scripted()
    # A run-free pass needs no stack, key or prices.
    result = await run_pass(config(runs=3), deps(repo, run_one, prices={}, keys={}, stack=None))
    assert run_one.calls == [] and result.runs == [] and result.spend.total_usd == 0
    assert result.pending == {"atk-cal": "02", "atk-held": "02", "leg-cal": "02", "leg-held": "02"}
    assert result.estimate_usd == 0 and not (repo / "spend.csv").exists()
    from evals.tier2.passes import load_pass

    assert load_pass(result.pass_id, repo) == result


async def test_each_run_gets_the_plans_landed_where_the_pass_runs(tmp_path):
    """What a run reads and which checks its verdict runs follow the pass's own `landed.toml` (before plan
    01b, say, no owner's Demo inbox), so every run gets the plans the pass loaded and records."""
    from evals.tests.eval_repo import make_repo as repo_with

    landed = ("master", "01a", "02a", "02")
    repo = repo_with(tmp_path / "repo", landed=landed)
    given: list[Any] = []

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        given.append(kwargs.get("landed"))
        return outcome(scenario, rep, kwargs["pass_id"])

    result = await run_pass(config(runs=1), deps(repo, run_one))
    assert result.landed == list(landed) and len(result.runs) == 4
    assert given == [list(landed)] * 4


async def test_runs_jsonl_names_each_runs_skipped_checks(repo):
    """A run's record in `runs.jsonl` lists the checks its verdict skipped because a plan hasn't landed,
    by the verdict's fixed names, so a row with no violation is never read as every check passed. A run
    that skipped none lists none, and an errored run, with no verdict, none either."""
    from evals.tier2.passes import load_pass
    from evals.tier2.verdict import SKIPPED_CHECKS

    before_01b = list(SKIPPED_CHECKS)[:2]   # the version caps and the owner's Demo inbox

    async def run_one(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        if scenario.id == "atk-cal":
            return outcome(scenario, rep, kwargs["pass_id"], error="timeout")
        return outcome(scenario, rep, kwargs["pass_id"], skipped=() if scenario.id == "leg-cal" else before_01b)

    result = await run_pass(config(runs=1), deps(repo, run_one))
    rows = {row["scenario_id"]: row for row in map(json.loads, (repo / "evals" / "out" / "passes" / result.pass_id
                                                                  / "runs.jsonl").read_text().splitlines())}
    assert {sid: row["skipped"] for sid, row in rows.items()} == {
        "atk-cal": [], "atk-held": before_01b, "leg-cal": [], "leg-held": before_01b}
    assert rows["atk-cal"]["status"] == "incomplete"
    assert load_pass(result.pass_id, repo) == result


async def test_pass_json_lists_the_gated_map_as_pairs_each_ending_in_its_path(tmp_path):
    """CI's secret scan reads a path that names an API or a key, then a colon or a comma, then a long value as a
    secret, so `pass.json` lists the gated map as `results.gated_pairs` does: [object id, path] pairs sorted by
    path. A pass.json from before, holding the map as an object, still loads."""
    from evals.results import gated_pairs
    from evals.tests.eval_repo import make_repo as repo_with
    from evals.tier2.passes import load_pass

    repo = repo_with(tmp_path / "repo", landed=("master", "01a"))
    result = await run_pass(config(runs=3), deps(repo, prices={}, keys={}, stack=None))   # run-free, as `MAX_USD=0`
    written = repo / "evals" / "out" / "passes" / result.pass_id / "pass.json"
    text = written.read_text()
    assert json.loads(text)["gated"] == gated_pairs(result.gated)
    assert json.loads(text)["gated"] == [[result.gated[path], path] for path in sorted(result.gated)]
    for gated_path in result.gated:   # each gated path ends its pair: never followed by a colon or a comma
        assert re.search(rf'"{re.escape(gated_path)}"\s*\]', text), gated_path
        assert not re.search(rf'"{re.escape(gated_path)}"\s*[:,]', text), gated_path
    assert load_pass(result.pass_id, repo) == result

    data = json.loads(text)
    written.write_text(json.dumps({**data, "gated": result.gated}))   # a pass.json from before: the object
    assert load_pass(result.pass_id, repo) == result
    pairs = data["gated"]
    for listed in (pairs + pairs[:1], pairs[::-1], {"pairs": pairs}, [[*pair, "extra"] for pair in pairs]):
        written.write_text(json.dumps({**data, "gated": listed}))
        with pytest.raises(ValueError, match="gated"):
            load_pass(result.pass_id, repo)


async def test_pass_without_prices_for_its_provider_refuses(repo):
    run_one = Scripted()
    anthropic_only = {"anthropic": ALL_MODELS}
    with pytest.raises(PassRefused, match="no list prices for bedrock claude-haiku-5-5, bedrock claude-opus-5-5"):
        await run_pass(config(provider="bedrock"), deps(repo, run_one, prices=anthropic_only))
    with pytest.raises(PassRefused, match="no list prices for anthropic claude-haiku-5-5"):
        await run_pass(config(), deps(repo, run_one, prices={}))
    # A Bedrock pass still needs the Claude API's prices for the kernel's checks.
    with pytest.raises(PassRefused, match="no list prices for anthropic claude-sonnet-5-5 in evals.pricing.PRICES"):
        await run_pass(config(provider="bedrock"), deps(repo, run_one, prices={"bedrock": ALL_MODELS}))
    assert run_one.calls == []
    dry = await run_pass(config(dry_run=True, max_usd=0), deps(repo, run_one, prices={}, keys={}))
    assert len(dry.runs) == 4 and dry.spend.total_usd == 0 and dry.providers.api == "fake"


async def test_record_rate_requires_sign_off_and_three_heldout_runs(repo, tmp_path):
    from evals.tests.eval_repo import make_repo as repo_with
    from evals.tier2.passes import record_rate

    three = await run_pass(config(runs=3, results=True), deps(repo))
    for who, why in (("", "First held-out run"), ("The owner", " ")):
        with pytest.raises(PassRefused, match="sign-off"):
            record_rate(three, signed_off_by=who, reason=why, root=repo, now=NOW)
    refusals = {
        "of 3 or more runs": await run_pass(config(runs=2, results=True), deps(repo)),
        "could write the results file, .* with --null-baseline": await run_pass(config(runs=3, null_baseline=True),
                                                                                 deps(repo)),
        "could write the results file, .* with --dry-run": await run_pass(config(runs=3, dry_run=True, max_usd=0),
                                                                           deps(repo)),
        "clean pass": await run_pass(config(runs=3, results=True),
                                     deps(repo, Scripted(errors={("leg-held", 2): ["timeout"]}))),
    }
    for match, finished in refusals.items():
        with pytest.raises(PassRefused, match=match):
            record_rate(finished, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    violating = await run_pass(config(runs=3, results=True), deps(repo, ViolatingRun(scenario="atk-cal")))
    with pytest.raises(PassRefused, match="clean pass"):
        record_rate(violating, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    # A whole results pass in which the held-out legitimate scenario waits for a plan: it has no runs to record.
    waiting = repo_with(tmp_path / "waiting", landed=("master", "01a"))
    run_free = await run_pass(config(runs=3, results=True), deps(waiting, prices={}, keys={}, stack=None))
    assert run_free.runs == [] and run_free.pending["leg-held"] == "02"
    with pytest.raises(PassRefused, match="doesn't cover the held-out legitimate suite: 3 runs missing, from leg-held"):
        record_rate(run_free, signed_off_by="The owner", reason="First held-out run", root=waiting, now=NOW)
    held = repo / "evals" / "tier2" / "scenarios" / "leg-held.yaml"
    held.write_text(held.read_text().replace("A crafted goal.", "Another goal."))
    with pytest.raises(PassRefused, match="held-out set changed"):
        record_rate(three, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    for root in (repo, waiting):    # nothing was recorded
        assert (root / "evals" / "recorded_rates.json").read_text() == '{"history": []}\n'


async def test_record_rate_refuses_a_pass_whose_runs_skipped_checks(tmp_path):
    """The recorded rate is the bar every later pass is held to, so it never comes from runs that
    skipped a check while a plan hadn't landed: they were never shown clean on it."""
    from evals.tests.eval_repo import make_repo as repo_with
    from evals.tier2.passes import record_rate
    from evals.tier2.verdict import SKIPPED_CHECKS

    repo = repo_with(tmp_path / "repo", landed=("master", "01a", "02a", "02"))   # plan 01b isn't landed

    async def before_01b(scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        return outcome(scenario, rep, kwargs["pass_id"], skipped=tuple(SKIPPED_CHECKS)[:2])

    skipping = await run_pass(config(runs=3, results=True), deps(repo, before_01b))
    with pytest.raises(PassRefused, match="^a rate is recorded only from a clean pass: no incomplete run, violation, "
                                          "skipped check or budget stop$"):
        record_rate(skipping, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    assert (repo / "evals" / "recorded_rates.json").read_text() == '{"history": []}\n'


async def test_record_rate_needs_a_heldout_legitimate_run(tmp_path):
    from evals.tests.eval_repo import make_repo as repo_with
    from evals.tier2.passes import record_rate

    # A whole, clean results pass on a suite whose held-out split holds no legitimate scenario: no rate to record.
    repo = repo_with(tmp_path / "repo", splits={"calibration": ["atk-cal", "leg-cal"], "heldout": ["atk-held"]})
    whole = await run_pass(config(runs=3, results=True), deps(repo))
    assert len(whole.runs) == 9 and not any(r.suite == "legit" and r.split == "heldout" for r in whole.runs)
    with pytest.raises(PassRefused, match=f"^pass {whole.pass_id} has no held-out legitimate run, so it has no rate "
                                          "to record$"):
        record_rate(whole, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    assert (repo / "evals" / "recorded_rates.json").read_text() == '{"history": []}\n'


@dataclass
class ViolatingRun(Scripted):
    """A clean run everywhere except `scenario`, whose runs break `money.no_rule`."""

    scenario: str = ""

    async def __call__(self, scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        self.calls.append((scenario.id, rep))
        return outcome(scenario, rep, violations=("money.no_rule",) if scenario.id == self.scenario else ())


async def test_record_rate_appends_history(repo):
    from evals.tests.eval_repo import commit
    from evals.tier2.passes import record_rate
    from evals.tier2.suite import load_recorded_rates

    first = await run_pass(config(runs=3, results=True), deps(repo))
    rate = record_rate(first, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    commit(repo, "the first recorded rate")
    assert (rate.trials, rate.completion_point) == (3, 1.0)       # leg-held, three runs
    assert rate.completion_lower_95 == round(wilson_lower_95_of(3, 3), 3)
    assert rate.provider == "anthropic" and rate.run_id == first.pass_id
    assert rate.model_ids["api"] == "claude-opus-5-5" and rate.model_ids["simulator"] == "claude-sonnet-5-5"
    assert rate.report == f"evals/reports/2026-10-30-{first.pass_id}.md"
    later = NOW.replace(day=31)
    bedrock = await run_pass(config(runs=3, provider="bedrock"), deps(repo, now=lambda: later))
    with pytest.raises(PassRefused, match="isn't gating evidence: it ran the API on bedrock"):
        record_rate(bedrock, signed_off_by="The owner", reason="Bedrock run", root=repo, now=later)
    second = await run_pass(config(runs=3, results=True), deps(repo, now=lambda: later))
    record_rate(second, signed_off_by="The owner", reason="Second held-out run", root=repo, now=later)
    commit(repo, "the second recorded rate")
    history = load_recorded_rates(repo / "evals" / "recorded_rates.json").history
    assert [entry.run_id for entry in history] == [first.pass_id, second.pass_id]
    assert history[0] == rate and history[1].provider == "anthropic"
    assert history[1].model_ids["api"] == "claude-opus-5-5"
    with pytest.raises(ValueError):    # history only grows at its end
        record_rate(first, signed_off_by="The owner", reason="Again", root=repo, now=NOW)


async def test_record_rate_needs_a_claude_api_pass_on_the_production_models(repo):
    from evals.tier2.passes import PassProviders, record_rate

    rates_file = repo / "evals" / "recorded_rates.json"
    bedrock = await run_pass(config(runs=3, provider="bedrock"), deps(repo))
    with pytest.raises(PassRefused, match=f"pass {bedrock.pass_id} isn't gating evidence: it ran the API on bedrock, "
                                          "the simulator on bedrock; .*only from a pass on the Claude API"):
        record_rate(bedrock, signed_off_by="The owner", reason="A Bedrock run", root=repo, now=NOW)
    anthropic_pass = await run_pass(config(runs=3, results=True), deps(repo))
    for named, change in {
        "it ran the simulator on bedrock": {
            "providers": PassProviders(api="anthropic", simulator="bedrock", kernel_checks="anthropic")},
        "conversation on claude-opus-4-1, not claude-opus-5-5": {
            "model_ids": {**anthropic_pass.model_ids, "conversation": "claude-opus-4-1"}},
        "the simulator was served by claude-sonnet-5, not one of the production models": {
            "served_models": {**anthropic_pass.served_models, "simulator": ["claude-sonnet-5", "claude-sonnet-5-5"]}},
        "the kernel's checks were served by claude-haiku-4-5, not one of the production models": {
            "served_models": {**anthropic_pass.served_models, "kernel_checks": ["claude-haiku-4-5"]}},
    }.items():
        with pytest.raises(PassRefused,
                           match=f"pass {anthropic_pass.pass_id} isn't gating evidence: .*{re.escape(named)}"):
            record_rate(anthropic_pass.model_copy(update=change), signed_off_by="The owner",
                        reason="First held-out run", root=repo, now=NOW)
    assert rates_file.read_text() == '{"history": []}\n'   # nothing was recorded
    rate = record_rate(anthropic_pass, signed_off_by="The owner", reason="First held-out run", root=repo, now=NOW)
    assert rate.provider == "anthropic"
    assert rate.model_ids == {"api": "claude-opus-5-5", "simulator": "claude-sonnet-5-5", **anthropic_pass.model_ids}


def wilson_lower_95_of(k: int, n: int) -> float:
    from evals.gate import wilson_lower_95

    return wilson_lower_95(k, n)


async def test_results_require_the_in_process_stack(repo):
    from evals.results import ResultsRefused, results_file
    from evals.tier2.schema import RecordedRates

    external = {"base_url": "https://desk.example.invalid", "records_dsn": "postgresql+asyncpg://reader@db/desk"}
    run_one = Scripted()
    with pytest.raises(PassRefused, match="--base-url"):
        await run_pass(config(results=True, **external), deps(repo, run_one))
    assert run_one.calls == []
    explored = await run_pass(config(**external), deps(repo, Scripted()))
    assert explored.providers.api == "unknown"
    with pytest.raises(ResultsRefused, match="--base-url"):
        results_file(explored, RecordedRates(history=[]), root=repo)


async def test_a_results_pass_refuses_before_any_run_what_its_export_would(repo, monkeypatch):
    """What a --results pass's export would refuse that is known before a run refuses the pass before
    the kernel build and the first run, so a paid pass is never wasted on it: rates that don't load, a
    current rate that isn't gating evidence (a hand-edited rate from a pass on Bedrock), and model ids
    that aren't the production ones."""
    from evals.tests.eval_repo import commit, write
    from evals.tier2 import passes
    from evals.tier2.schema import RecordedRate, RecordedRates

    bedrock = RecordedRate(
        run_id="sunday", recorded_at=NOW, completion_point=0.879, completion_lower_95=0.800, trials=99,
        heldout_sha256="a" * 64, provider="bedrock",
        model_ids={"api": "claude-opus-5-5", "simulator": "claude-sonnet-5-5"},
        report="evals/reports/2026-11-01-sunday.md", reason="First held-out run", signed_off_by="The owner")
    built: list[str] = []
    for rates_text, reason in (("{\"history\": [", "recorded_rates.json"),
                               (RecordedRates(history=[bedrock]).model_dump_json(), "it was recorded on bedrock")):
        write(repo, "evals/recorded_rates.json", rates_text)
        commit(repo, "a hand-edited recorded rate")
        run_one = Scripted()
        with pytest.raises(PassRefused, match=reason):
            await run_pass(config(results=True), deps(repo, run_one, build_kernel=lambda: built.append("kernel")))
        assert run_one.calls == [] and built == [], reason
        assert not (repo / "spend.csv").exists()
    write(repo, "evals/recorded_rates.json", '{"history": []}\n')
    commit(repo, "the empty rate history")
    real_ids = passes.pass_model_ids
    monkeypatch.setattr(passes, "pass_model_ids",
                        lambda config: {**real_ids(config), "conversation": "claude-opus-4-1"})
    run_one = Scripted()
    with pytest.raises(PassRefused, match="conversation on claude-opus-4-1, not claude-opus-5-5"):
        await run_pass(config(results=True), deps(repo, run_one, build_kernel=lambda: built.append("kernel")))
    assert run_one.calls == [] and built == []
    monkeypatch.setattr(passes, "pass_model_ids", real_ids)
    assert len((await run_pass(config(results=True), deps(repo))).runs) == 4


async def test_a_pass_never_writes_the_records_password(repo, monkeypatch, capsys):
    from pydantic import ValidationError

    from evals.run import tier2_config
    from evals.tier2.passes import load_pass

    # A password in the URL (percent-encoded, as a DSN holds one with an @) and one in its query, which the
    # database driver reads too.
    dsn = "postgresql+asyncpg://desk_api:s3cret%40pass@db.example.invalid:5432/desk?ssl=require&password=query-secret"
    external = await run_pass(config(base_url="https://desk.example.invalid", records_dsn=dsn), deps(repo))
    assert external.config.records_dsn == dsn             # the pass itself read its records with the password
    out = repo / "evals" / "out" / "passes" / external.pass_id
    written = "".join(path.read_text() for path in sorted(out.rglob("*")) if path.is_file())
    assert "records_dsn" in written
    assert not [secret for secret in ("s3cret", "%40pass", "query-secret") if secret in written]
    stored = load_pass(external.pass_id, repo).config.records_dsn
    assert stored == "postgresql+asyncpg://desk_api:***@db.example.invalid:5432/desk?ssl=require"
    # A DSN that isn't a database URL, or whose password the parser would read only in part, is refused before
    # the pass, so nothing unparsed is ever written, and neither the refusal nor the command line's error shows
    # any of the password: one missing its @host (the parser reads the password as a port) and three with an
    # unencoded @ in the password, whose tail would otherwise be written as the host or the database.
    monkeypatch.setenv("MODEL_PROVIDER", "anthropic")
    refusals = {
        "host=db password=s3cret": "--records-dsn needs a database URL",
        "postgresql+asyncpg://desk_api:s3cret/desk": "--records-dsn needs a database URL",
        "postgresql+asyncpg://desk_api:s3cret@t4il@db.example.invalid/desk": "percent-encode",
        "postgresql+asyncpg://desk_api:s3cret@t4il/x@db.example.invalid/desk": "percent-encode",
        "postgresql+asyncpg://desk_api:s3cret@t4il?x@db.example.invalid/desk": "percent-encode",
    }
    for given, reason in refusals.items():
        with pytest.raises(ValidationError, match=reason) as refused:
            config(base_url="https://desk.example.invalid", records_dsn=given)
        assert not [secret for secret in ("s3cret", "t4il") if secret in str(refused.value)], given
        with pytest.raises(SystemExit):
            tier2_config(["--runs", "1", "--max-usd", "0", "--base-url", "https://desk.example.invalid",
                          "--records-dsn", given])
        printed = capsys.readouterr()
        assert reason in printed.err, given
        assert not [secret for secret in ("s3cret", "t4il") if secret in printed.out + printed.err], given
    with pytest.raises(ValidationError, match="--base-url and --records-dsn go together") as refused:
        config(records_dsn=dsn)
    assert "s3cret" not in str(refused.value)


@dataclass
class CommitsMidPass(Scripted):
    """A clean run that first commits an ungated change, as someone working during a long pass would."""

    root: Path = Path()

    async def __call__(self, scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        from evals.tests.eval_repo import commit, write

        write(self.root, "README.md", f"Edited during {scenario.id} run {rep}.\n")
        commit(self.root, "an ungated change during the pass")
        return await super().__call__(scenario, rep, target, simulator, **kwargs)


async def test_pass_records_the_commit_it_started_on(repo):
    from evals.tests.eval_repo import git

    started = git(repo, "rev-parse", "HEAD")
    result = await run_pass(config(split="heldout"), deps(repo, CommitsMidPass(root=repo)))
    assert git(repo, "rev-parse", "HEAD") != started
    assert result.git_sha == started        # the commit whose gated inputs the pass ran on


@dataclass
class SeesAnswering(Scripted):
    """A clean run that notes the Answering switch each scenario was run with."""

    answering: dict[str, bool] = field(default_factory=dict)

    async def __call__(self, scenario: Any, rep: int, target: Any, simulator: Any, **kwargs: Any) -> RunOutcome:
        self.answering[scenario.id] = scenario.setup.answering
        return await super().__call__(scenario, rep, target, simulator, **kwargs)


async def test_null_baseline_turns_answering_off_for_legitimate_runs_only(repo):
    null = SeesAnswering()
    await run_pass(config(null_baseline=True), deps(repo, null))
    assert null.answering == {"atk-cal": True, "atk-held": True, "leg-cal": False, "leg-held": False}
    plain = SeesAnswering()
    await run_pass(config(), deps(repo, plain))
    assert plain.answering == {"atk-cal": True, "atk-held": True, "leg-cal": True, "leg-held": True}


async def test_pass_reads_its_commit_before_building_the_kernel(repo, monkeypatch):
    """A results pass names the commit it loaded its suite, splits and landed plans from: it reads the sha
    right after the clean-tree check, before the credential and price checks and the kernel build, so a
    commit made while `make kernel` runs isn't the one the pass names."""
    from evals import results
    from evals.tests.eval_repo import commit, git, write

    steps: list[str] = []
    git_of = results.git

    def logged_git(root: Path, *args: str, **kwargs: Any) -> str:
        if args == ("rev-parse", "--verify", "HEAD^{commit}"):
            steps.append("sha")
        return git_of(root, *args, **kwargs)

    def build_kernel() -> None:
        steps.append("build")
        write(repo, "README.md", "Edited while the kernel built.\n")
        commit(repo, "an ungated change during the kernel build")

    monkeypatch.setattr(results, "git", logged_git)
    started = git(repo, "rev-parse", "HEAD")
    logged = deps(repo, build_kernel=build_kernel,
                  credential=lambda name: steps.append("credential") or KEYS.get(name))
    logged.prices = lambda: steps.append("prices") or PRICES
    result = await run_pass(config(results=True), logged)
    assert list(dict.fromkeys(steps)) == ["sha", "credential", "prices", "build"]
    assert git(repo, "rev-parse", "HEAD") != started and result.git_sha == started
