"""Pending-only heads need no placeholder evidence; runnable heads keep the strict check."""

import json
import subprocess
from pathlib import Path

import pytest

from evals import results, run
from evals.tests.eval_repo import commit, git, make_repo, scenario_yaml, set_landed, write
from evals.tier2.schema import RecordedRates, wilson_lower_95
from evals.waivers import WAIVERS_PATH


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


@pytest.mark.parametrize("change", ["reason", "signer", "timestamp", "reorder", "delete entry", "delete file",
                                   "append", "unreadable head", "unreadable base", "malformed append",
                                   "object", "invalid json", "hits boolean", "rep float"])
def test_unarmed_head_keeps_waiver_history(tmp_path: Path, change: str):
    from evals.tests.test_waivers import waiver_data
    from evals.waivers import Waiver

    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    history = [Waiver.model_validate(waiver_data(pass_id=f"older-pass-{n}")).model_dump(mode="json")
               for n in (1, 2)]
    write(repo, WAIVERS_PATH, json.dumps(history))
    base = commit(repo, "the waiver history to preserve")
    if change.startswith("unreadable"):
        git(repo, "update-index", "--cacheinfo", f"160000,{base},{WAIVERS_PATH}")
        git(repo, "commit", "-q", "-m", "unreadable waiver registry")
        if change == "unreadable base":
            base = git(repo, "rev-parse", "HEAD")
            # The readable working-tree file must not conceal unreadable committed evidence.
            write(repo, "kernel/src/lib.rs", "// changed after restoring readable waivers\n")
            commit(repo, "restore readable waivers at head")
    else:
        altered = json.loads(json.dumps(history))
        if change == "reason":
            altered[0]["reason"] = "A rewritten reason."
        elif change == "signer":
            altered[0]["signed_off_by"] = "Another signer"
        elif change == "timestamp":
            altered[0]["signed_at"] = altered[0]["signed_at"].replace("Z", "+00:00")
        elif change == "reorder":
            altered.reverse()
        elif change == "delete entry":
            altered.pop()
        elif change == "append":
            altered.append({**history[0], "pass_id": "newer-pass"})
        elif change == "malformed append":
            altered.append({"bogus": 1})
        elif change == "hits boolean":
            altered[0]["hits"] = True
        elif change == "rep float":
            altered[0]["rep"] = 1.0
        if change == "delete file":
            (repo / WAIVERS_PATH).unlink()
        else:
            contents = {"object": "{}", "invalid json": "["}.get(change, json.dumps(altered))
            write(repo, WAIVERS_PATH, contents)
        commit(repo, "change waiver history while every scenario is pending")

    passed, reason = results.results_check(base, repo)

    if change == "append":
        assert passed and "no results file is needed" in reason, reason
    elif change.startswith("unreadable"):
        assert not passed and WAIVERS_PATH in reason and "can't be read as a file" in reason, reason
    elif change in ("malformed append", "object", "invalid json", "hits boolean", "rep float"):
        assert not passed and "the head's eval files don't load" in reason, reason
    else:
        assert not passed and "waivers.json rewrites the history" in reason, reason
    if change in ("hits boolean", "rep float"):
        # History comparison itself must distinguish JSON types, independent of schema validation.
        with pytest.raises(results.CheckFailed, match="waivers.json rewrites the history"):
            results._check_waiver_history("HEAD", base, repo)


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


@pytest.mark.parametrize("side", ["pr", "main"])
@pytest.mark.parametrize("change", ["rewrite", "delete", "append", "malformed append"])
def test_unarmed_merge_preserves_waiver_history(tmp_path: Path, side: str, change: str):
    from evals.tests.test_waivers import waiver_data
    from evals.waivers import Waiver

    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    entry = Waiver.model_validate(waiver_data(pass_id="older-pass")).model_dump(mode="json")
    write(repo, WAIVERS_PATH, json.dumps([entry]))
    commit(repo, "the shared waiver history")
    git(repo, "checkout", "-q", "-b", "plan/change")
    for current in ("pr", "main"):
        if current == "main":
            git(repo, "checkout", "-q", "main")
        write(repo, "kernel/src/lib.rs" if current == "pr" else "backend/desk/api/prompts.py", current)
        if current == side:
            if change == "rewrite":
                history = [{**entry, "reason": "A rewritten attestation."}]
            elif change == "delete":
                history = []
            elif change == "malformed append":
                history = [entry, {"bogus": 1}]
            else:
                history = [entry, {**entry, "pass_id": "newer-pass"}]
            write(repo, WAIVERS_PATH, json.dumps(history))
        commit(repo, f"{current} changes inputs while pending")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")

    ready, reason = results.merge_ready(root=repo)

    if change == "append":
        assert ready and "no results file is needed" in reason, reason
    elif change == "malformed append":
        assert not ready and "eval files don't load" in reason, reason
    else:
        assert not ready and "waivers.json rewrites the history" in reason, reason


