"""image_smoke.sh: the app image run as the deploy runs it, against local Postgres. Here `docker`
and `uv` are stubs that record each call and the env files they were handed, so the test checks
what each container would get against the synthesized task definitions, without Docker."""

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import INFRA

SCRIPT = INFRA / "scripts" / "image_smoke.sh"
TEST_HOOKS = ("DESK_DECISIONS", "DESK_PROVE", "ANTHROPIC_BASE_URL")
# Made-up local passwords, as a developer's .env would hold them.
DOT_ENV = {
    "DESK_ADMIN_PASSWORD": "local-admin-6d1f",
    "KERNEL_ROLE_PASSWORD": "local-kernel-93ab",
    "API_ROLE_PASSWORD": "local-api-27ce",
    "MOCKPAY_ROLE_PASSWORD": "local-mockpay-4b80",
}
PASSCODE_HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA=="
KERNEL_IP = "172.17.0.5"
LOCAL = {"DB_HOST": "host.docker.internal", "DB_PORT": "5433", "DB_SSLMODE": "disable", "DB_NAME": "desk"}

DOCKER_STUB = """#!{python}
import json, os, stat, sys
args = sys.argv[1:]
record = {{"argv": args, "env_files": []}}
for flag, value in zip(args, args[1:]):
    if flag == "--env-file":
        with open(value) as handle:
            record["env_files"].append({{"mode": stat.S_IMODE(os.stat(value).st_mode), "lines": handle.read().splitlines()}})
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps(record) + "\\n")
fail = os.environ.get("DOCKER_FAIL", "")
if fail and fail in " ".join(args):
    sys.exit(1)
joined = " ".join(args)
if args[0] == "run" and "hash_passcode" in joined:
    print("{passcode_hash}")
elif args[0] == "run" and "-d" in args:
    print("0123456789abcdef")
elif args[0] == "inspect" and "State.Running" in joined:
    print("true")
elif args[0] == "inspect":
    print("{kernel_ip}")
elif args[0] == "exec" and "8702" in joined:
    print('{{"ok": true}}')
"""
UV_STUB = """#!/bin/sh
printf 'uv %s\\n' "$*" >> "$UV_LOG"
"""


def _container(template, name: str) -> dict:
    for definition in template.find_resources("AWS::ECS::TaskDefinition").values():
        for container in definition["Properties"]["ContainerDefinitions"]:
            if container["Name"] == name:
                return container
    raise AssertionError(f"no container {name}")


def _names(container: dict, key: str) -> set[str]:
    return {item["Name"] for item in container.get(key, [])}


