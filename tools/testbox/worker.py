#!/usr/bin/env python3
"""Remote half of a locked lane transaction. Never reads the caller's environment."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desk_tools.testbox import RESERVED, Timings, remote_environment, selected_files


ACTIVE = None


def stop(signum, _frame):
    if ACTIVE is not None and ACTIVE.poll() is None:
        os.killpg(ACTIVE.pid, signum)
        ACTIVE.wait()
    raise SystemExit(128 + signum)


def run(cmd, **kwargs):
    global ACTIVE
    ACTIVE = subprocess.Popen(cmd, start_new_session=True, **kwargs)
    code = ACTIVE.wait()
    ACTIVE = None
    if code:
        raise subprocess.CalledProcessError(code, cmd)


def digest(repo, paths):
    h = hashlib.sha256()
    files = []
    for name in paths:
        source = repo / name
        if source.is_dir():
            for directory, dirs, names in os.walk(source):
                dirs[:] = [d for d in dirs if d not in RESERVED]
                files.extend(Path(directory) / n for n in names)
        else:
            files.append(source)
    for path in sorted(set(files)):
        if path.is_file() and selected_files([path.relative_to(repo).as_posix()]):
            h.update(path.relative_to(repo).as_posix().encode())
            h.update(path.read_bytes())
    return h.hexdigest()


def main():
    timing = Timings("worker")
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, stop)
    base = Path(sys.argv[1])
    repo = base / "repo"
    transfer = base / "transfer"
    request = json.loads((transfer / "request.json").read_text())
    # Remove files that disappeared on branch switches, without touching lane build state.
    current = set(json.loads((transfer / "manifest.json").read_text()))
    completed = base / "manifest.tmp"
    completed.write_text(json.dumps(sorted(current)))
    completed.replace(base / "manifest.json")
    (base / "pending-manifest.json").unlink(missing_ok=True)
    if not (repo / ".git").exists():
        run(["git", "init", "-q", str(repo)])
        run(["git", "-C", str(repo), "remote", "add", "origin", "https://github.com/gvsi/claude-desk.git"])
    refs = subprocess.run(["git", "rev-parse", "HEAD", "refs/remotes/origin/main"], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    signature = ":".join(refs.stdout.splitlines()) if refs.returncode == 0 else ""
    if signature != request["signature"]:
        if request.get("bundle", True):
            run(["git", "bundle", "unbundle", str(transfer / "source.bundle")], cwd=repo, stdout=subprocess.DEVNULL)
        for revision in (request["head"], request["main"]):
            run(["git", "cat-file", "-e", revision + "^{commit}"], cwd=repo)
        run(["git", "update-ref", "refs/remotes/origin/main", request["main"]], cwd=repo)
        # Set HEAD and the index, without replacing the caller's uncommitted working files.
        run(["git", "update-ref", "--no-deref", "HEAD", request["head"]], cwd=repo)
        (base / "git-signature").write_text(request["signature"])
        (transfer / "source.bundle").unlink(missing_ok=True)
    # Commands may stage files without moving either ref. Restore the index every time.
    run(["git", "read-tree", request["head"]], cwd=repo)
    timing.mark("git_import")
    env = {"HOME": "/home/ubuntu", "USER": "ubuntu", "LANG": "C.UTF-8", "PATH": "/home/ubuntu/.cargo/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin", "TMPDIR": str(base / "tmp")}
    (base / "tmp").mkdir(exist_ok=True)
    env.update(remote_environment(request["lane"], str(repo), request["ci"]))
    # Environment files contain only checked-in development defaults and this lane's database URLs.
    defaults = (repo / ".env.example").read_text()
    for key in ("ADMIN", "KERNEL", "API", "MOCKPAY"):
        defaults = "\n".join(f"{key}_DATABASE_URL={env[f'{key}_DATABASE_URL']}" if line.startswith(f"{key}_DATABASE_URL=") else line for line in defaults.splitlines())
    (repo / ".env").write_text(defaults + "\n")
    (repo / ".env").chmod(0o600)
    os.chdir(repo)
    kernel_hash = digest(repo, ["kernel", "backend/pyproject.toml", "backend/uv.lock", "rust-toolchain.toml", "Makefile"])
    timing.mark("kernel_hash")
    stamp = base / "kernel-hash"
    rebuilt = False
    if not stamp.exists() or stamp.read_text() != kernel_hash or not (repo / "kernel/target/release/desk-prove").exists():
        print("testbox: building lane kernel", flush=True)
        run(["make", "kernel"], env=env)
        stamp.write_text(kernel_hash)
        rebuilt = True
    timing.mark("kernel_setup")
    run(["uv", "sync", "--project", "backend", "--group", "evals"], env=env)
    timing.mark("uv_sync")
    # Templates are keyed by migration inputs. Global lock also serializes role creation/ALTERs.
    schema = digest(repo, ["backend/alembic", "backend/desk/db"])
    template = "template_" + schema[:24]
    database = env["ADMIN_DATABASE_URL"].rsplit("/", 1)[1]
    timing.mark("schema_hash")
    with open("/srv/testbox/template.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        timing.mark("database_lock")
        # Use the lane venv's psycopg. SQL identifiers are constructed by psycopg, never interpolated.
        helper = str(repo / "tools/testbox/database.py")
        run([str(repo / "backend/.venv/bin/python"), helper, str(base), template, database, schema], env=env)
    timing.mark("database_setup")
    command = request["command"]
    print("testbox: running " + repr(command), flush=True)
    if rebuilt and command == ["make", "kernel"]:
        return 0  # The requested build already ran above.
    try:
        run(command, env=env)
        timing.mark("command")
        return 0
    except subprocess.CalledProcessError as exc:
        return exc.returncode if exc.returncode >= 0 else 128 - exc.returncode



if __name__ == "__main__":
    sys.exit(main())
