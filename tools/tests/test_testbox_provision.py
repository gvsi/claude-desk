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
# Fixture names for the account's deny-only inline policies; provisioning accepts them by content, never by name.
ACCOUNT_DENY = "account-guardrail-deny"
OTHER_DENY = "another-account-deny"
DENY_DOCUMENT = {"Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Action": ["secretsmanager:PutSecretValue"], "Resource": "*"}]}
POLICY = {"Version": "2012-10-17", "Statement": [{"Sid": "SessionManagerAndRunCommandOnly", "Effect": "Allow", "Action": [
    "ssm:UpdateInstanceInformation", "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage",
    "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint",
    "ec2messages:GetMessages", "ec2messages:SendReply"], "Resource": "*"}]}


class AWS:
    def __init__(self, fresh=False, fail=None, account_policies=()):
        self.fresh, self.fail, self.calls = fresh, fail, []
        self.role = {"Arn": ROLE_ARN, "RoleName": provision.NAME, "Tags": provision.TAGS}
        self.profile = {"Arn": PROFILE_ARN, "Tags": provision.TAGS, "Roles": [self.role]}
        self.attached, self.document = [], copy.deepcopy(POLICY)
        # Deny-only inline policies the account adds to every role, including one this run creates.
        self.account_policies = list(account_policies)
        self.documents = {name: copy.deepcopy(DENY_DOCUMENT) for name in account_policies}   # other inline policies
        self.inline = self.account_policies[:] if fresh else [POLICY_NAME, *self.account_policies]
        self.deleted_policies = []     # policy names delete-role-policy was called with
        self.instance = {"InstanceId": "i-0123456789abcdef0", "InstanceType": "c8g.24xlarge",
                         "IamInstanceProfile": {"Arn": PROFILE_ARN}, "MetadataOptions": {"HttpTokens": "required"},
                         "SecurityGroups": [{"GroupId": "sg-test"}], "State": {"Name": "stopped"}}

    def __call__(self, command, **kwargs):
        service, op = command[3:5]
        self.calls.append(op)
        policy_name = command[command.index("--policy-name") + 1] if "--policy-name" in command else None
        if op == "delete-role-policy":
            self.deleted_policies.append(policy_name)
        if op == self.fail:
            return SimpleNamespace(returncode=1, stderr="Injected failure", stdout="")
        data = {}
        if op == "put-role-policy":
            self.inline = [name for name in self.inline if name != POLICY_NAME] + [POLICY_NAME]
            self.document = copy.deepcopy(POLICY)
        elif op == "delete-role-policy" and policy_name in self.inline:
            self.inline.remove(policy_name)
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
            data = {"PolicyDocument": self.documents.get(policy_name, self.document)}
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
        assert POLICY_NAME not in fixture.deleted_policies
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


def test_fresh_instance_bootstraps_once_with_small_user_data(monkeypatch):
    fixture = AWS(fresh=True)
    requests = {}
    def record(command, **kwargs):
        if command[4] == 'run-instances':
            requests['user_data'] = command[command.index('--user-data') + 1]
        if command[4] == 'send-command':
            requests['payload'] = json.loads(command[command.index('--parameters') + 1])['commands'][0]
        return fixture(command, **kwargs)
    invoke(monkeypatch, record)
    assert len(requests['user_data'].encode()) < 1024
    assert 'bash /opt/testbox/bootstrap.sh' not in requests['user_data']
    payload = requests['payload']
    assert payload.index('rm -f /opt/testbox/ready') < payload.index('flock -x -w 1500 9')
    assert payload.index('flock -x -w 1500 9') < payload.index('base64 -d')
    assert 'bootstrap-version' in payload


def test_bootstrap_browser_version_matches_web_lockfile():
    import re
    root = Path(__file__).resolve().parents[2]
    bootstrap = (root / 'tools/testbox/bootstrap.sh').read_text()
    pinned = re.search(r'playwright@([0-9.]+)', bootstrap).group(1)
    locked = json.loads((root / 'web/package-lock.json').read_text())['packages']['node_modules/@playwright/test']['version']
    assert pinned == locked


