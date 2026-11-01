# Claude Desk

Claude Desk is a concept prototype: a public, always-on Claude for a person or small business that strangers and other people's agents can talk to. It answers, books, quotes, releases documents to verified people and takes payments under the owner's rules.

The demo business is Turner Plumbing. You play Mike Turner, its owner, while Claude answers his customers and their agents.

## Try it

[owner: the hosted URL, after the first deploy]

The passcode comes with the link. Each visitor gets a fresh copy of the Turner Plumbing demo, tied to a browser cookie, with no account to create.

## Things to try

1. **Chat as a customer.** Turner's public page opens in a new tab. Ask for a quote or a booking. Each reply is checked before it appears, and a receipt under each message shows what the checks did.
2. **Try to break it.** Ask for a discount, someone else's invoice, or a promise Mike never made. The receipts show what was held or blocked, and Safety, in Mike's app, lists every attempt.
3. **Answer a held request.** One is waiting on Today: a customer asked for 15% off a drain clearing, which Mike's rules don't allow without asking him.
4. **Create your own Desk.** "+ New business", in the switcher at the top left, starts a short setup interview and ends with a live link someone else can use.

## What's real, mocked and unfinished

The kernel, API, web app, eval suites and AWS deployment are implemented on `main`. The hosted demo runs the prototype with the limits below.

| Part | Status | At this commit |
|---|---|---|
| Safety kernel | Real | On `main`: Rule cards compile to Cedar, proofs gate activation, every tool call gets a decision, approvals bind to one exact call, and the ledger is hash-chained and signed. See [`kernel/`](kernel/) and [`kernel_service/`](backend/desk/kernel_service/). Browser-signed owner approvals are still on the roadmap; see the security model below. |
| The reply check: everything a visitor sees is checked by the kernel first. Prices, dates, discounts and bookings come only from cards built from the business's facts: Claude's own words can't state a price, date or discount, can't make a promise the cards don't back, and can confirm a booking only next to a booking card. | Real | On `main`: The kernel checks replies before delivery. It builds price, date, discount and booking cards from facts and scans Claude's prose in English and Spanish. See [`reply_check.py`](backend/desk/kernel_service/reply_check.py) and [`deliver.py`](backend/desk/api/deliver.py). Promises the code scan doesn't recognize rely on a model check, which can miss. |
| Quotes and bookings | Real | On `main`: The server prices quotes from the Desk's price list, applies the owner's discount rules and books open slots on the built-in calendar. See the [adapters](backend/desk/kernel_service/adapters/). Fixed-menu prices and calendar slots; no staff scheduling, recurring bookings or external calendar connector. |
| Public chat and owner participation | Real | On `main`: Checked replies, receipts, owner take-over, messages, whispers and hand-back work in the [public chat](web/src/public/PublicChat.tsx) and [owner conversations](web/src/owner/conversations/). English and Spanish are supported; other languages open an owner handoff. |
| Spanish | Real: Spanish replies and owner translations; other languages open an owner handoff | On `main`: the kernel's [language handling](backend/desk/kernel_service/lang.py), [turn route](backend/desk/kernel_service/turn.py) and the API's [translation jobs](backend/desk/api/jobs.py). |
| Passcode and demo copies | Real | On `main`: The [passcode](backend/desk/api/passcode.py), [per-visitor copies](backend/desk/kernel_service/copies.py), [rate limits](backend/desk/api/ratelimit.py) and visitor cookies are implemented. A cookie resumes the conversation. Signing in with a Claude account is a static vision screen. |
| Returning visitors | Simple: the visitor cookie resumes a conversation; Claude account sign-in is a vision mock | On `main`: [visitor cookies](backend/desk/api/cookies.py) and the [Claude account vision page](web/src/vision/ClaudeAccountPage.tsx). |
| Verifying a customer and releasing private documents | Real rules. Verification codes are simulated in the Demo inbox | On `main`: [Verification](backend/desk/kernel_service/verification.py) enforces contact-on-record routing, expiry, attempts and limits; [document release](backend/desk/kernel_service/adapters/release_document.py) requires the verified record owner. Codes appear in the Demo inbox, with no email or text delivery and no proof of contact possession. Client document upload is not implemented. |
| Payments and MCP | Payments are mocked; MCP pinning and execution checks are real | On `main`: [Payment links](backend/desk/kernel_service/payments.py), refunds and agent charges use the mock payments server. Its two MCP tools are [pinned by hash](backend/desk/kernel_service/mcp_pins.py), listed again before execution and disabled on drift until review. No money moves and no payment provider is connected. Checkout says "Test payment, no money moves". |
| Visiting agents | Real signatures and spending checks; a demo agent and wallet | On `main`: The [Agent Card](backend/desk/api/routes/public.py) and [signed endpoint](backend/desk/api/routes/agents.py), [signature checks](backend/desk/kernel_service/agents.py), [spending limits](backend/desk/kernel_service/mandates.py) and built-in [send-an-agent panel](web/src/public/agents/) work. The built-in agent and demo wallet stand in for another person's agent and wallet; connecting your own Claude is instructions plus an endpoint. |
| Setup | Real interview; sample Claude memory | On `main`: The [setup interview](backend/desk/api/setup.py) drafts rule cards, runs safety probes and opens a preview before publishing a live link. Claude drafts sample memory from the owner's description and presents it as their Claude memory. Connected apps are simulated: only the mock payments server connects. Web search is real. |
| The owner app | Real screens; People and reporting are simple | On `main`: [Routes](web/src/app/routes.tsx) cover Today and its briefing, Conversations, Rules, Safety, People, Share and Settings, including knowledge and notifications. The switcher, Desk picker, new-business setup and deletion work. People and reporting are simple. Push, text and email alerts are simulated in the Demo inbox. |
| Desk management | Real: switch between Desks, create one through setup and delete one | On `main`: the [owner layout](web/src/owner/OwnerLayout.tsx), [Desk picker](web/src/ds/components/Sidebar/) and [kernel Desk routes](backend/desk/kernel_service/desks.py). |
| Suggested upgrades | Simple: suggestions from the owner's approvals | On `main`: [Suggestions](backend/desk/api/rules.py) use at least three approvals of the same tool in 30 days and require the owner's confirmation. Suggestions use the owner's approvals, not the attack record. |
| Share kit | Link and QR real; mocks for the Google profile, email signature and voicemail, with the embed coming later | On `main`: [Share](web/src/owner/share/) provides the public link, a QR code and copy for a Google profile, email signature and voicemail. Share copy connects to no service; the website embed is marked "Coming later". |
| Vision pages and connectors | Static vision screens; other integrations are unfinished | On `main`: [vision pages](web/src/vision/) show a Claude account, city office, team Desk and phone app. [Connector management screens](web/src/owner/connectors/pages.ts) and the [Channels settings page](web/src/owner/settings/SettingsLayout.tsx) are not built. Other connectors and channels are not live integrations. |
| Accessibility | Automated checks and implemented interaction paths | On `main`: The [design system](web/src/ds/) and screen tests cover contrast, keyboard paths, live announcements, reduced motion and automated axe checks. These checks are not an independent accessibility audit. |
| Evals | Real suites, calibration and latency tooling | On `main`: [Tier 1](evals/tier1/) exercises boundary cases without model calls; [tier 2](evals/tier2/) has hostile and legitimate conversations, separate calibration and held-out splits, and a results gate. [Calibration](evals/calibration/) and [latency tooling](evals/latency.py) are implemented. Hosted latency runs refuse to start without trusted usage metering; final measured results belong in Evidence below. |
| Hosting | Hosted prototype | On `main`: [AWS infrastructure](infra/) serves the web app and API through CloudFront, splits secrets by container and keeps the kernel reachable only inside its task. The [runbook](docs/deploy.md) covers deploys and smoke checks. One application task and one database; this is a concept prototype, not a production service. |

