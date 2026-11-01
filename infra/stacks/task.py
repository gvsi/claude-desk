"""The app task: two containers from one image in one Fargate arm64 task.

`kernel` runs the kernel on 127.0.0.1:8701 with no port mapping, so nothing outside the task
reaches it; it holds every business credential. `Main` runs the API on 8700 behind the load
balancer and starts only once the kernel is healthy. Both share the task's network namespace
(awsvpc), so the API reaches the kernel at 127.0.0.1. This is the "Deploy and runtime" seam in
Plan 06b: the commands, plain environment and secrets of each container.
"""

from aws_cdk import Duration, RemovalPolicy, Size
from aws_cdk import aws_ecs as ecs
from aws_cdk import aws_iam as iam
from aws_cdk import aws_logs as logs
from constructs import Construct

from stacks.config import DeskConfig
from stacks.data_stack import API_ROLE, DATABASE_NAME, KERNEL_ROLE, MOCKPAY_ROLE, DeskData, DeskSecrets
from stacks.image import desk_image

# Express Mode routes to the one named port of the container called Main; the fallback targets it too.
API_CONTAINER = "Main"
API_PORT = 8700
API_PORT_NAME = "api"
# The seam's commands; the image's entrypoint composes each container's database URLs first.
KERNEL_COMMAND = ["python", "-m", "desk.kernel_service"]
API_COMMAND = [
    "uvicorn", "--factory", "desk.api.main:app_factory",
    "--host", "0.0.0.0", "--port", str(API_PORT),
    # Above the load balancer's 300 s idle timeout, so the balancer, not uvicorn, closes idle
    # connections and never sends a request down one uvicorn has just closed.
    "--timeout-keep-alive", "310",
    # No access log: a request path can carry a single-use token (a document link, /api/d/{token}),
    # which would otherwise reach the api log stream.
    "--no-access-log",
]
KERNEL_URL = "http://127.0.0.1:8701"
KERNEL_HEALTH_URL = f"{KERNEL_URL}/health"
# CloudFront appends the viewer's address to X-Forwarded-For and the load balancer appends
# CloudFront's, so the viewer is the second entry from the right; only CloudFront reaches the
# origin, so that entry can't be forged.
TRUSTED_PROXY_HOPS = "2"
# Exits 0 only when the kernel answers 200 within 2 s: any other status, an error status (raised
# by urlopen), a refused connection or a timeout ends in a non-zero exit. The image has no curl.
KERNEL_HEALTH_CHECK = (
    "import sys, urllib.request; "
    f"sys.exit(0 if urllib.request.urlopen('{KERNEL_HEALTH_URL}', timeout=2).status == 200 else 1)"
)


