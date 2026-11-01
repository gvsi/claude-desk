"""One budgeted soft-promise experiment with Haiku and Sonnet candidates and a steps-only diagnostic.

MAX_USD is the remaining allowance for this invocation. One stable experiment ledger
retains cumulative spend regardless of --output and enforces the experiment's $3.20 cap.
--samples accepts a common count or per-arm counts such as new:5,steps_only:5,sonnet:2.
Sonnet arms are estimated at SONNET_PER_CALL_USD ($0.0026 per check, 1.5 times the measured mean).
Actual spend uses returned usage, including thinking within output_tokens. Timeouts block.
Rescore each arm's saved results with soft_promise --rescore; no model is called there.
"""

import argparse
import asyncio
import fcntl
import hashlib
import json
import math
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from evals.calibration import soft_promise as sp

TOTAL_USD = 3.20      # the owner's cap for the whole experiment, raised from $1.70 on 2026-10-31 for the Sonnet arm
ARM_NAMES = {"old", "new", "sonnet", "steps_only"}
EXPERIMENT_ID = "soft-promise-next-steps"
LEDGER_PATH = Path("evals/out/soft-promise/experiment.json")
SYMPATHY_SENTENCE = (
    "Sympathy, and general advice any professional in this trade would give that commits the business "
    "to no outcome, time, price or action, is not a promise."
)


class Experiment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    baseline_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    samples: int | dict[str, int]
    max_usd: float = Field(ge=0, allow_inf_nan=False)
    output: Path
    arms: str = "old,new"
    concurrency: int = Field(4, ge=1)

    @field_validator("samples", mode="before")
    @classmethod
    def parse_samples(cls, value):
        if isinstance(value, str):
            if value.isdecimal():
                value = int(value)
            else:
                pairs = [part.split(":") for part in value.split(",")]
                if any(len(pair) != 2 or not pair[1].isdecimal() for pair in pairs):
                    raise ValueError("samples must be a count or arm:count pairs")
                if len({pair[0] for pair in pairs}) != len(pairs):
                    raise ValueError("samples repeats an arm")
                value = {name: int(count) for name, count in pairs}
        counts = value.values() if isinstance(value, dict) else [value]
        if not counts or any(isinstance(count, bool) or not isinstance(count, int) or count < 1 for count in counts):
            raise ValueError("sample counts must be positive integers")
        if isinstance(value, dict) and value.keys() - ARM_NAMES:
            raise ValueError("samples names an unknown arm")
        return value

    def samples_for(self, arm: str) -> int:
        if isinstance(self.samples, int):
            return self.samples
        if arm not in self.samples:
            raise sp.Refused(f"samples has no count for selected arm {arm}")
        return self.samples[arm]


def digest(data: object) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def wire_request(prompt: str, data: BaseModel, arm: str = "new") -> dict:
    """The exact SDK request, checked against captured fake requests by the offline test."""
    d = sp.decisions
    return {"model": sp.SONNET_MODEL if arm == "sonnet" else sp.HAIKU_MODEL,
            "max_tokens": d.SOFT_PROMISE_MAX_TOKENS, "system": prompt,
            "messages": [{"role": "user", "content": sp.request_message(data)}],
            "thinking": {"type": "adaptive" if arm == "sonnet" else "disabled"},
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": d.SOFT_PROMISE_SCHEMA}},
            "timeout": d.SOFT_PROMISE_TIMEOUT_S if arm == "sonnet" else sp.HAIKU_TIMEOUT_S}


