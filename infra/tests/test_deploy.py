"""deploy.sh, run in a pseudo-terminal (or, unattended, without one) with `aws`, `npx`, `npm`,
`make`, `uv` and the Keychain's `security` stubbed: the order of the steps, what each is given,
that `cdk deploy` keeps a terminal for its approval prompt, and that the first failing step stops
the deploy. Nothing reaches AWS or the real Keychain."""

import hashlib
import json
import os
import pty
import select
import shutil
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
LOAD_BALANCER = "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/ecs-express-desk/0a1b2c3d4e5f6071"
DOMAIN = "desk.example.com"
CERTIFICATE = f"arn:aws:acm:us-east-1:{ACCOUNT}:certificate/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"
KEYCHAIN_LOOKUP = ["find-generic-password", "-s", "claude-desk-passcode", "-w"]
KEYCHAIN_PROBE = ["find-generic-password", "-s", "claude-desk-passcode", "-g"]
STORE_IT = 'security add-generic-password -s claude-desk-passcode -a "$USER" -w'
REPLACE_IT = 'security add-generic-password -U -s claude-desk-passcode -a "$USER" -w'

# Each stub appends {"tool", "argv", "cwd", "tty", "passcode", "env"} to $STUB_LOG, "passcode" being
# the SHA-256 of the DESK_PASSCODE it was given (None without one) and "env" each environment
# variable's name with the SHA-256 of its value, so no passcode is ever written; aws and cdk read and
# write the deployed stacks' outputs in $STACKS (JSON), as CloudFormation would hold them; `security`
# answers deploy.sh's two Keychain lookups from the file $KEYCHAIN, the stored bytes, as Apple's
# SecurityTool does (keychain_find.c's do_password_item_printing and keychain_utilities.c's
# print_buffer, which never set a locale): -w writes the password alone, as lowercase hex when any
# byte fails isprint() in the C locale (space to ~); -g writes the attributes to stdout and
# `password: ` to stderr, then 0x<HEX> when any byte is outside space to ~ or is a backslash, then
# "<value>" with those bytes as octal escapes when any byte is not.
STUB = """#!{python}
import hashlib, json, os, re, sys
tool, args = os.path.basename(sys.argv[0]), sys.argv[1:]
passcode = os.environ.get("DESK_PASSCODE")
sha256 = lambda text: hashlib.sha256(text.encode(errors="surrogateescape")).hexdigest()
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps({{"tool": tool, "argv": args, "cwd": os.getcwd(), "tty": os.isatty(1),
                          "passcode": sha256(passcode) if passcode else None,
                          "env": {{name: sha256(value) for name, value in os.environ.items()}}}}) + "\\n")
if tool == "security":
    if os.environ.get("KEYCHAIN_LOCKED") or (args == {probe} and os.environ.get("KEYCHAIN_PROBE_DENIED")):
        print("security: SecKeychainSearchCopyNext: User interaction is not allowed.", file=sys.stderr)
        sys.exit(36)                              # a locked login Keychain, as over SSH or from launchd
    if args not in ({lookup}, {probe}) or not os.path.exists(os.environ["KEYCHAIN"]):
        print("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
              file=sys.stderr)
        sys.exit(44)
    stored = open(os.environ["KEYCHAIN"], "rb").read()
    if args == {lookup}:
        printable = all(0x20 <= byte <= 0x7E for byte in stored)
        sys.stdout.buffer.write((stored if printable else stored.hex().encode()) + b"\\n")
        sys.exit(0)
    print('keychain: "/Users/owner/Library/Keychains/login.keychain-db"\\nclass: "genp"\\nattributes:\\n'
          '    "svce"<blob>="claude-desk-passcode"')
    quoted = [0x20 <= byte <= 0x7E and byte != 0x5C for byte in stored]
    shown = b""
    if not all(quoted):
        shown += b"0x" + stored.hex().upper().encode() + (b"  " if any(quoted) else b" ")
    if any(quoted):
        shown += b'"' + b"".join(bytes([byte]) if ok else b"\\\\%03o" % byte for byte, ok in zip(stored, quoted)) + b'"'
    sys.stdout.flush()
    sys.stderr.buffer.write(b"password: " + shown + b"\\n")
    sys.exit(0)
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
elif tool == "npx" and args[:3] == ["--no-install", "cdk", "diff"]:
    print(f"stub: cdk security diff for {{args[3]}}", file=sys.stderr)  # cdk diff writes to stderr
    sys.exit(1 if os.environ.get("FAIL_DIFF") else 0)
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
        stacks["DeskApp"] = {{"PublicUrl": url, "ServiceEndpoint": "{endpoint}", "LoadBalancerArn": "{load_balancer}",
                             "DeployedSha": sha, "Deploys": deploys}}
        if os.environ.get("STUB_NO_LOAD_BALANCER"):
            del stacks["DeskApp"]["LoadBalancerArn"]
    json.dump(stacks, open(stacks_path, "w"))
"""


