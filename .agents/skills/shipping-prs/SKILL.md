---
name: shipping-prs
description: Use when opening, updating, merging or watching a pull request in this repo, or closing out after a merge.
---

# Shipping PRs

Work reaches `main` through a pull request: a branch in a worktree, the review panel (two seats, three for critical work), green CI checks, then a squash merge. `executing-implementation-plans` follows this for each part plan.

## Open

- Work in a worktree under `.worktrees/` (git-ignored) on a branch created from `origin/main`: `git fetch origin && git worktree add --no-track -b <branch> .worktrees/<name> origin/main`.
- Commit, push with `git push -u origin <branch>`, and open the PR with `gh pr create --title "<title>" --body-file <file>`.
- **Title:** a conventional-commit title (`feat: …`, `fix: …`, `docs: …`), imperative and specific about what changed. It becomes the squash commit's subject.
- **Body:**
  - Summary: what changed and why, in a few lines.
  - Tests: each command run and its result, quoted (pass counts, not "tests pass"), plus eval results when the kernel, prompts or policies changed.
  - Review: for a plan's PR, the plan's Review Ledger, any parked P3s, and any task set aside with its branch.
  - Design evidence, for a design PR (`AGENTS.md` "Design PRs"): the screenshots and recordings, never committed to the PR's branch or uploaded through a browser form (layout and contact sheets: "Design PRs" in `docs/plans/2026-10-28-00-master-plan.md`). In this order:
    1. Open the PR; its number `<n>` names the captures' folder.
    2. Push the captures to the orphan `pr-media` branch under `pr-<n>/` only, from a detached worktree of your own, since Git checks a branch out in one worktree at a time and other design PRs push captures too: `git fetch origin pr-media && git worktree add --detach .worktrees/pr-media-<n> origin/pr-media`; copy the captures into its `pr-<n>/`, `git add pr-<n> && git commit`, then `git push origin HEAD:pr-media`. If the push is rejected because another PR pushed first, run `git fetch origin pr-media && git rebase origin/pr-media` in that worktree and push again, until it goes through; never force-push `pr-media`. Then `git worktree remove .worktrees/pr-media-<n>`.
    3. Edit the description (`gh pr edit <n> --body-file <file>`) to link each capture as `https://github.com/gvsi/claude-desk/blob/pr-media/pr-<n>/<file>?raw=true`.

    A PR that touches `web/` or copy with no visible change says so here instead.
  - The last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **PR text is written for outside readers** of the public history: neutral and self-contained, with no internal shorthand, no references to private docs or conversations, no local paths, and no secrets or logs that might hold them.

## Review and CI

- Start the panel (`orchestrating-review-subagents`, code review on `origin/main...HEAD`) as soon as the PR is open; don't wait for checks. Every push that updates the PR starts the next round while checks run in parallel.
- Watch checks with `gh pr checks <n> --watch` and fix until they are green. An assertion failure is never infrastructure, and a test is not "flaky" without evidence.
- Infrastructure failure (no runner, a job that died before running tests): `gh run rerun <run-id> --failed`, at most twice, then stop and report.
- Spot reclaim: a job that fails with "The runner has received a shutdown signal" or "lost communication with the server". Don't investigate it. The orchestrator's watcher reruns the failed jobs within about two minutes, on-demand; if nothing has restarted after five minutes, rerun it yourself as above.
- If the repo has no CI checks yet, `gh pr checks` reports none. Say so in the PR body; the quoted local test results are the evidence.
- **Updating:** don't rebase just because `origin/main` moved. A PR whose own CI is green on its head merges as long as GitHub reports no conflict; main's CI run after the merge is the integration check, and deploys ship only a green `main`. Rebase (`git fetch origin && git rebase origin/main`, rerun the tests, `git push --force-with-lease`) only for a real conflict, a database migration, a `PROMPT_VERSION` bump, or a PR that changes the same files as what just landed (owner, 2026-11-01). A rebase that changes behaviour gets another review round.

## Merge

- Before `gh pr merge`, run `git fetch origin` and `make evals-merge-ready HEAD=origin/<branch>`; merge only on exit 0. It checks both sides' scenarios (each side's requirements for a shared id) against the union of their landed plans. While both sides have empty recorded-rate histories, every scenario is pending under that union, and every scenario in the actual merge tree is pending too, it is ready whatever results inputs changed: no results file is needed and none must be regenerated. Once plan 02 lands and any scenario can run, the strict both-sides rule applies. On `not ready` (subcommand exit 1; make reports any recipe failure as exit 2), rebase onto `origin/main`, regenerate results for the combined inputs (a pass that runs scenarios spends money and needs the owner's go first), remove the stale file, push and wait for green before checking readiness again and merging; resolve `error` results before merging.
- Merge only when the panel loop has ended with no `VALID — fix now` P1 or P2, no round is running, and every check is green: `gh pr merge <n> --squash`. Never merge with a failing or pending check.
- The squash commit keeps the PR title as its subject and ends with the `Co-Authored-By` line from `AGENTS.md`; pass `--subject` and `--body` when the default message would drop it.
- A clean panel is not owner sign-off. Anything on the sign-off list in `AGENTS.md` still needs the project owner's go before merge.
- A design PR (`AGENTS.md` "Design PRs") also needs the project owner's sign-off in the PR before merge.

## Close out

1. Remove the worktree once it has no uncommitted work, and delete the branch locally and on the remote: `git worktree remove .worktrees/<name> && git branch -D <branch> && git push origin --delete <branch>`. Never delete `pr-media`: it holds every design PR's captures.
2. Fast-forward the main checkout only when it is on `main` and clean: `git pull --ff-only`. Otherwise say you skipped it.
3. Close issues the PR settles with a comment naming the PR and what was verified. Record anything still owed as a GitHub issue, not only in chat.
4. Report: the PR link, what merged, the test and check results, the panel's verdict, and any follow-ups.
