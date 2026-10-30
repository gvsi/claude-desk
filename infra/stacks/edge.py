"""The edge: one CloudFront distribution, the Desk's only public address.

`/api/*` goes to the compute's origin; everything else is the web build in a private S3 bucket.
"""

from aws_cdk import Duration, RemovalPolicy, Stack
from aws_cdk import aws_certificatemanager as acm
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_iam as iam
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_assets as s3_assets
from aws_cdk import aws_s3_deployment as s3deploy
from constructs import Construct

from stacks.config import INFRA_DIR, DeskConfig

API_PATH = "/api/*"
INDEX = "index.html"
ASSETS_CACHE_CONTROL = "public, max-age=31536000, immutable"
SPA_REWRITE = INFRA_DIR / "functions" / "spa_rewrite.js"


class Edge(Construct):
    def __init__(self, scope: Construct, *, config: DeskConfig, api_origin: cloudfront.IOrigin) -> None:
        super().__init__(scope, "Edge")

        # Private: only this distribution reads it, through origin access control. The web build is
        # rebuilt on every deploy, so the bucket and its objects go with the stack.
        self.bucket = s3.Bucket(
            self,
            "WebBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )
        # The auto-delete function CDK adds for the bucket is plain Node.js; run it on arm64 like
        # all of the Desk's compute.
        auto_delete = Stack.of(self).node.find_child("Custom::S3AutoDeleteObjectsCustomResourceProvider")
        auto_delete.node.find_child("Handler").add_property_override("Architectures", ["arm64"])
        # Serves the web app's index.html for its client-side routes (/app/..., /d/<slug>, /pay/<token>).
        self.spa_rewrite = cloudfront.Function(
            self,
            "SpaRewrite",
            comment="Claude Desk: serve the web app for its routes",
            code=cloudfront.FunctionCode.from_file(file_path=str(SPA_REWRITE)),
            runtime=cloudfront.FunctionRuntime.JS_2_0,
        )
        self.distribution = cloudfront.Distribution(
            self,
            "Distribution",
            comment="Claude Desk: the web app and its API",
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
            http_version=cloudfront.HttpVersion.HTTP2_AND_3,
            default_root_object=INDEX,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(self.bucket),
                response_headers_policy=cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
                function_associations=[
                    cloudfront.FunctionAssociation(
                        function=self.spa_rewrite, event_type=cloudfront.FunctionEventType.VIEWER_REQUEST
                    )
                ],
            ),
            additional_behaviors={API_PATH: self._api_behavior(api_origin, self._api_headers())},
            **self._custom_domain(config),
        )
        # The address the Desk is shared at, and the API's PUBLIC_ORIGIN (deploy.sh passes it on).
        self.public_url: str = (
            f"https://{config.domain_name}"
            if config.domain_name is not None
            else f"https://{self.distribution.distribution_domain_name}"
        )

        self.web_assets, self.web_index = self._deploy_web_build(config)

    def _deploy_web_build(self, config: DeskConfig) -> tuple[s3deploy.BucketDeployment, s3deploy.BucketDeployment]:
        """The web build, in two steps: the content-hashed assets first, cached for a year, then
        index.html, revalidated on every load, with the deploy's one invalidation. Neither prunes:
        a tab still running the previous build keeps loading its own assets."""
        build = s3_assets.Asset(self, "WebBuild", path=str(config.web_dist))
        source = s3deploy.Source.bucket(build.bucket, build.s3_object_key)
        role = self._web_deploy_role(build)
        common = {
            "sources": [source],
            "destination_bucket": self.bucket,
            "prune": False,
            # BucketDeployment would grant the role invalidations on every distribution; it gets
            # a view it can't add to, and _web_deploy_role grants exactly what the deploy needs.
            "role": role.without_policy_updates(),
            "log_group": logs.LogGroup(
                self, "WebDeployLogs", retention=logs.RetentionDays.TWO_WEEKS, removal_policy=RemovalPolicy.DESTROY
            ),
        }
        assets = s3deploy.BucketDeployment(
            self,
            "WebAssets",
            exclude=[INDEX],
            cache_control=[s3deploy.CacheControl.from_string(ASSETS_CACHE_CONTROL)],
            **common,
        )
        index = s3deploy.BucketDeployment(
            self,
            "WebIndex",
            exclude=["*"],
            include=[INDEX],
            cache_control=[s3deploy.CacheControl.no_cache()],
            distribution=self.distribution,
            distribution_paths=["/*"],
            **common,
        )
        index.node.add_dependency(assets)
        for deployment in (assets, index):
            # The role and its policy exist before either step runs.
            deployment.node.add_dependency(role)
        return assets, index

    def _web_deploy_role(self, build: s3_assets.Asset) -> iam.Role:
        """The deploy function's role: logs, reading the staged build, writing the web bucket, and
        invalidating this distribution only."""
        role = iam.Role(
            self,
            "WebDeployRole",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            description="Copies the Claude Desk web build to its bucket and invalidates its distribution",
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSLambdaBasicExecutionRole")
            ],
        )
        build.grant_read(role)
        self.bucket.grant_read_write(role)
        self.distribution.grant(role, "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation")
        return role

    def _custom_domain(self, config: DeskConfig) -> dict:
        """With a domain: its alias and its certificate (ACM in us-east-1, checked by DeskConfig), at
        TLS 1.2 or later. Without one, CloudFront's own name and certificate."""
        if config.domain_name is None or config.certificate_arn is None:
            return {}
        return {
            "domain_names": [config.domain_name],
            "certificate": acm.Certificate.from_certificate_arn(self, "Certificate", config.certificate_arn),
            "minimum_protocol_version": cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        }

    def _api_headers(self) -> cloudfront.ResponseHeadersPolicy:
        """HSTS, nosniff and no framing on every API response, set over whatever the origin sends.
        No Referrer-Policy: the API's own `no-referrer` on document links must stand."""
        return cloudfront.ResponseHeadersPolicy(
            self,
            "ApiHeaders",
            comment="Claude Desk API: security headers that keep the API's Referrer-Policy",
            security_headers_behavior=cloudfront.ResponseSecurityHeadersBehavior(
                strict_transport_security=cloudfront.ResponseHeadersStrictTransportSecurity(
                    access_control_max_age=Duration.days(365), include_subdomains=True, override=True
                ),
                content_type_options=cloudfront.ResponseHeadersContentTypeOptions(override=True),
                frame_options=cloudfront.ResponseHeadersFrameOptions(
                    frame_option=cloudfront.HeadersFrameOption.DENY, override=True
                ),
            ),
        )

    def _api_behavior(
        self, api_origin: cloudfront.IOrigin, headers: cloudfront.IResponseHeadersPolicy
    ) -> cloudfront.BehaviorOptions:
        """Nothing is cached, and the API sees every viewer header but Host (the origin's own host
        routes the request at its load balancer), every cookie and every query string, plus the
        X-Forwarded-For entry CloudFront appends for the viewer."""
        return cloudfront.BehaviorOptions(
            origin=api_origin,
            cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
            origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
            # Server-sent events stream as written, never buffered for compression.
            compress=False,
            # Never a redirect: browsers turn a redirected POST into a GET.
            viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
            response_headers_policy=headers,
        )
