"""The fallback compute (`-c compute=alb`): the same task as an ECS service behind an internal
Application Load Balancer, for when Express Mode can't run the task or re-opens its balancer.

The balancer lives in the isolated subnets with no public address, and CloudFront reaches it over
a private connection through a VPC origin, so nothing on the internet reaches it. Its security
group admits HTTP on 80 only from CloudFront's origin-facing prefix list, which AWS documents for
VPC origins. The idle timeout is part of the balancer's definition here, so no custom resource
changes anything after the fact. The task runs in the public subnets with a public IP, its only
way out without NAT; the app group admits 8700 from the VPC only.
"""

from aws_cdk import Duration
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_ec2 as ec2
from aws_cdk import aws_ecs as ecs
from aws_cdk import aws_ecs_patterns as ecs_patterns
from aws_cdk import aws_elasticloadbalancingv2 as elbv2
from constructs import Construct

from stacks.compute_express import HEALTH_CHECK_PATH, ORIGIN_READ_TIMEOUT
from stacks.data_stack import DeskData
from stacks.task import API_CONTAINER, API_PORT

LISTENER_PORT = 80
# Above the 15 s heartbeat on an open event stream, below uvicorn's 310 s keep-alive.
IDLE_TIMEOUT = Duration.seconds(300)
# The API starts only once the kernel is healthy, which may take the kernel's whole 60 s start
# period; ECS ignores the balancer's failed checks until the API has had time to start too.
HEALTH_CHECK_GRACE_PERIOD = Duration.seconds(120)


class AlbCompute(Construct):
    """`.api_origin` is what the distribution's `/api/*` behavior uses: the VPC origin on the
    internal balancer. There is no `.service_endpoint`: no address of the origin is public."""

    def __init__(self, scope: Construct, data: DeskData, task: ecs.FargateTaskDefinition) -> None:
        super().__init__(scope, "Alb")

        # Only CloudFront: HTTP on 80 from its origin-facing list, and out only to the API's port
        # inside the VPC.
        self.security_group = ec2.SecurityGroup(
            self,
            "LoadBalancerSecurityGroup",
            vpc=data.vpc,
            description="Claude Desk internal load balancer: CloudFront only",
            allow_all_outbound=False,
        )
        self.security_group.add_ingress_rule(
            ec2.Peer.prefix_list(data.cloudfront_prefix_list_id),
            ec2.Port.tcp(LISTENER_PORT),
            "HTTP from CloudFront's origin-facing addresses, through the VPC origin",
        )
        # A CIDR rule is inline on the group, which is what makes CloudFormation remove EC2's
        # default allow-all egress. The service's rule to the app group (same port, added below)
        # is a separate resource, and a group with only those keeps the default.
        self.security_group.add_egress_rule(
            ec2.Peer.ipv4(data.vpc.vpc_cidr_block),
            ec2.Port.tcp(API_PORT),
            "The API in the task, for traffic and health checks",
        )
        self.load_balancer = elbv2.ApplicationLoadBalancer(
            self,
            "LoadBalancer",
            vpc=data.vpc,
            internet_facing=False,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_ISOLATED),
            security_group=self.security_group,
            idle_timeout=IDLE_TIMEOUT,
        )

        # The balancer targets the task's default container: Main, the API, never the kernel.
        task.default_container = task.find_container(API_CONTAINER)
        # DeskData owns the app group's rules (8700 from the VPC, which holds the balancer), so no
        # rule waits on this stack; immutable here, the service adds none of its own to it.
        app_security_group = ec2.SecurityGroup.from_security_group_id(
            self, "AppSecurityGroup", data.app_security_group.security_group_id, mutable=False
        )
        self.service = ecs_patterns.ApplicationLoadBalancedFargateService(
            self,
            "Service",
            cluster=data.cluster,
            task_definition=task,
            # One task: the demo's state lives in Postgres, and the per-IP limits in one process.
            desired_count=1,
            # A new task starts before the old one stops, and a deploy whose task never turns
            # healthy rolls back to the previous one and fails the stack update.
            min_healthy_percent=100,
            max_healthy_percent=200,
            circuit_breaker=ecs.DeploymentCircuitBreaker(rollback=True),
            health_check_grace_period=HEALTH_CHECK_GRACE_PERIOD,
            task_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
            assign_public_ip=True,
            security_groups=[app_security_group],
            load_balancer=self.load_balancer,
            public_load_balancer=False,
            protocol=elbv2.ApplicationProtocol.HTTP,
            listener_port=LISTENER_PORT,
            target_protocol=elbv2.ApplicationProtocol.HTTP,
            # The group above is the only way in; never the pattern's world-open listener rule.
            open_listener=False,
        )
        self.service.target_group.configure_health_check(path=HEALTH_CHECK_PATH, healthy_http_codes="200")
        # The pattern publishes the balancer's DNS name and an http:// URL; both are internal and
        # reach no one, so DeskApp's outputs stay the documented ones.
        for output in ("LoadBalancerDNS", "ServiceURL"):
            self.service.node.try_remove_child(output)

        self.api_origin: cloudfront.IOrigin = origins.VpcOrigin.with_application_load_balancer(
            self.load_balancer,
            protocol_policy=cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            http_port=LISTENER_PORT,
            read_timeout=ORIGIN_READ_TIMEOUT,
        )
