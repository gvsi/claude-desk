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

## What's real, mocked and unfinished

The kernel, API, web app, eval suites and AWS deployment are implemented on `main`. The hosted demo runs the prototype with these limits:

- **Real:** the kernel, the reply check, quotes and bookings, chat and take-over, and agent signatures and spending limits.
- **Mocked:** payments, code delivery (the Demo inbox), Claude memory, and the other apps in setup.
- **Not built:** connectors, channels, staff scheduling. See [Unfinished](#unfinished).

<details>
<summary>Part by part, with links to the code</summary>

| Part | Status | At this commit |
|---|---|---|
| Safety kernel | Real | On `main`: Rule cards compile to Cedar, proofs gate activation, every tool call gets a decision, approvals bind to one exact call, and the ledger is hash-chained and signed. See [`kernel/`](kernel/) and [`kernel_service/`](backend/desk/kernel_service/). Browser-signed owner approvals are still on the roadmap; see the security model below. |
| The reply check: everything a visitor sees is checked by the kernel first. Prices, dates, discounts and bookings come only from cards built from the business's facts: Claude's own words can't state a price, date or discount, can't make a promise the cards don't back, and can confirm a booking only next to a booking card. | Real | On `main`: The kernel checks replies before delivery. It builds price, date, discount and booking cards from facts and scans Claude's prose in English and Spanish. See [`reply_check.py`](backend/desk/kernel_service/reply_check.py) and [`deliver.py`](backend/desk/api/deliver.py). Promises the code scan doesn't recognize rely on a model check, which can miss. |
| Quotes and bookings | Real | On `main`: The server prices quotes from the Desk's price list, applies the owner's discount rules and books open slots on the built-in calendar. See the [adapters](backend/desk/kernel_service/adapters/). The kernel books only when the booking carries the visitor's name and a phone number or email, or the visitor saved them as a lead or is verified; Claude asks for them first, and for the address on a visit at the visitor's place, which isn't required. Fixed-menu prices and calendar slots; no staff scheduling, recurring bookings or external calendar connector. |
| Public chat and owner participation | Real | On `main`: Checked replies, receipts, owner take-over, messages, whispers and hand-back work in the [public chat](web/src/public/PublicChat.tsx) and [owner conversations](web/src/owner/conversations/). [Claude's replies render Markdown](web/src/ds/components/ClaudeMessage/ClaudeMessage.tsx). Links in its prose open in a new tab, and the kernel's reply check allows them only to the business's own contact details. Payment and document links come from cards. English and Spanish are supported; other languages open an owner handoff. A [demo visitor](backend/desk/api/demo_visitors.py), an AI that plays a customer on the owner's own Desk through the same public endpoints any visitor uses, lets the owner try take-over and whispers. It's tagged "Demo visitor" in Conversations, on Today and in Customers, says it's played by an AI if asked, and runs one at a time per copy, at most three starts an hour. |
| Spanish | Real: Spanish replies and owner translations; other languages open an owner handoff | On `main`: the kernel's [language handling](backend/desk/kernel_service/lang.py), [turn route](backend/desk/kernel_service/turn.py) and the API's [translation jobs](backend/desk/api/jobs.py). |
| Passcode and demo copies | Real | On `main`: The [passcode](backend/desk/api/passcode.py), [per-visitor copies](backend/desk/kernel_service/copies.py), [rate limits](backend/desk/api/ratelimit.py) and visitor cookies are implemented. A cookie resumes the conversation. Signing in with a Claude account is a static vision screen. |
| Sample week | Hand-written samples; on in the hosted demo, off by default elsewhere | On `main`: Each hosted copy opens on a [hand-written week](backend/desk/kernel_service/sample_week.py) of finished conversations, so Today, Conversations, Customers and Safety have history on a first visit. The kernel writes it when it creates the copy and marks its ledger entries; no model ran for it. The owner app labels it "Recorded history". Today's "Last 7 days" and the owner [reports](backend/desk/api/owner_reads.py) count it and say so; the reports include its one paid sample payment. A local copy starts without it unless `SAMPLE_WEEK=1` is set. |
| Returning visitors | Simple: the visitor cookie resumes a conversation; Claude account sign-in is a vision mock | On `main`: [visitor cookies](backend/desk/api/cookies.py) and the [Claude account vision page](web/src/vision/ClaudeAccountPage.tsx). |
| Verifying a customer and releasing private documents | Real rules. Verification codes are simulated in the Demo inbox | On `main`: [Verification](backend/desk/kernel_service/verification.py) enforces contact-on-record routing, expiry, attempts and limits; [document release](backend/desk/kernel_service/adapters/release_document.py) requires the verified record owner. Codes appear in the Demo inbox, with no email or text delivery and no proof of contact possession. Client document upload is not implemented. |
| Payments and MCP | Payments are mocked; MCP pinning and execution checks are real | On `main`: [Payment links](backend/desk/kernel_service/payments.py), refunds and agent charges use the mock payments server. Its two MCP tools are [pinned by hash](backend/desk/kernel_service/mcp_pins.py), listed again before execution and disabled on drift until review. No money moves and no payment provider is connected. Checkout says "Test payment, no money moves". |
| Visiting agents | Real signatures and spending checks; a demo agent and wallet | On `main`: The [Agent Card](backend/desk/api/routes/public.py) and [signed endpoint](backend/desk/api/routes/agents.py), [signature checks](backend/desk/kernel_service/agents.py), [spending limits](backend/desk/kernel_service/mandates.py) and built-in [send-an-agent panel](web/src/public/agents/) work. The built-in agent and demo wallet stand in for another person's agent and wallet; connecting your own Claude is instructions plus an endpoint. |
| Setup | Real setup interview, website reads and web search; sample Claude memory and simulated apps | On `main`: The [setup consultant](backend/desk/api/setup.py) asks permission to read memory and a website, researches the kind of business, and asks one question or proposal card at a time. Memory is drafted from the owner's description. The closing offer adds the owner as a test client only with their yes and their own typed contact. In the [Tools step](web/src/setup/ToolsStep.tsx), the mock payments server, shown as Stripe with a Mock badge, has a "Turn it on" card that reviews its tools; "Confirm and turn on" activates the change. Other apps are simulated. The owner confirms rules and customer-facing text, runs safety probes and tries a preview before publishing a live link. Until then, "Change something" takes the owner from the closing plan or Real situations back to the chat; what was drafted from the answers is drafted again, and the rules can't be confirmed until the safety check has run on the new draft. Offers the owner's opening description mentions, such as a student discount, aren't set up from their words: setup lists them at the end and says the Desk won't offer them, since a discount reaches customers only through the owner's rules, where one can be added. |
| Business tools | Implemented; on in the hosted demo, off by default elsewhere | On `main`: In the hosted demo ([`BUSINESS_TOOLS_ENABLED`](infra/stacks/task.py)), accepted setup jobs can become [business tools](backend/desk/api/setup.py) for intake, typed appointments, fixed-purpose payments and urgent callbacks. Elsewhere the setting is [off by default](backend/desk/api/settings.py). The [kernel](backend/desk/kernel_service/business_tools.py) derives their effects and requires review before use. Payments still use the mock provider; appointments use the built-in calendar. Turner's emergency callback is already enabled in the [demo seed](backend/desk/kernel_service/seed.py). |
| The owner app | Real screens; People, shown as Customers, and reporting are simple | On `main`: [Routes](web/src/app/routes.tsx) cover Today and its briefing, Conversations, Customers, Rules, Safety, Notifications, Profile, Share, Knowledge and Settings, including alerts. The switcher, Desk picker, new-business setup and deletion work. Setup and [Ask Claude](web/src/owner/rules/) render Markdown and [stream Claude's replies](backend/desk/api/owner_streaming.py) as they're written. Customers and reporting are simple. Push, text and email alerts are simulated on the Notifications page, under Safety. The app and the public page follow the device's light or dark theme; Appearance, in Settings › General, can choose Light or Dark instead, kept in that browser. |
| Desk management | Real: switch between Desks, create one through setup and delete one | On `main`: the [owner layout](web/src/owner/OwnerLayout.tsx), [Desk picker](web/src/ds/components/Sidebar/) and [kernel Desk routes](backend/desk/kernel_service/desks.py). |
| Suggested upgrades | Simple: suggestions from the owner's approvals | On `main`: [Suggestions](backend/desk/api/rules.py) use at least three approvals of the same tool in 30 days and require the owner's confirmation. Suggestions use the owner's approvals, not the attack record. |
| Share kit | Link and QR real; mocks for the Google profile, email signature and voicemail, with the embed coming later | On `main`: [Share](web/src/owner/share/) provides the public link, a QR code and copy for a Google profile, email signature and voicemail. Share copy connects to no service; the website embed is marked "Coming later". |
| Vision pages and connectors | Static vision screens; other integrations are unfinished | On `main`: [vision pages](web/src/vision/) show a Claude account, city office, team Desk and phone app. [Connector management screens](web/src/owner/connectors/pages.ts) and the [Channels settings page](web/src/owner/settings/SettingsLayout.tsx) are not built. Other connectors and channels are not live integrations. |
| Accessibility | Automated checks and implemented interaction paths | On `main`: The [design system](web/src/ds/) and screen tests cover contrast, keyboard paths, live announcements, reduced motion and automated axe checks. These checks are not an independent accessibility audit. |
| Evals | Real suites, calibration and latency tooling | On `main`: [Tier 1](evals/tier1/) exercises boundary cases without model calls; [tier 2](evals/tier2/) has hostile and legitimate conversations, separate calibration and held-out splits, and a results gate. [Calibration](evals/calibration/) and [latency tooling](evals/latency.py) are implemented. The final pass's results are in Evidence below; hosted latency wasn't measured. |
| Hosting | Hosted prototype | On `main`: [AWS infrastructure](infra/) serves the web app and API through CloudFront, splits secrets by container and keeps the kernel reachable only inside its task. The [runbook](docs/deploy.md) covers deploys and smoke checks. One application task and one database; this is a concept prototype, not a production service. |

</details>

### Unfinished

Connector management screens and the Channels settings page are not built. The built-in tools do not provide client document upload, staff scheduling, recurring bookings or an external calendar connection. Real payment processing, verification by possession of a contact and delivery of email, text or push notifications remain outside this prototype.

## What I left out on purpose

Real payments and real delivery of verification codes, so the safety boundary could be shown end to end without a provider; phone and email channels; staff scheduling and external calendars; connector management. Each would widen the surface without changing the one idea: a public Claude that acts for its owner and can't act past the owner's rules.

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
- [Design canvas](https://claude.ai/artifact/M46eP5Mtsoi15ruVMZ1uUx?sk=bbGjca_v34tZ2PPYoF0OVA): the signed board for every screen, and the explorations behind them.
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
