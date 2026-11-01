"""PR path scoping must only skip suites whose inputs are known to be unchanged."""

import os
import subprocess

import pytest

from desk_tools.changed_paths import classify, main


@pytest.mark.parametrize(
    "paths, expected",
    [
        (["web/src/App.tsx"], {"backend": False, "web": True}),
        (["backend/desk/api/app.py", "evals/run.py", "kernel/core/src/lib.rs"], {"backend": True, "web": False}),
        (["web/package.json", "backend/desk/api/app.py"], {"backend": True, "web": True}),
        *[([path], {"backend": True, "web": True}) for path in [
            "docs/ci.md", ".github/workflows/ci.yml", "tools/desk_tools/gate.py", "Makefile", ".env.example",
            "backend/desk/contracts.schema.json", "backend/desk/api/openapi.json",
            "backend/desk/kernel_service/lexicon/en.txt", "backend/desk/kernel_service/lexicon/nested/es.txt",
            "backend/desk/contracts.py", "backend/desk/money_cap.py", "backend/desk/api/rules.py",
            "backend/desk/kernel_service/seed.py", "backend/desk/kernel_service/render/en.py",
        ]],
        ([], {"backend": True, "web": True}),
        *[(["web/App.tsx", path], {"backend": True, "web": True}) for path in [
            "", "../web/App.tsx", "/web/App.tsx", "web/../backend/app.py", "web//App.tsx",
            '"web/quoted\\nfile"', "web/new\nline", "web/", "web/./App.tsx",
        ]],
    ],
)
def test_classify_pr_paths(paths, expected):
    assert classify(paths, "pull_request") == expected


@pytest.mark.parametrize("event", ["push", "workflow_dispatch", "", "pull_request_target", "unexpected"])
@pytest.mark.parametrize("paths", [[], ["web/package.json"], ["backend/desk/api/app.py"]])
def test_only_pull_requests_are_scoped(event, paths):
    assert classify(paths, event) == {"backend": True, "web": True}


@pytest.mark.parametrize("diff, backend, web", [
    ("web/src/App.tsx\n", "false", "true"),
    ("backend/desk/api/app.py\n", "true", "false"),
    ("", "true", "true"),
    ('"web/escaped\\nfile"\n', "true", "true"),
    (OSError("git missing"), "true", "true"),
    (subprocess.CalledProcessError(128, "git"), "true", "true"),
    (subprocess.TimeoutExpired("git", 30), "true", "true"),
    (UnicodeDecodeError("utf8", b"\xff", 0, 1, "invalid"), "true", "true"),
])
def test_job_writes_explicit_outputs_or_runs_everything_on_git_error(tmp_path, monkeypatch, diff, backend, web):
    output = tmp_path / "outputs"
    output.write_text("existing=value\n")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")

    def git(command, **kwargs):
        assert command == ["git", "-c", "diff.renames=false", "diff", "--name-only", "HEAD^1", "HEAD"]
        assert kwargs == {"check": True, "capture_output": True, "text": True, "timeout": 30}
        if isinstance(diff, Exception):
            raise diff
        return subprocess.CompletedProcess(command, 0, stdout=diff)

    monkeypatch.setattr(subprocess, "run", git)
    main()
    assert output.read_text() == f"existing=value\nbackend={backend}\nweb={web}\n"


@pytest.mark.parametrize("event", ["push", "workflow_dispatch", ""])
def test_non_pr_job_does_not_need_git(tmp_path, monkeypatch, event):
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", event)

    def no_git(*args, **kwargs):
        pytest.fail("Non-PR events must run everything without consulting git")

    monkeypatch.setattr(subprocess, "run", no_git)
    main()
    assert output.read_text() == "backend=true\nweb=true\n"


def test_merge_diff_includes_the_old_path_of_a_rename_into_web(tmp_path, monkeypatch):
    """A deleted backend input must not disappear behind git's rename detection."""
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=repo, check=True, capture_output=True, text=True,
            env={"PATH": os.environ["PATH"], "HOME": str(tmp_path),
                 "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
        ).stdout

    git("init", "-b", "main")
    git("config", "user.name", "CI test")
    git("config", "user.email", "ci@example.test")
    backend = repo / "backend"
    backend.mkdir()
    (backend / "input.txt").write_text("a backend input\n")
    git("add", ".")
    git("commit", "-m", "base")
    git("checkout", "-b", "change")
    (repo / "web").mkdir()
    (backend / "input.txt").rename(repo / "web/input.txt")
    git("add", ".")
    git("commit", "-m", "move input")
    git("checkout", "main")
    git("merge", "--no-ff", "change", "-m", "merge")
    output = tmp_path / "outputs"
    monkeypatch.chdir(repo)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    main()
    assert output.read_text() == "backend=true\nweb=true\n"
