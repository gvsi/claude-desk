"""The CI workflow and its setup action, read as data: what runs, when, with which pins and rights."""

import json
import re
import shlex
import shutil
import subprocess
import sys
import tomllib
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

    # Python dependencies come only from the committed lockfiles: every uv command runs as --locked,
    # and fails if a lockfile is missing or out of date. No job or step changes uv's settings.
    workflow = load(WORKFLOW)
    assert workflow["env"] == {"UV_LOCKED": "1"}
    for job in jobs(workflow):
        for scope in [job, *job["steps"]]:
            assert not any(name.startswith("UV_") for name in scope.get("env", {})), scope

    # A script that fetches a tool checks it against a pinned sha256 after the fetch; under
    # `bash -e` with no `||` (test_gated_jobs_go_through_the_gate), a mismatch stops the script.
    # A fetch is curl or wget run as a command: first on a line, or after a pipe, `;`, `&` or `$(`.
    fetching = []
    for step in all_steps():
        run = step.get("run", "")
        if fetch := re.search(r"(?:^|[|;&]|\$\()\s*(curl|wget)\b", run, flags=re.MULTILINE):
            fetching.append(step["name"])
            assert "sha256sum -c" in run[fetch.end() :], run
        assert not re.search(r"\|\s*(ba)?sh\b", run), run
    # The scan finds every pinned download, and nothing else fetches.
    assert sorted(fetching) == sorted(PINNED_DOWNLOADS)


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
        assert job["timeout-minutes"] == 25, job["name"]


# The runner switch: on when the repository variable CI_RUNNER_MODE is "ec2", except for a pull
# request from a fork, whose code never runs on a self-hosted runner.
SWITCH = (
    "vars.CI_RUNNER_MODE == 'ec2' && (github.event_name != 'pull_request' "
    "|| github.event.pull_request.head.repo.full_name == github.repository)"
)
# Where each job runs: GitHub-hosted ubuntu-24.04 unless the switch is on; then a single-use
# self-hosted runner, spot for pull requests and on-demand otherwise, whose label names the run,
# the attempt and the job. <suffix> is the job's own part of the label.
RUNS_ON = (
    "${{ " + SWITCH + " && fromJSON(format("
    """'["self-hosted","desk-ci-{0}-{1}-{2}-<suffix>"]', """
    "github.event_name == 'pull_request' && 'spot' || 'ondemand', github.run_id, github.run_attempt)) "
    "|| 'ubuntu-24.04' }}"
)
# The runner launcher's suffixes, one per job.
RUNNER_SUFFIXES = {"backend", "kernel", "proofs", "tier1", "tier2", "web", "infra", "secret-scan", "repo"}


def test_jobs_run_on_hosted_runners_unless_switched_to_ec2():
    workflow_jobs = load(WORKFLOW)["jobs"]

    pattern = re.escape(RUNS_ON).replace(re.escape("<suffix>"), "(.*)")
    suffixes = []
    for job_id, job in workflow_jobs.items():
        match = re.fullmatch(pattern, job["runs-on"])
        assert match, (job_id, job["runs-on"])
        suffixes.append(match[1])
        # The label names the job, so a reader of the runner's logs can tell which job it ran.
        assert match[1] == job_id, job_id
    # Each label is unique within the run and in the launcher's form.
    assert len(suffixes) == len(set(suffixes)) == len(workflow_jobs)
    assert set(suffixes) == RUNNER_SUFFIXES
    for suffix in suffixes:
        assert re.fullmatch(r"[a-z][a-z0-9-]{0,31}", suffix), suffix
    # Hosted stays the default: with the variable unset or not "ec2", or for a fork's pull request,
    # the switch is false and the expression falls back to ubuntu-24.04. Nothing else in a job picks
    # its machine.
    for job in workflow_jobs.values():
        assert job["runs-on"].startswith("${{ " + SWITCH + " && "), job["name"]
        assert job["runs-on"].endswith(" || 'ubuntu-24.04' }}"), job["name"]
        assert not {"strategy", "container"} & set(job), job["name"]


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
    assert set(with_services) == {"backend tests", "tier 1 evals"}
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
    # Exactly the arguments test_gate's proofs regression exercises.
    "proofs": ["desk-prove --selftest", PROOFS_GATE],
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
            "--required-if", "backend/desk/api/kernel_client.py",
            "--", "make", "kernel-contract",
        ],
    ],
    # Exactly the arguments test_gate's tier 2 regression exercises.
    "tier 2 results": [TIER2_RESULTS_GATE],
    "web tests": [
        ["--name", "web", "--run-if", "web/package.json", "--", "make", "web-test"],
        [
            "--name", "web-e2e",
            "--run-if", "web/playwright.config.ts",
            "--required-if", "web/e2e",
            "--", "make", "web-e2e",
        ],
    ],
    "infra synth": [["--name", "infra", "--run-if", "infra/cdk.json", "--", "make", "infra-check"]],
    # The ref under test only (main's history plus the pull request's commits), never other branches.
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
    assert PROOFS_GATE[PROOFS_GATE.index("--") + 1 :] == ["make", "check-presets"]
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


