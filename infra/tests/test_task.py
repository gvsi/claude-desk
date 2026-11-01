"""The app task: the kernel as a local-only sidecar beside the API (`Main`), one image, each
container with only its own secrets (the "Deploy and runtime" seam), as DeskApp synthesizes it."""

import json
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import actions, resource_list, role_statements


def _task(stacks) -> dict:
    tasks = stacks.template.find_resources("AWS::ECS::TaskDefinition")
    assert len(tasks) == 1, sorted(tasks)
    return next(iter(tasks.values()))["Properties"]


def test_task_is_arm64_fargate_awsvpc(desk_stacks):
    task = _task(desk_stacks)

    assert task["RequiresCompatibilities"] == ["FARGATE"]
    assert task["NetworkMode"] == "awsvpc"
    assert task["RuntimePlatform"] == {"CpuArchitecture": "ARM64", "OperatingSystemFamily": "LINUX"}
    assert (task["Cpu"], task["Memory"]) == ("1024", "2048")
    assert [container["Name"] for container in task["ContainerDefinitions"]] == ["kernel", "Main"]


def _container(stacks, name: str) -> dict:
    [container] = [item for item in _task(stacks)["ContainerDefinitions"] if item["Name"] == name]
    return container


API_COMMAND = [
    "uvicorn", "--factory", "desk.api.main:app_factory",
    "--host", "0.0.0.0", "--port", "8700",
    # Above the load balancer's 300 s idle timeout, so the balancer always closes first.
    "--timeout-keep-alive", "310",
    # No access log: a request path can carry a single-use token (a document link, /api/d/{token}),
    # and the log stream is readable by anyone with CloudWatch read access.
    "--no-access-log",
]


def test_main_is_the_api_with_one_named_port(desk_stacks):
    main = _container(desk_stacks, "Main")

    assert main["Essential"] is True
    # Express Mode routes to the one named port of the container called Main.
    assert main["PortMappings"] == [{"ContainerPort": 8700, "Name": "api", "Protocol": "tcp"}]
    # The image's entrypoint composes API_DATABASE_URL, then execs the seam's command.
    assert "EntryPoint" not in main
    assert main["Command"] == API_COMMAND
    assert main["DependsOn"] == [{"ContainerName": "kernel", "Condition": "HEALTHY"}]
    assert main["LinuxParameters"]["InitProcessEnabled"] is True
    assert main["LogConfiguration"]["Options"]["awslogs-stream-prefix"] == "api"


def test_main_is_the_default_container(desk_stacks):
    # A load balancer integration targets the task's default container, which would otherwise be
    # the first essential one added: the kernel, which maps no port and must never be a target.
    # The task sets it, so no compute has to change the task it is given.
    assert desk_stacks.desk_app.task_definition.default_container.container_name == "Main"


def test_kernel_sidecar_has_no_port_and_a_local_health_check(desk_stacks):
    kernel = _container(desk_stacks, "kernel")

    assert kernel["Essential"] is True
    # No port mapping: the kernel binds 127.0.0.1:8701, reachable only inside the task.
    assert "PortMappings" not in kernel
    assert "EntryPoint" not in kernel
    assert kernel["Command"] == ["python", "-m", "desk.kernel_service"]
    check = kernel["HealthCheck"]
    assert (check["Interval"], check["Timeout"], check["Retries"], check["StartPeriod"]) == (15, 5, 3, 60)
    assert check["Command"][:3] == ["CMD", "python", "-c"]
    assert "http://127.0.0.1:8701/health" in check["Command"][3]
    # The kernel starts the mock payments server as a child; an init process reaps it.
    assert kernel["LinuxParameters"]["InitProcessEnabled"] is True
    assert kernel["LogConfiguration"]["Options"]["awslogs-stream-prefix"] == "kernel"
    assert kernel["LogConfiguration"]["Options"]["mode"] == "non-blocking"


class _Health(BaseHTTPRequestHandler):
    """Answers /health with the status in the server's `status`, after its `delay` seconds."""

    def do_GET(self):  # noqa: N802 (http.server's name)
        threading.Event().wait(self.server.delay)
        self.send_response(self.server.status)
        self.end_headers()

    def log_message(self, *args):
        pass


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False  # a slow answer never holds up the test once it has its result


def _run_health_check(command: list[str], url: str) -> int:
    """The container's health check, run here with its URL pointed at `url`."""
    script = command[3].replace("http://127.0.0.1:8701/health", url)
    return subprocess.run([sys.executable, "-c", script], capture_output=True, timeout=10).returncode