def acceptance(new: sp.RunResult) -> dict:
    # A timeout fails closed in the reply check, so it blocks unsafe and honest prose alike.
    unsafe = [case.id for case in new.cases if case.expected in {"flag", "flag_ai"} and (
        case.samples != case.requested or sum(case.verdicts.get(verdict, 0) for verdict in sp.MEETS[case.expected])
        + case.errors.get("timeout", 0) != case.requested)]
    offers = [case.id for case in new.cases if case.expected == "pass"
              and case.majority_required and (
        case.samples != case.requested or case.verdicts["pass"] <= case.requested / 2)]
    return {"accepted": not (unsafe or offers or new.stopped_by_cap or new.over_cap),
            "unsafe_or_unmeasured": unsafe, "offers_without_majority": offers,
            "voice_pass_rates": {case.id: case.verdicts["pass"] / case.requested for case in new.cases
                                 if case.group == "voice" and case.expected == "pass"},
            "voice_ai": {case.id: case.outcome for case in new.cases if case.group == "voice_ai"}}


def arm_identity(identity: dict, name: str) -> str:
    """Samples and other arms don't erase evidence for unchanged wording and inputs."""
    return digest({"baseline_sha": identity["baseline_sha"], "arm": identity["arms"][name],
                   "labels": {case["id"]: case["expected"] for case in identity["case_manifest"]}})


def refresh_evidence(history: dict) -> None:
    current = history["experiment"]
    revisions = {revision["identity_sha256"]: revision["experiment"] for revision in history["revisions"]}
    for attempt in history["attempts"]:
        measured = revisions[attempt["identity_sha256"]]
        for name, arm in attempt["arms"].items():
            arm["identity_sha256"] = arm_identity(measured, name)
            arm["stale"] = name not in current["arms"] or arm["identity_sha256"] != arm_identity(current, name)
        attempt["stale"] = all(arm["stale"] for arm in attempt["arms"].values())


def arm_runs(history: dict, name: str) -> list[sp.RunResult]:
    """Validate saved results against the current arm before reusing any of its evidence."""
    identity = history["experiment"]
    recorded = identity["arms"][name]
    manifest = [sp.Case.model_validate(case) for case in identity["case_manifest"]]
    runs = []
    for attempt in history["attempts"]:
        arm = attempt["arms"].get(name)
        if arm is None or arm["stale"]:
            continue
        saved = arm["outcome"]
        saved = {**saved, "cases": [{key: value for key, value in case.items()
                                    if key in sp.CaseResult.model_fields} for case in saved["cases"]]}
        run = sp.RunResult.model_validate(saved)
        if (run.prompt.text != recorded["prompt"] or run.prompt.sha256 != recorded["prompt_sha256"]
                or run.input_shape != recorded["input_shape"] or len(run.cases) != len(manifest)):
            raise sp.Refused("saved evidence differs from the recorded arm")
        for result, case in zip(run.cases, manifest, strict=True):
            if (result.id, result.expected, result.input_sha256) != (
                    case.id, case.expected, sp.input_sha256(sp.call_input(case, run.input_shape))):
                raise sp.Refused("saved evidence differs from the recorded cases")
            result.majority_required = case.majority_required
        runs.append(run)
    return runs


def aggregate_acceptance(history: dict, name: str = "new") -> dict:
    """All current-identity samples count, including failures from an earlier attempt."""
    runs = arm_runs(history, name)
    if not runs:
        return {"accepted": False}
    combined = runs[0].model_copy(deep=True)
    for run in runs[1:]:
        combined.stopped_by_cap |= run.stopped_by_cap
        combined.over_cap |= run.over_cap
        for total, case in zip(combined.cases, run.cases, strict=True):
            if (total.id, total.input_sha256, total.expected) != (case.id, case.input_sha256, case.expected):
                raise sp.Refused("saved evidence differs from the experiment identity")
            total.requested += case.requested
            for verdict, count in case.verdicts.items():
                total.verdicts[verdict] = total.verdicts.get(verdict, 0) + count
            for status, count in case.errors.items():
                total.errors[status] = total.errors.get(status, 0) + count
    return acceptance(combined)


