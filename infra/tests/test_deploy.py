"""deploy.sh, run in a pseudo-terminal with `aws`, `npx`, `npm`, `make` and `uv` stubbed: the
order of the steps, what each is given, that `cdk deploy` keeps a terminal for its approval prompt,
and that the first failing step stops the deploy. Nothing reaches AWS."""

import json
import os
import pty
import select
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import INFRA

SCRIPT = INFRA / "scripts" / "deploy.sh"
REPO = INFRA.parent
ACCOUNT = "123456789012"
DISTRIBUTION_URL = "https://d111111abcdef8.cloudfront.net"
ENDPOINT = "https://desk-0a1b2c3d.ecs.us-west-2.on.aws/"
DOMAIN = "desk.example.com"
CERTIFICATE = f"arn:aws:acm:us-east-1:{ACCOUNT}:certificate/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"

# Each stub appends {"tool", "argv", "cwd", "tty"} to $STUB_LOG; aws and cdk read and write the
# deployed stacks' outputs in $STACKS (JSON), as CloudFormation would hold them.
STUB = """#!{python}
import json, os, re, sys
tool, args = os.path.basename(sys.argv[0]), sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps({{"tool": tool, "argv": args, "cwd": os.getcwd(), "tty": os.isatty(1)}}) + "\\n")
stacks_path = os.environ["STACKS"]
stacks = json.load(open(stacks_path)) if os.path.exists(stacks_path) else {{}}
joined = " ".join(args)
for name, needle in (("FAIL_PREFLIGHT", "preflight.py"), ("FAIL_ADMIN", "run_admin_task.py"),
                     ("FAIL_IMAGE", "image")):
    if os.environ.get(name) and needle in joined and tool in ("uv", "make"):
        print(f"stub: {{needle}} failed", file=sys.stderr)
        sys.exit(1)
if tool == "uv" and "smoke.py" in joined:
    sys.exit(int(os.environ.get("SMOKE_STATUS", "0")))
if tool == "aws" and args[:2] == ["sts", "get-caller-identity"]:
    print("{account}")
elif tool == "aws" and args[:2] == ["cloudformation", "describe-stacks"]:
    stack = args[args.index("--stack-name") + 1]
    key = re.search(r"OutputKey=='(\\w+)'", args[args.index("--query") + 1]).group(1)
    if stack not in stacks:
        print(f"An error occurred (ValidationError) when calling the DescribeStacks operation: "
              f"Stack with id {{stack}} does not exist", file=sys.stderr)
        sys.exit(254)
    print(stacks[stack].get(key, "None"))
elif tool == "npx" and args[:2] == ["--no-install", "cdk"] and args[2] == "deploy":
    stack = args[3]
    print(f"stub: cdk events for {{stack}}", file=sys.stderr)  # cdk's diff, prompt and events: stderr
    print(f"stub: cdk stack outputs for {{stack}}")            # its results: stdout
    context = dict(args[i + 1].split("=", 1) for i, arg in enumerate(args) if arg == "-c")
    if stack == "DeskData":
        stacks["DeskData"] = {{"ClusterName": "desk"}}
    else:
        domain = os.environ.get("DESK_DOMAIN_NAME")
        deploys = stacks.get("DeskApp", {{}}).get("Deploys", 0) + 1
        url = f"https://{{domain}}" if domain else "{distribution}"
        if os.environ.get("STUB_URL_MOVES") and deploys > 1:        # a distribution replaced on redeploy
            url = "https://d222222abcdef8.cloudfront.net"
        sha = os.environ.get("STUB_DEPLOYED_SHA") or context.get("git_sha", "unset")
        stacks["DeskApp"] = {{"PublicUrl": url, "ServiceEndpoint": "{endpoint}", "DeployedSha": sha,
                             "Deploys": deploys}}
    json.dump(stacks, open(stacks_path, "w"))
"""