def test_uv_archive_is_verified_before_extraction(tmp_path):
    import subprocess
    script = (Path(__file__).parents[1] / 'testbox/bootstrap.sh').read_text()
    start = script.index('  curl -fsSL https://github.com/astral-sh/uv/')
    end = script.index('  install -D /tmp/uv-', start)
    commands = script[start:end].replace('/tmp/testbox-uv.tar.gz', str(tmp_path / 'uv.tar.gz'))
    (tmp_path / 'bin').mkdir()
    (tmp_path / 'bin/curl').write_text('#!/bin/sh\nprintf corrupt > "$4"\n')
    (tmp_path / 'bin/curl').chmod(0o755)
    (tmp_path / 'bin/tar').write_text('#!/bin/sh\ntouch ' + str(tmp_path / 'extracted') + '\n')
    (tmp_path / 'bin/tar').chmod(0o755)
    import os
    result = subprocess.run(['bash', '-e', '-c', commands], env={**os.environ, 'PATH': str(tmp_path / 'bin') + ':' + os.environ['PATH']}, capture_output=True)
    assert result.returncode != 0
    assert not (tmp_path / 'extracted').exists()


def test_rebootstrap_restarts_postgres_only_when_configuration_changes(tmp_path):
    import os
    import subprocess
    script = (Path(__file__).parents[1] / 'testbox/bootstrap.sh').read_text()
    config = script[script.index('pg_changed=0'):script.index('# A bridge')]
    restart = script[script.index("if ! grep -q '10.200.0.0/16'"):script.index('runuser -u postgres')]
    pg = tmp_path / 'postgres'
    (pg / 'conf.d').mkdir(parents=True)
    (pg / 'pg_hba.conf').write_text('')
    log = tmp_path / 'services'
    (tmp_path / 'bin').mkdir()
    service = tmp_path / 'bin/systemctl'
    service.write_text('#!/bin/sh\necho "$*" >> ' + str(log) + '\n')
    service.chmod(0o755)
    commands = (config + restart).replace('/etc/postgresql/16/main', str(pg)).replace('/tmp/desk-testbox-postgres.conf', str(tmp_path / 'desired.conf'))
    env = {**os.environ, 'PATH': str(tmp_path / 'bin') + ':' + os.environ['PATH']}
    for _ in range(2):
        subprocess.run(['bash', '-e', '-c', commands], check=True, env=env)
    (pg / 'conf.d/testbox.conf').write_text('old configuration')
    subprocess.run(['bash', '-e', '-c', commands], check=True, env=env)
    assert log.read_text().splitlines() == ['restart postgresql', 'start postgresql', 'restart postgresql']


@pytest.mark.parametrize("args", [("--check",), ()])
def test_the_accounts_deny_only_policies_on_the_role_are_accepted_and_left_alone(monkeypatch, args):
    """Any other inline policy whose statements all deny can't grant anything, so the check accepts it beside the
    session policy, whatever its name, and neither the check nor provisioning ever removes it."""
    fixture = AWS(account_policies=[ACCOUNT_DENY, OTHER_DENY])
    invoke(monkeypatch, fixture, *args)
    assert fixture.deleted_policies == []
    assert "put-role-policy" not in fixture.calls
    assert fixture.inline == [POLICY_NAME, ACCOUNT_DENY, OTHER_DENY]


@pytest.mark.parametrize("statement", [
    {"Effect": "Allow", "Action": ["ssm:GetParameter"], "Resource": "*"},
    {"Effect": "Deny", "Action": ["s3:PutObject"], "Resource": "*"},
    "no statements",
])
def test_the_accounts_policy_is_refused_unless_every_statement_denies(monkeypatch, statement):
    fixture = AWS(account_policies=[ACCOUNT_DENY])
    document = fixture.documents[ACCOUNT_DENY]
    if statement == "no statements":
        document["Statement"] = []
    else:
        document["Statement"].append(statement)
    if statement != "no statements" and statement["Effect"] == "Deny":
        invoke(monkeypatch, fixture, "--check")      # more denials are still deny-only
    else:
        with pytest.raises(RuntimeError, match="only deny"):
            invoke(monkeypatch, fixture, "--check")
    assert fixture.deleted_policies == []


