"""The edge: one CloudFront distribution serves the web build from a private bucket and passes
`/api/*` to the compute's origin uncached, with every viewer header, cookie and query string."""

import json
from fnmatch import fnmatchcase
from pathlib import Path

import pytest
from aws_cdk import aws_cloudfront as cloudfront
from conftest import INFRA, actions, build_stacks, resource_list, role_statements

import stacks.config as config_module
from stacks.compute_express import origin_host
from stacks.config import PLACEHOLDER_SITE


def _distribution(template) -> tuple[str, dict]:
    found = template.find_resources("AWS::CloudFront::Distribution")
    assert len(found) == 1, f"expected one distribution, found {sorted(found)}"
    [(distribution_id, distribution)] = found.items()
    return distribution_id, distribution["Properties"]["DistributionConfig"]


def _behaviors(template) -> tuple[dict, dict]:
    """The default (web) behavior and the one other behavior, `/api/*`."""
    _, config = _distribution(template)
    [api] = config["CacheBehaviors"]
    return config["DefaultCacheBehavior"], api


def _origins(template) -> tuple[dict, dict]:
    """The web origin (the default behavior's) and the API origin (`/api/*`'s)."""
    _, config = _distribution(template)
    web, api = _behaviors(template)
    by_id = {origin["Id"]: origin for origin in config["Origins"]}
    return by_id[web["TargetOriginId"]], by_id[api["TargetOriginId"]]


def _only_id(template, kind: str) -> str:
    found = template.find_resources(kind)
    assert len(found) == 1, f"expected one {kind}, found {sorted(found)}"
    return next(iter(found))


def test_one_distribution_two_origins(desk_stacks):
    _, config = _distribution(desk_stacks.template)
    web, api = _behaviors(desk_stacks.template)
    web_origin, api_origin = _origins(desk_stacks.template)

    assert len(config["Origins"]) == 2
    assert api["PathPattern"] == "/api/*"
    assert web["TargetOriginId"] != api["TargetOriginId"]
    bucket_id = _only_id(desk_stacks.template, "AWS::S3::Bucket")
    assert web_origin["DomainName"] == {"Fn::GetAtt": [bucket_id, "RegionalDomainName"]}
    # The compute's origin: the Express service's endpoint host, as Task 4 binds it.
    desk_app = desk_stacks.desk_app
    assert api_origin["DomainName"] == desk_app.resolve(origin_host(desk_app.compute.service_endpoint))


ALL_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]


def test_api_behavior_never_caches_and_forwards_cookies(desk_stacks):
    _, api = _behaviors(desk_stacks.template)

    # Nothing under /api/* is cached, and the API sees every viewer header but Host (the origin's
    # host routes the request), every cookie and every query string, plus CloudFront's
    # X-Forwarded-For entry for the viewer.
    assert api["CachePolicyId"] == cloudfront.CachePolicy.CACHING_DISABLED.cache_policy_id
    assert api["OriginRequestPolicyId"] == (
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.origin_request_policy_id
    )
    assert sorted(api["AllowedMethods"]) == ALL_METHODS
    # SSE streams as it is written; a redirect would turn a POST into a GET.
    assert api["Compress"] is False
    assert api["ViewerProtocolPolicy"] == "https-only"
    for legacy in ("ForwardedValues", "MinTTL", "DefaultTTL", "MaxTTL"):
        assert legacy not in api, legacy


def test_api_origin_has_a_60s_read_timeout_and_no_custom_headers(desk_stacks):
    _, api_origin = _origins(desk_stacks.template)
    _, config = _distribution(desk_stacks.template)

    # Long enough for /api/owner/policy/*'s answer, a 202 with a poll after 25 s.
    assert api_origin["CustomOriginConfig"]["OriginReadTimeout"] == 60
    assert api_origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only"
    # The edge adds no header of its own: only CloudFront's address range reaches the origin, and
    # the API trusts nothing but the X-Forwarded-For entry CloudFront appends.
    for origin in config["Origins"]:
        assert "OriginCustomHeaders" not in origin, origin["Id"]