@pytest.fixture
def deploy(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    body = STUB.format(python=sys.executable, account=ACCOUNT, distribution=DISTRIBUTION_URL, endpoint=ENDPOINT)
    for tool in ("aws", "npx", "npm", "make", "uv"):
        (bin_dir / tool).write_text(body)
        (bin_dir / tool).chmod(stat.S_IRWXU)
    out = tmp_path / "out"
    stacks = tmp_path / "stacks.json"
    log = tmp_path / "stub.log"

    class Run:
        def __init__(self, status: int, output: str) -> None:
            self.status, self.output = status, output
            self.calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            logs = sorted(out.glob("deploy-*.log"))
            self.log = logs[-1].read_text() if logs else ""

        def steps(self) -> list[str]:
            """Each call as `<tool> <first meaningful args>`."""
            steps = []
            for call in self.calls:
                argv = call["argv"]
                if call["tool"] == "uv":
                    steps.append("uv " + Path(argv[argv.index("python") + 1]).name)
                elif call["tool"] == "npx":
                    steps.append(f"cdk {argv[2]} {argv[3]}")
                elif call["tool"] == "aws":
                    steps.append("aws " + " ".join(argv[:2]))
                elif call["tool"] == "make":                        # its targets: no -C <dir>, no VAR=value
                    targets = [a for i, a in enumerate(argv) if a != "-C" and argv[i - 1:i] != ["-C"] and "=" not in a]
                    steps.append("make " + " ".join(targets))
                else:
                    steps.append(f"{call['tool']} {argv[0]}")
            return steps

        def cdk(self, stack: str) -> list[dict]:
            return [call for call in self.calls if call["tool"] == "npx" and call["argv"][3] == stack]

        def smoke(self) -> list[str]:
            [call] = [call for call in self.calls if call["tool"] == "uv" and any("smoke.py" in a for a in call["argv"])]
            return call["argv"][call["argv"].index(next(a for a in call["argv"] if a.endswith("smoke.py"))) + 1:]

    def run(*args: str, typed: str = ACCOUNT, terminal: bool = True, deployed: dict | None = None,
            **extra_env: str) -> Run:
        if deployed is not None:
            stacks.write_text(json.dumps(deployed))
        env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "HOME": os.environ.get("HOME", str(tmp_path)),
            "STUB_LOG": str(log),
            "STACKS": str(stacks),
            "DESK_DEPLOY_OUT": str(out),
            "DESK_PASSCODE": "deploy-test-passcode",
            "TERM": "dumb",
            **extra_env,
        }
        env = {name: value for name, value in env.items() if value is not None}
        command = ["bash", str(SCRIPT), *args]
        if not terminal:
            result = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    timeout=60)
            return Run(result.returncode, result.stdout + result.stderr)
        primary, secondary = pty.openpty()
        process = subprocess.Popen(command, env=env, stdin=secondary, stdout=secondary, stderr=secondary)
        os.close(secondary)
        os.write(primary, f"{typed}\n".encode())
        chunks = []
        while True:
            ready, _, _ = select.select([primary], [], [], 60)
            if not ready:
                process.kill()
                raise AssertionError("deploy.sh hung: " + b"".join(chunks).decode(errors="replace"))
            try:
                chunk = os.read(primary, 4096)
            except OSError:
                break
            if not chunk:
                break
            chunks.append(chunk)
        os.close(primary)
        return Run(process.wait(timeout=60), b"".join(chunks).decode(errors="replace"))

    return run


def _context(call: dict) -> dict[str, str]:
    argv = call["argv"]
    return dict(argv[i + 1].split("=", 1) for i, arg in enumerate(argv) if arg == "-c")


def _head() -> str:
    return subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True,
                          check=True).stdout.strip()


