"""The CI workflow and its setup action, read as data: what runs, when, with which pins and rights."""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tomllib
from copy import deepcopy
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml
from test_gate import PROOFS_GATE, TIER2_RESULTS_GATE

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
ACTIONS = sorted((ROOT / ".github/actions").glob("*/action.yml"))
CI_DOC = ROOT / "docs/ci.md"

# The check names branch protection requires, in the workflow's order (Plan 06a, "Produced").
REQUIRED_CHECKS = [
    "backend tests",
    "kernel tests",
    "proofs",
    "tier 1 evals",
    "tier 2 results",
    "web tests",
    "infra synth",
    "secret scan",
    "repo checks",
]

SUITES = {"backend": "backend tests", "tier1": "tier 1 evals"}
SHARD_JOBS = {f"{suite}-{shard}": f"{name} {shard}/4" for suite, name in SUITES.items() for shard in range(1, 5)}
CHECK_JOBS = {suite: [f"{suite}-{shard}" for shard in range(1, 5)] for suite in SUITES}
# The web suite runs its unit and browser tests in four shards, each with fewer workers than the runner's
# vCPUs (timing-sensitive screen tests flaked on a fully busy 4-vCPU runner), and its build and mocked
# end-to-end test in a job of its own.
WEB_SHARD_JOBS = {f"web-{shard}": f"web tests {shard}/4" for shard in range(1, 5)}
WEB_E2E_JOB = {"web-e2e": "web tests e2e"}
WEB_TEST_ARGS = "--shard={}/4 --maxWorkers=2"
WEB_CHECK_PARTS = {**{f"SHARD_{shard}": f"web-{shard}" for shard in range(1, 5)}, "E2E": "web-e2e"}
SCOPED_JOBS = {
    **dict.fromkeys([*SHARD_JOBS, "kernel", "proofs", "tier2", "infra"], "backend"),
    **dict.fromkeys([*WEB_SHARD_JOBS, *WEB_E2E_JOB], "web"),
}
SCOPE_COMMAND = "PYTHONPATH=tools python3 -m desk_tools.changed_paths"
SHARD_CHECK = '''if [ "$NEEDED" = false ] && test "$SHARD_1" = skipped && test "$SHARD_2" = skipped && test "$SHARD_3" = skipped && test "$SHARD_4" = skipped; then
  exit 0
fi
test "$SHARD_1" = success && test "$SHARD_2" = success && test "$SHARD_3" = success && test "$SHARD_4" = success'''
WEB_CHECK = '''if [ "$NEEDED" = false ] && test "$SHARD_1" = skipped && test "$SHARD_2" = skipped && test "$SHARD_3" = skipped && test "$SHARD_4" = skipped && test "$E2E" = skipped; then
  exit 0
fi
test "$SHARD_1" = success && test "$SHARD_2" = success && test "$SHARD_3" = success && test "$SHARD_4" = success && test "$E2E" = success'''
SHARD_TEST_STEPS = {
    f"{suite}-{shard}": steps
    for suite, steps in {
        "backend": {"Run the backend tests"},
        "tier1": {"Run the tier 1 evals", "Run the kernel contract tests against the real kernel"},
    }.items()
    for shard in range(1, 5)
}


@pytest.mark.parametrize("suite, name", SUITES.items())
def test_explicit_shards_are_identical_except_their_number(suite, name):
    workflow_jobs = load(WORKFLOW)["jobs"]
    normalized = []
    for shard in range(1, 5):
        job = deepcopy(workflow_jobs[f"{suite}-{shard}"])
        assert job.pop("name") == f"{name} {shard}/4"
        assert "strategy" not in job
        assert job.pop("runs-on") == RUNS_ON.replace("<suffix>", f"{suite}-{shard}")
        for step in job["steps"]:
            if "PYTEST_ADDOPTS" in step.get("env", {}):
                assert step["env"]["PYTEST_ADDOPTS"] == f"--shard={shard}/4"
                step["env"]["PYTEST_ADDOPTS"] = "--shard=1/4"
        normalized.append(job)
    assert all(job == normalized[0] for job in normalized)


@pytest.mark.parametrize("job_id, name", SHARD_JOBS.items())
def test_suites_run_as_four_shards_with_options_only_on_test_steps(job_id, name):
    workflow = load(WORKFLOW)
    job = workflow["jobs"][job_id]
    assert job["name"] == name
    assert "strategy" not in job
    assert job["if"] == "${{ !cancelled() && needs.changes.outputs.backend != 'false' }}" and job["needs"] == ["changes"]
    assert "PYTEST_ADDOPTS" not in workflow["env"]
    for other_id, other in workflow["jobs"].items():
        assert "PYTEST_ADDOPTS" not in other.get("env", {})
        for step in other["steps"]:
            is_test = step.get("name") in SHARD_TEST_STEPS.get(other_id, set())
            options = step.get("env", {}).get("PYTEST_ADDOPTS")
            shard = other_id.rsplit("-", 1)[-1]
            assert options == (f"--shard={shard}/4" if is_test else None)
    assert {step["name"] for step in job["steps"] if "PYTEST_ADDOPTS" in step.get("env", {})} == SHARD_TEST_STEPS[job_id]


def test_web_shards_are_identical_except_their_shard():
    workflow_jobs = load(WORKFLOW)["jobs"]
    normalized = []
    for shard in range(1, 5):
        job = deepcopy(workflow_jobs[f"web-{shard}"])
        assert job.pop("name") == f"web tests {shard}/4"
        assert job.pop("runs-on") == RUNS_ON.replace("<suffix>", f"web-{shard}")
        [test] = [step for step in job["steps"] if "WEB_TEST_ARGS" in step.get("env", {})]
        assert test["name"] == "Run the web type check and unit tests"
        assert test["env"] == {"WEB_TEST_ARGS": WEB_TEST_ARGS.format(shard)}
        test["env"]["WEB_TEST_ARGS"] = WEB_TEST_ARGS.format(1)
        normalized.append(job)
    assert all(job == normalized[0] for job in normalized)
    # Only the web shards' test steps pass test arguments, and `make web-test` hands them to the test run.
    for job_id, job in workflow_jobs.items():
        assert "WEB_TEST_ARGS" not in job.get("env", {})
        for step in job["steps"]:
            assert ("WEB_TEST_ARGS" in step.get("env", {})) == (job_id in WEB_SHARD_JOBS and step.get("name") == "Run the web type check and unit tests")
    makefile = (ROOT / "Makefile").read_text()
    recipe = makefile.split("\nweb-test: web-deps\n", 1)[1].split("\n\n", 1)[0]
    assert recipe.strip() == "cd web && npm run typecheck && npm test -- $(WEB_TEST_ARGS)"


@pytest.mark.parametrize("needed", ["true", "", "false"])
@pytest.mark.parametrize("part", WEB_CHECK_PARTS)
@pytest.mark.parametrize("result", ["success", "failure", "cancelled", "skipped", ""])
def test_the_required_web_check_fails_unless_every_shard_and_the_end_to_end_test_succeeded(tmp_path, needed, part, result):
    job = load(WORKFLOW)["jobs"]["web"]
    assert job["name"] == "web tests"
    assert job["needs"] == ["changes", *WEB_CHECK_PARTS.values()]
    assert job["if"] == "always()"
    assert set(job) == {"name", "runs-on", "timeout-minutes", "needs", "if", "steps"}
    [step] = job["steps"]
    assert step["env"] == {"NEEDED": "${{ needs.changes.outputs.web }}",
                           **{name: "${{ needs." + job_id + ".result }}" for name, job_id in WEB_CHECK_PARTS.items()}}
    assert step["run"].strip() == WEB_CHECK
    expected = "skipped" if needed == "false" else "success"
    results = dict.fromkeys(WEB_CHECK_PARTS, expected)
    results[part] = result
    executed, _ = Runner(tmp_path).run(step, "ARM64", NEEDED=needed, **results)
    assert executed.returncode == (0 if result == expected else 1), executed.stderr


