"""One budgeted old/new soft-promise experiment, with an immutable baseline and saved manifest.

MAX_USD is the remaining allowance for this invocation. A canonical ledger per baseline
retains cumulative spend regardless of --output and enforces the experiment's $1.70 cap.
Rescore each arm's saved results with soft_promise --rescore; no model is called there.
"""

import argparse
import asyncio
import fcntl
import hashlib
import json
import math
import sys
from dataclasses import replace
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from evals.calibration import soft_promise as sp

TOTAL_USD = 1.70


class Experiment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    baseline_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    samples: int = Field(ge=1)
    max_usd: float = Field(ge=0, allow_inf_nan=False)
    output: Path
    arms: str = "old,new"
    concurrency: int = Field(4, ge=1)


def digest(data: object) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def wire_request(prompt: str, data: BaseModel) -> dict:
    """The exact SDK request, checked against captured fake requests by the offline test."""
    d = sp.decisions
    return {"model": d.SOFT_PROMISE_MODEL, "max_tokens": d.SOFT_PROMISE_MAX_TOKENS, "system": prompt,
            "messages": [{"role": "user", "content": sp.request_message(data)}],
            "thinking": {"type": "disabled"},
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": d.SOFT_PROMISE_SCHEMA}},
            "timeout": d.SOFT_PROMISE_TIMEOUT_S}


def acceptance(new: sp.RunResult) -> dict:
    unsafe = [case.id for case in new.cases if case.expected in {"flag", "flag_ai"} and case.outcome != "all"]
    offers = [case.id for case in new.cases if case.expected == "pass"
              and case.majority_required and (
        case.samples != case.requested or case.verdicts["pass"] <= case.requested / 2)]
    return {"accepted": not (unsafe or offers or new.stopped_by_cap or new.over_cap),
            "unsafe_or_unmeasured": unsafe, "offers_without_majority": offers,
            "voice_pass_rates": {case.id: case.verdicts["pass"] / case.requested for case in new.cases
                                 if case.group == "voice" and case.expected == "pass"},
            "voice_ai": {case.id: case.outcome for case in new.cases if case.group == "voice_ai"}}


def aggregate_acceptance(history: dict, output: Path) -> dict:
    """All current-identity samples count, including failures from an earlier attempt."""
    runs = []
    for attempt in history["attempts"]:
        if attempt["stale"] or attempt["identity_sha256"] != history["identity_sha256"]:
            continue
        if arm := attempt["arms"].get("new"):
            saved = arm.get("outcome")
            if saved is None:
                saved = json.loads((output.parent / arm["results"]).read_text())
            saved = {**saved, "cases": [{key: value for key, value in case.items()
                                        if key in sp.CaseResult.model_fields} for case in saved["cases"]]}
            runs.append(sp.RunResult.model_validate(saved))
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
    return acceptance(combined)


async def experiment(config: Experiment, deps: sp.Deps) -> dict:
    ledger = deps.root / "evals/out/soft-promise" / f"{config.baseline_sha}.json"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    # Keep one lock through admission, reservations and settlement. A second process
    # refuses immediately instead of blocking an event loop or racing its allowance.
    with ledger.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise sp.Refused("the experiment ledger is in use; retry after it finishes") from None
        return await _experiment(config, deps, ledger)