def test_first_deploy_runs_every_step_in_order(deploy):
    run = deploy()
    assert run.status == 0, run.output
    assert run.steps() == [
        "aws sts get-caller-identity",
        "uv preflight.py",
        "aws cloudformation describe-stacks",  # DeskApp's PublicUrl: none yet
        "make image image-check",              # built, then checked, before any change in AWS
        "npm ci",
        "cdk deploy DeskData",
        "uv run_admin_task.py",
        "cdk deploy DeskApp",
        "aws cloudformation describe-stacks",  # the new PublicUrl differs from the pending origin
        "cdk deploy DeskApp",
        "aws cloudformation describe-stacks",
        "aws cloudformation describe-stacks",  # DeployedSha
        "aws cloudformation describe-stacks",  # ClusterName
        "aws cloudformation describe-stacks",  # ServiceEndpoint
        "uv smoke.py",
    ]
    first, second = run.cdk("DeskApp")
    assert "public_origin" not in _context(first)
    assert _context(second)["public_origin"] == DISTRIBUTION_URL
    assert run.smoke() == ["--base-url", DISTRIBUTION_URL, "--cluster", "desk",
                           "--origin-host", "desk-0a1b2c3d.ecs.us-west-2.on.aws"]


def test_cdk_deploys_ask_for_approval_on_the_terminal(deploy):
    run = deploy()
    assert run.status == 0, run.output
    cdk_calls = [call for call in run.calls if call["tool"] == "npx"]
    assert cdk_calls
    for call in cdk_calls:
        argv = call["argv"]
        assert argv[argv.index("--require-approval") + 1] == "broadening"
        assert "--exclusively" in argv
        assert call["tty"], "cdk prompts for approval only when its output is a terminal"
        assert call["cwd"] == str(INFRA)
        context = _context(call)
        assert context["compute"] == "express"
        assert context["git_sha"] == _head()
        assert context["web_dist"] == str(REPO / "web" / "dist")


def test_the_image_is_built_from_this_checkout_at_head(deploy):
    """The kernel image the app image is built on is tagged with HEAD, and cdk is given every image
    input, so neither another worktree's desk-kernel:dev nor an exported DESK_IMAGE_* setting can
    reach the image that ships while DeployedSha reports HEAD."""
    run = deploy()
    assert run.status == 0, run.output
    [make] = [call for call in run.calls if call["tool"] == "make"]
    assert make["argv"][:2] == ["-C", str(REPO)]
    assert f"KERNEL_TAG={_head()}" in make["argv"]
    cdk_calls = [call for call in run.calls if call["tool"] == "npx"]
    assert len(cdk_calls) == 3
    for call in cdk_calls:
        context = _context(call)
        assert context["kernel_image"] == f"desk-kernel:{_head()}"
        assert context["image_dir"] == str(REPO)
        assert context["image_file"] == "infra/app.Dockerfile"


@pytest.mark.parametrize("name", ["DESK_IMAGE_DIR", "DESK_IMAGE_FILE", "DESK_KERNEL_IMAGE"])
def test_an_exported_image_setting_stops_the_deploy(deploy, name):
    """cdk would read DESK_<KEY> for a setting the deploy doesn't pass; deploy.sh passes these, and
    refuses to start while one is exported rather than leave it to a reader to wonder which won."""
    run = deploy(**{name: "/elsewhere"})
    assert run.status == 2
    assert f"unset {name}" in run.output
    assert run.calls == []


def test_a_failed_image_check_stops_before_any_change(deploy):
    """image-check catches a missing or stale proof report, among others, before cdk runs."""
    run = deploy(FAIL_IMAGE="1")
    assert run.status == 1
    assert run.steps()[-1] == "make image image-check"
    assert not run.cdk("DeskData") and not run.cdk("DeskApp")


def test_make_image_check_reads_the_image_kernel_tag_built():
    """With KERNEL_TAG, image-check checks the app image `make image` just tagged."""
    dry_run = subprocess.run(["make", "-n", "-C", str(REPO), "image-check", "KERNEL_TAG=0a1b2c3"],
                             capture_output=True, text=True, check=True).stdout
    assert 'docker run --rm "desk-app:0a1b2c3"' in dry_run


