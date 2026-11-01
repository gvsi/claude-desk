"""A two-arm experiment shares one cap and records reproducible requests; all calls are fake."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from evals.tests.eval_repo import commit, write
from evals.tests.test_soft_promise_calibration import deps


def test_retry_cannot_hide_an_unsafe_sample(deps, tmp_path):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1,
                            output=tmp_path / "experiment.json")
    first = asyncio.run(exp.experiment(config, deps))
    assert not first["attempts"][0]["acceptance"]["accepted"]
    deps.client.client.answer = lambda prose: "flag" if "sort everything" in prose else "pass"
    second = asyncio.run(exp.experiment(config, deps))
    assert not second["attempts"][0]["stale"]
    assert not second["attempts"][1]["acceptance"]["accepted"]
    assert second["attempts"][1]["acceptance"]["unsafe_or_unmeasured"] == ["promise-sort"]


def test_both_arms_use_the_recorded_cases_and_prompts_during_edits(deps, tmp_path, monkeypatch):
    import yaml
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1,
                            output=tmp_path / "experiment.json")

    def answer(prose):
        data = yaml.safe_load(deps.cases.read_text())
        data["cases"][1].update(prose="How can I help?", expected="pass")
        deps.cases.write_text(yaml.safe_dump(data))
        monkeypatch.setattr(exp.sp.decisions, "SOFT_PROMISE_SYSTEM", "edited during the run")
        return "flag" if "sort everything" in prose else "pass"

    deps.client.client.answer = answer
    history = asyncio.run(exp.experiment(config, deps))
    for arm, requests in zip(("old", "new"), (deps.client.client.requests[:2], deps.client.client.requests[2:])):
        recorded = history["experiment"]["arms"][arm]
        assert list(recorded["requests_sha256"].values()) == [exp.digest(request) for request in requests]
        saved = history["attempts"][0]["arms"][arm]["outcome"]
        assert saved["cases"][1]["expected"] == "flag"
    assert history["attempts"][0]["acceptance"]["accepted"]


def test_different_output_cannot_reset_the_experiment_budget(deps, tmp_path, monkeypatch):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    monkeypatch.setattr(exp, "TOTAL_USD", 0.0022)
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1,
                            output=tmp_path / "first.json")
    history = asyncio.run(exp.experiment(config, deps))
    count = len(deps.client.client.requests)
    with pytest.raises(exp.sp.Refused, match="remaining"):
        asyncio.run(exp.experiment(config.model_copy(update={"output": tmp_path / "second.json"}), deps))
    assert len(deps.client.client.requests) == count
    canonical = deps.root / "evals/out/soft-promise" / f"{baseline}.json"
    assert json.loads(canonical.read_text())["cumulative_spend_usd"] == history["cumulative_spend_usd"]


def test_experiment_refuses_the_whole_estimate_before_any_call(deps, tmp_path):
    from evals.calibration.soft_promise_experiment import Experiment, experiment
    from evals.calibration.soft_promise import Refused
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = Experiment(baseline_sha=baseline, samples=5, max_usd=0.001,
                        output=tmp_path / "experiment.json")
    with pytest.raises(Refused, match="estimate.*remaining"):
        asyncio.run(experiment(config, deps))
    assert deps.client.keys == []
    assert not config.output.exists()


def test_experiment_refuses_concurrent_access_before_any_call(deps, tmp_path):
    import fcntl
    from evals.calibration import soft_promise_experiment as exp
    baseline = "0" * 40
    ledger = deps.root / "evals/out/soft-promise" / f"{baseline}.lock"
    ledger.parent.mkdir(parents=True)
    with ledger.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1,
                                output=tmp_path / "experiment.json")
        with pytest.raises(exp.sp.Refused, match="in use"):
            asyncio.run(exp.experiment(config, deps))
    assert not deps.client.keys


def test_experiment_records_both_requests_and_cumulative_budget(deps, tmp_path, monkeypatch):
    from evals.calibration import soft_promise_experiment as exp
    from evals.calibration.soft_promise import Refused
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    monkeypatch.setattr(exp, "TOTAL_USD", 0.0022)
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1, output=tmp_path / "experiment.json")
    history = asyncio.run(exp.experiment(config, deps))
    assert history == json.loads(config.output.read_text())
    assert history["cumulative_spend_usd"] == pytest.approx(0.000384)
    assert set(history["attempts"][0]["arms"]) == {"old", "new"}
    for arm, requests in zip(("old", "new"), (deps.client.client.requests[:2], deps.client.client.requests[2:])):
        identity = history["experiment"]["arms"][arm]
        assert identity["input_shape"] == arm
        assert list(identity["requests_sha256"].values()) == [exp.digest(request) for request in requests]
        assert ("next_steps" in json.loads(requests[0]["messages"][0]["content"])) == (arm == "new")
    count = len(deps.client.client.requests)
    with pytest.raises(Refused, match="remaining"):
        asyncio.run(exp.experiment(config, deps))
    assert len(deps.client.client.requests) == count


def test_a_prompt_revision_keeps_the_budget_and_marks_prior_evidence_stale(deps, tmp_path, monkeypatch):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1, output=tmp_path / "experiment.json")
    first = asyncio.run(exp.experiment(config, deps))
    monkeypatch.setattr(exp.sp.decisions, "SOFT_PROMISE_SYSTEM", "revised wording")
    second = asyncio.run(exp.experiment(config, deps))
    assert second["cumulative_spend_usd"] == pytest.approx(first["cumulative_spend_usd"] * 2)
    assert len(second["revisions"]) == 2
    assert second["attempts"][0]["stale"]
    assert not second["attempts"][1]["stale"]
    assert second["revisions"][0]["identity_sha256"] != second["revisions"][1]["identity_sha256"]


def test_acceptance_needs_every_unsafe_sample_and_a_majority_for_each_offer():
    from evals.calibration.soft_promise import CaseResult
    from evals.calibration.soft_promise_experiment import acceptance
    unsafe = CaseResult(id="unsafe", group="voice", language="en", input_sha256="0" * 64,
                        expected="flag", code_blocked=True, requested=5,
                        verdicts={"flag": 4, "pass": 1})
    offer = CaseResult(id="refund", group="refund_rules", language="es", input_sha256="0" * 64,
                       expected="pass", code_blocked=False, requested=5,
                       verdicts={"flag": 2, "pass": 3})
    run = SimpleNamespace(cases=[unsafe, offer], stopped_by_cap=False, over_cap=False)
    assert acceptance(run)["unsafe_or_unmeasured"] == ["unsafe"]
    unsafe.verdicts = {"flag": 5, "pass": 0}
    assert acceptance(run)["accepted"]
    offer.verdicts = {"flag": 3, "pass": 2}
    assert acceptance(run)["offers_without_majority"] == ["refund"]
    unsafe.expected = "flag_ai"
    assert acceptance(run)["unsafe_or_unmeasured"] == ["unsafe"]
