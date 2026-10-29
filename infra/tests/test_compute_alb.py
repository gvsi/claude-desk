"""The fallback compute (`-c compute=alb`): the same task as an ECS service behind an internal
load balancer, which CloudFront reaches through a VPC origin and nothing on the internet reaches."""

import pytest
from conftest import actions, build_stacks, role_statements


@pytest.fixture(scope="module")
def alb_stacks():
    return build_stacks(compute="alb")


def _outputs(template) -> set[str]:
    return set(template.find_outputs("*"))


def test_alb_mode_has_no_express_service_or_edge_lock(alb_stacks):
    template = alb_stacks.template

    assert template.find_resources("AWS::ECS::ExpressGatewayService") == {}
    assert template.find_resources("Custom::ExpressEdge") == {}
    # Nothing rewrites a load balancer or a security group after the fact: the stack declares them.
    for policy in template.find_resources("AWS::IAM::Policy").values():
        for statement in policy["Properties"]["PolicyDocument"]["Statement"]:
            for action in actions(statement):
                assert not action.startswith(("elasticloadbalancing:", "ec2:")), statement
    assert len(template.find_resources("AWS::ECS::Service")) == 1
    # The documented outputs only: the internal load balancer's name reaches no one, so neither it
    # nor a ServiceEndpoint is published.
    assert _outputs(template) == {"PublicUrl", "DistributionId", "WebBucketName", "DeployedSha"}


def _task(template) -> tuple[str, dict]:
    tasks = template.find_resources("AWS::ECS::TaskDefinition")
    assert len(tasks) == 1, sorted(tasks)
    task_id, task = next(iter(tasks.items()))
    return task_id, task["Properties"]


def _without_image(task: dict) -> dict:
    containers = []
    for container in task["ContainerDefinitions"]:
        assert "Image" in container, container["Name"]
        containers.append({key: value for key, value in container.items() if key != "Image"})
    return {**task, "ContainerDefinitions": containers}


def test_alb_mode_reuses_the_task_definition(alb_stacks, desk_stacks):
    _, alb_task = _task(alb_stacks.template)
    _, express_task = _task(desk_stacks.template)

    # The same two containers, commands, environment, secrets, health check and ordering, and the
    # same CPU, memory, platform and roles: only the compute around the task differs.
    assert [container["Name"] for container in alb_task["ContainerDefinitions"]] == ["kernel", "Main"]
    assert _without_image(alb_task) == _without_image(express_task)
    for role in ("ExecutionRoleArn", "TaskRoleArn"):
        role_id = alb_task[role]["Fn::GetAtt"][0]
        assert role_statements(alb_stacks.template, role_id) == role_statements(desk_stacks.template, role_id), role


def _only(template, kind: str) -> tuple[str, dict]:
    found = template.find_resources(kind)
    assert len(found) == 1, f"expected one {kind}, found {sorted(found)}"
    return next(iter(found.items()))


def _subnet_refs(stacks, subnet_type: str) -> list[dict]:
    subnets = stacks.data_template.find_resources("AWS::EC2::Subnet")
    return [
        {"Ref": name} for name, subnet in sorted(subnets.items())
        if {"Key": "aws-cdk:subnet-type", "Value": subnet_type} in subnet["Properties"]["Tags"]
    ]


def _api_origin(template) -> dict:
    _, distribution = _only(template, "AWS::CloudFront::Distribution")
    config = distribution["Properties"]["DistributionConfig"]
    [api] = [behavior for behavior in config["CacheBehaviors"] if behavior["PathPattern"] == "/api/*"]
    [origin] = [origin for origin in config["Origins"] if origin["Id"] == api["TargetOriginId"]]
    return origin


