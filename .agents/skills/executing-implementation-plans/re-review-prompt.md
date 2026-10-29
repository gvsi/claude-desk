<!-- Adapted from obra/superpowers 6.4.1 (MIT, see LICENSE-superpowers). -->

# Scoped Re-Review Prompt Template

Dispatch after each fix round. The re-reviewer checks that each finding was addressed and that the fix broke nothing; it is not a fresh review. Run it like the task review (fresh GPT-6.1 Sol `codex exec` seat, or the `plan-task-reviewer` agent as fallback, prompt written to `.plan-runs/<plan-slug>/task-<N>-rereview-<R>-prompt.md`). The status line is `Fix round:`.

```
You are re-reviewing one task's fix round. A previous review produced
findings and the implementer has tried to fix them. Verdict each finding
and inspect the fix diff, nothing else. Read AGENTS.md first.

## The task

The "Task N" section of [PLAN_FILE].

## Findings under verification

[FINDINGS]

## The fix

Read the implementer's report; fix reports are appended at the end:
[REPORT_FILE]

Range: [FIX_BASE_SHA]..[HEAD_SHA] in [WORKSPACE] (the fix base is the head
the previous review saw). Read it once:
`git log --oneline [FIX_BASE_SHA]..[HEAD_SHA]` and
`git diff -U10 [FIX_BASE_SHA]..[HEAD_SHA]`.

Your review is read-only. Don't change the working tree, the index, HEAD
or any branch, and don't dispatch subagents or ask for a second opinion.

## Scope

Verdict every finding, then inspect the fix diff for problems the fix
introduced, including any weakening of a safety invariant, the kernel/API
trust boundary or fail-closed behaviour. Don't re-review code the fix didn't
touch: list issues entirely outside it under Out-of-scope observations.
They don't block this task or extend the loop; the PR panel sees them.

## Tests

The implementer reran the covering tests and appended the results. Treat
the report as unverified claims: confirm it names the covering tests and
shows their output, and check the claims against the diff. Don't rerun the
suite; run a focused test only for a specific doubt no existing run answers.

## Output format

Your final message is the report; begin with the first finding's verdict.

### Finding verdicts
For each finding, in order:
- [finding one-liner] — ADDRESSED | NOT ADDRESSED, with file:line evidence.
  "Attempted" is not addressed: the defect must no longer exist.

### New breakage in the fix diff
Severity (P1/P2/P3) and file:line for each. "None" if clean.

### Out-of-scope observations
Non-blocking; the coordinator ledgers them. "None" if none.

### Verdict
Fix round: All findings addressed, no new P1/P2 breakage |
Findings remain open — [list the open ones]
```

**Placeholders:** `[PLAN_FILE]` and task number; `[FINDINGS]`, the previous review's P1 and P2 findings and spec issues, verbatim, one per bullet; `[REPORT_FILE]`; `[WORKSPACE]`; `[FIX_BASE_SHA]`, the head the previous review saw; `[HEAD_SHA]`, the current head.