def test_the_required_web_check_accepts_every_success_even_if_the_suite_was_ruled_out(tmp_path):
    [step] = load(WORKFLOW)["jobs"]["web"]["steps"]
    executed, _ = Runner(tmp_path).run(step, "ARM64", NEEDED="false", **dict.fromkeys(WEB_CHECK_PARTS, "success"))
    assert executed.returncode == 0, executed.stderr


@pytest.mark.parametrize("job_id, shard_ids", CHECK_JOBS.items())
@pytest.mark.parametrize("needed", ["true", "", "false"])
@pytest.mark.parametrize("shard", range(1, 5))
@pytest.mark.parametrize("result", ["success", "failure", "cancelled", "skipped", ""])
def test_required_suite_checks_fail_unless_all_shards_succeeded(tmp_path, job_id, shard_ids, needed, shard, result):
    job = load(WORKFLOW)["jobs"][job_id]
    assert job["needs"] == ["changes", *shard_ids]
    assert job["if"] == "always()"
    assert set(job) == {"name", "runs-on", "timeout-minutes", "needs", "if", "steps"}
    [step] = job["steps"]
    assert set(step) == {"name", "env", "run"}
    assert step["env"] == {
        "NEEDED": "${{ needs.changes.outputs.backend }}",
        **{
            f"SHARD_{number}": "${{ needs." + shard_id + ".result }}"
            for number, shard_id in enumerate(shard_ids, 1)
        },
    }
    assert "||" not in step["run"]
    expected = "skipped" if needed == "false" else "success"
    results = {f"SHARD_{number}": expected for number in range(1, 5)}
    results[f"SHARD_{shard}"] = result
    executed, _ = Runner(tmp_path).run(step, "ARM64", NEEDED=needed, **results)
    assert executed.returncode == (0 if result == expected else 1), executed.stderr


@pytest.mark.parametrize("job_id", CHECK_JOBS)
def test_required_suite_checks_accept_four_successes_even_if_the_suite_was_ruled_out(tmp_path, job_id):
    [step] = load(WORKFLOW)["jobs"][job_id]["steps"]
    results = {f"SHARD_{number}": "success" for number in range(1, 5)}
    executed, _ = Runner(tmp_path).run(step, "ARM64", NEEDED="false", **results)
    assert executed.returncode == 0, executed.stderr


@pytest.mark.parametrize("job_id, flag", SCOPED_JOBS.items())
def test_scoped_jobs_run_unless_explicitly_ruled_out_even_if_classification_failed(job_id, flag):
    job = load(WORKFLOW)["jobs"][job_id]
    assert job["needs"] == ["changes"]
    assert job["if"] == "${{ !cancelled() && needs.changes.outputs." + flag + " != 'false' }}"


def test_backend_scoped_job_gates_do_not_depend_on_web():
    for job_id, job in load(WORKFLOW)["jobs"].items():
        if "needs.changes.outputs.backend" not in job.get("if", ""):
            continue
        for step in job["steps"]:
            words = shlex.split(step.get("run", ""))
            for index, word in enumerate(words):
                option, separator, value = word.partition("=")
                if option in {"--run-if", "--required-if"}:
                    path = value if separator else words[index + 1]
                    path = path.removeprefix("./").rstrip("/")
                    assert path != "web" and not path.startswith("web/"), (job_id, step["name"], path)


def test_secret_scan_and_repo_checks_start_without_classification():
    for job_id in ["secret-scan", "repo"]:
        job = load(WORKFLOW)["jobs"][job_id]
        assert "needs" not in job and "if" not in job


def test_changed_paths_job_only_classifies_pull_requests_and_writes_both_outputs():
    job = load(WORKFLOW)["jobs"]["changes"]
    assert job["name"] == "changed paths"
    assert "needs" not in job
    assert job["if"] == "github.event_name == 'pull_request'"
    checkout, classify = job["steps"]
    assert is_checkout(checkout)
    assert checkout["with"] == {"persist-credentials": False, "fetch-depth": 2}
    assert classify["id"] == "classify"
    assert classify["env"] == {
        "GITHUB_EVENT_NAME": "${{ github.event_name }}",
        "PR_HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
    }
    assert classify["run"] == SCOPE_COMMAND
    assert job["outputs"] == {flag: "${{ steps.classify.outputs." + flag + " }}" for flag in ["backend", "web"]}


# The plan's pinned actions: the commit each version tag pointed to when it was pinned.
PINNED_ACTIONS = {
    "actions/checkout": ("3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"),
    "astral-sh/setup-uv": ("1c37ad07a6a961277cf70c0d37d6f313000f5884", "v10.3.0"),
    "Swatinem/rust-cache": ("6323deb102c322ba6fcbdcafc7e3dddab59af2b6", "v2.9.2"),
    "actions/setup-node": ("949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"),
}


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def triggers(workflow: dict) -> dict:
    # YAML 1.1 reads a bare `on` key as the boolean true.
    return workflow["on"] if "on" in workflow else workflow[True]


def jobs(workflow: dict) -> list[dict]:
    assert workflow["jobs"], "the workflow has no jobs"
    return list(workflow["jobs"].values())


def all_steps() -> list[dict]:
    """Every step of every job in ci.yml and of every local action."""
    steps = [step for job in jobs(load(WORKFLOW)) for step in job["steps"]]
    for action in ACTIONS:
        steps += load(action)["runs"]["steps"]
    return steps


def is_checkout(step: dict) -> bool:
    return step.get("uses", "").startswith("actions/checkout@")


