"""The Express Mode compute: the service runs the app task as given, and its load balancer is
locked to CloudFront by the ExpressEdge custom resource."""

import json
import os
import subprocess
import sys
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk import aws_lambda as lambda_
from conftest import actions, resource_list, role_statements

from stacks.compute_express import origin_host


def _only(template, kind: str) -> tuple[str, dict]:
    found = template.find_resources(kind)
    assert len(found) == 1, f"expected one {kind}, found {sorted(found)}"
    return next(iter(found.items()))


def _subnet_ids(stacks, subnet_type: str) -> list[str]:
    subnets = stacks.data_template.find_resources("AWS::EC2::Subnet")
    return sorted(
        name for name, subnet in subnets.items()
        if {"Key": "aws-cdk:subnet-type", "Value": subnet_type} in subnet["Properties"]["Tags"]
    )


def test_express_service_uses_the_custom_task_definition(desk_stacks):
    task_id, _ = _only(desk_stacks.template, "AWS::ECS::TaskDefinition")
    _, service = _only(desk_stacks.template, "AWS::ECS::ExpressGatewayService")
    props = service["Properties"]

    assert props["ServiceName"] == "desk"
    assert props["Cluster"] == "desk"
    assert props["TaskDefinitionArn"] == {"Ref": task_id}
    assert "InfrastructureRoleArn" in props
    # Roles, CPU and memory come from the task definition; Express builds no container of its own.
    for key in ("PrimaryContainer", "Cpu", "Memory", "ExecutionRoleArn", "TaskRoleArn"):
        assert key not in props, key
    assert props["HealthCheckPath"] == "/api/health"
    assert props["ScalingTarget"] == {"MinTaskCount": 1, "MaxTaskCount": 1}
    network = props["NetworkConfiguration"]
    # Public subnets: an internet-facing load balancer, and tasks with public IPs (there is no NAT).
    assert [desk_stacks.source(subnet) for subnet in network["Subnets"]] == [
        {"Ref": subnet} for subnet in _subnet_ids(desk_stacks, "Public")
    ]
    assert [desk_stacks.source(group) for group in network["SecurityGroups"]] == [
        {"Fn::GetAtt": [desk_stacks.data_id(desk_stacks.data.app_security_group), "GroupId"]}
    ]


def test_express_infrastructure_role(desk_stacks):
    _, service = _only(desk_stacks.template, "AWS::ECS::ExpressGatewayService")
    role_id = service["Properties"]["InfrastructureRoleArn"]["Fn::GetAtt"][0]
    role = desk_stacks.template.find_resources("AWS::IAM::Role")[role_id]["Properties"]

    assert role["AssumeRolePolicyDocument"]["Statement"] == [
        {"Action": "sts:AssumeRole", "Effect": "Allow", "Principal": {"Service": "ecs.amazonaws.com"}}
    ]
    [managed] = role["ManagedPolicyArns"]
    assert json.dumps(managed).endswith(
        ':iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"]]}'
    )
    assert role_statements(desk_stacks.template, role_id) == []


def _evaluate(value):
    """What CloudFormation makes of Fn::Select, Fn::Split and Fn::Join over literal strings."""
    if isinstance(value, str):
        return value
    [(function, args)] = value.items()
    if function == "Fn::Select":
        index, items = args
        return _evaluate(items)[index]
    if function == "Fn::Split":
        delimiter, source = args
        return _evaluate(source).split(delimiter)
    if function == "Fn::Join":
        delimiter, items = args
        items = _evaluate(items) if isinstance(items, dict) else [_evaluate(item) for item in items]
        return delimiter.join(items)
    raise AssertionError(f"unexpected {function}")


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://a.ecs.us-west-2.on.aws/",
        "https://a.ecs.us-west-2.on.aws",
        "a.ecs.us-west-2.on.aws",
        "a.ecs.us-west-2.on.aws/",
    ],
)
def test_origin_host_strips_scheme_and_path(endpoint):
    stack = cdk.Stack(cdk.App(), "Probe")

    assert _evaluate(stack.resolve(origin_host(endpoint))) == "a.ecs.us-west-2.on.aws"


