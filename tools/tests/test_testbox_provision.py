"""Provisioning fixtures never contact AWS or a database."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

SPEC = importlib.util.spec_from_file_location("testbox_provision", Path(__file__).parents[1] / "testbox/provision.py")
provision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provision)
ROLE_ARN = "arn:aws:iam::123456789012:role/claude-desk-test-box"
PROFILE_ARN = "arn:aws:iam::123456789012:instance-profile/claude-desk-test-box"
POLICY_NAME = "claude-desk-test-box-session"
POLICY = {"Version": "2012-10-17", "Statement": [{"Sid": "SessionManagerAndRunCommandOnly", "Effect": "Allow", "Action": [
    "ssm:UpdateInstanceInformation", "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage",
    "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint",
    "ec2messages:GetMessages", "ec2messages:SendReply"], "Resource": "*"}]}


class AWS:
    def __init__(self, fresh=False, fail=None):
        self.fresh, self.fail, self.calls = fresh, fail, []
        self.role = {"Arn": ROLE_ARN, "RoleName": provision.NAME, "Tags": provision.TAGS}
        self.profile = {"Arn": PROFILE_ARN, "Tags": provision.TAGS, "Roles": [self.role]}
        self.attached, self.inline, self.document = [], [POLICY_NAME], copy.deepcopy(POLICY)
        self.instance = {"InstanceId": "i-0123456789abcdef0", "InstanceType": "c8g.24xlarge",
                         "IamInstanceProfile": {"Arn": PROFILE_ARN}, "MetadataOptions": {"HttpTokens": "required"},
                         "SecurityGroups": [{"GroupId": "sg-test"}], "State": {"Name": "stopped"}}

    def __call__(self, command, **kwargs):
        service, op = command[3:5]
        self.calls.append(op)
        if op == self.fail:
            return SimpleNamespace(returncode=1, stderr="Injected failure", stdout="")
        data = {}
        if op == "put-role-policy":
            self.inline = [POLICY_NAME]
            self.document = copy.deepcopy(POLICY)
        if op == "get-role":
            data = {"Role": self.role}
        elif op == "get-instance-profile":
            data = {"InstanceProfile": self.profile}
        if self.fresh and op in ("get-role", "get-instance-profile"):
            return SimpleNamespace(returncode=1, stderr="NoSuchEntity", stdout="")
        if op == "create-role":
            data = {"Role": self.role}
        elif op == "create-instance-profile":
            data = {"InstanceProfile": self.profile}
        elif op == "list-attached-role-policies":
            data = {"AttachedPolicies": self.attached}
        elif op == "list-role-policies":
            data = {"PolicyNames": self.inline}
        elif op == "get-role-policy":
            data = {"PolicyDocument": self.document}
        elif op == "describe-vpcs":
            data = {"Vpcs": [{"VpcId": "vpc-test"}]}
        elif op == "describe-security-groups":
            data = {"SecurityGroups": [] if self.fresh else [{"GroupId": "sg-test", "Tags": provision.TAGS, "IpPermissions": []}]}
        elif op == "create-security-group":
            data = {"GroupId": "sg-test"}
        elif op == "describe-instances":
            data = {"Reservations": [] if self.fresh else [{"Instances": [self.instance]}]}
        elif op == "get-parameter":
            data = {"Parameter": {"Value": "ami-test"}}
        elif op == "describe-subnets":
            data = {"Subnets": [{"AvailabilityZone": "test-a", "MapPublicIpOnLaunch": True, "SubnetId": "subnet-test"}]}
        elif op == "describe-instance-type-offerings":
            data = {"InstanceTypeOfferings": [{"Location": "test-a"}]}
        elif op == "run-instances":
            data = {"Instances": [self.instance]}
        elif op == "describe-instance-information":
            data = {"InstanceInformationList": [{"PingStatus": "Online"}]}
        elif op == "send-command":
            data = {"Command": {"CommandId": "test"}}
        elif op == "get-command-invocation":
            data = {"Status": "Success"}
        return SimpleNamespace(returncode=0, stdout=json.dumps(data), stderr="")


def invoke(monkeypatch, fixture, *args):
    monkeypatch.setattr(provision.subprocess, "run", fixture)
    monkeypatch.setattr(provision.time, "sleep", lambda _: None)
    monkeypatch.setattr(sys, "argv", ["provision.py", "--region", "us-east-1", *args])
    provision.main()


@pytest.mark.parametrize("mismatch", ["missing-profile", "profile-arn", "role-name", "role-arn", "empty-roles", "managed", "extra-inline", "missing-inline", "document"])
def test_reused_instance_rejects_identity_or_policy_mismatch_before_mutation(monkeypatch, mismatch):
    fixture = AWS()
    if mismatch == "missing-profile":
        fixture.instance.pop("IamInstanceProfile")
    elif mismatch == "profile-arn":
        fixture.instance["IamInstanceProfile"]["Arn"] += "-other"
    elif mismatch == "role-name":
        fixture.profile["Roles"] = [{"RoleName": "other", "Arn": ROLE_ARN}]
    elif mismatch == "role-arn":
        fixture.profile["Roles"] = [{"RoleName": provision.NAME, "Arn": ROLE_ARN + "-other"}]
    elif mismatch == "empty-roles":
        fixture.profile["Roles"] = []
    elif mismatch == "managed":
        fixture.attached = [{"PolicyName": "AmazonSSMManagedInstanceCore", "PolicyArn": "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"}]
    elif mismatch == "extra-inline":
        fixture.inline.append("extra")
    elif mismatch == "missing-inline":
        fixture.inline = []
    elif mismatch == "document":
        fixture.document["Statement"][0]["Action"].append("ssm:GetParameter")
    with pytest.raises(RuntimeError):
        invoke(monkeypatch, fixture)
    assert not set(fixture.calls) & {"start-instances", "send-command", "modify-instance-attribute", "attach-role-policy", "put-role-policy", "add-role-to-instance-profile"}


def test_exact_session_policy_passes_read_only_live_check(monkeypatch):
    fixture = AWS()
    invoke(monkeypatch, fixture, "--check")
    assert "get-role-policy" in fixture.calls
    assert not set(fixture.calls) & {"start-instances", "send-command", "modify-instance-attribute", "put-role-policy", "add-role-to-instance-profile"}


@pytest.mark.parametrize('failure', ['get-role', 'create-role', 'put-role-policy', 'list-attached-role-policies', 'list-role-policies', 'get-role-policy', 'get-instance-profile', 'create-instance-profile', 'add-role-to-instance-profile', 'describe-vpcs', 'describe-security-groups', 'create-security-group', 'describe-instances', 'get-parameter', 'describe-subnets', 'describe-instance-type-offerings', 'run-instances', 'describe-instance-information', 'send-command', 'get-command-invocation'])
def test_partial_creation_rolls_back_every_created_resource(monkeypatch, failure):
    fixture = AWS(fresh=True, fail=failure)
    with pytest.raises(RuntimeError, match='Injected failure'):
        invoke(monkeypatch, fixture)
    calls = fixture.calls
    for create, delete in [('create-role', 'delete-role'), ('create-instance-profile', 'delete-instance-profile'), ('create-security-group', 'delete-security-group'), ('run-instances', 'terminate-instances')]:
        if create in calls and create != failure:
            assert delete in calls, (failure, calls)
    if failure == 'put-role-policy':
        assert 'delete-role-policy' not in calls
    if failure == 'add-role-to-instance-profile':
        assert 'remove-role-from-instance-profile' not in calls


def test_rollback_continues_deleting_resources_after_association_cleanup_failure(monkeypatch):
    fixture = AWS(fresh=True, fail='describe-vpcs')
    original = fixture.__call__
    def fail_cleanup(command, **kwargs):
        if command[4] in {'remove-role-from-instance-profile', 'delete-role-policy'}:
            fixture.calls.append(command[4])
            return SimpleNamespace(returncode=1, stderr='NoSuchEntity', stdout='')
        return original(command, **kwargs)
    with pytest.raises(RuntimeError, match='Injected failure'):
        invoke(monkeypatch, fail_cleanup)
    assert 'delete-instance-profile' in fixture.calls
    assert 'delete-role' in fixture.calls
