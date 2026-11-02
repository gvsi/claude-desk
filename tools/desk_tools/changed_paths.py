"""Conservative PR suite selection; usable with the runner's Python, without dependencies."""

import os
import subprocess
from pathlib import Path


# Inputs outside web/ read by its generators, imports and tests. Keep additions here:
# gen-contracts/gen-api and mocks validate the schemas; fixtures read contracts, seed and
# renderers; mocks read money-cap/API copy; board tests read the kernel's lexicons; the public
# page's no-name check reads setup's owner-name fallback; Safety's copy test reads the words a
# triage summary gives as why a request was turned down.
# About pages also embed docs/*.md, already covered by WEB_PREFIXES below.
WEB_READ_PATHS = (
    "backend/desk/contracts.schema.json",
    "backend/desk/api/openapi.json",
    "backend/desk/contracts.py",
    "backend/desk/money_cap.py",
    "backend/desk/api/rules.py",
    "backend/desk/api/setup.py",
    "backend/desk/api/prompts.py",
    "backend/desk/kernel_service/seed.py",
    "backend/desk/kernel_service/render/",
    "backend/desk/kernel_service/lexicon/",
)
WEB_PREFIXES = ("web/", "docs/", ".github/", "tools/")


def classify(paths: list[str], event: str) -> dict[str, bool]:
    """Only a nonempty, well-formed PR diff may rule a suite out."""
    everything = {"backend": True, "web": True}
    if event != "pull_request" or not paths:
        return everything
    for path in paths:
        # Quoted/escaped git output or noncanonical paths cannot establish a safe skip.
        if (
            not isinstance(path, str)
            or any(part in ("", ".", "..") for part in path.split("/"))
            or any(ord(char) < 32 or char in '\\"' for char in path)
        ):
            return everything
    return {
        "backend": not all(path.startswith("web/") for path in paths),
        "web": any(
            "/" not in path
            or path.startswith(WEB_PREFIXES)
            or any(path.startswith(item) if item.endswith("/") else path == item for item in WEB_READ_PATHS)
            for path in paths
        ),
    }


def main() -> None:
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    paths = []
    if event == "pull_request":
        try:
            parents = subprocess.run(
                ["git", "show", "-s", "--format=%P", "HEAD"],
                check=True, capture_output=True, text=True, timeout=30,
            ).stdout.split()
            if len(parents) == 2 and parents[1] == os.environ.get("PR_HEAD_SHA", ""):
                # Keep both endpoints: moving backend code into web/ is not web-only.
                result = subprocess.run(
                    ["git", "-c", "diff.renames=false", "diff", "--name-only", "HEAD^1", "HEAD"],
                    check=True, capture_output=True, text=True, timeout=30,
                )
                paths = result.stdout.splitlines()
            else:
                print("HEAD is not the expected PR merge; running every suite.")
        except (OSError, subprocess.SubprocessError, UnicodeError):
            print("Changed paths unavailable; running every suite.")
    needs = classify(paths, event)
    outputs = "".join(f"{suite}={str(needed).lower()}\n" for suite, needed in needs.items())
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write(outputs)
    print(outputs, end="")


if __name__ == "__main__":
    main()
