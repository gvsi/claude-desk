"""run_admin_task.py: the one-off admin task runs from DeskData's outputs in the public subnets with
a public IP and the admin group, and the deploy goes on only when its container exits 0."""

import pytest
from botocore.stub import Stubber
from conftest import load_script, unsigned_client

CLUSTER = "desk"
TASK_DEFINITION = "arn:aws:ecs:us-west-2:123456789012:task-definition/desk-admin:7"
SUBNETS = ["subnet-0a1b2c3d4e5f60718", "subnet-0f1e2d3c4b5a69788"]
ADMIN_GROUP = "sg-0a1b2c3d4e5f60718"
TASK_ID = "4f3e2d1c0b5a49687a6b5c4d3e2f1a0b"
TASK_ARN = f"arn:aws:ecs:us-west-2:123456789012:task/{CLUSTER}/{TASK_ID}"
LOG_GROUP = "DeskData-AdminLogs1A2B3C4D-AbCdEfGhIjKl"
LOG_STREAM = f"admin/admin/{TASK_ID}"
FAST = {"Delay": 1, "MaxAttempts": 2}


def _outputs(**overrides) -> list[dict]:
    values = {
        "ClusterName": CLUSTER,
        "AdminTaskDefinitionArn": TASK_DEFINITION,
        "PublicSubnetIds": ",".join(SUBNETS),
        "AdminSecurityGroupId": ADMIN_GROUP,
        "AppSecurityGroupId": "sg-0f1e2d3c4b5a69788",
        "CloudFrontPrefixListId": "pl-82a045eb",
        **overrides,
    }
    return [{"OutputKey": key, "OutputValue": value} for key, value in values.items() if value is not None]


@pytest.fixture
def aws():
    clients = {name: unsigned_client(name) for name in ("cloudformation", "ecs", "logs")}
    stubs = {name: Stubber(client) for name, client in clients.items()}
    for stub in stubs.values():
        stub.activate()
    yield clients, stubs
    for stub in stubs.values():
        stub.assert_no_pending_responses()
        stub.deactivate()


def _expect_outputs(stubs, **overrides) -> None:
    stubs["cloudformation"].add_response(
        "describe_stacks",
        {"Stacks": [{"StackName": "DeskData", "CreationTime": "2026-10-30T10:00:00Z",
                     "StackStatus": "UPDATE_COMPLETE", "Outputs": _outputs(**overrides)}]},
        {"StackName": "DeskData"},
    )


def _expect_run(stubs) -> None:
    stubs["ecs"].add_response(
        "run_task",
        {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "PROVISIONING"}], "failures": []},
        {
            "cluster": CLUSTER,
            "taskDefinition": TASK_DEFINITION,
            "launchType": "FARGATE",
            "count": 1,
            "startedBy": "desk-deploy",
            "networkConfiguration": {
                "awsvpcConfiguration": {"subnets": SUBNETS, "securityGroups": [ADMIN_GROUP], "assignPublicIp": "ENABLED"}
            },
        },
    )


def _stopped(container: dict, **task) -> dict:
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "STOPPED", "containers": [container], **task}],
            "failures": []}


def _expect_stop(stubs, container: dict, **task) -> None:
    """The waiter's poll, then the final description."""
    for _ in range(2):
        stubs["ecs"].add_response("describe_tasks", _stopped(container, **task), {"cluster": CLUSTER, "tasks": [TASK_ARN]})


def _expect_logs(stubs, lines: list[str] | None) -> None:
    stubs["ecs"].add_response(
        "describe_task_definition",
        {"taskDefinition": {"containerDefinitions": [{
            "name": "admin",
            "logConfiguration": {"logDriver": "awslogs", "options": {
                "awslogs-group": LOG_GROUP, "awslogs-stream-prefix": "admin", "awslogs-region": "us-west-2"}},
        }]}},
        {"taskDefinition": TASK_DEFINITION},
    )
    params = {"logGroupName": LOG_GROUP, "logStreamName": LOG_STREAM, "limit": 30, "startFromHead": False}
    if lines is None:
        stubs["logs"].add_client_error("get_log_events", "ResourceNotFoundException", "The specified log stream does not exist.", expected_params=params)
    else:
        events = [{"timestamp": 1793440800000 + n, "message": line} for n, line in enumerate(lines)]
        stubs["logs"].add_response("get_log_events", {"events": events}, params)


