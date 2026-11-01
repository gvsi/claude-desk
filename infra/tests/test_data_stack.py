"""DeskData: the network, the database, the generated secrets, the security groups and the
one-off admin task, as synthesized templates."""

import json
import string
from pathlib import Path

import aws_cdk as cdk
import pytest
from conftest import actions as _actions
from conftest import build_stacks
from conftest import resource_list as _resource_list
from conftest import role_statements as _statements


def _resources(template, kind: str) -> dict:
    return template.find_resources(kind)


def _tag(resource: dict, key: str) -> str | None:
    return next((tag["Value"] for tag in resource["Properties"].get("Tags", []) if tag["Key"] == key), None)


def test_vpc_has_public_and_isolated_subnets_and_no_nat(data_template):
    data_template.resource_count_is("AWS::EC2::VPC", 1)
    data_template.resource_count_is("AWS::EC2::NatGateway", 0)
    subnets = _resources(data_template, "AWS::EC2::Subnet").values()
    kinds = sorted(_tag(subnet, "aws-cdk:subnet-type") for subnet in subnets)
    assert kinds == ["Isolated", "Isolated", "Public", "Public"]
    for subnet in subnets:
        public = _tag(subnet, "aws-cdk:subnet-type") == "Public"
        assert subnet["Properties"]["MapPublicIpOnLaunch"] is public
    # The only routes out are the public subnets' default routes to the internet gateway.
    routes = _resources(data_template, "AWS::EC2::Route").values()
    assert len(routes) == 2
    assert all(set(route["Properties"]) == {"RouteTableId", "DestinationCidrBlock", "GatewayId"} for route in routes)
    assert all(route["Properties"]["DestinationCidrBlock"] == "0.0.0.0/0" for route in routes)


def _only(template, kind: str) -> tuple[str, dict]:
    found = _resources(template, kind)
    assert len(found) == 1, f"expected one {kind}, found {sorted(found)}"
    return next(iter(found.items()))


def _subnet_ids(template, subnet_type: str) -> set[str]:
    subnets = _resources(template, "AWS::EC2::Subnet")
    return {name for name, subnet in subnets.items() if _tag(subnet, "aws-cdk:subnet-type") == subnet_type}


def test_database_is_private_encrypted_postgres_16(data_template):
    _, db = _only(data_template, "AWS::RDS::DBInstance")
    props = db["Properties"]
    assert (props["Engine"], props["EngineVersion"], props["DBInstanceClass"]) == ("postgres", "16.13", "db.t4g.small")
    assert (props["AllocatedStorage"], props["StorageType"], props["StorageEncrypted"]) == ("20", "gp3", True)
    assert props["PubliclyAccessible"] is False
    assert props["MultiAZ"] is False
    assert props["BackupRetentionPeriod"] == 7
    assert props["DeletionProtection"] is True
    assert props["DBName"] == "desk"
    assert (db["DeletionPolicy"], db["UpdateReplacePolicy"]) == ("Snapshot", "Snapshot")
    _, subnet_group = _only(data_template, "AWS::RDS::DBSubnetGroup")
    assert {ref["Ref"] for ref in subnet_group["Properties"]["SubnetIds"]} == _subnet_ids(data_template, "Isolated")
    # The master user is desk_admin, read with its password from a secret generated without punctuation.
    admin_id, admin = _secret_named(data_template, "desk/db/admin")
    for field, key in (("MasterUsername", "username"), ("MasterUserPassword", "password")):
        assert props[field] == {
            "Fn::Join": ["", ["{{resolve:secretsmanager:", {"Ref": admin_id}, f":SecretString:{key}::}}}}"]]
        }
    generator = admin["Properties"]["GenerateSecretString"]
    assert generator["SecretStringTemplate"] == '{"username":"desk_admin"}'
    assert (generator["GenerateStringKey"], generator["ExcludePunctuation"]) == ("password", True)


def _secret_named(template, name: str) -> tuple[str, dict]:
    found = [
        (secret_id, secret)
        for secret_id, secret in _resources(template, "AWS::SecretsManager::Secret").items()
        if secret["Properties"].get("Name") == name
    ]
    assert len(found) == 1, f"expected one secret named {name}"
    return found[0]


