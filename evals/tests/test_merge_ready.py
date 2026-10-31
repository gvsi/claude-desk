"""Merge readiness against a moving main, using real commits in a throwaway repo."""

import subprocess
from pathlib import Path

import pytest

from evals import results, run
from evals.tests.eval_repo import commit, git, make_repo, write


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = make_repo(tmp_path / "repo")
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(root, "checkout", "-q", "-b", "plan/change")
    return root


def change(repo: Path, path: str) -> None:
    write(repo, path, "A change on this branch.\n")
    commit(repo, f"change {path}")


def change_main(repo: Path, path: str) -> None:
    git(repo, "checkout", "-q", "main")
    change(repo, path)
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "plan/change")


def test_both_sides_gated_refuses_and_names_each_sides_paths(repo):
    change(repo, "kernel/src/lib.rs")
    change_main(repo, "backend/desk/api/prompts.py")

    ready, reason = results.merge_ready(root=repo)

    assert not ready
    assert "PR gated paths: 'kernel/src/lib.rs'" in reason
    assert "origin/main gated paths: 'backend/desk/api/prompts.py'" in reason
    assert len(reason.splitlines()) == 1


def test_only_pr_gated_is_ready(repo):
    change(repo, "kernel/src/lib.rs")
    change_main(repo, "README.md")

    assert results.merge_ready(root=repo)[0]


def test_only_main_gated_is_ready(repo):
    change(repo, "README.md")
    change_main(repo, "backend/desk/api/prompts.py")

    assert results.merge_ready(root=repo)[0]


def test_neither_side_gated_is_ready(repo):
    change(repo, "README.md")
    change_main(repo, "docs/guide.md")

    assert results.merge_ready(root=repo)[0]


def test_head_containing_origin_main_is_ready(repo):
    change(repo, "kernel/src/lib.rs")
    change_main(repo, "backend/desk/api/prompts.py")
    git(repo, "merge", "-q", "--no-edit", "origin/main")

    assert results.merge_ready(root=repo)[0]


def test_cli_returns_one_and_one_line_when_not_ready(repo, capsys):
    change(repo, "kernel/src/lib.rs")
    change_main(repo, "backend/desk/api/prompts.py")

    assert run.merge_ready([], root=repo) == 1
    output = capsys.readouterr()
    assert output.out.startswith("merge-ready: not ready:")
    assert len(output.out.splitlines()) == 1
    assert not output.err


@pytest.mark.parametrize("path", ["evals/recorded_rates.json", "evals/results/new.json"])
@pytest.mark.parametrize("side", ["pr", "main"])
def test_extra_results_inputs_on_either_side_also_block(repo, path, side):
    change(repo, path if side == "pr" else "kernel/src/lib.rs")
    change_main(repo, path if side == "main" else "backend/desk/api/prompts.py")

    ready, reason = results.merge_ready(root=repo)

    assert not ready
    assert repr(path) in reason


def test_explicit_head_is_checked_instead_of_checked_out_branch(repo):
    change(repo, "kernel/src/lib.rs")
    change_main(repo, "backend/desk/api/prompts.py")
    git(repo, "checkout", "-q", "main")

    assert results.merge_ready(root=repo)[0]
    assert not results.merge_ready("plan/change", root=repo)[0]


def test_move_out_of_gated_directory_still_blocks(repo):
    git(repo, "mv", "kernel/src/lib.rs", "ungated.rs")
    commit(repo, "move the kernel file out")
    change_main(repo, "backend/desk/api/prompts.py")

    ready, reason = results.merge_ready(root=repo)

    assert not ready
    assert "'kernel/src/lib.rs'" in reason


def test_unusual_paths_keep_the_diagnostic_on_one_line(repo):
    path = "kernel/src/naïve\nfile.rs"
    change(repo, path)
    change_main(repo, "backend/desk/api/prompts.py")

    ready, reason = results.merge_ready(root=repo)

    assert not ready
    assert repr(path) in reason
    assert len(reason.splitlines()) == 1


@pytest.mark.parametrize("args", [[], ["--head", "plan/change"]])
def test_cli_returns_zero_and_one_line_when_ready(repo, capsys, args):
    assert run.merge_ready(args, root=repo) == 0
    output = capsys.readouterr()
    assert output.out.startswith("merge-ready: ready:")
    assert len(output.out.splitlines()) == 1
    assert not output.err
    assert run.COMMANDS["merge-ready"] is run.merge_ready


@pytest.mark.parametrize("case", ["missing head", "missing main", "not a repo", "unrelated histories"])
def test_cli_git_errors_return_two(repo, tmp_path, capsys, case):
    args = []
    if case == "missing head":
        args = ["--head", "missing"]
    elif case == "missing main":
        git(repo, "update-ref", "-d", "refs/remotes/origin/main")
    elif case == "not a repo":
        repo = tmp_path
    else:
        git(repo, "checkout", "-q", "--orphan", "unrelated")
        commit(repo, "unrelated root")

    assert run.merge_ready(args, root=repo) == 2
    output = capsys.readouterr()
    assert output.out.startswith("merge-ready: error:")
    assert len(output.out.splitlines()) == 1
    assert not output.err


def test_cli_non_utf8_filename_returns_two(repo, capsys):
    # Build the tree directly: some filesystems refuse non-UTF-8 filenames.
    blob = git(repo, "rev-parse", "HEAD:kernel/src/lib.rs")
    entries = git(repo, "ls-tree", "HEAD").encode() + b"\n"
    entries += f"100644 blob {blob}\t".encode() + b"invalid-\xff.rs\n"
    tree = subprocess.run(
        ["git", "-C", str(repo), "mktree"], input=entries, capture_output=True, check=True,
    ).stdout.decode().strip()
    head = git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "add a non-UTF-8 filename")
    git(repo, "update-ref", "HEAD", head)

    assert run.merge_ready([], root=repo) == 2
    output = capsys.readouterr()
    assert output.out.startswith("merge-ready: error:")
    assert "decode" in output.out
    assert len(output.out.splitlines()) == 1
    assert not output.err


@pytest.mark.parametrize("args", [["--head"], ["--unknown"], ["--hea", "HEAD"]])
def test_cli_usage_errors_return_two(args):
    with pytest.raises(SystemExit) as error:
        run.main(["merge-ready", *args])
    assert error.value.code == 2


@pytest.mark.parametrize("head", [None, "origin/plan/change"])
def test_make_target_passes_default_or_selected_head(head):
    command = ["make", "--no-print-directory", "-n", "evals-merge-ready"]
    if head is not None:
        command.append(f"HEAD={head}")
    planned = subprocess.run(command, cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True)

    assert planned.returncode == 0, planned.stderr
    assert planned.stdout.strip().endswith(f'python -m evals.run merge-ready --head "{head or "HEAD"}"')
