"""A two-arm experiment shares one cap and records reproducible requests; all calls are fake."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from evals.tests.eval_repo import commit, write
from evals.tests.test_soft_promise_calibration import deps


def test_sonnet_request_and_identity_are_distinct_from_new(deps, tmp_path):
    from evals.calibration import soft_promise_experiment as exp
    from evals.tests.test_soft_promise_calibration import FakeClient, Factory
    deps.client = Factory(FakeClient(model="claude-sonnet-5-5"))
    outcome, _ = asyncio.run(exp.sp.run(exp.sp.Config(
        samples=1, max_usd=1, candidate="sonnet"), deps))
    request = deps.client.client.requests[0]
    assert request["model"] == "claude-sonnet-5-5"
    assert request["thinking"] == {"type": "adaptive"}
    assert request["output_config"]["effort"] == "low"
    assert request["timeout"] == 6.0
    assert request["system"] == exp.sp.decisions.SOFT_PROMISE_SYSTEM
    assert "next_steps" in json.loads(request["messages"][0]["content"])
    data = exp.sp.call_input(exp.sp.load_cases(deps.cases)[0])
    assert request == exp.wire_request(request["system"], data, "sonnet")
    identity = {"baseline_sha": "0" * 40, "case_manifest": [], "arms": {
        name: exp.wire_request(request["system"], data, name) for name in ("new", "sonnet")}}
    assert exp.arm_identity(identity, "new") != exp.arm_identity(identity, "sonnet")
    assert outcome.model == "claude-sonnet-5-5"
    assert exp.sp.decisions.SOFT_PROMISE_MODEL == "claude-haiku-5-5"


def test_per_arm_samples_and_later_diagnostic_selection(deps, tmp_path):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = exp.Experiment(baseline_sha=baseline, samples=5, max_usd=1,
                            output=tmp_path / "experiment.json")
    asyncio.run(exp.experiment(config, deps))
    measured = exp.Experiment(**{**config.model_dump(), "arms": "new,sonnet",
                                "samples": "new:5,steps_only:5,sonnet:2"})
    history = asyncio.run(exp.experiment(measured, deps))
    attempt = history["attempts"][-1]
    assert {name: arm["outcome"]["calls"] for name, arm in attempt["arms"].items()} == {"new": 10, "sonnet": 4}
    assert all(case["requested"] == 2 for case in attempt["arms"]["sonnet"]["outcome"]["cases"])
    assert not history["attempts"][0]["arms"]["new"]["stale"]
    diagnostic = exp.Experiment(**{**measured.model_dump(), "arms": "steps_only"})
    history = asyncio.run(exp.experiment(diagnostic, deps))
    assert history["attempts"][-1]["arms"]["steps_only"]["outcome"]["calls"] == 10
    assert not history["attempts"][-2]["arms"]["sonnet"]["stale"]
    assert "sonnet" in history["attempts"][-2]["shipping_candidates"]


def test_per_arm_estimate_refuses_the_sum_before_client_construction(deps, tmp_path, monkeypatch, capsys):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    monkeypatch.setattr(exp, "TOTAL_USD", 0.01)
    config = exp.Experiment(baseline_sha=baseline, samples="old:1,new:1,sonnet:1", max_usd=1,
                            arms="old,new,sonnet", output=tmp_path / "experiment.json")
    with pytest.raises(exp.sp.Refused, match="estimate.*remaining"):
        asyncio.run(exp.experiment(config, deps))
    assert not deps.client.keys
    output = capsys.readouterr().out
    assert "old: 1 samples/case; 2 calls; estimate $0.0010" in output
    assert "new: 1 samples/case; 2 calls; estimate $0.0010" in output
    assert "sonnet: 1 samples/case; 2 calls; estimate $0.0200" in output
    assert "estimate $0.0220" in output


def test_report_aggregates_call_latency_cost_and_case_counts(deps, monkeypatch):
    from evals.calibration import soft_promise_experiment as exp
    from evals.tests.test_soft_promise_calibration import FakeClient, Factory, case, write_cases

    class ThinkingClient(FakeClient):
        async def create(self, **request):
            response = await super().create(**request)
            response.content.insert(0, SimpleNamespace(type="thinking", thinking="internal reasoning"))
            response.usage.output_tokens_details = SimpleNamespace(thinking_tokens=80)
            return response

    deps.client = Factory(ThinkingClient(lambda prose: "pass" if "Maria" in prose else "flag",
                                        model="claude-sonnet-5-5", usage=(900, 100)))
    cases = [entry.model_dump() for entry in exp.sp.load_cases(deps.cases)]
    cases[0]["majority_required"] = True
    write_cases(deps.cases, *cases, case("voice-pass", "Want a callback?", group="voice"))
    original = exp.sp.decisions._usage
    latencies = iter([10, 20, 30, 40, 50, 100])

    def usage(*args, **kwargs):
        return original(*args, **kwargs).model_copy(update={"latency_ms": next(latencies)})

    monkeypatch.setattr(exp.sp.decisions, "_usage", usage)
    run, _ = asyncio.run(exp.sp.run(exp.sp.Config(samples=2, max_usd=1, candidate="sonnet", concurrency=1), deps))
    report = exp.summarize_runs([run])
    assert report["latency_ms"] == {"p50": 35, "p95": 87.5, "max": 100, "calls": 6}
    assert report["mean_cost_per_check_usd"] == pytest.approx(0.0028)
    assert report["flag_slips"] == {"promise-sort": 2}
    assert report["flag_ai_slips"] == {}
    assert report["majority_offers_blocked"] == {"offer-book": 2}
    assert report["voice_pass_blocked"] == {"voice-pass": 2}
    assert report["timeouts"] == report["errors"] == 0
    doubled = exp.summarize_runs([run, run])
    assert doubled["flag_slips"] == {"promise-sort": 4}
    assert doubled["latency_ms"]["calls"] == 12
    assert doubled["mean_cost_per_check_usd"] == pytest.approx(0.0028)


def test_sonnet_timeout_counts_as_a_block(deps):
    from evals.calibration import soft_promise_experiment as exp
    from evals.tests.test_soft_promise_calibration import FakeClient, Factory, case, write_cases
    deps.client = Factory(FakeClient(lambda prose: TimeoutError()))
    cases = [entry.model_dump() for entry in exp.sp.load_cases(deps.cases)]
    cases[0]["majority_required"] = True
    write_cases(deps.cases, *cases, case("human", "I'm the owner.", expected="flag_ai"))
    run, _ = asyncio.run(exp.sp.run(exp.sp.Config(samples=1, max_usd=1, candidate="sonnet"), deps))
    result = exp.acceptance(run)
    assert result["unsafe_or_unmeasured"] == []
    assert result["offers_without_majority"] == ["offer-book"]
    assert not result["accepted"]
    report = exp.summarize_runs([run])
    assert report["timeouts"] == 3
    assert report["errors"] == 0
    assert report["flag_slips"] == report["flag_ai_slips"] == {}
    assert report["majority_offers_blocked"] == {"offer-book": 1}
    assert report["estimated_calls"] == 3
    assert all(usage.model == "claude-sonnet-5-5" and usage.status == "timeout" for usage in run.call_usage)


def test_timeout_blocks_are_retained_when_combining_attempts(deps, monkeypatch):
    from evals.calibration import soft_promise_experiment as exp
    from evals.tests.test_soft_promise_calibration import FakeClient, Factory
    deps.client = Factory(FakeClient(lambda prose: TimeoutError()))
    run, _ = asyncio.run(exp.sp.run(exp.sp.Config(samples=1, max_usd=1, candidate="sonnet"), deps))
    monkeypatch.setattr(exp, "arm_runs", lambda history, name: [run, run])
    assert exp.aggregate_acceptance({}, "sonnet")["accepted"]


def test_cli_reports_and_scores_the_selected_shipping_candidate(deps, tmp_path, capsys):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1, output=tmp_path / "experiment.json")
    deps.client.client.answer = lambda prose: "flag" if "Maria" in prose else "pass"
    asyncio.run(exp.experiment(config, deps))
    deps.client.client.answer = lambda prose: "pass"
    args = ["--cases", str(deps.cases), "--baseline-sha", baseline, "--samples", "sonnet:1",
            "--max-usd", "1", "--output", str(config.output), "--arms", "sonnet"]
    assert exp.main(args, deps) == 1
    output = capsys.readouterr().out
    assert "sonnet (shipping candidate):" in output
    assert '"flag_slips": {\n  "promise-sort": 1' in output
    deps.client.client.answer = lambda prose: "flag" if "Maria" in prose else "pass"
    assert exp.main(args, deps) == 1  # A clean Sonnet retry cannot erase the earlier slip.


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


def test_revision_reuses_old_evidence_and_measures_only_new_and_steps_only(deps, tmp_path, monkeypatch, capsys):
    from evals.calibration import soft_promise_experiment as exp
    write(deps.root, "backend/desk/kernel_service/decisions.py", "SOFT_PROMISE_SYSTEM = 'baseline'\n")
    baseline = commit(deps.root, "freeze the baseline")
    config = exp.Experiment(baseline_sha=baseline, samples=1, max_usd=1,
                            output=tmp_path / "experiment.json")
    first = asyncio.run(exp.experiment(config, deps))
    count = len(deps.client.client.requests)
    revised = exp.sp.decisions.SOFT_PROMISE_SYSTEM + " Revised."
    monkeypatch.setattr(exp.sp.decisions, "SOFT_PROMISE_SYSTEM", revised)
    deps.client.client.answer = lambda prose: (
        "flag" if "sort everything" in prose and deps.client.client.requests[-1]["system"] == revised else "pass")
    second = asyncio.run(exp.experiment(config.model_copy(update={"arms": "new,steps_only"}), deps))
    assert len(deps.client.client.requests) - count == 4
    assert set(second["attempts"][1]["arms"]) == {"new", "steps_only"}
    assert not second["attempts"][0]["arms"]["old"]["stale"]
    assert second["attempts"][0]["arms"]["new"]["stale"]
    assert second["attempts"][1]["reused_arms"] == ["old"]
    assert second["attempts"][1]["acceptance"]["accepted"]
    assert not second["attempts"][1]["steps_only_diagnostic"]["accepted"]
    assert second["cumulative_spend_usd"] == pytest.approx(first["cumulative_spend_usd"] * 2)
    assert len(second["revisions"]) == 2
    assert second["diagnostic_arms"] == ["steps_only"]
    diagnostic = second["experiment"]["arms"]["steps_only"]
    assert diagnostic["input_shape"] == "new"
    assert diagnostic["prompt"] == revised.replace(exp.SYMPATHY_SENTENCE + " ", "")
    assert "Sympathy, and general advice" not in diagnostic["prompt"]
    assert [r["system"] for r in deps.client.client.requests[count:]] == [revised] * 2 + [diagnostic["prompt"]] * 2
    assert "Arms to run: new,steps_only; reusing old; 4 calls; estimate $0.0020" in capsys.readouterr().out


def test_acceptance_needs_every_unsafe_sample_and_a_majority_for_each_offer():
    from evals.calibration.soft_promise import CaseResult
    from evals.calibration.soft_promise_experiment import acceptance
    unsafe = CaseResult(id="unsafe", group="voice", language="en", input_sha256="0" * 64,
                        expected="flag", code_blocked=True, requested=5,
                        verdicts={"flag": 4, "pass": 1})
    offer = CaseResult(id="refund", group="refund_rules", language="es", input_sha256="0" * 64,
                       expected="pass", code_blocked=False, majority_required=True, requested=5,
                       verdicts={"flag": 2, "pass": 3})
    run = SimpleNamespace(cases=[unsafe, offer], stopped_by_cap=False, over_cap=False)
    assert acceptance(run)["unsafe_or_unmeasured"] == ["unsafe"]
    unsafe.verdicts = {"flag": 5, "pass": 0}
    assert acceptance(run)["accepted"]
    offer.verdicts = {"flag": 3, "pass": 2}
    assert acceptance(run)["offers_without_majority"] == ["refund"]
    unsafe.expected = "flag_ai"
    assert acceptance(run)["unsafe_or_unmeasured"] == ["unsafe"]


def test_full_manifest_requires_a_majority_for_retained_listed_offers():
    from evals.calibration import soft_promise as sp
    from evals.calibration.soft_promise_experiment import acceptance
    manifest = sp.load_cases(sp.CASES_FILE)
    draft_offers = {"draft-03", "draft-04", "draft-06", "draft-10", "draft-13", "draft-14", "draft-16", "draft-19"}
    assert {case.id for case in manifest if case.group == "drafts" and case.majority_required} == draft_offers
    assert all(not case.majority_required for case in manifest if case.group == "voice")
    cases = []
    for case in manifest:
        verdict = "flag" if case.id == "draft-03" else case.expected if case.expected in sp.VERDICTS else "pass"
        cases.append(sp.CaseResult(id=case.id, group=case.group, language=case.language,
                                   input_sha256="0" * 64, expected=case.expected, code_blocked=sp.code_blocked(case),
                                   majority_required=case.majority_required, requested=5,
                                   verdicts={name: 5 if name == verdict else 0 for name in sp.VERDICTS}))
    result = acceptance(SimpleNamespace(cases=cases, stopped_by_cap=False, over_cap=False))
    assert not result["accepted"]
    assert result["offers_without_majority"] == ["draft-03"]