@pytest.mark.parametrize(
    ("status", "delay", "healthy"),
    [(200, 0, True), (204, 0, False), (503, 0, False), (200, 3, False)],
    ids=["200", "204", "503", "slower-than-2s"],
)
def test_kernel_health_check_passes_only_on_a_prompt_200(desk_stacks, status, delay, healthy):
    command = _container(desk_stacks, "kernel")["HealthCheck"]["Command"]
    server = _Server(("127.0.0.1", 0), _Health)
    server.status, server.delay = status, delay
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        code = _run_health_check(command, f"http://127.0.0.1:{server.server_port}/health")
    finally:
        server.shutdown()
        server.server_close()

    assert (code == 0) is healthy


def test_kernel_health_check_fails_when_nothing_listens(desk_stacks):
    command = _container(desk_stacks, "kernel")["HealthCheck"]["Command"]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    # The port was free a moment ago and nothing listens on it now: the connection is refused.

    assert _run_health_check(command, f"http://127.0.0.1:{port}/health") != 0


def _secret_name(stacks, logical_id: str) -> str:
    return stacks.data_template.to_json()["Resources"][logical_id]["Properties"]["Name"]


def _secret_ref(stacks, value) -> tuple[str, str | None]:
    """A container secret's `ValueFrom` as (DeskData secret name, JSON field or None)."""
    field = None
    if isinstance(value, dict) and "Fn::Join" in value:
        separator, (arn, suffix) = value["Fn::Join"]
        assert separator == "" and suffix.startswith(":") and suffix.endswith("::"), value
        value, field = arn, suffix[1:-2]
    source = stacks.source(value)
    assert set(source) == {"Ref"}, source
    return _secret_name(stacks, source["Ref"]), field


# The seam's "ECS secrets" row: each container gets only its own.
SEAM_SECRETS = {
    "kernel": {
        "KERNEL_DB_PASSWORD": ("desk/db/kernel", "password"),
        "MOCKPAY_DB_PASSWORD": ("desk/db/mockpay", "password"),
        "DESK_SIGNING_SEED": ("desk/signing-seed", None),
        "ANTHROPIC_API_KEY": ("desk/anthropic-api-key", None),
        "TYPESAFE_API_KEY": ("desk/typesafe-api-key", None),
        "MOCKPAY_KEY": ("desk/mockpay-key", None),
    },
    "Main": {
        "API_DB_PASSWORD": ("desk/db/api", "password"),
        "ANTHROPIC_API_KEY": ("desk/anthropic-api-key", None),
        "PASSCODE_HASH": ("desk/passcode-hash", None),
    },
}


def test_secrets_split_by_container(desk_stacks):
    for name, expected in SEAM_SECRETS.items():
        container = _container(desk_stacks, name)
        secrets = {item["Name"]: _secret_ref(desk_stacks, item["ValueFrom"]) for item in container["Secrets"]}

        assert secrets == expected, name


def _environment(stacks, name: str) -> dict:
    return {item["Name"]: stacks.source(item["Value"]) for item in _container(stacks, name).get("Environment", [])}


def test_plain_environment_is_the_seam(desk_stacks):
    db = desk_stacks.data_id(desk_stacks.data.db)
    database = {
        "DB_HOST": {"Fn::GetAtt": [db, "Endpoint.Address"]},
        "DB_PORT": {"Fn::GetAtt": [db, "Endpoint.Port"]},
        "DB_NAME": "desk",
    }

    assert _environment(desk_stacks, "kernel") == {
        "DESK_ENV": "production",
        "DESK_DB_URLS": "KERNEL,MOCKPAY",
        "KERNEL_DB_USER": "desk_kernel",
        "MOCKPAY_DB_USER": "desk_mockpay",
        **database,
    }
    assert _environment(desk_stacks, "Main") == {
        "DESK_ENV": "production",
        "DESK_DB_URLS": "API",
        "API_DB_USER": "desk_api",
        **database,
        "KERNEL_URL": "http://127.0.0.1:8701",
        "PUBLIC_ORIGIN": "https://d111111abcdef8.cloudfront.net",
        "TRUSTED_PROXY_HOPS": "2",
        "BUSINESS_TOOLS_ENABLED": "1",
    }