async def _experiment(config: Experiment, deps: sp.Deps, ledger: Path) -> dict:
    if config.arms != "old,new":
        raise sp.Refused("--arms must be old,new, both arms of one experiment")
    cases = sp.load_cases(deps.cases)
    baseline = sp.load_prompt(deps.root, ref=config.baseline_sha)
    prompts = {"old": baseline, "new": sp.load_prompt(deps.root)}
    manifest = [case.model_dump(mode="json") for case in cases]
    identity = {"baseline_sha": config.baseline_sha, "samples": config.samples, "case_manifest": manifest,
                "arms": {arm: {"input_shape": arm, "prompt": prompt.text, "prompt_sha256": prompt.sha256,
                               "requests_sha256": {case.id: digest(wire_request(
                                   prompt.text, sp.call_input(case, arm))) for case in cases}}
                         for arm, prompt in prompts.items()}}
    revision = {"experiment": identity, "identity_sha256": digest(identity)}
    history = {**revision, "revisions": [revision], "total_cap_usd": TOTAL_USD,
               "cumulative_spend_usd": 0.0, "attempts": []}
    source = ledger
    if not source.exists():
        # Import the pre-ledger experiment, including any paid run, before admitting
        # more calls. Its conventional output is discovered even with another --output.
        legacy = ledger.parent / "next-steps-experiment.json"
        source = legacy if legacy.exists() else config.output
    if source.exists():
        try:
            history = json.loads(source.read_text())
            if history["experiment"]["baseline_sha"] != config.baseline_sha:
                raise sp.Refused("the experiment baseline is frozen; keep its original --baseline-sha")
            previous = float(history["cumulative_spend_usd"])
            if not math.isfinite(previous) or previous < 0 or previous > TOTAL_USD:
                raise ValueError
            for prior in history["attempts"]:
                for arm in prior["arms"].values():
                    arm["results"] = str((source.parent / arm["results"]).resolve())
                    if "outcome" not in arm:
                        arm["outcome"] = json.loads(Path(arm["results"]).read_text())
            if history["identity_sha256"] != digest(identity):
                # A wording iteration is still the same experiment and allowance. Retain
                # the old full manifest and hashes; its answers certify no revised input.
                history["revisions"].append(revision)
                history.update(revision)
                for attempt in history["attempts"]:
                    attempt["stale"] = True
        except (OSError, ValueError, KeyError, TypeError):
            raise sp.Refused("the experiment ledger is invalid") from None
    remaining = min(config.max_usd, TOTAL_USD - history["cumulative_spend_usd"])
    estimate = round(len(cases) * config.samples * 2 * sp.PER_CALL_USD, 6)
    if estimate > remaining + sp.EPSILON:
        raise sp.Refused(f"experiment estimate ${estimate:.4f} exceeds remaining budget ${remaining:.4f}")
    spend_file = deps.spend_file or sp.shared_spend_file(deps.root)
    sp.month_guard(deps, spend_file, estimate)
    # Validate credentials before writing an attempt, without ever recording them.
    sp.api_key()
    sp.decisions.refuse_custom_headers()
    attempt = {"identity_sha256": digest(identity), "stale": False,
               "estimate_usd": estimate, "max_usd": remaining, "arms": {}, "spend_usd": 0.0}
    history["attempts"].append(attempt)
    config.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        data = json.dumps(history, ensure_ascii=False, indent=1) + "\n"
        for target in dict.fromkeys((ledger, config.output)):
            temporary = target.with_suffix(".tmp")
            temporary.write_text(data)
            temporary.replace(target)

    save()
    for arm in ("old", "new"):
        arm_deps = replace(deps, out_dir=config.output.parent / (config.output.stem + "-arms"))
        # A durable reservation survives interruption or an error before an arm saves its
        # measured usage. A retry can never silently regain that allowance.
        reservation = remaining
        history["cumulative_spend_usd"] += reservation
        attempt["reserved_usd"] = reservation
        save()
        outcome, path = await sp.run(sp.Config(
            samples=config.samples, max_usd=remaining, label=arm, input_shape=arm,
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
        if arm == "new":
            attempt["acceptance"] = aggregate_acceptance(history, config.output)
        save()
        if outcome.stopped_by_cap or outcome.over_cap:
            break
    return history


def main(argv=None, deps=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--baseline-sha", required=True)
    parser.add_argument("--arms", default="old,new")
    parser.add_argument("--samples", type=int, required=True)
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
    print(json.dumps(attempt.get("acceptance", {"accepted": False}), ensure_ascii=False, indent=1))
    return 0 if attempt.get("acceptance", {}).get("accepted") else 1


if __name__ == "__main__":
    sys.exit(main())
