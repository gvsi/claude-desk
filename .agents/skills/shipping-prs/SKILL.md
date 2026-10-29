---
name: shipping-prs
description: Use when opening, updating, merging or watching a pull request in this repo, or closing out after a merge.
---

# Shipping PRs

Work reaches `main` through a pull request: a branch in a worktree, the two-seat review panel, green CI checks, then a squash merge. `executing-implementation-plans` follows this for each part plan.

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
    2. Push the captures to the orphan `pr-media` branch under `pr-<n>/` only, from a worktree on that branch (`git fetch origin pr-media && git worktree add .worktrees/pr-media pr-media`). If the push is rejected because another worktree pushed first, run `git fetch origin pr-media && git rebase origin/pr-media` and push again; never force-push `pr-media`.
    3. Edit the description (`gh pr edit <n> --body-file <file>`) to link each capture as `https://github.com/gvsi/claude-desk/blob/pr-media/pr-<n>/<file>?raw=true`.

    A PR that touches `web/` or copy with no visible change says so here instead.
  - The last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **PR text is written for outside readers** of the public history: neutral and self-contained, with no internal shorthand, no references to private docs or conversations, no local paths, and no secrets or logs that might hold them.

## Review and CI

- Start the panel (`orchestrating-review-subagents`, code review on `origin/main...HEAD`) as soon as the PR is open; don't wait for checks. Every push that updates the PR starts the next round while checks run in parallel.
- Watch checks with `gh pr checks <n> --watch` and fix until they are green. An assertion failure is never infrastructure, and a test is not "flaky" without evidence.
- Infrastructure failure (no runner, a job that died before running tests): `gh run rerun <run-id> --failed`, at most twice, then stop and report.
- If the repo has no CI checks yet, `gh pr checks` reports none. Say so in the PR body; the quoted local test results are the evidence.
- **Updating:** if `origin/main` has moved and the PR conflicts or falls behind, `git fetch origin && git rebase origin/main`, rerun the tests and `git push --force-with-lease`. A rebase that changes behaviour gets another review round.

## Merge

- Merge only when the panel loop has ended with no `VALID — fix now` P1 or P2, no round is running, and every check is green: `gh pr merge <n> --squash`. Never merge with a failing or pending check.
- The squash commit keeps the PR title as its subject and ends with the `Co-Authored-By` line from `AGENTS.md`; pass `--subject` and `--body` when the default message would drop it.
- A clean panel is not owner sign-off. Anything on the sign-off list in `AGENTS.md` still needs the project owner's go before merge.
- A design PR (`AGENTS.md` "Design PRs") also needs the project owner's sign-off in the PR before merge.

## Close out

1. Remove the worktree once it has no uncommitted work, and delete the branch locally and on the remote: `git worktree remove .worktrees/<name> && git branch -D <branch> && git push origin --delete <branch>`. Never delete `pr-media`: it holds every design PR's captures.
2. Fast-forward the main checkout only when it is on `main` and clean: `git pull --ff-only`. Otherwise say you skipped it.
3. Close issues the PR settles with a comment naming the PR and what was verified. Record anything still owed as a GitHub issue, not only in chat.
4. Report: the PR link, what merged, the test and check results, the panel's verdict, and any follow-ups.