@pytest.fixture
def smoke_run(tmp_path):
    """Runs image_smoke.sh with the stubs; returns (completed process, docker calls, uv calls)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(DOCKER_STUB.format(python=sys.executable, passcode_hash=PASSCODE_HASH, kernel_ip=KERNEL_IP))
    (bin_dir / "uv").write_text(UV_STUB)
    for stub in bin_dir.iterdir():
        stub.chmod(stat.S_IRWXU)
    dot_env = tmp_path / "dot.env"
    dot_env.write_text("".join(f"{name}={value}\n" for name, value in DOT_ENV.items()))
    out = tmp_path / "out"      # never the worktree's infra/out, where a real run may be writing

    def run(**extra_env: str):
        env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "HOME": os.environ.get("HOME", str(tmp_path)),
            "STUB_LOG": str(tmp_path / "docker.log"),
            "UV_LOG": str(tmp_path / "uv.log"),
            "DESK_ENV_FILE": str(dot_env),
            "IMAGE_SMOKE_POLL_SECONDS": "0",
            "IMAGE_SMOKE_OUT": str(out),
            **extra_env,
        }
        result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env, timeout=60)
        log = tmp_path / "docker.log"
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        uv_log = tmp_path / "uv.log"
        return result, calls, uv_log.read_text().splitlines() if uv_log.exists() else []

    run.out = out
    return run


def _env_runs(calls: list[dict]) -> dict[str, dict]:
    """Container name -> {"argv", "env", "mode", "path"} for each `docker run` given an env file."""
    runs = {}
    for call in calls:
        if call["argv"][0] != "run" or not call["env_files"]:
            continue
        [env_file] = call["env_files"]
        env = dict(line.split("=", 1) for line in env_file["lines"] if line)
        argv = call["argv"]
        name = argv[argv.index("--name") + 1]
        runs[name] = {"argv": argv, "env": env, "mode": env_file["mode"],
                      "path": Path(argv[argv.index("--env-file") + 1])}
    return runs


def _by_role(runs: dict[str, dict]) -> dict[str, dict]:
    roles = {}
    for name, run in runs.items():
        role = name.rsplit("-", 1)[-1]
        assert role in ("admin", "kernel", "api"), name
        roles[role] = run
    return roles


def _command(run: dict) -> list[str]:
    argv = run["argv"]
    return argv[argv.index("desk-app:dev") + 1:]


def test_image_smoke_env_covers_the_seam(smoke_run, desk_stacks):
    result, calls, uv_calls = smoke_run()
    assert result.returncode == 0, result.stdout + result.stderr
    roles = _by_role(_env_runs(calls))
    assert set(roles) == {"admin", "kernel", "api"}

    from stacks.task import API_COMMAND, KERNEL_COMMAND

    admin = _container(desk_stacks.data_template, "admin")
    kernel = _container(desk_stacks.template, "kernel")
    api = _container(desk_stacks.template, "Main")
    expected = {"admin": admin, "kernel": kernel, "api": api}
    assert _command(roles["admin"]) == admin["Command"]
    assert _command(roles["kernel"]) == KERNEL_COMMAND
    assert _command(roles["api"]) == API_COMMAND

    for role, container in expected.items():
        env = roles[role]["env"]
        assert roles[role]["mode"] == 0o600, role
        # Every plain-environment name and every secret of the seam column, nothing more but the
        # local server's DB_SSLMODE, and no test hook.
        assert set(env) == _names(container, "Environment") | _names(container, "Secrets") | {"DB_SSLMODE"}, role
        assert not set(env) & set(TEST_HOOKS), role
        for name, value in LOCAL.items():
            assert env[name] == value, (role, name)
        for item in container["Environment"]:
            if isinstance(item["Value"], str) and item["Name"] not in LOCAL:
                local = {"PUBLIC_ORIGIN": "https://localhost.invalid", "TRUSTED_PROXY_HOPS": "0"}
                assert env[item["Name"]] == local.get(item["Name"], item["Value"]), (role, item["Name"])

    assert roles["kernel"]["env"]["DESK_ENV"] == roles["api"]["env"]["DESK_ENV"] == "production"
    assert roles["admin"]["env"]["ADMIN_DB_PASSWORD"] == DOT_ENV["DESK_ADMIN_PASSWORD"]
    for prefix in ("KERNEL", "API", "MOCKPAY"):
        assert roles["admin"]["env"][f"{prefix}_ROLE_PASSWORD"] == DOT_ENV[f"{prefix}_ROLE_PASSWORD"]
    assert roles["kernel"]["env"]["KERNEL_DB_PASSWORD"] == DOT_ENV["KERNEL_ROLE_PASSWORD"]
    assert roles["kernel"]["env"]["MOCKPAY_DB_PASSWORD"] == DOT_ENV["MOCKPAY_ROLE_PASSWORD"]
    assert roles["api"]["env"]["API_DB_PASSWORD"] == DOT_ENV["API_ROLE_PASSWORD"]
    assert roles["kernel"]["env"]["ANTHROPIC_API_KEY"] == roles["api"]["env"]["ANTHROPIC_API_KEY"] == "not-a-key"
    seed, mockpay_key = roles["kernel"]["env"]["DESK_SIGNING_SEED"], roles["kernel"]["env"]["MOCKPAY_KEY"]
    assert re.fullmatch(r"[0-9a-f]{64}", seed) and re.fullmatch(r"[0-9a-f]{64}", mockpay_key) and seed != mockpay_key
    assert roles["api"]["env"]["PASSCODE_HASH"] == PASSCODE_HASH


def test_image_smoke_runs_an_init_process_where_the_task_does(smoke_run, desk_stacks):
    """Each container gets `--init` exactly when its synthesized container sets InitProcessEnabled,
    so the kernel's mock payments child runs under the same PID 1 as on ECS."""
    result, calls, _ = smoke_run()
    assert result.returncode == 0, result.stdout + result.stderr
    roles = _by_role(_env_runs(calls))
    expected = {"admin": _container(desk_stacks.data_template, "admin"),
                "kernel": _container(desk_stacks.template, "kernel"), "api": _container(desk_stacks.template, "Main")}
    assert expected["kernel"]["LinuxParameters"]["InitProcessEnabled"] is True
    for role, container in expected.items():
        argv = roles[role]["argv"]
        options = argv[:argv.index("desk-app:dev")]
        assert ("--init" in options) == container.get("LinuxParameters", {}).get("InitProcessEnabled", False), role


