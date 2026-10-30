"""Run an eval tier from the repository root.

    python -m evals.run tier1 [--target stub|kernel|api] [pytest args]

With no test paths among the pytest args it runs all of `evals/tier1`. It exits non-zero when
pytest does, when no case was collected, or when the run left no summary or a summary with a
failure in it.
"""

import argparse
import json
import sys
from pathlib import Path

import pytest

from evals.tier1.harness import SUMMARY_FILE, TARGETS, TIER1_DIR

EVALS_DIR = Path(__file__).resolve().parent


def tier1(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.run tier1", allow_abbrev=False)
    parser.add_argument("--target", choices=TARGETS, default="kernel")
    options, pytest_args = parser.parse_known_args(argv)
    selected = any(Path(arg.split("::")[0]).exists() for arg in pytest_args if not arg.startswith("-"))
    SUMMARY_FILE.unlink(missing_ok=True)
    args = ["-c", str(EVALS_DIR / "pytest.ini"), "--target", options.target, *pytest_args]
    code = pytest.main(args if selected else [*args, str(TIER1_DIR)])
    if code == pytest.ExitCode.NO_TESTS_COLLECTED:
        print("tier 1 collected no cases", file=sys.stderr)
        return int(code)
    if not SUMMARY_FILE.is_file():
        print("tier 1 wrote no summary", file=sys.stderr)
        return int(code) or 1
    if code == pytest.ExitCode.OK and json.loads(SUMMARY_FILE.read_text())["failed"]:
        return 1
    return int(code)


def main(argv: list[str]) -> int:
    if not argv or argv[0] != "tier1":
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return tier1(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
