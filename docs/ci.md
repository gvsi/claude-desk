# Continuous integration

Every push to `main`, every pull request to `main` and every manual run starts one GitHub Actions workflow, `ci` ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). Each push to a pull request runs it once, and a newer push cancels the older run of the same pull request. A run on `main` is never cancelled once it starts; if several pushes to `main` are waiting, only the newest one runs.

CI holds no secrets and no model key, and it can only read the repository:

- The workflow's token has `contents: read`, and no job widens it.
- No checkout keeps the token in the git config.
- Every action is pinned by commit.
- Python dependencies come only from the committed uv lockfiles (`UV_LOCKED=1`), and a missing or out-of-date lockfile fails the job.
- Every downloaded tool (cvc5, gitleaks, actionlint, and rustup-init on a runner without rustup) is the build for the runner's architecture, x86-64 or arm64, and is checked against a pinned sha256 before it runs. Any other architecture fails the job before anything is downloaded.

## The checks

The workflow has nine jobs. Their names are the check names, in this order:

1. `backend tests`: the backend's tests pass against a real Postgres 16. First the migrations apply to an empty database and the service roles get their passwords. The job fails before migrating if the migration chain has more than one head.
2. `kernel tests`: the Rust kernel's tests pass (`cargo test --locked`), with cvc5 available to the proof binary's tests.
3. `proofs`: two things pass. The proof binary's self-test runs against cvc5 (`desk-prove --selftest`). Then every shipped rule set is proved again and has to match its committed proof report (`make check-presets`). A report that is missing, out of date or failing fails the check.
4. `tier 1 evals`: two suites pass against the real kernel and database. Both need no network and no model key:
   - the model-free attack suite (`make evals-tier1`);
   - the API's kernel contract tests, against the real kernel and not only the fake one, for each part of the kernel that `evals/tier1/landed.toml` lists as landed (`make kernel-contract`).
5. `tier 2 results`: on pull requests only. A change to the gated inputs has to carry a passing tier 2 results file for exactly those inputs (`make evals-results-check BASE=origin/main`). The gated inputs are the kernel, prompts, rule presets, shared contracts, mock payments and the eval judging code.
6. `web tests`: two steps pass in turn. First the web app type-checks and its unit tests pass (`make web-test`). Then it builds, the build check passes and the mocked end-to-end test passes (`make web-e2e`).
7. `infra synth`: the infrastructure tests pass and the CDK app synthesizes (`make infra-check`). Nothing is deployed, and no cloud credentials are used.
8. `secret scan`: gitleaks finds no secret in the history under test. On a pull request that is `main`'s history plus the pull request's commits; on a push to `main`, it is `main`'s history. Other branches aren't scanned, so one branch's finding can't fail every other run. A secret committed and later deleted still counts.
   - It uses gitleaks' default rules with no exceptions. `.gitleaks.toml` has no allowlist, there is no `.gitleaksignore`, and inline `gitleaks:allow` comments are ignored.
   - Each finding is logged with its file, line and commit, and the secret itself is redacted.
9. `repo checks`: three things pass:
   - actionlint on the workflow, with shellcheck on the workflow's scripts;
   - the repository tooling's tests (`cd tools && uv run pytest -q`);
   - the docs check (`make docs-check`).

## When a check skips or fails

Some checks run code that other parts of the project add over time. Each of those commands runs through a gate, `tools/desk_tools/gate.py`:

```sh
uv run --project tools python -m desk_tools.gate --name <name> --run-if <path> [--run-if <path>]... [--required-if <path>]... -- <command>
```

The gate decides by paths alone, relative to the repository root. It never asks make whether a target exists. So once a suite's code is in the repository, a missing make target or a Makefile error fails the check.

| State | Result |
|---|---|
| Every `--run-if` path exists | Runs the command and exits with its code |
| A `--run-if` path is missing and a `--required-if` path exists | Fails (exit 1) without running the command, naming both paths |
| A `--run-if` path is missing and no `--required-if` path exists | Skips (exit 0) and says so in the job log and summary: "`<name>`: skipped, `<path>` is not in the repo yet" |
| A usage error | Fails (exit 2) without running anything |

The gates in the workflow:

| Gate | Runs once this exists | Fails if missing while this exists | Command |
|---|---|---|---|
| `proofs` | `backend/scripts/prove_presets.py` | `kernel/cedar/proofs` or `backend/desk/kernel_service/compiler.py` | `make check-presets` |
| `tier1` | `evals/run.py` | `backend/desk/kernel_service/app.py` | `make evals-tier1` |
| `kernel-contract` | `backend/tests/kernel_contract/conftest.py` | `backend/desk/api/kernel_client.py` | `make kernel-contract` |
| `tier2-results` | `evals/results.py` | `evals/results` | `make evals-results-check BASE=origin/main` |
| `web` | `web/package.json` | | `make web-test` |
| `web-e2e` | `web/playwright.config.ts` | `web/e2e` | `make web-e2e` |
| `infra` | `infra/cdk.json` | | `make infra-check` |
| `docs` | `tools/desk_tools/check_docs.py` | | `make docs-check` |