def _stub_body() -> str:
    return STUB.format(python=sys.executable, account=ACCOUNT, distribution=DISTRIBUTION_URL, endpoint=ENDPOINT,
                       load_balancer=LOAD_BALANCER, lookup=repr(KEYCHAIN_LOOKUP), probe=repr(KEYCHAIN_PROBE))


@pytest.fixture
def deploy(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    keychain_bin = tmp_path / "keychain-bin"  # the stub `security`, ahead of the real one on PATH
    keychain_bin.mkdir()
    body = _stub_body()
    for tool in ("aws", "npx", "npm", "make", "uv"):
        (bin_dir / tool).write_text(body)
        (bin_dir / tool).chmod(stat.S_IRWXU)
    (keychain_bin / "security").write_text(body)
    (keychain_bin / "security").chmod(stat.S_IRWXU)
    out = tmp_path / "out"
    stacks = tmp_path / "stacks.json"
    log = tmp_path / "stub.log"
    keychain = tmp_path / "keychain"

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

        def cdk(self, stack: str, command: str = "deploy") -> list[dict]:
            return [call for call in self.calls
                    if call["tool"] == "npx" and call["argv"][2] == command and call["argv"][3] == stack]

        def text(self) -> str:
            """Everything the run printed, logged or gave a stub on its command line."""
            return self.output + self.log + json.dumps([call["argv"] for call in self.calls])

        def smoke(self) -> list[str]:
            [call] = [call for call in self.calls if call["tool"] == "uv" and any("smoke.py" in a for a in call["argv"])]
            return call["argv"][call["argv"].index(next(a for a in call["argv"] if a.endswith("smoke.py"))) + 1:]

    def run(*args: str, typed: str = ACCOUNT, terminal: bool = True, deployed: dict | None = None,
            keychain_item: str | None = None, security: bool = True, bash_options: tuple[str, ...] = (),
            **extra_env: str) -> Run:
        """`keychain_item` is the passcode the stub Keychain holds (none by default); without
        `security`, PATH holds the stubs and only the shell and `dirname` besides; `bash_options` go
        to the bash that runs deploy.sh, before the script."""
        if deployed is not None:
            stacks.write_text(json.dumps(deployed))
        if keychain_item is not None:
            keychain.write_text(keychain_item)
        path = [bin_dir, keychain_bin, os.environ["PATH"]]
        if not security:
            basics = tmp_path / "basics"
            basics.mkdir(exist_ok=True)
            for tool in ("bash", "dirname"):
                if not (basics / tool).exists():
                    (basics / tool).symlink_to(shutil.which(tool))
            path = [bin_dir, basics]
        env = {
            "PATH": os.pathsep.join(map(str, path)),
            "HOME": os.environ.get("HOME", str(tmp_path)),
            "STUB_LOG": str(log),
            "STACKS": str(stacks),
            "KEYCHAIN": str(keychain),
            "DESK_DEPLOY_OUT": str(out),
            "DESK_PASSCODE": "deploy-test-passcode",
            "TERM": "dumb",
            **extra_env,
        }
        env = {name: value for name, value in env.items() if value is not None}
        command = ["bash", *bash_options, str(SCRIPT), *args]
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
        "aws cloudformation describe-stacks",  # LoadBalancerArn
        "uv smoke.py",
    ]
    first, second = run.cdk("DeskApp")
    assert "public_origin" not in _context(first)
    assert _context(second)["public_origin"] == DISTRIBUTION_URL
    assert run.smoke() == ["--base-url", DISTRIBUTION_URL, "--cluster", "desk",
                           "--origin-host", "desk-0a1b2c3d.ecs.us-west-2.on.aws", "--load-balancer-arn", LOAD_BALANCER]


