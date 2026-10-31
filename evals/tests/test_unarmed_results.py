"""Pending-only heads need no placeholder evidence; runnable heads keep the strict check."""

import json
from pathlib import Path

import pytest

from evals import results
from evals.tests.eval_repo import commit, git, make_repo, scenario_yaml, set_landed, write
from evals.tier2.schema import RecordedRates, wilson_lower_95


def recorded_history() -> str:
    rates = RecordedRates.model_validate({"history": [{
        "run_id": "recorded-run", "recorded_at": "2026-10-30T00:00:00Z", "completion_point": 1.0,
        "completion_lower_95": wilson_lower_95(3, 3), "trials": 3, "heldout_sha256": "a" * 64,
        "provider": "anthropic", "model_ids": results.RATE_MODEL_IDS,
        "report": "evals/reports/recorded-run.md", "reason": "First held-out run", "signed_off_by": "The owner",
    }]})
    return rates.model_dump_json()


def test_unarmed_gated_head_needs_no_results_file(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    write(repo, "kernel/src/lib.rs", "// changed kernel\n")
    commit(repo, "a gated change without placeholder results")

    passed, reason = results.results_check(base, repo)

    assert passed, reason
    assert "every scenario is pending" in reason
    assert "no results file is needed" in reason
    assert "strict check applies once any scenario can run" in reason


def test_one_runnable_scenario_restores_the_exact_missing_file_failure(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"), scenarios={
        "atk-held": {"requires": ["02"]},
        **{sid: {"requires": ["01b", "02"]} for sid in ("atk-cal", "leg-cal", "leg-held")},
    })
    base = commit(repo, "the unarmed base")
    write(repo, "kernel/src/lib.rs", "// changed kernel\n")
    set_landed(repo, ("master", "01a", "02"))
    commit(repo, "one scenario becomes runnable with the gated change")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert reason == (f"evals/results/{results.inputs_key('HEAD', repo)}.json isn't committed: "
                      "the head's gated inputs have no results file "
                      "(run make evals-tier2 and commit what it writes)")


def test_unarmed_head_with_a_recorded_rate_fails_closed(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    write(repo, "evals/recorded_rates.json", recorded_history())
    commit(repo, "a rate means the gate was armed once")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert "recorded_rates.json has a recorded rate" in reason
    assert "unarmed" in reason


@pytest.mark.parametrize("history", ["rate deleted", "rate rewritten", "landed plan dropped"])
def test_unarmed_head_keeps_rate_history_and_landed_plans(tmp_path: Path, history: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a", "01b"))
    if history.startswith("rate"):
        write(repo, "evals/recorded_rates.json", recorded_history())
    base = commit(repo, "the history to preserve")
    write(repo, "kernel/src/lib.rs", "// changed kernel\n")
    if history == "rate deleted":
        write(repo, "evals/recorded_rates.json", '{"history": []}\n')
    elif history == "rate rewritten":
        data = json.loads(recorded_history())
        data["history"][0]["reason"] = "Rewritten reason"
        write(repo, "evals/recorded_rates.json", json.dumps(data))
    else:
        set_landed(repo, ("master", "01a"))
    commit(repo, "rewrite committed history while still pending")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert ("rewrites the history" if history.startswith("rate") else "drops plans") in reason


@pytest.mark.parametrize("existing", [False, True])
def test_unarmed_head_still_validates_added_or_edited_results(tmp_path: Path, existing: bool):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    path = "evals/results/" + "a" * 16 + ".json"
    if existing:
        write(repo, path, '{"pass_id": "old"}\n')
    base = commit(repo, "the unarmed base")
    write(repo, path, '{"pass_id": "edited"}\n')
    commit(repo, "invalid results while every scenario is pending")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert f"{path} doesn't validate" in reason


def test_merge_ready_accepts_two_unarmed_sides_with_gated_changes(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    git(repo, "checkout", "-q", "-b", "plan/change")
    write(repo, "kernel/src/lib.rs", "// PR change\n")
    commit(repo, "PR gated change")
    git(repo, "checkout", "-q", "main")
    write(repo, "backend/desk/api/prompts.py", "# main change\n")
    commit(repo, "main gated change")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")

    ready, reason = results.merge_ready(root=repo)

    assert ready, reason
    assert "every scenario is pending" in reason


@pytest.mark.parametrize("scenario_side", ["pr", "main"])
@pytest.mark.parametrize("shared_id", [False, True])
@pytest.mark.parametrize("split_plans", [False, True])
def test_merge_ready_refuses_a_scenario_armed_by_the_union(
    tmp_path: Path, scenario_side: str, shared_id: bool, split_plans: bool,
):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"), scenarios={
        sid: {"requires": ["01c", "02"]} for sid in ("atk-cal", "atk-held", "leg-cal", "leg-held")
    })
    git(repo, "checkout", "-q", "-b", "plan/change")

    def side_change(side: str) -> None:
        write(repo, "kernel/src/lib.rs" if side == "pr" else "backend/desk/api/prompts.py", side + "\n")
        if side == scenario_side:
            sid = "atk-held" if shared_id else "atk-union"
            required = ["01b", "02"] if split_plans else ["02"]
            write(repo, f"evals/tier2/scenarios/{sid}.yaml", scenario_yaml(sid, requires=required))
            if split_plans:
                set_landed(repo, ("master", "01a", "01b"))
        else:
            set_landed(repo, ("master", "01a", "02"))
        commit(repo, f"{side} remains pending alone")

    side_change("pr")
    git(repo, "checkout", "-q", "main")
    side_change("main")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")
    assert results.unarmed("HEAD", repo)
    assert results.unarmed("origin/main", repo)

    ready, reason = results.merge_ready(root=repo)

    assert not ready
    assert "PR gated paths:" in reason and "origin/main gated paths:" in reason
    assert "rebase onto origin/main and regenerate the results file" in reason


def test_unarmed_reads_the_requested_commits_not_the_working_tree(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    pending = commit(repo, "the unarmed commit")
    set_landed(repo, ("master", "01a", "02"))
    runnable = commit(repo, "the runnable commit")
    set_landed(repo, ("master", "01a"))

    assert results.unarmed(pending, repo)
    assert not results.unarmed(runnable, repo)
    assert not results.unarmed(root=repo)


async def test_valid_pending_results_need_no_regeneration_after_a_gated_change(tmp_path: Path):
    from evals.tests.test_results import results_at_head

    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    stale = await results_at_head(repo)
    write(repo, "kernel/src/lib.rs", "// changed after pending-only results\n")
    commit(repo, "a gated change after placeholder results")
    assert stale.name != f"{results.inputs_key('HEAD', repo)}.json"

    passed, reason = results.results_check(base, repo)

    assert passed, reason
    assert "no results file is needed" in reason


@pytest.mark.parametrize("path", ["evals/tier1/landed.toml", "evals/tier2/scenarios/atk-held.yaml"])
def test_malformed_committed_eval_files_cannot_claim_an_unarmed_pass(tmp_path: Path, path: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    write(repo, path, "invalid\n")
    commit(repo, "malformed committed eval data")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert "the head's eval files don't load" in reason