def test_no_distribution_wide_error_responses(desk_stacks):
    _, config = _distribution(desk_stacks.template)

    # An error page for the whole distribution would turn the API's 404s and 403s into the web
    # app's page; the web app's routes are rewritten on its own behavior instead.
    assert "CustomErrorResponses" not in config


def test_functions_attach_to_the_right_behaviors(desk_stacks):
    template = desk_stacks.template
    web, api = _behaviors(template)
    function_id = _only_id(template, "AWS::CloudFront::Function")
    function = template.find_resources("AWS::CloudFront::Function")[function_id]["Properties"]

    # spa_rewrite.js, as its Node tests run it, on the web app's viewer requests only.
    assert function["FunctionCode"] == (INFRA / "functions" / "spa_rewrite.js").read_text()
    assert function["FunctionConfig"]["Runtime"] == "cloudfront-js-2.0"
    assert function["AutoPublish"] is True
    assert web["FunctionAssociations"] == [
        {"EventType": "viewer-request", "FunctionARN": {"Fn::GetAtt": [function_id, "FunctionARN"]}}
    ]
    # Nothing rewrites or answers for the API, and no Lambda@Edge runs anywhere.
    assert "FunctionAssociations" not in api
    for behavior in (web, api):
        assert "LambdaFunctionAssociations" not in behavior


def test_bucket_is_private_and_read_through_oac(desk_stacks):
    template = desk_stacks.template
    distribution_id, _ = _distribution(template)
    bucket_id = _only_id(template, "AWS::S3::Bucket")
    bucket = template.find_resources("AWS::S3::Bucket")[bucket_id]
    web_origin, _ = _origins(template)

    assert bucket["Properties"]["PublicAccessBlockConfiguration"] == {
        "BlockPublicAcls": True,
        "BlockPublicPolicy": True,
        "IgnorePublicAcls": True,
        "RestrictPublicBuckets": True,
    }
    # The web build is rebuilt on every deploy, so the bucket and its objects go with the stack.
    assert bucket["DeletionPolicy"] == bucket["UpdateReplacePolicy"] == "Delete"
    [auto_delete] = template.find_resources("Custom::S3AutoDeleteObjects").values()
    assert auto_delete["Properties"]["BucketName"] == {"Ref": bucket_id}

    # CloudFront signs its requests (origin access control); the origin has no legacy identity.
    oac_id = _only_id(template, "AWS::CloudFront::OriginAccessControl")
    oac = template.find_resources("AWS::CloudFront::OriginAccessControl")[oac_id]["Properties"]
    assert oac["OriginAccessControlConfig"]["OriginAccessControlOriginType"] == "s3"
    assert oac["OriginAccessControlConfig"]["SigningBehavior"] == "always"
    assert oac["OriginAccessControlConfig"]["SigningProtocol"] == "sigv4"
    assert web_origin["OriginAccessControlId"] == {"Fn::GetAtt": [oac_id, "Id"]}
    assert web_origin["S3OriginConfig"] == {"OriginAccessIdentity": ""}

    [policy] = template.find_resources("AWS::S3::BucketPolicy").values()
    assert policy["Properties"]["Bucket"] == {"Ref": bucket_id}
    statements = policy["Properties"]["PolicyDocument"]["Statement"]
    bucket_arn = {"Fn::GetAtt": [bucket_id, "Arn"]}
    objects = {"Fn::Join": ["", [bucket_arn, "/*"]]}
    # Plain HTTP is refused for everyone.
    assert [statement for statement in statements if statement["Effect"] == "Deny"] == [
        {
            "Action": "s3:*",
            "Condition": {"Bool": {"aws:SecureTransport": "false"}},
            "Effect": "Deny",
            "Principal": {"AWS": "*"},
            "Resource": [bucket_arn, objects],
        }
    ]
    # Only this distribution reads objects; nothing is granted to everyone.
    allows = [statement for statement in statements if statement["Effect"] == "Allow"]
    readers = [
        statement for statement in allows
        if any(fnmatchcase("s3:GetObject", action) for action in actions(statement))
    ]
    distribution_arn = {
        "Fn::Join": [
            "",
            [
                "arn:", {"Ref": "AWS::Partition"}, ":cloudfront::", {"Ref": "AWS::AccountId"},
                ":distribution/", {"Ref": distribution_id},
            ],
        ]
    }
    assert readers == [
        {
            "Action": "s3:GetObject",
            "Condition": {"StringEquals": {"AWS:SourceArn": distribution_arn}},
            "Effect": "Allow",
            "Principal": {"Service": "cloudfront.amazonaws.com"},
            "Resource": objects,
        }
    ]
    for statement in allows:
        assert statement["Principal"] not in ("*", {"AWS": "*"}), statement