@pytest.mark.parametrize("account", [{}, {"DESK_DEPLOY_ACCOUNT": ACCOUNT}])
def test_cdk_deploys_ask_for_approval_on_the_terminal(deploy, account):
    """At a terminal cdk keeps its approval prompt, whether or not DESK_DEPLOY_ACCOUNT is set."""
    run = deploy(**account)
    assert run.status == 0, run.output
    cdk_calls = [call for call in run.calls if call["tool"] == "npx"]
    assert cdk_calls and all(call["argv"][2] == "deploy" for call in cdk_calls)
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
    assert "--origin-host" not in run.smoke() and "--load-balancer-arn" not in run.smoke()


def test_express_mode_without_a_load_balancer_output_stops_before_smoke(deploy):
    """Without the balancer's ARN the smoke can't describe its groups, so the deploy isn't done."""
    deployed = {"DeskData": {"ClusterName": "desk"},
                "DeskApp": {"PublicUrl": DISTRIBUTION_URL, "ServiceEndpoint": ENDPOINT, "DeployedSha": "0" * 40}}
    run = deploy(deployed=deployed, STUB_NO_LOAD_BALANCER="1")
    assert run.status == 1
    assert "LoadBalancerArn" in run.log
    assert not _smoke_ran(run)


def test_allow_branch_reaches_preflight(deploy):
    run = deploy("--allow-branch")
    assert run.status == 0, run.output
    [preflight] = [call for call in run.calls if call["tool"] == "uv" and any("preflight" in a for a in call["argv"])]
    assert preflight["argv"][-1] == "--allow-branch"


def test_wrong_account_stops_before_anything_else(deploy):
    run = deploy(typed="999999999999")
    assert run.status == 1
    assert run.steps() == ["aws sts get-caller-identity"]


def test_the_deploy_account_replaces_retyping_it(deploy):
    """With DESK_DEPLOY_ACCOUNT set, the account step compares it with the credentials' account and
    asks nothing, even at a terminal: what's typed there is never read."""
    run = deploy(typed="999999999999", DESK_DEPLOY_ACCOUNT=ACCOUNT)
    assert run.status == 0, run.output
    assert "Type that account ID" not in run.output
    assert run.steps()[:2] == ["aws sts get-caller-identity", "uv preflight.py"]


@pytest.mark.parametrize("terminal", [True, False])
@pytest.mark.parametrize("args", [[], ["--data-only"]])
def test_a_deploy_account_other_than_the_credentials_is_refused_before_anything_runs(deploy, args, terminal):
    run = deploy(*args, typed=ACCOUNT, terminal=terminal, DESK_DEPLOY_ACCOUNT="999999999999")
    assert run.status == 1
    assert run.steps() == ["aws sts get-caller-identity"]
    assert f"DESK_DEPLOY_ACCOUNT is 999999999999, but the AWS credentials are for account {ACCOUNT}" in run.log
    assert "nothing was deployed" in run.log
    assert "Type that account ID" not in run.output


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


def _is_smoke(call: dict) -> bool:
    return call["tool"] == "uv" and any("smoke.py" in a for a in call["argv"])


def _smoke_ran(run) -> bool:
    return any(_is_smoke(call) for call in run.calls)


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


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@pytest.mark.parametrize("terminal", [True, False])
def test_without_an_exported_passcode_it_comes_from_the_keychain(deploy, terminal):
    """The smoke checks sign in with the passcode the Keychain holds; deploy.sh reads it, then checks
    how it's stored, before any deploy step, and gives it to smoke.py alone, never on a command line,
    the log or the output."""
    run = deploy(terminal=terminal, keychain_item="keychain-test-passcode", DESK_PASSCODE=None,
                 DESK_DEPLOY_ACCOUNT=ACCOUNT)
    assert run.status == 0, run.output
    assert run.steps()[:2] == ["security find-generic-password"] * 2
    lookups = [call["argv"] for call in run.calls if call["tool"] == "security"]
    assert lookups == [KEYCHAIN_LOOKUP, KEYCHAIN_PROBE]
    given = {call["passcode"] for call in run.calls if call["tool"] != "security" and not _is_smoke(call)}
    assert given == {None}
    [smoke] = [call for call in run.calls if _is_smoke(call)]
    assert smoke["passcode"] == _sha256("keychain-test-passcode")
    assert "keychain-test-passcode" not in run.text()