def test_rolling_back_a_created_role_removes_every_inline_policy_it_still_has_before_deleting_it(monkeypatch):
    """The account can add its deny-only policies to a role between its creation and a rollback, and delete-role
    fails while any inline policy remains, so rollback lists the role's inline policies and removes them first."""
    fixture = AWS(fresh=True, fail="describe-vpcs", account_policies=[ACCOUNT_DENY, OTHER_DENY])
    with pytest.raises(RuntimeError, match="Injected failure"):
        invoke(monkeypatch, fixture)
    assert sorted(fixture.deleted_policies) == sorted([POLICY_NAME, ACCOUNT_DENY, OTHER_DENY])
    assert fixture.inline == []
    assert fixture.calls.index("delete-role") > max(i for i, op in enumerate(fixture.calls) if op == "delete-role-policy")


def fake_tools(tmp_path, **statuses):
    """A bin directory whose commands record their arguments and exit with the given status."""
    tools = tmp_path / 'bin'
    tools.mkdir(exist_ok=True)
    for name, status in statuses.items():
        (tools / name).write_text(f'#!/bin/sh\necho "$@" >> {tmp_path / (name + "-args")}\nexit {status}\n')
        (tools / name).chmod(0o755)
    return tools


def bootstrap_header(tmp_path):
    """bootstrap.sh up to its first package step, pointed at a stand-in /opt/testbox and log."""
    script = (Path(__file__).parents[1] / 'testbox/bootstrap.sh').read_text()
    header = script[:script.index('export DEBIAN_FRONTEND')]
    (tmp_path / 'opt').mkdir()
    (tmp_path / 'opt/ready').write_text('ready\n')
    return header.replace('/var/log/desk-testbox-bootstrap.log', str(tmp_path / 'log')).replace('/opt/testbox', str(tmp_path / 'opt'))


@pytest.mark.parametrize('failure', ['step', 'drain'])
def test_a_bootstrap_that_ends_without_readiness_records_a_failed_setup(tmp_path, failure):
    """A failed step, or a drain of running lanes that runs out of time, leaves a marker, so runs stop reporting
    "bootstrapping, retry shortly" for a setup that is no longer running."""
    import os
    import subprocess
    tools = fake_tools(tmp_path, flock=1)
    script = bootstrap_header(tmp_path) + ('false\n' if failure == 'step' else '')
    env = {**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}', 'TESTBOX_BOOTSTRAP_LOCKED': '1' if failure == 'step' else '0'}
    result = subprocess.run(['bash', '-c', script], env=env, capture_output=True)
    assert result.returncode != 0
    assert not (tmp_path / 'opt/ready').exists()
    assert (tmp_path / 'opt/bootstrap-failed').exists()
    if failure == 'drain':
        assert (tmp_path / 'flock-args').read_text().split() == ['-x', '-w', '1500', '9']


def test_a_successful_bootstrap_clears_a_failed_setup_before_admitting_runs():
    script = (Path(__file__).parents[1] / 'testbox/bootstrap.sh').read_text()
    assert script.rstrip().splitlines()[-2:] == ['rm -f /opt/testbox/bootstrap-failed', "printf 'ready\\n' > /opt/testbox/ready"]


def bootstrap_payload(monkeypatch):
    payload = {}
    fixture = AWS()
    fixture.instance["State"]["Name"] = "running"
    def record(command, **kwargs):
        if command[4] == 'send-command':
            payload['text'] = json.loads(command[command.index('--parameters') + 1])['commands'][0]
        return fixture(command, **kwargs)
    invoke(monkeypatch, record)
    return payload['text']


def test_a_reprovision_that_cannot_drain_running_lanes_in_time_records_a_failed_setup(monkeypatch, tmp_path):
    """Running lanes can hold the machine lock for their whole run. The payload stops waiting within SSM's
    30-minute limit and leaves the failed-setup marker instead of an endless "bootstrapping"."""
    import os
    import subprocess
    tools = fake_tools(tmp_path, flock=1, **{'cloud-init': 0})
    opt = tmp_path / 'opt'
    opt.mkdir()
    (opt / 'ready').write_text('ready\n')
    run = subprocess.run   # invoke() patches subprocess.run for the provisioning fixture
    payload = bootstrap_payload(monkeypatch).replace('/opt/testbox', str(opt))
    result = run(['sh', '-c', payload], env={**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}'}, capture_output=True)
    assert result.returncode != 0
    assert (tmp_path / 'flock-args').read_text().split() == ['-x', '-w', '1500', '9']
    assert not (opt / 'ready').exists()
    assert (opt / 'bootstrap-failed').exists()
    assert not (opt / 'bootstrap.sh').exists()
