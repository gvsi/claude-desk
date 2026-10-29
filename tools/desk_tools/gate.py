"""Run, skip or fail a CI suite by whether the paths that mark its code exist.

    python -m desk_tools.gate --name <name> --run-if <path> [--run-if <path>]...
        [--required-if <path>]... -- <command...>

Every --run-if path exists: run the command and exit with its code, so a missing make target
or a Makefile error fails. A --run-if path is missing and a --required-if path exists: exit 1.
A --run-if path is missing and nothing requires the suite: print a skip line, append it to
$GITHUB_STEP_SUMMARY when that is set, and exit 0. Usage errors exit 2. Paths are relative to
the working directory. The gate only checks paths; it never asks make whether a target exists.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

USAGE_ERROR = 2


class UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):
        raise UsageError(message)


def _parse(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = _Parser(
        prog="python -m desk_tools.gate",
        usage="%(prog)s --name NAME --run-if PATH [--run-if PATH]... [--required-if PATH]... -- COMMAND...",
    )
    parser.add_argument("--name", required=True, help="the suite's name in messages")
    parser.add_argument(
        "--run-if", action="append", required=True, metavar="PATH",
        help="a path that marks the suite's code; the command runs only when every one exists",
    )
    parser.add_argument(
        "--required-if", action="append", default=[], metavar="PATH",
        help="a path that turns a missing suite into a failure instead of a skip",
    )
    try:
        split = argv.index("--") if "--" in argv else len(argv)
        args = parser.parse_args(argv[:split])
        if split == len(argv):
            raise UsageError("the command must follow --")
        command = argv[split + 1 :]
        if not command:
            raise UsageError("no command after --")
        for path in args.run_if + args.required_if:
            if not path:
                raise UsageError("a path is empty")
            if path.startswith("make:"):
                raise UsageError(f"{path!r}: the gate takes paths, not make targets")
    except UsageError as error:
        parser.print_usage(sys.stderr)
        print(f"{parser.prog}: error: {error}", file=sys.stderr)
        raise
    return args, command


def main(argv: list[str]) -> int:
    try:
        args, command = _parse(argv)
    except UsageError:
        return USAGE_ERROR

    missing = [path for path in args.run_if if not Path(path).exists()]
    if not missing:
        return subprocess.run(command).returncode

    requiring = [path for path in args.required_if if Path(path).exists()]
    if requiring:
        print(f"`{args.name}` is required by `{requiring[0]}` but `{missing[0]}` is missing", file=sys.stderr)
        return 1

    line = f"`{args.name}`: skipped, `{missing[0]}` is not in the repo yet"
    print(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as file:
            file.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
