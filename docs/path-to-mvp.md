# Path to MVP

What the prototype needs to become a minimum viable product (MVP) for real businesses: real identity, real payment and message providers, and recovery when a model or a provider fails. The product proposal describes [the first release](product-proposal.md#the-first-release). The [architecture decisions](architecture-decisions.md) explain today's choices, and the [threat model](threat-model.md) says what they claim and what they don't.

## Architecture

Today the API runs conversations; the kernel holds business credentials, compiles and proves rules, and checks actions and replies. Postgres roles prevent API writes to kernel records. Both processes trust their shared host. Keep that authority boundary for an MVP, add browser-signed approvals and rule confirmations, and verify signed replies in the browser. Separating the kernel onto another host would require authenticated calls and credential isolation.

The API supports server-sent events (SSE), an HTTP connection that carries updates as they happen. Visitor replies still pass the kernel's checks before delivery. Setup and Ask Claude, the owner's chat about their rules, have separate [owner-only streams](../backend/desk/api/owner_streaming.py) for text as it is written, and their screens show that text as it arrives. These display streams are process-local and carry no authority to change rules: cards, choices and drafts come from the validated final response. Saved visitor events use [Postgres replay and notifications](../backend/desk/api/sse.py), while the owner's in-progress display text stays in memory.

Read the safety and usefulness numbers together: a Desk that refused everything would have no violations and complete nothing. Here, held-out means scenarios not used to tune the reviewer. The results cover only the attacks and assumptions the [evals guide](evals.md) lists.

| Metric | Value | Source |
|---|---|---|
| Baseline violations across all judged runs (both suites and splits), unwaived | [measured: unwaived violations, final held-out pass] | [measured: source, final held-out pass] |
| Baseline violations across all judged runs, waived, with who signed | [measured: waived violations, final held-out pass] | [measured: source, final held-out pass] |
| Held-out legitimate completion, completed / trials and Wilson 95% interval | [measured: held-out legitimate completion and interval, final held-out pass] | [measured: source, final held-out pass] |
| False holds on tools legitimate tasks expect allowed, count / eligible decisions and rate | [measured: held-out false holds, final held-out pass] | [measured: source, final held-out pass] |

Only the AI-denial check can be waived: the owner signs, one message at a time, for a correct refusal that quotes the line it won't say. A waived violation stays in the report, counted apart with who signed it.

## Infrastructure

The [service configuration](../infra/stacks/compute_express.py) runs exactly one task, a single copy of the API and kernel containers, each with [its own secrets](../infra/stacks/task.py). [RDS](../infra/stacks/data_stack.py) is private, encrypted and single-AZ, with backups and a final snapshot. [CloudFront](../infra/stacks/edge.py) serves S3 assets and uncached API traffic on one domain; the fallback compute mode uses an internal load balancer. This describes the configuration in the repository, not an audit of the live deployment.

For an MVP, run the database across availability zones, rehearse restores and failover, and move rate limits into shared storage before adding tasks, since today each task keeps its own. Add a web application firewall, and alerts for spend, waits for database connections and the ledger, holds, payment reconciliation and failed replies. Set an availability target and name who is on call. The [deploy guide](deploy.md) covers releases and infrastructure costs.

## Model integration

Opus handles conversation, and [Haiku](../backend/desk/api/triage.py) writes the owner's triage notes on stopped attempts and English translations of messages in other languages. [Sonnet reviews actions and checks possible promises and denials of being an AI](../backend/desk/kernel_service/decisions.py) inside the kernel. When it's configured, [Jev](../backend/desk/kernel_service/jev.py), an optional second reply checker, can only add blocks: it can't skip Sonnet or authorize an action. Jev runs at TypeSafe, an outside service that then receives each reply's text and cards ([data flow](threat-model.md#external-reply-evaluation)). The [evals guide](evals.md#soft-check-calibration-2026-10-31) records the calibration and its remaining misses. For the conversation model, [prompt caching](../backend/desk/api/model.py) covers the unchanging start of its prompt and the conversation so far. Keep each route's model explicit, with no silent fallback to another: if the action reviewer fails, the action is held for the owner. Compare completion, violations, holds, cost and latency before changing models.

During setup, Claude acts as a [setup consultant](../backend/desk/api/setup.py). It asks whether it may look at the owner's Claude memory and website; the question names only those two. With a yes, it reads the sample Claude memory and the website, and runs up to three web searches, a cap the [kernel enforces](../backend/desk/kernel_service/adapters/web_search.py). Its [prompt](../backend/desk/api/prompts.py) tells it to search for the kind of business, not this business by name or its prices; that is an instruction to Claude, not a check. The owner sees each completed search as a label with its query. The reads run together after their kernel decisions. The [search measurement reported in PR #625](https://github.com/gvsi/claude-desk/pull/625) took about 15 s typically and 18 s at the slowest across 12 calls, before the hosted kernel's additional network hop. Each [kernel search](../backend/desk/kernel_service/decisions.py) has a 30 s deadline, raised from 20 s in that pull request, so a slow search fails less often. Failed searches leave setup to continue with the information it has. Research can inform proposed facts and jobs, but cannot set the owner's money limits.

| Metric | Value | Source |
|---|---|---|
| Reviewer skipped, share of tool decisions in held-out legitimate-task conversations | [measured: share of tool decisions skipping the reviewer, final held-out pass] | [measured: source, final held-out pass] |
| Reviewer reached, share of tool decisions in held-out legitimate-task conversations | [measured: share of tool decisions reaching the reviewer, final held-out pass] | [measured: source, final held-out pass] |

The two shares add up to the whole. Today's daily model budget counts the API's model calls but not the kernel's. An MVP needs each Desk's model spend reserved before every call on every route, settled correctly when calls run at once, and limits the owner can see.

## Scaling and what breaks first

Model cost and latency may limit useful traffic before the infrastructure does; only measurement can say. Proofs run when an owner changes rules, not during conversations. The demo rules' proof time below comes from the final pass's latency run; the 30-card time is the kernel core's, measured locally while other test suites ran on the same machine.

| Constraint | Value | Source |
|---|---|---|
| Opus cost per Desk reply (one reply the visitor waits for) in held-out legitimate-task conversations, mean / p50 / p95, including calls after tools | [measured: Opus cost per reply, final held-out pass] | [measured: source, final held-out pass] |
| Opus model time per Desk reply (one reply the visitor waits for) in held-out legitimate-task conversations, p50 / p95, including calls after tools | [measured: Opus model time per reply, final held-out pass] | [measured: source, final held-out pass] |
| Proof, Turner Plumbing's demo rules, local p50 / p95 | [measured: proving latency, final held-out pass] | [measured: source, final held-out pass] |
| Proof, 30 rule cards, local p50 / p95 | 1,172 / 2,390 ms | [Kernel core PR #33, proving latency](https://github.com/gvsi/claude-desk/pull/33) |
| SSE streams per task, steady state | estimate: at most min(3S, 30I) for S visitor sessions across I internet addresses subject to the per-address limit; no total task cap | estimate: min(3 × S, 30 × I) = stream ceiling; [stream slots](../backend/desk/api/ratelimit.py). Excludes streams with no per-address limit and brief overlap while an older stream closes after a new one replaces it. |
| API Postgres connection budget per task | estimate: up to 47 | estimate: (20 pool + 10 overflow) + 10 turn locks + 5 job connections + 1 event listener + 1 job listener = 47; [API pools](../backend/desk/api/main.py), [job pool](../backend/desk/db/session.py), [event listener](../backend/desk/api/sse.py), [job listener](../backend/desk/api/jobs.py). |
| Postgres demand with T app tasks | estimate: up to 77T, plus admin and operational connections | estimate: T × (47 + 2 × (5 pool + 10 overflow)) = 77T; SQLAlchemy defaults left implicit by the [kernel](../backend/desk/kernel_service/app.py) and [mock provider](../backend/desk/mockpay/store.py). Database connection capacity is not pinned. |
| Ledger writes to one busy Desk | estimate: at most 1,000 / L entries/s, L = amortized locked time per entry in ms through commit | estimate: 1 exclusive ledger-head lock / (L / 1,000) = 1,000 / L; [ledger append](../backend/desk/kernel_service/ledger.py), [lock order](../backend/desk/kernel_service/repo.py). L is not measured. |

Before scaling, load-test three things: slow and reconnecting readers of the live-update stream (server-sent events), for memory and lag; waits for a database connection as tasks are added; and how long a Desk's ledger lock is waited for and held until each write commits. The deployment runs one API process. Setup's running turns and Ask Claude's [drafting registry](../backend/desk/api/proving.py) keep their display streams in that process, so a reconnect to another process cannot resume the growing text. Before adding processes or tasks, use shared run ownership and display delivery, or keep each run's requests on its owning process with recovery after it stops. More tasks multiply database connections without easing one Desk's ledger, which takes one write at a time. Set the pool sizes left at library defaults, and keep connections in reserve for operators, first.

## Latency and cost per conversation

Each source names its report, pass, date and latency run. Cost per legitimate-task conversation includes the Desk's own checks, triage and translation; the simulated visitor and setup are counted separately. [How to read a report](../evals/reports/README.md) defines each sample. The last column shows an estimate where the [master plan](plans/2026-10-28-00-master-plan.md#model-cost-and-latency-budget) gives one, beside local measurements, with the conversation size it assumed.

| Metric | Environment | Value | Source | Planned estimate |
|---|---|---|---|---|
| Cost per legitimate-task conversation, mean / p50 / p95 | Local evals | [measured: cost per conversation, final held-out pass] | [measured: source, final held-out pass] | $0.20 for 10 turns, 4 tool calls and 10 checked replies, warm cache |
| Full turn, warm and cold first turns apart, p50 / p95 | Local | [measured: local full-turn latency, final held-out pass] | [measured: source, final held-out pass] | — |
| Finished model reply to reveal, p50 / p95 | Local | [measured: local reveal latency p50 and p95, final held-out pass] | [measured: source, final held-out pass] | p50 1.1 s, p95 2.8 s, capped at 8 s |
| Reply check, p50 / p95 | Local, server-side | [measured: local reply-check latency, final held-out pass] | [measured: source, final held-out pass] | — |
| Decide, p50 / p95 | Local, server-side | [measured: local decide latency, final held-out pass] | [measured: source, final held-out pass] | — |
| Reviewer when called, p50 / p95 | Local, server-side | [measured: local reviewer latency, final held-out pass] | [measured: source, final held-out pass] | 0.8–1.5 s, 4 s timeout |
| Full turn, warm and cold first turns apart, p50 / p95 | Hosted | Not measured | [Why hosted wasn't measured](../evals/latency.py) | — |
| Reviewer when called, p50 / p95 | Hosted | Not measured | [Why hosted wasn't measured](../evals/latency.py) | — |

All latency here is local: `make evals-latency PASS=<id>` measures it. Hosted latency wasn't measured. The harness refuses a run against the deployment until the deployment reports what its model calls cost, so that a run can stop at its spending limit.

## What changes for real users

Replace the Demo inbox with real codes by email or text that prove a visitor holds the contact, without revealing which contacts are on record. Connect a real payment provider through a reviewed MCP server, keeping approvals, protection against charging twice, spending reservations and reconciliation. Bind approvals and rule confirmations to the owner's browser key before real money moves.

Replace per-visitor demo copies with real accounts: sign-in, team membership and account recovery, tested isolation of each business's data and credentials, and rules for how long data is kept. Add shared abuse and spend limits, real notifications and on-call recovery. Ask visitors before involving the owner; keep chat useful after holds and handoffs. Measure self-service and false holds alongside safety before expanding coverage.

Setup now proposes jobs one at a time. With [business tools enabled](../backend/desk/api/settings.py), accepted jobs can become reviewed tools built from fixed blocks: intake, typed appointments, fixed-purpose payments and urgent callbacks. The [hosted deployment](../infra/stacks/task.py) turns setup's configurations on; they are off by default elsewhere. For real owners, replace the memory drafted from their description and simulated connected apps with consented account connections. Website reads and web search already run for real. Keep the owner's confirmation of [what customers will read](../backend/desk/api/setup.py) and the separate review before a business tool is enabled. The optional test-client offer writes only the owner's own contact, with their yes; it supplies no client document.

## Trade-offs made and deferred

| Decision | Why now | Cost | Revisit when |
|---|---|---|---|
| Kernel beside the API rather than on another host | A small deployment with an explicit authority boundary | Shared host remains trusted | Host isolation is required for real tenant credentials |
| Compiled cards and proofs rather than freehand policy | Owner confirmation has a precise meaning | Less expressive rules; proof wait on edits | Measured customer needs exceed card shapes |
| Check visitor replies before reveal; stream owner-only display text separately | A visitor never sees a draft that failed its check; the API can show the owner progress without acting on it | Visitor reveal delay and rewrites; owner streams need process-local run ownership | Faster checks preserve the boundary, or owner traffic needs multiple processes |
| Mock payments and delivery rather than live providers | Exercise the controls without moving money | No evidence of real contact possession or provider reliability | A real pilot has provider operations and recovery ready |
| Fixed task count rather than automatic scaling | Keep process-local limits and owner display streams predictable | No measured high-load capacity or failover claim | Shared limits, recoverable run ownership, connection budgets and load tests are in place |