def test_triggers_are_main_pushes_pull_requests_on_any_base_and_dispatch():
    workflow = load(WORKFLOW)

    assert workflow["name"] == "ci"
    on = triggers(workflow)
    assert set(on) == {"push", "pull_request", "workflow_dispatch"}
    assert on["push"] == {"branches": ["main"]}
    assert on["pull_request"] in (None, {})
    assert on["workflow_dispatch"] in (None, {})
    # One run per pull request push; a newer push cancels an older pull request run, never a run on main.
    assert workflow["concurrency"] == {
        "group": "ci-${{ github.event.pull_request.number || github.ref }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    }


def test_actions_pinned_by_commit_sha():
    """Every action is local or pinned by commit with its version tag beside it; downloads are checked too."""
    lines = []   # (path, uses value, version comment), read from the text since YAML drops comments
    for path in [WORKFLOW, *ACTIONS]:
        for line in path.read_text().splitlines():
            if match := re.match(r"\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$", line):
                lines.append((path, match[1], match[2]))
    # The text scan saw exactly the steps' `uses`, so none escaped it.
    assert sorted(uses for _, uses, _ in lines) == sorted(step["uses"] for step in all_steps() if "uses" in step)

    used = set()
    for path, uses, comment in lines:
        if uses.startswith("./"):
            assert (ROOT / uses / "action.yml").is_file(), (path, uses)
            continue
        match = re.fullmatch(r"([\w.-]+/[\w.-]+)@([0-9a-f]{40})", uses)
        assert match, (path, uses)
        assert comment and re.fullmatch(r"v\d+(\.\d+)*", comment), (path, uses)
        assert (match[2], comment) == PINNED_ACTIONS.get(match[1]), (path, uses, comment)
        used.add(match[1])
    assert used == set(PINNED_ACTIONS)

    # Python dependencies come only from the committed lockfiles: every uv command runs as --locked,
    # and fails if a lockfile is missing or out of date. No job or step changes uv's settings.
    workflow = load(WORKFLOW)
    assert workflow["env"] == {"UV_LOCKED": "1"}
    for job in jobs(workflow):
        for scope in [job, *job["steps"]]:
            assert not any(name.startswith("UV_") for name in scope.get("env", {})), scope

    # Only the pinned downloads fetch, and each checks what it fetched (download_problems).
    for step in all_steps():
        assert download_problems(step) == [], (step.get("name"), step.get("run"))
    fetching = [step["name"] for step in all_steps() if FETCH.search(step.get("run", ""))]
    assert sorted(fetching) == sorted(PINNED_DOWNLOADS)


# curl or wget given an option or a URL, wherever it stands in a script: after sudo, env, xargs,
# if, then, do, !, a brace, a parenthesis, a backtick or a quote.
FETCH = re.compile(r"\b(curl|wget)\s+(?:-|\"?https?://)")


def download_problems(step: dict) -> list[str]:
    """What is wrong with how a step fetches. Only the pinned downloads may fetch or name a URL; each
    fetch is followed by a sha256 check, which under `bash -e` with no `||`
    (test_gated_jobs_go_through_the_gate) stops the script on a mismatch; and nothing is piped into a shell."""
    run, pinned = step.get("run", ""), step.get("name") in PINNED_DOWNLOADS
    problems = []
    fetches = list(FETCH.finditer(run))
    if fetches and not pinned:
        problems.append("fetches but isn't a pinned download")
    if any("sha256sum -c" not in run[fetch.end() :] for fetch in fetches):
        problems.append("fetches with no sha256 check after it")
    if re.search(r"https?://", run) and not pinned:
        problems.append("names a URL but isn't a pinned download")
    if re.search(r"\|\s*(ba)?sh\b", run):
        problems.append("pipes into a shell")
    return problems


# Ways a script can fetch, each of which the download rule must see.
FETCH_FORMS = [
    "sudo curl -sSfL -o tool.tgz https://example.com/tool.tgz",
    "if curl -sSfL -o tool.tgz https://example.com/tool.tgz; then echo fetched; fi",
    "if true; then curl -sSfL -o tool.tgz https://example.com/tool.tgz; fi",
    'for url in https://example.com/tool.tgz; do curl -sSfLO "$url"; done',
    "env curl -sSfL -o tool.tgz https://example.com/tool.tgz",
    "echo https://example.com/tool.tgz | xargs curl -sSfLO",
    'bash -c "curl -sSfL -o tool.tgz https://example.com/tool.tgz"',
    "tool=`curl -sSfL https://example.com/tool`",
    "(curl -sSfL -o tool.tgz https://example.com/tool.tgz)",
    "{ curl -sSfL -o tool.tgz https://example.com/tool.tgz; }",
    "! curl -sSfL -o tool.tgz https://example.com/tool.tgz",
    "sudo wget -q https://example.com/tool.tgz",
    'curl "https://example.com/tool.tgz" -o tool.tgz',
    "wget https://example.com/tool.tgz",
]


@pytest.mark.parametrize("run", FETCH_FORMS)
def test_download_rule_sees_every_way_a_script_fetches(run):
    # Under a pinned download's name, only the fetch itself can give it away: nothing checks it after.
    assert "fetches with no sha256 check after it" in download_problems({"name": "Install gitleaks 8.30.1", "run": run})
    # Under any other name, a step must not fetch or name a URL at all.
    problems = download_problems({"name": "Build the thing", "run": run})
    assert "fetches but isn't a pinned download" in problems or "names a URL but isn't a pinned download" in problems


@pytest.mark.parametrize(
    "step, problem",
    [
        ({"name": "Build the thing", "run": 'curl -sSfL -o tool.tgz "$url"\necho "$sha256  tool.tgz" | sha256sum -c'},
         "fetches but isn't a pinned download"),
        ({"name": "Build the thing", "run": "echo see https://example.com"}, "names a URL but isn't a pinned download"),
        ({"name": "Install gitleaks 8.30.1", "run": 'curl -sSfL "$url" | sh'}, "pipes into a shell"),
        ({"name": "Install gitleaks 8.30.1", "run": 'echo "$sha256  t" | sha256sum -c\ncurl -sSfL -o t "$url"'},
         "fetches with no sha256 check after it"),
    ],
)
def test_download_rule_catches_each_problem(step, problem):
    assert problem in download_problems(step)


@pytest.mark.parametrize(
    "step",
    [
        # Naming curl as a word isn't a fetch.
        {"name": "Check the runner", "run": "for tool in curl unzip make cc; do command -v \"$tool\"; done"},
        {"name": "Install gitleaks 8.30.1", "run": 'curl -sSfL -o t "https://example.com/t"\necho "$sha256  t" | sha256sum -c --strict'},
    ],
)
def test_download_rule_allows_checked_pinned_downloads_and_words(step):
    assert download_problems(step) == []


def test_ci_has_no_secrets_and_reads_only():
    workflow = load(WORKFLOW)

    assert workflow["permissions"] == {"contents": "read"}
    for job in jobs(workflow):
        # A job may only narrow the workflow's rights.
        assert job.get("permissions", {}) in ({}, {"contents": "read"}, {"contents": "none"}), job["name"]
        # Every job that runs repository code starts from a checkout with no token left in git.
        if job["name"] not in {"backend tests", "tier 1 evals", "web tests"}:
            assert is_checkout(job["steps"][0]), job["name"]
    assert "pull_request_target" not in triggers(workflow)
    for path in [WORKFLOW, *ACTIONS]:
        text = path.read_text()
        assert not re.search(r"\bsecrets\s*[.\[:]", text), path
        assert "github.token" not in text and "GITHUB_TOKEN" not in text, path
        assert "pull_request_target" not in text, path
        assert "ANTHROPIC" not in text, path
    checkouts = [step for step in all_steps() if is_checkout(step)]
    assert checkouts
    for step in checkouts:
        assert step["with"]["persist-credentials"] is False, step


def documented_checks() -> list[str]:
    """The numbered list under docs/ci.md's "The checks" heading: "1. `backend tests`: ..."."""
    section = CI_DOC.read_text().split("\n## The checks\n", 1)[1].split("\n## ", 1)[0]
    return re.findall(r"^\d+\. `([^`]+)`", section, flags=re.MULTILINE)


def test_job_names_are_the_required_checks():
    workflow_jobs = jobs(load(WORKFLOW))

    helpers = [*SHARD_JOBS.values(), *WEB_SHARD_JOBS.values(), *WEB_E2E_JOB.values(), "changed paths"]
    assert [job["name"] for job in workflow_jobs if job["name"] not in helpers] == REQUIRED_CHECKS
    assert len(workflow_jobs) == len(REQUIRED_CHECKS) + len(helpers)
    assert documented_checks() == REQUIRED_CHECKS
    for job in workflow_jobs:
        assert job["timeout-minutes"] == JOB_TIMEOUTS.get(job["name"], 25), job["name"]


# Suite shards retain their time limit; their required checks inspect each shard's own result.
JOB_TIMEOUTS = {**dict.fromkeys([*SHARD_JOBS.values(), *WEB_SHARD_JOBS.values()], 40),
                "backend tests": 5, "tier 1 evals": 5, "web tests": 5, "changed paths": 5}


# The runner switch: on when the repository variable CI_RUNNER_MODE is "ec2", except for a pull
# request from a fork, whose code never runs on a self-hosted runner.
SWITCH = (
    "vars.CI_RUNNER_MODE == 'ec2' && (github.event_name != 'pull_request' "
    "|| github.event.pull_request.head.repo.full_name == github.repository)"
)
# Where each job runs: GitHub-hosted ubuntu-24.04 unless the switch is on; then a single-use
# self-hosted on-demand runner for every event (docs/ci.md, "Runners"), whose label names the run,
# the attempt and the job. <suffix> is the job's own part of the label.
RUNS_ON = (
    "${{ " + SWITCH + " && fromJSON(format("
    """'["self-hosted","desk-ci-{0}-{1}-{2}-<suffix>"]', """
    "'ondemand', github.run_id, github.run_attempt)) "
    "|| 'ubuntu-24.04' }}"
)
# The runner launcher's suffixes, one per job.
RUNNER_SUFFIXES = {"backend", "kernel", "proofs", "tier1", "tier2", "web", "infra", "secret-scan", "repo", "changes"}


def test_jobs_run_on_hosted_runners_unless_switched_to_ec2():
    workflow_jobs = load(WORKFLOW)["jobs"]

    suffixes = []
    for job_id, job in workflow_jobs.items():
        assert job["runs-on"] == own_desk(job_id), (job_id, job["runs-on"])
        # Each explicit shard and required check gets its own machine.
        suffixes.append(job_id)
        assert "strategy" not in job, job["name"]
        assert "container" not in job, job["name"]
    # Each label is unique within the run and in the launcher's form.
    shard_suffixes = {f"{suite}-{shard}" for suite in [*CHECK_JOBS, "web"] for shard in range(1, 5)} | set(WEB_E2E_JOB)
    assert len(suffixes) == len(set(suffixes)) == len(RUNNER_SUFFIXES) + len(shard_suffixes)
    assert set(suffixes) == RUNNER_SUFFIXES | shard_suffixes
    for suffix in suffixes:
        assert re.fullmatch(r"[a-z][a-z0-9-]{0,31}", suffix), suffix
    # Hosted stays the default with the variable unset, or for a fork's pull request.
    for job in workflow_jobs.values():
        assert job["runs-on"].startswith("${{ " + SWITCH + " && "), job["name"]
        assert job["runs-on"].endswith(" || 'ubuntu-24.04' }}"), job["name"]


def env_example() -> dict[str, str]:
    lines = (ROOT / ".env.example").read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if re.match(r"[A-Z][A-Z0-9_]*=", line))


