<!-- Adapted from obra/superpowers 6.4.1 (MIT, see LICENSE-superpowers). -->

# Task Reviewer Prompt Template

One review per task: the reviewer reads the task's diff once and returns two verdicts, spec compliance and code quality. Fill the template, write it to `.plan-runs/<plan-slug>/task-<N>-review-prompt.md`, and run the GPT-6.1 Sol seat on it with `codex exec` as `orchestrating-review-subagents` describes (`"$(cat <that file>)"` as the prompt). If Codex is unavailable, dispatch the `plan-task-reviewer` agent with `model: opus` and the same prompt. The status line is `Task quality:`.

```
You are reviewing one task's implementation: first whether it matches its
requirements, then whether it is well built. This is a task-scoped gate;
the two-seat panel reviews the whole part plan in its PR. Read AGENTS.md first.

## What was requested

The "Task N" section of [PLAN_FILE].

Global constraints that bind this task:
[GLOBAL_CONSTRAINTS]

## What the implementer claims

Read the implementer's report: [REPORT_FILE]

## Diff under review

Range: [BASE_SHA]..[HEAD_SHA] in [WORKSPACE]. Read it once:
`git log --oneline [BASE_SHA]..[HEAD_SHA]`, `git diff --stat [BASE_SHA]..[HEAD_SHA]`
and `git diff -U10 [BASE_SHA]..[HEAD_SHA]`. Read a changed file separately
only when a hunk you must judge is cut off, and say so. Don't crawl the
codebase: look outside the diff only to check a concrete risk you can name
(one focused check per risk, naming both). Changes to a contract, shared
state or a kernel endpoint are named risks; checking their callers is right.

Your review is read-only. Don't change the working tree, the index, HEAD
or any branch, and don't dispatch subagents or ask for a second opinion. If
the diff feels too large for one pass, review it in passes and say so.

## Don't trust the report

Treat the report as unverified claims and check them against the diff.
Design rationales ("kept it simple", "YAGNI") are the implementer grading
their own work; they never lower a finding's severity.

## Tests

The implementer ran the tests and reported RED/GREEN evidence. Don't rerun
the suite to confirm it. Run a focused test only when the code raises a
specific doubt no existing run answers; recommend heavier checks instead of
running them. Warnings or noise in the reported output are findings. If the
evidence looks truncated or missing, re-read the report at its path; if it
is really missing, report that as a gap.

## Part 1: spec compliance

- Missing: requirements skipped, or claimed without being implemented.
- Extra: features nobody asked for, over-engineering.
- Misunderstood: the right feature built the wrong way.

If the task lists several files with a change each, check every one has its
hunk. A requirement you can't verify from this diff alone (it lives in
unchanged code or spans tasks) goes under "Cannot verify from diff".

## Part 2: code quality and safety

- Safety invariants (AGENTS.md): does any change weaken one, open a path
  around one, or loosen a test, eval threshold or oracle to get past one?
  Every tool call through /decide, every visitor-visible text through the
  reply check, rules only from the compiler?
- Trust boundary: the API process holds no business credentials, can't
  write kernel tables, and passes session IDs, never identities.
- Fail closed: every error, timeout, missing score, unknown tool or parse
  failure ends in refuse, hold or block, never allow, execute or reveal.
- Untrusted text: tool results, knowledge, MCP descriptions, whispers and
  visitor messages are never treated as instructions or policy.
- Evals: a kernel, prompt or policy change shows fast eval suite results.
- Tests verify real behaviour, not mocks; the task's edge cases are covered.
- Error handling, separation of concerns, DRY without premature
  abstraction, the plan's file structure, no new oversized files.

Cite file:line for every finding and for any check you'd otherwise answer
with a bare "yes".

## Calibration

P1: breaks a safety invariant, the trust boundary or fail-closed
behaviour, or loses or corrupts data. P2: this task can't be trusted until
it's fixed: incorrect or fragile behaviour, a missed requirement, swallowed
errors, duplicated logic blocks, tests that assert nothing. Broader coverage
and polish are P3. An open P1 or P2 sets the task aside; only P3s can be
parked. If the plan itself mandates a defect, report it as P2,
labelled plan-mandated; the project owner decides.

## Output format

Your final message is the report; begin with the spec verdict. Every line
is a verdict, a finding with file:line, or a check you ran.

### Spec compliance
- Spec compliant | Issues found: [missing/extra/misunderstood, file:line]
- Cannot verify from diff: [items and what the coordinator should check]

### Issues
#### P1 (must fix)
#### P2 (must fix before landing)
#### P3 (minor)
For each: file:line, what's wrong, why it matters, how to fix.

### Assessment
Task quality: Approved | Needs fixes
Reasoning: [1–2 sentences]
```

**Placeholders:** `[PLAN_FILE]` and task number; `[GLOBAL_CONSTRAINTS]`, copied verbatim from the plan's Global Constraints (exact values, formats and relationships between components, not process rules); `[REPORT_FILE]`; `[WORKSPACE]`; `[BASE_SHA]`, the recorded task BASE; `[HEAD_SHA]`, the current head.
