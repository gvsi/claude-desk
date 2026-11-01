# Continuous integration

Every push to `main`, every pull request on any base branch (including stacked pull requests) and every manual run starts one GitHub Actions workflow, `ci` ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). Each push to a pull request runs it once, and a newer push cancels the older run of the same pull request. A run on `main` is never cancelled once it starts; if several pushes to `main` are waiting, only the newest one runs.

CI holds no secrets and no model key, and it can only read the repository:

- The workflow's token has `contents: read`, and no job widens it.
- No checkout keeps the token in the git config.
- Every action is pinned by commit.
- Python dependencies come only from the committed uv lockfiles (`UV_LOCKED=1`), and a missing or out-of-date lockfile fails the job.
- Every downloaded tool (cvc5, gitleaks, actionlint, and rustup-init on a runner without rustup) is the build for the runner's architecture, x86-64 or arm64, and is checked against a pinned sha256 before it runs. Any other architecture fails the job before anything is downloaded.
- The Postgres client and ShellCheck, installed only on a runner without them, come from Ubuntu's signed archive at the current noble version and aren't sha256-pinned (see "Runners").

## The checks

The workflow has nine required checks, in this order. `backend tests` and `tier 1 evals` each run as four explicit parallel shard jobs, rather than a matrix, with `--shard=1/4` through `--shard=4/4`. Each shard has its own runner and database; collection order assigns every test to exactly one shard in each session. The two required check jobs read each shard's own result, instead of relying on how GitHub combines a matrix's results. They pass when all four results are `success`, or when path classification explicitly ruled out the suite and all four shards were skipped. The checks run even after a failed or cancelled shard, so those results fail the required check instead of skipping it; a needed suite's skipped or empty shard results also fail. Each check job waits for a runner of its own after its last shard, which adds a runner's start-up time to the run. Shards run on separate runners rather than as parallel workers on one (pytest-xdist), because the suites share one database, which the backend's tests and tier 1 empty as they go: parallel workers would each need a database of their own.

1. `backend tests`: the backend's tests pass against a real Postgres 16. In each shard, the migrations apply to an empty database and the service roles get their passwords. The shard fails before migrating if the migration chain has more than one head. Then the database stops making commits durable (`make db-throwaway`: no WAL flush at commit, no fsync, no full-page writes), since it is thrown away with the job and the tests spend much of their time committing. The target refuses to run unless `CI` is `true`, as GitHub Actions sets it, so it never touches a developer's persistent database. `tier 1 evals` sets up its database the same way.
2. `kernel tests`: the Rust kernel's tests pass (`cargo test --locked`), with cvc5 available to the proof binary's tests.
3. `proofs`: two things pass. The proof binary's self-test runs against cvc5 (`desk-prove --selftest`). Then every shipped rule set is proved again and has to match its committed proof report (`make check-presets`). A report that is missing, out of date or failing fails the check.
4. `tier 1 evals`: two suites pass against the real kernel and database. Both need no network and no model key:
   - the model-free attack suite (`make evals-tier1`). Every CI run is the strict one, a manual workflow run on any branch included: a plan whose code is on the branch but which `evals/tier1/landed.toml` doesn't list fails it at collection, and the run's summary names the plan under `unlisted` and counts it as failed. A local run on the plan's own branch only warns and keeps that plan's cases pending;
   - the API's kernel contract tests, against the real kernel and not only the fake one, for each part of the kernel that `evals/tier1/landed.toml` lists as landed (`make kernel-contract`).
5. `tier 2 results`: on pull requests, pushes to `main` and manual runs (`make evals-results-check BASE="$RESULTS_BASE" HISTORY_SINCE="$HISTORY_SINCE"`, with `RESULTS_BASE` set to the event's base commit on pull requests and the repository's root commit otherwise). While every scenario at the committed head is pending, no results file is needed and none must be regenerated. Rate and waiver histories must still remain append-only and landed plans must be kept: on pull requests against the event's base, and on pushes against every earlier commit on `main` and on manual runs against every earlier commit on the selected branch, along its first parents (`HISTORY_SINCE`, the same root commit), so a rewrite whose own run was cancelled or ignored still fails every later run. A force-push to `main` fails the check, since CI can't check the history it replaced. Once plan 02 lands and any scenario can run, the strict rule applies: a change to the gated inputs has to carry a passing tier 2 results file for exactly those inputs. Pushes and manual runs use the same results rule, so an armed head missing its results still fails the next run after a cancelled run. The gated inputs are the kernel, prompts, rule presets, shared contracts, mock payments and the eval judging code.
6. `web tests`: the web app's checks pass in five jobs, and the required check job reads each one's own result the same way as the backend's:
   - `web tests 1/4` through `web tests 4/4`: in each, the web app type-checks and a quarter of its unit and browser test files pass (`make web-test` with `WEB_TEST_ARGS=--shard=N/4 --maxWorkers=2`, which Vitest splits by file). On one 4-vCPU runner, the whole run kept every vCPU busy for about nine minutes, and timing-sensitive screen tests (scroll places, glides, waits for an element) failed at random, a different one each run. Each shard therefore runs at most two test workers, half the runner's vCPUs. Vitest gives Node and browser tests separate worker budgets that run at once, so the Node-only `unit` project runs after the browser projects (`sequence.groupOrder`), keeping two the ceiling for the whole shard.
   - `web tests e2e`: the app builds, the build check passes and the mocked end-to-end test passes (`make web-deps web-e2e`).

   The check passes when all five results are `success`, or when path classification ruled out the web suite and all five were skipped.
