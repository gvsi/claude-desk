# Evals reports

Each tier 2 pass that is gated and reported leaves three files here:

- `<date>-<pass_id>.md`: the report.
- `latest.json`: the latest report's numbers, which the README, the path to MVP and the latest results in [the evals guide](../../docs/evals.md) read.
- `spend.csv`: this month's eval spend, one row per pass.

`make evals-report PASS=<id>` (`python -m evals.run report --pass <id>`) writes all three and rewrites the evals guide's latest results. It reads:

- the pass's runs and transcripts, in `evals/out/passes/<pass_id>/`, which is never committed, because transcripts quote what visitors saw;
- the pass's spend row and this month's other rows, from the spend file every worktree shares;
- the latest local and hosted latency runs made for the pass (`make evals-latency PASS=<id>`), never a dry run's;
- the calibration the reviewer's thresholds came from, at the pass's commit;
- the current recorded rate;
- with `NULL_BASELINE=<id>`, a null-baseline pass that judged exactly the held-out legitimate tasks the pass ran, with no `--only` and no stop at its budget.

Only a pass of the whole suite becomes the latest report: `--suite all`, `--split heldout` or `all`, no `--only`, and not stopped by its `--max-usd` budget. Any other pass, such as a calibration pass, gets its report alone, under `evals/out/reports/`, which is never committed. That report says what the pass left out, and the files here and the evals guide stay as they were.

It refuses a dry run, a null-baseline pass or a pass with no run, since none of them measures a Desk. It also refuses a pass whose files it can't read whole, such as a missing transcript or a scenario changed since the pass. A refused report writes nothing.

## Reading a report

A report has seven sections.

**Summary.** Whether the gate passed and, if not, why. It also shows the pass id, date, commit, what the pass ran (its suite, split and any `--only` scenarios), how many runs were judged or errored, and scenarios still pending on an unlanded part of the product. Two tables show where each part's model calls went (the API, the simulated visitor and the kernel's checks) and the model id each route sent.

**Attack suite.** Baseline violations, by category and oracle. With none, the report gives the rule-of-three bound: zero violations in n held-out attack runs puts the per-run violation rate below 3/n with 95% confidence. With some, it gives the Wilson 95% upper bound of the runs that had one. Any violation in any run fails the gate.

"What stopped each attempt" reads each attack run's records and lists what stopped it:

- a refusal or a hold at `/decide`;
- a refusal at execution;
- a reply the reply check turned down, with the kind of violation;
- a refused verification check;
- a breaker pause.

A run that broke a baseline rule is also listed as not stopped, with the oracle that caught it, even when the kernel stopped something else in it. A run with neither was declined in conversation: Claude said no without the kernel having to stop anything.

**Legitimate-task suite.** The section covers:

- Held-out completion as k of n runs, with its Wilson 95% interval.
- The recorded bar it is compared with: the Wilson 95% lower bound of N trials from the first held-out pass, signed off by the owner.
- The expected false-fail rate: how often a build whose true rate is the recorded one would fail a single run of the n held-out tasks by chance.
- False holds: held decisions on tools a task expects the Desk to be allowed to use.
- The null baseline, which must stay at or under half the held-out point.

**Reviewer.** How often the reviewer was called per conversation, and how often partial evaluation let the kernel skip it. It names the thresholds' calibration and shows a confusion table per effect: of the held-out decisions the reviewer scored, how many attack and legitimate ones were allowed without the owner or held.

**Cost.** The Desk-side cost per conversation (mean, p50, p95) and mean tokens per call by route. It also gives this pass's spend and cost per run, and the month's eval spend against the limit the cumulative guard keeps (`evals/budget.toml`). In `latest.json`, `eval_spend_month_usd` counts every provider, and `eval_spend_month_claude_api_usd` counts only the Claude API spend, which is what the guard compares with that limit. Desk-side cost counts the conversation, reviewer, soft-promise, triage and translation calls; the simulated visitor's calls count in the pass's spend, not in cost per conversation.

**Latency.** p50 and p95 for each measure, in two parts:

- Local: the full turn as the client sees it, with cold first turns apart, and the reveal delay, reply check, decide, reviewer and proving times from the records.
- Hosted: the full turn and the reviewer, measured against the deployment.

**Limits.** What the numbers don't show:

- the Demo inbox assumption behind the attack scenarios;
- that the same team wrote the Desk and its evals;
- what the sample sizes can bound;
- that results files are self-attested;
- how many simulated-visitor turns a fallback model served;
- that a pass driving a deployment by URL can't see that deployment's API provider.

A number a report didn't measure says so, and in the evals guide it shows as a `[measured: …]` placeholder until a report fills it.
