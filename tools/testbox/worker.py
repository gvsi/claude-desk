#!/usr/bin/env python3
"""Remote half of a locked lane transaction. Never reads the caller's environment."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desk_tools.testbox import RESERVED, Timings, remote_environment, selected_files


ACTIVE = None
# How web/ is installed. It is part of each lane's install record, so changing it reinstalls every lane.
NPM_CI = ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"]


def stop(signum, _frame):
    # Popen.wait holds a non-reentrant lock. Unwind it before cleanup waits again.
    raise SystemExit(128 + signum)


def run(cmd, **kwargs):
    global ACTIVE
    kwargs.setdefault("stdout", sys.stderr)
    ACTIVE = subprocess.Popen(cmd, start_new_session=True, **kwargs)
    try:
        code = ACTIVE.wait()
    finally:
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        try:
            if ACTIVE.poll() is None:
                os.killpg(ACTIVE.pid, signal.SIGTERM)
                try:
                    ACTIVE.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(ACTIVE.pid, signal.SIGKILL)
                    ACTIVE.wait()
            ACTIVE = None
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
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


def exit_status(exc):
    return exc.returncode if exc.returncode >= 0 else 128 - exc.returncode


def node_identity(env):
    """The Node npm runs under. Bootstrap replaces the binary to change the pinned version, which changes its size and
    modification time; reading them costs no process start, unlike `node --version`."""
    node = shutil.which("node", path=env.get("PATH"))
    if node is None:
        return "no node"
    info = os.stat(node)
    return f"{os.path.realpath(node)} {info.st_size} {info.st_mtime_ns}"


def web_install_record(repo, recipe):
    """What an install of `recipe` left: npm writes node_modules/.package-lock.json as an install's last step, so its
    hash, taken right after the worker's own npm ci, changes if a cancelled npm ci or a lane command's npm install
    touches the tree later. None while there is no finished install."""
    try:
        return recipe + " " + hashlib.sha256((repo / "web/node_modules/.package-lock.json").read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def install_web_dependencies(base, repo, env):
    """Run npm ci in web/ unless this lane's install record matches its package files, the install command, the Node
    binary and the installed tree, so narrow web commands work without `make web-test`'s own install. Returns an exit
    status that stops the call, or None."""
    if not (repo / "web/package-lock.json").is_file():
        return None
    recipe = " ".join([digest(repo, ["web/package.json", "web/package-lock.json"]), shlex.join(NPM_CI), node_identity(env)])
    stamp = base / "web-deps-hash"
    current = web_install_record(repo, recipe)
    if current is not None and stamp.exists() and stamp.read_text() == current:
        return None
    print("testbox: installing web dependencies (npm ci in web/)", file=sys.stderr, flush=True)
    stamp.unlink(missing_ok=True)  # An install that stops part way must not pass for the recorded one.
    try:
        run(NPM_CI, cwd=repo / "web", env=env)
    except subprocess.CalledProcessError as exc:
        print(f"testbox: npm ci in web/ failed (exit {exc.returncode}); the command did not run", file=sys.stderr, flush=True)
        return exit_status(exc)
    installed = web_install_record(repo, recipe)
    if installed is not None:
        stamp.write_text(installed)
    return None


def main():
    timing = Timings("worker")
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, stop)
    base = Path(sys.argv[1])
    repo = base / "repo"
    transfer = base / "transfer"
    request = json.loads((transfer / "request.json").read_text())
    if request.get("timing"):
        os.environ["TESTBOX_TIMING"] = "1"
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
        print("testbox: building lane kernel", file=sys.stderr, flush=True)
        run(["make", "kernel"], env=env)
        stamp.write_text(kernel_hash)
        rebuilt = True
    timing.mark("kernel_setup")
    run(["uv", "sync", "--project", "backend", "--group", "evals"], env=env)
    timing.mark("uv_sync")
    failed = install_web_dependencies(base, repo, env)
    timing.mark("web_setup")
    if failed:
        return failed
    # Templates are keyed by migration inputs. Global lock also serializes role creation/ALTERs.
    schema = digest(repo, ["backend/alembic", "backend/desk/db"])
    template = "template_" + schema[:24]
    database = env["ADMIN_DATABASE_URL"].rsplit("/", 1)[1]
    timing.mark("schema_hash")
    with open("/srv/testbox/template.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        timing.mark("database_lock")
        # Use the lane venv's psycopg. SQL identifiers are constructed by psycopg, never interpolated.
        helper = str(Path(__file__).resolve().with_name("database.py"))
        run([str(repo / "backend/.venv/bin/python"), helper, str(base), template, database, schema], env=env)
    timing.mark("database_setup")
    command = request["command"]
    print("testbox: running " + repr(command), file=sys.stderr, flush=True)
    if rebuilt and command == ["make", "kernel"]:
        return 0  # The requested build already ran above.
    try:
        run(command, env=env, stdout=None)
        timing.mark("command")
        return 0
    except subprocess.CalledProcessError as exc:
        return exit_status(exc)



if __name__ == "__main__":
    sys.exit(main())