def test_runs_the_admin_task_in_public_subnets_and_waits(aws, capsys):
    clients, stubs = aws
    _expect_outputs(stubs)
    _expect_run(stubs)
    _expect_stop(stubs, {"name": "admin", "lastStatus": "STOPPED", "exitCode": 0}, stopCode="EssentialContainerExited")
    _expect_logs(stubs, ["admin: database at head 0007", "admin: desk_kernel, desk_api, desk_mockpay can log in"])

    assert load_script("run_admin_task").main([], clients=clients, wait=FAST) == 0
    out = capsys.readouterr().out
    assert TASK_ID in out and LOG_GROUP in out and LOG_STREAM in out
    assert "desk_kernel, desk_api, desk_mockpay can log in" in out
    assert "exited 0" in out


def test_nonzero_exit_fails(aws, capsys):
    clients, stubs = aws
    _expect_outputs(stubs)
    _expect_run(stubs)
    _expect_stop(stubs, {"name": "admin", "lastStatus": "STOPPED", "exitCode": 1}, stopCode="EssentialContainerExited")
    _expect_logs(stubs, ["admin: the migration failed: relation already exists"])

    assert load_script("run_admin_task").main([], clients=clients, wait=FAST) == 1
    captured = capsys.readouterr()
    assert "the migration failed" in captured.out
    assert "exit code 1" in captured.err


def test_start_failure_fails(aws, capsys):
    """run_task places no task: nothing to wait for, and the reason is printed."""
    clients, stubs = aws
    _expect_outputs(stubs)
    stubs["ecs"].add_response(
        "run_task", {"tasks": [], "failures": [{"arn": TASK_DEFINITION, "reason": "RESOURCE:ENI", "detail": "no capacity"}]}
    )

    assert load_script("run_admin_task").main([], clients=clients, wait=FAST) == 1
    assert "RESOURCE:ENI" in capsys.readouterr().err


def test_task_that_never_ran_its_container_fails(aws, capsys):
    """Stopped without an exit code (the image couldn't be pulled, a secret couldn't be read)."""
    clients, stubs = aws
    _expect_outputs(stubs)
    _expect_run(stubs)
    _expect_stop(
        stubs,
        {"name": "admin", "lastStatus": "STOPPED", "reason": "ResourceInitializationError: unable to pull secrets"},
        stopCode="TaskFailedToStart",
        stoppedReason="Task failed to start",
    )
    _expect_logs(stubs, None)

    assert load_script("run_admin_task").main([], clients=clients, wait=FAST) == 1
    captured = capsys.readouterr()
    assert "TaskFailedToStart" in captured.err and "unable to pull secrets" in captured.err
    assert "no log" in captured.out


def test_task_that_never_stops_fails(aws, capsys):
    clients, stubs = aws
    _expect_outputs(stubs)
    _expect_run(stubs)
    running = {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "RUNNING", "containers": [{"name": "admin"}]}], "failures": []}
    for _ in range(FAST["MaxAttempts"]):
        stubs["ecs"].add_response("describe_tasks", running, {"cluster": CLUSTER, "tasks": [TASK_ARN]})
    _expect_logs(stubs, ["admin: migrating"])

    assert load_script("run_admin_task").main([], clients=clients, wait=FAST) == 1
    assert "didn't stop" in capsys.readouterr().err


def test_missing_stack_output_fails_before_running(aws, capsys):
    clients, stubs = aws
    _expect_outputs(stubs, AdminSecurityGroupId=None)

    assert load_script("run_admin_task").main([], clients=clients, wait=FAST) == 1
    assert "AdminSecurityGroupId" in capsys.readouterr().err