def test_merge_ready_refuses_pending_merge_with_a_scenario_in_both_splits(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    original = (repo / results.SPLITS_PATH).read_text()
    git(repo, "checkout", "-q", "-b", "plan/change")
    write(repo, "evals/tier2/scenarios/atk-new.yaml", scenario_yaml("atk-new"))
    write(repo, results.SPLITS_PATH, original.replace("calibration:\n", "calibration:\n- atk-new\n"))
    pr = commit(repo, "add a calibration scenario")
    git(repo, "checkout", "-q", "main")
    write(repo, "evals/tier2/scenarios/atk-new.yaml", scenario_yaml("atk-new"))
    write(repo, results.SPLITS_PATH, original.replace("heldout:\n", "heldout:\n- atk-new\n"))
    main = commit(repo, "add the same scenario to heldout")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")
    assert results.results_check("main~1", repo)[0]
    git(repo, "checkout", "-q", "main")
    assert results.results_check("main~1", repo)[0]
    git(repo, "checkout", "-q", "plan/change")
    merged = git(repo, "merge-tree", "--write-tree", pr, main)
    assert results.unarmed(merged, repo)

    ready, reason = results.merge_ready(root=repo)

    assert not ready
    assert reason.startswith("not ready:")
    assert "atk-new is in both splits" in reason


@pytest.mark.parametrize("scenario_side", ["pr", "main"])
@pytest.mark.parametrize("shared_id", [False, True])
@pytest.mark.parametrize("split_plans", [False, True])
def test_merge_ready_refuses_a_scenario_armed_by_the_union(
    tmp_path: Path, scenario_side: str, shared_id: bool, split_plans: bool,
):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"), scenarios={
        sid: {"requires": ["01c", "02"]} for sid in ("atk-cal", "atk-held", "leg-cal", "leg-held")
    })
    if split_plans:
        # Add plans at opposite ends so the merge tests the union, rather than a text conflict.
        write(repo, results.LANDED_PATH, 'plans = [\n"master",\n"01a",\n]\n')
        commit(repo, "multiline landed plans")
    git(repo, "checkout", "-q", "-b", "plan/change")

    def side_change(side: str) -> None:
        write(repo, "kernel/src/lib.rs" if side == "pr" else "backend/desk/api/prompts.py", side + "\n")
        if side == scenario_side:
            sid = "atk-held" if shared_id else "atk-union"
            required = ["01b", "02"] if split_plans else ["02"]
            write(repo, f"evals/tier2/scenarios/{sid}.yaml", scenario_yaml(sid, requires=required))
            if split_plans:
                write(repo, results.LANDED_PATH, 'plans = [\n"01b",\n"master",\n"01a",\n]\n')
        else:
            if split_plans:
                write(repo, results.LANDED_PATH, 'plans = [\n"master",\n"01a",\n"02",\n]\n')
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
    from evals.tests.test_results import run_free_at_head

    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    stale = await run_free_at_head(repo)
    write(repo, "kernel/src/lib.rs", "// changed after pending-only results\n")
    commit(repo, "a gated change after placeholder results")
    assert stale.name != f"{results.inputs_key('HEAD', repo)}.json"

    passed, reason = results.results_check(base, repo)

    assert passed, reason
    assert "no results file is needed" in reason


