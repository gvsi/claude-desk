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
        self.instance = {"InstanceId": "i-0123456789abcdef0", "InstanceType": "c8g.12xlarge",
                         "IamInstanceProfile": {"Arn": PROFILE_ARN}, "MetadataOptions": {"HttpTokens": "required"},
                         "SecurityGroups": [{"GroupId": "sg-test"}], "State": {"Name": "stopped"}}
        self.standby = None            # an instance tagged as the standby, if any
        self.retired = []              # instances tagged as retired
        self.tagged = []               # (resource ids, Purpose value) per create-tags call
        self.invocation = "Success"    # the status SSM reports for a command

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
            filters = json.loads(command[command.index("--filters") + 1])
            purpose = next(f["Values"][0] for f in filters if f["Name"] == "tag:Purpose")
            found = [None if self.fresh else self.instance] if purpose == provision.ACTIVE else \
                    [self.standby] if purpose == provision.STANDBY else self.retired
            data = {"Reservations": [{"Instances": [i for i in found if i]}]}
        elif op == "create-tags":
            tags = json.loads(command[command.index("--tags") + 1])
            self.tagged.append((json.loads(command[command.index("--resources") + 1]),
                                next(t["Value"] for t in tags if t["Key"] == "Purpose")))
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
            data = {"Status": self.invocation}
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


def launched(monkeypatch, fixture, *args):
    """The run-instances request a provisioning run makes, as instance type and instance tags."""
    requests = []
    def record(command, **kwargs):
        if command[4] == 'run-instances':
            specs = json.loads(command[command.index('--tag-specifications') + 1])
            requests.append((command[command.index('--instance-type') + 1],
                             {t['Key']: t['Value'] for t in next(s for s in specs if s['ResourceType'] == 'instance')['Tags']}))
        return fixture(command, **kwargs)
    invoke(monkeypatch, record, *args)
    return requests


def test_the_test_machine_is_a_c8g_12xlarge(monkeypatch):
    assert launched(monkeypatch, AWS(fresh=True)) == [('c8g.12xlarge', {'Project': 'claude-desk', 'Purpose': 'agent-test-box', 'Name': 'claude-desk-test-box'})]


def test_a_standby_launches_beside_the_active_machine_under_a_tag_clients_never_discover(monkeypatch):
    """The active machine may be of another size: a replacement is proven before lanes move to it."""
    fixture = AWS()
    fixture.instance.update(InstanceType='c8g.24xlarge', State={'Name': 'running'})
    fixture.standby = None
    def no_standby_yet(command, **kwargs):
        result = fixture(command, **kwargs)
        if command[4] == 'run-instances':
            fixture.standby = dict(fixture.instance, InstanceId='i-0fedcba9876543210', InstanceType='c8g.12xlarge')
        return result
    requests = launched(monkeypatch, no_standby_yet, '--standby')
    assert requests == [('c8g.12xlarge', {'Project': 'claude-desk', 'Purpose': 'agent-test-box-standby', 'Name': 'claude-desk-test-box'})]
    assert fixture.tagged == []


def test_a_rerun_reuses_the_standby_and_leaves_the_active_machine_alone(monkeypatch):
    fixture = AWS()
    fixture.instance.update(InstanceType='c8g.24xlarge', State={'Name': 'running'})
    fixture.standby = dict(fixture.instance, InstanceId='i-0fedcba9876543210', InstanceType='c8g.12xlarge')
    assert launched(monkeypatch, fixture, '--standby') == []
    assert 'start-instances' not in fixture.calls and fixture.tagged == []


def machines(fixture):
    """The old c8g.24xlarge active and a proven c8g.12xlarge standby, each with its volume and network interface."""
    fixture.instance.update(InstanceType='c8g.24xlarge', State={'Name': 'running'},
                            BlockDeviceMappings=[{'Ebs': {'VolumeId': 'vol-old'}}], NetworkInterfaces=[{'NetworkInterfaceId': 'eni-old'}])
    fixture.standby = dict(fixture.instance, InstanceId='i-0fedcba9876543210', InstanceType='c8g.12xlarge',
                           BlockDeviceMappings=[{'Ebs': {'VolumeId': 'vol-new'}}], NetworkInterfaces=[{'NetworkInterfaceId': 'eni-new'}])
    handed = []
    return handed, lambda region, active, retired, api: handed.append((region, active, retired))


def test_promote_retires_the_active_machine_before_activating_the_proven_standby(monkeypatch):
    """Clients discover exactly one active machine, so the old one leaves before the new one joins: a failure
    between the two leaves none, which a re-run of the promotion repairs, never two."""
    fixture = AWS()
    handed, handover = machines(fixture)
    monkeypatch.setattr(provision, 'handover', handover)
    invoke(monkeypatch, fixture, '--promote')
    assert fixture.tagged == [(['i-0123456789abcdef0', 'vol-old', 'eni-old'], 'agent-test-box-retired'),
                              (['i-0fedcba9876543210', 'vol-new', 'eni-new'], 'agent-test-box')]
    # The old machine is known before its retag: a tag query right after it may not see the change yet.
    assert handed == [('us-east-1', 'i-0fedcba9876543210', ['i-0123456789abcdef0'])]


