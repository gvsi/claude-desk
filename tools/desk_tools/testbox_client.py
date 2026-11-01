"""SSM/SSH transport. Only explicitly selected source files leave the worktree."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

from desk_tools.testbox import Timings, lane_name, selected_files


def capture(cmd, **kwargs):
    return subprocess.check_output(cmd, text=True, **kwargs).strip()


def cleanup_script(base: str) -> str:
    # Prune only formerly synced sources and now-empty parents. Build directories survive.
    return """import json
from pathlib import Path
base = Path(BASE)
repo = (base / 'repo').resolve()
previous = json.loads((base / 'manifest.json').read_text()) if (base / 'manifest.json').exists() else []
current = json.loads((base / 'transfer/manifest.json').read_text())
for name in set(previous) - set(current):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts:
        continue
    path = repo / relative
    parent = path.parent
    resolved = parent.resolve()
    if resolved != repo and repo not in resolved.parents:
        continue
    if path.is_symlink() or path.is_file():
        path.unlink()
    while parent != repo:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
""".replace('BASE', repr(base))


def source_files(root: Path) -> list[str]:
    raw = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root)
    paths = raw.decode().split("\0")
    result = []
    for path in selected_files(paths):
        source = root / path
        resolved = source.resolve()
        if root not in resolved.parents or not selected_files([resolved.relative_to(root).as_posix()]):
            continue
        if source.is_symlink():
            # Preserve relative links within the selected source tree, never absolute host paths.
            if not os.path.isabs(os.readlink(source)):
                result.append(path)
        elif source.is_file():
            result.append(path)
    return sorted(set(result))


def source_state(root: Path, files: list[str]) -> dict[str, str]:
    """Compare bytes and permissions, including edits that preserve size and mtime."""
    state = {}
    for name in selected_files(files):
        path = root / name
        try:
            mode = path.lstat().st_mode
            if path.is_symlink():
                # Symlink permissions differ on macOS/Linux and rsync does not preserve them.
                mode = "symlink"
                content = os.readlink(path).encode()
            else:
                content = path.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            continue
        state[name] = f"{mode}:{hashlib.sha256(content).hexdigest()}"
    return state


def changed_files(current: dict[str, str], previous: dict[str, str]) -> list[str]:
    return sorted(name for name, value in current.items() if previous.get(name) != value)


def lane_state_script(base: str) -> str:
    # Inspect actual remote bytes under the lane lock, not a client-side assumption. Commands
    # may edit/delete source files, and a different client may have synchronized this lane.
    return """import json, sys
from pathlib import Path
base = Path(BASE)
sys.path.insert(0, str(base / 'repo/tools'))
try:
    from desk_tools.testbox_client import source_state
    files = json.loads((base / 'manifest.json').read_text())
    sources = source_state(base / 'repo', files)
except (ImportError, FileNotFoundError):
    sources = {}
signature = (base / 'git-signature').read_text() if (base / 'git-signature').exists() else ''
print(json.dumps({'git': signature, 'sources': sources}), flush=True)
""".replace('BASE', repr(base))


def control_path(cache: Path, region: str, instance: str) -> Path:
    return cache / (hashlib.sha256(("v2:" + region + instance).encode()).hexdigest()[:20] + ".sock")


def warm_instance(cache: Path, region: str) -> str | None:
    try:
        instance = json.loads((cache / f"connection-{region}.json").read_text())["instance"]
    except (FileNotFoundError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(instance, str) or not re.fullmatch(r"i-[0-9a-f]{8,17}", instance):
        return None
    result = subprocess.run(["ssh", "-S", str(control_path(cache, region, instance)), "-O", "check", "ubuntu@" + instance], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return instance if result.returncode == 0 else None


def create_bundle(root: Path, bundle: Path, previous: str) -> bool:
    """Ship only objects absent from the remote's last imported HEAD/main histories."""
    known = []
    for revision in previous.split(":"):
        if re.fullmatch(r"[0-9a-f]{40,64}", revision) and subprocess.run(
            ["git", "cat-file", "-e", revision + "^{commit}"], cwd=root,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0:
            known.append(revision)
    refs = ["HEAD", "refs/remotes/origin/main"] + ["^" + revision for revision in known]
    if capture(["git", "rev-list", "--count", *refs], cwd=root) == "0":
        return False  # Ref rewinds need no pack; the remote already has their objects.
    subprocess.run(["git", "bundle", "create", str(bundle), *refs], cwd=root, check=True, stdout=subprocess.DEVNULL)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=os.environ.get("TESTBOX_REGION", "us-east-1"))
    parser.add_argument("--ci", action="store_const", const="1", help="explicitly set CI on the remote run")
    parser.add_argument("--lane", help="scratch lane override; normally the worktree directory name")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command.pop(0)
    if not args.command:
        parser.error("give a command, for example: tools/testbox/run make kernel")
    # This is a convenience guard, not a sandbox for arbitrary shell programs. No keys are sent.
    forbidden = {"tier2", "evals-tier2", "evals-soft-promise", "evals-reviewer", "evals-latency"}
    words = re.findall(r"[A-Za-z0-9_-]+", " ".join(args.command))
    if forbidden.intersection(words) or "make dev" in " ".join(args.command):
        parser.error("model/secret-dependent jobs and make dev stay on the laptop")
    os.environ["PATH"] = str(Path.home() / ".local/bin") + os.pathsep + os.environ["PATH"]
    root = Path(capture(["git", "rev-parse", "--show-toplevel"]))
    lane = lane_name(args.lane or str(root))
    cache = Path.home() / ".cache/desk-testbox"
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache.chmod(0o700)
    # Serialize callers for the same lane before changing its worktree or database.
    with (cache / f"{args.region}-{lane}.lock").open("w") as lock:
        timing = Timings("client")
        fcntl.flock(lock, fcntl.LOCK_EX)
        timing.mark("local_lock")
        return run(args, root, lane, cache)


