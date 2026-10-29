"""The CI workflow and its setup action, read as data: what runs, when, with which pins and rights."""

import re
import shlex
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from test_gate import TIER2_RESULTS_GATE

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


def test_triggers_are_main_pushes_pull_requests_and_dispatch():
    workflow = load(WORKFLOW)

    assert workflow["name"] == "ci"
    on = triggers(workflow)
    assert set(on) == {"push", "pull_request", "workflow_dispatch"}
    assert on["push"] == {"branches": ["main"]}
    assert on["pull_request"] == {"branches": ["main"]}
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

    # A script that fetches a tool checks it against a pinned sha256 after the fetch; under
    # `bash -e` with no `||` (test_gated_jobs_go_through_the_gate), a mismatch stops the script.
    for step in all_steps():
        run = step.get("run", "")
        if fetch := re.search(r"\b(curl|wget)\b", run):
            assert "sha256sum -c" in run[fetch.end() :], run
            assert not re.search(r"\|\s*(ba)?sh\b", run), run


def test_ci_has_no_secrets_and_reads_only():
    workflow = load(WORKFLOW)

    assert workflow["permissions"] == {"contents": "read"}
    for job in jobs(workflow):
        # A job may only narrow the workflow's rights.
        assert job.get("permissions", {}) in ({}, {"contents": "read"}, {"contents": "none"}), job["name"]
        # Each job starts from a checkout that leaves no token in the git config.
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

    assert [job["name"] for job in workflow_jobs] == REQUIRED_CHECKS
    assert documented_checks() == REQUIRED_CHECKS
    for job in workflow_jobs:
        assert job["runs-on"] == "ubuntu-24.04", job["name"]
        assert job["timeout-minutes"] == 25, job["name"]


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

    with_services = {job["name"]: job["services"] for job in jobs(load(WORKFLOW)) if "services" in job}
    assert set(with_services) == {"backend tests", "tier 1 evals"}
    for name, services in with_services.items():
        assert services == {
            "postgres": {
                "image": db["image"],
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
    """Both jobs that migrate check for one head first, then migrate and set the role passwords."""
    for name in ["backend tests", "tier 1 evals"]:
        commands = runs(job_named(name))
        assert SETTINGS in commands, name
        settings = commands.index(SETTINGS)
        # The heads check comes before anything migrates.
        assert commands[settings + 1 : settings + 4] == [ONE_HEAD, MIGRATE, "make db-roles"], name
        assert not any("alembic" in run for run in commands[:settings]), name

    assert runs(job_named("backend tests"))[-1] == "cd backend && uv run pytest -q"


GATE = ["uv", "run", "--project", "tools", "python", "-m", "desk_tools.gate"]
MIGRATIONS = [SETTINGS, ONE_HEAD, MIGRATE, "make db-roles"]

# What each check runs after its setup, as Plan 06a Task 2's job table says: a string is a plain
# command, a list is the gate's arguments.
CHECKS = {
    "backend tests": [*MIGRATIONS, "cd backend && uv run pytest -q"],
    "kernel tests": ["cd kernel && cargo test --locked"],
    "proofs": [
        "desk-prove --selftest",
        ["--name", "proofs", "--run-if", "backend/desk/kernel_service/compiler.py", "--", "make", "check-presets"],
    ],
    "tier 1 evals": [
        *MIGRATIONS,
        [
            "--name", "tier1",
            "--run-if", "evals/run.py",
            "--required-if", "backend/desk/kernel_service/app.py",
            "--", "make", "evals-tier1",
        ],
        [
            "--name", "kernel-contract",
            "--run-if", "backend/tests/kernel_contract/conftest.py",
            "--", "make", "kernel-contract",
        ],
    ],
    # Exactly the arguments test_gate's tier 2 regression exercises.
    "tier 2 results": [TIER2_RESULTS_GATE],
    "web tests": [
        ["--name", "web", "--run-if", "web/package.json", "--", "make", "web-test"],
        ["--name", "web-e2e", "--run-if", "web/playwright.config.ts", "--", "make", "web-e2e"],
    ],
    "infra synth": [["--name", "infra", "--run-if", "infra/cdk.json", "--", "make", "infra-check"]],
    "secret scan": ["gitleaks git --redact --no-banner --exit-code 1 ."],
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
    assert TIER2_RESULTS_GATE[TIER2_RESULTS_GATE.index("--") + 1 :] == ["make", "evals-results-check", "BASE=origin/main"]
    # Tier 2 runs on pull requests, against main's full history.
    tier2 = job_named("tier 2 results")
    assert tier2["if"] == "github.event_name == 'pull_request'"
    assert tier2["steps"][0]["with"]["fetch-depth"] == 0
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
