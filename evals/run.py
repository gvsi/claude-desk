"""Run an eval tier from the repository root.

    python -m evals.run tier1 [--target stub|kernel|api] [pytest args]
    python -m evals.run simulator-check --provider anthropic|bedrock
    python -m evals.run tier2 --suite attack|legit|all --split calibration|heldout|all --runs N --max-usd X
        [--only ids] [--concurrency 4] [--dry-run] [--null-baseline] [--results] [--base-url URL --records-dsn DSN]
    python -m evals.run gate --pass <id> [--final]
    python -m evals.run waiver-review --pass <id>
    python -m evals.run waive --pass <id> --message <id> [--message <id>] --reason "<text>" --signed-off-by "<name>"
    python -m evals.run results --pass <id>
    python -m evals.run record-rate --pass <id> --signed-off-by "<name>" --reason "<text>" [--lower-bar]
    python -m evals.run key
    python -m evals.run results-check --base <ref> [--history-since <rev>]
    python -m evals.run merge-ready [--head <ref>]
    python -m evals.run calibrate --pass <id> [--write] [--owner-approved "<name>"]
    python -m evals.run latency --max-usd X [--turns 20] [--base-url URL] [--dry-run] [--pass <id>]
    python -m evals.run report --pass <id> [--null-baseline <id>]

With no test paths among the pytest args, `tier1` runs all of `evals/tier1`. It exits non-zero
when pytest does, when no case was collected, or when the run left no summary or a summary with a
failure in it.

`simulator-check` makes one simulated-visitor turn on the provider, through the refusal fallback
middleware with that provider's `SIMULATOR_FALLBACK_BETAS` entry (`evals/tier2/simulator.py`), for
well under $0.05: exit 0 when it is served, 1 when the API answers an error, naming the
`anthropic-beta` header when the error does.

`tier2` runs a pass (`evals/tier2/passes.py`) with `MODEL_PROVIDER` (the environment, else `.env`;
`anthropic` when unset) as its provider, and with `--results` writes `evals/results/<inputs>.json`
(only on `anthropic`: gating evidence comes from the Claude API with the production 5.5 models);
it prints the pass's summary and gate (whose summary line counts the runs that skipped checks while a
plan hadn't landed, then a line names each such check and its runs, as `gate` prints them too), then
the export's refusal if the file is refused, and exits
1 when the pass or its export is refused or its gate fails. `gate`, `results` and `record-rate` read a
finished pass from `evals/out/passes/<id>/` and make no model calls; `results`, `record-rate` and
`gate --final` refuse a pass that isn't gating evidence and accept only a `--results` pass, read from
what the pass recorded rather than its `config.results` alone; `gate --final` and `record-rate`
accept only a whole pass (no `--only`, `--dry-run`, `--null-baseline` or `--base-url`) at the head's
gated inputs, reconciled with the head as `results-check` would (`evals.results.reconcile_pass`,
which `final_gate` and `record_rate` share). `record-rate` never lowers the completion bar on the same
held-out set unless `--lower-bar` is given, and then marks the entry `lowered` and says so; a miss is
fixed in the Desk, not by lowering its bar. `key` prints the inputs key
(`make evals-key`), and `results-check` is the check CI runs (`make evals-results-check`), with no
database, network or key: exit 0 when unchanged inputs or complete passing results permit it, or
every head scenario is pending (no recorded rate); otherwise exit 1, the reason on stdout.
`merge-ready` checks the head (default HEAD) against origin/main from their merge base, with no
network or model call: exit 0 when ready, 1 when both sides changed results inputs and a scenario
can run under their combined landed plans or in their merge, or a recorded rate prevents the
unarmed shortcut. It also exits 1 on a merge conflict, or when the merge has other than exactly one
Alembic head; other check errors exit 2.

`calibrate` (`evals/calibrate.py`) proposes each effect's reviewer thresholds from a finished
calibration pass and writes its report with no model call: `evals/reports/calibration-v<N>.md` when a
row changes, else `calibration-<pass_id>.md` (never over one already there), and under
`evals/out/reports/` for a dry run, a null baseline, a pass that isn't gating evidence (on the Claude
API with the production 5.5 models, `evals.results.gating_refusal`) or one that doesn't stand for the
whole calibration split at its commit (made with `--only` or a `--suite` other than `all`, stopped by
its budget, started with an uncommitted gated change or no record of its start, or without one judged
run of every calibration scenario and repetition, `evals.results.selection_problems`), the report
saying why; it refuses a pass of any other split. `--write` also rewrites the calibrated block of
`backend/desk/kernel_service/review_thresholds.py` when a row changes (never from a pass whose report
stays under `evals/out/reports/`, which it refuses, writing nothing), and a `charge` or `pay_out` row
looser than the kernel's initial one needs `--owner-approved`. It exits 1 when refused, with the
reason on stdout.

`latency` (`evals/latency.py`) makes `--turns` visitor turns each of a plain question, a quote and a
booking, each kind in its own copy, on the in-process stack built from this tree (its API on
`MODEL_PROVIDER`; every model scripted with `--dry-run`) or on the deployment at `--base-url`, and
writes `evals/out/latency/<id>.json`, its numbers labelled `local` or `hosted` and `--pass` naming the
pass they are for. A real run starts no turn once its calls cost `--max-usd`, read from records it can
trust, and appends what they cost to the shared spend file; a run on the deployment is refused, since
the deployment reports no usage of its conversation's calls it could stop by. It exits 1 when the run
is refused or measured nothing it can report.

`report` (`evals/report.py`) writes the report of a finished pass with no model call: under
`evals/reports/`, `<date>-<pass_id>.md`, `latest.json` and this month's rows of the shared spend file as
`spend.csv`, and the latest results in `docs/evals.md`. It reads the pass's runs and transcripts, the
gate over its rows, the current recorded rate, the usage of its judged legitimate runs, the latest local
and hosted latency runs whose `--pass` named it (never a dry run's; without one the report says latency
wasn't measured; each part names its run, and a hosted run's provider stays unknown, as it recorded it),
the thresholds' calibration at the pass's commit and, with `--null-baseline`, a
null-baseline pass that judged exactly the held-out legitimate tasks the pass ran (no `--only`, no stop
at its budget). Only a whole `--results` pass becomes the latest report: `--suite all --split all`
with no `--only`, not stopped by its budget, gating evidence (on the Claude API with the production
5.5 models, `evals.results.gating_refusal`), holding one judged run of every scenario and repetition
less the pending ones, its rows reconciled one by one with the suite at its commit
(`evals.results.selection_problems`), and standing for its commit by what it recorded before its
runs: no uncommitted gated change, the kernel built from that tree and its commit's gated inputs
(`evals.results.unchecked_refusal`). Its null baseline must be gating evidence too, and it reads a
local latency run only when the run measured the API on the Claude API at the pass's commit; it
leaves out any other and says why (`evals.report.latency_left_out`). Any other pass,
such as a pass on Bedrock, a held-out-split pass or one with an errored run, gets its report alone,
under `evals/out/reports/`, and the command says why. A dry run, a null-baseline pass, a pass with no
run, a null baseline that isn't gating evidence for a report that would become the latest, or anything
it can't read whole is refused: exit 1, the reason on stdout, nothing written.
"""