def test_an_exported_passcode_wins_over_the_keychain(deploy):
    """DESK_PASSCODE, when set, is the one the smoke checks use; the Keychain isn't read, and no
    step but smoke.py inherits it."""
    run = deploy(keychain_item="keychain-test-passcode", DESK_PASSCODE="exported-test-passcode")
    assert run.status == 0, run.output
    assert not [call for call in run.calls if call["tool"] == "security"]
    given = {call["passcode"] for call in run.calls if not _is_smoke(call)}
    assert given == {None}
    [smoke] = [call for call in run.calls if _is_smoke(call)]
    assert smoke["passcode"] == _sha256("exported-test-passcode")
    assert "exported-test-passcode" not in run.text()


def test_a_caller_variable_named_passcode_carries_the_keychain_value_to_no_step(deploy):
    """deploy.sh holds the Keychain value in a shell variable named passcode. A caller's exported
    variable of that name is dropped before the lookup, so the value reaches smoke.py alone, as
    DESK_PASSCODE, under no other name and in no other step's environment."""
    run = deploy(keychain_item="keychain-test-passcode", DESK_PASSCODE=None, DESK_DEPLOY_ACCOUNT=ACCOUNT,
                 passcode="caller-value")
    assert run.status == 0, run.output
    secret = _sha256("keychain-test-passcode")
    assert run.calls and _smoke_ran(run)
    for call in run.calls:
        holding = sorted(name for name, value in call["env"].items() if value == secret)
        assert holding == (["DESK_PASSCODE"] if _is_smoke(call) else []), (call["tool"], call["argv"][:3])
    assert "keychain-test-passcode" not in run.text()


@pytest.mark.parametrize("trace", [{"SHELLOPTS": "xtrace"}, {"bash_options": ("-x",)}], ids=["SHELLOPTS", "bash-x"])
@pytest.mark.parametrize("exported", [False, True], ids=["keychain", "exported"])
def test_a_traced_run_is_refused_before_any_passcode_is_read(deploy, trace, exported):
    """Bash's xtrace writes each assignment it runs, with its value, to the output and so to the log,
    whether the caller's shell hands it down (SHELLOPTS=xtrace) or asks for it (bash -x). deploy.sh
    refuses to start under it, before it touches an exported passcode or reads the Keychain."""
    run = deploy(terminal=False, keychain_item="keychain-test-passcode", DESK_DEPLOY_ACCOUNT=ACCOUNT,
                 DESK_PASSCODE="exported-test-passcode" if exported else None, **trace)
    assert run.status == 2      # no output in the message: traced, it would hold the passcode
    assert "deploy: run without xtrace; it would print the passcode" in run.output
    assert run.calls == []
    for secret in ("keychain-test-passcode", "exported-test-passcode"):
        assert secret not in run.text()


@pytest.mark.parametrize("locked", [False, True])
def test_a_keychain_item_that_cant_be_read_says_so_before_any_step(deploy, locked):
    """`security` fails alike when the item is missing, when the login Keychain is locked (an SSH or
    launchd session) and when access is denied, so deploy.sh says only that the item couldn't be
    read, asks after both causes, and gives the command to store it and the one to replace it."""
    lock = {"KEYCHAIN_LOCKED": "1"} if locked else {}
    run = deploy(keychain_item="keychain-test-passcode" if locked else None, DESK_PASSCODE=None,
                 DESK_DEPLOY_ACCOUNT=ACCOUNT, **lock)
    assert run.status == 2
    assert run.steps() == ["security find-generic-password"]
    assert ("the macOS Keychain item claude-desk-passcode couldn't be read "
            "(is it stored, and is the login Keychain unlocked?)") in run.output
    assert STORE_IT in run.output and REPLACE_IT in run.output
    assert "DESK_PASSCODE" in run.output                                     # the other way to give it
    assert "keychain-test-passcode" not in run.text()