def summarize_runs(runs: list[sp.RunResult]) -> dict:
    """Counts retain every current-identity sample, including earlier failed attempts."""
    slips = {"flag": Counter(), "flag_ai": Counter()}
    offers, voice, statuses = Counter(), Counter(), Counter()
    for run in runs:
        for case in run.cases:
            if case.expected in slips and case.verdicts.get("pass", 0):
                slips[case.expected][case.id] += case.verdicts["pass"]
            blocked = case.samples - case.verdicts.get("pass", 0)
            if case.expected == "pass" and blocked:
                if case.majority_required:
                    offers[case.id] += blocked
                if case.group == "voice":
                    voice[case.id] += blocked
            statuses.update(case.errors)
    latencies = sorted(usage.latency_ms for run in runs for usage in run.call_usage)

    def percentile(fraction):
        if not latencies:
            return None
        position = (len(latencies) - 1) * fraction
        lo, hi = math.floor(position), math.ceil(position)
        return round(latencies[lo] + (latencies[hi] - latencies[lo]) * (position - lo), 3)

    calls = sum(run.calls for run in runs)
    return {"calls": calls,
            "flag_slips": dict(slips["flag"]), "flag_ai_slips": dict(slips["flag_ai"]),
            "majority_offers_blocked": dict(offers), "voice_pass_blocked": dict(voice),
            "latency_ms": {"p50": percentile(0.5), "p95": percentile(0.95),
                           "max": max(latencies) if latencies else None, "calls": len(latencies)},
            "calls_without_latency": calls - len(latencies),
            "mean_cost_per_check_usd": sum(run.spend_usd for run in runs) / calls if calls else None,
            "estimated_calls": sum(run.estimated_calls for run in runs),
            "timeouts": statuses["timeout"], "errors": sum(statuses.values()) - statuses["timeout"],
            "error_statuses": dict(statuses)}


def arm_reports(history: dict) -> dict:
    reports = {}
    for name in history["experiment"]["arms"]:
        runs = arm_runs(history, name)
        if runs:
            reports[name] = {**summarize_runs(runs), "shipping_candidate": name in {"new", "sonnet"},
                             "acceptance": aggregate_acceptance(history, name)}
    return reports


async def experiment(config: Experiment, deps: sp.Deps) -> dict:
    ledger = deps.root / LEDGER_PATH
    ledger.parent.mkdir(parents=True, exist_ok=True)
    # Keep one lock through admission, reservations and settlement. A second process
    # refuses immediately instead of blocking an event loop or racing its allowance.
    with ledger.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise sp.Refused("the experiment ledger is in use; retry after it finishes") from None
        return await _experiment(config, deps, ledger)


def load_history(ledger: Path, output: Path, baseline_sha: str) -> dict | None:
    """Discover and migrate paid evidence before considering any new admission."""
    source = ledger
    if not source.exists():
        # Discover the former SHA ledger independently of the caller's chosen SHA.
        prior = [path for path in ledger.parent.glob("*.json")
                 if len(path.stem) == 40 and all(c in "0123456789abcdef" for c in path.stem)]
        if len(prior) > 1:
            raise sp.Refused("multiple legacy experiment ledgers require reconciliation")
        legacy = ledger.parent / "next-steps-experiment.json"
        source = prior[0] if prior else legacy if legacy.exists() else output
    if not source.exists():
        return None
    try:
        history = json.loads(source.read_text())
        frozen = history.get("frozen_baseline_sha", history["experiment"]["baseline_sha"])
        if (history.get("experiment_id", EXPERIMENT_ID) != EXPERIMENT_ID
                or history["experiment"]["baseline_sha"] != frozen):
            raise ValueError
        previous = float(history["cumulative_spend_usd"])
        if not math.isfinite(previous) or previous < 0 or previous > TOTAL_USD:
            raise ValueError
        for prior in history["attempts"]:
            for arm in prior["arms"].values():
                arm["results"] = str((source.parent / arm["results"]).resolve())
                if "outcome" not in arm:
                    arm["outcome"] = json.loads(Path(arm["results"]).read_text())
        history.update(experiment_id=EXPERIMENT_ID, frozen_baseline_sha=frozen, total_cap_usd=TOTAL_USD)
        # A zero-budget invocation still durably migrates all spend and arm evidence.
        if source != ledger:
            temporary = ledger.with_suffix(".tmp")
            temporary.write_text(json.dumps(history, ensure_ascii=False, indent=1) + "\n")
            temporary.replace(ledger)
        if frozen != baseline_sha:
            raise sp.Refused("the experiment baseline is frozen; keep its original --baseline-sha")
        return history
    except (OSError, ValueError, KeyError, TypeError):
        raise sp.Refused("the experiment ledger is invalid") from None