def test_make_image_tags_both_images_with_kernel_tag():
    """`make image` builds desk-kernel:<KERNEL_TAG> and the app image on it (dev unless given)."""
    def dry_run(*args: str) -> str:
        return subprocess.run(["make", "-n", "-C", str(REPO), "image", *args], capture_output=True, text=True,
                              check=True).stdout

    tagged = dry_run("KERNEL_TAG=0a1b2c3")
    assert "-f kernel/Dockerfile -t desk-kernel:0a1b2c3 ." in tagged
    assert "--build-arg KERNEL_IMAGE=desk-kernel:0a1b2c3 -t desk-app:0a1b2c3 ." in tagged
    assert "desk-kernel:dev" not in tagged and "desk-app:dev" not in tagged
    plain = dry_run()
    assert "-t desk-kernel:dev ." in plain and "--build-arg KERNEL_IMAGE=desk-kernel:dev -t desk-app:dev ." in plain


def test_everything_is_logged(deploy):
    run = deploy()
    assert run.status == 0, run.output
    assert _head() in run.log and ACCOUNT in run.log
    assert "Smoke checks" in run.log and DISTRIBUTION_URL in run.log
    assert "deploy-test-passcode" not in run.log + run.output


def test_cdk_events_are_logged_and_its_stack_outputs_stay_on_the_terminal(deploy):
    """cdk deploy writes all but its results to stderr, which the log keeps; its results (the stack
    outputs) go to stdout, which stays the terminal its approval prompt needs. docs/deploy.md says so."""
    run = deploy()
    assert run.status == 0, run.output
    for stack in ("DeskData", "DeskApp"):
        assert f"stub: cdk events for {stack}" in run.log
        assert f"stub: cdk stack outputs for {stack}" in run.output
        assert f"stub: cdk stack outputs for {stack}" not in run.log


def test_a_later_deploy_keeps_its_public_url(deploy):
    deployed = {"DeskData": {"ClusterName": "desk"},
                "DeskApp": {"PublicUrl": DISTRIBUTION_URL, "ServiceEndpoint": ENDPOINT, "DeployedSha": "0" * 40}}
    run = deploy(deployed=deployed)
    assert run.status == 0, run.output
    [only] = run.cdk("DeskApp")
    assert _context(only)["public_origin"] == DISTRIBUTION_URL


def test_custom_domain_deploys_desk_app_once(deploy):
    run = deploy(DESK_DOMAIN_NAME=DOMAIN, DESK_CERTIFICATE_ARN=CERTIFICATE)
    assert run.status == 0, run.output
    assert len(run.cdk("DeskApp")) == 1
    assert run.smoke()[:2] == ["--base-url", f"https://{DOMAIN}"]


def test_deploying_without_the_domain_it_serves_is_refused(deploy):
    """Forgetting to export the domain would drop the distribution's alias and break the CNAME."""
    deployed = {"DeskApp": {"PublicUrl": f"https://{DOMAIN}", "ServiceEndpoint": ENDPOINT}}
    run = deploy(deployed=deployed)
    assert run.status == 1
    assert "DESK_DOMAIN_NAME" in run.output
    assert not [call for call in run.calls if call["tool"] in ("npx", "make")]


def test_alb_mode(deploy):
    run = deploy("--compute", "alb")
    assert run.status == 0, run.output
    assert {_context(call)["compute"] for call in run.calls if call["tool"] == "npx"} == {"alb"}
    assert "--origin-host" not in run.smoke()


def test_allow_branch_reaches_preflight(deploy):
    run = deploy("--allow-branch")
    assert run.status == 0, run.output
    [preflight] = [call for call in run.calls if call["tool"] == "uv" and any("preflight" in a for a in call["argv"])]
    assert preflight["argv"][-1] == "--allow-branch"