def test_secret_scan_has_no_exceptions():
    """gitleaks' default rules with nothing to exempt a finding: no allowlist, no ignore file, no inline allow."""
    assert tomllib.loads((ROOT / ".gitleaks.toml").read_text()) == {
        "minVersion": "v8.30.1",
        "extend": {"useDefault": True},
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
    """Runs a step's script as GitHub runs a `shell: bash` step, on a runner of the given architecture."""

    def __init__(self, tmp_path: Path):
        self.dir = tmp_path
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        for name, body in STUBS.items():
            stub = self.bin / name
            stub.write_text(f"#!{sys.executable} -I\n{STUB_PRELUDE}\n{body}")
            stub.chmod(0o755)
        (tmp_path / "home").mkdir()
        (tmp_path / "runner-temp").mkdir()
        self.github_path = tmp_path / "github-path"
        self.github_env = tmp_path / "github-env"
        self.log = tmp_path / "stub-log"

    def run(self, step: dict, arch: str, **env: str) -> tuple[subprocess.CompletedProcess, list[list]]:
        """The step's result and the stub calls it made, in order; env adds to or replaces the runner's."""
        self.log.unlink(missing_ok=True)
        script = self.dir / "step.sh"
        script.write_text(step["run"])
        result = subprocess.run(
            [BASH, "--noprofile", "--norc", "-eo", "pipefail", str(script)],
            env={
                "PATH": f"{self.bin}:/usr/bin:/bin",
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
    assert shutil.which("rustup", path=f"{runner.bin}:/usr/bin:/bin") is None
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
        "psql", "postgresql-client", ["backend tests", "tier 1 evals"], "make db-roles",
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

    # Only the stubs on PATH, so the command on the machine running the test can't stand in.
    result, events = runner.run(step, "ARM64", PATH=str(runner.bin))

    assert result.returncode == 0, result.stderr
    # A freshly booted runner may still hold the dpkg lock for its own updates, so apt waits for it.
    wait = ["-o", "DPkg::Lock::Timeout=300"]
    assert events == [
        ["sudo", "apt-get", *wait, "update", "-q"],
        ["sudo", "DEBIAN_FRONTEND=noninteractive", "apt-get", *wait, "install", "-y", "-q", "--no-install-recommends", package],
    ]

    (runner.bin / command).symlink_to(runner.bin / "tar")
    result, events = runner.run(step, "X64", PATH=str(runner.bin))

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


CHECK_RUNNER = "Check the runner has curl, unzip, make and cc"
# What a runner must have before any job starts, as docs/ci.md's Runners section lists it.
RUNNER_PREREQUISITES = ["docker", "sudo", "curl", "git", "make", "unzip", "cc", "tar"]


def test_setup_desk_first_checks_the_runner_has_what_it_needs(tmp_path):
    """curl and unzip fetch and unpack the tools, make builds the kernel, and cc links Rust code."""
    steps = load(ROOT / ".github/actions/setup-desk/action.yml")["runs"]["steps"]
    assert steps[0]["name"] == CHECK_RUNNER
    runner = Runner(tmp_path)

    # The stubs give curl and unzip but no make or cc.
    result, events = runner.run(steps[0], "ARM64", PATH=str(runner.bin))

    assert result.returncode == 1
    assert "the runner has no make cc;" in result.stderr
    assert events == []

    for tool in ["make", "cc"]:
        (runner.bin / tool).symlink_to(runner.bin / "tar")
    result, events = runner.run(steps[0], "ARM64", PATH=str(runner.bin))

    assert result.returncode == 0, result.stderr
    assert events == []


def test_ci_doc_lists_what_a_runner_needs():
    section = CI_DOC.read_text().split("\n## Runners\n", 1)[1].split("\n## ", 1)[0]
    [line] = [line for line in section.splitlines() if line.startswith("- **Prerequisites.**")]

    assert re.findall(r"`([^`]+)`", line) == RUNNER_PREREQUISITES


# GitHub gives a job to any runner whose labels include all of the job's labels. A desk runner has
# `self-hosted` and its own desk-ci label, so a job that asks for `self-hosted` without its own desk
# label, or for another job's desk label, could take a runner meant for a different job, and the
# launcher would then stop the wrong machine. Only ci.yml's nine jobs may ask for desk labels.
WORKFLOWS = sorted([*(ROOT / ".github/workflows").glob("*.yml"), *(ROOT / ".github/workflows").glob("*.yaml")])


# A job's own desk label: the market, run id and attempt (literal, or the format() placeholders
# ci.yml fills), then the job's key.
DESK_LABEL = re.compile(r"desk-ci-(?:spot|ondemand|\{0\})-(?:\d+|\{1\})-(?:\d+|\{2\})-([a-z][a-z0-9-]{0,31})")


def runs_on_text(value) -> str:
    """Every string in a runs-on value, whatever its form: a label, a list, a group mapping or an expression."""
    if isinstance(value, dict):
        return "\n".join(runs_on_text(item) for item in value.values())
    if isinstance(value, list):
        return "\n".join(runs_on_text(item) for item in value)
    return str(value)


def runner_label_problems(file: str, workflow: dict) -> list[str]:
    """Each job that could take a desk runner meant for another job. Labels match in any letter case."""
    problems = []
    for key, job in (workflow.get("jobs") or {}).items():
        text = runs_on_text(job.get("runs-on", ""))
        labels = re.findall(r"desk-ci-[^\s\"',\[\]]*", text, flags=re.IGNORECASE)
        own = [label for label in labels if (match := DESK_LABEL.fullmatch(label)) and match[1] == key]
        problems += [f"{key}: {label} isn't this job's own desk label" for label in labels if label not in own]
        if labels and (file != "ci.yml" or key not in RUNNER_SUFFIXES):
            problems.append(f"{key}: only ci.yml's nine jobs may ask for desk labels")
        if re.search(r"\bself-hosted\b", text, flags=re.IGNORECASE) and not own:
            problems.append(f"{key}: self-hosted without its own desk label")
    return problems


def test_no_job_can_take_another_jobs_desk_runner():
    assert "ci.yml" in [path.name for path in WORKFLOWS]
    for path in WORKFLOWS:
        assert runner_label_problems(path.name, load(path)) == [], path.name


@pytest.mark.parametrize(
    "file, text, problem",
    [
        # self-hosted without the job's own desk label, in each form runs-on takes.
        ("other.yml", "jobs: {lint: {runs-on: self-hosted}}", "lint: self-hosted without its own desk label"),
        ("other.yml", "jobs: {lint: {runs-on: [Self-Hosted, linux, ARM64]}}", "lint: self-hosted without its own desk label"),
        ("other.yml", "jobs: {lint: {runs-on: {group: desk, labels: [self-hosted]}}}", "lint: self-hosted without its own desk label"),
        ("ci.yml", "jobs: {web: {runs-on: \"${{ vars.X == 'y' && 'self-hosted' || 'ubuntu-24.04' }}\"}}", "web: self-hosted without its own desk label"),
        # A desk label whose suffix isn't the job's key.
        ("ci.yml", "jobs: {backend: {runs-on: [self-hosted, desk-ci-spot-1-1-web]}}", "backend: desk-ci-spot-1-1-web isn't this job's own desk label"),
        ("ci.yml", "jobs: {backend: {runs-on: [desk-ci-spot-1-1-backend, desk-ci-spot-1-1-web]}}", "backend: desk-ci-spot-1-1-web isn't this job's own desk label"),
        ("ci.yml", "jobs: {backend: {runs-on: [self-hosted, desk-ci-backend]}}", "backend: desk-ci-backend isn't this job's own desk label"),
        # Desk labels anywhere but ci.yml's nine jobs.
        ("other.yml", "jobs: {backend: {runs-on: [self-hosted, desk-ci-spot-1-1-backend]}}", "backend: only ci.yml's nine jobs may ask for desk labels"),
        ("ci.yml", "jobs: {extra: {runs-on: [self-hosted, desk-ci-spot-1-1-extra]}}", "extra: only ci.yml's nine jobs may ask for desk labels"),
    ],
)
def test_runner_label_rules_catch_a_job_that_could_take_the_wrong_runner(file, text, problem):
    assert problem in runner_label_problems(file, yaml.safe_load(text))


@pytest.mark.parametrize(
    "text",
    [
        "jobs: {backend: {runs-on: ubuntu-24.04}}",
        "jobs: {backend: {runs-on: [self-hosted, desk-ci-ondemand-123-2-backend]}}",
        "jobs: {build: {uses: ./.github/workflows/other.yml}}",
    ],
)
def test_runner_label_rules_allow_hosted_runners_and_a_jobs_own_desk_label(text):
    assert runner_label_problems("ci.yml", yaml.safe_load(text)) == []