CERTIFICATE_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/0f0e0d0c-0b0a-0908-0706-050403020100"


def _outputs(template) -> dict:
    return {name: output["Value"] for name, output in template.find_outputs("*").items()}


def test_custom_domain_is_optional(desk_stacks):
    # Without a domain: CloudFront's own name and certificate.
    distribution_id, config = _distribution(desk_stacks.template)
    assert "Aliases" not in config
    assert "ViewerCertificate" not in config
    assert _outputs(desk_stacks.template)["PublicUrl"] == {
        "Fn::Join": ["", ["https://", {"Fn::GetAtt": [distribution_id, "DomainName"]}]]
    }

    # With one: its alias, its us-east-1 certificate, TLS 1.2 at least, and the API's links on it.
    stacks = build_stacks(domain_name="desk.example.com", certificate_arn=CERTIFICATE_ARN)
    _, config = _distribution(stacks.template)
    assert config["Aliases"] == ["desk.example.com"]
    assert config["ViewerCertificate"] == {
        "AcmCertificateArn": CERTIFICATE_ARN,
        "MinimumProtocolVersion": "TLSv1.2_2021",
        "SslSupportMethod": "sni-only",
    }
    assert _outputs(stacks.template)["PublicUrl"] == "https://desk.example.com" == stacks.config.public_origin
    assert "CustomErrorResponses" not in config


def test_api_headers_keep_the_origin_referrer_policy(desk_stacks):
    template = desk_stacks.template
    web, api = _behaviors(template)

    # The web app: CloudFront's managed security headers, HSTS among them.
    managed = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
    assert web["ResponseHeadersPolicyId"] == managed.response_headers_policy_id
    # The API: HSTS, nosniff and no framing, set over whatever the origin sends; no Referrer-Policy,
    # so the API's own no-referrer on document links stands.
    policy_id = api["ResponseHeadersPolicyId"]["Ref"]
    policy = template.find_resources("AWS::CloudFront::ResponseHeadersPolicy")[policy_id]["Properties"]
    config = policy["ResponseHeadersPolicyConfig"]
    assert config["SecurityHeadersConfig"] == {
        "StrictTransportSecurity": {"AccessControlMaxAgeSec": 31536000, "IncludeSubdomains": True, "Override": True},
        "ContentTypeOptions": {"Override": True},
        "FrameOptions": {"FrameOption": "DENY", "Override": True},
    }
    for other in ("CorsConfig", "CustomHeadersConfig", "RemoveHeadersConfig", "ServerTimingHeadersConfig"):
        assert other not in config, other


@pytest.fixture(scope="module")
def web_dist(tmp_path_factory):
    """A built web app as Vite lays it out: index.html and content-hashed assets."""
    dist = tmp_path_factory.mktemp("dist")
    (dist / "index.html").write_text('<!doctype html><script type="module" src="/assets/app-1a2b.js"></script>\n')
    (dist / "assets").mkdir()
    (dist / "assets" / "app-1a2b.js").write_text("export {};\n")
    return dist


@pytest.fixture(scope="module")
def web_stacks(web_dist):
    return build_stacks(web_dist=str(web_dist))


def _deployments(template) -> tuple[str, dict, str, dict]:
    """The assets deployment (everything but index.html) and the index.html deployment."""
    deployments = template.find_resources("Custom::CDKBucketDeployment")
    assert len(deployments) == 2, sorted(deployments)
    [(index_id, index)] = [item for item in deployments.items() if "Include" in item[1]["Properties"]]
    [(assets_id, assets)] = [item for item in deployments.items() if item[0] != index_id]
    return assets_id, assets, index_id, index