def test_api_origin_is_the_service_endpoint_over_https(desk_stacks):
    stacks = desk_stacks
    service_id, _ = _only(stacks.template, "AWS::ECS::ExpressGatewayService")
    # The edge's /api/* behavior (stacks/edge.py) uses the compute's origin as bound here.
    _, distribution = _only(stacks.template, "AWS::CloudFront::Distribution")
    config = distribution["Properties"]["DistributionConfig"]
    [api] = [behavior for behavior in config["CacheBehaviors"] if behavior["PathPattern"] == "/api/*"]
    [origin] = [origin for origin in config["Origins"] if origin["Id"] == api["TargetOriginId"]]

    assert stacks.desk_app.resolve(stacks.desk_app.compute.service_endpoint) == {"Fn::GetAtt": [service_id, "Endpoint"]}
    assert origin["DomainName"] == stacks.desk_app.resolve(origin_host(stacks.desk_app.compute.service_endpoint))
    assert origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only"
    assert origin["CustomOriginConfig"]["OriginReadTimeout"] == 60
    # No secret header: only CloudFront's address range reaches the load balancer.
    assert "OriginCustomHeaders" not in origin


def _function_role(template, function: dict) -> str:
    return function["Properties"]["Role"]["Fn::GetAtt"][0]


def _functions(template) -> dict:
    return template.find_resources("AWS::Lambda::Function")


def _edge_function_ids(stacks) -> set[str]:
    return {
        stacks.desk_app.get_logical_id(child) for child in stacks.desk_app.compute.node.find_all()
        if isinstance(child, lambda_.CfnFunction)
    }


def _express_edge_handler(stacks) -> tuple[str, dict]:
    """The ExpressEdge handler, among the Express construct's own functions (the web deploy's
    function is an `index.handler` too)."""
    functions = _functions(stacks.template)
    [handler_id] = [
        function_id for function_id in _edge_function_ids(stacks)
        if functions[function_id]["Properties"]["Handler"] == "index.handler"
    ]
    return handler_id, functions[handler_id]


def test_express_edge_is_scoped(desk_stacks):
    template = desk_stacks.template
    service_id, _ = _only(template, "AWS::ECS::ExpressGatewayService")
    task_id, _ = _only(template, "AWS::ECS::TaskDefinition")
    _, edge = _only(template, "Custom::ExpressEdge")
    props = edge["Properties"]

    # The load balancer Express made for this service, and CloudFront's list from DeskData.
    assert props["LoadBalancerArn"] == {
        "Fn::GetAtt": [service_id, "ECSManagedResourceArns.IngressPath.LoadBalancerArn"]
    }
    assert desk_stacks.source(props["PrefixListId"]) == desk_stacks.data.resolve(
        desk_stacks.data.cloudfront_prefix_list_id
    )
    # A new task revision updates the service, then re-applies the lock.
    assert props["TaskDefinitionArn"] == {"Ref": task_id}
    assert set(props) == {"ServiceToken", "LoadBalancerArn", "PrefixListId", "TaskDefinitionArn"}

    _, handler = _express_edge_handler(desk_stacks)
    assert handler["Properties"]["Runtime"] == "python3.13"
    assert handler["Properties"]["Architectures"] == ["arm64"]

    statements = role_statements(template, _function_role(template, handler))
    by_action = {tuple(sorted(actions(statement))): statement for statement in statements}
    assert set(by_action) == {
        ("elasticloadbalancing:ModifyLoadBalancerAttributes",),
        ("ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"),
        ("ec2:DescribeSecurityGroups", "elasticloadbalancing:DescribeLoadBalancers"),
    }
    assert by_action[("elasticloadbalancing:ModifyLoadBalancerAttributes",)]["Resource"] == props["LoadBalancerArn"]
    ingress = by_action[("ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress")]
    assert json.dumps(ingress["Resource"]).endswith(':security-group/*"]]}')
    vpc_id = {"Ref": desk_stacks.data_id(desk_stacks.data.vpc)}
    assert list(ingress["Condition"]["ArnEquals"]) == ["ec2:Vpc"]
    *prefix, vpc = ingress["Condition"]["ArnEquals"]["ec2:Vpc"]["Fn::Join"][1]
    assert json.dumps(prefix).endswith(':vpc/"]') and desk_stacks.source(vpc) == vpc_id
    # Describe calls take no resource; nothing that changes anything is allowed on "*".
    assert by_action[("ec2:DescribeSecurityGroups", "elasticloadbalancing:DescribeLoadBalancers")]["Resource"] == "*"
    assert "Condition" not in by_action[("ec2:DescribeSecurityGroups", "elasticloadbalancing:DescribeLoadBalancers")]


READ_ONLY = ("ec2:Describe", "elasticloadbalancing:Describe", "ecr:GetAuthorizationToken")


