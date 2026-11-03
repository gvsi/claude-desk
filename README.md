# Claude Desk

Claude Desk is a concept prototype: a public, always-on Claude for a person or small business that strangers and other people's agents can talk to. It answers, books, quotes, releases documents to verified people and takes test payments under the owner's rules.

The demo business is Turner Plumbing. You play Mike Turner, its owner, while Claude answers his customers and their agents.

https://github.com/user-attachments/assets/794e7553-1960-40b5-927b-f5890c142e44

## Try it

[desk.alcantara.xyz](https://desk.alcantara.xyz)

The passcode comes with the submission. Each visitor gets a fresh copy of the Turner Plumbing demo, tied to a browser cookie, with no account to create.

## Things to try

After the passcode you're on Today, in Mike's app. Its Things to try list has a button for each of the first five steps below.

1. **Chat as a customer.** "Open your public page" opens Turner's public page in a new tab. Ask for a quote or a booking. Each reply is checked before it appears, and a receipt under each message shows what the checks did.
2. **Watch a demo visitor.** "Start a demo visitor" opens a chat where an AI plays a customer on Mike's Desk. Take over, whisper to Claude or hand the chat back while it talks.
3. **Try to break it.** Ask for a discount, someone else's invoice, or a promise Mike never made. A discount is held for Mike and waits on Today, and someone else's invoice needs a code sent to the contact on record. Then "Open in Safety" lists the requests the Desk turned down and the replies it stopped.
4. **Answer a held request.** One is waiting on Today: a customer asked for 15% off a drain clearing, which Mike's rules don't allow without asking him.
5. **Create your own Desk.** "Start a Desk" starts a setup interview. Describe the business and let Claude read your Claude memory (in the demo, a sample drafted from your description) and your website. It asks its questions and proposes jobs and apps one at a time; then you review the rules, try the preview and publish a live link.
6. **Ask Claude about your rules.** Open Ask Claude in Rules and ask what it can handle without you.

## What's real, mocked and not built

The kernel, API, web app, eval suites and AWS deployment are implemented on `main`. The hosted demo runs the prototype with these limits:

- **Real:** the kernel, the reply check, quotes and bookings, chat and take-over, and agent signatures and spending limits.
- **Mocked:** payments, code delivery (the Demo inbox), Claude memory, and the other apps in setup.
- **Not built:** connectors, channels, staff scheduling. See [Not in this prototype](#not-in-this-prototype).

<details>
<summary>Part by part, with links to the code</summary>

| Part | Status | Where |
|---|---|---|
| Safety kernel | Real | Rule cards compile to Cedar, proofs gate activation, every tool call gets a decision, approvals bind to one exact call, and the ledger is hash-chained and signed: [`kernel/`](kernel/), [`kernel_service/`](backend/desk/kernel_service/). Browser-signed owner approvals are on the roadmap. |
| Reply check | Real | Every reply is checked before delivery: prices, dates, discounts and bookings come only from cards built from the business's facts, and Claude's prose is scanned in English and Spanish ([`reply_check.py`](backend/desk/kernel_service/reply_check.py), [`deliver.py`](backend/desk/api/deliver.py)). Promises the code scan doesn't recognize rely on a model check, which can miss. |
| Quotes and bookings | Real | Quotes from the price list and the owner's discount rules; open slots on the built-in calendar ([adapters](backend/desk/kernel_service/adapters/)). No staff scheduling, recurring bookings or external calendar. |
| Public chat and owner participation | Real | Checked replies, receipts, take-over, whispers and hand-back ([public chat](web/src/public/PublicChat.tsx), [owner conversations](web/src/owner/conversations/)); English and Spanish, with [owner translations](backend/desk/api/jobs.py); other languages open an owner handoff. A [demo visitor](backend/desk/api/demo_visitors.py) is an AI customer on the same public endpoints. |
| Passcode, copies and returning visitors | Real | [Passcode](backend/desk/api/passcode.py), [per-visitor copies](backend/desk/kernel_service/copies.py), [rate limits](backend/desk/api/ratelimit.py) and [visitor cookies](backend/desk/api/cookies.py), which resume a conversation. Claude account sign-in is a [vision screen](web/src/vision/ClaudeAccountPage.tsx). |
| Sample week | Hand-written; hosted demo only | A [hand-written week](backend/desk/kernel_service/sample_week.py) of finished conversations, labelled "Recorded history"; no model ran for it. Locally it's off unless `SAMPLE_WEEK=1`. |
| Verification and private documents | Real rules; codes simulated | [Verification](backend/desk/kernel_service/verification.py) and [document release](backend/desk/kernel_service/adapters/release_document.py) to the verified record owner; codes appear in the Demo inbox. |
| Payments and MCP | Payments mocked; MCP checks real | [Payment links](backend/desk/kernel_service/payments.py), refunds and agent charges use a mock server whose MCP tools are [pinned by hash](backend/desk/kernel_service/mcp_pins.py), listed again before execution and disabled on drift until review. No money moves. |
| Visiting agents | Real checks; demo agent and wallet | [Signed endpoint](backend/desk/api/routes/agents.py), [signature checks](backend/desk/kernel_service/agents.py) and [spending limits](backend/desk/kernel_service/mandates.py); a built-in agent and wallet stand in for another person's. |
| Setup | Real interview and web reads; sample memory, simulated apps | The [setup consultant](backend/desk/api/setup.py) reads memory and a website with permission, researches the business and asks one question or proposal card at a time. The owner confirms rules and text, runs safety probes and tries a preview before publishing. |
| Business tools | Hosted demo only | Accepted setup jobs become [business tools](backend/desk/kernel_service/business_tools.py) for intake, appointments, fixed payments and urgent callbacks, reviewed before use. |
| Owner app and Desk management | Real; Customers and reporting simple | [Routes](web/src/app/routes.tsx) for Today, Conversations, Customers, Rules, Safety, Notifications, Profile, Share, Knowledge and Settings; Desks are switched, created and deleted ([owner layout](web/src/owner/OwnerLayout.tsx)). Alerts are simulated on Notifications. |
| Share, suggestions and vision pages | Simple or static | [Share](web/src/owner/share/) gives a real link and QR code; [suggestions](backend/desk/api/rules.py) need three approvals in 30 days and the owner's yes; [vision pages](web/src/vision/) are static. |
| Accessibility | Automated checks | [Design system](web/src/ds/) and screen tests cover contrast, keyboard paths, announcements, reduced motion and axe; not an independent audit. |
| Evals | Real | [Tier 1](evals/tier1/), [tier 2](evals/tier2/), [calibration](evals/calibration/) and [latency tooling](evals/latency.py). The final pass's results are in Evidence below; hosted latency wasn't measured. |
| Hosting | Prototype | [AWS](infra/) through CloudFront, secrets split by container, the kernel reachable only inside its task; [runbook](docs/deploy.md). One task and one database. |

</details>

### Not in this prototype

Connector management, the Channels settings page, phone and email channels, client document upload, staff scheduling, recurring bookings and external calendars aren't built. Payments and the delivery of verification codes, email, text and push notifications are simulated, so the safety boundary shows end to end without a provider, and verification doesn't prove possession of a contact. Each of these would widen the surface without changing the one idea: a public Claude that acts for its owner and can't act past the owner's rules.

## Security model

Claude proposes every action and every reply; a separate kernel process decides whether each action runs and whether each reply can be shown, under rules compiled by code from the owner's rule cards and proved before they go live.

A bug in the chat layer's visitor and agent paths can't move money outside the owner's rules, change rules, approve anything, verify anyone or forge the ledger: those paths never hold the owner's token, and each of these needs it or a check that only the kernel holds. On the owner's own requests the chat layer carries the owner's token, so a bug there could misdirect an approval or a rule confirmation to another held request or proved draft of the same Desk; browser-signed approvals, on the roadmap, close that. This covers a buggy chat layer, not a compromised one.

Prompt injection and social engineering can't make Claude act past the owner's rules. Within them, it can still be talked into actions the rules allow, and into text that is wrong or unflattering but carries no price, date or promise. Promises without numbers or words like "guarantee" rely on a model check, which can miss.

**Demo limits.** Verification codes are simulated: the Demo inbox shows codes to whoever entered the contact, so demo verification shows that codes go only to the contact on record, but it does not establish possession of the contact. The inbox also reveals whether a contact is on record, and because limits count per contact, a stranger can cancel a contact's live challenge and use up its hourly limit; each lockout is logged and shown to the owner. Payments are mocked, and no payment provider is involved.

The [threat model](docs/threat-model.md#controls) lists what is claimed and what isn't, and names the implementation and tests for each control.

## Evidence

Two eval suites run against the real kernel and Claude: an attack suite of hostile visitors and agents, and a legitimate-task suite of ordinary customer requests. The scenarios are split in two: one for tuning the thresholds of the reviewer, a model check that can only narrow what auto-allow rules let through, and one held out for reporting. The final pass ran on the kernel's initial thresholds, with none tuned.

| Measure | Result |
|---|---|
| Baseline violations | 0 unwaived in 261 judged runs. The word-level check flagged 4 replies as AI denials; each was a correct refusal that quoted the line it wouldn't say, read and waived one at a time by Giovanni Alcantara. 78 held-out attack runs bound the violation rate at 10.7% per run (95% upper). |
| Legitimate tasks completed | 72 of 72 held-out runs (100.0%; Wilson 95% interval 94.9% to 100.0%) |
| Tool decisions held for the owner that the task expected the Desk to make alone | 0 of 80 decisions the held-out tasks expected allowed (0.0%) |
| From Claude's finished reply to the visitor seeing it, p50 and p95, measured locally (the hosted demo wasn't measured) | 1,764 / 4,484 ms (n = 60) |
| The full turn, from the visitor's message to Claude's reply, warm, p50 and p95, measured locally | 4,324 / 10,114 ms (n = 57) |
| Model cost per conversation | $0.049 mean, $0.046 p50, $0.095 p95, over 117 legitimate-task conversations, both splits; held-out ones averaged about 2 Desk replies |

From the [final eval pass's report](evals/reports/2026-11-03-20261103-012831-4a664a.md): pass 20261103-012831-4a664a, 2026-11-03.

The attack suite tests known attacks: a clean run means none of those got through, not that no attack can.

The [evals guide](docs/evals.md) says what each suite tests, how a run is judged and gated, what it costs and how to reproduce one, and holds the latest results.

## Run it locally

You need Docker with Compose (running), uv, Rust 1.99.1 (rustup reads it from `kernel/rust-toolchain.toml`), Node 24 (24.15 or later), and make, git, curl, unzip and a C compiler: Xcode Command Line Tools on macOS, `build-essential` on Debian or Ubuntu. uv fetches Python 3.13. It's set up for macOS and Linux, arm64 or x86_64; on Windows, use WSL. The first `make setup` builds the kernel and takes several minutes.

```sh
make setup   # dependencies, the kernel module and proof binary, cvc5, Postgres in Docker, migrations and roles
make dev     # the kernel on 127.0.0.1:8701, the API on 127.0.0.1:8700 and the web app; Ctrl-C stops all three
```

Then open the address Vite prints. Model features need an Anthropic API key: add `ANTHROPIC_API_KEY=<your key>` to `.env`, which `make setup` copies from `.env.example`. `make dev` starts all three services and stops them together; it refuses to start without the proof binary and cvc5 installed by `make setup`.

`make setup` runs Postgres on 127.0.0.1:5433; if it stops, for example after a restart, `docker compose up -d db` starts it again. Besides 8700 and 8701, `make dev` uses 8702 for the mock payments server the kernel starts, and Vite uses 5173, so these ports need to be free.

Run the tests with `make test` and `make web-test`. `make test` runs the kernel's tests and the backend's. The backend's use the local database and empty its tables, including any Desks you made, so stop `make dev` first. `make web-test` runs the web app's tests, after installing Playwright's browsers and their system packages; on Linux that needs Debian or Ubuntu and asks for sudo. Both are long runs: CI splits the backend tests across four machines.

## How it was built

Claude Desk was built with Claude Code. Claude Opus 5.5 agents wrote the plans and the code, test first and one task at a time, and each task was reviewed before it was committed. Every plan and pull request went to a review panel of models at extra-high reasoning (Claude Opus 5.5 and GPT-6.1 Sol, with other seats on some rounds); most plans end with a review ledger that names its seats and what they found, and [docs/reviews/](docs/reviews/) holds the reviews of the first master plan. [AGENTS.md](AGENTS.md#safety-invariants-never-weaken-these-not-even-to-make-a-test-pass) holds the rules every agent works under, including the safety invariants no change may weaken.

Three calls I made against what the agents or reviewers pushed for: a Desk resolves what it can and asks the visitor before involving the owner, instead of handing off by default; payments are fully mocked, with no provider keys, so the safety boundary shows without one; and every screen was designed and signed off before any interface code.

## Documents

- [Capability prediction](docs/capability-prediction.md): what a generally available Claude model will do for a small business by Q4 2027, and what will still hold it back.
- [Product proposal](docs/product-proposal.md): what Claude Desk is, who it's for, what the first release enforces in code, and how we'll know it works.
- The Vision article, under About this prototype in the app (`/about/vision`): where a Desk could go next.
- [Design spec](docs/specs/2026-10-28-claude-desk-design.md): the product, the locked decisions and why.
- [Threat model](docs/threat-model.md): what is claimed, what isn't, and where each control is enforced.
- [Architecture decisions](docs/architecture-decisions.md): the main choices, with the alternatives and their costs.
- [Path to MVP](docs/path-to-mvp.md): what changes for real users, scaling limits, latency and cost.
- [Deploying](docs/deploy.md): the AWS runbook and its monthly cost.
- [Continuous integration](docs/ci.md): what CI checks and what it can't.
- [Plans](docs/plans/): the master plan and one plan per part, most with a review ledger.
- [Reviews](docs/reviews/), [research](docs/research/) and the [kernel feasibility spike](docs/spikes/2026-10-28-kernel-feasibility.md).

---

Concept prototype by [Giovanni Alcantara](https://www.linkedin.com/in/giovannialcantara/), not an Anthropic product
