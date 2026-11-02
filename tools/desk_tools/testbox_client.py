"""SSM/SSH transport. Only explicitly selected source files leave the worktree."""
import argparse
import base64
import fcntl
import hashlib
import json
import inspect
import os
import re
from pathlib import Path
import shlex
import shutil
import signal
import uuid
import subprocess
import sys
import tempfile
import time

from desk_tools.testbox import RESERVED, Timings, lane_name, selected_files


PROTOCOL_VERSION = 2


def stage_runner(transfer: Path):
    """Carry the client's worker and imports, independent of the selected Git tree."""
    tools = Path(__file__).resolve().parents[1]
    for name in ('testbox/worker.py', 'testbox/database.py', 'desk_tools/__init__.py',
                 'desk_tools/testbox.py', 'desk_tools/testbox_client.py'):
        target = transfer / 'tools' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(tools / name, target)


def capture(cmd, **kwargs):
    return subprocess.check_output(cmd, text=True, **kwargs).strip()


def cleanup_script(base: str) -> str:
    # Reconcile selected nonignored sources; ignored build directories survive.
    return """import json, subprocess
from pathlib import Path, PurePosixPath
RESERVED = RESERVED_VALUE
SELECTED_FUNCTION
base = Path(BASE)
repo = (base / 'repo').resolve()
previous = json.loads((base / 'manifest.json').read_text()) if (base / 'manifest.json').exists() else []
pending = base / 'pending-manifest.json'
previous = set(previous) | set(json.loads(pending.read_text()) if pending.exists() else [])
current = set(json.loads((base / 'transfer/manifest.json').read_text()))
def remember(paths):
    temporary = base / 'pending-manifest.tmp'
    temporary.write_text(json.dumps(sorted(paths)))
    temporary.replace(pending)
# Remember everything before pruning: interruption during cleanup is recoverable too.
remember(previous | current)
# Tracked and staged paths too: a file a remote command created and staged (git add) stays in the tree when the
# worker resets the index, so it must be pruned here like an untracked one.
listed = subprocess.run(['git', '-C', str(repo), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
strays = set(selected_files(listed.stdout.decode().split('\\0'))) if listed.returncode == 0 else set()
for name in (previous | strays) - current:
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
remember(current)
""".replace('BASE', repr(base)).replace('RESERVED_VALUE', repr(RESERVED)).replace('SELECTED_FUNCTION', inspect.getsource(selected_files))


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
    return """import json, subprocess, sys
from pathlib import Path
base = Path(BASE)
sys.path.insert(0, str(base / 'transfer/tools'))
try:
    from desk_tools.testbox_client import source_state
    files = json.loads((base / 'manifest.json').read_text())
    sources = source_state(base / 'repo', files)
except (ImportError, FileNotFoundError):
    sources = {}
refs = subprocess.run(['git', '-C', str(base / 'repo'), 'rev-parse', 'HEAD', 'refs/remotes/origin/main'], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
signature = ':'.join(refs.stdout.splitlines()) if refs.returncode == 0 else ''
print(json.dumps({'git': signature, 'sources': sources}), flush=True)
""".replace('BASE', repr(base))


def new_lane_notice(remote: dict) -> str | None:
    """A lane with no repository on the machine yet sets everything up on this call, which takes minutes."""
    if remote["git"]:
        return None
    return ("testbox: setting up this lane on the test machine (its first call here: full sync, environment, kernel "
            "and database), about 5 minutes; it is reachable, so don't retry")


def transaction_script(base: str, command: list[str], cancel: list[str]) -> str:
    """Hold the lane until execution AND cancellation finish, including on client EOF."""
    return """import fcntl, os, select, signal, subprocess, sys, time
from pathlib import Path
base = Path(BASE)
process = None
def interrupted(signum, _frame):
    raise SystemExit(128 + signum)
for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(signum, interrupted)
with (base / 'lock').open('w') as lock:
    # Poll rather than block, so a caller that leaves while another call holds the lane stops waiting at once.
    # The client sends nothing until it has the lane state, so readable stdin here can only be its EOF.
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if select.select([0], [], [], 0.1)[0]:
                raise SystemExit(130)
    try:
        exec(STATE)
        # Read unbuffered: the same stream remains a lifetime lease after the start byte.
        start = b''
        while len(start) < 4:
            part = os.read(0, 4 - len(start))
            if not part:
                raise SystemExit(130)
            start += part
        if start != b'run\\n':
            raise SystemExit(130)
        process = subprocess.Popen(COMMAND, stdin=subprocess.DEVNULL, start_new_session=True)
        while process.poll() is None:
            if select.select([0], [], [], 0.1)[0]:
                if not os.read(0, 1024):
                    raise SystemExit(130)
        raise SystemExit(process.returncode)
    finally:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        if process is not None:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            # The cgroup also covers children that detached from the process group.
            subprocess.run(CANCEL, check=True, stdout=subprocess.DEVNULL)
""".replace('BASE', repr(base)).replace('STATE', repr(lane_state_script(base))).replace('COMMAND', repr(command)).replace('CANCEL', repr(cancel))


