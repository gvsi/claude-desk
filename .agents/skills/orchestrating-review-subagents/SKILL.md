---
name: orchestrating-review-subagents
description: Use when asked to spin up plan reviewers, review a plan or spec, spin up code review subagents, run the reviewer panel on a commit range, or resume an in-progress review loop.
---

# Orchestrating Review Subagents

This skill is the single source of truth for running plan and code reviews through the reviewer panel. Before any later round of a review loop, re-read this file in full if your context may have been compacted; it holds the loop rules.

## The panel

Critical changes (the kernel/API trust boundary, money, verification, approvals, the ledger, the reply check, prompts and the evals gate's scoring) get two seats at `xhigh` from different model families, dispatched in parallel; other changes get the GPT-6.1 Sol seat alone (`AGENTS.md`, **Agents**). Don't ask the project owner to choose a panel.

- **Opus 5.5**, native: the Agent tool with `model: opus`, from a Claude Code session running at `xhigh` (native subagents inherit the session's effort). Claude Code never shells out to `claude -p` for this seat.
- **GPT-6.1 Sol**: `codex exec -C <repo root> -c model=gpt-6.1-sol -c model_reasoning_effort=xhigh --json "<prompt>" < /dev/null`, with a sandbox setting as below.
- From a Codex session the transports swap: Sol runs natively, and Opus runs as `claude -p --model opus --effort xhigh --output-format json "<prompt>" < /dev/null` from the repo root.

The project owner's explicit choices (models, panel, round cap) override these defaults. If one seat is unavailable (CLI, authentication or usage limit), run the round with the others and report the reduced panel and the reason. The gate stays incomplete until every seat it needs finishes or the project owner waives it.

## Reviewer mutation boundary

Reviewers verify; they don't only read. They may run tests, linters, builds, repository scripts and other focused checks, including ones that create normal local caches, temporary files or isolated test data, and they may use any read-only diagnostic capability available to them. The examples are not an exhaustive allowlist.

A reviewer never edits the review target and never changes external state: no deploys, cloud resources, configuration changes, writes to shared data, messages, commits or pushes. It returns findings; the orchestrator owns every fix. If it lacks a capability it needs, it returns a verification hint instead of claiming the check ran. It never prints secrets.

## CLI seats: completion and waiting

- Launch from the repo root so the seat loads `AGENTS.md`. Run it as a long-lived foreground process through the orchestrator's exec facility: no shell `&`, and keep `< /dev/null` so it can't block on stdin.
- Give a CLI seat a sandbox that allows the `uv` cache and the localhost sockets the tests need. The no-edit boundary above still applies.
- A Codex seat is complete only with process exit `0`, a final `item.completed` agent message containing a valid reviewer status, and `turn.completed`. A Claude CLI seat needs exit `0`, `is_error: false`, a success subtype and a `result` containing a valid status. A transcript that ends in a tool call without a status is incomplete: rerun that seat in the same round.
- **Usage limits are a hard stop, not a hang.** Codex can print `ERROR: You've hit your usage limit … try again at <time>` and exit. Never retry in a loop. In the panel, continue with the other seat and note when Codex can be retried. For a single-seat review, report the blocker and ask the project owner before substituting another model.
- Wait on the process handle and resume when it exits; if only polling is available, use the longest blocking wait the harness allows (3–5 minutes), not 30-second polls. Never kill a seat because it is slow or quiet; `xhigh` reasoning can stay silent for a long time while healthy. No `timeout` wrappers or broad `pkill`. Authentication errors, usage limits, process failures and malformed output follow the rules above; none of them counts as completion.

## Dispatch inputs

Give each seat short locating context, never pasted payloads:

- **Purpose:** 1–3 sentences on what the plan or change is for.
- **Requirement source:** the spec in `docs/specs/`, the plan in `docs/plans/` and its task numbers, or a note that none exists.
- **Target:** the plan path, a PR number and branch with the range `origin/main...HEAD`, or an exact commit range `<base>..<head>` (plus a narrower file set if there is one).
- **Constraints:** only the project owner's decisions and ledger rulings that could change the verdict.
- Open each prompt with `Read <seat spec path> first.` (the repo-relative spec path named below) and don't restate the spec. Seats fetch the target themselves.

## Shared loop

1. **Fan out** the panel's seats in parallel ("The panel"), each following its spec.
2. **Wait** for every seat under the rules above.
3. **Require valid outputs.** Valid statuses are `complete`, `complete_with_concerns`, `needs_context` and `blocked`. A round is complete when every active seat is `complete` or `complete_with_concerns` and has either listed findings or said it has no P1/P2. For `needs_context`, supply the context and rerun that seat only; for `blocked`, clear the blocker or ask the project owner. Malformed output caused by tooling: rerun that seat, same round.
4. **Consolidate** by root cause, not by wording or `file:line`, and record which seats reported each finding.
5. **Validate** each finding yourself: re-read the cited refs, run its verification hint, and give a verdict (`VALID — fix now`, `VALID — decision needed`, `VALID — defer` or `INVALID — skip`) with a one-line rationale. Check codebase reality, compatibility constraints and whether the current behaviour is intended. A fix that adds an unreachable path or speculative scope is not `fix now`. Use `decision needed` only when the right fix replaces the core approach or most of the plan; stop and ask the project owner.
6. **Fix** every `VALID — fix now` P1/P2: amend the plan, or change the code with blocking issues first, then simple fixes, then complex ones, running the narrowest proving check after each group. Take P3s when cheap; defer or skip the rest.
7. **Judgment stop.** If no `VALID — fix now` P1/P2 survives and what remains is wording, process clarification or non-behavioural cleanup, stop without another round. Never apply this to anything touching a safety invariant, the kernel/API trust boundary, money, verification, approvals, the ledger, secrets, or a failing test or eval.
8. **Terminate** when a complete round leaves no `VALID — fix now` P1/P2, the judgment stop applies, the round cap is reached, or the project owner says stop. Code review also requires the tests (and the evals gate, where it applies) to pass on the final head and, for a PR, its CI checks to be green.

**Round cap: 1 completed round** unless the project owner sets another. **P1 extension:** a completed round with any `VALID — fix now` P1 earns one more round on its fixes, and each later round with a valid P1 earns another, up to **3 completed rounds**. A targeted rerun (for `needs_context`, malformed output or tooling failure) stays in its round. At the cap, still validate and apply every authorized fix, then stop and report that those fixes were not re-reviewed.

## Foundation gate

Before collecting issues, seats review the frame of the target:

- **Goal:** the problem being solved.
- **Core model:** concepts, lifecycle, state ownership and source of truth.
- **Invariants:** the six safety invariants in `AGENTS.md`, plus any the spec or plan adds.
- **Risk boundaries:** the kernel/API trust boundary, sessions and verification, money and mandates, approvals, the ledger, reply checks, MCP pins, data labels, per-visitor copies, retries and restarts.
- **Shape:** one coherent model, or a pile of special cases.

A wrong or incomplete frame is one high-level P1/P2 `abstraction gap`, not a list of its symptoms. When validating, treat repeated findings in one area as a possible abstraction gap.

## Plan cleanup

After applying plan fixes, and before re-reviewing or declaring convergence:

- Collapse repeated patches into the simplest shared model, and remove stale branches, assumptions and contradictions left by earlier rounds.
- Prefer state tables, lifecycles, contracts and short examples to long code. Keep a snippet only when it is the contract, a test shape or a tricky integration point.
- Append or update a `## Review Ledger` at the end of the plan: each round's major findings, what changed, deferred items and the project owner's decisions.

## Display format (per finding, when reporting)

```
[#] P1 — Title  (seats: opus-5.5, gpt-6.1-sol)
Location:     path/to/file.py:42  (or plan.md §3.2)
Type:         local defect | abstraction gap | safety invariant | product decision | test coverage gap
Impact:       <plain-language impact on visitors, the owner or operations>
Root cause:   <one sentence>
Evidence:     <file:line refs, doc links, snippets>
Reasoning:    <2–4 lines: observation → conclusion>
Proposed fix: <concrete change>
Verdict:      VALID — fix now | VALID — decision needed | VALID — defer | INVALID — skip
Rationale:    <1 line>
```

## Plan review

Triggered by "spin up plan reviewers", "review the plan" or similar.

- Seat spec: `.claude/agents/implementation-plan-reviewer.md`. Target: a plan in `docs/plans/` or a spec in `docs/specs/`. Seats review only the document and use the codebase only to check its claims.
- Autonomous between rounds: amend the plan file yourself, clean it up, and re-fan-out while under the cap. Don't hand the fixes to another agent.
- Report after every round (rounds so far, validated findings in the display format, what changed) without pausing for approval.
- Final summary, written for someone who read none of the rounds: total rounds, findings by round, the plan's final state, decisions left for the project owner, `Ready to implement: yes | with fixes | no, architecture decision needed`, and the major changes in plain language.

## Code review

Triggered by "spin up review subagents", "review this PR" or similar, and by `executing-implementation-plans` once a part plan's PR is open.

- Seat spec: `.claude/agents/code-reviewer.md`. Target: a PR, reviewed as `git diff origin/main...HEAD` in its worktree, or an explicit `<base>..<head>` range; seats review only that diff. Seats check compliance with the spec and plan (missing or extra scope) before code quality.
- Start the first round as soon as the PR is opened or updated, and watch CI checks while the panel runs (`shipping-prs`).
- When the range touches both sides of a contract (the kernel HTTP API, `backend/desk/contracts.py`, fixtures generated from `contracts.schema.json`), seats check the seam first: what one side sends must match what the other accepts.
- Autonomous between rounds: implement every `VALID — fix now` finding (yourself or through a fresh implementer), commit each fix group once its tests pass, push, and re-review the updated range while under the cap.
- Report after every round (rounds so far, validated findings in the display format, the fix commits) without pausing for approval.
- Final summary: total rounds, findings by round, the final head and PR state, decisions left for the project owner, and `Ready to merge: yes | with fixes | no`.
