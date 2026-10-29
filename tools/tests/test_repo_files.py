"""Repository files the deploy relies on: what the app image's build context leaves out, and how
the image is layered on the kernel image."""

import re
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