def desk_task_definition(scope: Construct, data: DeskData, config: DeskConfig) -> ecs.FargateTaskDefinition:
    """The task both compute modes run (Express Mode, or the fallback ALB service)."""
    # ECS pulls the image, writes the logs and fetches each container's secrets with the execution
    # role (the managed policy, plus a read grant per secret below). The processes themselves get
    # the task role, which holds nothing: every credential arrives as a container secret.
    execution_role = iam.Role(
        scope,
        "TaskExecutionRole",
        assumed_by=iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        description="Claude Desk app task: image pull, logs and the app's secrets",
        managed_policies=[
            iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AmazonECSTaskExecutionRolePolicy")
        ],
    )
    task_role = iam.Role(
        scope,
        "TaskRole",
        assumed_by=iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        description="Claude Desk app task processes: no permissions",
    )
    task = ecs.FargateTaskDefinition(
        scope,
        "Task",
        family="desk",
        cpu=1024,
        memory_limit_mib=2048,
        execution_role=execution_role,
        task_role=task_role,
        runtime_platform=ecs.RuntimePlatform(
            cpu_architecture=ecs.CpuArchitecture.ARM64,
            operating_system_family=ecs.OperatingSystemFamily.LINUX,
        ),
    )
    image = desk_image(scope, config)
    log_group = logs.LogGroup(
        scope, "TaskLogs", retention=logs.RetentionDays.TWO_WEEKS, removal_policy=RemovalPolicy.DESTROY
    )

    # The entrypoint composes <P>_DATABASE_URL for each prefix P in DESK_DB_URLS from these parts,
    # P_DB_USER and the P_DB_PASSWORD secret. Production mode: the kernel refuses to start with a
    # test hook set or without its signing seed, and /health reports the proof mode.
    database = {
        "DB_HOST": data.db.db_instance_endpoint_address,
        "DB_PORT": data.db.db_instance_endpoint_port,
        "DB_NAME": DATABASE_NAME,
    }
    kernel = task.add_container(
        "kernel",
        container_name="kernel",
        image=image,
        essential=True,
        command=KERNEL_COMMAND,
        environment={
            "DESK_ENV": "production",
            "DESK_DB_URLS": "KERNEL,MOCKPAY",
            "KERNEL_DB_USER": KERNEL_ROLE,
            "MOCKPAY_DB_USER": MOCKPAY_ROLE,
            **database,
        },
        secrets=_kernel_secrets(data.secrets),
        health_check=ecs.HealthCheck(
            command=["CMD", "python", "-c", KERNEL_HEALTH_CHECK],
            interval=Duration.seconds(15),
            timeout=Duration.seconds(5),
            retries=3,
            start_period=Duration.seconds(60),
        ),
        # The kernel starts the mock payments server as a child process; an init process
        # forwards signals to it and reaps it.
        linux_parameters=ecs.LinuxParameters(scope, "KernelLinux", init_process_enabled=True),
        logging=_logs(log_group, "kernel"),
    )
    api = task.add_container(
        API_CONTAINER,
        container_name=API_CONTAINER,
        image=image,
        essential=True,
        command=API_COMMAND,
        environment={
            "DESK_ENV": "production",
            "DESK_DB_URLS": "API",
            "API_DB_USER": API_ROLE,
            **database,
            "KERNEL_URL": KERNEL_URL,
            # Every absolute link the API builds starts here; no request header sets it.
            "PUBLIC_ORIGIN": config.public_origin,
            "TRUSTED_PROXY_HOPS": TRUSTED_PROXY_HOPS,
            # Setup's proposal cards carry block configurations, so an accepted job becomes a business tool.
            "BUSINESS_TOOLS_ENABLED": "1",
        },
        secrets=_api_secrets(data.secrets),
        port_mappings=[ecs.PortMapping(container_port=API_PORT, name=API_PORT_NAME, protocol=ecs.Protocol.TCP)],
        linux_parameters=ecs.LinuxParameters(scope, "ApiLinux", init_process_enabled=True),
        logging=_logs(log_group, "api"),
    )
    # The API starts only once the kernel answers its health check, and an unhealthy kernel
    # (both are essential) replaces the task.
    api.add_container_dependencies(
        ecs.ContainerDependency(container=kernel, condition=ecs.ContainerDependencyCondition.HEALTHY)
    )
    # A load balancer targets the default container, which would otherwise be the first essential
    # one added: the kernel, which maps no port.
    task.default_container = api
    return task


def _kernel_secrets(secrets: DeskSecrets) -> dict[str, ecs.Secret]:
    """The kernel's database logins (its own and mock payments'), the ledger's signing seed, the
    Anthropic and TypeSafe keys for its reply checks and the mock payments key: every business credential."""
    return {
        "KERNEL_DB_PASSWORD": ecs.Secret.from_secrets_manager(secrets.kernel_db, "password"),
        "MOCKPAY_DB_PASSWORD": ecs.Secret.from_secrets_manager(secrets.mockpay_db, "password"),
        "DESK_SIGNING_SEED": ecs.Secret.from_secrets_manager(secrets.signing_seed),
        "ANTHROPIC_API_KEY": ecs.Secret.from_secrets_manager(secrets.anthropic),
        "TYPESAFE_API_KEY": ecs.Secret.from_secrets_manager(secrets.typesafe),
        "MOCKPAY_KEY": ecs.Secret.from_secrets_manager(secrets.mockpay_key),
    }


def _api_secrets(secrets: DeskSecrets) -> dict[str, ecs.Secret]:
    """The API's own database login, the Anthropic key and the demo passcode's hash; no business
    credential."""
    return {
        "API_DB_PASSWORD": ecs.Secret.from_secrets_manager(secrets.api_db, "password"),
        "ANTHROPIC_API_KEY": ecs.Secret.from_secrets_manager(secrets.anthropic),
        "PASSCODE_HASH": ecs.Secret.from_secrets_manager(secrets.passcode_hash),
    }


def _logs(log_group: logs.ILogGroup, prefix: str) -> ecs.LogDriver:
    """Per-container streams in the task's log group; non-blocking, so a slow log write never
    stalls a request, with Express Mode's default buffer so a burst isn't dropped."""
    return ecs.LogDrivers.aws_logs(
        stream_prefix=prefix,
        log_group=log_group,
        mode=ecs.AwsLogDriverMode.NON_BLOCKING,
        max_buffer_size=Size.mebibytes(25),
    )