def test_postgres_services_match_compose():
    """CI's database is the local one: same image, port, user, database and password, so password auth is exercised."""
    db = load(ROOT / "docker-compose.yml")["services"]["db"]
    settings = env_example()
    user, database = db["environment"]["POSTGRES_USER"], db["environment"]["POSTGRES_DB"]
    password = settings["DESK_ADMIN_PASSWORD"]
    assert db["image"] == "postgres:16"
    assert db["environment"]["POSTGRES_PASSWORD"] == f"${{DESK_ADMIN_PASSWORD:-{password}}}"
    [mapping] = db["ports"]
    host_port, container_port = mapping.split(":")[-2:]
    # Every process connects to that database, on that port, as in .env.example.
    for name, value in settings.items():
        if name.endswith("_DATABASE_URL"):
            url = urlsplit(value)
            assert (url.hostname, str(url.port), url.path) == ("localhost", host_port, f"/{database}"), name

    # The image follows the runner switch. GitHub-hosted runners pull the compose file's image from
    # Docker Hub, since their shared addresses run into ECR Public's anonymous limit; self-hosted
    # runners pull the same official image and tag from its ECR Public mirror.
    image = f"${{{{ {SWITCH} && 'public.ecr.aws/docker/library/{db['image']}' || '{db['image']}' }}}}"

    with_services = {job["name"]: job["services"] for job in jobs(load(WORKFLOW)) if "services" in job}
    assert set(with_services) == set(SHARD_JOBS.values())
    for name, services in with_services.items():
        assert services == {
            "postgres": {
                "image": image,
                "ports": [f"{host_port}:{container_port}"],
                "env": {"POSTGRES_USER": user, "POSTGRES_PASSWORD": password, "POSTGRES_DB": database},
                "options": services["postgres"]["options"],
            }
        }, name
        assert shlex.split(services["postgres"]["options"]) == [
            "--health-cmd", f"pg_isready -U {user}",
            "--health-interval", "5s",
            "--health-retries", "20",
        ], name


# .env.example's settings, copied to .env and exported to every later step, as `make db-roles` and the tests read them.
SETTINGS = "cp .env.example .env\ngrep -E '^[A-Z][A-Z0-9_]*=' .env >> \"$GITHUB_ENV\""
ONE_HEAD = 'test "$(cd backend && uv run alembic heads | wc -l)" -eq 1'
MIGRATE = "cd backend && uv run alembic upgrade head"


def job_named(name: str) -> dict:
    [job] = [job for job in jobs(load(WORKFLOW)) if job["name"] == name]
    return job


def runs(job: dict) -> list[str]:
    return [step["run"].strip() for step in job["steps"] if "run" in step]


def test_backend_job_fails_on_two_alembic_heads():
    """Every shard that migrates checks for one head first, then migrates and sets the role passwords."""
    for name in SHARD_JOBS.values():
        commands = runs(job_named(name))
        assert SETTINGS in commands, name
        settings = commands.index(SETTINGS)
        # The heads check comes before anything migrates.
        assert commands[settings + 1 : settings + 4] == [ONE_HEAD, MIGRATE, "make db-roles"], name
        assert not any("alembic" in run for run in commands[:settings]), name

    for shard_id in CHECK_JOBS["backend"]:
        assert runs(job_named(SHARD_JOBS[shard_id]))[-1] == "cd backend && uv run pytest -q"


GATE = ["uv", "run", "--project", "tools", "python", "-m", "desk_tools.gate"]
MIGRATIONS = [SETTINGS, ONE_HEAD, MIGRATE, "make db-roles"]
# The job's database is thrown away with its runner, so it skips durable commits.
THROWAWAY = "make db-throwaway"
TIER2_BASE_SETUP = (
    'if [ "$FORCED" = "true" ]; then\n'
    '  echo "::error::a force-push to main replaced history that CI can\'t check for rewritten rates or waivers"\n'
    '  exit 1\n'
    'fi\n'
    'HISTORY_SINCE=""\n'
    'if [ -z "$RESULTS_BASE" ]; then\n'
    '  RESULTS_BASE="$(git rev-list --max-parents=0 HEAD | tail -n 1)"\n'
    '  HISTORY_SINCE="$RESULTS_BASE"\n'
    'fi'
)

# What each check runs after its setup, as Plan 06a Task 2's job table says: a string is a plain
# command, a list is the gate's arguments.
CHECKS = {
    "changed paths": [SCOPE_COMMAND],
    **dict.fromkeys(
        (SHARD_JOBS[shard_id] for shard_id in CHECK_JOBS["backend"]),
        [*MIGRATIONS, THROWAWAY, "cd backend && uv run pytest -q"],
    ),
    **dict.fromkeys(SUITES.values(), [SHARD_CHECK]),
    "kernel tests": ["cd kernel && cargo test --locked"],
    # Exactly the arguments test_gate's proofs regression exercises.
    "proofs": ["desk-prove --selftest", PROOFS_GATE],
    **dict.fromkeys((SHARD_JOBS[shard_id] for shard_id in CHECK_JOBS["tier1"]), [
        *MIGRATIONS,
        THROWAWAY,
        [
            "--name", "tier1",
            "--run-if", "evals/run.py",
            "--required-if", "backend/desk/kernel_service/app.py",
            "--", "make", "evals-tier1",
        ],
        [
            "--name", "kernel-contract",
            "--run-if", "backend/tests/kernel_contract/conftest.py",
            "--required-if", "backend/desk/api/kernel_client.py",
            "--", "make", "kernel-contract",
        ],
    ]),
    # The same gate arguments as test_gate, with a base selected for the workflow event.
    "tier 2 results": [[*TIER2_RESULTS_GATE[:-1], "BASE=$RESULTS_BASE", "HISTORY_SINCE=$HISTORY_SINCE"]],
    "web tests": [WEB_CHECK],
    **dict.fromkeys(WEB_SHARD_JOBS.values(), [["--name", "web", "--run-if", "web/package.json", "--", "make", "web-test"]]),
    "web tests e2e": [
        [
            "--name", "web-e2e",
            "--run-if", "web/playwright.config.ts",
            "--required-if", "web/e2e",
            "--", "make", "web-deps", "web-e2e",
        ],
    ],
    "infra synth": [["--name", "infra", "--run-if", "infra/cdk.json", "--", "make", "infra-check"]],
    # The ref under test only (the base's history plus the pull request's commits), never other branches.
    "secret scan": [
        'gitleaks git --redact --verbose --no-banner --exit-code 1 --ignore-gitleaks-allow --log-opts="--full-history HEAD" .'
    ],
    "repo checks": [
        "actionlint",
        "cd tools && uv run pytest -q",
        ["--name", "docs", "--run-if", "tools/desk_tools/check_docs.py", "--", "make", "docs-check"],
    ],
}