@pytest.mark.parametrize('interrupted', ['after-retiring', 'after-activating'])
def test_a_rerun_of_an_interrupted_promotion_finishes_the_handover(monkeypatch, interrupted):
    fixture = AWS()
    handed, handover = machines(fixture)
    old = fixture.instance
    fixture.retired, fixture.instance = [old], None
    if interrupted == 'after-activating':
        fixture.instance, fixture.standby = fixture.standby, None
    monkeypatch.setattr(provision, 'handover', handover)
    invoke(monkeypatch, fixture, '--promote')
    assert fixture.tagged == ([] if interrupted == 'after-activating' else [(['i-0fedcba9876543210', 'vol-new', 'eni-new'], 'agent-test-box')])
    assert handed == [('us-east-1', 'i-0fedcba9876543210', ['i-0123456789abcdef0'])]


def test_promote_refuses_a_standby_whose_setup_is_running_or_failed(monkeypatch):
    fixture = AWS()
    handed, handover = machines(fixture)
    fixture.invocation = 'Failed'
    monkeypatch.setattr(provision, 'handover', handover)
    with pytest.raises(RuntimeError, match="standby isn't ready"):
        invoke(monkeypatch, fixture, '--promote')
    assert fixture.tagged == [] and handed == []


class Masters:
    """This laptop's SSH masters as control sockets: `-O stop` removes one unless it is stuck, `-O check` sees it."""

    def __init__(self, stuck=False):
        self.stuck, self.stops = stuck, 0

    def __call__(self, command, **kwargs):
        socket = Path(command[command.index('-S') + 1])
        if command[command.index('-O') + 1] == 'stop':
            self.stops += 1
            if not self.stuck:
                socket.unlink()
            return SimpleNamespace(returncode=0)
        return SimpleNamespace(returncode=0 if socket.exists() else 255)


class SSM:
    """Scripts run on instances over SSM, each answered with `status`."""

    def __init__(self, status='Success'):
        self.status, self.scripts = status, []

    def __call__(self, service, operation, **params):
        if operation == 'send-command':
            self.scripts.append((params['instance_ids'][0], params['parameters']['commands'][0]))
            return {'Command': {'CommandId': 'test'}}
        return {'Status': self.status}


def handing_over(monkeypatch, tmp_path, masters, late_client=None):
    monkeypatch.setenv('HOME', str(tmp_path))
    cache = provision.cache_directory()
    cache.mkdir(parents=True)
    shared = cache / 'connection-us-east-1.json'
    shared.write_text(json.dumps({'instance': 'i-0123456789abcdef0'}))
    old = provision.control_path(cache, 'us-east-1', 'i-0123456789abcdef0')
    old.touch()                                    # every lane's warm connection to the old machine
    opened = []
    monkeypatch.setattr(provision, 'open_connection', lambda cache, region, instance, api, remember: opened.append((instance, remember)))
    monkeypatch.setattr(provision.subprocess, 'run', masters)
    sleeps = []
    def sleep(_):
        sleeps.append(1)
        if late_client and len(sleeps) == 2:
            late_client(shared, old)
    monkeypatch.setattr(provision.time, 'sleep', sleep)
    monkeypatch.setattr(provision, 'HANDOVER_SECONDS', 3)
    return shared, old, opened


def test_handover_records_the_active_machine_and_keeps_closing_a_reopened_old_connection(monkeypatch, tmp_path):
    """A call that chose the old machine just before the switch reopens its connection and records it; the handover
    window closes it again and restores the record, so later calls from any branch's client reach the new machine."""
    def late_client(shared, old):
        old.touch()
        shared.write_text(json.dumps({'instance': 'i-0123456789abcdef0'}))
    masters, ssm = Masters(), SSM()
    shared, old, opened = handing_over(monkeypatch, tmp_path, masters, late_client)
    provision.handover('us-east-1', 'i-0fedcba9876543210', [], ssm)
    assert opened == [('i-0fedcba9876543210', False)]
    assert json.loads(shared.read_text()) == {'instance': 'i-0fedcba9876543210'}
    assert not old.exists() and masters.stops == 2
    # A caller still queued behind the old connection can't reopen it later: the old machine takes no new ones.
    assert ssm.scripts == [('i-0123456789abcdef0', provision.REFUSE_NEW_CONNECTIONS)]


def test_a_retired_machine_stops_only_its_ssh_listener_so_running_calls_continue():
    assert 'KillMode=process' in provision.REFUSE_NEW_CONNECTIONS
    assert provision.REFUSE_NEW_CONNECTIONS.index('KillMode=process') < provision.REFUSE_NEW_CONNECTIONS.index('systemctl stop')


def test_handover_reports_a_retired_machine_that_still_takes_new_connections(monkeypatch, tmp_path):
    handing_over(monkeypatch, tmp_path, Masters())
    with pytest.raises(RuntimeError, match='still takes new SSH connections'):
        provision.handover('us-east-1', 'i-0fedcba9876543210', ['i-0123456789abcdef0'], SSM('Failed'))


