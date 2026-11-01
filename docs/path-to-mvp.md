# Path to MVP

An MVP needs real identity, real providers and recovery from model and provider failures. The [architecture decisions](architecture-decisions.md) explain the choices; the [threat model](threat-model.md) sets their limits.

## Architecture

Today the API runs conversations; the kernel holds business credentials, compiles and proves rules, and checks actions and replies. Postgres roles prevent API writes to kernel records. Both processes trust their shared host. Keep that authority boundary for an MVP, add browser-signed approvals and rule confirmations, and verify signed replies in the browser. Separating the kernel onto another host would require authenticated calls and credential isolation.

Read safety and usefulness together. Pending results cover only the attacks and assumptions in the [evals guide](evals.md).

| Metric | Value | Source |
|---|---|---|
| Held-out attack violations, unwaived | [measured: held-out attack violations unwaived, final held-out pass] | [measured: source, final held-out pass] |
| Held-out attack violations, waived, with reasons kept separate | [measured: held-out attack violations waived, final held-out pass] | [measured: source, final held-out pass] |
| Held-out legitimate completion, completed / trials and Wilson 95% interval | [measured: held-out legitimate completion and interval, final held-out pass] | [measured: source, final held-out pass] |
| False holds on tools legitimate tasks expect allowed, count / eligible decisions and rate | [measured: held-out false holds, final held-out pass] | [measured: source, final held-out pass] |

A waiver stays visible and does not silently change the gate.

## Infrastructure

The [service configuration](../infra/stacks/compute_express.py) fixes capacity at one task, with [separate container secrets](../infra/stacks/task.py). [RDS](../infra/stacks/data_stack.py) is private, encrypted and single-AZ, with backups and a final snapshot. [CloudFront](../infra/stacks/edge.py) serves S3 assets and uncached API traffic at the same origin; the fallback uses an internal load balancer. These describe configuration, not a live audit.

For an MVP, use multi-AZ RDS, rehearse restores and failover, and share rate and spend coordination before adding tasks. Add WAF controls and alerts for spend, pool and ledger waits, holds, reconciliation and reply failures. Assign an availability target and on-call ownership. The [deploy guide](deploy.md) covers releases and infrastructure costs.

## Model integration

Opus handles conversation, Sonnet reviews actions and Haiku checks replies. [Caching](../backend/desk/api/model.py) covers the static prefix and history. Keep routing explicit, with no silent fallback: reviewer failures hold. Compare completion, violations, holds, cost and latency before changing models.

| Metric | Value | Source |
|---|---|---|
| Reviewer skipped, share of tool decisions | [measured: reviewer skip rate, final held-out pass] | [measured: source, final held-out pass] |
| Reviewer reached, share of tool decisions | [measured: share of tool decisions reaching the reviewer, final held-out pass] | [measured: source, final held-out pass] |

The shares are complements. Today's API budget excludes kernel model calls. An MVP needs per-Desk reservations across all routes, concurrency-safe settlement and owner-visible spend limits.

## Scaling and what breaks first

Model cost and latency may constrain useful traffic first; measurement must decide. Proofs run on rule changes. The PR's local proving measurements include contention from other suites.

