# Claude Desk

Claude Desk is a concept prototype: a public, always-on Claude for a person or small business that strangers and other people's agents can talk to. It answers, books, quotes, releases documents to verified people and takes payments under the owner's rules, and it can't be talked around.

The demo business is Rivera Plumbing. You play Maria Rivera, its owner, while Claude answers her customers and their agents.

## Try it

[owner: the hosted URL, after the first deploy]

The passcode comes with the link. Each visitor gets a fresh copy of the Rivera Plumbing demo, tied to a browser cookie, with no account to create.

## Things to try

1. **Chat as a customer.** Rivera's public page opens in a new tab. Ask for a quote or a booking. Each reply is checked before it appears, and a receipt under each message shows what the checks did.
2. **Try to break it.** Ask for a discount, someone else's invoice, or a promise Maria never made. The receipts show what was held or blocked, and Safety, in Maria's app, lists every attempt.
3. **Answer a held request.** One is waiting on Today: a customer asked for 15% off a drain clearing, which Maria's rules don't allow without asking her.
4. **Create your own Desk.** "+ New business", in the switcher at the top left, starts a short setup interview and ends with a live link someone else can use.

## What's real, mocked and unfinished

| Part | Status | At this commit |
|---|---|---|
| The safety kernel: rule cards compiled to Cedar policies, a decision on every action, proofs before rules go live, owner approvals, a signed ledger | Real | The Rust core is on `main` ([`kernel/`](kernel/)): Cedar decisions, the proof binary, ledger hashing and signing. Rule cards, approvals and the kernel service land with [the kernel core (plan 01a)](docs/plans/2026-10-28-01a-safety-kernel-core.md) |
| The reply check: prices, dates, discounts and bookings only in cards rendered from the business's records, and Claude's prose checked in English and Spanish | Real | Lands with the kernel core (plan 01a) and [the API core (plan 02a)](docs/plans/2026-10-28-02a-api-core.md) |
| Public chat, and the owner taking over, speaking, whispering to Claude and handing back | Real | Lands with the API core (plan 02a), [the rest of the API (plan 02b)](docs/plans/2026-10-28-02b-api-owner-setup-agents.md) and [the web app (plan 04)](docs/plans/2026-10-28-04-web.md) |
| Returning visitors | Simple: the visitor cookie resumes the conversation. Signing in with a Claude account is a vision mock: a static screen | Lands with the API core (plan 02a) and the web app (plan 04) |
| Verifying a customer | Real rules: codes go only to the contact on record, with expiry, attempts and limits. Verification codes are simulated: they appear in a Demo inbox on screen instead of an email or a text | Lands with [kernel verification and owner data (plan 01b)](docs/plans/2026-10-28-01b-kernel-verification-owner-data.md), the rest of the API (plan 02b) and the web app (plan 04) |
| Payment links, refunds and a visiting agent's charges | Payments are mocked: links open a checkout page labelled "Test payment, no money moves", and a mock payments server in this repository stands in for the provider | Lands with [kernel payments, agents and setup (plan 01c)](docs/plans/2026-10-28-01c-kernel-payments-agents-setup.md), the rest of the API (plan 02b) and the web app (plan 04) |
| The mock payments server as a connected tool (MCP), pinned by hash and listed again before every call | Real MCP, mocked payments | Lands with kernel payments, agents and setup (plan 01c) |
| Visiting agents: an Agent Card, signed requests and signed spending limits | Real; a demo wallet and a built-in agent stand in for someone else's | Lands with kernel payments, agents and setup (plan 01c), the rest of the API (plan 02b) and the web app (plan 04) |
| The setup interview: rule cards, safety probes, a preview and a live link | Real; its reads of the owner's Claude memories are simulated | Lands with kernel payments, agents and setup (plan 01c), the rest of the API (plan 02b) and the web app (plan 04) |
| The owner app: Today, Conversations, Rules, Safety, People and knowledge | Real | The design system is on `main` ([`web/src/ds/`](web/src/ds/)). The screens land with the rest of the API (plan 02b) and the web app (plan 04) |
| Suggested upgrades: rules Claude offers from the owner's own approvals | Simple: three or more approvals of one kind in 30 days bring a suggested rule for the owner to confirm; the attack record isn't used | Lands with the rest of the API (plan 02b) and the web app (plan 04) |
| Share kit | Link and QR real; mocks for the rest: the Google profile, email signature and voicemail texts are copy to paste, connected to nothing, and the website embed is marked "Coming later" | Lands with the web app (plan 04) |
| Alerts to the owner (push, text, email) | Simulated in the Demo inbox | Lands with kernel verification and owner data (plan 01b), the rest of the API (plan 02b) and the web app (plan 04) |
| Connectors, channels, a city office, a team Desk and phone screens | Vision mocks: static screens | Lands with the web app (plan 04) |
| Evals: an attack suite, a legitimate-task suite, calibration and latency | Real | Lands with [tier 1 evals (plan 05a)](docs/plans/2026-10-28-05a-evals-tier1.md) and [tier 2 evals and the report (plan 05b)](docs/plans/2026-10-28-05b-evals-tier2-and-report.md) |
| Hosting: one CloudFront address, secrets split by container, a kernel reachable only inside its task | Real | The deploy code is on `main` ([`infra/`](infra/)). The hosted demo goes up with the first deploy |