def test_database_forces_tls_and_never_logs_statements(data_template):
    db_id, db = _only(data_template, "AWS::RDS::DBInstance")
    group_id, group = _only(data_template, "AWS::RDS::DBParameterGroup")
    assert db["Properties"]["DBParameterGroupName"] == {"Ref": group_id}
    assert group["Properties"]["Family"] == "postgres16"
    # Statements never reach the server log: not as they run, and not when they fail, since a
    # failing ALTER ROLE from the admin task would otherwise log its password verifier.
    assert group["Properties"]["Parameters"] == {
        "rds.force_ssl": "1",
        "log_statement": "none",
        "log_min_error_statement": "panic",
    }
    # No database log is exported to CloudWatch.
    assert "EnableCloudwatchLogsExports" not in db["Properties"]


def _logical_id(stack, construct) -> str:
    return stack.get_logical_id(construct.node.default_child)


def _ingress(template, group_id: str) -> list[dict]:
    """Every ingress rule of a security group: inline, and standalone rules naming it."""
    groups = _resources(template, "AWS::EC2::SecurityGroup")
    rules = list(groups[group_id]["Properties"].get("SecurityGroupIngress", []))
    for rule in _resources(template, "AWS::EC2::SecurityGroupIngress").values():
        if rule["Properties"]["GroupId"] == {"Fn::GetAtt": [group_id, "GroupId"]}:
            rules.append({key: value for key, value in rule["Properties"].items() if key != "GroupId"})
    return rules


def _without_description(rule: dict) -> dict:
    return {key: value for key, value in rule.items() if key != "Description"}


