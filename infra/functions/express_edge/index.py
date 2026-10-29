"""ExpressEdge: lock the Express service's load balancer to CloudFront.

A CloudFormation custom resource, run through `custom_resources.Provider`. Express Mode's API
sets neither the load balancer's idle timeout nor its ingress, so on create and update, for the
load balancer named by `LoadBalancerArn`, this:

- sets `idle_timeout.timeout_seconds` to 300: above the API's 15 s SSE heartbeat, below
  uvicorn's 310 s keep-alive, so the balancer closes idle connections first;
- on each of the load balancer's security groups, revokes every ingress rule open to 0.0.0.0/0
  or ::/0, then admits 443 only from `PrefixListId`, CloudFront's origin-facing prefix list.

Delete changes nothing (the service, and with it the load balancer, is going away). Any error
raises, so the provider reports FAILED and the stack rolls back. Revoking comes before admitting,
so a failure part-way leaves the load balancer closed, never open.
"""

import boto3

IDLE_TIMEOUT = {"Key": "idle_timeout.timeout_seconds", "Value": "300"}
HTTPS = 443
WORLD_V4, WORLD_V6 = "0.0.0.0/0", "::/0"


def _client(name: str):
    return boto3.client(name)


def _required(properties: dict, name: str) -> str:
    value = properties.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"ExpressEdge needs the {name} property")
    return value


def handler(event: dict, context: object) -> dict:
    request = event["RequestType"]
    if request == "Delete":
        return {"PhysicalResourceId": event["PhysicalResourceId"]}
    if request not in ("Create", "Update"):
        raise ValueError(f"unknown request type {request}")
    properties = event["ResourceProperties"]
    load_balancer = _required(properties, "LoadBalancerArn")
    prefix_list = _required(properties, "PrefixListId")

    elbv2, ec2 = _client("elbv2"), _client("ec2")
    [balancer] = elbv2.describe_load_balancers(LoadBalancerArns=[load_balancer])["LoadBalancers"]
    group_ids = balancer.get("SecurityGroups") or []
    if not group_ids:
        # Describing no IDs would list every group in the account; there is nothing to lock.
        raise RuntimeError(f"load balancer {load_balancer} has no security groups to lock")
    for group in ec2.describe_security_groups(GroupIds=group_ids)["SecurityGroups"]:
        _lock(ec2, group, prefix_list)
    elbv2.modify_load_balancer_attributes(LoadBalancerArn=load_balancer, Attributes=[IDLE_TIMEOUT])
    return {"PhysicalResourceId": load_balancer}


def _lock(ec2, group: dict, prefix_list: str) -> None:
    """Revoke the group's world-open ingress, then admit 443 from the prefix list if it doesn't yet."""
    world = [part for part in map(_world_part, group["IpPermissions"]) if part is not None]
    if world:
        revoked = ec2.revoke_security_group_ingress(GroupId=group["GroupId"], IpPermissions=world)
        # A permission EC2 doesn't recognise is reported, not raised: it stayed open.
        if not revoked.get("Return") or revoked.get("UnknownIpPermissions"):
            raise RuntimeError(f"could not revoke world ingress on {group['GroupId']}")
    if not any(_admits(permission, prefix_list) for permission in group["IpPermissions"]):
        admitted = ec2.authorize_security_group_ingress(
            GroupId=group["GroupId"],
            IpPermissions=[
                {
                    "IpProtocol": "tcp",
                    "FromPort": HTTPS,
                    "ToPort": HTTPS,
                    "PrefixListIds": [{"PrefixListId": prefix_list, "Description": "CloudFront origin-facing"}],
                }
            ],
        )
        if not admitted.get("Return"):
            raise RuntimeError(f"could not admit CloudFront on {group['GroupId']}")


def _world_part(permission: dict) -> dict | None:
    """The part of an ingress permission open to every address, as a revoke request names it, or
    None. Other sources in the same permission (a private range, a group) are kept."""
    v4 = [{"CidrIp": WORLD_V4} for item in permission.get("IpRanges", []) if item.get("CidrIp") == WORLD_V4]
    v6 = [{"CidrIpv6": WORLD_V6} for item in permission.get("Ipv6Ranges", []) if item.get("CidrIpv6") == WORLD_V6]
    if not v4 and not v6:
        return None
    part = {key: permission[key] for key in ("IpProtocol", "FromPort", "ToPort") if key in permission}
    if v4:
        part["IpRanges"] = v4
    if v6:
        part["Ipv6Ranges"] = v6
    return part


def _admits(permission: dict, prefix_list: str) -> bool:
    """Whether this permission admits 443 from the prefix list."""
    return (
        permission.get("IpProtocol") == "tcp"
        and permission.get("FromPort") == HTTPS
        and permission.get("ToPort") == HTTPS
        and any(item.get("PrefixListId") == prefix_list for item in permission.get("PrefixListIds", []))
    )
