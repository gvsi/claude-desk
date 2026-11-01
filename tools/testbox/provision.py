"""Tag-discovered, transactional provisioning; AWS CLI supplies credentials, never this repo."""
import argparse
import base64
import json
import pathlib
import subprocess
import sys
if sys.version_info < (3, 10):
    print("testbox: Python 3.10 or newer is required; run with python3.10+ or install a current Python 3.", file=sys.stderr)
    sys.exit(1)
import time
import hashlib
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from desk_tools.testbox_client import cache_directory, control_path, open_connection  # noqa: E402
INSTANCE_TYPE = "c8g.12xlarge"
# Clients use the one running instance tagged ACTIVE. A replacement in the same region launches beside it as STANDBY,
# which no client discovers unless asked (`tools/testbox/run --standby`); once proven, --promote tags the old one
# RETIRED and the standby ACTIVE, so every lane moves on its next call while calls already running finish.
ACTIVE, STANDBY, RETIRED = "agent-test-box", "agent-test-box-standby", "agent-test-box-retired"
TAGS = [{"Key": "Project", "Value": "claude-desk"}, {"Key": "Purpose", "Value": ACTIVE}]
NAME = "claude-desk-test-box"
SESSION_POLICY_NAME = NAME + "-session"
# The account may add deny-only inline policies to every IAM role. The check accepts any other inline policy whose
# statements all deny, since it can't grant anything, and provisioning never removes one; rollback removes them
# only from a role this run created and is deleting, since delete-role fails while any inline policy remains.
SESSION_POLICY = {"Version": "2012-10-17", "Statement": [{"Sid": "SessionManagerAndRunCommandOnly", "Effect": "Allow", "Action": [
    "ssm:UpdateInstanceInformation", "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage",
    "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint",
    "ec2messages:GetMessages", "ec2messages:SendReply"], "Resource": "*"}]}


# How long promotion keeps closing reopened connections to retired machines and restoring the record, for calls that
# chose the old machine just before promotion (their connection setup polls SSM for up to three minutes). Callers
# slower than that find the retired machine refusing new connections.
HANDOVER_SECONDS = 240