import argparse
import asyncio
import json
import sys
from datetime import UTC, date
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from evals.tier1.harness import SUMMARY_FILE, TARGETS, TIER1_DIR

if TYPE_CHECKING:
    from evals.latency import LatencyConfig, LatencyDeps
    from evals.report import Calibration, NullBaseline, ReportLatency, ReportRun, SpendRow
    from evals.tier2.artifact import RunArtifact
    from evals.tier2.passes import PassConfig, PassResult
    from evals.tier2.suite import Suite

EVALS_DIR = Path(__file__).resolve().parent


def tier1(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.run tier1", allow_abbrev=False)
    parser.add_argument("--target", choices=TARGETS, default="kernel")
    options, pytest_args = parser.parse_known_args(argv)
    selected = any(Path(arg.split("::")[0]).exists() for arg in pytest_args if not arg.startswith("-"))
    SUMMARY_FILE.unlink(missing_ok=True)
    args = ["-c", str(EVALS_DIR / "pytest.ini"), "--target", options.target, *pytest_args]
    code = pytest.main(args if selected else [*args, str(TIER1_DIR)])
    if code == pytest.ExitCode.NO_TESTS_COLLECTED:
        print("tier 1 collected no cases", file=sys.stderr)
        return int(code)
    if not SUMMARY_FILE.is_file():
        print("tier 1 wrote no summary", file=sys.stderr)
        return int(code) or 1
    if code == pytest.ExitCode.OK and json.loads(SUMMARY_FILE.read_text())["failed"]:
        return 1
    return int(code)


def simulator_check(argv: list[str]) -> int:
    from evals.tier2 import simulator

    parser = argparse.ArgumentParser(prog="python -m evals.run simulator-check", allow_abbrev=False)
    parser.add_argument("--provider", choices=simulator.PROVIDERS, required=True)
    options = parser.parse_args(argv)
    return asyncio.run(simulator.simulator_check(options.provider))


def tier2_config(argv: list[str]) -> "PassConfig":
    """The pass `tier2` was asked for; the provider is `MODEL_PROVIDER`."""
    from evals.tier2.passes import PassConfig, credential

    parser = argparse.ArgumentParser(prog="python -m evals.run tier2", allow_abbrev=False)
    parser.add_argument("--suite", choices=("attack", "legit", "all"), default="all")
    parser.add_argument("--split", choices=("calibration", "heldout", "all"), default="all")
    parser.add_argument("--runs", type=int, required=True)
    parser.add_argument("--max-usd", type=float, required=True)
    parser.add_argument("--only", action="append", default=[], help="scenario ids, comma-separated or repeated")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--null-baseline", action="store_true")
    parser.add_argument("--results", action="store_true")
    parser.add_argument("--base-url")
    parser.add_argument("--records-dsn")
    options = parser.parse_args(argv)
    provider = credential("MODEL_PROVIDER") or "anthropic"
    if provider not in ("anthropic", "bedrock"):
        parser.error(f"MODEL_PROVIDER is anthropic or bedrock, not {provider!r}")
    only = tuple(dict.fromkeys(sid.strip() for group in options.only for sid in group.split(",") if sid.strip()))
    try:
        return PassConfig(suite=options.suite, split=options.split, runs=options.runs, max_usd=options.max_usd,
                          only=only, concurrency=options.concurrency, dry_run=options.dry_run,
                          null_baseline=options.null_baseline, results=options.results, base_url=options.base_url,
                          records_dsn=options.records_dsn, provider=provider)
    except ValueError as error:
        parser.error(str(error))


def tier2(argv: list[str]) -> int:
    from evals.gate import gate
    from evals.results import ResultsRefused, write_results
    from evals.tier2.passes import PassRefused, run_pass
    from evals.tier2.suite import load_recorded_rates

    config = tier2_config(argv)
    try:
        result = asyncio.run(run_pass(config))
    except PassRefused as refused:
        print(f"tier2: {refused}")
        return 1
    # What the pass did and its gate are printed whatever the export says, so a refused results file (a pass its
    # budget stopped, say) still shows the runs, the spend and why runs are missing.
    rates = load_recorded_rates()
    judged = gate(result, rates)
    print(f"tier2: pass {result.pass_id}: {len(result.runs)} runs, {len(result.pending)} scenarios pending, "
          f"{result.errors} errors, ${result.spend.total_usd:.2f} spent (estimate ${result.estimate_usd:.2f}), "
          f"providers {result.providers.model_dump()}")
    _print_gate(judged)
    if config.results:
        try:
            written = write_results(result, rates)
        except ResultsRefused as refused:
            print(f"tier2: {refused}")
            return 1
        print(f"tier2: wrote {written.relative_to(EVALS_DIR.parent)}")
    return 0 if judged.passed else 1


def _print_gate(judged: Any) -> None:
    """The gate's summary line, which counts the runs that skipped checks while a plan hadn't landed, then a
    line for each check they skipped and one for each reason the gate failed."""
    from evals.gate import skipped_summary, violation_summary

    point = "none" if judged.completion_point is None else f"{judged.completion_point:.3f}"
    recorded = ("none" if judged.recorded_lower_95 is None
                else f"{judged.recorded_lower_95:.3f} ({judged.recorded_provider})")
    skipped = (f"; {skipped_summary(len(judged.skipped_runs), judged.skipped_checks)}" if judged.skipped_runs
               else "")
    print(f"gate: {'passed' if judged.passed else 'failed'}; held-out legitimate completion {point} over "
          f"{judged.completion_trials} runs ({judged.provider}), recorded {recorded}; "
          f"{violation_summary(judged)}{skipped}")
    for check, runs in judged.skipped_checks.items():
        print(f"gate: in {runs} runs, {check}")
    for reason in judged.reasons:
        print(f"gate: {reason}")


def _pass_parser(prog: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"python -m evals.run {prog}", allow_abbrev=False)
    parser.add_argument("--pass", dest="pass_id", required=True)
    return parser


def gate_command(argv: list[str]) -> int:
    from evals.gate import gate
    from evals.results import ResultsRefused, final_gate
    from evals.tier2.passes import PassRefused, load_pass
    from evals.tier2.suite import load_recorded_rates
    from evals.waivers import WaiverRefused, checked_waivers, load_waivers

    parser = _pass_parser("gate")
    parser.add_argument("--final", action="store_true")
    options = parser.parse_args(argv)
    try:
        finished, rates = load_pass(options.pass_id), load_recorded_rates()
        if options.final:
            judged = final_gate(finished, rates)
        else:
            waivers = checked_waivers(finished, load_waivers(EVALS_DIR.parent), root=EVALS_DIR.parent)
            judged = gate(finished, rates, waivers=waivers)
    except (PassRefused, ResultsRefused, WaiverRefused, OSError, ValueError) as refused:
        print(f"gate: {refused}")
        return 1
    _print_gate(judged)
    return 0 if judged.passed else 1


def waiver_review_command(argv: list[str]) -> int:
    from evals.tier2.passes import PassRefused, load_pass
    from evals.waivers import write_review

    options = _pass_parser("waiver-review").parse_args(argv)
    try:
        path = write_review(load_pass(options.pass_id), root=EVALS_DIR.parent)
    except (PassRefused, OSError, ValueError) as refused:
        print(f"waiver-review: {refused}")
        return 1
    print(f"waiver-review: {path.read_text().splitlines()[2]} Wrote {path.relative_to(EVALS_DIR.parent)}")
    return 0


def waive_command(argv: list[str]) -> int:
    from evals.tier2.passes import PassRefused
    from evals.waivers import sign_waivers

    parser = _pass_parser("waive")
    parser.add_argument("--message", action="append", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--signed-off-by", required=True)
    options = parser.parse_args(argv)
    try:
        entries = sign_waivers(options.pass_id, options.message, reason=options.reason,
                               signed_off_by=options.signed_off_by, root=EVALS_DIR.parent)
    except (PassRefused, OSError, ValueError) as refused:
        print(f"waive: {refused}")
        return 1
    print(f"waive: appended {len(entries)} waivers for pass {options.pass_id}, signed by {entries[0].signed_off_by}")
    return 0


def results_command(argv: list[str]) -> int:
    from evals.results import ResultsRefused, write_results
    from evals.tier2.passes import PassRefused, load_pass
    from evals.tier2.suite import load_recorded_rates

    options = _pass_parser("results").parse_args(argv)
    try:
        written = write_results(load_pass(options.pass_id), load_recorded_rates())
    except (PassRefused, ResultsRefused, OSError, ValueError) as refused:
        print(f"results: {refused}")
        return 1
    print(f"results: wrote {written.relative_to(EVALS_DIR.parent)}")
    return 0


def record_rate_command(argv: list[str]) -> int:
    from evals.gate import gate, waiver_summary
    from evals.results import GitError, ResultsRefused, checked_committed_waivers, lowered_notice
    from evals.tier2.passes import PassRefused, load_pass, record_rate
    from evals.tier2.schema import RecordedRates

    parser = _pass_parser("record-rate")
    parser.add_argument("--signed-off-by", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--lower-bar", action="store_true")
    options = parser.parse_args(argv)
    try:
        finished = load_pass(options.pass_id)
        waivers = checked_committed_waivers(finished, root=EVALS_DIR.parent)
        judged = gate(finished, RecordedRates(history=[]), waivers=waivers)
        rate = record_rate(finished, signed_off_by=options.signed_off_by, reason=options.reason,
                           lower_bar=options.lower_bar)
    except (OSError, ValueError, GitError, PassRefused, ResultsRefused) as refused:
        print(f"record-rate: {refused}")
        return 1
    lowered = f"; {notice}" if (notice := lowered_notice(rate)) else ""
    waived = f"; {waiver_summary(judged)}" if judged.waived_violations else ""
    print(f"record-rate: recorded {rate.completion_lower_95:.3f} (point {rate.completion_point:.3f} over "
          f"{rate.trials} held-out legitimate runs, {rate.provider}) from pass {rate.run_id}{waived}{lowered}; run "
          f"results --pass {rate.run_id} to re-export the results file")
    return 0


def key(argv: list[str]) -> int:
    from evals.results import inputs_key

    argparse.ArgumentParser(prog="python -m evals.run key", allow_abbrev=False).parse_args(argv)
    print(inputs_key())
    return 0


def results_check(argv: list[str]) -> int:
    from evals.results import results_check as check

    parser = argparse.ArgumentParser(prog="python -m evals.run results-check", allow_abbrev=False)
    parser.add_argument("--base", required=True)
    parser.add_argument("--history-since")
    options = parser.parse_args(argv)
    passed, reason = check(options.base, history_since=options.history_since)
    print(f"results-check: {reason}")
    return 0 if passed else 1


def merge_ready(argv: list[str], *, root: Path | None = None) -> int:
    from evals.results import REPO_ROOT, GitError
    from evals.results import merge_ready as check

    parser = argparse.ArgumentParser(prog="python -m evals.run merge-ready", allow_abbrev=False)
    parser.add_argument("--head", default="HEAD")
    options = parser.parse_args(argv)
    try:
        ready, reason = check(options.head, root if root is not None else REPO_ROOT)
    except (GitError, OSError, UnicodeError) as error:
        print(f"merge-ready: error: {' '.join(str(error).splitlines())}")
        return 2
    print(f"merge-ready: {reason}")
    return 0 if ready else 1


def calibrate_command(argv: list[str], *, root: Path | None = None) -> int:
    from evals.calibrate import CalibrationRefused, calibrate
    from evals.tier2.passes import REPO_ROOT

    parser = _pass_parser("calibrate")
    parser.add_argument("--write", action="store_true", help="rewrite the calibrated block of the thresholds file")
    parser.add_argument("--owner-approved", metavar="NAME",
                        help="the owner who approved writing a charge or pay_out row looser than its initial values")
    options = parser.parse_args(argv)
    if options.owner_approved is not None and not options.write:
        parser.error("--owner-approved goes with --write")
    root = root or REPO_ROOT
    try:
        done = calibrate(options.pass_id, root=root, write=options.write, owner_approved=options.owner_approved)
    except CalibrationRefused as refused:
        print(f"calibrate: {refused}")
        return 1
    for effect, row in done.proposal.table.items():
        print(f"calibrate: {effect} {row.min_within_charter_bp} / {row.max_manipulation_bp} "
              f"({done.proposal.notes[effect]})")
    if done.written:
        print(f"calibrate: wrote the thresholds as version {done.version}; run make proofs and make evals-tier1 "
              "before committing them")
    print(f"calibrate: wrote {done.report.relative_to(root)}")
    return 0


def latency_config(argv: list[str]) -> "LatencyConfig":
    """The latency run asked for; the in-process stack's provider is `MODEL_PROVIDER`."""
    from evals.latency import LatencyConfig
    from evals.tier2.passes import credential

    parser = argparse.ArgumentParser(prog="python -m evals.run latency", allow_abbrev=False)
    parser.add_argument("--turns", type=int, default=20, help="turns of each kind")
    parser.add_argument("--max-usd", type=float, required=True)
    parser.add_argument("--base-url", help="the hosted deployment; the in-process stack when left out")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pass", dest="pass_id", help="the pass these numbers are for")
    options = parser.parse_args(argv)
    provider = credential("MODEL_PROVIDER") or "anthropic"
    if provider not in ("anthropic", "bedrock"):
        parser.error(f"MODEL_PROVIDER is anthropic or bedrock, not {provider!r}")
    try:
        return LatencyConfig(turns=options.turns, max_usd=options.max_usd, base_url=options.base_url,
                             dry_run=options.dry_run, provider=provider, pass_id=options.pass_id)
    except ValueError as error:
        parser.error(str(error))


async def latency_command(argv: list[str], deps: "LatencyDeps | None" = None) -> int:
    import httpx

    from evals.client import ApiCallFailed
    from evals.latency import LatencyDeps, LatencyMismatch, LatencyRefused, run_latency
    from evals.tier2.passes import PassRefused

    config = latency_config(argv)
    deps = deps or LatencyDeps()
    try:
        run, written = await run_latency(config, deps)
    except (LatencyRefused, LatencyMismatch, PassRefused) as refused:
        print(f"latency: {refused}")
        return 1
    except ApiCallFailed as failed:   # the call and its status, never the body the API sent
        print(f"latency: {failed.op} answered {failed.status}")
        return 1
    except httpx.HTTPError as failed:
        print(f"latency: the request failed ({type(failed).__name__})")
        return 1
    part = run.latency.hosted if run.where == "hosted" else run.latency.local
    measured = len(run.samples) - part.errored_turns
    spent = ("" if run.spend_usd is None
             else f", ${run.spend_usd:.2f} charged as an estimate, since its calls couldn't all be priced"
             if run.spend_estimated else f", ${run.spend_usd:.2f} spent")
    print(f"latency: {run.where} run {run.latency_id}: {measured} of {len(run.samples)} turns measured, "
          f"{part.errored_turns} failed{', stopped by --max-usd' if run.stopped_by_budget else ''}{spent}")
    print(f"latency: wrote {written.relative_to(deps.root)}")
    return 0 if measured else 1


def latency(argv: list[str]) -> int:
    return asyncio.run(latency_command(argv))


class ReportRefused(RuntimeError):
    """A report can't be written from what the pass left; the message says why. Nothing was written."""


# The parts of a run's artifact the report never reads: what the visitor saw, what the simulated owner did
# and read, and each decision's full form. They are left out before a transcript is read, since the runner
# redacts every code a run saw wherever it appears, and a code that matches a timestamp's microseconds
# leaves that timestamp unreadable. The report reads the records, usage and verdict, which are read whole,
# and of the turns only how many visitor messages there were and when each Desk turn ended (`report.desk_turn_times`),
# read before they're left out.
UNREAD_ARTIFACT_FIELDS: dict[str, Any] = {"turns": [], "owner_actions": [], "documents_fetched": [],
                                          "decisions_full": {}, "owner_inbox": []}


def report_inputs(pass_id: str, *, root: Path, null_baseline_id: str | None = None) -> dict[str, Any]:
    """`write_report`'s inputs for the finished pass `pass_id` in the repository at `root`, read from what
    the pass left: `pass.json`, `runs.jsonl` and each run's transcript, the gate over its rows and the
    current recorded rate, this month's rows of the shared spend file (its own among them), the usage of
    its judged legitimate runs, the latency runs that name it, the thresholds' calibration at its commit
    and, with `null_baseline_id`, a null-baseline pass that judged the same held-out legitimate tasks (and is
    gating evidence when the report would become the latest). Anything missing or inconsistent refuses, so
    no run or number is left out unseen. The summary also states what keeps the pass from the latest
    report beyond its config: rows that don't hold one judged run of every scenario and repetition it
    selected, reconciled with the suite at its commit (`results.selection_problems`), and a start that
    doesn't show it stood for its commit (`results.unchecked_refusal`)."""
    from pydantic import ValidationError

    from evals.gate import gate
    from evals.report import PassSummary, kept_out, latest_refusal, load_budget
    from evals.results import GitError, ResultsRefused, checked_committed_waivers, selection_problems, unchecked_refusal
    from evals.tier2.passes import load_pass
    from evals.tier2.suite import load_recorded_rates, load_splits, load_suite, suite_sha256
    from evals.usage import conversation_metrics
    from evals.waivers import checked_waivers, load_waivers

    result = load_pass(pass_id, root)
    config = result.config
    if refusal := latest_refusal(result.pass_id, dry_run=config.dry_run, null_baseline=config.null_baseline):
        raise ReportRefused(refusal)
    if not result.runs:
        raise ReportRefused(f"pass {pass_id} made no run ({len(result.pending)} scenarios pending), so there is "
                            "nothing to report")
    evals = root / "evals"
    try:
        suite = load_suite(evals / "tier2" / "scenarios")
        same_suite = suite_sha256(suite, load_splits(evals / "splits.yaml")) == result.suite_sha256
        rates = load_recorded_rates(evals / "recorded_rates.json")
        budget = load_budget(evals / "budget.toml")
    except (OSError, ValueError) as error:
        raise ReportRefused(f"the suite, the recorded rates or the budget can't be read: {error}") from None
    if not same_suite:
        raise ReportRefused(f"the scenarios or splits changed since pass {pass_id} ran, so its runs can't be read "
                            "against them; report a pass of this tree's suite")
    runs, legit = _report_runs(root, result, suite)
    try:
        metrics = conversation_metrics(legit)
    except (LookupError, ValueError) as error:   # no list price for a model, or a call that can't be read
        raise ReportRefused(f"the legitimate runs' usage can't be priced: {error}") from None
    day = result.created_at.astimezone(UTC).date()
    spend_month = _month_spend(root, day)
    own = [row for row in spend_month if row.pass_id == result.pass_id]
    if len(own) != 1:
        raise ReportRefused(f"the shared spend file holds {len(own)} rows for pass {pass_id}, not one; the report "
                            "reads the pass's spend from the row the pass appended")
    try:
        summary = PassSummary(
            pass_id=result.pass_id, date=day, git_sha=result.git_sha, suite=config.suite, split=config.split,
            only=list(config.only), providers=result.providers.model_dump(), model_ids=result.model_ids,
            served_models=result.served_models, runs_per_scenario=config.runs, external=config.base_url is not None,
            dry_run=config.dry_run, null_baseline=config.null_baseline, stopped_by_budget=result.stopped_by_budget,
            pending=result.pending, heldout_sha256=result.heldout_sha256, spend=own[0],
            simulator_fallbacks=result.simulator_fallbacks, runs=runs, uncovered=selection_problems(result, root),
            unchecked=unchecked_refusal(result, root))
    except ValidationError as error:
        raise ReportRefused(f"pass {pass_id} doesn't read as a report's pass ({error.error_count()} problems: "
                            f"{error.errors()[0]['msg']})") from None
    latest = not kept_out(summary)
    try:
        waivers = (checked_committed_waivers(result, root=root) if latest
                   else checked_waivers(result, load_waivers(root), root=root))
    except (OSError, ValueError, GitError, ResultsRefused) as error:
        raise ReportRefused(f"the pass's waivers can't be checked: {error}") from None
    return {
        "pass_result": summary, "gate_result": gate(result, rates, waivers=waivers), "metrics": metrics,
        "latency": _pass_latency(root, result, latest=latest), "calibration": _calibration_at(root, result.git_sha),
        "recorded": rates.current,
        "null_baseline": _null_baseline(root, null_baseline_id, result, latest=latest) if null_baseline_id else None,
        "spend_month": spend_month, "budget": budget,
    }


def _report_runs(root: Path, result: "PassResult", suite: "Suite") -> tuple[list["ReportRun"], list["RunArtifact"]]:
    """Each run of the pass as the report reads it, from its row and its transcript, and the artifacts of
    its judged legitimate runs. A transcript that is missing, unreadable, another run's, or holds another
    verdict than its row refuses."""
    from evals.report import ReportRun, desk_turn_times
    from evals.tier2.passes import pass_dir
    from evals.tier2.runner import RunOutcome

    transcripts = pass_dir(root, result.pass_id) / "transcripts"
    runs, legit = [], []
    for row in result.runs:
        name = f"{row.scenario_id} rep {row.rep}"
        turn_times = None
        try:
            data = json.loads((transcripts / f"{row.scenario_id}-{row.rep}.json").read_bytes())
            if isinstance(data, dict) and isinstance(data.get("artifact"), dict):
                turn_times = desk_turn_times(data["artifact"])   # when each Desk turn ended, nothing it said
                data["artifact"] = {**data["artifact"], **UNREAD_ARTIFACT_FIELDS}
            outcome = RunOutcome.model_validate(data)
        except (OSError, ValueError) as error:   # ValueError: JSON that doesn't parse, or a ValidationError
            raise ReportRefused(f"the transcript of {name} can't be read ({type(error).__name__}), so the run can't "
                                "be reported") from None
        scenario = suite.scenarios.get(row.scenario_id)
        artifact, verdict = outcome.artifact, outcome.verdict
        if (outcome.scenario_id, outcome.rep, outcome.pass_id) != (row.scenario_id, row.rep, result.pass_id) or (
                artifact is not None and (artifact.scenario_id, artifact.rep) != (row.scenario_id, row.rep)):
            raise ReportRefused(f"the transcript of {name} is another run's")
        if scenario is None:
            raise ReportRefused(f"{name} names a scenario the suite doesn't hold")
        common: dict[str, Any] = {"rep": row.rep, "fallback_turns": outcome.simulator.fallback_turns,
                                  "switches": outcome.simulator.switches, "turn_times": turn_times}
        try:
            if row.status == "incomplete":
                # An incomplete run keeps its error's kind; one with no error had a verdict that didn't fit a
                # row, which the pass recorded as a harness (infra) error.
                kind = outcome.error.kind if outcome.error is not None else "infra"
                runs.append(ReportRun.from_run(scenario, row.split, error=kind, **common))
                continue
            if verdict is None or artifact is None or outcome.error is not None or (
                    row.violations, row.success, row.false_holds, row.expected_allow, row.skipped) != (
                    [v.oracle for v in verdict.violations], verdict.success, verdict.false_holds,
                    verdict.expected_allow, verdict.skipped):
                raise ReportRefused(f"the transcript of {name} doesn't hold the verdict its row records")
            runs.append(ReportRun.from_run(scenario, row.split, artifact=artifact, verdict=verdict, **common))
        except ValueError as error:
            raise ReportRefused(f"{name} can't be reported: {error}") from None
        if row.suite == "legit":
            legit.append(artifact)
    return runs, legit


def _month_spend(root: Path, day: date) -> list["SpendRow"]:
    """The shared spend file's rows of `day`'s month; a row of that month that can't be read refuses, so
    the month's spend is never reported short."""
    from evals.report import SPEND_COLUMNS, SpendRow
    from evals.tier2.passes import read_spend, shared_spend_file

    month, rows = f"{day:%Y-%m}", []
    for row in read_spend(shared_spend_file(root)):
        if not (row.get("date") or "").startswith(month):
            continue
        if not row.get("estimated_usd"):   # written before spend rows marked the part charged as an estimate
            raise ReportRefused(f"a {month} row of the shared spend file doesn't say how much of it was estimated (it "
                                "was written before rows marked that), so the month's spend can't be reported as "
                                "measured; fill its estimated_usd, 0 when every call it counts was priced")
        try:
            rows.append(SpendRow.model_validate({**{column: row.get(column) for column in SPEND_COLUMNS},
                                                 "runs": int(row.get("runs") or "")}))
        except (TypeError, ValueError) as error:
            raise ReportRefused(f"a {month} row of the shared spend file can't be read ({type(error).__name__}), so "
                                "the month's spend can't be reported") from None
    return rows


def _pass_latency(root: Path, result: "PassResult", *, latest: bool) -> "ReportLatency | None":
    """The latency measured for the pass: of the latency runs whose file names it (`latency --pass`), the
    latest local one and the latest hosted one, each with the run it came from. A dry run's scripted
    numbers are never read. When the report may become the latest (`latest`), a local run is read only
    when it measured the API on the Claude API at the pass's commit; each other one is left out, and the
    report says why (`report.latency_left_out`). A hosted run keeps its API's provider as it recorded it,
    unknown. None when no run was measured for the pass and none was left out, which the report shows as
    not measured. A file that can't be read, or names the pass but isn't a latency run, refuses."""
    from pydantic import ValidationError

    from evals.latency import LatencyRun
    from evals.report import LatencySource, ReportLatency, latency_left_out

    directory = root / "evals" / "out" / "latency"
    chosen: dict[str, tuple[LatencyRun, LatencySource]] = {}
    left_out: list[str] = []
    for path in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            raise ReportRefused(f"latency file {path.name} can't be read ({type(error).__name__})") from None
        if not isinstance(data, dict):
            raise ReportRefused(f"latency file {path.name} isn't a latency run")
        if data.get("pass_id") != result.pass_id:
            continue
        try:
            measured = LatencyRun.model_validate(data)
        except ValidationError:
            raise ReportRefused(f"latency file {path.name} names pass {result.pass_id} but isn't a latency "
                                "run") from None
        if measured.provider == "fake":
            continue
        source = LatencySource(latency_id=measured.latency_id, provider=measured.provider, git_sha=measured.git_sha)
        if latest and measured.where == "local" and (line := latency_left_out(source, result.git_sha)):
            left_out.append(line)
            continue
        if measured.where not in chosen or measured.created_at > chosen[measured.where][0].created_at:
            chosen[measured.where] = (measured, source)
    if not chosen and not left_out:
        return None
    local, hosted = chosen.get("local"), chosen.get("hosted")
    return ReportLatency(local=local[0].latency.local if local else None, local_source=local[1] if local else None,
                         hosted=hosted[0].latency.hosted if hosted else None,
                         hosted_source=hosted[1] if hosted else None, local_left_out=left_out)


def _calibration_at(root: Path, git_sha: str) -> "Calibration | None":
    """The calibration the pass's reviewer thresholds came from: the `CALIBRATION` record of the kernel's
    thresholds file at the pass's commit. None when the file there records none (the kernel's initial
    thresholds) or doesn't exist yet."""
    import tempfile

    from pydantic import ValidationError

    from evals import results
    from evals.calibrate import THRESHOLDS_PATH, CalibrationRefused, load_thresholds
    from evals.report import Calibration

    try:
        source = results.show(root, git_sha, THRESHOLDS_PATH)
    except results.GitError as error:
        raise ReportRefused(f"the pass's commit can't be read here: {error}") from None
    if source is None:
        return None
    with tempfile.TemporaryDirectory() as staging:
        staged = Path(staging) / Path(THRESHOLDS_PATH).name
        staged.write_bytes(source)
        try:
            record = load_thresholds(staged).calibration
        except CalibrationRefused as refused:
            raise ReportRefused(f"the thresholds file at the pass's commit can't be read: {refused}") from None
    if record is None:
        return None
    if not isinstance(record, dict) or record.get("split") != "calibration":
        raise ReportRefused("the thresholds file's CALIBRATION at the pass's commit names no calibration-split pass")
    try:
        return Calibration.model_validate({key: value for key, value in record.items() if key != "split"})
    except ValidationError as error:
        raise ReportRefused(f"the thresholds file's CALIBRATION at the pass's commit doesn't read as a calibration "
                            f"({error.errors()[0]['msg']})") from None


def _null_baseline(root: Path, null_id: str, real: "PassResult", *, latest: bool) -> "NullBaseline":
    """The held-out legitimate runs of `null_id`, a real pass run with Answering off on the same held-out
    set as `real`, as the report's null baseline. It must have judged exactly the held-out legitimate
    tasks `real` ran, with no `--only` and no stop at its budget, since the report sets the two side by
    side. When `real`'s report would become the latest, it must also be gating evidence, by the check the
    pass itself is held to (`results.gating_refusal`), so the latest report never quotes a null baseline
    run on another provider or served by a model other than the production ones. Otherwise the reason it
    isn't goes with it, and the report's null baseline line says it."""
    from evals.report import NullBaseline, null_baseline_refusal
    from evals.results import gating_refusal
    from evals.tier2.passes import load_pass

    null = load_pass(null_id, root)
    if not null.config.null_baseline or null.config.dry_run:
        raise ReportRefused(f"pass {null_id} isn't a null baseline: --null-baseline names a real pass run with "
                            "tier2 --null-baseline")
    refusal = gating_refusal(null)
    if latest and refusal:
        raise ReportRefused(null_baseline_refusal(real.pass_id, refusal))
    if null.heldout_sha256 != real.heldout_sha256:
        raise ReportRefused(f"null-baseline pass {null_id} ran on another held-out set than pass {real.pass_id}, so "
                            "the two can't be compared")
    covers = f"so it may not cover the held-out legitimate tasks pass {real.pass_id} ran"
    if null.config.only:
        raise ReportRefused(f"null-baseline pass {null_id} ran with --only, {covers}")
    if null.stopped_by_budget:
        raise ReportRefused(f"null-baseline pass {null_id} was stopped by its --max-usd budget, {covers}")
    rows = [r for r in null.runs if r.status == "scored" and r.suite == "legit" and r.split == "heldout"]
    ran = {r.scenario_id for r in real.runs if r.suite == "legit" and r.split == "heldout"}
    judged = {r.scenario_id for r in rows}
    if missing := sorted(ran - judged):
        raise ReportRefused(f"null-baseline pass {null_id} didn't judge {', '.join(missing)}, which pass "
                            f"{real.pass_id} ran, so the two can't be compared")
    if extra := sorted(judged - ran):
        raise ReportRefused(f"null-baseline pass {null_id} judged {', '.join(extra)}, which pass {real.pass_id} "
                            "didn't run, so the two can't be compared")
    if not rows:
        raise ReportRefused(f"null-baseline pass {null_id} judged no held-out legitimate run")
    return NullBaseline(pass_id=null.pass_id, successes=sum(bool(r.success) for r in rows), trials=len(rows),
                        gating_refusal=refusal)


def report_command(argv: list[str], *, root: Path | None = None) -> int:
    from evals.gate import violation_summary
    from evals.report import exploratory, kept_out, partial, write_report
    from evals.tier2.passes import REPO_ROOT, PassRefused

    parser = _pass_parser("report")
    parser.add_argument("--null-baseline", metavar="PASS",
                        help="a null-baseline pass (tier2 --null-baseline) of the same held-out set")
    options = parser.parse_args(argv)
    root = root or REPO_ROOT
    try:
        inputs = report_inputs(options.pass_id, root=root, null_baseline_id=options.null_baseline)
        written = write_report(**inputs, reports_dir=root / "evals" / "reports", evals_doc=root / "docs" / "evals.md",
                               out_dir=root / "evals" / "out" / "reports")
    except (ReportRefused, PassRefused, OSError, ValueError) as refused:   # ValueError: the guide's markers
        print(f"report: {refused}")
        return 1
    judged, latency = inputs["gate_result"], inputs["latency"]
    measured = latency is not None and (latency.local is not None or latency.hosted is not None)
    print(f"report: pass {options.pass_id}: the gate {'passed' if judged.passed else 'failed'}; "
          f"{violation_summary(judged)}; latency "
          f"{'measured' if measured else 'not measured'}")
    for line in latency.local_left_out if latency is not None else []:
        print(f"report: {line}")
    kept = "so the latest report, evals/reports/spend.csv and the latest results in docs/evals.md stay as they were"
    summary = inputs["pass_result"]
    left_out, explores = partial(summary), exploratory(summary)
    if left_out:
        print(f"report: the pass ran part of the suite ({', '.join(left_out)}), {kept}")
    if explores:
        print(f"report: {explores}; {kept}")
    if summary.uncovered:
        print(f"report: the pass's rows don't hold a judged run of every scenario and repetition it selected "
              f"({'; '.join(summary.uncovered)}), {kept}")
    if summary.unchecked:
        print(f"report: {summary.unchecked}; {kept}")
    if kept_out(summary):
        print(f"report: wrote {written.relative_to(root)}")
        return 0
    print(f"report: wrote {written.relative_to(root)}, evals/reports/latest.json and evals/reports/spend.csv, and "
          "the latest results in docs/evals.md")
    return 0


COMMANDS = {"tier1": tier1, "simulator-check": simulator_check, "tier2": tier2, "gate": gate_command,
            "waiver-review": waiver_review_command, "waive": waive_command,
            "results": results_command, "record-rate": record_rate_command, "key": key, "results-check": results_check,
            "merge-ready": merge_ready, "calibrate": calibrate_command, "latency": latency, "report": report_command}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