@pytest.mark.parametrize(("path", "contents"), [
    (results.LANDED_PATH, "invalid\n"),
    ("evals/tier2/scenarios/atk-held.yaml", "invalid\n"),
    (results.RATES_PATH, "invalid\n"),
    (WAIVERS_PATH, "invalid\n"),
    (WAIVERS_PATH, '[{"pass_id": "x", "oracle": "private.marker"}]\n'),
])
def test_malformed_committed_eval_files_cannot_claim_an_unarmed_pass(tmp_path: Path, path: str, contents: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    write(repo, path, contents)
    commit(repo, "malformed committed eval data")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert "the head's eval files don't load" in reason


@pytest.mark.parametrize(("side", "path", "existing"), [
    ("head", results.RATES_PATH, True),
    ("head", results.LANDED_PATH, True),
    ("head", WAIVERS_PATH, True),
    ("head", "evals/results/aaaaaaaaaaaaaaaa.json", False),
    ("head", "evals/results/aaaaaaaaaaaaaaaa.json", True),
    ("base", results.RATES_PATH, True),
    ("base", results.LANDED_PATH, True),
    ("base", WAIVERS_PATH, True),
])
@pytest.mark.parametrize("kind", ["gitlink", "tree", "missing blob"])
def test_unreadable_committed_files_fail_closed(tmp_path: Path, side: str, path: str, existing: bool, kind: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    if existing and path.startswith(results.RESULTS_DIR):
        write(repo, path, "{}\n")
    if path == WAIVERS_PATH:
        write(repo, path, "[]\n")
    base = commit(repo, "the unarmed base")
    original = git(repo, "rev-parse", f"HEAD:{path}") if existing else None
    missing_oid = None
    if kind == "gitlink":
        git(repo, "update-index", "--add", "--cacheinfo", f"160000,{base},{path}")
        git(repo, "commit", "-q", "-m", "unreadable gitlink")
    elif kind == "tree":
        if (repo / path).exists():
            (repo / path).unlink()
        write(repo, path + "/child", "not a file\n")
        commit(repo, "directory in place of evidence")
    else:
        write(repo, path, '{"history": [], "unreadable": true}\n')
        commit(repo, "evidence with a missing blob")
        missing_oid = git(repo, "rev-parse", f"HEAD:{path}")
    unreadable = git(repo, "rev-parse", "HEAD")
    if side == "base":
        base = unreadable
        # Restore only the index: working-tree evidence must never influence the check.
        if kind == "tree":
            git(repo, "update-index", "--force-remove", path + "/child")
        git(repo, "update-index", "--add", "--cacheinfo", f"100644,{original},{path}")
        write(repo, "kernel/src/lib.rs", "// gated change after restoring readable evidence\n")
        git(repo, "add", "kernel/src/lib.rs")
        git(repo, "commit", "-q", "-m", "restore readable evidence at head")
    if missing_oid is not None:
        (repo / ".git/objects" / missing_oid[:2] / missing_oid[2:]).unlink()

    with pytest.raises(results.GitError, match="can't be read as a file"):
        results.show(repo, unreadable, path)
    passed, reason = results.results_check(base, repo)
    assert not passed
    assert path in reason and "can't be read as a file" in reason


@pytest.mark.parametrize("splits", ["calibration: 3\nheldout: []\n",
                                  "calibration: [atk-cal, leg-cal]\nheldout: [atk-held]\n"])
def test_unarmed_head_checks_its_committed_splits(tmp_path: Path, splits: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = commit(repo, "the unarmed base")
    write(repo, "evals/splits.yaml", splits)
    commit(repo, "invalid head splits")

    passed, reason = results.results_check(base, repo)

    assert not passed
    assert reason.startswith("the head's splits don't hold its suite:")


@pytest.mark.parametrize("side", ["pr", "main"])
@pytest.mark.parametrize("history", ["recorded", "gitlink", "malformed"])
def test_merge_ready_checks_each_sides_rate_history(tmp_path: Path, side: str, history: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "-b", "plan/change")
    for current in ("pr", "main"):
        if current == "main":
            git(repo, "checkout", "-q", "main")
        write(repo, "kernel/src/lib.rs" if current == "pr" else "backend/desk/api/prompts.py", current)
        if current == side and history != "gitlink":
            write(repo, results.RATES_PATH, recorded_history() if history == "recorded" else "invalid")
        commit(repo, f"{current} gated change")
        if current == side and history == "gitlink":
            git(repo, "update-index", "--cacheinfo", f"160000,{base},{results.RATES_PATH}")
            git(repo, "commit", "-q", "-m", "unreadable rates")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")

    if history == "recorded":
        assert not results.merge_ready(root=repo)[0]
    else:
        with pytest.raises(results.GitError, match="recorded_rates.json"):
            results.merge_ready(root=repo)


def test_merge_ready_checks_the_actual_merge_for_a_newly_runnable_scenario(tmp_path: Path):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"), scenarios={
        sid: {"requires": ["01b", "01a", "01c", "02"]} for sid in ("atk-cal", "atk-held", "leg-cal", "leg-held")
    })
    path = "evals/tier2/scenarios/atk-held.yaml"
    original = (repo / path).read_text()
    git(repo, "checkout", "-q", "-b", "plan/change")
    write(repo, path, original.replace("- 01b\n", ""))
    commit(repo, "PR removes one prerequisite")
    git(repo, "checkout", "-q", "main")
    write(repo, path, original.replace("- 01c\n", ""))
    set_landed(repo, ("master", "01a", "02"))
    commit(repo, "main removes the other prerequisite and lands 02")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")
    assert results.unarmed(root=repo, other_rev="origin/main")
    merged = git(repo, "merge-tree", "--write-tree", "HEAD", "origin/main")
    assert not results.unarmed(merged, repo)

    assert not results.merge_ready(root=repo)[0]


@pytest.mark.parametrize("failure", ["conflict", "command error"])
def test_merge_ready_fails_closed_when_the_merge_tree_cannot_be_built(tmp_path: Path, monkeypatch, capsys, failure: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    git(repo, "checkout", "-q", "-b", "plan/change")
    write(repo, "kernel/src/lib.rs", "// PR\n")
    commit(repo, "PR gated change")
    git(repo, "checkout", "-q", "main")
    write(repo, "kernel/src/lib.rs", "// main\n")
    commit(repo, "main conflicting gated change")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")
    if failure == "command error":
        real_run = subprocess.run

        def fail_merge(command, *args, **kwargs):
            if "merge-tree" in command:
                return subprocess.CompletedProcess(command, 128, "", "merge-tree unavailable")
            return real_run(command, *args, **kwargs)

        monkeypatch.setattr(subprocess, "run", fail_merge)
        with pytest.raises(results.GitError, match="merge-tree unavailable"):
            results.merge_ready(root=repo)
        assert run.merge_ready([], root=repo) == 2
        assert "merge-ready: error:" in capsys.readouterr().out
    else:
        ready, reason = results.merge_ready(root=repo)
        assert not ready
        assert reason == ("not ready: the PR conflicts with origin/main in 'kernel/src/lib.rs'; "
                          "rebase onto origin/main")
        assert run.merge_ready([], root=repo) == 1
        output = capsys.readouterr().out
        assert "merge-ready: " + reason in output
        assert len(output.splitlines()) == 1


def test_push_to_main_from_readme_root_goes_strict_as_soon_as_02_lands(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "evals@example.invalid")
    git(repo, "config", "user.name", "Evals")
    git(repo, "config", "commit.gpgsign", "false")
    write(repo, "README.md", "The first commit.\n")
    root = commit(repo, "README only")
    make_repo(repo, landed=("master", "01a"))

    passed, reason = results.results_check(root, repo)
    assert passed, reason
    assert "every scenario is pending" in reason

    set_landed(repo, ("master", "01a", "02"))
    commit(repo, "arm the gate")
    passed, reason = results.results_check(root, repo)
    assert not passed
    assert reason == (f"evals/results/{results.inputs_key('HEAD', repo)}.json isn't committed: "
                      "the head's gated inputs have no results file "
                      "(run make evals-tier2 and commit what it writes)")


def test_merge_ready_cli_returns_two_for_malformed_landed_on_main(tmp_path: Path, capsys):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    git(repo, "checkout", "-q", "-b", "plan/change")
    write(repo, "kernel/src/lib.rs", "// PR\n")
    commit(repo, "PR gated change")
    git(repo, "checkout", "-q", "main")
    write(repo, results.LANDED_PATH, "invalid\n")
    commit(repo, "malformed main landed plans")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")

    assert run.merge_ready([], root=repo) == 2
    assert "merge-ready: error:" in capsys.readouterr().out


@pytest.mark.parametrize("path", ["evals/tier2/scenarios/atk-held.yaml", WAIVERS_PATH])
def test_merge_ready_cli_returns_two_for_a_gitlink_on_main(tmp_path: Path, capsys, path: str):
    repo = make_repo(tmp_path / "repo", landed=("master", "01a"))
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "-b", "plan/change")
    write(repo, "kernel/src/lib.rs", "// PR\n")
    commit(repo, "PR gated change")
    git(repo, "checkout", "-q", "main")
    git(repo, "update-index", "--add", "--cacheinfo", f"160000,{base},{path}")
    git(repo, "commit", "-q", "-m", "unreadable eval file on main")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")

    with pytest.raises(results.GitError, match=path):
        results.merge_ready(root=repo)
    assert run.merge_ready([], root=repo) == 2
    output = capsys.readouterr().out
    assert "merge-ready: error:" in output
    assert path in output and "can't be read as a file" in output