| Constraint | Value | Source |
|---|---|---|
| Mean Opus cost per visitor turn, including calls after tools | [measured: Opus cost per turn, final held-out pass] | [measured: source, final held-out pass] |
| Mean Opus model time per visitor turn, including calls after tools | [measured: Opus latency per turn, final held-out pass] | [measured: source, final held-out pass] |
| Proof, Rivera seed, local p50 / p95 | 381 / 702 ms | [Kernel core PR #33, proving latency](https://github.com/gvsi/claude-desk/pull/33) |
| Proof, 30 cards, local p50 / p95 | 1,172 / 2,390 ms | [Kernel core PR #33, proving latency](https://github.com/gvsi/claude-desk/pull/33) |
| SSE streams per task, steady state | estimate: at most min(3S, 30I) for S visitor sessions across I counted client addresses; no total task cap | estimate: min(3 × S, 30 × I) = stream ceiling; [stream slots](../backend/desk/api/ratelimit.py). Excludes address-exempt streams and brief overlap while an evicted stream closes. |
| API Postgres connection budget per task | estimate: up to 46 | estimate: (20 pool + 10 overflow) + 10 turn locks + 5 job connections + 1 listener = 46; [API pools](../backend/desk/api/main.py), [job pool](../backend/desk/db/session.py), [listener](../backend/desk/api/sse.py). |
| Postgres demand with T app tasks | estimate: up to 76T, plus admin and operational connections | estimate: T × (46 + 2 × (5 pool + 10 overflow)) = 76T; SQLAlchemy defaults left implicit by the [kernel](../backend/desk/kernel_service/app.py) and [mock provider](../backend/desk/mockpay/store.py). Database connection capacity is not pinned. |
| Ledger writes to one busy Desk | estimate: at most 1,000 / L entries/s, L = amortized locked time per entry in ms through commit | estimate: 1 exclusive ledger-head lock / (L / 1,000) = 1,000 / L; [ledger append](../backend/desk/kernel_service/ledger.py), [lock order](../backend/desk/kernel_service/repo.py). L is not measured. |

Load-test slow SSE readers and reconnects for memory and lag, pool checkout waits as tasks increase, and ledger lock wait and hold time through commit. More tasks multiply connections without removing a Desk's ledger bottleneck. Pin implicit pool sizes and reserve operational connections first.

## Latency and cost per conversation

Fill sources with report link, pass ID, date and latency-run ID. Conversation cost includes Desk-side checks, triage and translation; simulator and setup costs are separate. The [report reader](../evals/reports/README.md) defines samples. Add [master budget](plans/2026-10-28-00-master-plan.md#model-cost-and-latency-budget) estimates only beside filled measurements, naming their assumed conversation size.

| Metric | Environment | Value | Source | Master estimate beside measurement |
|---|---|---|---|---|
| Cost per conversation, mean / p50 / p95 | Local evals | [measured: cost per conversation, final held-out pass] | [measured: source, final held-out pass] | — |
| Full turn, warm and cold first turns apart, p50 / p95 | Local | [measured: local full-turn latency, final held-out pass] | [measured: source, final held-out pass] | No full-turn estimate specified |
| Finished model reply to reveal, p50 / p95 | Local | [measured: local reveal latency p50 and p95, final held-out pass] | [measured: source, final held-out pass] | — |
| Reply check, p50 / p95 | Local, server-side | [measured: local reply-check latency, final held-out pass] | [measured: source, final held-out pass] | — |
| Decide, p50 / p95 | Local, server-side | [measured: local decide latency, final held-out pass] | [measured: source, final held-out pass] | No separate estimate specified |
| Reviewer when called, p50 / p95 | Local, server-side | [measured: local reviewer latency, final held-out pass] | [measured: source, final held-out pass] | — |
| Full turn, warm and cold first turns apart, p50 / p95 | Hosted | Not measured; Monday follow-up | [Hosted metering restriction](../evals/latency.py) | No full-turn estimate specified |
| Reviewer when called, p50 / p95 | Hosted | Not measured; Monday follow-up | [Hosted metering restriction](../evals/latency.py) | Await hosted measurement |

Run `make evals-latency PASS=<id>` for local intervals. Hosted measurement is Monday's follow-up, requiring spend metering first; today's harness refuses an unmetered hosted run.

## What changes for real users

Replace the Demo inbox with contact possession checks that resist customer enumeration. Add a real payment provider and reviewed MCP server, retaining approvals, idempotency, reservations and reconciliation. Bind approvals and rule confirmations to the owner's browser key before real money moves.

Replace demo copies with authenticated tenants, membership and recovery, tested row and credential isolation, and retention rules. Add shared abuse and spend limits, real notifications and on-call recovery. Ask visitors before involving the owner; keep chat useful after holds and handoffs. Measure self-service and false holds alongside safety before expanding coverage.

## Trade-offs made and deferred

| Decision | Why now | Cost | Revisit when |
|---|---|---|---|
| Kernel beside the API rather than on another host | A small deployment with an explicit authority boundary | Shared host remains trusted | Host isolation is required for real tenant credentials |
| Compiled cards and proofs rather than freehand policy | Owner confirmation has a precise meaning | Less expressive rules; proof wait on edits | Measured customer needs exceed card shapes |
| Check before reveal rather than stream unchecked prose | A visitor never sees a draft that failed its check | Reveal delay and rewrites | Faster checks preserve the same boundary in evals |
| Mock payments and delivery rather than live providers | Exercise the controls without moving money | No evidence of real contact possession or provider reliability | A real pilot has provider operations and recovery ready |
| Fixed task count rather than automatic scaling | Keep process-local limits predictable | No measured high-load capacity or failover claim | Shared limits, connection budgets and load tests are in place |