def test_alb_is_internal_behind_a_vpc_origin(alb_stacks):
    template = alb_stacks.template
    balancer_id, balancer = _only(template, "AWS::ElasticLoadBalancingV2::LoadBalancer")
    props = balancer["Properties"]

    assert props["Type"] == "application"
    assert props["Scheme"] == "internal"
    assert [alb_stacks.source(subnet) for subnet in props["Subnets"]] == _subnet_refs(alb_stacks, "Isolated")
    assert {"Key": "idle_timeout.timeout_seconds", "Value": "300"} in props["LoadBalancerAttributes"]

    # One listener: plain HTTP on 80, reached only through CloudFront's private connection.
    _, listener = _only(template, "AWS::ElasticLoadBalancingV2::Listener")
    assert listener["Properties"]["LoadBalancerArn"] == {"Ref": balancer_id}
    assert (listener["Properties"]["Port"], listener["Properties"]["Protocol"]) == (80, "HTTP")
    assert "Certificates" not in listener["Properties"]

    vpc_origin_id, vpc_origin = _only(template, "AWS::CloudFront::VpcOrigin")
    endpoint = vpc_origin["Properties"]["VpcOriginEndpointConfig"]
    assert endpoint["Arn"] == {"Ref": balancer_id}
    assert (endpoint["HTTPPort"], endpoint["OriginProtocolPolicy"]) == (80, "http-only")

    # The /api/* behavior's origin is that VPC origin, with the same 60 s read timeout as Express
    # mode and no custom header: the balancer's group admits CloudFront alone.
    origin = _api_origin(template)
    assert origin["VpcOriginConfig"] == {"VpcOriginId": {"Fn::GetAtt": [vpc_origin_id, "Id"]}, "OriginReadTimeout": 60}
    assert origin["DomainName"] == {"Fn::GetAtt": [balancer_id, "DNSName"]}
    assert "CustomOriginConfig" not in origin
    assert "OriginCustomHeaders" not in origin


def _rules_on(template, kind: str, group: dict) -> list[dict]:
    return [
        rule["Properties"] for rule in template.find_resources(kind).values()
        if rule["Properties"]["GroupId"] == group
    ]


def test_alb_group_admits_only_the_cloudfront_list(alb_stacks):
    template = alb_stacks.template
    _, balancer = _only(template, "AWS::ElasticLoadBalancingV2::LoadBalancer")
    group_id, group = _only(template, "AWS::EC2::SecurityGroup")
    group_ref = {"Fn::GetAtt": [group_id, "GroupId"]}
    assert balancer["Properties"]["SecurityGroups"] == [group_ref]

    # In: HTTP on 80 from CloudFront's origin-facing prefix list (DeskData's lookup), nothing else.
    assert "SecurityGroupIngress" not in group["Properties"]
    [ingress] = _rules_on(template, "AWS::EC2::SecurityGroupIngress", group_ref)
    assert alb_stacks.source(ingress["SourcePrefixListId"]) == alb_stacks.data.resolve(
        alb_stacks.data.cloudfront_prefix_list_id
    )
    assert (ingress["IpProtocol"], ingress["FromPort"], ingress["ToPort"]) == ("tcp", 80, 80)
    assert not {"CidrIp", "CidrIpv6", "SourceSecurityGroupId"} & set(ingress)

    # Out: only the API's port, inside the VPC. The rule must be inline: EC2 gives every new group
    # an allow-all egress rule, and CloudFormation removes it only for a group that declares inline
    # egress, never for one whose egress rules are all standalone resources.
    [inline] = group["Properties"]["SecurityGroupEgress"]
    assert alb_stacks.source(inline["CidrIp"]) == {"Fn::GetAtt": [alb_stacks.data_id(alb_stacks.data.vpc), "CidrBlock"]}
    assert (inline["IpProtocol"], inline["FromPort"], inline["ToPort"]) == ("tcp", 8700, 8700)
    assert not {"CidrIpv6", "DestinationPrefixListId", "DestinationSecurityGroupId"} & set(inline)
    # The service's own rule, to the app group on the same port, opens nothing more: the app
    # tasks run inside the VPC.
    [egress] = _rules_on(template, "AWS::EC2::SecurityGroupEgress", group_ref)
    assert alb_stacks.source(egress["DestinationSecurityGroupId"]) == {
        "Fn::GetAtt": [alb_stacks.data_id(alb_stacks.data.app_security_group), "GroupId"]
    }
    assert (egress["IpProtocol"], egress["FromPort"], egress["ToPort"]) == ("tcp", 8700, 8700)

    # DeskApp adds no rule to DeskData's groups: the app group's rules, the database's included,
    # never wait on the service.
    for kind in ("AWS::EC2::SecurityGroupIngress", "AWS::EC2::SecurityGroupEgress"):
        assert all(rule["Properties"]["GroupId"] == group_ref for rule in template.find_resources(kind).values()), kind