def checks(job: dict) -> list[str | list[str]]:
    """The job's commands, with each gate call as its arguments; "Install ..." steps are setup."""
    commands = []
    for step in job["steps"]:
        if "run" not in step or step.get("name", "").startswith("Install "):
            continue
        run = step["run"].strip()
        if "desk_tools.gate" in run:
            if step.get("name") == "Check the tier 2 results":
                assert run.startswith(TIER2_BASE_SETUP + "\n")
                run = run[len(TIER2_BASE_SETUP) + 1 :]
            # One gate call per step, nothing else, so its exit code is the step's.
            words = shlex.split(run)
            assert words[: len(GATE)] == GATE, run
            commands.append(words[len(GATE) :])
        else:
            commands.append(run)
    return commands


def test_gated_jobs_go_through_the_gate():
    workflow = load(WORKFLOW)

    assert {job["name"]: checks(job) for job in jobs(workflow)} == CHECKS
    tier2_gate = CHECKS["tier 2 results"][0]
    assert tier2_gate[tier2_gate.index("--") + 1 :] == [
        "make", "evals-results-check", "BASE=$RESULTS_BASE", "HISTORY_SINCE=$HISTORY_SINCE",
    ]
    assert PROOFS_GATE[PROOFS_GATE.index("--") + 1 :] == ["make", "check-presets"]
    # Tier 2 checks pull requests against their event's base commit, including stacked PRs;
    # pushes and manual runs check the head against the root commit, even after cancelled runs.
    tier2 = job_named("tier 2 results")
    assert tier2["if"] == "${{ !cancelled() && needs.changes.outputs.backend != 'false' }}"
    assert tier2["steps"][0]["with"]["fetch-depth"] == 0
    [results] = [step for step in tier2["steps"] if step.get("name") == "Check the tier 2 results"]
    assert results["env"] == {
        "RESULTS_BASE": "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}",
        "FORCED": "${{ github.event_name == 'push' && github.event.forced || false }}",
    }
    assert results["run"].rstrip().endswith(
        'make evals-results-check BASE="$RESULTS_BASE" HISTORY_SINCE="$HISTORY_SINCE"')
    # The secret scan reads the whole history.
    assert job_named("secret scan")["steps"][0]["with"]["fetch-depth"] == 0

    # Nothing turns a failure into a pass, and no workflow step runs conditionally. Scripts run as
    # `bash -eo pipefail` (GitHub's `shell: bash`), so a failing line fails its step.
    assert workflow["defaults"] == {"run": {"shell": "bash"}}
    for job in jobs(workflow):
        assert "continue-on-error" not in job, job["name"]
        for step in job["steps"]:
            assert "continue-on-error" not in step and "if" not in step, (job["name"], step)
            assert "shell" not in step, (job["name"], step)
    for action in ACTIONS:
        for step in load(action)["runs"]["steps"]:
            assert "continue-on-error" not in step, (action, step)
            assert "run" not in step or step["shell"] == "bash", (action, step)
    for step in all_steps():
        run = step.get("run", "")
        assert "||" not in run and "set +" not in run, run
    # The Node setups keep no npm cache: the web job runs before web/package-lock.json exists.
    node_setups = [step for step in all_steps() if step.get("uses", "").startswith("actions/setup-node@")]
    assert node_setups
    for step in node_setups:
        assert step["with"] == {"node-version": "24.21.0", "package-manager-cache": False}, step
    # Each job keeps its own uv cache, so the first job to save one can't stand in for the others; a
    # job that never runs uv (kernel tests) has nothing to save, which mustn't fail its post step.
    uv_setups = [step for step in all_steps() if step.get("uses", "").startswith("astral-sh/setup-uv@")]
    assert uv_setups
    for step in uv_setups:
        assert step["with"] == {
            "version": "0.13.0",
            "python-version": "3.13",
            "enable-cache": True,
            "cache-suffix": "${{ github.job }}",
            "ignore-nothing-to-cache": True,
        }, step


def test_tier2_rejects_force_push_before_running_the_gate(tmp_path):
    [step] = [step for step in job_named("tier 2 results")["steps"]
              if step.get("name") == "Check the tier 2 results"]
    script = tmp_path / "check.sh"
    script.write_text(step["run"])
    result = subprocess.run(["bash", "-eo", "pipefail", str(script)], text=True, capture_output=True,
                            cwd=tmp_path, env={**os.environ, "FORCED": "true", "RESULTS_BASE": "unused"})
    assert result.returncode == 1
    assert result.stdout == ("::error::a force-push to main replaced history that CI can't check "
                             "for rewritten rates or waivers\n")
    assert not result.stderr