def test_an_empty_keychain_item_says_so_before_any_step(deploy):
    """The item is there, so only the command that replaces it applies: storing it again would fail
    with "already exists"."""
    run = deploy(keychain_item="", DESK_PASSCODE=None, DESK_DEPLOY_ACCOUNT=ACCOUNT)
    assert run.status == 2
    assert run.steps() == ["security find-generic-password"]
    assert "the macOS Keychain item claude-desk-passcode is empty" in run.output
    assert REPLACE_IT in run.output and STORE_IT not in run.output and "DESK_PASSCODE" in run.output


def test_the_stub_security_answers_as_apples_does(tmp_path):
    """The stub writes what Apple's SecurityTool source writes for each lookup (see STUB), so the
    printable ASCII check is tested against the output the real `security` gives, never raw bytes
    -w can't return. The expected bytes are worked out by hand from that source."""
    stub = tmp_path / "security"
    stub.write_text(_stub_body())
    stub.chmod(stat.S_IRWXU)
    keychain = tmp_path / "keychain"
    env = {"STUB_LOG": str(tmp_path / "stub.log"), "KEYCHAIN": str(keychain), "STACKS": str(tmp_path / "stacks")}

    def lookup(stored: str, flag: str) -> tuple[bytes, bytes]:
        keychain.write_bytes(stored.encode())
        result = subprocess.run([str(stub), *KEYCHAIN_LOOKUP[:-1], flag], env=env, capture_output=True, check=True)
        return result.stdout, result.stderr

    assert lookup("café-pass", "-w") == (b"636166c3a92d70617373\n", b"")
    assert lookup("café-pass", "-g")[1] == b'password: 0x636166C3A92D70617373  "caf\\303\\251-pass"\n'
    assert lookup('a"b c~', "-w") == (b'a"b c~\n', b"")
    assert lookup('a"b c~', "-g")[1] == b'password: "a"b c~"\n'
    assert lookup("a\\b", "-w") == (b"a\\b\n", b"")                 # a backslash is printable: -w gives it as is
    assert lookup("a\\b", "-g")[1] == b'password: 0x615C62  "a\\134b"\n'
    assert lookup("\t\n", "-g")[1] == b"password: 0x090A \n"
    assert b'"svce"<blob>="claude-desk-passcode"' in lookup("a", "-g")[0]


@pytest.mark.parametrize("item", ["café-keychain-passcode", "tab\tkeychain-passcode", "line\nkeychain-passcode",
                                  "del\x7fkeychain-passcode", "back\\slash-keychain-passcode"])