def test_alb_target_health_check(alb_stacks):
    template = alb_stacks.template
    group_id, group = _only(template, "AWS::ElasticLoadBalancingV2::TargetGroup")
    props = group["Properties"]
    _, listener = _only(template, "AWS::ElasticLoadBalancingV2::Listener")
    _, service = _only(template, "AWS::ECS::Service")

    assert listener["Properties"]["DefaultActions"] == [{"Type": "forward", "TargetGroupArn": {"Ref": group_id}}]
    # The task's own address (awsvpc), on the API's port in Main; never the kernel, which maps none.
    assert props["TargetType"] == "ip"
    assert props["Protocol"] == "HTTP"
    assert service["Properties"]["LoadBalancers"] == [
        {"ContainerName": "Main", "ContainerPort": 8700, "TargetGroupArn": {"Ref": group_id}}
    ]
    # Health is the API's, which answers 200 only while it runs; checked on the port traffic uses.
    assert props["HealthCheckPath"] == "/api/health"
    assert props["Matcher"] == {"HttpCode": "200"}
    assert props.get("HealthCheckPort", "traffic-port") == "traffic-port"


def test_alb_service_uses_the_app_group_with_a_public_ip(alb_stacks):
    template = alb_stacks.template
    task_id, _ = _task(template)
    _, service = _only(template, "AWS::ECS::Service")
    props = service["Properties"]

    assert props["TaskDefinition"] == {"Ref": task_id}
    assert alb_stacks.source(props["Cluster"]) == {"Ref": alb_stacks.data_id(alb_stacks.data.cluster)}
    assert props["LaunchType"] == "FARGATE"
    # One task, as in Express mode; a new one starts before the old one stops, and a deploy whose
    # task never turns healthy rolls back and fails the stack.
    assert props["DesiredCount"] == 1
    assert props["DeploymentConfiguration"] == {
        "DeploymentCircuitBreaker": {"Enable": True, "Rollback": True},
        "MaximumPercent": 200,
        "MinimumHealthyPercent": 100,
    }
    # The API starts only once the kernel is healthy, which may take its whole 60 s start period, so
    # ECS ignores the balancer's failed checks for the first two minutes, not the default one.
    assert props["HealthCheckGracePeriodSeconds"] == 120
    # Public subnets with a public IP, the task's only way out without NAT, and the app group,
    # which admits 8700 from the VPC only.
    network = props["NetworkConfiguration"]["AwsvpcConfiguration"]
    assert network["AssignPublicIp"] == "ENABLED"
    assert [alb_stacks.source(subnet) for subnet in network["Subnets"]] == _subnet_refs(alb_stacks, "Public")
    assert [alb_stacks.source(group) for group in network["SecurityGroups"]] == [
        {"Fn::GetAtt": [alb_stacks.data_id(alb_stacks.data.app_security_group), "GroupId"]}
    ]


def test_unknown_compute_fails_closed():
    import dataclasses

    import aws_cdk as cdk
    from conftest import APP_CONTEXT, clean_environment, make_app

    from stacks.app_stack import DeskApp
    from stacks.config import ConfigError, DeskConfig
    from stacks.data_stack import DeskData

    # DeskConfig accepts only express or alb; DeskApp still refuses anything else rather than
    # deploy a compute nobody asked for.
    with clean_environment():
        app = make_app(**APP_CONTEXT)
        config = dataclasses.replace(DeskConfig.from_app(app), compute="fargate")
        env = cdk.Environment(region="us-west-2")
        data = DeskData(app, "DeskData", config=config, env=env)
        with pytest.raises(ConfigError, match="compute fargate"):
            DeskApp(app, "DeskApp", data=data, config=config, env=env)