def test_wrong_account_stops_before_anything_else(deploy):
    run = deploy(typed="999999999999")
    assert run.status == 1
    assert run.steps() == ["aws sts get-caller-identity"]


def test_preflight_failure_stops_before_any_change(deploy):
    run = deploy(FAIL_PREFLIGHT="1")
    assert run.status == 1
    assert run.steps() == ["aws sts get-caller-identity", "uv preflight.py"]
    assert "stopped" in run.log


def test_admin_failure_stops_before_desk_app(deploy):
    run = deploy(FAIL_ADMIN="1")
    assert run.status == 1
    assert run.cdk("DeskData") and not run.cdk("DeskApp")
    assert not any(call["tool"] == "uv" and any("smoke.py" in a for a in call["argv"]) for call in run.calls)


def _smoke_ran(run) -> bool:
    return any(call["tool"] == "uv" and any("smoke.py" in a for a in call["argv"]) for call in run.calls)


def test_a_public_url_that_moves_again_stops_before_smoke(deploy):
    """The second DeskApp deploy pins the URL the first one reported; if it moves again, the API's
    links point at an address the Desk no longer serves, so the deploy stops."""
    run = deploy(STUB_URL_MOVES="1")
    assert run.status == 1
    assert len(run.cdk("DeskApp")) == 2
    assert "PublicUrl moved again" in run.log
    assert not _smoke_ran(run)


def test_a_deployed_commit_other_than_head_stops_before_smoke(deploy):
    run = deploy(STUB_DEPLOYED_SHA="0" * 40)
    assert run.status == 1
    assert f"DeskApp reports commit {'0' * 40}, not {_head()}" in run.log
    assert not _smoke_ran(run)


@pytest.mark.parametrize("status", ["1", "2"])
def test_smoke_failure_fails_the_deploy(deploy, status):
    run = deploy(SMOKE_STATUS=status)
    assert run.status == 1
    assert "smoke" in run.log.lower() and "stopped" in run.log


def test_needs_the_passcode_exported(deploy):
    run = deploy(DESK_PASSCODE=None)
    assert run.status == 2
    assert "DESK_PASSCODE" in run.output
    assert run.calls == []


def test_needs_a_terminal(deploy):
    run = deploy(terminal=False)
    assert run.status == 2
    assert "terminal" in run.output
    assert run.calls == []


def test_data_only_deploys_desk_data_behind_the_account_check(deploy):
    """The first deploy creates DeskData alone, before the owner secrets can be set, in the account
    the owner retyped, never in whichever account the ambient credentials resolve to."""
    run = deploy("--data-only", DESK_PASSCODE=None)
    assert run.status == 0, run.output
    assert run.steps() == [
        "aws sts get-caller-identity",
        "uv preflight.py",
        "make image image-check",
        "npm ci",
        "cdk deploy DeskData",
    ]
    [preflight] = [call for call in run.calls if call["tool"] == "uv"]
    assert preflight["argv"][-1] == "--data-only"
    [desk_data] = run.cdk("DeskData")
    assert desk_data["tty"]
    context = _context(desk_data)
    assert context["git_sha"] == _head() and context["kernel_image"] == f"desk-kernel:{_head()}"
    assert "web_dist" not in context
    assert "set_secret.py" in run.log and "infra/scripts/deploy.sh" in run.log      # what comes next


def test_data_only_stops_at_a_wrong_account(deploy):
    run = deploy("--data-only", typed="999999999999", DESK_PASSCODE=None)
    assert run.status == 1
    assert run.steps() == ["aws sts get-caller-identity"]


@pytest.mark.parametrize("args", [["--compute", "lambda"], ["--compute"], ["--force"]])
def test_usage_errors(deploy, args):
    run = deploy(*args)
    assert run.status == 2
    assert run.calls == []