def test_web_build_cache_control_and_prune(web_stacks):
    template = web_stacks.template
    distribution_id, _ = _distribution(template)
    bucket_id = _only_id(template, "AWS::S3::Bucket")
    assets_id, assets, index_id, index = _deployments(template)

    # First the content-hashed assets, cached for a year; never pruned, so a tab still running
    # the previous build keeps loading its own assets.
    assert assets["Properties"]["Exclude"] == ["index.html"]
    assert assets["Properties"]["SystemMetadata"] == {"cache-control": "public, max-age=31536000, immutable"}
    assert assets["Properties"]["Prune"] is False
    assert "DistributionId" not in assets["Properties"]
    # Then index.html alone, revalidated on every load, and the deploy's one invalidation.
    assert assets_id in index["DependsOn"]
    assert index["Properties"]["Exclude"] == ["*"]
    assert index["Properties"]["Include"] == ["index.html"]
    assert index["Properties"]["SystemMetadata"] == {"cache-control": "no-cache"}
    assert index["Properties"]["Prune"] is False
    assert index["Properties"]["DistributionId"] == {"Ref": distribution_id}
    assert index["Properties"]["DistributionPaths"] == ["/*"]
    # Both from the one staged web build, into the web bucket.
    for key in ("SourceBucketNames", "SourceObjectKeys"):
        assert assets["Properties"][key] == index["Properties"][key], key
    for deployment in (assets, index):
        assert deployment["Properties"]["DestinationBucketName"] == {"Ref": bucket_id}


S3_WRITES = ("s3:Put*", "s3:Delete*", "s3:Abort*", "s3:Replicate*", "s3:Restore*")


def test_web_deploy_writes_only_the_web_bucket_and_invalidates_only_this_distribution(web_stacks):
    template = web_stacks.template
    distribution_id, _ = _distribution(template)
    bucket_id = _only_id(template, "AWS::S3::Bucket")
    _, assets, _, index = _deployments(template)

    # One deploy function serves both steps, on arm64 like all of the Desk's compute.
    assert assets["Properties"]["ServiceToken"] == index["Properties"]["ServiceToken"]
    function_id = index["Properties"]["ServiceToken"]["Fn::GetAtt"][0]
    function = template.find_resources("AWS::Lambda::Function")[function_id]["Properties"]
    assert function["Architectures"] == ["arm64"]
    role_id = function["Role"]["Fn::GetAtt"][0]
    role = template.find_resources("AWS::IAM::Role")[role_id]["Properties"]
    [basic_execution] = role["ManagedPolicyArns"]
    assert basic_execution["Fn::Join"][1][-1] == ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

    statements = role_statements(template, role_id)
    for statement in statements:
        assert "*" not in resource_list(statement), statement
    # Invalidations only on this distribution.
    distribution_arn = web_stacks.desk_app.resolve(web_stacks.desk_app.edge.distribution.distribution_arn)
    assert {"Ref": distribution_id} in distribution_arn["Fn::Join"][1]
    cloudfront_statements = [
        statement for statement in statements if any(action.startswith("cloudfront:") for action in actions(statement))
    ]
    assert len(cloudfront_statements) == 1
    assert sorted(actions(cloudfront_statements[0])) == ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    assert cloudfront_statements[0]["Resource"] == distribution_arn
    # Writes only to the web bucket.
    web_bucket = [{"Fn::GetAtt": [bucket_id, "Arn"]}, {"Fn::Join": ["", [{"Fn::GetAtt": [bucket_id, "Arn"]}, "/*"]]}]
    def writes(action: str) -> bool:
        return any(fnmatchcase(action, write) or fnmatchcase(write, action) for write in S3_WRITES)

    writers = [statement for statement in statements if any(writes(action) for action in actions(statement))]
    assert writers, statements
    for statement in writers:
        assert all(resource in web_bucket for resource in resource_list(statement)), statement

    # Each step waits for the deploy role's permissions, so the first deploy never runs without them.
    [policy_id] = [
        name for name, policy in template.find_resources("AWS::IAM::Policy").items()
        if {"Ref": role_id} in policy["Properties"]["Roles"]
    ]
    for deployment in (assets, index):
        assert policy_id in deployment["DependsOn"]


