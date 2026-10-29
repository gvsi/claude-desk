"""The ExpressEdge custom resource's handler, against stubbed AWS clients: it sets the load
balancer's idle timeout and leaves its security groups admitting only CloudFront."""

import importlib.util
from pathlib import Path

import boto3
import botocore
import pytest
from botocore.config import Config
from botocore.exceptions import ClientError
from botocore.stub import Stubber

HANDLER = Path(__file__).resolve().parents[1] / "functions" / "express_edge" / "index.py"
LOAD_BALANCER = (
    "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/ecs-express-gateway-alb/0a1b2c3d4e5f6a7b"
)
PREFIX_LIST = "pl-82a045eb"
GROUP = "sg-0a1b2c3d4e5f60718"
OTHER_GROUP = "sg-0f1e2d3c4b5a69788"


@pytest.fixture
def edge(monkeypatch):
    """The handler module with stubbed elbv2 and ec2 clients; every call must be expected."""
    spec = importlib.util.spec_from_file_location("express_edge_index", HANDLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = Config(signature_version=botocore.UNSIGNED)
    clients = {name: boto3.client(name, region_name="us-west-2", config=config) for name in ("elbv2", "ec2")}
    stubs = {name: Stubber(client) for name, client in clients.items()}
    monkeypatch.setattr(module, "_client", lambda name: clients[name])
    for stub in stubs.values():
        stub.activate()
    yield module, stubs["elbv2"], stubs["ec2"]
    for stub in stubs.values():
        stub.deactivate()


def _event(request_type: str, **extra) -> dict:
    event = {
        "RequestType": request_type,
        "RequestId": "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f9",
        "ResourceProperties": {
            "ServiceToken": "arn:aws:lambda:us-west-2:123456789012:function:provider",
            "LoadBalancerArn": LOAD_BALANCER,
            "PrefixListId": PREFIX_LIST,
        },
    }
    return {**event, **extra}


def _world_rules() -> list[dict]:
    """What Express gives its load balancer's group: HTTPS from anywhere, over IPv4 and IPv6."""
    return [
        {
            "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
            "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "Ipv6Ranges": [{"CidrIpv6": "::/0"}],
            "PrefixListIds": [], "UserIdGroupPairs": [],
        },
    ]


def _cloudfront_rule() -> dict:
    return {
        "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
        "IpRanges": [], "Ipv6Ranges": [], "PrefixListIds": [{"PrefixListId": PREFIX_LIST}], "UserIdGroupPairs": [],
    }


def _expect_describe(elbv2: Stubber, ec2: Stubber, groups: dict[str, list[dict]]) -> None:
    elbv2.add_response(
        "describe_load_balancers",
        {"LoadBalancers": [{"LoadBalancerArn": LOAD_BALANCER, "SecurityGroups": list(groups)}]},
        {"LoadBalancerArns": [LOAD_BALANCER]},
    )
    ec2.add_response(
        "describe_security_groups",
        {"SecurityGroups": [{"GroupId": group, "IpPermissions": rules} for group, rules in groups.items()]},
        {"GroupIds": list(groups)},
    )


# The attributes the lock sets: the idle timeout, and X-Forwarded-For appended to, never kept as
# the client sent it or removed, since the API counts its trusted hops from the right of it.
ATTRIBUTES = [
    {"Key": "idle_timeout.timeout_seconds", "Value": "300"},
    {"Key": "routing.http.xff_header_processing.mode", "Value": "append"},
]


def _expect_idle_timeout(elbv2: Stubber) -> None:
    elbv2.add_response(
        "modify_load_balancer_attributes",
        {"Attributes": ATTRIBUTES},
        {"LoadBalancerArn": LOAD_BALANCER, "Attributes": ATTRIBUTES},
    )


def test_sets_idle_timeout_to_300_and_appends_x_forwarded_for(edge):
    """TRUSTED_PROXY_HOPS=2 holds only while the balancer appends CloudFront's address to the
    header; in `preserve` mode the second entry from the right would be the visitor's own."""
    module, elbv2, ec2 = edge
    _expect_describe(elbv2, ec2, {GROUP: [_cloudfront_rule()]})
    _expect_idle_timeout(elbv2)

    result = module.handler(_event("Create"), None)

    elbv2.assert_no_pending_responses()
    ec2.assert_no_pending_responses()
    assert result["PhysicalResourceId"] == LOAD_BALANCER


def test_replaces_world_ingress_with_the_prefix_list(edge):
    module, elbv2, ec2 = edge
    from_another_group = {
        "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [], "Ipv6Ranges": [], "PrefixListIds": [],
        "UserIdGroupPairs": [{"GroupId": OTHER_GROUP, "UserId": "123456789012"}],
    }
    mixed = {  # one rule open to the world and to a private range: only the world part goes
        "IpProtocol": "tcp", "FromPort": 80, "ToPort": 80,
        "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "HTTP"}, {"CidrIp": "10.0.0.0/16"}],
        "Ipv6Ranges": [], "PrefixListIds": [], "UserIdGroupPairs": [],
    }
    everything = {
        "IpProtocol": "-1", "IpRanges": [], "Ipv6Ranges": [{"CidrIpv6": "::/0"}], "PrefixListIds": [],
        "UserIdGroupPairs": [],
    }
    _expect_describe(elbv2, ec2, {GROUP: [*_world_rules(), from_another_group, mixed, everything]})
    ec2.add_response(
        "revoke_security_group_ingress",
        {"Return": True},
        {
            "GroupId": GROUP,
            "IpPermissions": [
                {
                    "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
                    "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "Ipv6Ranges": [{"CidrIpv6": "::/0"}],
                },
                {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
                {"IpProtocol": "-1", "Ipv6Ranges": [{"CidrIpv6": "::/0"}]},
            ],
        },
    )
    ec2.add_response(
        "authorize_security_group_ingress",
        {"Return": True},
        {
            "GroupId": GROUP,
            "IpPermissions": [
                {
                    "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
                    "PrefixListIds": [{"PrefixListId": PREFIX_LIST, "Description": "CloudFront origin-facing"}],
                }
            ],
        },
    )
    _expect_idle_timeout(elbv2)

    module.handler(_event("Update", PhysicalResourceId=LOAD_BALANCER), None)

    elbv2.assert_no_pending_responses()
    ec2.assert_no_pending_responses()


def _expect_lock(ec2: Stubber, group: str) -> None:
    ec2.add_response("revoke_security_group_ingress", {"Return": True}, {"GroupId": group, "IpPermissions": [
        {
            "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
            "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "Ipv6Ranges": [{"CidrIpv6": "::/0"}],
        }
    ]})
    ec2.add_response("authorize_security_group_ingress", {"Return": True}, {"GroupId": group, "IpPermissions": [
        {
            "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
            "PrefixListIds": [{"PrefixListId": PREFIX_LIST, "Description": "CloudFront origin-facing"}],
        }
    ]})


def test_is_idempotent(edge):
    module, elbv2, ec2 = edge
    # The first run locks both of the load balancer's groups...
    _expect_describe(elbv2, ec2, {GROUP: _world_rules(), OTHER_GROUP: _world_rules()})
    _expect_lock(ec2, GROUP)
    _expect_lock(ec2, OTHER_GROUP)
    _expect_idle_timeout(elbv2)
    module.handler(_event("Create"), None)
    ec2.assert_no_pending_responses()

    # ...and a later run finds them locked: no revoke or authorize call (an unexpected call fails).
    _expect_describe(elbv2, ec2, {GROUP: [_cloudfront_rule()], OTHER_GROUP: [_cloudfront_rule()]})
    _expect_idle_timeout(elbv2)
    module.handler(_event("Update", PhysicalResourceId=LOAD_BALANCER), None)

    elbv2.assert_no_pending_responses()
    ec2.assert_no_pending_responses()


def test_delete_changes_nothing(edge):
    module, elbv2, ec2 = edge

    # No response is queued, so any AWS call would fail the test.
    result = module.handler(_event("Delete", PhysicalResourceId=LOAD_BALANCER), None)

    assert result == {"PhysicalResourceId": LOAD_BALANCER}


def test_errors_propagate(edge):
    module, elbv2, ec2 = edge
    _expect_describe(elbv2, ec2, {GROUP: _world_rules()})
    ec2.add_client_error("revoke_security_group_ingress", "UnauthorizedOperation", http_status_code=403)

    # Raised, so the provider reports FAILED and the stack rolls back.
    with pytest.raises(ClientError, match="UnauthorizedOperation"):
        module.handler(_event("Create"), None)


@pytest.mark.parametrize(
    "response",
    [{"Return": False}, {"Return": True, "UnknownIpPermissions": [{"IpProtocol": "tcp", "FromPort": 443}]}],
    ids=["not-returned", "unknown-permissions"],
)
def test_a_revoke_that_did_not_apply_fails(edge, response):
    module, elbv2, ec2 = edge
    _expect_describe(elbv2, ec2, {GROUP: _world_rules()})
    ec2.add_response("revoke_security_group_ingress", response)

    with pytest.raises(RuntimeError, match=f"could not revoke world ingress on {GROUP}"):
        module.handler(_event("Create"), None)


def test_an_authorize_that_did_not_apply_fails(edge):
    module, elbv2, ec2 = edge
    _expect_describe(elbv2, ec2, {GROUP: [_cloudfront_rule() | {"FromPort": 80, "ToPort": 80}]})
    ec2.add_response("authorize_security_group_ingress", {"Return": False})

    with pytest.raises(RuntimeError, match=f"could not admit CloudFront on {GROUP}"):
        module.handler(_event("Create"), None)


def test_a_load_balancer_without_security_groups_fails(edge):
    module, elbv2, ec2 = edge
    # Describing no group IDs would list every group in the account: never lock those.
    elbv2.add_response(
        "describe_load_balancers",
        {"LoadBalancers": [{"LoadBalancerArn": LOAD_BALANCER, "SecurityGroups": []}]},
        {"LoadBalancerArns": [LOAD_BALANCER]},
    )

    with pytest.raises(RuntimeError, match="has no security groups"):
        module.handler(_event("Create"), None)
    ec2.assert_no_pending_responses()


@pytest.mark.parametrize("missing", ["LoadBalancerArn", "PrefixListId"])
def test_missing_properties_fail(edge, missing):
    module, _, _ = edge
    event = _event("Create")
    event["ResourceProperties"] = {k: v for k, v in event["ResourceProperties"].items() if k != missing}

    with pytest.raises(ValueError, match=missing):
        module.handler(event, None)