def test_a_keychain_passcode_that_isnt_printable_ascii_is_refused_unshown_before_any_step(deploy, item):
    """docs/deploy.md asks for a printable ASCII passcode with no backslash: `security -w` hands any
    other character back as hex, which wouldn't sign in, and -g, which shows how the item is stored,
    marks a backslash the same way. Such an item is refused before any step, without being shown in
    any form, whatever the caller's locale."""
    run = deploy(keychain_item=item, DESK_PASSCODE=None, DESK_DEPLOY_ACCOUNT=ACCOUNT,
                 LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
    assert run.status == 2
    assert [call["argv"] for call in run.calls] == [KEYCHAIN_LOOKUP, KEYCHAIN_PROBE]
    assert ("the macOS Keychain item claude-desk-passcode has a character outside printable ASCII, "
            "or a backslash (it isn't shown)") in run.output
    assert REPLACE_IT in run.output and STORE_IT not in run.output     # the item is there: replace it
    secret = "keychain-passcode"
    for form in (secret, secret.encode().hex(), secret.encode().hex().upper()):
        assert form not in run.text()


def test_every_printable_ascii_character_but_the_backslash_reaches_smoke_as_stored(deploy):
    stored = "".join(chr(code) for code in range(0x20, 0x7F) if chr(code) != "\\")      # space to ~
    run = deploy(keychain_item=stored, DESK_PASSCODE=None, DESK_DEPLOY_ACCOUNT=ACCOUNT,
                 LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
    assert run.status == 0, run.output
    [smoke] = [call for call in run.calls if _is_smoke(call)]
    assert smoke["passcode"] == _sha256(stored)


def test_a_keychain_item_whose_stored_form_cant_be_read_is_refused_before_any_step(deploy):
    """The second lookup (-g), which shows how the item is stored, can fail on its own, as when access
    is denied the second time: deploy.sh then says so, before any step. The item is there, so only
    the command that replaces it applies."""
    run = deploy(keychain_item="keychain-test-passcode", DESK_PASSCODE=None, DESK_DEPLOY_ACCOUNT=ACCOUNT,
                 KEYCHAIN_PROBE_DENIED="1")
    assert run.status == 2
    assert [call["argv"] for call in run.calls] == [KEYCHAIN_LOOKUP, KEYCHAIN_PROBE]
    assert ("the macOS Keychain item claude-desk-passcode couldn't be read a second time, to check how "
            "it's stored (is the login Keychain unlocked?)") in run.output
    assert REPLACE_IT in run.output and STORE_IT not in run.output
    assert "keychain-test-passcode" not in run.text()


def test_no_security_command_says_to_export_the_passcode_before_any_step(deploy):
    """Off macOS, or with `security` missing, there's no Keychain to read: deploy.sh says so, and
    gives no Keychain command, since neither could run; DESK_PASSCODE is the way left."""
    run = deploy(security=False, DESK_PASSCODE=None, DESK_DEPLOY_ACCOUNT=ACCOUNT)
    assert run.status == 2
    assert run.calls == []
    assert "no `security` command" in run.output
    assert STORE_IT not in run.output and REPLACE_IT not in run.output
    assert "export DESK_PASSCODE for this run" in run.output


def test_unattended_without_the_deploy_account_is_refused(deploy):
    """Without a terminal nobody can retype the account ID, so DESK_DEPLOY_ACCOUNT must name it."""
    run = deploy(terminal=False)
    assert run.status == 2
    assert "run this in your own terminal: cdk deploy asks for approval there, and you retype the account ID" \
        in run.output
    assert "DESK_DEPLOY_ACCOUNT" in run.output
    assert run.calls == []


def test_unattended_with_the_deploy_account_deploys_to_the_end(deploy):
    run = deploy(terminal=False, DESK_DEPLOY_ACCOUNT=ACCOUNT)
    assert run.status == 0, run.output
    assert len(run.cdk("DeskData")) == 1 and len(run.cdk("DeskApp")) == 2
    assert _smoke_ran(run)
    assert f"deploy: done. {_head()} serves at {DISTRIBUTION_URL}" in run.log


def test_unattended_deploys_log_each_security_diff_then_deploy_without_a_prompt(deploy):
    """With no terminal for cdk's approval prompt, each `cdk deploy` is preceded by a read-only diff
    of that stack's broadened security changes, given the same stack and context, which the log
    keeps; the deploy then runs with --require-approval never."""
    run = deploy(terminal=False, DESK_DEPLOY_ACCOUNT=ACCOUNT)
    assert run.status == 0, run.output
    cdk_steps = [step for step in run.steps() if step.startswith("cdk ")]
    assert cdk_steps == ["cdk diff DeskData", "cdk deploy DeskData", "cdk diff DeskApp", "cdk deploy DeskApp",
                         "cdk diff DeskApp", "cdk deploy DeskApp"]
    calls = [call for call in run.calls if call["tool"] == "npx"]
    for diff, deployed in zip(calls[::2], calls[1::2]):
        diff_argv, deploy_argv = diff["argv"], deployed["argv"]
        assert {"--security-only", "--exclusively"} <= set(diff_argv)
        assert diff_argv[diff_argv.index("--method") + 1] == "template"      # read-only: no change set
        assert diff_argv[diff_argv.index("--fail-on") + 1] == "never"        # a diff isn't an error
        assert diff["cwd"] == str(INFRA) and _context(diff) == _context(deployed)
        assert deploy_argv[deploy_argv.index("--require-approval") + 1] == "never"
    for stack in ("DeskData", "DeskApp"):
        assert f"stub: cdk security diff for {stack}" in run.log
    assert "--require-approval never" in run.log                             # said where it applies


def test_a_failed_security_diff_stops_before_that_deploy(deploy):
    run = deploy(terminal=False, DESK_DEPLOY_ACCOUNT=ACCOUNT, FAIL_DIFF="1")
    assert run.status == 1
    assert run.cdk("DeskData", "diff") and not run.cdk("DeskData")
    assert "cdk diff DeskData failed" in run.log


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