def test_image_smoke_runs_the_task_shape_and_prints_no_value(smoke_run):
    result, calls, uv_calls = smoke_run()
    assert result.returncode == 0, result.stdout + result.stderr
    roles = _by_role(_env_runs(calls))
    kernel_name = next(name for name in _env_runs(calls) if name.endswith("-kernel"))

    # The admin task first and in the foreground, then the kernel with the API's port published on
    # loopback only, then the API in the kernel's network namespace, as in one awsvpc task.
    order = [call["argv"][call["argv"].index("--name") + 1].rsplit("-", 1)[-1]
             for call in calls if call["argv"][0] == "run" and call["env_files"]]
    assert order == ["admin", "kernel", "api"]
    assert "-d" not in roles["admin"]["argv"] and "--rm" in roles["admin"]["argv"]
    assert "127.0.0.1:8700:8700" in roles["kernel"]["argv"]
    assert f"container:{kernel_name}" in roles["api"]["argv"]
    assert not any(arg in ("-e", "--env") for call in calls for arg in call["argv"])

    joined = "\n".join(" ".join(call["argv"]) for call in calls)
    assert "8702/provider/health" in joined and "X-Mockpay-Key" in joined  # mock payments, from inside the kernel
    assert KERNEL_IP in joined and "8701" in joined  # the kernel's port, probed from outside its namespace
    assert uv_calls and "--base-url http://localhost:8700 --only api_health" in uv_calls[-1]

    values = [value for run in roles.values() for name, value in run["env"].items()
              if name.endswith(("PASSWORD", "KEY", "SEED", "HASH"))]
    printed = result.stdout + result.stderr + joined + "\n".join(uv_calls)
    assert values and not [value for value in values if value in printed]
    assert {run["path"].parent for run in roles.values()} == {smoke_run.out}     # IMAGE_SMOKE_OUT
    assert not list(smoke_run.out.glob("image-smoke*")), "env files are deleted on exit"
    assert any(call["argv"][:2] == ["rm", "-f"] for call in calls)


def test_admin_failure_stops_before_the_app(smoke_run):
    result, calls, uv_calls = smoke_run(DOCKER_FAIL="migrate-and-roles")
    assert result.returncode != 0
    assert "admin" in result.stderr
    assert set(_by_role(_env_runs(calls))) == {"admin"}
    assert uv_calls == []
    assert not list(smoke_run.out.glob("image-smoke*"))


@pytest.mark.parametrize("missing", sorted(DOT_ENV))
def test_missing_local_password_fails_before_docker_runs(smoke_run, tmp_path, missing):
    dot_env = tmp_path / "partial.env"
    dot_env.write_text("".join(f"{name}={value}\n" for name, value in DOT_ENV.items() if name != missing))
    result, calls, _ = smoke_run(DESK_ENV_FILE=str(dot_env))
    assert result.returncode != 0 and missing in result.stderr
    assert not [call for call in calls if call["argv"][0] == "run"]
