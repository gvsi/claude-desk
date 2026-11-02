---
name: executing-implementation-plans
description: Use when executing a written implementation plan from docs/plans/ — building its tasks, resuming a half-built plan, or whenever a plan or another skill calls for subagent-driven development or executing a plan task by task.
---

# Executing Implementation Plans

The plan runner for this repo. Adapted from obra/superpowers 6.4.1 (MIT, `LICENSE-superpowers`); use it in place of that project's subagent-driven-development and executing-plans skills.

**Core principle:** a fresh implementer per task, one task review per task, at most two fix rounds, then one pull request per part plan with the review panel (two seats, three for critical work) as the final gate. You coordinate; you never write task code yourself.

## Seats

| Seat | Model | How |
|---|---|---|
| Implementer | Opus 5.5; Fable 5.1 at `xhigh` for a very complex or critical task (the kernel, the kernel/API trust boundary, money, verification, the evals gate, the master plan) | the `plan-implementer` agent via the Agent tool with `model: opus` (`model: fable` for those), a fresh agent per task; fix rounds resume the same agent (SendMessage). Fable: paused, see AGENTS.md, Agents. |
| Task reviewer and re-reviewer | GPT-6.1 Sol at `xhigh` | `codex exec`, launched and checked as in `orchestrating-review-subagents`, a fresh run each time; fallback: the `plan-task-reviewer` agent with `model: opus` |
| PR gate | Opus 5.5 and GPT-6.1 Sol at `xhigh`, plus Fable 5.1 at `xhigh` for critical work | the panel in `orchestrating-review-subagents` |

- Always pass `model` explicitly; an omitted model inherits the session's. Run the coordinating session at `xhigh`, since native subagents inherit its effort.
- The task review is a cross-vendor check on the Claude implementer. Its status line is `Task quality:` (re-review: `Fix round:`). If Codex is unavailable, run that review on a fresh `plan-task-reviewer` seat with the same prompt and ledger the substitution; the PR gate still needs every panel seat.
- From a Codex session, the implementer runs as `claude -p --model opus` (`--model fable --effort xhigh` for critical work) from the repo root (fix rounds: `claude -p --resume <session_id>`), and Sol reviews natively.
- Implementers and reviewers never dispatch subagents of their own.

## Workspace

- Each part plan runs in its own worktree on its own branch, created from `origin/main`: `git fetch origin && git worktree add --no-track -b plan/<plan-slug> .worktrees/<plan-slug> origin/main`.
- Tasks commit on that branch. Nothing reaches `main` per task; the plan's work lands through one pull request (see Finish).
- Run notes live in `.plan-runs/<plan-slug>/` in the main checkout (git-ignored): the ledger `progress.md`, the reports `task-<N>-report.md`, and filled reviewer prompts.

## Setup

1. Open the ledger, or create it with first line `# Ledger — plan: docs/plans/<file>`. After compaction, trust the ledger and `git log` over your memory.
2. Ledger `Plan BASE <sha>` (the `origin/main` commit the worktree started from) before Task 1.
3. **Resume** task by task. `Task <N>: complete` or `set aside` → skip. `Task <N>: start` with no later line → commits in `<BASE>..HEAD` go straight to review; none → re-dispatch the implementer. Last line is a fix round → continue at the next round with the recorded BASE. Never re-record BASE for a started task.
4. Read the plan, the master plan sections it consumes and the spec once. One todo per task. Note tasks that share a file or interface, and rule on any conflict before Task 1.

## The task loop

1. **Record BASE** in the plan's worktree (`git rev-parse HEAD`) and ledger `Task <N>: start (BASE <sha>)` before dispatching.
2. **Dispatch the implementer** with [implementer-prompt.md](implementer-prompt.md): the plan path and task number, one line on where the task fits, interfaces from earlier tasks, your answer to any ambiguity, the workspace and the report path. Paste no prior-task history. One implementer at a time, never in parallel.
3. **Handle the status.** DONE → review. DONE_WITH_CONCERNS → read the concerns; correctness or scope concerns are fixed before review. NEEDS_CONTEXT → answer and resume. BLOCKED → more context, a smaller split or a ruling, never the same retry with nothing changed. BLOCKED on a safety invariant → set the task aside and raise it (see Rulings).
4. **Review:** dispatch [task-reviewer-prompt.md](task-reviewer-prompt.md) with the task, the report, `<BASE>..HEAD` and the plan's Global Constraints copied verbatim. Never tell a reviewer what not to flag. Resolve each "cannot verify from diff" item yourself; a real gap fails the review.
5. **Fix loop, two rounds at most.** Triggered by spec issues, any P1 or P2 finding, or a confirmed gap. P3 findings never enter the loop: park each in the plan's `## Review Ledger` as `Task <N>: P3 parked — <finding> — <why it can wait>`. Only P3s can be parked.
   - Each round: resume the same implementer with the open findings verbatim; it fixes, reruns the covering tests and appends to its report. Then a scoped re-review with [re-review-prompt.md](re-review-prompt.md) on `<FIX_BASE>..HEAD`.
   - Ledger each round: `Task <N>: fix round <R>/2 (<X> addressed, <Y> open — <one-liners>; <a7>..<b7>)`.
   - A P1 or P2 still open after round 2 sets that task aside, not the run. Move its commits to their own branch and rewind the plan branch: `git branch plan/<plan-slug>-task-<N> HEAD && git reset --hard <BASE>`. Ledger `Task <N>: set aside on plan/<plan-slug>-task-<N> — <open findings>` and report it to the project owner with the findings verbatim. Continue with the tasks that don't depend on it; ledger each one that does as `Task <M>: skipped — depends on Task <N>`.
   - A finding that weakens a safety invariant is never parked as P3. Set the task aside the same way and raise it with the project owner right away.
   - Never fix findings yourself.
