"""Tag-discovered, transactional provisioning; AWS CLI supplies credentials, never this repo."""
import argparse
import base64
import json
import pathlib
import subprocess
import sys
import time
import hashlib
import uuid

HERE = pathlib.Path(__file__).resolve().parent
TAGS = [{"Key": "Project", "Value": "claude-desk"}, {"Key": "Purpose", "Value": "agent-test-box"}]
NAME = "claude-desk-test-box"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", required=True)
    args = parser.parse_args()
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
        for name, data in assets.items():
            encoded = base64.b64encode(data).decode()
            payload += f"echo '{encoded}' | base64 -d > /opt/testbox/{name}\n"
        payload += "bash /opt/testbox/bootstrap.sh\n"
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
            if not owned(existing["Role"].get("Tags", [])):
                raise RuntimeError("Refusing an existing IAM role without this project's ownership tags")
        else:
            aws("iam", "create-role", role_name=role, tags=TAGS,
                assume_role_policy_document={"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]})
            created.append("role")
        policies = aws("iam", "list-attached-role-policies", role_name=role)["AttachedPolicies"]
        if any(p["PolicyName"] != "AmazonSSMManagedInstanceCore" for p in policies) or aws("iam", "list-role-policies", role_name=role)["PolicyNames"]:
            raise RuntimeError("Test box role has unexpected policies; refusing broader privileges")
        aws("iam", "attach-role-policy", role_name=role, policy_arn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
        existing = optional("iam", "get-instance-profile", instance_profile_name=profile)
        if existing:
            if not owned(existing["InstanceProfile"].get("Tags", [])):
                raise RuntimeError("Refusing an existing instance profile without ownership tags")
            roles = existing["InstanceProfile"]["Roles"]
            if roles and [r["RoleName"] for r in roles] != [role]:
                raise RuntimeError("Instance profile holds an unexpected role")
        else:
            aws("iam", "create-instance-profile", instance_profile_name=profile, tags=TAGS)
            created.append("profile")
            roles = []
        if not roles:
            aws("iam", "add-role-to-instance-profile", instance_profile_name=profile, role_name=role)
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
            group = aws("ec2", "create-security-group", group_name=NAME, description="Disposable agent tests; SSM access only; no inbound", vpc_id=vpc,
                        tag_specifications=[{"ResourceType": "security-group", "Tags": TAGS}])["GroupId"]
            created.append("group")
        found = aws("ec2", "describe-instances", filters=[{"Name": "tag:Project", "Values": ["claude-desk"]}, {"Name": "tag:Purpose", "Values": ["agent-test-box"]}, {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}])
        instances = [i for r in found["Reservations"] for i in r["Instances"]]
        if len(instances) > 1:
            raise RuntimeError("Multiple test boxes in region; refusing ambiguous setup")
        if instances:
            i = instances[0]
            instance = i["InstanceId"]
            if i["InstanceType"] != "c8g.24xlarge" or i["MetadataOptions"]["HttpTokens"] != "required" or [s["GroupId"] for s in i["SecurityGroups"]] != [group]:
                raise RuntimeError("Existing test box differs from required instance, metadata or network configuration")
            aws("ec2", "modify-instance-attribute", instance_id=instance, disable_api_termination={"Value": True})
            if i["State"]["Name"] == "stopped":
                aws("ec2", "start-instances", instance_ids=[instance])
            print(f"Existing test box: {instance} ({args.region}); checking bootstrap version")
            bootstrap_and_wait(instance)
            return
        image = aws("ssm", "get-parameter", name="/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id")["Parameter"]["Value"]
        subnets = aws("ec2", "describe-subnets", filters=[{"Name": "vpc-id", "Values": [vpc]}, {"Name": "default-for-az", "Values": ["true"]}])["Subnets"]
        offerings = aws("ec2", "describe-instance-type-offerings", location_type="availability-zone", filters=[{"Name": "instance-type", "Values": ["c8g.24xlarge"]}])["InstanceTypeOfferings"]
        zones = {o["Location"] for o in offerings}
        subnets = [s for s in subnets if s["AvailabilityZone"] in zones and s["MapPublicIpOnLaunch"]]
        if not subnets:
            raise RuntimeError("No public default subnet offers c8g.24xlarge; SSM needs internet egress")
        checksum = base64.b64encode((HERE.parent / "cvc5.sha256").read_bytes()).decode()
        launcher = base64.b64encode((HERE / "lane-exec.py").read_bytes()).decode()
        bootstrap = base64.b64encode((HERE / "bootstrap.sh").read_bytes()).decode()
        user_data = f"#!/bin/bash\nset -eu\nmkdir -p /opt/testbox\necho '{checksum}' | base64 -d > /opt/testbox/cvc5.sha256\necho '{bootstrap}' | base64 -d > /opt/testbox/bootstrap.sh\necho '{launcher}' | base64 -d > /opt/testbox/lane-exec.py\nbash /opt/testbox/bootstrap.sh\n"
        # Only retry capacity errors across AZs. ClientToken prevents duplicate launches on retry.
        for subnet in subnets:
            try:
                response = aws("ec2", "run-instances", image_id=image, instance_type="c8g.24xlarge", count=1,
                    client_token=f"desk-testbox-{uuid.uuid4()}",
                    iam_instance_profile={"Name": profile},
                    network_interfaces=[{"DeviceIndex": 0, "SubnetId": subnet["SubnetId"], "Groups": [group], "AssociatePublicIpAddress": True}],
                    metadata_options={"HttpTokens": "required", "HttpPutResponseHopLimit": 1}, disable_api_termination=True,
                    block_device_mappings=[{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 1024, "VolumeType": "gp3", "Iops": 16000, "Throughput": 1000, "Encrypted": True, "DeleteOnTermination": True}}],
                    tag_specifications=[{"ResourceType": resource, "Tags": TAGS + [{"Key": "Name", "Value": NAME}]} for resource in ("instance", "volume", "network-interface")],
                    user_data=user_data)
                instance = response["Instances"][0]["InstanceId"]
                created.append("instance")
                break
            except RuntimeError as exc:
                if "InsufficientInstanceCapacity" not in str(exc):
                    raise
        if not instance:
            raise RuntimeError("No capacity in default VPC availability zones")
        print(f"Created test box: {instance} ({args.region}), security group {group}, role/profile {role}")
        print("Bootstrap runs in cloud-init. Log: /var/log/desk-testbox-bootstrap.log", flush=True)
        bootstrap_and_wait(instance)
    except BaseException:
        # Roll back only resources this invocation created; pre-existing resources are preserved.
        print(f"Provisioning failed. Created in this invocation: {created}", file=sys.stderr)
        for resource in reversed(created):
            try:
                if resource == "instance":
                    aws("ec2", "modify-instance-attribute", instance_id=instance, disable_api_termination={"Value": False})
                    aws("ec2", "terminate-instances", instance_ids=[instance])
                    subprocess.run(["aws", "--region", args.region, "ec2", "wait", "instance-terminated", "--instance-ids", instance], check=True)
                elif resource == "group":
                    aws("ec2", "delete-security-group", group_id=group)
                elif resource == "profile":
                    aws("iam", "remove-role-from-instance-profile", instance_profile_name=profile, role_name=role)
                    aws("iam", "delete-instance-profile", instance_profile_name=profile)
                elif resource == "role":
                    aws("iam", "detach-role-policy", role_name=role, policy_arn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
                    aws("iam", "delete-role", role_name=role)
                print(f"Rolled back {resource}", file=sys.stderr)
            except Exception as cleanup_error:
                print(f"Cleanup incomplete for {resource}: {cleanup_error}; instance={instance}, group={group}, role/profile={role}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