def stop_connection(cache, region, instance) -> bool:
    """Stop this laptop's shared SSH connection to a retired machine taking new calls; calls already on it finish.
    True when none is left taking calls."""
    socket = control_path(cache, region, instance)
    if not socket.exists():
        return True
    host = "ubuntu@" + instance
    subprocess.run(["ssh", "-S", str(socket), "-O", "stop", host], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return subprocess.run(["ssh", "-S", str(socket), "-O", "check", host], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0


def ssm_run(api, instance, script):
    """Run a short root shell script on an instance over SSM; its final status."""
    command = api("ssm", "send-command", instance_ids=[instance], document_name="AWS-RunShellScript", timeout_seconds=60,
                  parameters={"commands": [script]})["Command"]["CommandId"]
    for _ in range(60):
        try:
            result = api("ssm", "get-command-invocation", command_id=command, instance_id=instance)
        except RuntimeError as exc:
            if "InvocationDoesNotExist" not in str(exc):
                raise
            result = {}
        if result.get("Status") in ("Success", "Failed", "TimedOut", "Cancelled"):
            return result["Status"]
        time.sleep(2)
    return "Unknown"


# Stops a retired machine's SSH server taking new connections. Its unit stops only the listener (KillMode=process), so
# sessions already open, including calls still running, continue. Undo with `systemctl start ssh.socket`.
REFUSE_NEW_CONNECTIONS = "systemctl show ssh.service -p KillMode | grep -qx KillMode=process && systemctl stop ssh.socket ssh.service"


def record_connection(shared, instance):
    temporary = shared.with_suffix(".tmp")
    temporary.write_text(json.dumps({"instance": instance}))
    temporary.replace(shared)   # clients never read half a record


def handover(region, active, retired, api):
    """Move this laptop's lanes to the active machine. Every lane's client, from any branch, reuses the connection the
    shared record names while it is alive, so promotion opens one to the active machine and records it, then keeps
    closing connections to retired machines and restoring the record for the handover window, which covers calls
    that chose the old machine just before the switch and reopen its connection or record it. A caller still queued
    behind one of those then can't reopen it at all: the retired machines stop taking new SSH connections."""
    cache = cache_directory()
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    shared = cache / f"connection-{region}.json"
    retired = set(retired)
    open_connection(cache, region, active, api, remember=False)
    for second in range(HANDOVER_SECONDS + 1):
        try:
            recorded = json.loads(shared.read_text()).get("instance")
        except (FileNotFoundError, ValueError, AttributeError):
            recorded = None
        if recorded != active:
            if recorded:
                retired.add(recorded)   # whatever lanes used before, retired or not, stops taking calls
            record_connection(shared, active)
        for instance in sorted(retired):
            stop_connection(cache, region, instance)
        if second < HANDOVER_SECONDS:
            time.sleep(1)
    for instance in sorted(retired):
        if ssm_run(api, instance, REFUSE_NEW_CONNECTIONS) != "Success":
            raise RuntimeError(f"The retired test box {instance} still takes new SSH connections; re-run --promote")
    record_connection(shared, active)
    if not all([stop_connection(cache, region, instance) for instance in sorted(retired)]):
        raise RuntimeError("This laptop's connection to a retired test box still takes calls; re-run --promote")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="read-only validation of the existing machine; never start or bootstrap it")
    mode.add_argument("--standby", action="store_true", help="provision (or re-check) a replacement beside the active machine; clients reach it only with --standby")
    mode.add_argument("--promote", action="store_true", help="make the running standby the active machine and retire the old one")
    args = parser.parse_args()
    read_only = args.check or args.promote
    purpose = STANDBY if args.standby else ACTIVE
    created = []

    def aws(service, operation, **kwargs):
        cmd = ["aws", "--region", args.region, service, operation, "--output", "json", "--no-cli-pager"]
        for key, value in kwargs.items():
            flag = "--" + key.replace("_", "-")
            if isinstance(value, bool):
                cmd.append(flag if value else "--no-" + key.replace("_", "-"))
            else:
                cmd.extend([flag, json.dumps(value) if isinstance(value, (dict, list)) else str(value)])
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"{service} {operation}: {result.stderr.strip()}")
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def optional(service, operation, **kwargs):
        try:
            return aws(service, operation, **kwargs)
        except RuntimeError as exc:
            if "NoSuchEntity" in str(exc):
                return None
            raise

    def owned(tags):
        return all(t in tags for t in TAGS)

    def bootstrap_and_wait(instance):
        # The same payload can repair an interrupted bootstrap or apply updated tool pins.
        payload = "set -eu\ncloud-init status --wait >/dev/null 2>&1 || true\n"
        assets = {name: (HERE / name).read_bytes() for name in ("bootstrap.sh", "lane-exec.py")}
        assets["cvc5.sha256"] = (HERE.parent / "cvc5.sha256").read_bytes()
        version = hashlib.sha256(b"".join(assets.values())).hexdigest()
        payload += f"if test -f /opt/testbox/ready && test \"$(cat /opt/testbox/bootstrap-version 2>/dev/null)\" = {version}; then exit 0; fi\n"
        # Stop admitting new runs, drain existing shared leases, then replace assets. Running lanes hold their
        # shared lease until they finish, so the drain gives up in time to report a failed setup within SSM's
        # 30-minute limit: leaving without readiness records one, and runs then exit 78 instead of 75.
        payload += "rm -f /opt/testbox/ready\n"
        payload += "trap 'test -f /opt/testbox/ready || touch /opt/testbox/bootstrap-failed' EXIT\n"
        payload += "exec 9>/opt/testbox/bootstrap.lock\nflock -x -w 1500 9\n"
        for name, data in assets.items():
            encoded = base64.b64encode(data).decode()
            payload += f"echo '{encoded}' | base64 -d > /opt/testbox/{name}\n"
        payload += "TESTBOX_BOOTSTRAP_LOCKED=1 bash /opt/testbox/bootstrap.sh\n"
        payload += f"echo '{version}' > /opt/testbox/bootstrap-version\n"
        deadline = time.monotonic() + 1800
        command = None
        last_notice = 0
        while time.monotonic() < deadline:
            if not command:
                status = aws("ssm", "describe-instance-information", filters=[{"Key": "InstanceIds", "Values": [instance]}])["InstanceInformationList"]
                if status and status[0]["PingStatus"] == "Online":
                    command = aws("ssm", "send-command", instance_ids=[instance], document_name="AWS-RunShellScript", timeout_seconds=1800,
                                  parameters={"commands": [payload], "executionTimeout": ["1800"]})["Command"]["CommandId"]
            else:
                try:
                    result = aws("ssm", "get-command-invocation", command_id=command, instance_id=instance)
                except RuntimeError as exc:
                    if "InvocationDoesNotExist" not in str(exc):
                        raise
                    result = {}
                if result.get("Status") == "Success":
                    print("Test box ready: bootstrap and toolchain completed", flush=True)
                    return
                if result.get("Status") in ("Failed", "TimedOut", "Cancelled"):
                    raise RuntimeError("Bootstrap failed: " + result.get("StandardOutputContent", "")[-2000:] + result.get("StandardErrorContent", "")[-2000:])
            if time.monotonic() - last_notice > 30:
                print("Waiting for SSM/bootstrap (up to 30 minutes)...", flush=True)
                last_notice = time.monotonic()
            time.sleep(5)
        raise RuntimeError("SSM/bootstrap did not become ready within 30 minutes")

    role = profile = NAME
    group = instance = None
    try:
        existing = optional("iam", "get-role", role_name=role)
        if existing:
            role_info = existing["Role"]
            if not owned(role_info.get("Tags", [])):
                raise RuntimeError("Refusing an existing IAM role without this project's ownership tags")
        else:
            if read_only:
                raise RuntimeError("Test box role is missing")
            role_info = aws("iam", "create-role", role_name=role, tags=TAGS,
                assume_role_policy_document={"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]})["Role"]
            created.append("role")
            aws("iam", "put-role-policy", role_name=role, policy_name=SESSION_POLICY_NAME, policy_document=SESSION_POLICY)
        policies = aws("iam", "list-attached-role-policies", role_name=role)["AttachedPolicies"]
        inline = aws("iam", "list-role-policies", role_name=role)["PolicyNames"]
        if policies or inline.count(SESSION_POLICY_NAME) != 1:
            raise RuntimeError("Test box role must have the inline session policy and no managed policies")
        for name in inline:
            if name == SESSION_POLICY_NAME:
                continue
            statements = aws("iam", "get-role-policy", role_name=role, policy_name=name)["PolicyDocument"].get("Statement", [])
            statements = statements if isinstance(statements, list) else [statements]
            if not statements or any(statement.get("Effect") != "Deny" for statement in statements):
                raise RuntimeError(f"Test box role's other inline policy {name} must only deny; only the session policy may allow")
        document = aws("iam", "get-role-policy", role_name=role, policy_name=SESSION_POLICY_NAME)["PolicyDocument"]
        # IAM may reorder actions, but no extra action, statement, condition or resource is accepted.
        def canonical(value):
            if isinstance(value, dict):
                return {k: canonical(v) for k, v in value.items()}
            if isinstance(value, list):
                return sorted((canonical(v) for v in value), key=lambda v: json.dumps(v, sort_keys=True))
            return value
        if canonical(document) != canonical(SESSION_POLICY):
            raise RuntimeError("Test box inline session policy differs from the required document")
        existing = optional("iam", "get-instance-profile", instance_profile_name=profile)
        if existing:
            profile_info = existing["InstanceProfile"]
            if not owned(profile_info.get("Tags", [])):
                raise RuntimeError("Refusing an existing instance profile without ownership tags")
            roles = profile_info["Roles"]
            if len(roles) != 1 or roles[0].get("RoleName") != role or roles[0].get("Arn") != role_info["Arn"]:
                raise RuntimeError("Instance profile must hold exactly the expected role by name and ARN")
        else:
            if read_only:
                raise RuntimeError("Test box instance profile is missing")
            profile_info = aws("iam", "create-instance-profile", instance_profile_name=profile, tags=TAGS)["InstanceProfile"]
            created.append("profile")
            aws("iam", "add-role-to-instance-profile", instance_profile_name=profile, role_name=role)
            created.append("profile-role")
            time.sleep(10)
        vpcs = aws("ec2", "describe-vpcs", filters=[{"Name": "is-default", "Values": ["true"]}])["Vpcs"]
        if len(vpcs) != 1:
            raise RuntimeError("Expected one default VPC; none will be created")
        vpc = vpcs[0]["VpcId"]
        groups = aws("ec2", "describe-security-groups", filters=[{"Name": "vpc-id", "Values": [vpc]}, {"Name": "group-name", "Values": [NAME]}])["SecurityGroups"]
        if groups:
            if len(groups) != 1 or not owned(groups[0].get("Tags", [])):
                raise RuntimeError("Refusing a security group without ownership tags")
            group = groups[0]["GroupId"]
            if groups[0]["IpPermissions"]:
                raise RuntimeError("Test box security group has inbound rules; refusing it")
        else:
            if read_only:
                raise RuntimeError("Test box security group is missing")
            group = aws("ec2", "create-security-group", group_name=NAME, description="Disposable agent tests; SSM access only; no inbound", vpc_id=vpc,
                        tag_specifications=[{"ResourceType": "security-group", "Tags": TAGS}])["GroupId"]
            created.append("group")
        def tagged(purpose, many=False):
            found = aws("ec2", "describe-instances", filters=[{"Name": "tag:Project", "Values": ["claude-desk"]}, {"Name": "tag:Purpose", "Values": [purpose]}, {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}])
            instances = [i for r in found["Reservations"] for i in r["Instances"]]
            if len(instances) > 1 and not many:
                raise RuntimeError(f"Multiple instances tagged {purpose} in region; refusing ambiguous setup")
            return instances

        def require_configured(i):
            if i["InstanceType"] != INSTANCE_TYPE or i["MetadataOptions"]["HttpTokens"] != "required" or [s["GroupId"] for s in i["SecurityGroups"]] != [group]:
                raise RuntimeError("Existing test box differs from required instance, metadata or network configuration")
            if i.get("IamInstanceProfile", {}).get("Arn") != profile_info["Arn"]:
                raise RuntimeError("Existing test box has an unexpected attached instance profile ARN")

        def require_ready(instance):
            # Every lane's next call lands here: refuse a standby whose setup is still running or failed.
            if ssm_run(aws, instance, "test -f /opt/testbox/ready && ! test -f /opt/testbox/bootstrap-failed") != "Success":
                raise RuntimeError("The standby isn't ready (its setup is running or failed); re-run --standby")

        if args.promote:
            # The tags record the handover, so a re-run after any interruption finishes it.
            standby, active = tagged(STANDBY), tagged(ACTIVE)
            old_ids = [i["InstanceId"] for i in active] if standby else []
            if standby:
                if standby[0]["State"]["Name"] != "running":
                    raise RuntimeError("The standby isn't running; start it with --standby and prove it with tools/testbox/run --standby")
                require_configured(standby[0])
                require_ready(standby[0]["InstanceId"])

                def retag(i, value):
                    resources = [i["InstanceId"]] + [m["Ebs"]["VolumeId"] for m in i.get("BlockDeviceMappings", []) if "Ebs" in m]
                    resources += [n["NetworkInterfaceId"] for n in i.get("NetworkInterfaces", [])]
                    aws("ec2", "create-tags", resources=resources, tags=[{"Key": "Purpose", "Value": value}])
                # Retire first: an interruption between the two leaves no active machine, which a re-run repairs, never two.
                for old in active:
                    retag(old, RETIRED)
                retag(standby[0], ACTIVE)
                active = standby
            # Known before the retag too: a tag query right after it may not see the change yet.
            retired = sorted(set(old_ids) | {i["InstanceId"] for i in tagged(RETIRED, many=True)})
            if not standby and not retired:
                raise RuntimeError("No standby to promote: provision one with --standby and prove it with tools/testbox/run --standby")
            if not active or active[0]["State"]["Name"] != "running":
                raise RuntimeError("No running active test box to hand over to; re-run --promote once it runs")
            require_configured(active[0])
            print(f"Handing this laptop's lanes over to {active[0]['InstanceId']} ({args.region}) for {HANDOVER_SECONDS} seconds...", flush=True)
            handover(args.region, active[0]["InstanceId"], retired, aws)
            print(f"Promoted {active[0]['InstanceId']} ({args.region}) to the active test box; retired: {', '.join(retired) or 'none'}. "
                  "Lanes move on their next call; terminate a retired box once no call runs on it (docs/testbox.md).")
            return
        instances = tagged(purpose)
        if instances:
            i = instances[0]
            instance = i["InstanceId"]
            require_configured(i)
            if args.check:
                print("Test box check: expected profile ARN, role ARN and exact inline session policy; other inline policies only deny; "
                      "no managed policies; instance/network configuration valid")
                return
            aws("ec2", "modify-instance-attribute", instance_id=instance, disable_api_termination={"Value": True})
            if i["State"]["Name"] == "stopped":
                aws("ec2", "start-instances", instance_ids=[instance])
            print(f"Existing {'standby ' if args.standby else ''}test box: {instance} ({args.region}); checking bootstrap version")
            bootstrap_and_wait(instance)
            return
        if args.check:
            raise RuntimeError("Test box instance is missing")
        image = aws("ssm", "get-parameter", name="/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id")["Parameter"]["Value"]
        subnets = aws("ec2", "describe-subnets", filters=[{"Name": "vpc-id", "Values": [vpc]}, {"Name": "default-for-az", "Values": ["true"]}])["Subnets"]
        offerings = aws("ec2", "describe-instance-type-offerings", location_type="availability-zone", filters=[{"Name": "instance-type", "Values": [INSTANCE_TYPE]}])["InstanceTypeOfferings"]
        zones = {o["Location"] for o in offerings}
        subnets = [s for s in subnets if s["AvailabilityZone"] in zones and s["MapPublicIpOnLaunch"]]
        if not subnets:
            raise RuntimeError(f"No public default subnet offers {INSTANCE_TYPE}; SSM needs internet egress")
        # SSM owns the single bootstrap/version path after cloud-init completes.
        user_data = "#!/bin/bash\nset -eu\ninstall -d -o root -g root /opt/testbox\n"
        # Only retry capacity errors across AZs. ClientToken prevents duplicate launches on retry.
        for subnet in subnets:
            try:
                response = aws("ec2", "run-instances", image_id=image, instance_type=INSTANCE_TYPE, count=1,
                    client_token=f"desk-testbox-{uuid.uuid4()}",
                    iam_instance_profile={"Name": profile},
                    network_interfaces=[{"DeviceIndex": 0, "SubnetId": subnet["SubnetId"], "Groups": [group], "AssociatePublicIpAddress": True}],
                    metadata_options={"HttpTokens": "required", "HttpPutResponseHopLimit": 1}, disable_api_termination=True,
                    block_device_mappings=[{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 1024, "VolumeType": "gp3", "Iops": 16000, "Throughput": 1000, "Encrypted": True, "DeleteOnTermination": True}}],
                    tag_specifications=[{"ResourceType": resource, "Tags": [TAGS[0], {"Key": "Purpose", "Value": purpose}, {"Key": "Name", "Value": NAME}]} for resource in ("instance", "volume", "network-interface")],
                    user_data=user_data)
                instance = response["Instances"][0]["InstanceId"]
                created.append("instance")
                break
            except RuntimeError as exc:
                if "InsufficientInstanceCapacity" not in str(exc):
                    raise
        if not instance:
            raise RuntimeError("No capacity in default VPC availability zones")
        print(f"Created {'standby ' if args.standby else ''}test box: {instance} ({args.region}), security group {group}, role/profile {role}")
        print("Bootstrap runs through SSM after cloud-init. Log: /var/log/desk-testbox-bootstrap.log", flush=True)
        bootstrap_and_wait(instance)
    except BaseException:
        # Roll back only resources this invocation created; pre-existing resources are preserved.
        print(f"Provisioning failed. Created in this invocation: {created}", file=sys.stderr)
        operations = {
            "instance": [("ec2", "modify-instance-attribute", {"instance_id": instance, "disable_api_termination": {"Value": False}}),
                         ("ec2", "terminate-instances", {"instance_ids": [instance]}),
                         ("ec2", "wait", {"instance_terminated": instance})],
            "group": [("ec2", "delete-security-group", {"group_id": group})],
            "profile-role": [("iam", "remove-role-from-instance-profile", {"instance_profile_name": profile, "role_name": role})],
            "profile": [("iam", "delete-instance-profile", {"instance_profile_name": profile})],
            "role": [("iam", "delete-inline-policies", {}), ("iam", "delete-role", {"role_name": role})],
        }
        # Association creation can fail. Track it separately and attempt every cleanup even
        # if an earlier cleanup fails; an absent association must not prevent deletion.
        for resource in reversed(created):
            for service, operation, params in operations[resource]:
                try:
                    if operation == "wait":
                        subprocess.run(["aws", "--region", args.region, "ec2", "wait", "instance-terminated", "--instance-ids", instance], check=True)
                    elif operation == "delete-inline-policies":
                        # Our session policy and any the account added: delete-role fails while one remains.
                        for name in (optional("iam", "list-role-policies", role_name=role) or {}).get("PolicyNames", []):
                            optional("iam", "delete-role-policy", role_name=role, policy_name=name)
                    else:
                        optional(service, operation, **params)
                    print(f"Rolled back {resource}: {operation}", file=sys.stderr)
                except Exception as cleanup_error:
                    print(f"Cleanup incomplete for {resource}: {cleanup_error}; instance={instance}, group={group}, role/profile={role}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
