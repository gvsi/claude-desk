"""Run an eval tier from the repository root.

    python -m evals.run tier1 [--target stub|kernel|api] [pytest args]
    python -m evals.run simulator-check --provider anthropic|bedrock
    python -m evals.run tier2 --suite attack|legit|all --split calibration|heldout|all --runs N --max-usd X
        [--only ids] [--concurrency 4] [--dry-run] [--null-baseline] [--results] [--base-url URL --records-dsn DSN]
    python -m evals.run gate --pass <id> [--final]
    python -m evals.run results --pass <id>
    python -m evals.run record-rate --pass <id> --signed-off-by "<name>" --reason "<text>" [--lower-bar]
    python -m evals.run key
    python -m evals.run results-check --base <ref>
    python -m evals.run calibrate --pass <id> [--write] [--owner-approved "<name>"]
    python -m evals.run latency --max-usd X [--turns 20] [--base-url URL] [--dry-run] [--pass <id>]

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
it prints the pass's summary and gate, then the export's refusal if the file is refused, and exits
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
database, network or key: exit 0 or 1, the reason on stdout.

`calibrate` (`evals/calibrate.py`) proposes each effect's reviewer thresholds from a finished
calibration pass and writes `evals/reports/calibration-v<N>.md`, with no model call; it refuses a
pass of any other split. `--write` also rewrites the calibrated block of
`backend/desk/kernel_service/review_thresholds.py` when a row changes (never from a dry run or a
null baseline), and a `charge` or `pay_out` row looser than the kernel's initial one needs
`--owner-approved`. It exits 1 when refused, with the reason on stdout.

`latency` (`evals/latency.py`) makes `--turns` visitor turns each of a plain question, a quote and a
booking, each kind in its own copy, on the in-process stack built from this tree (its API on
`MODEL_PROVIDER`; every model scripted with `--dry-run`) or on the deployment at `--base-url`, and
writes `evals/out/latency/<id>.json`, its numbers labelled `local` or `hosted` and `--pass` naming the
pass they are for. It exits 1 when the run is refused or measured nothing it can report.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from evals.tier1.harness import SUMMARY_FILE, TARGETS, TIER1_DIR

if TYPE_CHECKING:
    from evals.latency import LatencyConfig, LatencyDeps
    from evals.tier2.passes import PassConfig

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
    point = "none" if judged.completion_point is None else f"{judged.completion_point:.3f}"
    recorded = ("none" if judged.recorded_lower_95 is None
                else f"{judged.recorded_lower_95:.3f} ({judged.recorded_provider})")
    print(f"gate: {'passed' if judged.passed else 'failed'}; held-out legitimate completion {point} over "
          f"{judged.completion_trials} runs ({judged.provider}), recorded {recorded}")
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

    parser = _pass_parser("gate")
    parser.add_argument("--final", action="store_true")
    options = parser.parse_args(argv)
    try:
        finished, rates = load_pass(options.pass_id), load_recorded_rates()
        judged = final_gate(finished, rates) if options.final else gate(finished, rates)
    except (PassRefused, ResultsRefused) as refused:
        print(f"gate: {refused}")
        return 1
    _print_gate(judged)
    return 0 if judged.passed else 1


def results_command(argv: list[str]) -> int:
    from evals.results import ResultsRefused, write_results
    from evals.tier2.passes import PassRefused, load_pass
    from evals.tier2.suite import load_recorded_rates

    options = _pass_parser("results").parse_args(argv)
    try:
        written = write_results(load_pass(options.pass_id), load_recorded_rates())
    except (PassRefused, ResultsRefused) as refused:
        print(f"results: {refused}")
        return 1
    print(f"results: wrote {written.relative_to(EVALS_DIR.parent)}")
    return 0


def record_rate_command(argv: list[str]) -> int:
    from evals.results import lowered_notice
    from evals.tier2.passes import PassRefused, load_pass, record_rate

    parser = _pass_parser("record-rate")
    parser.add_argument("--signed-off-by", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--lower-bar", action="store_true")
    options = parser.parse_args(argv)
    try:
        rate = record_rate(load_pass(options.pass_id), signed_off_by=options.signed_off_by, reason=options.reason,
                           lower_bar=options.lower_bar)
    except PassRefused as refused:
        print(f"record-rate: {refused}")
        return 1
    lowered = f"; {notice}" if (notice := lowered_notice(rate)) else ""
    print(f"record-rate: recorded {rate.completion_lower_95:.3f} (point {rate.completion_point:.3f} over "
          f"{rate.trials} held-out legitimate runs, {rate.provider}) from pass {rate.run_id}{lowered}; run "
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
    options = parser.parse_args(argv)
    passed, reason = check(options.base)
    print(f"results-check: {reason}")
    return 0 if passed else 1


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
    spent = "" if run.spend_usd is None else f", ${run.spend_usd:.2f} spent"
    print(f"latency: {run.where} run {run.latency_id}: {measured} of {len(run.samples)} turns measured, "
          f"{part.errored_turns} failed{', stopped by --max-usd' if run.stopped_by_budget else ''}{spent}")
    print(f"latency: wrote {written.relative_to(deps.root)}")
    return 0 if measured else 1


def latency(argv: list[str]) -> int:
    return asyncio.run(latency_command(argv))


COMMANDS = {"tier1": tier1, "simulator-check": simulator_check, "tier2": tier2, "gate": gate_command,
            "results": results_command, "record-rate": record_rate_command, "key": key, "results-check": results_check,
            "calibrate": calibrate_command, "latency": latency}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