@pytest.mark.parametrize("event, gate_exit", [
    ("pull_request", 0), ("push", 0), ("workflow_dispatch", 0),
    ("pull_request", 7), ("push", 7), ("workflow_dispatch", 7),
])
def test_tier2_preserves_push_histories_without_changing_the_results_base(tmp_path, event, gate_exit):
    [step] = [step for step in job_named("tier 2 results")["steps"]
              if step.get("name") == "Check the tier 2 results"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "commands.jsonl"
    # Exercise the workflow's actual shell, with no network or model calls.
    stub = f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
with open(os.environ["COMMAND_LOG"], "a") as log:
    log.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name == "git":
    if sys.argv[1:] == ["rev-list", "--max-parents=0", "HEAD"]:
        print("a" * 40)
    else:
        sys.exit(99)
else:
    sys.exit(int(os.environ["GATE_EXIT"]))
'''
    for name in ("git", "uv"):
        path = bin_dir / name
        path.write_text(stub)
        path.chmod(0o755)
    script = tmp_path / "check.sh"
    script.write_text(step["run"])
    result = subprocess.run(["bash", "-eo", "pipefail", str(script)], text=True, capture_output=True,
                            env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                                 "RESULTS_BASE": "pr-base" if event == "pull_request" else "",
                                 "FORCED": "false", "COMMAND_LOG": str(log),
                                 "GATE_EXIT": str(gate_exit)})
    assert result.returncode == gate_exit, result.stderr
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    [gate_call] = [call for call in calls if call[0] == "uv"]
    assert gate_call[gate_call.index("--") + 1:] == [
        "make", "evals-results-check", f"BASE={'pr-base' if event == 'pull_request' else 'a' * 40}",
        f"HISTORY_SINCE={'' if event == 'pull_request' else 'a' * 40}",
    ]
    git_calls = [call for call in calls if call[0] == "git"]
    assert git_calls == ([] if event == "pull_request" else [["git", "rev-list", "--max-parents=0", "HEAD"]])


@pytest.mark.parametrize("history", ["", "b" * 40])
def test_results_make_target_forwards_only_a_supplied_history_since(history):
    result = subprocess.run(["make", "-n", "evals-results-check", "BASE=root-commit", f"HISTORY_SINCE={history}"],
                            cwd=ROOT, capture_output=True, text=True, check=True)
    command = shlex.split(result.stdout.strip())
    expected = ["results-check", "--base", "root-commit"]
    if history:
        expected.extend(["--history-since", history])
    assert command[command.index("results-check"):] == expected


def test_secret_scan_has_no_exceptions():
    """gitleaks' default rules with nothing to exempt a finding but one reviewed entry: no other
    allowlist, no ignore file, no inline allow. The entry covers one rule and needs its file and
    its line both, so anything else in that file is still scanned."""
    assert tomllib.loads((ROOT / ".gitleaks.toml").read_text()) == {
        "minVersion": "v8.30.1",
        "extend": {"useDefault": True},
        "allowlists": [{
            "description": "backend/tests/kernel/fixtures/kernel_core_version.json: a kernel-core rules version's "
                           "SHA-256 hashes, replayed by the upgrade test; no credentials",
            "targetRules": ["generic-api-key"],
            "condition": "AND",
            "paths": ["^backend/tests/kernel/fixtures/kernel_core_version\\.json$"],
            "regexTarget": "line",
            "regexes": ['^\\s*"draft_key_sha256": "[0-9a-f]{64}",?$'],
        }],
    }
    assert not (ROOT / ".gitleaksignore").exists()
    [scan] = checks(job_named("secret scan"))
    assert "--ignore-gitleaks-allow" in shlex.split(scan)
    # Nothing points gitleaks at another config.
    for path in [WORKFLOW, *ACTIONS]:
        assert "GITLEAKS_" not in path.read_text(), path


# Each tool CI downloads, by runner architecture (GitHub's RUNNER_ARCH): the release asset and
# its sha256, taken from the release and checked with sha256sum before it was pinned here.
PINNED_DOWNLOADS = {
    "Install cvc5 1.4.2": {
        "X64": (
            "https://github.com/cvc5/cvc5/releases/download/cvc5-1.4.2/cvc5-Linux-x86_64-static.zip",
            "7eb18f8c814c36a46c5a7d003983e9cfbc4b0a9828d6dd596239291bd4cc61d8",
        ),
        "ARM64": (
            "https://github.com/cvc5/cvc5/releases/download/cvc5-1.4.2/cvc5-Linux-arm64-static.zip",
            "765ebee59d9e5efccb60a445fa66fbddfb07a8de9fe7a5b6d128e5c2aafec974",
        ),
    },
    "Install gitleaks 8.30.1": {
        "X64": (
            "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
            "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
        ),
        "ARM64": (
            "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_arm64.tar.gz",
            "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
        ),
    },
    "Install actionlint 1.7.12": {
        "X64": (
            "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
            "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        ),
        "ARM64": (
            "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_arm64.tar.gz",
            "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
        ),
    },
    # Only on a runner without rustup; GitHub-hosted runners have it.
    "Install rustup 1.29.1 if the runner has none": {
        "X64": (
            "https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init",
            "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71",
        ),
        "ARM64": (
            "https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-unknown-linux-gnu/rustup-init",
            "15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433",
        ),
    },
}
INSTALL_RUSTUP = "Install rustup 1.29.1 if the runner has none"

BASH = shutil.which("bash")

# Stand-ins for the commands a download step runs, as Python scripts that log each call to
# $STUB_LOG. curl writes $STUB_BODY (or a line that is no release) where -o says. sha256sum -c
# logs the lines it was asked to check, from its file argument or stdin, and passes only when
# $STUB_CHECK_PASSES is 1, so by default it fails as a tampered download would.
STUBS = {
    "curl": """
args = sys.argv[1:]
saved = os.path.join(os.getcwd(), args[args.index("-o") + 1])
[url] = [arg for arg in args if arg.startswith("https://")]
log("curl", url, saved)
with open(saved, "w") as file:
    file.write(os.environ.get("STUB_BODY", "not the release\\n"))
""",
    "sha256sum": """
args = sys.argv[1:]
assert "-c" in args, args
files = [arg for arg in args if not arg.startswith("-")]
lines = (open(files[0]).read() if files else sys.stdin.read()).splitlines()
log("sha256sum -c", os.getcwd(), lines)
sys.exit(0 if os.environ.get("STUB_CHECK_PASSES") == "1" else 1)
""",
    "tar": 'log("tar", *sys.argv[1:])',
    "unzip": 'log("unzip", *sys.argv[1:])',
    "sudo": 'log("sudo", *sys.argv[1:])',
}
STUB_PRELUDE = """
import json, os, sys

def log(*event):
    with open(os.environ["STUB_LOG"], "a") as file:
        file.write(json.dumps(event) + "\\n")
"""


def step_named(name: str) -> dict:
    [step] = [step for step in all_steps() if step.get("name") == name]
    return step


class Runner:
    """Runs a step's script as GitHub runs a `shell: bash` step, on a runner of the given architecture.

    PATH is only a sandbox bin holding the stubs and links to REAL_TOOLS, so nothing else on the
    machine running the tests is found."""

    def __init__(self, tmp_path: Path):
        self.dir = tmp_path
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        for name, body in STUBS.items():
            stub = self.bin / name
            stub.write_text(f"#!{sys.executable} -I\n{STUB_PRELUDE}\n{body}")
            stub.chmod(0o755)
        for tool in REAL_TOOLS:
            real = shutil.which(tool)
            assert real, tool
            (self.bin / tool).symlink_to(real)
        (tmp_path / "home").mkdir()
        (tmp_path / "runner-temp").mkdir()
        # The system the runner reports, read in place of /etc/os-release.
        self.os_release = tmp_path / "os-release"
        self.os_release.write_text('NAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
        self.github_path = tmp_path / "github-path"
        self.github_env = tmp_path / "github-env"
        self.log = tmp_path / "stub-log"

    def run(self, step: dict, arch: str, **env: str) -> tuple[subprocess.CompletedProcess, list[list]]:
        """The step's result and the stub calls it made, in order; env adds to or replaces the runner's."""
        self.log.unlink(missing_ok=True)
        script = self.dir / "step.sh"
        script.write_text(step["run"].replace("/etc/os-release", str(self.os_release)))
        result = subprocess.run(
            [BASH, "--noprofile", "--norc", "-eo", "pipefail", str(script)],
            env={
                "PATH": str(self.bin),
                "HOME": str(self.dir / "home"),
                "RUNNER_ARCH": arch,
                "RUNNER_TEMP": str(self.dir / "runner-temp"),
                "GITHUB_WORKSPACE": str(ROOT),
                "GITHUB_PATH": str(self.github_path),
                "GITHUB_ENV": str(self.github_env),
                "STUB_LOG": str(self.log),
                **env,
            },
            cwd=self.dir,
            capture_output=True,
            text=True,
        )
        events = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, events


# The real commands the steps' scripts run besides bash's builtins and the stubs.
REAL_TOOLS = ["chmod", "grep", "mkdir"]


def test_steps_see_only_the_sandbox(tmp_path):
    """A tool on the machine running the tests, such as rustup or psql, can't stand in for one a runner lacks."""
    runner = Runner(tmp_path)

    result, _ = runner.run({"run": 'echo "$PATH"'}, "X64")

    assert result.stdout == f"{runner.bin}\n"
    assert sorted(path.name for path in runner.bin.iterdir()) == sorted([*STUBS, *REAL_TOOLS])


@pytest.mark.parametrize("arch", ["X64", "ARM64"])
@pytest.mark.parametrize("name", PINNED_DOWNLOADS)
def test_downloads_are_chosen_by_architecture_and_checked_first(tmp_path, name, arch):
    """Each tool is the pinned asset for the runner's architecture, and a failed check stops the step."""
    url, sha256 = PINNED_DOWNLOADS[name][arch]
    runner = Runner(tmp_path)

    result, events = runner.run(step_named(name), arch)

    assert [event[0] for event in events] == ["curl", "sha256sum -c"], (result.stderr, events)
    [[_, fetched, saved], [_, checked_in, lines]] = events
    assert fetched == url
    assert Path(saved).name == url.rsplit("/", 1)[1]
    # The check names exactly the file just fetched, with the pinned digest and nothing else.
    assert lines == [f"{sha256}  {Path(saved).name}"]
    assert Path(checked_in, Path(saved).name) == Path(saved)
    # The failed check fails the step before anything is unpacked or put on PATH.
    assert result.returncode == 1, result.stderr
    assert not runner.github_path.exists() and not runner.github_env.exists()


@pytest.mark.parametrize("name", PINNED_DOWNLOADS)
def test_an_unknown_architecture_downloads_nothing(tmp_path, name):
    runner = Runner(tmp_path)

    result, events = runner.run(step_named(name), "ARM")

    assert result.returncode == 1
    assert events == []
    assert "runner architecture ARM" in result.stderr
    assert not runner.github_path.exists() and not runner.github_env.exists()


def test_cvc5_checksums_cover_both_linux_builds():
    """setup-desk checks cvc5 against tools/cvc5.sha256, which local setup also reads."""
    lines = (ROOT / "tools/cvc5.sha256").read_text().splitlines()
    for url, sha256 in PINNED_DOWNLOADS["Install cvc5 1.4.2"].values():
        assert f"{sha256}  {url.rsplit('/', 1)[1]}" in lines, url


def test_rustup_is_left_alone_where_the_runner_has_it(tmp_path):
    runner = Runner(tmp_path)
    (runner.bin / "rustup").symlink_to(runner.bin / "tar")

    result, events = runner.run(step_named(INSTALL_RUSTUP), "X64")

    assert result.returncode == 0, result.stderr
    assert events == []
    assert not runner.github_path.exists()


@pytest.mark.parametrize("arch", ["X64", "ARM64"])
def test_rustup_init_runs_only_after_its_check_passes(tmp_path, arch):
    """The checked rustup-init installs rustup with no toolchain; setup-desk then installs the pinned one."""
    url, sha256 = PINNED_DOWNLOADS[INSTALL_RUSTUP][arch]
    runner = Runner(tmp_path)
    rustup_init = f"#!{sys.executable} -I\n{STUB_PRELUDE}\nlog('rustup-init', *sys.argv[1:])\n"

    result, events = runner.run(step_named(INSTALL_RUSTUP), arch, STUB_CHECK_PASSES="1", STUB_BODY=rustup_init)

    assert result.returncode == 0, result.stderr
    assert events[:2] == [
        ["curl", url, events[0][2]],
        ["sha256sum -c", str(Path(events[0][2]).parent), [f"{sha256}  rustup-init"]],
    ]
    assert events[2:] == [["rustup-init", "-y", "--profile", "minimal", "--default-toolchain", "none", "--no-modify-path"]]
    assert runner.github_path.read_text() == f"{tmp_path / 'home'}/.cargo/bin\n"


def test_setup_desk_installs_the_pinned_toolchain_after_rustup():
    steps = load(ROOT / ".github/actions/setup-desk/action.yml")["runs"]["steps"]
    names = [step.get("name") for step in steps]

    toolchain = step_named("Install Rust 1.99.1")
    assert names.index(INSTALL_RUSTUP) + 1 == names.index("Install Rust 1.99.1")
    assert toolchain["run"] == "rustup toolchain install 1.99.1 --profile minimal --no-self-update\nrustup default 1.99.1\n"


# Commands GitHub-hosted runners have and other runners may not, installed from Ubuntu's archive
# before their first use: step name -> (command, apt package, the jobs, the first command that needs it).
APT_INSTALLS = {
    # make db-roles sets the role passwords with psql.
    "Install the Postgres client if the runner has none": (
        "psql", "postgresql-client", list(SHARD_JOBS.values()), "make db-roles",
    ),
    # actionlint runs shellcheck on the workflow's scripts only when shellcheck is on PATH.
    "Install ShellCheck if the runner has none": ("shellcheck", "shellcheck", ["repo checks"], "actionlint"),
}


@pytest.mark.parametrize("install", APT_INSTALLS)
def test_jobs_install_what_hosted_runners_have_before_using_it(install):
    _, _, users, first_use = APT_INSTALLS[install]
    for name in users:
        steps = job_named(name)["steps"]
        names = [step.get("name") for step in steps]
        commands = [step.get("run", "").strip() for step in steps]
        assert names.count(install) == 1, name
        assert names.index(install) < commands.index(first_use), name
    for job in jobs(load(WORKFLOW)):
        if job["name"] not in users:
            assert install not in [step.get("name") for step in job["steps"]], job["name"]


@pytest.mark.parametrize("install", APT_INSTALLS)
def test_apt_installs_only_where_the_command_is_missing(tmp_path, install):
    command, package, users, _ = APT_INSTALLS[install]
    runner = Runner(tmp_path)
    [step, *same] = [step for name in users for step in job_named(name)["steps"] if step.get("name") == install]
    assert all(other == step for other in same)

    result, events = runner.run(step, "ARM64")

    assert result.returncode == 0, result.stderr
    # A freshly booted runner may still hold the dpkg lock for its own updates, so apt waits for it.
    wait = ["-o", "DPkg::Lock::Timeout=300"]
    assert events == [
        ["sudo", "apt-get", *wait, "update", "-q"],
        ["sudo", "DEBIAN_FRONTEND=noninteractive", "apt-get", *wait, "install", "-y", "-q", "--no-install-recommends", package],
    ]

    (runner.bin / command).symlink_to(runner.bin / "tar")
    result, events = runner.run(step, "X64")

    assert result.returncode == 0, result.stderr
    assert events == []


def test_ci_doc_says_where_jobs_run_and_how_to_switch_back():
    section = CI_DOC.read_text().split("\n## Runners\n", 1)[1].split("\n## ", 1)[0]

    assert "`ubuntu-24.04`" in section
    # The variable and value the workflow's switch reads, and its kill switch.
    [(variable, value)] = set(re.findall(r"vars\.(\w+) == '(\w+)'", RUNS_ON))
    assert f"`{variable}={value}`" in section
    assert "unset the variable" in section.lower()
    # Pull requests from forks never reach a self-hosted runner, and the doc says so.
    assert "pull requests from forks" in section.lower()


CHECK_RUNNER = "Check the runner is Ubuntu 24.04 with curl, unzip, make and cc"
# What a runner must have before any job starts, as docs/ci.md's Runners section lists it.
RUNNER_PREREQUISITES = ["docker", "sudo", "curl", "git", "make", "unzip", "cc", "tar"]


def test_setup_desk_first_checks_the_runner_has_what_it_needs(tmp_path):
    """curl and unzip fetch and unpack the tools, make builds the kernel, and cc links Rust code."""
    steps = load(ROOT / ".github/actions/setup-desk/action.yml")["runs"]["steps"]
    assert steps[0]["name"] == CHECK_RUNNER
    runner = Runner(tmp_path)

    # The stubs give curl and unzip but no make or cc.
    result, events = runner.run(steps[0], "ARM64")

    assert result.returncode == 1
    assert "the runner has no make cc;" in result.stderr
    assert events == []

    for tool in ["make", "cc"]:
        (runner.bin / tool).symlink_to(runner.bin / "tar")
    result, events = runner.run(steps[0], "ARM64")

    assert result.returncode == 0, result.stderr
    assert events == []


def test_ci_doc_lists_what_a_runner_needs():
    section = CI_DOC.read_text().split("\n## Runners\n", 1)[1].split("\n## ", 1)[0]
    [line] = [line for line in section.splitlines() if line.startswith("- **Prerequisites.**")]

    assert re.findall(r"`([^`]+)`", line) == RUNNER_PREREQUISITES


# GitHub gives a job to any runner whose labels include all of the job's labels. A desk runner
# carries exactly `self-hosted` and its own desk label, with no default OS or architecture labels,
# so a job asking for `self-hosted`, `linux`, `ARM64` or another job's desk label could take a
# runner meant for a different job, and the launcher would then stop the wrong machine. So every
# runs-on, in every workflow, is either a GitHub-hosted image label or, for ci.yml's checks and suite shards, that
# job's own desk expression.
WORKFLOWS = sorted([*(ROOT / ".github/workflows").glob("*.yml"), *(ROOT / ".github/workflows").glob("*.yaml")])
HOSTED_IMAGE = re.compile(r"(ubuntu|windows|macos)-[\w.-]+")


def runs_on_text(value) -> str:
    """Every string in a runs-on value, whatever its form: a label, a list, a group mapping or an expression."""
    if isinstance(value, dict):
        return "\n".join(runs_on_text(item) for item in value.values())
    if isinstance(value, list):
        return "\n".join(runs_on_text(item) for item in value)
    return str(value)


def runner_label_problems(file: str, workflow: dict) -> list[str]:
    """Each job whose runs-on isn't a GitHub-hosted image label or, in ci.yml, its own desk expression."""
    problems = []
    for key, job in (workflow.get("jobs") or {}).items():
        if "runs-on" not in job:
            # A job that calls a reusable workflow has no runner of its own.
            if "uses" not in job:
                problems.append(f"{key}: has no runs-on")
            continue
        runs_on = job["runs-on"]
        allowed = file == "ci.yml" and key in RUNNER_SUFFIXES | SHARD_JOBS.keys() | WEB_SHARD_JOBS.keys() | WEB_E2E_JOB.keys()
        if isinstance(runs_on, str) and HOSTED_IMAGE.fullmatch(runs_on):
            continue
        if allowed and runs_on == own_desk(key):
            continue
        if not allowed and re.search(r"desk-ci-", runs_on_text(runs_on), flags=re.IGNORECASE):
            problems.append(f"{key}: only ci.yml's checks, suite shards and path classifier may ask for desk labels")
        else:
            problems.append(f"{key}: runs-on is neither a GitHub-hosted image nor this job's own desk expression")
    return problems


def test_no_job_can_take_another_jobs_desk_runner():
    assert "ci.yml" in [path.name for path in WORKFLOWS]
    for path in WORKFLOWS:
        assert runner_label_problems(path.name, load(path)) == [], path.name


NOT_ALLOWED = "runs-on is neither a GitHub-hosted image nor this job's own desk expression"
ONLY_CI_JOBS = "only ci.yml's checks, suite shards and path classifier may ask for desk labels"


def own_desk(key: str) -> str:
    return RUNS_ON.replace("<suffix>", key)


@pytest.mark.parametrize(
    "file, key, runs_on, problem",
    [
        # Labels a desk runner could carry, in each form runs-on takes.
        ("other.yml", "lint", "self-hosted", NOT_ALLOWED),
        ("other.yml", "lint", "linux", NOT_ALLOWED),
        ("other.yml", "lint", "ARM64", NOT_ALLOWED),
        ("other.yml", "lint", ["Linux", "ARM64"], NOT_ALLOWED),
        ("other.yml", "lint", ["Self-Hosted", "linux", "ARM64"], NOT_ALLOWED),
        ("other.yml", "lint", {"group": "desk", "labels": ["self-hosted"]}, NOT_ALLOWED),
        ("other.yml", "lint", ["ubuntu-24.04"], NOT_ALLOWED),
        # Any expression but the job's own desk one.
        ("ci.yml", "web", "${{ vars.X == 'y' && 'self-hosted' || 'ubuntu-24.04' }}", NOT_ALLOWED),
        ("ci.yml", "web", "${{ matrix.os }}", NOT_ALLOWED),
        ("ci.yml", "backend", own_desk("web"), NOT_ALLOWED),
        ("ci.yml", "backend-1", own_desk("tier1-1"), NOT_ALLOWED),
        ("ci.yml", "backend-1", own_desk("backend"), NOT_ALLOWED),
        ("ci.yml", "backend-1", own_desk("backend-2"), NOT_ALLOWED),
        ("ci.yml", "backend", ["self-hosted", "desk-ci-spot-1-1-backend"], NOT_ALLOWED),
        # Desk labels anywhere but ci.yml's checks and suite shards.
        ("other.yml", "backend", own_desk("backend"), ONLY_CI_JOBS),
        ("other.yml", "lint", ["self-hosted", "desk-ci-spot-1-1-lint"], ONLY_CI_JOBS),
        ("ci.yml", "extra", own_desk("extra"), ONLY_CI_JOBS),
    ],
)
def test_runner_label_rules_catch_a_job_that_could_take_the_wrong_runner(file, key, runs_on, problem):
    assert runner_label_problems(file, {"jobs": {key: {"runs-on": runs_on}}}) == [f"{key}: {problem}"]


@pytest.mark.parametrize(
    "file, key, job",
    [
        ("other.yml", "lint", {"runs-on": "ubuntu-24.04"}),
        ("other.yml", "lint", {"runs-on": "ubuntu-24.04-arm"}),
        ("other.yml", "lint", {"runs-on": "windows-2025"}),
        ("other.yml", "lint", {"runs-on": "macos-15"}),
        ("ci.yml", "backend", {"runs-on": own_desk("backend")}),
        *[("ci.yml", key, {"runs-on": own_desk(key)}) for key in SHARD_JOBS],
        ("ci.yml", "secret-scan", {"runs-on": own_desk("secret-scan")}),
        ("other.yml", "release", {"uses": "./.github/workflows/ci.yml"}),
    ],
)
def test_runner_label_rules_allow_hosted_images_and_a_jobs_own_desk_expression(file, key, job):
    assert runner_label_problems(file, {"jobs": {key: job}}) == []


@pytest.mark.parametrize(
    "environment, os_release, passes",
    [
        ("self-hosted", "VERSION_CODENAME=noble\n", True),
        ("self-hosted", "VERSION_CODENAME=jammy\n", False),
        ("self-hosted", 'NAME="Debian GNU/Linux"\n', False),
        ("self-hosted", None, False),
        # A runner that doesn't say it is GitHub-hosted is checked.
        (None, "VERSION_CODENAME=jammy\n", False),
        # GitHub-hosted runners are the ubuntu-24.04 image runs-on names.
        ("github-hosted", "VERSION_CODENAME=jammy\n", True),
    ],
)
def test_runner_check_requires_ubuntu_24_04_on_any_runner_not_github_hosted(tmp_path, environment, os_release, passes):
    step = step_named(CHECK_RUNNER)
    assert "/etc/os-release" in step["run"]
    runner = Runner(tmp_path)
    for tool in ["make", "cc"]:
        (runner.bin / tool).symlink_to(runner.bin / "tar")
    if os_release is None:
        runner.os_release.unlink()
    else:
        runner.os_release.write_text(os_release)
    env = {} if environment is None else {"RUNNER_ENVIRONMENT": environment}

    result, events = runner.run(step, "ARM64", **env)

    assert events == []
    if passes:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode == 1
        assert "must be Ubuntu 24.04 (noble)" in result.stderr


def test_infra_synth_runs_without_the_shared_jsii_cache():
    # Single-use runners' home caches are group-writable, so jsii refuses its package cache and synth
    # fails. Each runner is fresh, so a cache saves nothing: the step turns it off.
    infra = load(WORKFLOW)["jobs"]["infra"]
    [synth] = [step for step in infra["steps"] if step.get("name") == "Test and synthesize the infrastructure"]
    assert synth.get("env", {}).get("JSII_RUNTIME_PACKAGE_CACHE") == "disabled"
