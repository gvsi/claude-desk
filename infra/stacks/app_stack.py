"""DeskApp: what serves traffic, rebuilt on every deploy from DeskData's network, database and
secrets: the two-container task, the compute that runs it (picked by `config.compute`) and the
edge, one CloudFront distribution for the web build and `/api/*`.

Outputs: `PublicUrl` (the Desk's address: the custom domain, else the distribution's),
`DistributionId`, `WebBucketName`, `ServiceEndpoint` (Express mode: the service's own address,
which only CloudFront may reach) and `DeployedSha`, the commit deploy.sh deployed.
"""

from aws_cdk import CfnOutput, Stack
from constructs import Construct

from stacks.compute_express import ExpressCompute
from stacks.config import ConfigError, DeskConfig
from stacks.data_stack import DeskData
from stacks.edge import Edge
from stacks.task import desk_task_definition


class DeskApp(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, data: DeskData, config: DeskConfig, **kwargs) -> None:
        super().__init__(
            scope, construct_id, description="Claude Desk app: the task, its compute and the CloudFront edge", **kwargs
        )
        self.add_stack_dependency(data, "the task runs on its network, database and secrets")
        self.task_definition = desk_task_definition(self, data, config)

        if config.compute != "express":
            # Fail closed: a deploy that asked for the fallback never gets Express in its place.
            raise ConfigError(f"compute {config.compute} isn't built in this version; use express")
        self.compute = ExpressCompute(self, data, self.task_definition)
        self.edge = Edge(self, config=config, api_origin=self.compute.api_origin)
        # CloudFront fronts the origin only once its load balancer admits CloudFront alone.
        self.edge.distribution.node.add_dependency(self.compute.edge_lock)
        CfnOutput(self, "PublicUrl", value=self.edge.public_url)
        CfnOutput(self, "DistributionId", value=self.edge.distribution.distribution_id)
        CfnOutput(self, "WebBucketName", value=self.edge.bucket.bucket_name)
        CfnOutput(self, "ServiceEndpoint", value=self.compute.service_endpoint)
        CfnOutput(self, "DeployedSha", value=config.git_sha)
