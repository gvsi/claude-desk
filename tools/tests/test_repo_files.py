"""Repository files the deploy relies on: what the app image's build context leaves out, and how
the image is layered on the kernel image."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _dockerignore_lines() -> list[str]:
    text = (REPO / ".dockerignore").read_text()
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def _matches(pattern: str, path: str) -> bool:
    """Docker's ignore-pattern match, enough for this repo's file: `*` and `?` stay inside one path
    segment, `**` spans segments, and a pattern matching a directory matches everything in it."""
    regex, i = "", 0
    pattern = pattern.strip("/")
    while i < len(pattern):
        if pattern.startswith("**/", i):
            regex, i = regex + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            regex, i = regex + ".*", i + 2
        elif pattern[i] == "*":
            regex, i = regex + "[^/]*", i + 1
        elif pattern[i] == "?":
            regex, i = regex + "[^/]", i + 1
        else:
            regex, i = regex + re.escape(pattern[i]), i + 1
    return re.fullmatch(regex + "(?:/.*)?", path) is not None


def _excluded(path: str, lines: list[str]) -> bool:
    """The last matching line decides; a `!` line puts a path back."""
    excluded = False
    for line in lines:
        negated = line.startswith("!")
        if _matches(line[1:] if negated else line, path):
            excluded = not negated
    return excluded


def test_dockerignore_keeps_secrets_tests_and_build_outputs_out():
    lines = _dockerignore_lines()
    required = [".env", ".env.*", ".local", ".plan-runs", ".worktrees", ".git", "**/node_modules", "**/.venv",
                "kernel/target", "infra/cdk.out", "infra/out", "backend/tests", "evals", "web"]
    missing = [entry for entry in required if entry not in lines]
    assert not missing, f".dockerignore lacks {missing}"

    kept_out = [".env", ".env.example", "backend/.env", ".local/notes.md", ".plan-runs/run/progress.md",
                ".worktrees/plan/backend/desk/env.py", ".git/HEAD", "web/node_modules/react/index.js",
                "backend/.venv/bin/python", "kernel/target/release/desk-prove", "infra/cdk.out/manifest.json",
                "infra/out/config.json", "backend/tests/test_db.py", "evals/cases/attack.yaml", "web/src/main.tsx"]
    shipped = ["kernel/cedar/proofs/rivera.json", "kernel/cedar/fixtures/baseline.cedar", "backend/desk/__init__.py",
               "backend/desk/kernel_service/compiler.py", "backend/pyproject.toml", "backend/uv.lock",
               "backend/alembic.ini", "backend/alembic/env.py", "backend/alembic/versions/0001_core.py"]
    assert [path for path in kept_out if not _excluded(path, lines)] == []
    assert [path for path in shipped if _excluded(path, lines)] == []


def test_app_image_builds_on_the_kernel_image():
    text = (REPO / "infra" / "app.Dockerfile").read_text()
    instructions = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
    # The kernel image is a required build argument: no default, so a build can't pick a stale one.
    assert "ARG KERNEL_IMAGE" in instructions
    assert not any(line.startswith("ARG KERNEL_IMAGE=") for line in instructions)
    assert [line for line in instructions if line.startswith("FROM ")] == ["FROM ${KERNEL_IMAGE}"]
    assert [line for line in instructions if line.startswith("USER ")][-1] == "USER desk"
    assert re.search(r"^ENV\b.*\bPYTHONPATH=/app/backend\b", text, re.MULTILINE)
    assert 'ENTRYPOINT ["python", "-m", "desk.ops.entrypoint"]' in instructions


def test_local_api_excludes_kernel_credentials_after_loading_dotenv(tmp_path):
    (tmp_path / "Makefile").write_text((REPO / "Makefile").read_text())
    (tmp_path / "backend").mkdir()
    (tmp_path / ".env").write_text(
        "TYPESAFE_API_KEY=fake-typesafe\nMOCKPAY_KEY=fake-mockpay\nANTHROPIC_API_KEY=fake-anthropic\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv = bin_dir / "uv"
    uv.write_text(f"#!{sys.executable}\n" + """import os, sys
from pathlib import Path
assert sys.argv[1:4] == ['run', '--env-file', '../.env']
for line in Path('../.env').read_text().splitlines():
    name, value = line.split('=', 1)
    os.environ[name] = value
os.execvp(sys.argv[4], sys.argv[4:])
""")
    uv.chmod(0o755)
    server = bin_dir / "uvicorn"
    server.write_text(f"#!{sys.executable}\n" + """import json, os
print(json.dumps({name: bool(os.environ.get(name)) for name in
                 ('TYPESAFE_API_KEY', 'MOCKPAY_KEY', 'ANTHROPIC_API_KEY')}))
""")
    server.chmod(0o755)
    env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
               TYPESAFE_API_KEY="fake-ambient-typesafe", MOCKPAY_KEY="fake-ambient-mockpay")
    result = subprocess.run(["make", "--no-print-directory", "api-serve"], cwd=tmp_path, env=env,
                            capture_output=True, text=True, check=True)
    assert json.loads(result.stdout.splitlines()[-1]) == {
        "TYPESAFE_API_KEY": False, "MOCKPAY_KEY": False, "ANTHROPIC_API_KEY": True}