def prepare_script(base: str) -> str:
    """Remote shell prefix: admit a run only on a ready machine, holding the bootstrap lock shared for its whole life.
    The transaction script follows, quoted, after `python3 -c`. Bash carries on after a failed `exec` redirection,
    so each step fails closed explicitly: without the lock, bootstrap could change the machine under the run."""
    # Not ready: 78 when the last setup failed or was cut short, 75 while one may still be running.
    ready = "test -f /opt/testbox/ready || { test -f /opt/testbox/bootstrap-failed && exit 78; exit 75; }; "
    return (ready + "exec 8</opt/testbox/bootstrap.lock || exit 75; flock -s -w 30 8 || exit 75; "
            + ready + f"mkdir -p {base}/repo {base}/transfer; exec python3 -c ")


def replace_host_key(known_hosts: Path, instance: str, host_key: list[str]):
    if known_hosts.exists():
        subprocess.run(["ssh-keygen", "-R", instance, "-f", str(known_hosts)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with known_hosts.open("a") as known:
        known.write(f"{instance} {host_key[0]} {host_key[1]}\n")


def start_holder(command: list[str]) -> subprocess.Popen:
    """Open the remote lane holder. Binary pipes, so the command's output passes through byte for byte."""
    return subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)


def relay(holder, out) -> int:
    """Start the job, copy its stdout to out unchanged as it arrives, and return its exit status."""
    holder.stdin.write(b"run\n")
    holder.stdin.flush()
    while chunk := holder.stdout.read1(65536):
        out.write(chunk)
        out.flush()
    return holder.wait()


def release(holder, started):
    """Close the lease. Once "run" was sent, that tells the remote watchdog to stop this exact call: wait for its
    acknowledgement. Before it there is no remote job, and the remote end may itself still be waiting (for a busy
    lane or the bootstrap lock), so stop the holder at once; the remote sees the closed connection and gives up."""
    if not holder.stdin.closed:
        try:
            holder.stdin.close()
        except BrokenPipeError:
            pass
    if not started:
        holder.terminate()
        try:
            holder.wait(timeout=5)
        except subprocess.TimeoutExpired:
            holder.kill()
            holder.wait()
        return
    # Drain without writing: a closed caller stdout must not skip acknowledgement.
    while holder.stdout.read(65536):
        pass
    holder.wait()


NOT_READY = {75: "the test machine is bootstrapping, retry shortly",
             78: "the test machine's setup failed: re-run tools/testbox/provision.sh"}


def read_remote_state(holder):
    """The lane's state, or None when the machine isn't ready for runs; holder.wait() then gives the exit code."""
    line = holder.stdout.readline()
    if line:
        return json.loads(line)
    code = holder.wait()
    if code in NOT_READY:
        print("testbox: " + NOT_READY[code], file=sys.stderr)
        return None
    raise RuntimeError("Could not lock the remote lane")


def use_local_bin():
    local = str(Path.home() / ".local/bin")
    if local not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = local + os.pathsep + os.environ.get("PATH", "")


def cache_directory() -> Path:
    """This laptop's SSH key, host keys and shared connections; never in the repository."""
    return Path.home() / ".cache/desk-testbox"


# Every lane's uploads queue on one shared connection, and Session Manager carries uploads slowly, so a keepalive
# reply can wait minutes behind them. Allow ten minutes before giving up. A closed SSM stream still ends the master at
# once, because the proxy process exits.
MASTER_OPTIONS = ("ControlPersist=3600", "ConnectTimeout=30", "ServerAliveInterval=30", "ServerAliveCountMax=20")


def control_path(cache: Path, region: str, instance: str) -> Path:
    # A master keeps the settings it was opened with, and callers reuse any live one. Naming the socket after those
    # settings gives changed ones their own master, while callers on older code keep theirs.
    key = "v2:" + region + instance + ":" + ",".join(MASTER_OPTIONS)
    return cache / (hashlib.sha256(key.encode()).hexdigest()[:20] + ".sock")


# A large upload on the shared connection holds every other lane's calls and keepalives behind it, so it opens its own
# connection over a new Session Manager session (about 6 s), compressed: macOS openrsync has no reliable -z, and
# source files shrink about fourfold. ssh keeps the first value given for each option, so these go first.
BULK_BYTES = 1_000_000
BULK_OPTIONS = ("-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "Compression=yes")


def transport(ssh_opts: list[str], size: int) -> str:
    """rsync's remote shell for an upload of `size` bytes: the shared connection, or a connection of its own."""
    return shlex.join(["ssh", *(BULK_OPTIONS if size > BULK_BYTES else ()), *ssh_opts])


def upload_size(root: Path, paths) -> int:
    total = 0
    for path in paths:
        try:
            total += (root / path).lstat().st_size
        except FileNotFoundError:
            continue
    return total


def warm_instance(cache: Path, region: str) -> str | None:
    try:
        instance = json.loads((cache / f"connection-{region}.json").read_text())["instance"]
    except (FileNotFoundError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(instance, str) or not re.fullmatch(r"i-[0-9a-f]{8,17}", instance):
        return None
    result = subprocess.run(["ssh", "-S", str(control_path(cache, region, instance)), "-O", "check", "ubuntu@" + instance], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return instance if result.returncode == 0 else None


def choose_instance(cache: Path, region: str, api, standby: bool) -> str:
    """The machine this call runs on: the remembered one while its connection is alive, else the one running instance
    tagged active. A standby (a replacement being proven before lanes move to it) is reached only when asked for."""
    instance = None if standby else warm_instance(cache, region)
    if instance is None:
        purpose = "agent-test-box-standby" if standby else "agent-test-box"
        found = api("ec2", "describe-instances", filters=[{"Name": "tag:Project", "Values": ["claude-desk"]}, {"Name": "tag:Purpose", "Values": [purpose]}, {"Name": "instance-state-name", "Values": ["running"]}])
        instances = [i for r in found["Reservations"] for i in r["Instances"]]
        if len(instances) != 1:
            raise RuntimeError(f"Expected one running {'standby ' if standby else ''}test box in {region}, found {len(instances)}")
        instance = instances[0]["InstanceId"]
    return instance


def open_connection(cache: Path, region: str, instance: str, api, remember: bool, timing=None) -> list[str]:
    """This laptop's shared SSH connection to the instance, opened over SSM unless one is alive; its options for ssh.
    With `remember`, every lane's next call reuses it (the active machine only, never a standby)."""
    aws = ["aws", "--region", region, "--no-cli-pager"]
    use_local_bin()   # the Session Manager plugin may live there
    # Reuse one encrypted SSM stream for SSH/rsync. No inbound port is opened.
    with (cache / f"connection-{instance}.lock").open("w") as connection_lock:
        fcntl.flock(connection_lock, fcntl.LOCK_EX)
        if timing:
            timing.mark("connection_lock")
        key = cache / "id_ed25519"
        if not key.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "desk-testbox-client", "-f", str(key)], check=True)
        control = control_path(cache, region, instance)
        proxy = shlex.join(aws + ["ssm", "start-session", "--target", instance, "--document-name", "AWS-StartSSHSession", "--parameters", "portNumber=%p"])
        ssh_opts = ["-o", f"ProxyCommand={proxy}", "-o", "ControlMaster=auto", "-o", f"ControlPath={control}", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={cache / 'known_hosts'}", "-o", "BatchMode=yes"]
        ssh_opts += [flag for option in MASTER_OPTIONS for flag in ("-o", option)] + ["-i", str(key)]
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
                except (subprocess.CalledProcessError, RuntimeError):
                    result = {}
                if result.get("Status") == "Success":
                    break
                if result.get("Status") in {"Failed", "Cancelled", "TimedOut"} or time.monotonic() > deadline:
                    raise RuntimeError("SSM could not authorize SSH: " + result.get("StandardErrorContent", "timeout"))
                time.sleep(2)
            host_key = result["StandardOutputContent"].strip().split()
            if host_key[:1] != ["ssh-ed25519"] or len(host_key) < 2:
                raise RuntimeError("SSM did not return the SSH host key")
            replace_host_key(cache / "known_hosts", instance, host_key)
            # A separate session prevents one caller's process-group cleanup killing other lanes.
            subprocess.run(["ssh", *ssh_opts, "-MNf", host], check=True, start_new_session=True)
        if remember:
            (cache / f"connection-{region}.json").write_text(json.dumps({"instance": instance}))
    return ssh_opts




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
    def terminated(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, terminated)
    signal.signal(signal.SIGHUP, terminated)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=os.environ.get("TESTBOX_REGION", "us-east-1"))
    parser.add_argument("--ci", action="store_const", const="1", help="explicitly set CI on the remote run")
    parser.add_argument("--lane", help="scratch lane override; normally the worktree directory name")
    parser.add_argument("--standby", action="store_true", help="run on the standby machine being proven (docs/testbox.md)")
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
    use_local_bin()
    root = Path(capture(["git", "rev-parse", "--show-toplevel"]))
    lane = lane_name(args.lane or str(root))
    cache = cache_directory()
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

    instance = choose_instance(cache, args.region, api, args.standby)
    timing.mark("discovery")
    print(f"testbox: connecting in {args.region}; lane={lane}", file=sys.stderr, flush=True)
    ssh_opts = open_connection(cache, args.region, instance, api, remember=not args.standby, timing=timing)
    host = "ubuntu@" + instance
    ssh = ["ssh", *ssh_opts, host]
    timing.mark("connection")
    base = f"/srv/testbox/lanes/{lane}"
    # Remote flock covers synchronization as well as execution, including different client hosts.
    call_id = uuid.uuid4().hex
    unit = f"desk-testbox-run-{lane}-{call_id}"
    # stop is idempotent even if cancellation happens before the service was created.
    cancel = ["sudo", "sh", "-c", f"systemctl stop {unit}.service 2>/dev/null || ! systemctl is-active --quiet {unit}.service"]
    transaction = transaction_script(base, ["sudo", "env", f"TESTBOX_PROTOCOL={PROTOCOL_VERSION}", f"TESTBOX_TIMING={int(os.environ.get('TESTBOX_TIMING') == '1')}", "/opt/testbox/lane-exec.py", lane, call_id, "python3", f"{base}/transfer/tools/testbox/worker.py", base], cancel)
    holder, started = None, False
    try:
        holder = start_holder(ssh + [prepare_script(base) + shlex.quote(transaction)])
        remote = read_remote_state(holder)
        if remote is None:
            return holder.wait()
        timing.mark("remote_lock")
        if notice := new_lane_notice(remote):
            print(notice, file=sys.stderr, flush=True)
        with tempfile.TemporaryDirectory(prefix="desk-testbox-") as tmp:
            tmp = Path(tmp)
            stage_runner(tmp)
            files = source_files(root)
            state = source_state(root, files)
            delta = changed_files(state, remote["sources"])
            timing.mark("file_list")
            print(f"testbox: syncing {len(delta)} of {len(files)} source files and Git HEAD", file=sys.stderr, flush=True)
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
            (tmp / "request.json").write_text(json.dumps({"lane": lane, "command": args.command, "ci": args.ci, "head": head, "main": main_ref, "signature": signature, "bundle": bundled, "timing": os.environ.get("TESTBOX_TIMING") == "1"}))
            rsync = shutil.which("rsync")
            if not rsync:
                raise RuntimeError("rsync is required (macOS openrsync is supported)")
            request_size = upload_size(tmp, [p.relative_to(tmp) for p in tmp.rglob("*") if p.is_file()])
            delta_size = upload_size(root, delta)
            if max(request_size, delta_size) > BULK_BYTES:
                print(f"testbox: sending {(request_size + delta_size) / 1e6:.1f} MB over a connection of its own, so "
                      "other lanes' calls don't wait behind it", file=sys.stderr, flush=True)
            # Protocol 29 works with macOS openrsync. No .git, environment, ignored files or build artifacts.
            subprocess.run([rsync, "-rlpt", "-e", transport(ssh_opts, request_size), str(tmp) + "/", host + ":" + base + "/transfer/"], check=True)
            timing.mark("request_transfer")
            # Delete stale source paths before sync, including file-to-directory branch changes.
            subprocess.run(ssh + ["python3 -c " + shlex.quote(cleanup_script(base))], check=True)
            timing.mark("source_cleanup")
            if delta:
                # Content hashes already selected changed paths; force transfer even when size
                # and mtime match. This also repairs sources altered by a previous remote job.
                subprocess.run([rsync, "-rlpt", "--ignore-times", "--from0", "--files-from=" + str(tmp / "files"), "-e", transport(ssh_opts, delta_size), str(root) + "/", host + ":" + base + "/repo/"], check=True)
            timing.mark("source_transfer")
            print(f"testbox: sync complete ({time.monotonic() - start:.2f}s)", file=sys.stderr, flush=True)
            # Run the worker shipped by this client, even if the selected tree has no tools.
            sys.stdout.flush()
            started = True   # From here on a remote job may exist, and its cleanup is awaited.
            code = relay(holder, sys.stdout.buffer)
            timing.mark("remote_execution")
            print(f"testbox: lane={lane} exit={code} elapsed={time.monotonic() - start:.2f}s", file=sys.stderr, flush=True)
            return code
    finally:
        # Finish releasing before the local lane lock is freed or INT/TERM exits.
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        try:
            if holder is not None:
                release(holder, started)
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"testbox: {exc}", file=sys.stderr)
        sys.exit(1)
