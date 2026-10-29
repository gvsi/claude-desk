"""Run the one-off admin task and wait for it: migrate the database, then set the role passwords.

    uv run --project infra python infra/scripts/run_admin_task.py

deploy.sh runs this after deploying DeskData and before DeskApp, so no new app task starts on an
unmigrated database. It reads DeskData's outputs, starts the admin task definition on Fargate in
the public subnets with a public IP (the only way out without NAT) and the admin security group,
waits until the task stops, and prints the task, its log stream and the stream's last lines (the
admin command prints role names, never a password).

Exit status: 0 only when the `admin` container exited 0; 1 otherwise, the task not starting, not
stopping within 15 minutes or a missing output included.
"""

import argparse
import sys

import boto3
from botocore.exceptions import BotoCoreError, ClientError, WaiterError

REGION = "us-west-2"
STACK = "DeskData"
CONTAINER = "admin"
LOG_LINES = 30
# Polls every 6 s for up to 15 minutes: an image pull, the migrations and the role passwords.
WAIT = {"Delay": 6, "MaxAttempts": 150}
OUTPUTS = ("ClusterName", "AdminTaskDefinitionArn", "PublicSubnetIds", "AdminSecurityGroupId")


class AdminTaskError(Exception):
    """The admin task couldn't be run or didn't succeed; the message says why."""


def _clients() -> dict:
    return {name: boto3.client(name, region_name=REGION) for name in ("cloudformation", "ecs", "logs")}


def stack_outputs(cloudformation, stack: str = STACK) -> dict[str, str]:
    """DeskData's outputs, each one the admin task needs required."""
    [description] = cloudformation.describe_stacks(StackName=stack)["Stacks"]
    outputs = {item["OutputKey"]: item["OutputValue"] for item in description.get("Outputs", [])}
    missing = [name for name in OUTPUTS if not outputs.get(name)]
    if missing:
        raise AdminTaskError(f"{stack} has no output {', '.join(missing)}: deploy {stack} first")
    return outputs


def start(ecs, outputs: dict[str, str]) -> str:
    """Starts one admin task and returns its ARN."""
    response = ecs.run_task(
        cluster=outputs["ClusterName"],
        taskDefinition=outputs["AdminTaskDefinitionArn"],
        launchType="FARGATE",
        count=1,
        startedBy="desk-deploy",
        networkConfiguration={
            "awsvpcConfiguration": {
                "subnets": outputs["PublicSubnetIds"].split(","),
                "securityGroups": [outputs["AdminSecurityGroupId"]],
                "assignPublicIp": "ENABLED",
            }
        },
    )
    if response.get("failures") or not response.get("tasks"):
        reasons = "; ".join(
            f"{failure.get('reason', 'unknown')} ({failure.get('detail', failure.get('arn', ''))})"
            for failure in response.get("failures", [])
        )
        raise AdminTaskError(f"the admin task didn't start: {reasons or 'no task was placed'}")
    return response["tasks"][0]["taskArn"]


def outcome(task: dict) -> tuple[int | None, str]:
    """The admin container's exit code (None when it never exited) and why the task stopped."""
    container = next((item for item in task.get("containers", []) if item.get("name") == CONTAINER), {})
    details = [task.get("stopCode"), task.get("stoppedReason"), container.get("reason")]
    return container.get("exitCode"), ": ".join(str(detail) for detail in details if detail)


def print_logs(ecs, logs, task_definition: str, task_arn: str) -> None:
    """The admin container's log stream and its last lines, as far as they exist."""
    try:
        [definition] = [
            item for item in ecs.describe_task_definition(taskDefinition=task_definition)["taskDefinition"][
                "containerDefinitions"
            ] if item["name"] == CONTAINER
        ]
        options = definition["logConfiguration"]["options"]
        group, prefix = options["awslogs-group"], options["awslogs-stream-prefix"]
    except (BotoCoreError, ClientError, KeyError, ValueError) as error:
        print(f"no log stream: the task definition names none ({type(error).__name__})")
        return
    stream = f"{prefix}/{CONTAINER}/{task_arn.rsplit('/', 1)[-1]}"
    print(f"log stream: {group} {stream}")
    try:
        events = logs.get_log_events(logGroupName=group, logStreamName=stream, limit=LOG_LINES, startFromHead=False)
    except (BotoCoreError, ClientError) as error:
        code = error.response.get("Error", {}).get("Code") if isinstance(error, ClientError) else type(error).__name__
        print(f"no log lines ({code}): the container wrote none")
        return
    for event in events.get("events", []):
        print(f"  {event['message'].rstrip()}")


def run(clients: dict, wait: dict) -> int:
    cloudformation, ecs, logs = clients["cloudformation"], clients["ecs"], clients["logs"]
    outputs = stack_outputs(cloudformation)
    cluster, task_definition = outputs["ClusterName"], outputs["AdminTaskDefinitionArn"]
    task_arn = start(ecs, outputs)
    print(f"admin task {task_arn.rsplit('/', 1)[-1]} started in cluster {cluster}; waiting for it to stop")
    try:
        ecs.get_waiter("tasks_stopped").wait(cluster=cluster, tasks=[task_arn], WaiterConfig=wait)
    except WaiterError:
        print_logs(ecs, logs, task_definition, task_arn)
        minutes = wait["Delay"] * wait["MaxAttempts"] / 60
        raise AdminTaskError(f"the admin task {task_arn} didn't stop within {minutes:g} minutes") from None
    [task] = ecs.describe_tasks(cluster=cluster, tasks=[task_arn])["tasks"]
    print_logs(ecs, logs, task_definition, task_arn)
    exit_code, reason = outcome(task)
    if exit_code is None:
        raise AdminTaskError(f"the admin container never ran: {reason or 'no reason given'}")
    if exit_code != 0:
        raise AdminTaskError(f"the admin container failed with exit code {exit_code}")
    print("admin task exited 0: the database is at head and the roles can log in")
    return 0


def main(argv: list[str] | None = None, *, clients: dict | None = None, wait: dict | None = None) -> int:
    argparse.ArgumentParser(description="Run the one-off admin task (migrations, role passwords) and wait.").parse_args(
        argv
    )
    try:
        return run(_clients() if clients is None else clients, WAIT if wait is None else wait)
    except AdminTaskError as error:
        print(f"run_admin_task: {error}", file=sys.stderr)
    except ClientError as error:
        print(f"run_admin_task: {error.response.get('Error', {}).get('Code', 'error')}: {error}", file=sys.stderr)
    except BotoCoreError as error:
        print(f"run_admin_task: {type(error).__name__}: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