async def _experiment(config: Experiment, deps: sp.Deps, ledger: Path) -> dict:
    saved = load_history(ledger, config.output, config.baseline_sha)
    selected = config.arms.split(",")
    if set(selected) - ARM_NAMES or len(set(selected)) != len(selected):
        raise sp.Refused("--arms must select distinct arms from old,new,sonnet,steps_only")
    samples = {arm: config.samples_for(arm) for arm in selected}
    cases = sp.load_cases(deps.cases)
    baseline = sp.load_prompt(deps.root, ref=config.baseline_sha)
    candidate = sp.load_prompt(deps.root)
    prompts = {"old": baseline, "new": candidate, "sonnet": candidate,
               "steps_only": sp.Prompt(candidate.text.replace(SYMPATHY_SENTENCE + " ", ""),
                                       "this tree without the sympathy and advice sentence (diagnostic)")}
    manifest = [case.model_dump(mode="json") for case in cases]
    identity = {"baseline_sha": config.baseline_sha, "samples": config.samples, "case_manifest": manifest,
                "arms": {arm: {"input_shape": "old" if arm == "old" else "new",
                               "prompt": prompt.text, "prompt_sha256": prompt.sha256,
                               "requests_sha256": {case.id: digest(wire_request(
                                   prompt.text, sp.call_input(case, "old" if arm == "old" else "new"), arm)) for case in cases}}
                         for arm, prompt in prompts.items()}}
    revision = {"experiment": identity, "identity_sha256": digest(identity)}
    history = {**revision, "revisions": [revision], "total_cap_usd": TOTAL_USD,
               "experiment_id": EXPERIMENT_ID, "frozen_baseline_sha": config.baseline_sha,
               "cumulative_spend_usd": 0.0, "attempts": []}
    if saved is not None:
        history = saved
        if history["identity_sha256"] != digest(identity):
            # A wording iteration retains the old full manifest, evidence and allowance.
            history["revisions"].append(revision)
            history.update(revision)
    history["diagnostic_arms"] = ["steps_only"]
    refresh_evidence(history)
    reused = []
    if "old" not in selected:
        valid_old = any(not run.stopped_by_cap and not run.over_cap
                        and all(case.samples >= max(samples.values()) for case in run.cases) for run in arm_runs(history, "old"))
        if not valid_old:
            raise sp.Refused("selected arms require complete unchanged old-arm evidence; include old first")
        reused = ["old"]
    config.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        data = json.dumps(history, ensure_ascii=False, indent=1) + "\n"
        for target in dict.fromkeys((ledger, config.output)):
            temporary = target.with_suffix(".tmp")
            temporary.write_text(data)
            temporary.replace(target)

    # Import legacy spend and preserve the revision even when MAX_USD=0 refuses calls.
    if saved is not None:
        save()
    remaining = min(config.max_usd, TOTAL_USD - history["cumulative_spend_usd"])
    calls = len(cases) * sum(samples.values())
    estimates = {arm: round(len(cases) * samples[arm] * sp.per_call_usd(
        "sonnet" if arm == "sonnet" else "haiku"), 6) for arm in selected}
    estimate = round(sum(estimates.values()), 6)
    for arm in selected:
        print(f"{arm}: {samples[arm]} samples/case; {len(cases) * samples[arm]} calls; estimate ${estimates[arm]:.4f}")
    print(f"Arms to run: {config.arms}; reusing {','.join(reused) or 'none'}; "
          f"{calls} calls; estimate ${estimate:.4f}; remaining ${remaining:.6f}")
    if estimate > remaining + sp.EPSILON:
        raise sp.Refused(f"experiment estimate ${estimate:.4f} exceeds remaining budget ${remaining:.4f}")
    spend_file = deps.spend_file or sp.shared_spend_file(deps.root)
    sp.month_guard(deps, spend_file, estimate)
    # Validate credentials before writing an attempt, without ever recording them.
    sp.api_key()
    sp.decisions.refuse_custom_headers()
    attempt = {"identity_sha256": digest(identity), "stale": False,
               "estimate_usd": estimate, "max_usd": remaining, "arms": {}, "spend_usd": 0.0,
               "reused_arms": reused, "arm_estimates_usd": estimates, "arm_samples": samples}
    history["attempts"].append(attempt)
    save()
    for arm in selected:
        arm_deps = replace(deps, out_dir=config.output.parent / (config.output.stem + "-arms"))
        # A durable reservation survives interruption or an error before an arm saves its
        # measured usage. A retry can never silently regain that allowance.
        reservation = remaining
        history["cumulative_spend_usd"] += reservation
        attempt["reserved_usd"] = reservation
        save()
        outcome, path = await sp.run(sp.Config(
            samples=samples[arm], max_usd=remaining, label=arm, input_shape=identity["arms"][arm]["input_shape"],
            candidate="sonnet" if arm == "sonnet" else "haiku",
            prompt_ref=config.baseline_sha if arm == "old" else None, concurrency=config.concurrency), arm_deps,
            cases=tuple(sp.Case.model_validate(case) for case in manifest), prompt=prompts[arm],
            request_hashes=frozenset(identity["arms"][arm]["requests_sha256"].values()))
        history["cumulative_spend_usd"] += outcome.spend_usd - reservation
        attempt["reserved_usd"] = 0
        attempt["spend_usd"] += outcome.spend_usd
        attempt["arms"][arm] = {"results": str(path.resolve()),
                               "spend_usd": outcome.spend_usd,
                               "outcome": outcome.model_dump(mode="json")}
        remaining -= outcome.spend_usd
        refresh_evidence(history)
        if arm in {"new", "sonnet", "steps_only"}:
            attempt["acceptance"] = aggregate_acceptance(history)
            attempt["shipping_candidates"] = {name: aggregate_acceptance(history, name) for name in ("new", "sonnet")}
            if arm == "steps_only":
                attempt["steps_only_diagnostic"] = aggregate_acceptance(history, "steps_only")
        attempt["arm_reports"] = arm_reports(history)
        save()
        if outcome.stopped_by_cap or outcome.over_cap:
            break
    return history


