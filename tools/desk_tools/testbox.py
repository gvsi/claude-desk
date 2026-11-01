"""Pure client rules shared with the remote runner (standard library only)."""
import os
import sys
import hashlib
import re
import shlex
import time
from pathlib import Path, PurePosixPath


# Lanes connect to Postgres directly at the test bridge's address (testbox0 in bootstrap.sh), which
# the launcher lets every lane reach on this port. The loopback forwarder on 127.0.0.1:5432 adds
# about 40 ms to each connection; it stays for clients on older branches, whose workers still use it.
DATABASE_HOST = "10.200.0.1"
DATABASE_PORT = 5432
RESERVED = {".git", ".aws", ".ssh", ".local", ".worktrees", ".plan-runs", ".venv", "node_modules", "target", ".tools", "__pycache__", ".pytest_cache", "test-results", "playwright-report", "cdk.out", ".npmrc", ".pypirc", ".netrc", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"}


class Timings:
    """Report phase wall times without source contents or connection identifiers."""

    def __init__(self, scope):
        self.scope = scope
        self.previous = time.monotonic()

    def mark(self, phase):
        now = time.monotonic()
        if os.environ.get("TESTBOX_TIMING") == "1":
            print(f"testbox timing: {self.scope}.{phase}={now - self.previous:.3f}s", file=sys.stderr, flush=True)
        self.previous = now


def lane_name(worktree: str) -> str:
    name = Path(worktree).name
    safe = re.sub(r"[^a-z0-9_-]", "-", name.lower())
    if safe != name or len(safe) > 40:
        safe = safe[:30] + "-" + hashlib.sha256(name.encode()).hexdigest()[:10]
    return safe or "lane"


def selected_files(paths: list[str]) -> list[str]:
    result = []
    for path in paths:
        parts = PurePosixPath(path).parts
        if not parts or path.startswith("/") or ".." in parts or RESERVED.intersection(parts):
            continue
        if any((p.startswith(".env") and p != ".env.example") or p.endswith((".pem", ".key", ".p12", ".pfx")) for p in parts):
            continue
        result.append(path)
    return result


def remote_environment(lane: str, repo: str, ci: str | None = None) -> dict[str, str]:
    # Only public development defaults; the caller's environment is never forwarded.
    db = "lane_" + lane.replace("-", "_")
    # Distinguish '-' and '_' without exceeding Postgres's 63 byte identifier limit.
    if "_" in lane:
        db += "_" + hashlib.sha256(lane.encode()).hexdigest()[:8]
    env = {
        "DESK_ADMIN_PASSWORD": "change-me-admin", "KERNEL_ROLE_PASSWORD": "change-me-kernel",
        "API_ROLE_PASSWORD": "change-me-api", "MOCKPAY_ROLE_PASSWORD": "change-me-mockpay",
        "CVC5": "/opt/testbox/cvc5/bin/cvc5", "DESK_PROVE": repo + "/kernel/target/release/desk-prove",
        "UV_CACHE_DIR": "/srv/testbox/cache/uv", "npm_config_cache": "/srv/testbox/cache/npm",
        "PLAYWRIGHT_BROWSERS_PATH": "/opt/testbox/browsers", "PLAYWRIGHT_SKIP_BROWSER_GC": "1", "CARGO_BUILD_JOBS": "8",
        "RAYON_NUM_THREADS": "8", "VITEST_MAX_THREADS": "8",
    }
    for prefix, user, password in (("ADMIN", "desk_admin", "admin"), ("KERNEL", "desk_kernel", "kernel"), ("API", "desk_api", "api"), ("MOCKPAY", "desk_mockpay", "mockpay")):
        env[f"{prefix}_DATABASE_URL"] = f"postgresql+psycopg://{user}:change-me-{password}@{DATABASE_HOST}:{DATABASE_PORT}/{db}"
    if ci is not None:
        env["CI"] = ci
    return env


def remote_command(command: list[str]) -> str:
    return shlex.join(command)
