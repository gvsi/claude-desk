"""The CI gate runs a suite, skips it visibly or fails, by whether the paths that mark its code exist."""

import sys
from pathlib import Path

import pytest

from desk_tools.gate import main


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """An empty checkout as the working directory, with its own job summary file."""
    checkout = tmp_path / "repo"
    checkout.mkdir()
    monkeypatch.chdir(checkout)
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary.md"))
    return checkout


def summary(repo: Path) -> str:
    path = repo.parent / "summary.md"
    return path.read_text() if path.exists() else ""


def touch(name: str) -> list[str]:
    """A command that records it ran by creating `name`."""
    return [sys.executable, "-c", f"open({name!r}, 'w').close()"]


def test_runs_command_when_every_run_if_path_exists(repo):
    (repo / "web").mkdir()
    (repo / "web" / "package.json").write_text("{}")
    (repo / "evals").mkdir()

    code = main(["--name", "web", "--run-if", "web/package.json", "--run-if", "evals", "--", *touch("ran")])

    assert code == 0
    assert (repo / "ran").exists()
    assert summary(repo) == ""


def test_propagates_command_exit_code(repo):
    (repo / "evals").mkdir()

    code = main(["--name", "tier1", "--run-if", "evals", "--", sys.executable, "-c", "raise SystemExit(3)"])

    assert code == 3


def test_makefile_error_fails(repo, capsys):
    (repo / "backend/desk/kernel_service").mkdir(parents=True)
    (repo / "backend/desk/kernel_service/compiler.py").write_text("")
    argv = ["--name", "proofs", "--run-if", "backend/desk/kernel_service/compiler.py", "--", "make", "check-presets"]

    for makefile in [
        "check-presets:\n\ttouch recipe-ran\nnot make syntax\n",  # a syntax error
        "kernel:\n\ttouch recipe-ran\n",  # no such target
        None,  # no Makefile
    ]:
        if makefile is None:
            (repo / "Makefile").unlink()
        else:
            (repo / "Makefile").write_text(makefile)

        code = main(argv)

        assert code == 2, makefile
        assert not (repo / "recipe-ran").exists(), makefile
        assert "skipped" not in capsys.readouterr().out, makefile
    assert summary(repo) == ""


def test_fails_when_required_but_absent(repo, capsys):
    (repo / "backend/desk/kernel_service").mkdir(parents=True)
    (repo / "backend/desk/kernel_service/app.py").write_text("")

    code = main(
        [
            "--name", "tier1",
            "--run-if", "evals/run.py",
            "--required-if", "evals/results",
            "--required-if", "backend/desk/kernel_service/app.py",
            "--", *touch("ran"),
        ]
    )

    assert code == 1
    assert not (repo / "ran").exists()
    assert capsys.readouterr().err == (
        "`tier1` is required by `backend/desk/kernel_service/app.py` but `evals/run.py` is missing\n"
    )
    assert summary(repo) == ""


def test_skips_visibly_when_nothing_requires_it(repo, capsys, monkeypatch):
    (repo / "web").mkdir()
    (repo / "web" / "package.json").write_text("{}")
    argv = [
        "--name", "web-e2e",
        "--run-if", "web/package.json",
        "--run-if", "web/playwright.config.ts",
        "--required-if", "evals/run.py",
        "--", *touch("ran"),
    ]
    line = "`web-e2e`: skipped, `web/playwright.config.ts` is not in the repo yet\n"

    code = main(argv)

    assert code == 0
    assert not (repo / "ran").exists()
    assert capsys.readouterr().out == line
    assert summary(repo) == line

    # Outside GitHub Actions the line still reaches the log.
    monkeypatch.delenv("GITHUB_STEP_SUMMARY")
    code = main(argv)

    assert code == 0
    assert capsys.readouterr().out == line
    assert summary(repo) == line


def test_usage_errors_exit_2(repo, capsys):
    (repo / "web").mkdir()
    run = touch("ran")
    for argv in [
        ["--name", "web", "--run-if", "web", *run],  # no `--`
        ["--name", "web", "--run-if", "web", "--"],  # no command
        ["--run-if", "web", "--", *run],  # no --name
        ["--name", "web", "--", *run],  # no --run-if
        ["--name", "web", "--run-if", "", "--", *run],  # empty path, which would mean the working directory
        ["--name", "web", "--run-if", "web", "--required-if", "", "--", *run],
        ["--name", "proofs", "--run-if", "make:check-presets", "--", *run],  # make targets aren't probed
        ["--name", "web", "--run-if", "web", "--unknown", "--", *run],
    ]:
        code = main(argv)

        assert code == 2, argv
        assert not (repo / "ran").exists(), argv
        assert "usage:" in capsys.readouterr().err, argv
    assert summary(repo) == ""