7. `infra synth`: the infrastructure tests pass and the CDK app synthesizes (`make infra-check`). Nothing is deployed, and no cloud credentials are used.
8. `secret scan`: gitleaks finds no secret in the history under test. On a pull request that is the base branch's history plus the pull request's commits; on a push to `main`, it is `main`'s history. On a manual run, it is the selected ref's history. Other branches aren't scanned, so one branch's finding can't fail every other run. A secret committed and later deleted still counts.
   - It uses gitleaks' default rules with one narrow allowlist in [`.gitleaks.toml`](../.gitleaks.toml): the `generic-api-key` rule may ignore a line containing only the `draft_key_sha256` field and a 64-character lowercase hexadecimal hash in `backend/tests/kernel/fixtures/kernel_core_version.json`. This is a rules-version fixture used by the kernel upgrade test, not a credential. The file path and whole-line pattern must both match; other fields, files and rules remain scanned. There is no `.gitleaksignore`, and inline `gitleaks:allow` comments are ignored.
   - Each finding is logged with its file, line and commit, and the secret itself is redacted.
9. `repo checks`: three things pass:
   - actionlint on the workflow, with shellcheck on the workflow's scripts;
   - the repository tooling's tests (`cd tools && uv run pytest -q`);
   - the docs check (`make docs-check`).

## Pull request path scoping

On pull requests, the additional `changed paths` check runs first for scoped suites. `secret scan` and `repo checks` start alongside it with no dependency and always run. The nine required check names stay unchanged. Pushes to `main` and manual runs skip `changes` before it takes a runner, avoiding its serial start-up time. Its outputs are then empty, so `!cancelled() && '' != 'false'` runs every scoped job and the required shard checks demand four successes. Only `pull_request` events can skip suites.

The classifier ([`tools/desk_tools/changed_paths.py`](../tools/desk_tools/changed_paths.py)) checks out the PR's merge commit with `fetch-depth: 2`. Before reading `git diff --name-only HEAD^1 HEAD`, it verifies that HEAD has exactly two parents and its second parent matches the event's `PR_HEAD_SHA`; otherwise it runs every suite. The first parent is the base branch. Git rename detection is disabled for the diff so both the old and new paths count. It applies these rules:

- Backend shards, tier 1 shards, kernel tests, proofs, tier 2 results and infra synth are skipped only when every changed file is under `web/`.
- Web tests are skipped only when no changed file is under `web/`, `docs/`, `.github/` or `tools/`, at the repository root (a path without `/`, including dotfiles), or in the external input list below.
- The external inputs read by web imports, generators and tests live in [`WEB_READ_PATHS` in the classifier](../tools/desk_tools/changed_paths.py). Source-scan tests keep those reads covered and reject web dependencies in backend-scoped code except the documented deployment paths. The About pages' raw Markdown imports are already covered by `docs/`.
- An empty diff, a git error or timeout, unreadable output, or an unexpected path runs everything. Quoted or escaped paths and noncanonical paths cannot earn a skip.

Scoping fails closed: each scoped job depends on `changes` and uses `${{ !cancelled() && needs.changes.outputs.<flag> != 'false' }}`. A `false` output skips a suite before it takes a machine. The classifier writes only lowercase `true` or `false`; GitHub compares expression strings without regard to case. A failed classifier or missing output runs the suite unless the workflow is cancelled. A skipped job reports as skipped. The required shard check jobs keep `if: always()` and require either four successes or an explicit `false` flag with four skipped shards; failure, cancellation, or missing results fail the check. A suite ruled out by paths with a failed shard also fails its check.

Rejected designs: workflow-level `paths` filters leave required checks missing; a plain `if: needs.changes.outputs...` skips suites when classification fails; a third-party paths-filter action adds another pinned dependency for work handled by one standard-library script.

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