def main(argv=None, deps=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--baseline-sha", required=True)
    parser.add_argument("--arms", default="new,steps_only")
    parser.add_argument("--samples", required=True, help="count for every arm, or new:5,steps_only:5,sonnet:2")
    parser.add_argument("--max-usd", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    options = vars(parser.parse_args(argv))
    cases = options.pop("cases")
    try:
        config = Experiment(**options)
        history = asyncio.run(experiment(config, replace(deps or sp.Deps(), cases=cases)))
    except (sp.Refused, ValidationError) as error:
        print(f"soft-promise experiment: {error}", file=sys.stderr)
        return 1
    print(f"Experiment: {config.output}; cumulative spend ${history['cumulative_spend_usd']:.6f}")
    attempt = history["attempts"][-1]
    for name, report in attempt["arm_reports"].items():
        role = "shipping candidate" if report["shipping_candidate"] else "diagnostic only" if name == "steps_only" else "baseline"
        print(f"{name} ({role}):")
        print(json.dumps(report, ensure_ascii=False, indent=1))
    if set(config.arms.split(",")) <= {"old", "steps_only"}:
        return 0
    candidates = set(config.arms.split(",")) & {"new", "sonnet"}
    return 0 if any(attempt.get("shipping_candidates", {}).get(name, {}).get("accepted") for name in candidates) else 1


if __name__ == "__main__":
    sys.exit(main())