def test_distribution_settings(desk_stacks):
    _, config = _distribution(desk_stacks.template)

    assert config["Enabled"] is True
    assert config["PriceClass"] == "PriceClass_100"
    assert config["HttpVersion"] == "http2and3"
    assert config["IPV6Enabled"] is True
    assert config["DefaultRootObject"] == "index.html"


def test_outputs_name_the_public_url_distribution_and_bucket(desk_stacks):
    distribution_id, _ = _distribution(desk_stacks.template)
    bucket_id = _only_id(desk_stacks.template, "AWS::S3::Bucket")
    outputs = _outputs(desk_stacks.template)

    # deploy.sh smoke-tests PublicUrl and passes it back as the API's PUBLIC_ORIGIN.
    assert outputs["PublicUrl"] == {"Fn::Join": ["", ["https://", {"Fn::GetAtt": [distribution_id, "DomainName"]}]]}
    assert outputs["DistributionId"] == {"Ref": distribution_id}
    assert outputs["WebBucketName"] == {"Ref": bucket_id}


def test_distribution_waits_for_the_origin_lock(desk_stacks):
    distribution_id, _ = _distribution(desk_stacks.template)
    lock_id = _only_id(desk_stacks.template, "Custom::ExpressEdge")
    distribution = desk_stacks.template.find_resources("AWS::CloudFront::Distribution")[distribution_id]

    # CloudFront starts sending traffic to the origin only once its load balancer admits
    # CloudFront alone and keeps idle streams open for 300 s.
    assert lock_id in distribution["DependsOn"]


def test_every_function_runs_on_arm64(desk_stacks):
    # "arm64 for all AWS compute": the web deploy and the bucket's auto-delete function included.
    functions = desk_stacks.template.find_resources("AWS::Lambda::Function")
    assert len(functions) >= 4, sorted(functions)
    for function_id, function in functions.items():
        assert function["Properties"].get("Architectures") == ["arm64"], function_id


def test_web_behavior_is_cached_compressed_and_https(desk_stacks):
    web, _ = _behaviors(desk_stacks.template)

    assert web["CachePolicyId"] == cloudfront.CachePolicy.CACHING_OPTIMIZED.cache_policy_id
    assert web["Compress"] is True
    assert web["ViewerProtocolPolicy"] == "redirect-to-https"
    # Reads only (CloudFormation's default when the template leaves the methods out).
    assert sorted(web.get("AllowedMethods", ["GET", "HEAD"])) == ["GET", "HEAD"]
    # S3 gets no viewer headers or cookies.
    assert "OriginRequestPolicyId" not in web


def _staged_web_build(stacks) -> list[str]:
    """The files of the web build the deployments copy, as staged in the cloud assembly."""
    assembly = Path(stacks.desk_app.node.root.synth().directory)
    assets = json.loads((assembly / "DeskApp.assets.json").read_text())["files"]
    _, _, _, index = _deployments(stacks.template)
    [object_key] = index["Properties"]["SourceObjectKeys"]
    staged = assembly / assets[object_key.removesuffix(".zip")]["source"]["path"]
    return sorted(path.relative_to(staged).as_posix() for path in staged.rglob("*") if path.is_file())


def test_deploys_the_configured_web_build_else_the_labelled_placeholder(web_stacks, tmp_path, monkeypatch):
    assert _staged_web_build(web_stacks) == ["assets/app-1a2b.js", "index.html"]

    # Without a web build (synth in CI), the labelled page that says the site is being built.
    monkeypatch.setattr(config_module, "DEFAULT_WEB_DIST", tmp_path / "web" / "dist")
    stacks = build_stacks()
    assert stacks.config.placeholder_site
    assert _staged_web_build(stacks) == ["index.html"]
    assert stacks.config.web_dist == PLACEHOLDER_SITE