SECRET_SUFFIXES = ("_PASSWORD", "_KEY", "_SEED", "_HASH", "_DATABASE_URL")
# Set only by tests and local runs; in production the kernel refuses to start with any of them.
TEST_HOOKS = ("DESK_DECISIONS", "DESK_PROVE", "ANTHROPIC_BASE_URL")


def test_no_secret_in_plain_environment(desk_stacks):
    for name in ("kernel", "Main"):
        environment = _environment(desk_stacks, name)
        assert environment, name
        assert not [key for key in environment if key.endswith(SECRET_SUFFIXES)], name


def test_both_containers_run_in_production_mode(desk_stacks):
    for name in ("kernel", "Main"):
        container = _container(desk_stacks, name)
        assert _environment(desk_stacks, name)["DESK_ENV"] == "production", name
        names = [item["Name"] for item in container.get("Environment", []) + container.get("Secrets", [])]
        assert not set(names) & set(TEST_HOOKS), name


def test_api_gets_public_origin_and_proxy_hops():
    from conftest import build_stacks

    stacks = build_stacks(
        domain_name="desk.example.com",
        certificate_arn="arn:aws:acm:us-east-1:123456789012:certificate/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
    )

    environment = _environment(stacks, "Main")
    assert stacks.config.public_origin == "https://desk.example.com"
    assert environment["PUBLIC_ORIGIN"] == stacks.config.public_origin
    assert environment["TRUSTED_PROXY_HOPS"] == "2"
    # The kernel builds no links and sees no client address.
    assert not {"PUBLIC_ORIGIN", "TRUSTED_PROXY_HOPS"} & set(_environment(stacks, "kernel"))


def _role_id(task: dict, key: str) -> str:
    return task[key]["Fn::GetAtt"][0]


def test_task_role_has_no_policies(desk_stacks):
    task_role_id = _role_id(_task(desk_stacks), "TaskRoleArn")
    role = desk_stacks.template.find_resources("AWS::IAM::Role")[task_role_id]["Properties"]

    # What the processes themselves hold: nothing. Credentials arrive as container secrets.
    assert role_statements(desk_stacks.template, task_role_id) == []
    assert "ManagedPolicyArns" not in role
    assert role["AssumeRolePolicyDocument"]["Statement"] == [
        {"Action": "sts:AssumeRole", "Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"}}
    ]


APP_SECRETS = {
    "desk/db/kernel", "desk/db/api", "desk/db/mockpay", "desk/signing-seed", "desk/mockpay-key",
    "desk/anthropic-api-key", "desk/typesafe-api-key", "desk/passcode-hash",
}


def test_execution_role_reads_only_the_app_secrets(desk_stacks):
    execution_role_id = _role_id(_task(desk_stacks), "ExecutionRoleArn")
    role = desk_stacks.template.find_resources("AWS::IAM::Role")[execution_role_id]["Properties"]
    statements = role_statements(desk_stacks.template, execution_role_id)

    # ECS pulls the image, writes the logs and fetches each container's secrets with this role.
    [managed] = role["ManagedPolicyArns"]
    assert json.dumps(managed).endswith(':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]]}')
    read = [
        stacks_source["Ref"]
        for statement in statements
        if any(action.startswith("secretsmanager:") for action in actions(statement))
        for stacks_source in (desk_stacks.source(resource) for resource in resource_list(statement))
    ]
    names = [_secret_name(desk_stacks, secret_id) for secret_id in read]
    assert sorted(names) == sorted(APP_SECRETS)  # each once; never desk/db/admin
    for statement in statements:
        if any(action.startswith("secretsmanager:") for action in actions(statement)):
            assert sorted(actions(statement)) == ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    every_action = [action for statement in statements for action in actions(statement)]
    assert not any(action.startswith(("kms:", "s3:")) for action in every_action)


def test_both_containers_log_to_the_task_group_without_blocking(desk_stacks):
    log_groups = desk_stacks.template.find_resources("AWS::Logs::LogGroup")
    for name, prefix in (("kernel", "kernel"), ("Main", "api")):
        options = _container(desk_stacks, name)["LogConfiguration"]["Options"]
        # A slow log write never stalls a request; Express Mode's own buffer size (25 MiB, in bytes),
        # so a burst isn't dropped.
        assert (options["mode"], options["max-buffer-size"]) == ("non-blocking", f"{25 * 2**20}b"), name
        assert options["awslogs-stream-prefix"] == prefix
        assert log_groups[options["awslogs-group"]["Ref"]]["Properties"]["RetentionInDays"] == 14