def test_database_ingress_only_from_app_and_admin_groups(data_stack, data_template):
    _, db = _only(data_template, "AWS::RDS::DBInstance")
    [db_group] = db["Properties"]["VPCSecurityGroups"]
    db_group_id = db_group["Fn::GetAtt"][0]
    app = _logical_id(data_stack, data_stack.app_security_group)
    admin = _logical_id(data_stack, data_stack.admin_security_group)

    rules = [_without_description(rule) for rule in _ingress(data_template, db_group_id)]

    postgres = {"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432}
    assert sorted(rules, key=str) == sorted(
        [
            {**postgres, "SourceSecurityGroupId": {"Fn::GetAtt": [app, "GroupId"]}},
            {**postgres, "SourceSecurityGroupId": {"Fn::GetAtt": [admin, "GroupId"]}},
        ],
        key=str,
    )
    assert not any("CidrIp" in rule or "CidrIpv6" in rule or "SourcePrefixListId" in rule for rule in rules)


def test_app_group_admits_8700_from_the_vpc_only(data_stack, data_template):
    app = _logical_id(data_stack, data_stack.app_security_group)
    vpc = _logical_id(data_stack, data_stack.vpc)

    rules = [_without_description(rule) for rule in _ingress(data_template, app)]

    # Load balancer traffic and health checks; the kernel's 8701 is never admitted.
    assert rules == [
        {"IpProtocol": "tcp", "FromPort": 8700, "ToPort": 8700, "CidrIp": {"Fn::GetAtt": [vpc, "CidrBlock"]}}
    ]


def test_admin_group_admits_nothing(data_stack, data_template):
    assert _ingress(data_template, _logical_id(data_stack, data_stack.admin_security_group)) == []


SECRET_NAMES = {
    "desk/db/admin",
    "desk/db/kernel",
    "desk/db/api",
    "desk/db/mockpay",
    "desk/signing-seed",
    "desk/mockpay-key",
    "desk/anthropic-api-key",
    "desk/typesafe-api-key",
    "desk/passcode-hash",
}


def test_secrets_are_generated_except_optional_disabled_placeholder(data_template):
    secrets = _resources(data_template, "AWS::SecretsManager::Secret").values()

    assert {secret["Properties"]["Name"] for secret in secrets} == SECRET_NAMES
    for secret in secrets:
        props = secret["Properties"]
        if props["Name"] == "desk/typesafe-api-key":
            assert props["SecretString"] == "unset"
            assert "GenerateSecretString" not in props
            continue
        assert "SecretString" not in props, props["Name"]
        assert "GenerateSecretString" in props, props["Name"]
        if props["Name"].startswith("desk/db/"):
            generator = props["GenerateSecretString"]
            assert generator["ExcludePunctuation"] is True
            assert generator["IncludeSpace"] is False
            assert generator["PasswordLength"] == 32


def _login(role: str) -> dict:
    return {"ExcludePunctuation": True, "GenerateStringKey": "password", "IncludeSpace": False, "PasswordLength": 32,
            "SecretStringTemplate": json.dumps({"username": role}, separators=(",", ":"))}


_HEX_64 = {"ExcludeCharacters": "ghijklmnopqrstuvwxyz", "ExcludePunctuation": True, "ExcludeUppercase": True,
           "IncludeSpace": False, "PasswordLength": 64}
_PLACEHOLDER = {"ExcludePunctuation": True, "IncludeSpace": False, "PasswordLength": 32}

# Each secret's generator exactly as first deployed. CloudFormation generates a new value when a
# generator changes, which would replace the database logins, rotate the ledger's signing seed (so
# earlier entries no longer verify) and overwrite the owner's key and passcode hash with a
# placeholder. A CDK upgrade that adds or changes a property fails here before it can do that.
GENERATORS = {
    "desk/db/admin": _login("desk_admin"),
    "desk/db/kernel": _login("desk_kernel"),
    "desk/db/api": _login("desk_api"),
    "desk/db/mockpay": _login("desk_mockpay"),
    "desk/signing-seed": _HEX_64,
    "desk/mockpay-key": _HEX_64,
    "desk/anthropic-api-key": _PLACEHOLDER,
    "desk/typesafe-api-key": {"SecretString": "unset"},
    "desk/passcode-hash": _PLACEHOLDER,
}


def test_each_secrets_generator_is_frozen(data_template):
    secrets = _resources(data_template, "AWS::SecretsManager::Secret").values()
    generators = {secret["Properties"]["Name"]: (
        {"SecretString": secret["Properties"]["SecretString"]} if "SecretString" in secret["Properties"]
        else secret["Properties"]["GenerateSecretString"]) for secret in secrets}
    assert generators == GENERATORS


def _alphabet(generator: dict) -> set[str]:
    """The characters Secrets Manager draws from under a GenerateSecretString."""
    alphabet = set(string.digits) if not generator.get("ExcludeNumbers") else set()
    if not generator.get("ExcludeLowercase"):
        alphabet |= set(string.ascii_lowercase)
    if not generator.get("ExcludeUppercase"):
        alphabet |= set(string.ascii_uppercase)
    if not generator.get("ExcludePunctuation"):
        alphabet |= set(string.punctuation)
    if generator.get("IncludeSpace"):
        alphabet.add(" ")
    return alphabet - set(generator.get("ExcludeCharacters", ""))


def test_signing_seed_and_mockpay_key_are_64_hex_and_retained(data_template):
    for name in ("desk/signing-seed", "desk/mockpay-key"):
        _, secret = _secret_named(data_template, name)
        generator = secret["Properties"]["GenerateSecretString"]
        assert "SecretStringTemplate" not in generator, name  # the whole value, not a JSON field
        assert generator["PasswordLength"] == 64, name
        assert _alphabet(generator) == set("0123456789abcdef"), name
        assert (secret["DeletionPolicy"], secret["UpdateReplacePolicy"]) == ("Retain", "Retain"), name


def test_role_secrets_name_their_roles(data_template):
    roles = {
        "desk/db/admin": "desk_admin",
        "desk/db/kernel": "desk_kernel",
        "desk/db/api": "desk_api",
        "desk/db/mockpay": "desk_mockpay",
    }
    for name, role in roles.items():
        _, secret = _secret_named(data_template, name)
        generator = secret["Properties"]["GenerateSecretString"]
        assert json.loads(generator["SecretStringTemplate"]) == {"username": role}, name
        assert generator["GenerateStringKey"] == "password", name


def _admin_task(template) -> dict:
    tasks = [
        task for task in _resources(template, "AWS::ECS::TaskDefinition").values()
        if task["Properties"]["Family"] == "desk-admin"
    ]
    assert len(tasks) == 1
    return tasks[0]["Properties"]


def test_admin_task_runs_the_seam_command(data_stack, data_template):
    task = _admin_task(data_template)
    assert task["RequiresCompatibilities"] == ["FARGATE"]
    assert task["NetworkMode"] == "awsvpc"
    assert task["RuntimePlatform"] == {"CpuArchitecture": "ARM64", "OperatingSystemFamily": "LINUX"}
    assert (task["Cpu"], task["Memory"]) == ("512", "1024")
    [container] = task["ContainerDefinitions"]
    assert container["Name"] == "admin"
    assert container["Essential"] is True
    # The image's entrypoint composes ADMIN_DATABASE_URL, then execs the command.
    assert "EntryPoint" not in container
    assert container["Command"] == ["python", "-m", "desk.ops.admin", "migrate-and-roles"]
    assert "PortMappings" not in container
    db = _logical_id(data_stack, data_stack.db)
    assert {item["Name"]: item["Value"] for item in container["Environment"]} == {
        "DESK_DB_URLS": "ADMIN",
        "ADMIN_DB_USER": "desk_admin",
        "DB_HOST": {"Fn::GetAtt": [db, "Endpoint.Address"]},
        "DB_PORT": {"Fn::GetAtt": [db, "Endpoint.Port"]},
        "DB_NAME": "desk",
    }
    assert container["LogConfiguration"]["LogDriver"] == "awslogs"
    assert container["LogConfiguration"]["Options"]["awslogs-stream-prefix"] == "admin"


def _role_id(task: dict, key: str) -> str:
    return task[key]["Fn::GetAtt"][0]


def test_admin_task_reads_only_admin_and_role_secrets(data_template):
    task = _admin_task(data_template)
    [container] = task["ContainerDefinitions"]
    secret_ids = {
        name: _secret_named(data_template, f"desk/db/{name}")[0] for name in ("admin", "kernel", "api", "mockpay")
    }
    expected = {
        "ADMIN_DB_PASSWORD": secret_ids["admin"],
        "KERNEL_ROLE_PASSWORD": secret_ids["kernel"],
        "API_ROLE_PASSWORD": secret_ids["api"],
        "MOCKPAY_ROLE_PASSWORD": secret_ids["mockpay"],
    }
    assert {item["Name"]: item["ValueFrom"] for item in container["Secrets"]} == {
        name: {"Fn::Join": ["", [{"Ref": secret_id}, ":password::"]]} for name, secret_id in expected.items()
    }

    # The execution role fetches exactly those four for the container; nothing else reads a secret.
    statements = _statements(data_template, _role_id(task, "ExecutionRoleArn"))
    read = [
        resource
        for statement in statements
        if any(action.startswith("secretsmanager:") for action in _actions(statement))
        for resource in _resource_list(statement)
    ]
    assert sorted(read, key=str) == sorted(({"Ref": secret_id} for secret_id in expected.values()), key=str)
    actions = [action for statement in statements for action in _actions(statement)]
    assert not any(action.startswith(("kms:", "s3:")) for action in actions)

    # The task role, which the admin process itself would hold, has no permissions at all.
    task_role_id = _role_id(task, "TaskRoleArn")
    assert _statements(data_template, task_role_id) == []
    assert "ManagedPolicyArns" not in _resources(data_template, "AWS::IAM::Role")[task_role_id]["Properties"]


def test_cloudfront_prefix_list_is_looked_up_at_deploy(data_stack, data_template):
    [(lookup_id, lookup)] = _resources(data_template, "Custom::AWS").items()
    for event in ("Create", "Update"):
        call = json.loads(lookup["Properties"][event])
        assert (call["service"], call["action"]) == ("EC2", "describeManagedPrefixLists")
        assert call["parameters"] == {
            "Filters": [{"Name": "prefix-list-name", "Values": ["com.amazonaws.global.cloudfront.origin-facing"]}]
        }
        assert call["outputPaths"] == ["PrefixLists.0.PrefixListId"]
    assert data_stack.resolve(data_stack.cloudfront_prefix_list_id) == {
        "Fn::GetAtt": [lookup_id, "PrefixLists.0.PrefixListId"]
    }
    # The lookup's function may describe prefix lists and write its own logs, nothing else.
    [policy] = [
        p for p in _resources(data_template, "AWS::IAM::Policy").values()
        if any("ec2:DescribeManagedPrefixLists" in _actions(s) for s in p["Properties"]["PolicyDocument"]["Statement"])
    ]
    statements = policy["Properties"]["PolicyDocument"]["Statement"]
    assert [action for statement in statements for action in _actions(statement)] == ["ec2:DescribeManagedPrefixLists"]
    [role] = policy["Properties"]["Roles"]
    [managed] = _resources(data_template, "AWS::IAM::Role")[role["Ref"]]["Properties"]["ManagedPolicyArns"]
    assert json.dumps(managed).endswith(':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]]}')


def test_synth_needs_no_credentials_or_lookups():
    from conftest import FIXTURE_CONTEXT, make_app

    from stacks.config import DeskConfig
    from stacks.data_stack import DeskData

    app = make_app(**FIXTURE_CONTEXT)
    DeskData(app, "DeskData", config=DeskConfig.from_app(app), env=cdk.Environment(region="us-west-2"))

    # A lookup (availability zones, an existing VPC) would need credentials and be listed here.
    manifest = json.loads((Path(app.synth().directory) / "manifest.json").read_text())
    assert manifest.get("missing", []) == []


def test_cluster_has_fargate_capacity_and_outputs(data_stack, data_template):
    cluster_id, cluster = _only(data_template, "AWS::ECS::Cluster")
    assert cluster["Properties"]["ClusterName"] == "desk"
    _, association = _only(data_template, "AWS::ECS::ClusterCapacityProviderAssociations")
    assert association["Properties"]["Cluster"] == {"Ref": cluster_id}
    assert set(association["Properties"]["CapacityProviders"]) == {"FARGATE", "FARGATE_SPOT"}

    # What deploy.sh and run_admin_task.py read, and what DeskApp's scripts check against.
    outputs = {name: output["Value"] for name, output in data_template.find_outputs("*").items()}
    [admin_task_id] = [
        name for name, task in _resources(data_template, "AWS::ECS::TaskDefinition").items()
        if task["Properties"]["Family"] == "desk-admin"
    ]
    public_subnets = sorted(_subnet_ids(data_template, "Public"))
    assert outputs == {
        "ClusterName": {"Ref": cluster_id},
        "AdminTaskDefinitionArn": {"Ref": admin_task_id},
        "PublicSubnetIds": {"Fn::Join": [",", [{"Ref": subnet} for subnet in public_subnets]]},
        "AdminSecurityGroupId": {"Fn::GetAtt": [_logical_id(data_stack, data_stack.admin_security_group), "GroupId"]},
        "AppSecurityGroupId": {"Fn::GetAtt": [_logical_id(data_stack, data_stack.app_security_group), "GroupId"]},
        "CloudFrontPrefixListId": data_stack.resolve(data_stack.cloudfront_prefix_list_id),
    }


@pytest.mark.parametrize("compute", ["express", "alb"])
def test_every_function_in_both_stacks_runs_on_arm64(compute):
    """"arm64 for all AWS compute": every Lambda function either stack synthesizes, the ones CDK
    adds for its own custom resources (the prefix list lookup, the default group's restriction)
    included, in both compute modes."""
    stacks = build_stacks(compute=compute)
    for template in (stacks.data_template, stacks.template):
        functions = template.find_resources("AWS::Lambda::Function")
        assert functions, template
        for function_id, function in functions.items():
            assert function["Properties"].get("Architectures") == ["arm64"], function_id
    assert len(stacks.data_template.find_resources("AWS::Lambda::Function")) == 2
