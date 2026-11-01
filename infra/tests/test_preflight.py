"""preflight.py: nothing deploys unless the tree is clean, HEAD is on origin/main, HEAD passes
the tier 2 results check, both owner secrets are set, and the web app builds and checks at
HEAD. The first failure stops it, named, before any later check runs."""

import os
import stat
import subprocess
from pathlib import Path

import pytest
from botocore.stub import Stubber
from conftest import load_script, unsigned_client

OWNER_SECRETS = ("desk/anthropic-api-key", "desk/passcode-hash")

# Stand-ins for make and npm: each logs its arguments and directory, and fails when told to.
MAKE_STUB = """#!/bin/sh
echo "make $* @ $(pwd)" >> "$STUB_LOG"
if [ -n "${MAKE_OUTPUT:-}" ]; then echo "$MAKE_OUTPUT"; fi
exit "${MAKE_STATUS:-0}"
"""
NPM_STUB = """#!/bin/sh
echo "npm $* @ $(pwd)" >> "$STUB_LOG"
if [ "$*" = "${NPM_FAIL:-}" ]; then echo "npm: $* failed"; exit 1; fi
if [ "$*" = "run build" ]; then mkdir -p dist/assets && echo '<!doctype html>' > dist/index.html; fi
exit 0
"""


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A clean clone of a one-branch origin, three commits deep, with make and npm stubbed."""
    for name, value in {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
                        "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com"}.items():
        monkeypatch.setenv(name, value)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("make", MAKE_STUB), ("npm", NPM_STUB)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(stat.S_IRWXU)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    log = tmp_path / "stub.log"
    monkeypatch.setenv("STUB_LOG", str(log))
    for name in ("MAKE_STATUS", "MAKE_OUTPUT", "NPM_FAIL"):
        monkeypatch.delenv(name, raising=False)

    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", str(origin)], check=True)
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "--quiet", "-b", "main", str(repo)], check=True)
    (repo / ".gitignore").write_text("dist/\nnode_modules/\n")
    (repo / "web").mkdir()
    (repo / "web" / "package.json").write_text('{"name": "web", "private": true}\n')
    _git(repo, "add", ".")
    _git(repo, "commit", "--quiet", "-m", "first")
    first = _git(repo, "rev-parse", "HEAD")
    for n in (2, 3):
        (repo / f"file{n}.txt").write_text(f"{n}\n")
        _git(repo, "add", ".")
        _git(repo, "commit", "--quiet", "-m", f"commit {n}")
    _git(repo, "remote", "add", "origin", str(origin))
    _git(repo, "push", "--quiet", "origin", "main")

    class Env:
        pass

    result = Env()
    result.repo, result.first, result.log = repo, first, log
    result.calls = lambda: log.read_text().splitlines() if log.exists() else []
    return result


@pytest.fixture
def secrets():
    client = unsigned_client("secretsmanager")
    with Stubber(client) as stub:
        yield client, stub
        stub.assert_no_pending_responses()


# Secrets Manager's version IDs: the owner's (set_secret.py tagged the secret with it), the
# placeholder's DeskData generated, and one written by neither, as a regenerated value would be.
OWNER_VERSION = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
PLACEHOLDER_VERSION = "9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0"
OTHER_VERSION = "5a5a5a5a-1b1b-2c2c-3d3d-4e4e4e4e4e4e"


def _secret(stub: Stubber, secret_id: str, tags: list[dict] | None, current: str = OWNER_VERSION) -> None:
    if tags is None:
        stub.add_client_error("describe_secret", "ResourceNotFoundException", "Secrets Manager can't find it.",
                              expected_params={"SecretId": secret_id})
        return
    stages = {current: ["AWSCURRENT"]}
    if current != PLACEHOLDER_VERSION:
        stages[PLACEHOLDER_VERSION] = ["AWSPREVIOUS"]
    stub.add_response("describe_secret", {"Name": secret_id, "Tags": tags, "VersionIdsToStages": stages},
                      {"SecretId": secret_id})


def _owner_set(stub: Stubber) -> None:
    for secret_id in OWNER_SECRETS:
        _secret(stub, secret_id, [{"Key": "aws:cloudformation:stack-name", "Value": "DeskData"},
                                  {"Key": "owner-set", "Value": OWNER_VERSION}])


def _run(env, secrets, *argv: str) -> int:
    client, _ = secrets
    return load_script("preflight").main(list(argv), repo=env.repo, secrets=client)


def test_all_checks_pass(env, secrets, capsys):
    _owner_set(secrets[1])

    assert _run(env, secrets) == 0
    assert _git(env.repo, "rev-parse", "HEAD") in capsys.readouterr().out


@pytest.mark.parametrize("change", ["modified", "untracked", "staged"])
def test_refuses_a_dirty_tree(env, secrets, capsys, change):
    if change == "modified":
        (env.repo / "file2.txt").write_text("changed\n")
    elif change == "untracked":
        (env.repo / "infra-notes.txt").write_text("not committed\n")
    else:
        (env.repo / "file3.txt").write_text("staged\n")
        _git(env.repo, "add", "file3.txt")

    assert _run(env, secrets) == 1
    assert "clean" in capsys.readouterr().err
    assert env.calls() == []  # no results check, no build; Stubber: no AWS call


def test_ignored_files_leave_the_tree_clean(env, secrets):
    (env.repo / "web" / "dist").mkdir()
    (env.repo / "web" / "dist" / "stale.js").write_text("old\n")
    _owner_set(secrets[1])

    assert _run(env, secrets) == 0


def test_refuses_a_commit_not_on_main(env, secrets, capsys):
    _git(env.repo, "switch", "--quiet", "-c", "feature")
    (env.repo / "feature.txt").write_text("unmerged\n")
    _git(env.repo, "add", ".")
    _git(env.repo, "commit", "--quiet", "-m", "unmerged")

    assert _run(env, secrets) == 1
    assert "origin/main" in capsys.readouterr().err
    assert env.calls() == []


def test_allow_branch_deploys_a_commit_not_on_main(env, secrets):
    _git(env.repo, "switch", "--quiet", "-c", "feature")
    (env.repo / "feature.txt").write_text("unmerged\n")
    _git(env.repo, "add", ".")
    _git(env.repo, "commit", "--quiet", "-m", "unmerged")
    _owner_set(secrets[1])

    assert _run(env, secrets, "--allow-branch") == 0


def test_sees_main_as_origin_has_it_now(env, secrets, tmp_path):
    """A commit merged on origin after this clone last fetched counts as on main."""
    _git(env.repo, "switch", "--quiet", "-c", "feature")
    (env.repo / "feature.txt").write_text("merged elsewhere\n")
    _git(env.repo, "add", ".")
    _git(env.repo, "commit", "--quiet", "-m", "merged elsewhere")
    _git(env.repo, "push", "--quiet", "origin", "feature:main")
    _git(env.repo, "update-ref", "refs/remotes/origin/main", f"{env.first}")
    _owner_set(secrets[1])

    assert _run(env, secrets) == 0


@pytest.mark.parametrize(
    ("status", "output", "reason"),
    [
        ("1", "results-check: evals/results/0123456789abcdef.json is missing", "tier 2"),
        ("2", "make: *** No rule to make target 'evals-results-check'.  Stop.", "missing"),
    ],
)
def test_fails_without_a_passing_results_check(env, secrets, capsys, monkeypatch, status, output, reason):
    monkeypatch.setenv("MAKE_STATUS", status)
    monkeypatch.setenv("MAKE_OUTPUT", output)

    assert _run(env, secrets) == 1
    err = capsys.readouterr().err
    assert reason in err and output in err
    # BASE is the first commit, so the head must satisfy the unarmed or strict results rule.
    assert env.calls() == [f"make evals-results-check BASE={env.first} @ {env.repo}"]


def test_results_check_runs_even_with_allow_branch(env, secrets, monkeypatch):
    monkeypatch.setenv("MAKE_STATUS", "1")

    assert _run(env, secrets, "--allow-branch") == 1


@pytest.mark.parametrize("reason", [
    "every scenario is pending at the head, so no results file is needed",
    "evals/results/0123456789abcdef.json passes: 12 runs",
])
def test_results_check_prints_the_checks_own_reason(env, capsys, monkeypatch, reason):
    monkeypatch.setenv("MAKE_OUTPUT", f"results-check: {reason}")

    load_script("preflight").check_results(env.repo)

    assert capsys.readouterr().out == f"ok: tier 2 results check: results-check: {reason}\n"


@pytest.mark.parametrize("missing", OWNER_SECRETS)
def test_refuses_owner_secrets_not_set(env, secrets, capsys, missing):
    for secret_id in OWNER_SECRETS:
        if secret_id == missing:
            _secret(secrets[1], secret_id, [{"Key": "aws:cloudformation:stack-name", "Value": "DeskData"}],
                    current=PLACEHOLDER_VERSION)
            break
        _secret(secrets[1], secret_id, [{"Key": "owner-set", "Value": OWNER_VERSION}])

    assert _run(env, secrets) == 1
    err = capsys.readouterr().err
    assert missing in err and "placeholder" in err and "set_secret.py" in err
    assert not any(call.startswith("npm") for call in env.calls())


@pytest.mark.parametrize("current", [PLACEHOLDER_VERSION, OTHER_VERSION])
def test_refuses_an_owner_secret_whose_current_value_the_owner_didnt_set(env, secrets, capsys, current):
    """The tag names the version set_secret.py wrote. If another version became current (one
    CloudFormation generated again, or a rotation), the tag no longer vouches for the value."""
    _secret(secrets[1], OWNER_SECRETS[0], [{"Key": "owner-set", "Value": OWNER_VERSION}], current=current)

    assert _run(env, secrets) == 1
    err = capsys.readouterr().err
    assert OWNER_SECRETS[0] in err and current in err and OWNER_VERSION in err and "set_secret.py" in err


def test_refuses_the_old_owner_set_true_tag(env, secrets, capsys):
    """`owner-set=true` names no version, so it vouches for none."""
    _secret(secrets[1], OWNER_SECRETS[0], [{"Key": "owner-set", "Value": "true"}])

    assert _run(env, secrets) == 1
    assert "set_secret.py" in capsys.readouterr().err


def test_refuses_owner_secrets_that_dont_exist(env, secrets, capsys):
    _secret(secrets[1], OWNER_SECRETS[0], None)

    assert _run(env, secrets) == 1
    assert "DeskData" in capsys.readouterr().err


def test_builds_and_checks_the_web_app_at_head(env, secrets):
    stale = env.repo / "web" / "dist" / "assets" / "app-old.js"
    stale.parent.mkdir(parents=True)
    stale.write_text("an old build\n")
    _owner_set(secrets[1])

    assert _run(env, secrets) == 0
    web = env.repo / "web"
    assert [call for call in env.calls() if call.startswith("npm")] == [
        f"npm ci @ {web}", f"npm run build @ {web}", f"npm run check:build @ {web}"
    ]
    assert not stale.exists()  # never an old dist
    assert (web / "dist" / "index.html").is_file()


@pytest.mark.parametrize("step", ["ci", "run build", "run check:build"])
def test_a_failing_web_step_fails(env, secrets, capsys, monkeypatch, step):
    monkeypatch.setenv("NPM_FAIL", step)
    _owner_set(secrets[1])

    assert _run(env, secrets) == 1
    assert f"npm {step}" in capsys.readouterr().err


def test_no_web_app_fails(env, secrets, capsys):
    _git(env.repo, "rm", "--quiet", "-r", "web")
    _git(env.repo, "commit", "--quiet", "-m", "no web")
    _git(env.repo, "push", "--quiet", "origin", "main")
    _owner_set(secrets[1])

    assert _run(env, secrets) == 1
    assert "web/package.json" in capsys.readouterr().err


def test_refuses_a_shallow_clone(env, secrets, capsys, tmp_path):
    """A shallow clone's root is the graft, not the first commit, so the diff from it could miss
    gated paths and pass the results check without a results file."""
    shallow = tmp_path / "shallow"
    subprocess.run(["git", "clone", "--quiet", "--depth", "1", f"file://{env.repo}", str(shallow)], check=True)

    assert load_script("preflight").main([], repo=shallow, secrets=secrets[0]) == 1
    assert "shallow" in capsys.readouterr().err
    assert env.calls() == []


def test_cdk_lookup_cache_leaves_the_tree_clean():
    """The first deploy's availability-zone lookup writes infra/cdk.context.json (it holds the
    account ID); the repo ignores it, so the next deploy's dirty-tree check passes."""
    repo = Path(__file__).resolve().parents[2]
    result = subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", "infra/cdk.context.json"], check=False)
    assert result.returncode == 0