The gates in the workflow (`RESULTS_BASE` is the event's base commit on pull requests and the repository's root commit on pushes and manual runs; `HISTORY_SINCE` is empty on pull requests and the same root commit otherwise, so a cancelled run can't hide missing results or rewritten histories from the next one):

| Gate | Runs once this exists | Fails if missing while this exists | Command |
|---|---|---|---|
| `proofs` | `backend/scripts/prove_presets.py` | `kernel/cedar/proofs` or `backend/desk/kernel_service/compiler.py` | `make check-presets` |
| `tier1` | `evals/run.py` | `backend/desk/kernel_service/app.py` | `make evals-tier1` |
| `kernel-contract` | `backend/tests/kernel_contract/conftest.py` | `backend/desk/api/kernel_client.py` | `make kernel-contract` |
| `tier2-results` | `evals/results.py` | `evals/results` | `make evals-results-check BASE="$RESULTS_BASE" HISTORY_SINCE="$HISTORY_SINCE"` |
| `web` | `web/package.json` | | `make web-test` |
| `web-e2e` | `web/playwright.config.ts` | `web/e2e` | `make web-e2e` |
| `infra` | `infra/cdk.json` | | `make infra-check` |
| `docs` | `tools/desk_tools/check_docs.py` | | `make docs-check` |

- A `--run-if` path is always the suite's own code, never its data. Data can only require a suite, so deleting the tier 2 results can't switch their check off.
- A `--required-if` path is code or data that exists once the suite has to run: the shipped proof reports or the rule compiler for `proofs`, the API's kernel client for `kernel-contract`, the end-to-end tests for `web-e2e`. Moving or deleting a suite's checker then fails the check instead of skipping it.
- The rule compiler lands a few commits before `make check-presets`. In between, `proofs` fails rather than skips.
- Path scoping happens before these gates on pull requests. On pushes to `main` and manual runs every suite remains eligible to run.

## Tier 2 runs locally

Tier 2 is the model-driven attack suite and legitimate-task suite. It needs a model key, and CI holds none.

- It runs locally with the development key.
- Its results file is committed to `evals/results/`, named by a hash of the gated inputs.
- On a pull request, `tier 2 results` reads the committed merge of the pull request into its base branch, which is what CI checks out. It compares changes and recorded history against the event's base commit, including for stacked pull requests. While every scenario is pending, no results file is needed and none must be regenerated. Rate and waiver histories must still only grow, landed plans must be kept, and added or edited results files must still validate; any recorded rate refuses the unarmed exception. Once plan 02 lands and any scenario can run, the strict rule applies: it fails when gated inputs changed and no passing results file covers them; a waivers-only change also needs a results file and gate recomputation.
- Before merging, fetch origin and run `make evals-merge-ready HEAD=origin/<branch>`. It is ready if both sides have empty recorded-rate histories, every scenario from either side (each side's requirements for a shared id) is pending against their combined landed plans, and every scenario in the actual merge tree is pending too, whatever results inputs changed. The merge tree must also preserve the base's rate and waiver histories unchanged, keep its landed plans, and have consistent suite and splits. A merge conflict always refuses, an error exits 2, and on every path the merge must have exactly one Alembic head, so two pull requests that each add a migration on the same parent can't both merge. Otherwise, when both sides changed results inputs since their merge base, rebase onto `origin/main`, regenerate results for the combined inputs (a pass that runs scenarios spends money and needs the owner's go first), remove the stale file, push and wait for green before checking readiness again and merging.
- Pushes to `main` and manual runs check the head against the repository's root commit with the same unarmed exception. They also hold the rate, waiver and landed-plan histories append-only against every earlier commit on the branch they check, along its first parents: `main` for a push, the selected branch for a manual run (`HISTORY_SINCE`, that same root commit): each earlier rate and waiver history must begin the head's unchanged, the head must keep every plan an earlier commit lists, and a history file that can't be read at any of those commits fails the check. A force-push to `main` fails the check, since CI can't check the history it replaced. Once any scenario can run, missing passing results for the head's gated inputs fail the next run even when the merge that introduced the gap had its run cancelled.

## Runners

- **Default.** Every job runs on a GitHub-hosted `ubuntu-24.04` runner (x86-64).
- **Self-hosted.** The repository variable `CI_RUNNER_MODE=ec2` moves every job to self-hosted, single-use Ubuntu 24.04 arm64 runners on AWS. They have no cloud role and run on an isolated network. Every run uses on-demand capacity, pull requests included: on November 1, 2026, AWS reclaimed Spot machines and cut jobs mid-run, so pull requests moved off Spot until the repository owner moves them back. Each label keeps its market part, so moving back changes one value in each job's `runs-on`.
- **Why.** The switch lets CI run on arm64, the production target's architecture, without drawing on the limited Actions minutes a private repository includes. The runner properties in this section, and the label form, are set by a runner launcher that this repository doesn't contain.
- **Pull requests from forks.** They always run on GitHub-hosted runners: the switch is on only for pushes, manual runs and pull requests whose head repository is this one. The runner launcher also starts runners only for runs whose head repository is this one, and it caps how many instances run and how long each lives. "Run workflows from fork pull requests" stays off while the repository is private, and if it ever goes public, runs from outside contributors need approval. Setting the variable spends AWS money, so it is the repository owner's call.
- **Labels.** Each job asks for a label of its own, `desk-ci-<spot or ondemand>-<run id>-<attempt>-<job>`, so no two jobs share a runner. By the runner launcher's contract, a desk runner carries exactly `self-hosted` and its own desk label, with no default OS or architecture labels such as `linux` or `ARM64`. GitHub gives a job to any runner that has all of the job's labels, so every job in every workflow asks either for a GitHub-hosted image label (`ubuntu-…`, `windows-…` or `macos-…`) or, for `ci.yml`'s required checks, suite shards and `changed paths` only, for its own desk expression; a workflow test enforces this. The path classifier's unique suffix is `changes`; every suffix matches `[a-z][a-z0-9-]{0,31}`.
- **Shard labels.** Backend shards use the suffixes `backend-1` through `backend-4`, tier 1 shards use `tier1-1` through `tier1-4`, and web shards use `web-1` through `web-4`, with `web-e2e` for the web end-to-end job. The required check jobs keep `backend`, `tier1` and `web`.
- **Database image.** The Postgres service is Docker's official `postgres:16`, the image `docker-compose.yml` uses. GitHub-hosted runners pull it from Docker Hub, since their shared addresses run into ECR Public's anonymous pull limit. Self-hosted runners pull the same image and tag from its ECR Public mirror, `public.ecr.aws/docker/library/postgres:16`.
- **Prerequisites.** A runner must be Ubuntu 24.04 and have `docker`, `sudo`, `curl`, `git`, `make`, `unzip`, `cc` and `tar`. GitHub-hosted runners do. setup-desk's first step fails, naming what is wrong, when a runner that isn't GitHub-hosted isn't Ubuntu 24.04 (noble), or when any runner lacks curl, unzip, make or cc.
- **Setup.** Where a runner has no rustup, psql or ShellCheck, the jobs install them first: rustup from a checked rustup-init, the Postgres client and ShellCheck with apt from Ubuntu's signed archive, at the current noble version and not sha256-pinned. GitHub-hosted runners have all three, so nothing is installed there.
- **apt locks.** The workflow's own `apt-get install` steps wait up to five minutes for the dpkg lock (`-o DPkg::Lock::Timeout=300`). Everything else that uses apt, such as the `apt-get update` before each install (whose package lists lock that option doesn't cover) and Playwright's own installs, relies on the runner image, which masks apt-daily, apt-daily-upgrade and unattended-upgrades so the locks are free at boot.
- **Kill switch.** Unset the variable, and the next run is back on GitHub-hosted runners. Any value other than `ec2` (in any letter case) does the same. Jobs that already asked for a self-hosted runner keep waiting for one until they are cancelled.

## Runner minutes

The first run took 27 billed runner minutes, summed over the original nine jobs (21 minutes of job time; GitHub rounds each job up to the minute). Measured on the first run, on October 29, 2026, before most suites had landed and before the backend and tier 1 jobs were sharded, so expect more as the web, infrastructure and eval suites arrive. The longest jobs were backend tests (6m 22s), proofs (5m 46s), tier 1 evals (5m 13s) and kernel tests (2m 18s); the run took about 6.5 minutes end to end.

While the repository is private, runs draw on the account's included Actions minutes: 2,000 a month on GitHub Free.

## Branch protection

Branch protection isn't configured from this repository; it is the repository owner's call.

- **Plan.** On a private repository, branch protection needs GitHub Pro or a paid organization plan.
- **Skips.** A skipped check counts as passing. That covers path scoping and the gate's visible skips. The shard check jobs still run and validate the reason their shards skipped.
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
  - The backend tests and tier 1 evals need the local database (`docker compose up -d db`). Both empty its tables as they run, so use a database whose data doesn't matter (`docs/evals.md`, "Reproduce a run").
  - The kernel tests, proofs and tier 1 evals need cvc5, found through `CVC5` or `PATH`.