### Unfinished

This README was written during the build. The status column describes each part as designed, and the last column says what is on `main` at this commit. Besides the parts it names, `main` has the shared contracts, the database roles with per-copy isolation and CI. The other parts are being built and reviewed on their own branches, and this table is updated as each one lands; the hosted demo goes up after that. The security model below is the design too: the threat model's controls table says which controls are on `main`. Anything cut before the deadline will be listed here.

## Security model

Claude proposes every action and every reply; a separate kernel process decides whether each action runs and whether each reply can be shown, under rules compiled by code from the owner's rule cards and proved before they go live.

A bug in the chat layer's visitor and agent paths can't move money outside the owner's rules, change rules, approve anything, verify anyone or forge the ledger: those paths never hold the owner's token, and each of these needs it or a check that only the kernel holds. On the owner's own requests the chat layer carries the owner's token, so a bug there could misdirect an approval or a rule confirmation to another held request or proved draft of the same Desk; browser-signed approvals, on the roadmap, close that. This covers a buggy chat layer, not a compromised one.

Talking Claude around can't make it act past the owner's rules. Within them, it can still be talked into actions the rules allow, and into text that is wrong or unflattering but carries no price, date or promise.

**Demo limits.** Verification codes are simulated: the Demo inbox shows codes to whoever entered the contact, so demo verification shows that codes go only to the contact on record, but it does not establish possession of the contact. The inbox also reveals whether a contact is on record, and because limits count per contact, a stranger can cancel a contact's live challenge and use up its hourly limit; each lockout is logged and shown to the owner. Payments are mocked, and no payment provider is involved.

The [threat model](docs/threat-model.md) lists what is claimed and what isn't, and where each control is enforced and tested.

## Evidence

Two eval suites run against the real kernel and Claude: an attack suite of hostile visitors and agents, and a legitimate-task suite of ordinary customer requests. The thresholds are tuned on one split of the scenarios and reported on another, held out.

| Measure | Result |
|---|---|
| Baseline violations in the attack suite | [measured: held-out attack suite] |
| Legitimate tasks completed | [measured: held-out legitimate-task suite] |
| Legitimate requests held for the owner | [measured: held-out legitimate-task suite] |
| From Claude's finished reply to the visitor seeing it, p50 and p95 | [measured: check-then-reveal latency] |
| Model cost per conversation | [measured: cost per conversation] |

The attack suite tests the attacks we thought of: a clean run means none of those got through, not that no attack can.

[measured: link the evals guide, docs/evals.md (what each suite tests, the gate and how to reproduce a run), once it lands with the evals report]

## Run it locally

You need Docker, uv, Rust 1.99.1 (rustup reads it from `kernel/rust-toolchain.toml`) and Node 24.

```sh
make setup   # dependencies, the kernel module and proof binary, cvc5, Postgres in Docker, migrations and roles
make dev     # the kernel on 127.0.0.1:8701, the API on 127.0.0.1:8700 and the web app; Ctrl-C stops all three
```

Then open the address Vite prints. Model features need an Anthropic API key: add `ANTHROPIC_API_KEY=<your key>` to `.env`, which `make setup` copies from `.env.example`. Until the kernel service, the API and the web app have landed (see "Unfinished"), `make dev` names the part that is missing and stops.

## How it was built

Claude Desk was built with Claude Code. Claude Opus 5.5 agents wrote the plans and the code, test first and one task at a time, and each task was reviewed before it was committed. Every plan and pull request went to a review panel of models at extra-high reasoning (Claude Opus 5.5 and GPT-6.1 Sol, with other seats on some rounds); each plan's Review Ledger names its seats and what they found, and [docs/reviews/](docs/reviews/) holds the reviews of the first master plan. [AGENTS.md](AGENTS.md) holds the rules every agent works under, including the safety invariants no change may weaken.

## Documents

- Capability prediction: [owner: link]
- Product proposal: [owner: link]
- [Design spec](docs/specs/2026-10-28-claude-desk-design.md): the product, the locked decisions and why.
- [Threat model](docs/threat-model.md): what is claimed, what isn't, and where each control is enforced.
- [Architecture decisions](docs/architecture-decisions.md): the main choices, with the alternatives and their costs.
- [Deploying](docs/deploy.md): the AWS runbook and its monthly cost.
- [Continuous integration](docs/ci.md): what CI checks and what it can't.
- [Plans](docs/plans/): the master plan and one plan per part, each with its Review Ledger.
- [Reviews](docs/reviews/), [research](docs/research/) and the [kernel feasibility spike](docs/spikes/2026-10-28-kernel-feasibility.md).

---

Concept prototype by Giovanni Alcantara, not an Anthropic product