- A `--run-if` path is always the suite's own code, never its data. Data can only require a suite, so deleting the tier 2 results can't switch their check off.
- A `--required-if` path is code or data that exists once the suite has to run: the shipped proof reports or the rule compiler for `proofs`, the API's kernel client for `kernel-contract`, the end-to-end tests for `web-e2e`. Moving or deleting a suite's checker then fails the check instead of skipping it.
- The rule compiler lands a few commits before `make check-presets`. In between, `proofs` fails rather than skips.
- Everything else in the workflow runs on every push, with no gate.

## Tier 2 runs locally

Tier 2 is the model-driven attack suite and legitimate-task suite. It needs a model key, and CI holds none.

- It runs locally with the development key.
- Its results file is committed to `evals/results/`, named by a hash of the gated inputs.
- On a pull request, `tier 2 results` recomputes that hash for the merge of the pull request into `main`, which is what CI checks out. It fails when gated inputs changed and no passing results file covers them.
- When `main` gains gated changes after the results file was made, rebase the pull request and run tier 2 again to regenerate the file.
- Pushes to `main` skip the job, since the pull request already ran it.

## Runners

- **Default.** Every job runs on a GitHub-hosted `ubuntu-24.04` runner (x86-64).
- **Self-hosted.** The repository variable `CI_RUNNER_MODE=ec2` moves every job to self-hosted, single-use arm64 runners on AWS. They have no cloud role and run on an isolated network. Pull request runs use spot capacity; pushes and manual runs use on-demand.
- **Pull requests from forks.** They always run on GitHub-hosted runners: the switch is on only for pushes, manual runs and pull requests whose head repository is this one. The runner launcher also starts runners only for runs whose head repository is this one, and it caps how many instances run and how long each lives. "Run workflows from fork pull requests" stays off while the repository is private, and if it ever goes public, runs from outside contributors need approval. Setting the variable spends AWS money, so it is the repository owner's call.
- **Labels.** Each job asks for a label of its own, `desk-ci-<spot or ondemand>-<run id>-<attempt>-<job>`, so no two jobs share a runner.
- **Database image.** The Postgres service is Docker's official `postgres:16`, the image `docker-compose.yml` uses. GitHub-hosted runners pull it from Docker Hub, since their shared addresses run into ECR Public's anonymous pull limit. Self-hosted runners pull the same image and tag from its ECR Public mirror, `public.ecr.aws/docker/library/postgres:16`.
- **Setup.** Where a runner has no rustup, psql or ShellCheck, the jobs install them first: rustup from a checked rustup-init, the Postgres client and ShellCheck from Ubuntu's archive. GitHub-hosted runners have all three, so nothing is installed there.
- **Kill switch.** Unset the variable, and the next run is back on GitHub-hosted runners. Any value other than `ec2` does the same. Jobs that already asked for a self-hosted runner keep waiting for one until they are cancelled.

## Runner minutes

One run takes 27 billed runner minutes, summed over the nine jobs (21 minutes of job time; GitHub rounds each job up to the minute). Measured on the first run, on October 29, 2026, before most suites had landed, so expect more as the web, infrastructure and eval suites arrive. The longest jobs were backend tests (6m 22s), proofs (5m 46s), tier 1 evals (5m 13s) and kernel tests (2m 18s); the run took about 6.5 minutes end to end.

While the repository is private, runs draw on the account's included Actions minutes: 2,000 a month on GitHub Free.

## Branch protection

Branch protection isn't configured from this repository; it is the repository owner's call.

- **Plan.** On a private repository, branch protection needs GitHub Pro or a paid organization plan.
- **Skips.** A skipped check counts as passing. That covers the gate's visible skips, and `tier 2 results` on pushes to `main`, where it doesn't run.
- **Requiring the checks.** To require the nine checks on `main`, with each branch up to date before it merges, run:

```sh
gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input protection.json
```

`protection.json`:

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "backend tests",
      "kernel tests",
      "proofs",
      "tier 1 evals",
      "tier 2 results",
      "web tests",
      "infra synth",
      "secret scan",
      "repo checks"
    ]
  },
  "enforce_admins": null,
  "required_pull_request_reviews": null,
  "restrictions": null
}
```

## Running the checks locally

- **Tooling tests.** The gate's and the workflow's tests run with `cd tools && uv run pytest -q`.
- **Other checks.** Each check's make target runs the same way it does in CI.
  - The backend tests and tier 1 evals need the local database (`docker compose up -d db`).
  - The kernel tests, proofs and tier 1 evals need cvc5, found through `CVC5` or `PATH`.