def run(args, root, lane, cache):
    start = time.monotonic()
    timing = Timings("client")
    aws = ["aws", "--region", args.region, "--no-cli-pager"]
    def api(service, operation, **params):
        cmd = aws + [service, operation, "--output", "json"]
        for k, v in params.items():
            cmd += ["--" + k.replace("_", "-"), json.dumps(v) if isinstance(v, (list, dict)) else str(v)]
        return json.loads(capture(cmd))

    instance = warm_instance(cache, args.region)
    if instance is None:
        found = api("ec2", "describe-instances", filters=[{"Name": "tag:Project", "Values": ["claude-desk"]}, {"Name": "tag:Purpose", "Values": ["agent-test-box"]}, {"Name": "instance-state-name", "Values": ["running"]}])
        instances = [i for r in found["Reservations"] for i in r["Instances"]]
        if len(instances) != 1:
            raise RuntimeError(f"Expected one running test box in {args.region}, found {len(instances)}")
        instance = instances[0]["InstanceId"]
    timing.mark("discovery")
    print(f"testbox: connecting in {args.region}; lane={lane}", flush=True)
    # Reuse one encrypted SSM stream for SSH/rsync. No inbound port is opened.
    with (cache / f"connection-{instance}.lock").open("w") as connection_lock:
        fcntl.flock(connection_lock, fcntl.LOCK_EX)
        timing.mark("connection_lock")
        key = cache / "id_ed25519"
        if not key.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "desk-testbox-client", "-f", str(key)], check=True)
        control = control_path(cache, args.region, instance)
        proxy = shlex.join(aws + ["ssm", "start-session", "--target", instance, "--document-name", "AWS-StartSSHSession", "--parameters", "portNumber=%p"])
        ssh_opts = ["-o", f"ProxyCommand={proxy}", "-o", "ControlMaster=auto", "-o", "ControlPersist=3600", "-o", f"ControlPath={control}", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={cache / 'known_hosts'}", "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-i", str(key)]
        host = "ubuntu@" + instance
        check = subprocess.run(["ssh", *ssh_opts, "-O", "check", host], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if check.returncode:
            public = key.with_suffix(".pub").read_text().strip()
            # Trust the host key delivered over authenticated SSM, never trust-on-first-use over IP.
            script = "set -eu; install -d -o ubuntu -g ubuntu -m 700 /home/ubuntu/.ssh; "
            script += f"grep -qxF {shlex.quote(public)} /home/ubuntu/.ssh/authorized_keys || echo {shlex.quote(public)} >> /home/ubuntu/.ssh/authorized_keys; "
            script += "chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys; chmod 600 /home/ubuntu/.ssh/authorized_keys; cat /etc/ssh/ssh_host_ed25519_key.pub"
            command = api("ssm", "send-command", instance_ids=[instance], document_name="AWS-RunShellScript", parameters={"commands": [script]})["Command"]["CommandId"]
            deadline = time.monotonic() + 180
            while True:
                try:
                    result = api("ssm", "get-command-invocation", command_id=command, instance_id=instance)
                except subprocess.CalledProcessError:
                    result = {}
                if result.get("Status") == "Success":
                    break
                if result.get("Status") in {"Failed", "Cancelled", "TimedOut"} or time.monotonic() > deadline:
                    raise RuntimeError("SSM could not authorize SSH: " + result.get("StandardErrorContent", "timeout"))
                time.sleep(2)
            host_key = result["StandardOutputContent"].strip().split()
            if host_key[:1] != ["ssh-ed25519"] or len(host_key) < 2:
                raise RuntimeError("SSM did not return the SSH host key")
            with (cache / "known_hosts").open("a") as known:
                known.write(f"{instance} {host_key[0]} {host_key[1]}\n")
        # A separate session prevents one caller's process-group cleanup killing other lanes.
        if check.returncode:
            subprocess.run(["ssh", *ssh_opts, "-MNf", host], check=True, start_new_session=True)
        (cache / f"connection-{args.region}.json").write_text(json.dumps({"instance": instance}))
    ssh = ["ssh", *ssh_opts, host]
    timing.mark("connection")
    base = f"/srv/testbox/lanes/{lane}"
    # Remote flock covers synchronization as well as execution, including different client hosts.
    transaction = "python3 -c " + shlex.quote(lane_state_script(base)) + f"; read -r start || exit 130; exec sudo /opt/testbox/lane-exec.py {lane} python3 {base}/repo/tools/testbox/worker.py {base}"
    prepare = f"test -f /opt/testbox/ready || exit 75; mkdir -p {base}/repo {base}/transfer; flock {base}/lock sh -c "
    holder = subprocess.Popen(ssh + [prepare + shlex.quote(transaction)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    try:
        line = holder.stdout.readline()
        if not line:
            raise RuntimeError("Could not lock the remote lane")
        remote = json.loads(line)
        timing.mark("remote_lock")
        with tempfile.TemporaryDirectory(prefix="desk-testbox-") as tmp:
            tmp = Path(tmp)
            files = source_files(root)
            state = source_state(root, files)
            delta = changed_files(state, remote["sources"])
            timing.mark("file_list")
            print(f"testbox: syncing {len(delta)} of {len(files)} source files and Git HEAD", flush=True)
            (tmp / "manifest.json").write_text(json.dumps(files))
            (tmp / "files").write_bytes(b"\0".join(p.encode() for p in delta) + (b"\0" if delta else b""))
            head = capture(["git", "rev-parse", "HEAD"], cwd=root)
            main_ref = capture(["git", "rev-parse", "refs/remotes/origin/main"], cwd=root)
            signature = head + ":" + main_ref
            old = remote["git"]
            timing.mark("git_state")
            bundled = False
            if old != signature:
                bundled = create_bundle(root, tmp / "source.bundle", old)
            timing.mark("git_bundle")
            (tmp / "request.json").write_text(json.dumps({"lane": lane, "command": args.command, "ci": args.ci, "head": head, "main": main_ref, "signature": signature, "bundle": bundled}))
            rsync = shutil.which("rsync")
            if not rsync:
                raise RuntimeError("rsync is required (macOS openrsync is supported)")
            transport = shlex.join(["ssh", *ssh_opts])
            # Protocol 29 works with macOS openrsync. No .git, environment, ignored files or build artifacts.
            subprocess.run([rsync, "-rlpt", "-e", transport, str(tmp) + "/", host + ":" + base + "/transfer/"], check=True)
            timing.mark("request_transfer")
            # Delete stale source paths before sync, including file-to-directory branch changes.
            subprocess.run(ssh + ["python3 -c " + shlex.quote(cleanup_script(base))], check=True)
            timing.mark("source_cleanup")
            if delta:
                # Content hashes already selected changed paths; force transfer even when size
                # and mtime match. This also repairs sources altered by a previous remote job.
                subprocess.run([rsync, "-rlpt", "--ignore-times", "--from0", "--files-from=" + str(tmp / "files"), "-e", transport, str(root) + "/", host + ":" + base + "/repo/"], check=True)
            timing.mark("source_transfer")
            print(f"testbox: sync complete ({time.monotonic() - start:.2f}s)", flush=True)
            # Install the runner from this synced tree, so uncommitted client changes are testable.
            holder.stdin.write("run\n")
            holder.stdin.flush()
            holder.stdin.close()
            for line in holder.stdout:
                print(line, end="", flush=True)
            code = holder.wait()
            timing.mark("remote_execution")
            print(f"testbox: lane={lane} exit={code} elapsed={time.monotonic() - start:.2f}s", flush=True)
            return code
    finally:
        if not holder.stdin.closed:
            holder.stdin.close()
        if holder.poll() is None:
            holder.terminate()
        holder.wait(timeout=15)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"testbox: {exc}", file=sys.stderr)
        sys.exit(1)
