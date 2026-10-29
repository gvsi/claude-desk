"""Express Mode compute: the app task as an ECS Express Mode service.

Express runs the task definition as given (the `Main` container's one named port, roles, CPU and
memory from the task) and manages an internet-facing ALB in the public subnets, with HTTPS on 443
and a host-header rule for the service's own endpoint. Its API takes no idle timeout or ingress
setting, so the ExpressEdge custom resource sets both on the ALB after Express creates it (changes
made outside Express persist unless an Express update conflicts). CloudFront reaches the service
at that endpoint over HTTPS.
"""

from aws_cdk import CustomResource, Duration, Fn, Stack
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_ecs as ecs
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import custom_resources as cr
from constructs import Construct

from stacks.config import INFRA_DIR
from stacks.data_stack import CLUSTER_NAME, DeskData

SERVICE_NAME = "desk"
HEALTH_CHECK_PATH = "/api/health"
# Long enough for /api/owner/policy/*'s answer, a 202 with a poll after 25 s.
ORIGIN_READ_TIMEOUT = Duration.seconds(60)
EXPRESS_EDGE_CODE = INFRA_DIR / "functions" / "express_edge"


def origin_host(endpoint: str) -> str:
    """The endpoint's host, whether Express gives it with a scheme, a trailing slash, or bare.
    Evaluated by CloudFormation, since the endpoint is known only once the service exists."""
    return Fn.select(0, Fn.split("/", Fn.join("", Fn.split("https://", endpoint))))


class ExpressCompute(Construct):
    """`.api_origin` is what the distribution's `/api/*` behavior uses; `.service_endpoint` is the
    service's own address, which the smoke checks expect to refuse direct connections."""

    def __init__(self, scope: Construct, data: DeskData, task: ecs.FargateTaskDefinition) -> None:
        super().__init__(scope, "Express")

        # Assumed by ECS to create and manage the load balancer, target groups, listener rules,
        # certificate, scaling and alarms for the service.
        infrastructure_role = iam.Role(
            self,
            "InfrastructureRole",
            assumed_by=iam.ServicePrincipal("ecs.amazonaws.com"),
            description="ECS Express Mode infrastructure for the Claude Desk service",
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name(
                    "service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
                )
            ],
        )
        self.service = ecs.CfnExpressGatewayService(
            self,
            "Service",
            service_name=SERVICE_NAME,
            cluster=CLUSTER_NAME,
            task_definition_arn=task.task_definition_arn,
            infrastructure_role_arn=infrastructure_role.role_arn,
            health_check_path=HEALTH_CHECK_PATH,
            # One task: the demo's state lives in Postgres, and the per-IP limits in one process.
            scaling_target=ecs.CfnExpressGatewayService.ExpressGatewayScalingTargetProperty(
                min_task_count=1, max_task_count=1
            ),
            # Public subnets: Express makes the load balancer internet-facing and gives tasks public
            # IPs, their only way out without NAT. The app group admits 8700 from the VPC only.
            network_configuration=ecs.CfnExpressGatewayService.ExpressGatewayServiceNetworkConfigurationProperty(
                subnets=[subnet.subnet_id for subnet in data.vpc.public_subnets],
                security_groups=[data.app_security_group.security_group_id],
            ),
        )

        self.load_balancer_arn: str = self.service.attr_ecs_managed_resource_arns_ingress_path_load_balancer_arn
        self.edge_lock = self._edge_lock(data, task)

        self.service_endpoint: str = self.service.attr_endpoint
        self.api_origin: cloudfront.IOrigin = origins.HttpOrigin(
            origin_host(self.service_endpoint),
            protocol_policy=cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            read_timeout=ORIGIN_READ_TIMEOUT,
        )

    def _edge_lock(self, data: DeskData, task: ecs.FargateTaskDefinition) -> CustomResource:
        """ExpressEdge (functions/express_edge): the load balancer's idle timeout to 300 s, and its
        security groups admitting 443 only from CloudFront's prefix list. A failure fails the
        resource, and the stack rolls back."""
        load_balancer = self.load_balancer_arn
        handler = lambda_.Function(
            self,
            "ExpressEdgeFunction",
            description="Locks the Claude Desk Express load balancer to CloudFront",
            runtime=lambda_.Runtime.PYTHON_3_13,
            architecture=lambda_.Architecture.ARM_64,
            handler="index.handler",
            # Only the handler: tests that import it leave bytecode beside it.
            code=lambda_.Code.from_asset(str(EXPRESS_EDGE_CODE), exclude=["__pycache__", "*.pyc"]),
            timeout=Duration.minutes(1),
        )
        handler.add_to_role_policy(
            iam.PolicyStatement(
                actions=["elasticloadbalancing:ModifyLoadBalancerAttributes"], resources=[load_balancer]
            )
        )
        # Ingress changes only on security groups in this VPC, where Express puts the balancer.
        handler.add_to_role_policy(
            iam.PolicyStatement(
                actions=["ec2:RevokeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupIngress"],
                resources=[Stack.of(self).format_arn(service="ec2", resource="security-group", resource_name="*")],
                conditions={"ArnEquals": {"ec2:Vpc": data.vpc.vpc_arn}},
            )
        )
        # The two describe calls take no resource-level permission.
        handler.add_to_role_policy(
            iam.PolicyStatement(
                actions=["elasticloadbalancing:DescribeLoadBalancers", "ec2:DescribeSecurityGroups"], resources=["*"]
            )
        )
        provider = cr.Provider(self, "ExpressEdgeProvider", on_event_handler=handler)
        # The provider's own function is plain Node.js; run it on arm64 like all of the Desk's compute.
        framework = provider.node.find_child("framework-onEvent").node.default_child
        framework.add_property_override("Architectures", ["arm64"])
        return CustomResource(
            self,
            "ExpressEdge",
            service_token=provider.service_token,
            resource_type="Custom::ExpressEdge",
            properties={
                "LoadBalancerArn": load_balancer,
                "PrefixListId": data.cloudfront_prefix_list_id,
                # Changes with every new task revision, so the lock is re-applied after each
                # service update, in case Express touched the balancer.
                "TaskDefinitionArn": task.task_definition_arn,
            },
        )
