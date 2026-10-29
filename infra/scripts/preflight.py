"""Check that HEAD may be deployed, before deploy.sh touches anything in AWS.

    uv run --project infra python infra/scripts/preflight.py [--allow-branch]

In order, stopping at the first failure, which it names:

1. The working tree is clean (ignored files aside) and the clone isn't shallow.
2. HEAD is on `main` as origin has it now (fetched first); `--allow-branch` skips this check only.
3. `make evals-results-check BASE=<the repository's first commit>`. The first commit touches no
   gated path, so the check always requires HEAD's own tier 2 results file to exist and pass. A
   missing make target fails too: no deploy without the tier 2 check.
4. Both owner secrets (`desk/anthropic-api-key`, `desk/passcode-hash`) carry the `owner-set=true`
   tag that infra/scripts/set_secret.py adds, so neither is still DeskData's generated placeholder.
5. The web app builds and checks at HEAD: `npm ci`, `npm run build`, `npm run check:build` in
   `web/`, after deleting any earlier `web/dist`, so an old build is never deployed.

Exit status: 0 when every check passes, 1 at the first failure, 2 a usage error.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError

REGION = "us-west-2"
REPO = Path(__file__).resolve().parents[2]
OWNER_SECRETS = ("desk/anthropic-api-key", "desk/passcode-hash")
OWNER_SET_TAG = ("owner-set", "true")
MAIN = "refs/remotes/origin/main"
WEB_STEPS = (["npm", "ci"], ["npm", "run", "build"], ["npm", "run", "check:build"])


class PreflightError(Exception):
    """A check failed; the message says which and what to do."""


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)


def _git_out(repo: Path, *args: str) -> str:
    result = _git(repo, *args)
    if result.returncode != 0:
        raise PreflightError(f"git {' '.join(args)} failed: {result.stderr.strip() or result.returncode}")
    return result.stdout.strip()


def check_clean(repo: Path) -> None:
    if _git_out(repo, "rev-parse", "--is-shallow-repository") == "true":
        raise PreflightError("this is a shallow clone, so its first commit isn't known: fetch with --unshallow")
    changes = _git_out(repo, "status", "--porcelain", "--untracked-files=all")
    if changes:
        listed = changes.splitlines()
        more = f" and {len(listed) - 5} more" if len(listed) > 5 else ""
        raise PreflightError(
            "the working tree isn't clean; commit or stash first: " + ", ".join(line[3:] for line in listed[:5]) + more
        )
    print("ok: the working tree is clean")


def check_on_main(repo: Path) -> None:
    fetched = _git(repo, "fetch", "--quiet", "origin", f"+refs/heads/main:{MAIN}")
    if fetched.returncode != 0:
        raise PreflightError(f"can't fetch main from origin: {fetched.stderr.strip()}")
    ancestor = _git(repo, "merge-base", "--is-ancestor", "HEAD", MAIN)
    if ancestor.returncode == 1:
        raise PreflightError("HEAD isn't on origin/main: deploy a merged commit (or pass --allow-branch)")
    if ancestor.returncode != 0:
        raise PreflightError(f"can't compare HEAD with origin/main: {ancestor.stderr.strip()}")
    print("ok: HEAD is on origin/main")


def first_commit(repo: Path) -> str:
    """The oldest root commit: with no gated path in it, the results check can't pass vacuously."""
    return _git_out(repo, "rev-list", "--max-parents=0", "--reverse", "HEAD").splitlines()[0]


def check_results(repo: Path) -> None:
    base = first_commit(repo)
    result = subprocess.run(
        ["make", "evals-results-check", f"BASE={base}"], cwd=repo, capture_output=True, text=True, check=False
    )
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        if "No rule to make target" in output:
            reason = "the evals-results-check target is missing, so HEAD's tier 2 result can't be checked"
        else:
            reason = "HEAD has no passing tier 2 results file"
        raise PreflightError(f"{reason} (make evals-results-check BASE={base}):\n{output}")
    print(f"ok: HEAD's tier 2 results file passes (make evals-results-check BASE={base})")


def check_owner_secrets(client) -> None:
    for secret_id in OWNER_SECRETS:
        try:
            tags = client.describe_secret(SecretId=secret_id).get("Tags", [])
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "error")
            if code == "ResourceNotFoundException":
                raise PreflightError(f"{secret_id} doesn't exist: deploy DeskData first") from None
            raise PreflightError(f"can't read {secret_id}: {code}") from None
        except BotoCoreError as error:
            raise PreflightError(f"can't read {secret_id}: {type(error).__name__}") from None
        if not any((tag.get("Key"), tag.get("Value")) == OWNER_SET_TAG for tag in tags):
            raise PreflightError(
                f"{secret_id} is still the generated placeholder: set it with infra/scripts/set_secret.py {secret_id}"
            )
    print(f"ok: {' and '.join(OWNER_SECRETS)} are owner-set")


def check_web(repo: Path) -> None:
    web = repo / "web"
    if not (web / "package.json").is_file():
        raise PreflightError("web/package.json doesn't exist at HEAD: there is no web app to deploy")
    shutil.rmtree(web / "dist", ignore_errors=True)
    for step in WEB_STEPS:
        result = subprocess.run(step, cwd=web, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            output = (result.stdout + result.stderr).strip()
            raise PreflightError(f"{' '.join(step)} failed in web/:\n{output}")
    if not (web / "dist" / "index.html").is_file():
        raise PreflightError("npm run build wrote no web/dist/index.html")
    print("ok: the web app builds and checks at HEAD")


def main(argv: list[str] | None = None, *, repo: Path | None = None, secrets=None) -> int:
    parser = argparse.ArgumentParser(description="Check that HEAD may be deployed.")
    parser.add_argument("--allow-branch", action="store_true", help="deploy a commit that isn't on origin/main")
    args = parser.parse_args(argv)
    repo = REPO if repo is None else Path(repo)
    try:
        check_clean(repo)
        if args.allow_branch:
            print("skipped: HEAD may be off origin/main (--allow-branch)")
        else:
            check_on_main(repo)
        check_results(repo)
        check_owner_secrets(boto3.client("secretsmanager", region_name=REGION) if secrets is None else secrets)
        check_web(repo)
    except PreflightError as error:
        print(f"preflight: {error}", file=sys.stderr)
        return 1
    print(f"preflight: {_git_out(repo, 'rev-parse', 'HEAD')} may be deployed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