def test_owner_secret_ids_match_set_secret():
    # Jev is optional; deploy still requires the Anthropic key and passcode hash alone.
    assert load_script("preflight").OWNER_SECRETS == OWNER_SECRETS
    assert set(load_script("set_secret").OWNER_SECRETS) == set(OWNER_SECRETS) | {"desk/typesafe-api-key"}


def test_data_only_skips_the_owner_secrets_and_the_web_build(env, secrets, capsys):
    """deploy.sh --data-only deploys DeskData alone, which creates the owner secrets, so they can't
    be set yet, and serves no web app; every other check still runs."""
    assert _run(env, secrets, "--data-only") == 0          # no describe_secret: the stub has no response
    out = capsys.readouterr().out
    assert "ok: HEAD is on origin/main" in out and "ok: tier 2 results check:" in out
    assert "skipped: the owner secrets and the web build (--data-only: DeskData alone)" in out
    calls = env.calls()
    assert any(call.startswith("make evals-results-check") for call in calls)
    assert not any(call.startswith("npm") for call in calls)


@pytest.mark.parametrize("failure", ["dirty", "results"])
def test_data_only_still_needs_a_clean_tree_and_passing_results(env, secrets, capsys, monkeypatch, failure):
    if failure == "dirty":
        (env.repo / "file2.txt").write_text("changed\n")
    else:
        monkeypatch.setenv("MAKE_STATUS", "1")

    assert _run(env, secrets, "--data-only") == 1