6. **Complete:** run the task's tests, ledger `Task <N>: complete (<base7>..<head7>, review clean | <K> P3 parked)`, mark the todo, next task.

## Tests and evals

- Test-first, per `AGENTS.md`: one test at a time, run it, fix before moving on, and never commit while a test fails. Implementer reports carry RED and GREEN evidence: the command and its output.
- Before calling anything done (a task, a fix round, a part plan), run the command that proves it and quote the result. A claim without output is not evidence.
- **Evals gate.** A task that touches the kernel (`kernel/`, `backend/desk/kernel_service/`), prompts or policies runs the fast, model-free eval suite before reporting. Before the PR merges, the attack suite must show zero baseline violations and the legitimate-task suite must be at or above its recorded completion rate on the final head. A miss fails the gate; it is never fixed by editing a threshold, an oracle or a recorded rate. Until the suites exist, ledger `Evals: not yet available` and say so in the report.

## Rulings and when to stop

Don't pause between tasks or ask whether to continue. Decide ambiguities, plan defects and conflicts yourself (the spec outranks the plan, and the master plan's contracts outrank a part plan), and ledger each one: `Ruling: <decision> — <why> — <cost if wrong>`.

Stop and raise it with the project owner instead of ruling when:

- a task seems to need weakening, bypassing or carving an exception into any of the six safety invariants in `AGENTS.md`, including to make a test or eval pass;
- a step falls on the owner sign-off list in `AGENTS.md`. A plan that says "deploy" or "create the stack" is a plan, not an approval;
- every path forward is a guess.

## Finish: one PR per part plan

When every task is complete, set aside or skipped, run the test suites the plan touched and, where it applies, the evals gate in the worktree, and quote the results. Then follow `shipping-prs`:

1. Push the branch: `git push -u origin plan/<plan-slug>`.
2. Open the PR with `gh pr create`: a conventional-commit title; a body with the summary, the test commands with their results, the plan's Review Ledger and any parked P3s, and any task set aside with its branch. The body ends with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
3. Load `orchestrating-review-subagents` and run the code-review panel (two seats, three for critical work) on `origin/main...HEAD`. Put every parked P3 and every `Ruling:` line from the run ledger verbatim in the dispatch.
4. Validated findings go to a fresh `plan-implementer` with the findings verbatim; commit, rerun the covering tests and push. Rounds follow that skill's cap.
5. Merge (squash) once the panel is clean and CI checks are green.
6. Remove the worktree and `.plan-runs/<plan-slug>/`, and delete the plan branch. Branches of tasks set aside stay.

Report: the PR link and merge state, test and eval results, the panel's verdict, every ruling with its cost if wrong, every parked P3, and every task set aside or skipped. If the project owner skips the panel, ledger `Review: skipped by the project owner`, say so in the PR body, and don't merge without their go.

## Red flags

| Thought | Reality |
|---|---|
| "One more fix round will converge" | Two is the cap. Set the task aside on its own branch, report it, carry on. |
| "It's only P2; I'll park it and keep the task" | Only P3s are parked. An open P1 or P2 sets the task aside. |
| "A task is set aside, so I'll stop the run" | Only that task and the ones depending on it stop. |
| "I'll fix it myself; dispatching is overhead" | Your fixes skip review and fill your context. Resume the implementer. |
| "The test only passes if this check is relaxed" | That is a safety invariant in the way. Stop and raise it. |
| "The attack suite flags a false positive; I'll adjust the oracle" | A changed oracle or threshold is a failed gate. Raise it. |
| "It's a small error path; allowing is friendlier" | Errors fail closed: refuse, hold or block. |
| "The plan says deploy, so it's approved" | A plan is not an approval. Deploys need the project owner's go. |
| "CI is still running, but the panel is clean" | Merge only with checks green. |
| "The implementer spawned its own reviewer; extra assurance" | A duplicate seat at full cost. Implementers never dispatch subagents. |
| "Tests passed earlier, so it's done" | Run the proving command now and quote it. |