def test_handover_reports_an_old_connection_that_will_not_stop(monkeypatch, tmp_path):
    shared, old, opened = handing_over(monkeypatch, tmp_path, Masters(stuck=True))
    with pytest.raises(RuntimeError, match='still takes calls'):
        provision.handover('us-east-1', 'i-0fedcba9876543210', ['i-0123456789abcdef0'], SSM())


@pytest.mark.parametrize('standby', [None, 'stopped', 'c8g.24xlarge', 'metadata'])
def test_promote_refuses_a_standby_that_is_missing_stopped_or_misconfigured(monkeypatch, standby):
    fixture = AWS()
    fixture.instance.update(State={'Name': 'running'})
    if standby:
        fixture.standby = dict(fixture.instance, InstanceId='i-0fedcba9876543210', State={'Name': 'running'})
        if standby == 'stopped':
            fixture.standby['State'] = {'Name': 'stopped'}
        elif standby == 'metadata':
            fixture.standby['MetadataOptions'] = {'HttpTokens': 'optional'}
        else:
            fixture.standby['InstanceType'] = standby
    monkeypatch.setattr(provision, 'handover', lambda *args: None)
    with pytest.raises(RuntimeError):
        invoke(monkeypatch, fixture, '--promote')
    assert fixture.tagged == []


def test_every_lane_on_one_shared_connection_gets_far_more_than_sshds_ten_sessions(tmp_path):
    """Lanes on a laptop share one SSH connection; sshd's default of 10 sessions on it refused new calls once a
    dozen lanes ran at once. The bootstrap raises it, reloading sshd only when the setting changes: a reload keeps
    open connections, and each new one gets the new limit. A failed check leaves nothing installed, so a retry
    checks again."""
    import os
    import re
    import subprocess
    script = (Path(__file__).parents[1] / 'testbox/bootstrap.sh').read_text()
    block = script[script.index('# Every lane on a laptop shares one SSH connection'):script.index('# This server holds only disposable test data')]
    assert 256 <= int(re.search(r'MaxSessions (\d+)', block).group(1)) <= 450   # each session holds ~2 of 1024 files
    # A laptop's connection can die while Session Manager keeps sshd's local socket open, and sshd then keeps that
    # connection's processes, and the lane locks they hold, until something kills them. sshd now closes a connection
    # whose client stops answering keepalives, within 15 minutes, but never inside the ten minutes a live connection's
    # reply may spend queued behind slow uploads.
    interval = int(re.search(r'ClientAliveInterval (\d+)', block).group(1))
    count = int(re.search(r'ClientAliveCountMax (\d+)', block).group(1))
    assert 600 <= interval * count <= 900
    assert f"grep -qx 'clientaliveinterval {interval}'" in block                # the check confirms the one in effect
    # On a fresh machine no connection has started ssh.service yet, so the check's runtime directory may be missing.
    assert block.index('install -d -o root -g root -m 0755 /run/sshd') < block.index('sshd -t')
    (tmp_path / 'bin').mkdir()
    log = tmp_path / 'services'
    effective = tmp_path / 'effective'
    (tmp_path / 'bin/systemctl').write_text('#!/bin/sh\necho "systemctl $*" >> ' + str(log) + '\n')
    (tmp_path / 'bin/sshd').write_text('#!/bin/sh\necho "sshd $*" >> ' + str(log) + '\n'
                                       'test "$1" = -T && cat ' + str(effective) + '\nexit 0\n')
    for tool in ('systemctl', 'sshd'):
        (tmp_path / 'bin' / tool).chmod(0o755)
    config = tmp_path / 'sshd_config.d'
    config.mkdir()
    commands = block.replace('/etc/ssh/sshd_config.d', str(config)).replace('/tmp/desk-testbox-sshd.conf', str(tmp_path / 'desired.conf'))
    commands = commands.replace('install -d -o root -g root -m 0755 /run/sshd', 'mkdir -p ' + str(tmp_path / 'run-sshd'))
    env = {**os.environ, 'PATH': str(tmp_path / 'bin') + ':' + os.environ['PATH']}
    run = lambda: subprocess.run(['bash', '-e', '-c', commands], env=env, capture_output=True)
    reload = ['sshd -t', 'sshd -T', 'systemctl try-reload-or-restart ssh.service']

    effective.write_text(f'maxsessions 256\nclientaliveinterval {interval}\n')
    assert run().returncode == 0 and run().returncode == 0
    assert log.read_text().splitlines() == reload                       # installed once, then left alone
    (config / '90-testbox.conf').write_text('old configuration')
    assert run().returncode == 0
    assert log.read_text().splitlines() == reload * 2                   # a changed file is checked and reloaded

    log.write_text('')
    (config / '90-testbox.conf').unlink()
    effective.write_text('maxsessions 10\n')                           # another drop-in read first wins
    assert run().returncode != 0
    assert not (config / '90-testbox.conf').exists()                    # so a retry checks again
    assert 'systemctl try-reload-or-restart ssh.service' not in log.read_text()