### Unfinished

Connector management screens and the Channels settings page are not built. The built-in tools do not provide client document upload, staff scheduling, recurring bookings or an external calendar connection. Real payment processing, verification by possession of a contact and delivery of email, text or push notifications remain outside this prototype.

## What we left out on purpose

Real payments and real delivery of verification codes, so the safety boundary could be shown end to end without a provider; phone and email channels; staff scheduling and external calendars; connector management. Each would widen the surface without changing the one idea: a public Claude that acts for its owner and can't act past the owner's rules.

## Security model

The [threat model's controls table](docs/threat-model.md#controls) names the implementation and tests for each control, with the prototype's limits.

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

The [evals guide](docs/evals.md) says what each suite tests, how a run is judged and gated, what it costs and how to reproduce one, and holds the latest results.

## Run it locally

You need Docker, uv, Rust 1.99.1 (rustup reads it from `kernel/rust-toolchain.toml`) and Node 24.

```sh
make setup   # dependencies, the kernel module and proof binary, cvc5, Postgres in Docker, migrations and roles
make dev     # the kernel on 127.0.0.1:8701, the API on 127.0.0.1:8700 and the web app; Ctrl-C stops all three
```

Then open the address Vite prints. Model features need an Anthropic API key: add `ANTHROPIC_API_KEY=<your key>` to `.env`, which `make setup` copies from `.env.example`. `make dev` starts all three services and stops them together; it refuses to start without the proof binary and cvc5 installed by `make setup`.

## How it was built

Claude Desk was built with Claude Code. Claude Opus 5.5 agents wrote the plans and the code, test first and one task at a time, and each task was reviewed before it was committed. Every plan and pull request went to a review panel of models at extra-high reasoning (Claude Opus 5.5 and GPT-6.1 Sol, with other seats on some rounds); each plan's Review Ledger names its seats and what they found, and [docs/reviews/](docs/reviews/) holds the reviews of the first master plan. [AGENTS.md](AGENTS.md) holds the rules every agent works under, including the safety invariants no change may weaken.

Three calls I made against what the agents or reviewers pushed for: a Desk resolves what it can and asks the visitor before involving the owner, instead of handing off by default; payments are fully mocked, with no provider keys, so the safety boundary shows without one; and every screen was designed and signed off before any interface code.

## Documents

- [Capability prediction](docs/capability-prediction.md)
- [Product proposal](docs/product-proposal.md)
- [Design spec](docs/specs/2026-10-28-claude-desk-design.md): the product, the locked decisions and why.
- [Threat model](docs/threat-model.md): what is claimed, what isn't, and where each control is enforced.
- [Architecture decisions](docs/architecture-decisions.md): the main choices, with the alternatives and their costs.
- [Deploying](docs/deploy.md): the AWS runbook and its monthly cost.
- [Continuous integration](docs/ci.md): what CI checks and what it can't.
- [Plans](docs/plans/): the master plan and one plan per part, each with its Review Ledger.
- [Reviews](docs/reviews/), [research](docs/research/) and the [kernel feasibility spike](docs/spikes/2026-10-28-kernel-feasibility.md).

---

Concept prototype by Giovanni Alcantara, not an Anthropic product
