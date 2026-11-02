#!/usr/bin/python3
"""Root-owned launcher: each lane has its own loopback/ports and internet via a test bridge."""
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

# Accept this protocol version and the one before it, so from the next version on a client one
# version behind keeps working after a newer branch re-provisions the machine. Version 2 is the
# first one clients send; clients from before it send none and are refused, so only 2 is in use.
PROTOCOL_VERSION = 2
if os.environ.get("TESTBOX_PROTOCOL") not in {str(PROTOCOL_VERSION), str(PROTOCOL_VERSION - 1)}:
    raise SystemExit("update your branch's tools/testbox or re-provision")

lane = sys.argv[1]
call_id = sys.argv[2]
if not re.fullmatch(r"[0-9a-f]{32}", call_id):
    raise SystemExit("Invalid call ID")
unit = "desk-testbox-run-" + lane + "-" + call_id
process = None
def stop(signum, _frame):
    # Unwind process.wait's lock before the finally block reaps the launcher.
    raise SystemExit(128 + signum)
for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(signum, stop)
if not re.fullmatch(r"[a-z0-9_-]{1,41}", lane):
    raise SystemExit("Invalid lane name")
try:
    state = Path("/var/lib/desk-testbox")
    state.mkdir(exist_ok=True)
    with (state / "network.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = state / "networks.json"
        entries = json.loads(registry.read_text()) if registry.exists() else {}
        ns = "desk-" + lane
        if lane not in entries:
            number = len(entries) + 2
            address = str(ipaddress.IPv4Address("10.200.0.0") + number)
            entries[lane] = address
            registry.write_text(json.dumps(entries))
        address = entries[lane]
        if subprocess.run(["ip", "netns", "exec", ns, "true"], stderr=subprocess.DEVNULL).returncode:
            def run(*cmd):
                subprocess.run(cmd, check=True)
            suffix = hashlib.sha256(lane.encode()).hexdigest()[:10]
            host_link, peer = "dh" + suffix, "dn" + suffix
            run("ip", "netns", "add", ns)
            try:
                run("ip", "link", "add", host_link, "type", "veth", "peer", "name", peer)
                run("ip", "link", "set", host_link, "master", "testbox0")
                run("ip", "link", "set", host_link, "up")
                run("ip", "link", "set", peer, "netns", ns)
                run("ip", "-n", ns, "link", "set", "lo", "up")
                run("ip", "-n", ns, "addr", "add", address + "/16", "dev", peer)
                run("ip", "-n", ns, "link", "set", peer, "up")
                run("ip", "-n", ns, "route", "add", "default", "via", "10.200.0.1")
                # Deny metadata credentials and direct traffic to other lane addresses.
                run("ip", "netns", "exec", ns, "iptables", "-A", "OUTPUT", "-d", "169.254.169.254", "-j", "REJECT")
                run("ip", "netns", "exec", ns, "iptables", "-A", "OUTPUT", "-d", "10.200.0.1", "-p", "tcp", "--dport", "5432", "-j", "ACCEPT")
                run("ip", "netns", "exec", ns, "iptables", "-A", "OUTPUT", "-d", "10.200.0.0/16", "-j", "REJECT")
            except BaseException:
                subprocess.run(["ip", "netns", "delete", ns])
                subprocess.run(["ip", "link", "delete", host_link], stderr=subprocess.DEVNULL)
                raise
        resolv = Path("/etc/netns") / ns
        resolv.mkdir(parents=True, exist_ok=True)
        (resolv / "resolv.conf").write_text("nameserver 169.254.169.253\n")
    # Workers from older branches dial Postgres at 127.0.0.1:5432, so this forwarder relays the lane's loopback to
    # the bridge. Current workers connect to the bridge (10.200.0.1:5432) directly (#490). Tier 1's loopback-only
    # network guard patches Python sockets and never saw database connections, which go through libpq. Retire the
    # forwarder once no older branches remain.
    db_unit = "desk-testbox-db-" + lane
    if subprocess.run(["systemctl", "is-active", "--quiet", db_unit]).returncode:
        subprocess.run(["systemd-run", "--unit", db_unit, "--property=Restart=on-failure", "ip", "netns", "exec", ns,
                        "socat", "TCP4-LISTEN:5432,bind=127.0.0.1,reuseaddr,fork", "TCP4:10.200.0.1:5432"], check=True)
    # A completed test must not leave Vite, mock servers or subprocesses using the lane's ports.
    # A cgroup also catches descendants that start a new process group/session.
    process = subprocess.Popen(["systemd-run", "--quiet", "--collect", "--wait", "--pipe", "--service-type=exec",
                                "--unit", unit, "--property=KillMode=control-group", "--property=TimeoutStopSec=10s",
                                "ip", "netns", "exec", ns, "runuser", "-u", "ubuntu", "--", *sys.argv[3:]])
    sys.exit(process.wait())
finally:
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, signal.SIG_IGN)
    subprocess.run(["systemctl", "stop", unit + ".service"], stderr=subprocess.DEVNULL)
    if process is not None:
        process.wait()