def test_no_mutating_action_on_any_resource(desk_stacks):
    for policy in desk_stacks.template.find_resources("AWS::IAM::Policy").values():
        for statement in policy["Properties"]["PolicyDocument"]["Statement"]:
            if "*" in resource_list(statement):
                assert all(action.startswith(READ_ONLY) for action in actions(statement)), statement


def test_express_edge_runs_on_arm64(desk_stacks):
    # The handler and the provider's framework function both; "arm64 for all AWS compute".
    edge_functions = _edge_function_ids(desk_stacks)
    assert len(edge_functions) == 2, sorted(edge_functions)
    for function_id in edge_functions:
        assert _functions(desk_stacks.template)[function_id]["Properties"]["Architectures"] == ["arm64"], function_id


def test_no_database_rule_depends_on_the_service(desk_stacks):
    # DeskApp makes no security group or rule: the database admits the app group by a rule in
    # DeskData, which exists before the service and never waits on it.
    for kind in ("AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupIngress", "AWS::EC2::SecurityGroupEgress"):
        assert desk_stacks.template.find_resources(kind) == {}, kind
    data = json.dumps(desk_stacks.data_template.to_json())
    assert "DeskApp" not in data
    db_group = desk_stacks.data_id(desk_stacks.data.db_security_group)
    app_group = desk_stacks.data_id(desk_stacks.data.app_security_group)
    postgres_from_app = [
        rule for rule in desk_stacks.data_template.find_resources("AWS::EC2::SecurityGroupIngress").values()
        if rule["Properties"]["GroupId"] == {"Fn::GetAtt": [db_group, "GroupId"]}
        and rule["Properties"]["SourceSecurityGroupId"] == {"Fn::GetAtt": [app_group, "GroupId"]}
    ]
    assert [rule["Properties"]["FromPort"] for rule in postgres_from_app] == [5432]
    assert all("DependsOn" not in rule for rule in postgres_from_app)


def test_outputs_name_the_service_endpoint_and_the_deployed_commit(desk_stacks):
    service_id, _ = _only(desk_stacks.template, "AWS::ECS::ExpressGatewayService")
    outputs = {name: output["Value"] for name, output in desk_stacks.template.find_outputs("*").items()}

    # deploy.sh passes the endpoint's host to the smoke checks, which expect it to refuse connections.
    assert outputs["ServiceEndpoint"] == {"Fn::GetAtt": [service_id, "Endpoint"]}
    assert outputs["DeployedSha"] == "0123456789abcdef0123456789abcdef01234567"


def test_unbuilt_compute_fails_closed():
    from conftest import build_stacks

    from stacks.config import ConfigError

    # The fallback (an internal ALB behind a VPC origin) isn't built yet; never deploy Express instead.
    with pytest.raises(ConfigError, match="compute alb"):
        build_stacks(compute="alb")


def test_app_synthesizes_deskapp_after_deskdata_without_credentials(tmp_path):
    from conftest import APP_CONTEXT, INFRA, feature_flags

    # app.py as `cdk synth` runs it, without AWS credentials or an account.
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith(("AWS_", "CDK_", "DESK_"))
    }
    environment.update(
        CDK_OUTDIR=str(tmp_path),
        CDK_CONTEXT_JSON=json.dumps({**feature_flags(), **APP_CONTEXT}),
        AWS_CONFIG_FILE=os.devnull,
        AWS_SHARED_CREDENTIALS_FILE=os.devnull,
        AWS_EC2_METADATA_DISABLED="true",
        JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION="1",
    )
    subprocess.run([sys.executable, "app.py"], cwd=INFRA, env=environment, check=True, capture_output=True)

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest.get("missing", []) == []  # no lookup needed credentials
    stacks = {name: item for name, item in manifest["artifacts"].items() if item["type"] == "aws:cloudformation:stack"}
    assert set(stacks) == {"DeskData", "DeskApp"}
    assert "DeskData" in stacks["DeskApp"]["dependencies"]
    assert stacks["DeskApp"]["environment"] == "aws://unknown-account/us-west-2"


def test_express_edge_code_is_only_the_handler(desk_stacks):
    assembly = Path(desk_stacks.desk_app.node.root.synth().directory)
    assets = json.loads((assembly / "DeskApp.assets.json").read_text())["files"]
    _, function = _express_edge_handler(desk_stacks)
    asset = assets[function["Properties"]["Code"]["S3Key"].removesuffix(".zip")]
    assert asset["source"]["packaging"] == "zip"
    handler = assembly / asset["source"]["path"]

    # The tests import the handler, which writes bytecode beside it; never ship that.
    assert sorted(item.relative_to(handler).as_posix() for item in handler.rglob("*")) == ["index.py"]
