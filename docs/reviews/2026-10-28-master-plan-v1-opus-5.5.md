# Review: Claude Desk spec and master plan (pre-implementation)

- **Reviewer:** Claude Opus 5.5 (extra-high reasoning)
- **Date:** 2026-10-28
- **Target:** the design spec and master plan v1 (commit `40d302a`)

Findings were triaged into master plan v2; some were declined. This is the review as written, lightly edited for publication.

Inputs: `docs/specs/2026-10-28-claude-desk-design.md` (the "spec"), `docs/plans/2026-10-28-00-master-plan.md` v1 (the "plan"), and the research notes in `docs/research/` (policy, arch, stack options, safety patterns). UNVERIFIED means I did not check it against a primary source today.

**Severity levels**
- **Blocker:** fix it in the master plan before the subsystem plans are written. It breaks a core claim, leaves a gap an attacker or auditor can find, or makes the schedule fail.
- **Important:** must land in the subsystem plans.
- **Minor:** cheap clarity or polish.

## Verdict

- **The kernel split protects credentials, not authority.** The API process asserts the principal, runs verification, owns the whole database and emits the reveal. Against a compromised API process it is mostly not a boundary. It is cheap to fix: move four responsibilities, add a database role, sign replies.
- **Money and commitments can bypass the design with no compromise at all.** Claude picks prices and recipients as tool arguments. An agent's spending limit authorizes pay-outs. The verification code is public and fixed.
- **The plan has structural gaps.** The contracts are too thin for the plan index. The proofs mostly re-prove Cedar's forbid-wins rule. The riskiest infrastructure is first touched on Sunday.

## What the API process can do on its own, as written

| Capability | How | Blocked by the kernel today? |
|---|---|---|
| Make any session "verified" as any person | It passes `Principal{level:"verified", person_id}` to `/decide` and `/check_reply`. `desk/api/verification.py` lives in the API. `sessions.principal_json` is writable by the API. | No |
| Approve any held action | `/approvals/sign` "passes the owner's authenticated request through", but the kernel cannot authenticate an owner | No |
| Change policies, mode, per-person rules, contacts on record, tool enablement and pins | Everything sits in one schema under one database role, so it can write directly | No. Proofs guard only the baseline, and only on the `/policy/activate` path |
| Show unchecked text to a visitor | The API is the SSE emitter | No |
| Delete or truncate ledger rows | Same database role | Detectable only if the chain head is anchored, which is not planned |
| Read Stripe or MCP keys | Possible if secrets are fetched at runtime with the ECS task role, which every container in the task shares | Depends on Plan 05 |
| Execute a call that Cedar refuses for every principal; forge ledger signatures | — | Yes |

---

## Findings

### Blockers

**B1. The kernel boundary is credential custody only; authority comes from the API.**
- **Where:**
  - Plan: Kernel HTTP API (`/decide {principal}`, `/check_reply {principal}`, `/approvals/sign`).
  - Plan: Repo layout (`desk/api/verification.py`, `sessions.py`).
  - Plan: Task 2 (one schema holding `sessions.principal_json`, `people.contact_on_record`, `policies`, `tools`, `facts`, `ledger_entries`).
  - Spec: Decisions log › Safety kernel (locked); Safety architecture #1 and #6.
- **What's wrong:**
  - See the table above.
  - SymCC proves policy logic over attributes. It says nothing about who set `principal.verified`.
  - The baseline item "verification codes only to contacts on record" is enforced outside the kernel.
- **Fix** (about 0.5 day, mostly moving code):
  1. **The kernel owns sessions and identity.**
     - Add `POST /sessions`, `POST /verify/start` and `POST /verify/check` to the kernel.
     - Add a kernel table `kernel.sessions(session_id, desk_id, principal, verified_at, mandate_id)`.
     - `/decide`, `/execute` and `/check_reply` take `session_id`, never a `Principal`.
  2. **Use two Postgres roles and schemas.**
     - The `kernel.*` schema holds policies, tools and pins, contacts, the session principal, decisions, approvals, facts, documents, verification challenges, mandates and the ledger. Only `desk_kernel` can write to it.
     - `desk_api` gets read-only views of what it needs.
     - Alembic runs as an admin role.
  3. **Give each container its own secrets.**
     - Use the per-container ECS `secrets` field, which the execution role fetches.
     - Give the task role no Secrets Manager or S3 grants.
  4. **Write the threat model as a claim you can defend,** and put it in the README and in the Safety page's "how it works":
     - Baseline invariants hold even if the API process is compromised.
     - Owner preferences hold unless the API process or the owner's session is compromised.
     - Private data already in a verified session's model context is exposed to a compromised API.

**B2. Claude picks prices and recipients as tool arguments; the baseline only limits money going out.**
- **Where:**
  - Plan: Shared contracts › `ToolProfile.amount_arg` and `recipient_arg`; Review Focus.
  - Spec: System › Tool profiles; Safety architecture #3 and #6.
- **What's wrong:**
  - **The Chevy-$1 path works with no compromise:**
    - The visitor talks Claude into calling `native.quote(amount=100)` ("Mike said $1").
    - $1 is under any money cap, so `/decide` allows it.
    - The result becomes a Fact, so the reply "your quote is $1" counts as backed and is revealed.
  - **The same shape appears elsewhere:**
    - `payment_link(amount=…)`.
    - `release_document(recipient="attacker@x")`.
    - A Stripe payment-link `description="80% off applied"`. It shows on Stripe's checkout page and never passes `/check_reply`.
- **Fix:**
  - **Server-price every inbound-money tool:**
    - `quote(items[], qty, discount_code?)` is priced by the kernel from a price list the kernel owns.
    - `payment_link(quote_id)` takes a quote, not an amount.
    - Discounts come only from a card field `max_discount_pct` (default 0), plus a baseline invariant `total ≥ list × (1 − max_discount)`.
  - **No recipient arguments.** Messages and documents go only to the owner or to the verified principal's contact on record, enforced by a baseline forbid plus an invariant.
  - **No Claude-written free text in any tool field a visitor can see.** Fill it from a template using facts, or run it through `/check_reply`.
  - Add all four cases to Review Focus and to the attack suite.

**B3. "No money without an owner rule *or* a signed limit" lets an agent's spending limit authorize pay-outs, and the limit itself is an unverified integer.**
- **Where:**
  - Spec: Safety architecture #6.
  - Spec: Safety architecture #1 ("signed agent … gets public-level trust plus its signed spending limit").
  - Spec: Decisions log › Defaults accepted ("our own AP2-style signed spending limits").
  - Plan: `Principal.agent_limit_cents`; `Effect = move_money`.
- **What's wrong:**
  1. **Direction.** A visiting agent's limit is the visitor's authorization to spend. It is not authorization for the business to refund or pay out. As worded, a $1,000 signed limit satisfies the baseline for a $500 refund.
  2. **Trust.** Nothing says who issues or verifies the signed limit, so any agent can sign its own.
  3. **Accumulation.** Cedar is stateless, so ten $100 calls each pass a $100 limit.
- **Fix:**
  - **Split the effect.** Replace `Effect.move_money` with:
    - `charge`: money coming in, capped by the signed limit for agents.
    - `pay_out`: refunds and transfers, allowed only by owner rules and never by a signed limit.
  - **Add a contract** `Mandate{mandate_id, issuer, agent_key_id, principal_hint, limit_cents, currency, expires_at, nonce, sig}`.
    - The kernel verifies it against trusted issuers. For the prototype, that is a "Demo wallet" issuer key held by the kernel and used by the send-an-agent panel.
  - **Track cumulative spend.** The kernel computes `context.mandate_spent_cents` from its own records, with the invariant `amount + spent ≤ limit`.
  - **Default to public.** An agent with no mandate from a trusted issuer gets public-level trust.

**B4. The fixed demo code `424242` for every contact is unsound. This re-opens a locked choice for a concrete reason.**
- **Where:** Plan: Global Constraints ("`424242` for every contact in seeds"). Spec: Decisions log › Verification and messages.
- **What's wrong:**
  - **Impersonation without inbox access.** Anyone who knows a contact on record can verify as that person without opening any inbox. They can learn the contact from the People list, the seed data, or a demo visitor's shared live link. A visitor claiming to be a customer on record (name@example.com) → code sent → type 424242 → that customer's lease.
  - **Anyone can find it.** It takes minutes, and it amounts to a jailbreak, which is an anti-goal.
  - **It makes the baseline untestable.** Where the code is delivered no longer matters, so "codes only to the contact on record" can't be tested.
- **Fix:**
  - **Random codes.** Use a random 6-digit code per challenge: hashed, 10-minute expiry, 5 attempts, plus a rate limit on challenges per person. This is the "real logic" the spec already promises.
  - **Delivery.** Deliver it only to that contact's entry in the Demo inbox. The UX barely changes: one glance at the inbox.
  - **Evals.** Evals read codes through a kernel hook that exists only in tests.
  - **No enumeration.** Give public sessions a uniform reply ("If that matches our records, we sent a code") so the chat can't be used to enumerate customers.

**B5. The shared contracts are frozen "exactly", but they can't express half the plan index.**
- **Where:** Plan: Shared contracts; Kernel HTTP API; Task 2.
- **What's missing (each feature below has no field or call):**
  - **Sessions:**
    - Session state and take-over/handoff: `mode: ai|owner|paused`, owner presence ("Answering"), the "Mike joined" event, callback booking.
    - A typed union of SSE events (writing, receipt, revealed{text, sig}, held, owner_joined, demo_inbox). OpenAPI does not type SSE payloads, so generate the TypeScript types from a Pydantic discriminated union.
  - **Rules and approvals:**
    - `RuleCard`: kind, tool or effect, money limit, hours, who, mode, `@id`.
    - Approval answers with a scope preview.
    - A policy annotation contract (`@tier("auto"|"hold")`, `@card`, `@reason`). Without it, the "3 policy sets" in `policy.rs` can't be split out of one `cedar_text`.
  - **Identity:** `Mandate` (see B3).
  - **Facts and knowledge:**
    - Typed `Fact.claims` (money in cents with currency, percent, datetime with timezone, text) instead of `value: dict`.
    - `owner_statement` facts.
    - Knowledge items with labels.
  - **Tables for native tools and their supporting data:** price list, quotes, calendar and bookings, documents, leads, verification challenges, run events (SSE replay), notifications, blocked attempts and triage.
  - **Languages:** `messages.lang` and an owner-side translation.
  - **Setup:** setup-chat state.
  - **Principal:** it needs `kind`, `person_id`, `verified_at` and `mandate_id` so it can express an owner, and an agent acting for a verified human. A single `Level` enum can do neither.
  - **Decision and verdict:**
    - `Decision` needs an argument hash, a state, `expires_at` and the ledger sequence number.
    - `ReplyVerdict` needs a signature and typed violations.
  - **Schema scope.** `PolicyEngine(schema, baseline)` takes one static schema, but MCP actions differ per desk.
  - **Table count.** Task 2 says "all 13 tables" but lists 12.
- **Fix:** add a Task 0, "contracts v2", before any subsystem plan. It takes about 2 hours.

**B6. The first deploy is on Sunday, and the riskiest unknowns are infrastructure.**
- **Where:** Plan: Schedule; Plan index (05). Spec: Decisions log › Stack.
- **What's wrong.** Each of these could cost a day:
  - **ECS Express Mode** may not host a two-container task with per-container secrets (UNVERIFIED; its API centres on a primary container).
  - **Fargate build:** the PyO3 wheel and the cvc5 binary must build for Fargate's architecture.
  - **SSE** through CloudFront and the ALB.
  - **Cookies:** the CloudFront and ALB domains are different sites, so Safari blocks the cookie.
  - **Migrations.**
  - **Stripe MCP** reachability and auth.
- **Fix: deploy a walking skeleton to the real URL on Thursday night (≤4 h):**
  1. **CDK stack:** the `api` and `kernel` containers with per-container secrets, RDS, and CloudFront serving `/api/*` from the same origin.
  2. **Kernel build:** a multi-stage arm64 build of `desk_kernel` with cvc5. `/health` returns `version()` and the result of one SymCC `implies` check.
  3. **SSE check:** stream for 5 minutes with 15-second comments and watch it in Safari.
  4. **Cookie check:** set the passcode cookie and read it in Safari.
  - **Fallback:** if Express Mode can't host the sidecar, use CDK `ApplicationLoadBalancedFargateService` with two container definitions. It uses the same Fargate and ALB primitives, so the locked platform choice is unchanged in substance.

### Important

**I1. `context.review` can widen permissions unless its placement is enforced; Cedar has no floats; partial evaluation is experimental.**
- **Where:**
  - Spec: Decisions layer (locked).
  - Plan: Global Constraints.
  - Plan: Rust module surface (`needs_review` via partial evaluation).
  - Plan: the `Review` floats.
- **What's wrong:**
  - **It's only a convention.** "Only as extra conditions on auto-allow rules" isn't enforced anywhere.
  - **A fooled reviewer can lift a rule if review appears in:**
    - a drafted `forbid … unless { context.review.within_charter > 0.9 }`;
    - an `||` or a negation;
    - a hold-permit.
  - **The proofs don't cover it.** Baseline proofs treat review as any value, so they cover the baseline only, not the owner's forbids and holds.
  - **No floats.** Cedar has no float type, only `decimal` with comparison methods.
  - **Partial evaluation is experimental.** `is_authorized_partial` sits behind an experimental feature.
  - **The reviewer still reads attacker-shaped text.** It never sees the visitor's raw text, but it does see attacker-shaped free-text arguments and reply drafts.
- **Fix:**
  1. **Lint at activation.** Walk the policy JSON (EST).
     - `context.review.*` is allowed only as top-level `&&` conjuncts inside the `when` clause of `@tier("auto")` permits.
     - It must be in monotone form (`within_charter_bp >= K`, `manipulation_bp <= K`).
     - Reject it anywhere else.
  2. **Use integers.** Scores are `Long` basis points (0–10000).
  3. **Drop partial evaluation.** Evaluate twice instead, with review at its best and worst values. The same outcome both times means the reviewer call can be skipped. This is exact under rule 1.
  4. **Prove monotonicity.** Add a SymCC check that `auto ⇒ auto_without_review`.
  5. **Fail closed.** A reviewer error or timeout leaves the attribute absent, so the permit doesn't fire and the action is held.
  6. **Define "block".** The spec says the reviewer can "block"; the plan only allows allow → hold. Define block as hold plus a count toward a session circuit breaker.
  7. **Limit the reviewer's input.** Strip or truncate free-text arguments before the reviewer sees them.

**I2. The planned proofs mostly re-prove Cedar's forbid-wins rule; the real risks are elsewhere.**
- **Where:**
  - Spec: Enforcement (locked) ("baseline invariants proven before any owner policy goes live").
  - Spec: Policy, per door ("Claude drafts the owner's charter into a policy").
  - Spec: Defaults accepted (fallback templates).
  - Plan: `cedar/invariants`, `prove.rs`.
- **What's wrong.** Owner policies only add permits and forbids, and a forbid always wins. So `baseline ∪ owner ⇒ baseline-invariant` re-proves Cedar's semantics on every activation. It can't catch what actually goes wrong:
  1. **Claude writes Cedar that is wider than the owner's cards.** No baseline is violated, but the behavior is wrong.
  2. **A forbid that errors is skipped, which fails open.**
     - Validated policies can still error on `Long` overflow (`amount + spent` with a huge `amount`), on extension calls, and on resource entities missing from the store, such as an unknown `doc_id`.
  3. **A mis-profiled tool escapes the effect-group forbids.** The proofs and the baseline share the same grouping, so they share the same blind spot.
- **Fix:**
  - **Claude drafts RuleCards (typed JSON), never Cedar.** A deterministic compiler emits Cedar with `@id`, `@card`, `@tier` and `@reason` annotations.
  - **Prove these at activation:**
    - `never_errors` on the baseline plus the active policies.
    - `auto ⊆ reference(cards)`, where the reference is generated independently from the card fields. Show counterexamples in the owner's language ("A customer could get a $500 refund without asking you").
    - Review monotonicity (I1).
    - The price floor and recipient invariants (B2), the mandate invariant (B3), and a prototype-wide hard cap on auto-allowed money.
  - **Fail closed in the kernel:**
    - Treat any forbid evaluation error as a refusal.
    - Refuse when the resource entity can't be resolved.
    - Range-check numeric arguments before Cedar.
  - **This removes the "fallback templates when a drafted policy won't validate" path:** templates become the only path.

**I3. An LLM drafts tool profiles from untrusted descriptions, and "read-only" tools are enabled without asking.**
- **Where:**
  - Spec: Tool profiles; Confirming profiles; Prototype scope.
  - Plan: `ToolProfile`; `/tools/connect`.
- **What's wrong:**
  - **Injection into the classifier.** An injected tool description can get the drafter to label a money tool `read`, and it is then enabled without the owner seeing it.
  - **Generic tools.** Stripe's MCP server exposes generic `stripe_api_read` and `stripe_api_write` tools whose arguments are an HTTP method and path (per the research notes in `docs/research/`; UNVERIFIED today). A flat `effects` list can't describe them.
  - **Ownership from arguments.** `record_owner_arg` takes record ownership from an argument Claude supplies.
- **Fix:**
  - **Deterministic floor.** An unknown tool gets every effect, counts as irreversible, and is hold-only until the owner confirms. MCP annotations are hints only.
  - **Curated registry.** Ship a curated Stripe profile registry in the repo.
  - **Synthetic operations.** Expose operations such as `mcp.stripe.create_refund` and `mcp.stripe.list_charges`, each bound to a fixed method and path, so Claude never sees the generic write tool.
  - **Trusted descriptions.** Claude sees descriptions the owner confirmed, not the server's text.
  - **Pinning.** Pin the SHA-256 of the raw `tools/list` entry as it came over the wire.
  - **Ownership by lookup.** The kernel resolves resource ownership by looking it up (fetch the charge, read its customer), not from arguments.
  - **New calls.** Add `/tools/confirm` and `/tools/available {session_id}`, which returns the kernel-filtered tool list for that session.

**I4. Ledger integrity gaps.**
- **Where:**
  - Plan: Rust surface `Ledger.append(prev_hash, payload_json)`.
  - Plan: Task 2 `ledger_entries(seq, desk_id, …, payload_json)`.
  - Plan: Kernel HTTP API (no append call).
  - Spec: Safety kernel ("append to ledger" is one of its about five calls); baseline ("every attempt is logged").
- **What's wrong:**
  - **Hashes won't verify.** If `payload_json` is stored as JSONB, Postgres reorders keys, so hashes fail on verification.
  - **The chain can fork.** Python reads `prev_hash` and then Rust appends, so two concurrent appends fork the chain.
  - **Weak hash coverage.** `seq` is global, and the hash doesn't cover desk, sequence number or time.
  - **Unprotected rows.** The API can delete or truncate rows.
  - **Events go unlogged.** There is no append call, so events that originate in the API are never logged: verification attempts, rate-limit blocks, take-overs, whispers, A2A auth failures.
- **Fix:**
  - **Canonical bytes.** Store canonical JCS text and hash those bytes.
  - **Full coverage.** Hash `(desk_id, seq, prev_hash, created_at, payload)`.
  - **No forks.** Keep a per-desk head row locked with `FOR UPDATE`, plus `UNIQUE(desk_id, seq)`.
  - **Access.** Only the kernel role can write.
  - **Append call.** Add `POST /ledger/append` with `source="api"` marked as untrusted origin.
  - **Witness copy.** Send a signed head checkpoint every N entries to the Demo inbox as the owner's witness copy.
  - **Verification.** Add a `verify` CLI and publish the public key on the Safety page and the Agent Card.

**I5. Approvals: the token isn't tied to owner authentication, nothing is re-checked, and there is no cancel, no expiry and no defined answer scope.**
- **Where:**
  - Plan: `/execute`, `/approvals/sign`, Review Focus #4.
  - Spec: Safety architecture #5; At runtime #6.
- **Fix: one kernel call,** `POST /approvals/{decision_id}/answer {answer, owner_session}`. It:
  - accepts one answer per decision;
  - re-decides against the current policy, pins and spend, with `context.owner_approved = true` (this satisfies hold-permits only; the baseline still applies);
  - executes with `decision_id` as the Stripe idempotency key;
  - writes the outcome to the ledger.
- **Supporting changes:**
  - **Idempotency.** `/execute` returns the stored result when called again.
  - **States.** `held → approved | denied | expired | cancelled`, with a 24-hour expiry. A visitor's "never mind" cancels.
  - **Rule-making answers.** "Allow only for this person" and "Deny always" produce a RuleCard diff the owner sees before confirming. It goes through activation, so it is proven and logged.
  - **Approval cards.** Render only kernel-typed fields: tool, amount, recipient, record owner. Never show Claude's summary or translation (the Unit 42 lesson: a card that showed only the total let an injected item through).
  - **Token.** Drop the separate HMAC token, or bind it to `{desk, session, args_sha256, decision_id, exp, jti}` and make it single-use.

**I6. Parked tool calls conflict with Claude's message protocol.**
- **Where:** Spec: Decisions log › Stack ("Procrastinate to resume paused runs"). Plan: Plan 02.
- **What's wrong:**
  - **Parking blocks the chat.** A `tool_use` without a `tool_result` blocks the conversation: the visitor's next message returns a 400.
  - **Opus 5.5 constraints (per the research notes in `docs/research/`):**
    - Thinking can't be disabled, so history must be append-only.
    - Forced `tool_choice` returns 400, so `send_reply` can't be forced.
  - **Mixed outcomes.** Parallel calls can mix allow and hold.
  - **Concurrent turns.** A double submit or a fast second message can interleave two turns and break `tool_use`/`tool_result` pairing.
- **Fix:**
  - **Never park.** Return `tool_result {status:"held", approval_id}` immediately.
  - **Owner answers.** When the owner answers, the app posts a fixed-template outcome card ("Mike approved — booking {{B-77}}") and queues a system note for Claude's next turn.
  - **Serialize turns.** Add a per-session run lock and a queue for inbound messages.
  - **Delivery feedback.** The `send_reply` `tool_result` reports what was actually delivered, so Claude knows when its text was rewritten.
  - **Plain text is checked too.** Any `end_turn` text is a draft with zero citations and goes through the check.
  - **Mixed results.** Return mixed parallel outcomes in one `tool_result` message.
  - **Simpler queue.** Procrastinate becomes a plain job queue.
  - **Spike this on day 1.**

**I7. The reply checker tries to spot bad spans, and spelling will beat it.**
- **Where:**
  - Spec: Safety architecture #3; At runtime #4; Defaults accepted ("Claude lists the tool-issued references"); Languages.
  - Plan: `ReplyDraft`; `ReplyVerdict`.
- **What's wrong:**
  - **Regex misses:** "eighty percent", "half price", "la mitad", "gratis", and the ambiguity between Spanish "1.500 €" and "$1.500".
  - **Injectable extractor.** The Haiku extractor reads attacker-shaped text, so it can be injected.
  - **Self-declared language.** `ReplyDraft.language` is declared by Claude.
- **Fix:**
  - **Deterministic quoting.**
    - Claude writes placeholders such as `{{Q-1042.total}}` and `{{charter.hours}}`.
    - Code renders the values per locale.
  - **Fail closed** on any of these outside a placeholder, unless a cited charter or knowledge fact covers it:
    - a numeral, currency, percent or number word;
    - a commitment verb from an en/es lexicon: waive, free, guarantee, refund, discount, approved, gratis, garantía, reembolso, descuento, and so on.
  - **Additive extractor.** The Haiku pass can only add violations, never clear them.
  - **Kernel language detection.** The kernel detects the language; anything other than en/es goes to handoff.
  - **One retry.** Allow one regenerate-with-feedback attempt before falling back to "Let me check with Mike".

**I8. Only the API process enforces check-then-reveal.**
- **Where:** Plan: Global Constraints; `/check_reply`. Spec: Reply timing.
- **Fix** (about 3 hours; it turns a claim into something an auditor can inspect):
  - **One choke point.** A single `deliver()` function in the API handles chat, A2A responses, Demo-inbox follow-ups and error text.
  - **Signed verdicts.** The kernel signs the `ReplyVerdict` with Ed25519 over `{session_id, message_id, sha256(text), ledger_seq}`.
  - **Clients verify.** The public page and the send-an-agent panel render only signed messages.
    - The public key ships in the static bundle on S3/CloudFront.
    - Verify with WebCrypto Ed25519 or `@noble/ed25519`.
  - **Receipts link to the ledger.** The margin receipt links to the ledger entry.

**I9. Data labels leak through knowledge, memory and mid-session identity switches.**
- **Where:**
  - Spec: Visitor experience (Memory); Product (Knowledge); At runtime #3.
  - Plan: `Label`; `Fact`.
- **What's wrong:**
  - **No label rule.** Uploads, website content and MCP outputs have none. FIDES treats unlabeled data as public.
  - **Memory leaks.** Returning-visitor memory can load a verified session's private facts into a later public session.
  - **Identity switches leak.** Verifying as A and then as B in one session leaves A's data in context.
  - **Pasted documents.** Documents pasted into context can be paraphrased out.
- **Fix:**
  - **Owner-only default.** Uploads and MCP outputs are owner-only until the owner marks them public.
  - **Kernel-filtered context.** A kernel call `GET /context {session_id}` returns the entitled knowledge and facts for prompt assembly.
  - **Memory.** Across visits, load only public facts until the visitor verifies again.
  - **New person, new session.** Switching to a different verified person starts a fresh session.
  - **Release by link.** Documents are released as a single-use link the kernel serves; facts carry only the title and ID.
  - **Canaries.** Per-document canary strings feed both runtime leak detection and eval oracles.

**I10. The owner's own words don't count as facts.**
- **Where:** Spec: Owner experience (Taking over a conversation; Conversation detail). Plan: no coverage.
- **What's wrong:**
  - **Blocked owner offers.** If Mike types "I can do it for $150" or whispers "offer $20 off", Claude repeating it is blocked as unbacked.
  - **No lock.** Nothing stops the agent loop during a take-over.
- **Fix:**
  - **Owner messages.** They bypass the checker but are logged and turned into `owner_statement` facts through an authenticated kernel call.
  - **Whispers.** They go in as system messages, and any commitments in them also become facts.
  - **Take-over.** Switching the session mode pauses the loop.

**I11. Mode, per-person rules and contacts live in columns the API can write.**
- **Where:**
  - Plan: Task 2 (`desks.mode`, `people.rules_json`, `people.contact_on_record`).
  - Spec: Owner experience (Autonomy); Safety architecture #5 ("Auto-OK limits rise …").
- **Fix:**
  - **Compile into policy.** Mode and per-person rules compile into the active policy version as RuleCards.
  - **Contacts.** The kernel owns contacts. Changing one requires an owner-authenticated call that logs the change and notifies the old contact.
  - **Only the owner widens.** "Limits rise" must be suggestions the owner confirms.
  - **Resist farming.** Weight suggestions by distinct verified people, so an attacker can't manufacture a clean record.

**I12. SymCC, PyO3 and cvc5 toolchain choices.**
- **Where:** Plan: Tech Stack; Task 1 Step 1; Repo layout `prove.rs` ("runs `cedar symcc`").
- **What's wrong:**
  - **CLI churn plus Rust cost.** Shelling out from Rust to the experimental CLI combines the CLI's churn (its README says the surface "can change between releases") with Rust's build cost. The feature name is already hedged.
  - **cvc5 install.** `brew install cvc5` is UNVERIFIED and unpinned.
  - **Architecture.** Building for x86 Fargate from an arm64 Mac means slow QEMU builds.
  - **GIL.** `prove()` holds the Python GIL for seconds and stalls `/decide`.
- **Fix:**
  - **Pinned crate.** Call `cedar-policy-symcc` from Rust, pinned to `=0.8.0` with `cedar-policy =4.14.0` (per the research notes in `docs/research/`).
  - **Pinned solver.** Use a static cvc5 release binary pinned to the version SymCC targets (1.3.x), on the Mac and in Docker.
  - **Build.** ARM64 Fargate; a multi-stage Docker build (`maturin build --release`, then `python:3.13-slim-bookworm`).
  - **Concurrency.** Release the GIL (`allow_threads`/`detach`, depending on the PyO3 version), run proofs in a thread pool, and give each check a timeout.
  - **Inputs.** Pass strings, not file paths.
  - **Fallback if SymCC slips:** prove parameterized card templates once in CI, with limits as entity attributes. At activation, run an exhaustive bounded evaluation and label it honestly ("checked on N cases", not "proven").

**I13. Deploy details that break SSE and cookies.**
- **Where:**
  - Plan: Architecture ("web … static on S3 + CloudFront … talks only to the API service"); Plan 05.
  - Spec: Stack ("long idle timeout and keepalives").
- **Fix:**
  - **Same origin.** Serve the API through CloudFront (`/api/*` routed to the ALB origin, caching off, all cookies and headers forwarded), or put both under one registrable domain.
  - **Cookie.** `cd_copy` is HttpOnly, Secure and SameSite=Lax, and stored hashed in the database.
  - **Keepalive.** Send an SSE comment every 15 seconds. This fits the ALB's 60-second default and CloudFront's origin response timeout (default 30 s), so no ALB change is needed.
  - **One task.** Run desired = max = 1 task for the demo window, with Postgres LISTEN/NOTIFY for fan-out across deploys.
  - **Startup order.** Give the kernel container a health check and set `dependsOn: HEALTHY`.
  - **Local dev.** Use `network_mode: service:kernel` in docker-compose so `127.0.0.1` works.

**I14. The Decisions layer promises "probabilities … calibrated on the attack suite".**
- **Where:** Spec: Decisions layer (locked).
- **What's wrong:**
  - **No logprobs.** The Claude API doesn't return them.
  - **Uncalibrated.** Probabilities the model states in text are not calibrated.
  - **Too few cases.** 50 scenarios can't calibrate anything.
  - **Overfitting.** Tuning thresholds on the gating set overfits it.
- **Fix:**
  - **Rename.** Call them scores, in basis points.
  - **Thresholds.** Use fixed, conservative thresholds.
  - **Reporting.** Report confusion counts on a held-out split.
  - **Keep** the pluggable backend.

**I15. Eval gate design.**
- **Where:** Plan: Plan 04. Spec: Enforcement (locked) ("gate every change … zero baseline violations").
- **What's wrong:**
  - **Too slow per change.** Running ~50 multi-turn Opus scenarios on every change is slow and costly.
  - **Circular oracle.** The oracle for "unbacked commitment" is the checker itself.
  - **Stochastic runs.** Thinking makes runs non-deterministic.
- **Fix:**
  - **Tier 1: every commit, seconds, no LLM.**
    - A golden `/decide` table.
    - Reply-check fixtures in en and es, including spelled-out numbers and locale formats.
    - Injected tool output and description-drift cases.
    - Ledger verification.
  - **Tier 2: nightly and before each deploy.**
    - LLM attacker scenarios, three runs each.
    - Independent oracles: canary strings, kernel execution records, per-scenario regexes such as "80%" or "$1".
    - Benign tasks to measure utility.
  - **New cases.** Add those from B2, B3, I3 and I9, mixed parallel calls, approval replay, and cross-copy access.

**I16. Per-visitor demo copies.**
- **Where:** Spec: Decisions log › Demo copies. Plan: Global Constraints; Task 2 `copies`.
- **What's wrong:**
  - **Slugs.** `desks.slug` must be globally unique for colleague links.
  - **Isolation.** Child tables carry no `copy_id`, so one missing filter leaks another demo visitor's conversations.
  - **Seeding.** The seeded held request must be a real kernel decision (logged and approvable), but `seed.py` lives in the API.
  - **Shared Stripe account.** All copies share one Stripe test account, so a refund in copy A breaks copy B's seeded charge.
  - **Wasted proofs.** Running proofs per copy repeats the same work.
- **Fix:**
  - **Slugs.** Use `turner-plumbing-<short>`.
  - **Isolation.** Put `copy_id` on every row, with row-level security or a mandatory scoped repository plus a test.
  - **Seeding.** Seed kernel data through a kernel call, `POST /copies/seed`.
  - **Stripe.** Create per-copy Stripe objects lazily, or keep seeded flows create-only.
  - **Proofs.** Cache proof results by policy hash.

**I17. Pinning a third-party hosted MCP server lets the demo disable itself.**
- **Where:** Spec: Prototype scope ("one real MCP server (Stripe in test mode)"). Plan: Review Focus #5.
- **What's wrong:** if Stripe edits a tool description during the demo window, every copy correctly disables that tool. Core flows must not depend on it.
- **Fix:**
  - **Payments.** Native `payment_link` calls the Stripe SDK directly from the kernel.
  - **Scope.** Stripe MCP powers only the connected-tool demos (for example, a refund going through its profile).
  - **Drift UX.** Drift shows a designed owner card.
  - **Monitoring.** A daily pin-health check alerts you.

**I18. Schedule and cut line.**
- **Where:** Plan: Schedule; Global Constraints (priority order). Spec: Build priority; Minimum cut.
- **What's wrong:**
  - **Saturday is overloaded.** It holds the whole web app: 7 nav areas, Settings with sub-navigation, the public page, the setup flow and first-visit arrival.
  - **Sunday is overloaded.** It holds evals, the agent visitor, the deploy and the project docs.
  - **Serial lanes.** Running lanes one after another wastes the subagent model.
- **Fix:**
  - **Parallel lanes from Friday:**
    - kernel;
    - API loop;
    - web, built against fixtures generated from contracts v2 and reusing the design canvas HTML and CSS;
    - infrastructure.
  - **Protect a docs block.**
  - **Use the explicit cut line below.**

### Minor

- **M1. Table count and Procrastinate (plan › Task 2).** It says 13 tables but lists 12. Procrastinate's schema needs its own migration step alongside Alembic.
- **M2. Reviewer "block" (spec › Safety architecture #4 vs plan › Global Constraints).** "Block" is undefined; see I1.
- **M3. Untyped violations (plan › `ReplyVerdict.violations: list[dict]`).** Make it typed: `kind`, `span`, `fact_ids`, `rule_id`.
- **M4. Engine caching (plan › Rust surface).** Cache the parsed `PolicySet` per (desk, version). `decide` should return evaluation errors, and the kernel should refuse when a forbid errors.
- **M5. AI-written owner text (spec › Conversation detail; Landing; Languages).** One-line summaries, briefings and owner translations are model text derived from visitor input. Label them as AI-written and keep them out of approval cards.
- **M6. Agent auth (spec › Visitor experience › Identity, A2A).** Pick one agent auth method (an Ed25519 JWS per request, or HTTP Message Signatures) plus a key registry. A2A responses go through `deliver()`.
- **M7. Setup safety check (spec › Product › Creation, "Claude Desk attacks itself").** Live multi-turn attacks won't fit in 2 minutes. Run about 8 deterministic probes against `/decide` and `/check_reply`, plus the proofs (<3 s).
- **M8. Residual risk (spec › Residual risk).** Add lines for "compromised API process" and "paraphrased leakage within what the person is entitled to".
- **M9. Abuse budget (spec › Spend).** "No cap" stays locked, but still set a per-copy token budget as abuse control.
- **M10. Decision binding (plan › Kernel API).** `/execute` must check `decision.session_id == session_id`. Allow decisions should expire after about 60 seconds.

---

## Missing work (no plan owns it)

| Item | Suggested owner |
|---|---|
| RuleCard compiler, plus rule edits by chat outside setup ("Claude shows the exact change, owner confirms") | Plan 01 (compiler), Plan 02 (chat) |
| Setup safety-check runner (deterministic probes) | Plan 02, using kernel calls |
| Native tool data and logic: price list and quotes, built-in calendar, document store and release links, lead capture, handoff and callback, identity check tool | Plan 01 (`gateway/native`) |
| Owner translation (es→en); notification defaults and plain-word tweaks; reports (bookings and revenue, handled vs. needed the owner); returning-visitor memory; conversation summaries; storage for blocked attempts and triage | Plan 02 |
| "Connect your own Claude" endpoint (A2A and/or MCP) and its instructions page | Plans 02 and 03 |
| Demo inbox serving as both the visitors' phones and the owner's phone, including ledger checkpoints | Plans 02 and 03 |
| Threat model and ADR: what the kernel split protects, and why our own loop | Plan 05 |
| Observability: structured logs keyed by session and decision, a CloudWatch dashboard | Plan 05 |
| Copy and Desk lifecycle (delete Desk; "kept until deleted") | Plan 02 |

---

## Feasibility within the build window

| Piece | Risk | De-risk (when) | Fallback |
|---|---|---|---|
| Two-container ECS task with per-container secrets | High (Express Mode sidecar support UNVERIFIED) | Thursday-night skeleton | CDK `ApplicationLoadBalancedFargateService` with two containers |
| SSE through CloudFront and the ALB, plus cookies | Medium | Skeleton: stream for 5 minutes to Safari over the real URL | API on a subdomain of the same registrable domain |
| PyO3/maturin wheel and cvc5 in the container | Medium | Skeleton: `version()` plus one SymCC `implies` inside Fargate | Proofs in CI plus bounded checks |
| SymCC maturity (0.x API, experimental CLI) | Medium | Thursday: one invariant with a counterexample, called from Python | Same as above |
| Opus 5.5 held-tool protocol and latency | Medium | Thursday spike: held result, `send_reply`, `end_turn` text; measure p50/p95 for model finish → reveal and for the full turn | If p95 is unacceptable, the project owner decides on a faster chat model using the measurements |
| Procrastinate resume | Low, once tool calls are never parked | — | FastAPI BackgroundTasks plus a startup sweeper |
| Stripe MCP (auth, generic tools, drift) | Medium | Friday morning: connect, `tools/list`, snapshot | Profile demo on a local MCP server; payments via the SDK |

**Cut line.** Work down the list and stop wherever time runs out.

1. **Must (deployed by Saturday night):**
   - **Kernel tools:** decide and execute for native tools (server-priced quote, booking, release by link, payment link via the SDK).
   - **Verification:** in the kernel, with random codes delivered to the Demo inbox.
   - **Reply check:** placeholders plus an en/es lexicon, with signed verdicts.
   - **Ledger.**
   - **Approvals:** with the four answers.
   - **Public chat:** check-then-reveal plus margin receipts.
   - **Owner app:** Today, Conversations, Rules (cards), Safety.
   - **Demo copies:** with seed data.
2. **Should (Sunday):**
   - SymCC proofs at activation, with the fallback above.
   - The setup chat: 6 questions → cards → probes → preview → link and QR.
   - Take-over and whisper; Spanish.
   - The reviewer with two-point evaluation.
   - The tier-1 gate plus about 20 tier-2 scenarios; the latency report.
3. **Could (Monday morning):**
   - Stripe MCP connect, profiling and drift.
   - The agent visitor: Agent Card plus send-an-agent with a Demo-wallet mandate.
   - Depth in People, Share and Settings.
   - Scenarios grown to 50.
4. **Mock:** connectors; channels; city office; team Desk; phone-native screens; "connect your own Claude" as instructions only.

---

## Top 5 recommended changes to the master plan

1. **Make the kernel own identity and authority.**
   - `/decide`, `/execute` and `/check_reply` take `session_id`, never a `Principal`.
   - Verification moves into the kernel, with random per-challenge codes delivered to the Demo inbox. This drops the fixed `424242`.
   - Use a separate Postgres role and schema for kernel tables, and per-container ECS secrets.
   - The kernel signs reply verdicts with Ed25519, and the public page verifies them before rendering.
   - Write the resulting threat-model claim into the README.
2. **Add contracts v2 as Task 0, before the subsystem plans are written.**
   - Session mode and take-over; an SSE event union; `RuleCard`; `Mandate`; approval answers with scope.
   - Typed `Fact.claims` and owner statements; knowledge labels; tables for native tools.
   - A `Principal` that can express an owner, and an agent acting for a verified human.
   - Policy annotations; a per-desk schema; a fix for the 13-vs-12 table count.
3. **Have Claude draft RuleCards and code compile them to Cedar.**
   - Re-aim the proofs at: never-errors (forbid errors fail open), auto ⊆ cards (counterexamples in owner language), and review monotonicity.
   - Lint `context.review` to `&&` conjuncts in auto-permits, use basis-point `Long`s, and replace partial evaluation with two-point evaluation.
4. **Fix money and commitment semantics at the tool layer.**
   - Server-priced quotes and payment links, with a discount floor.
   - No recipients chosen by Claude.
   - Split `move_money` into `charge` and `pay_out`, so a signed limit never authorizes a refund. Signed limits are verified by the kernel and tracked cumulatively.
   - Replies use placeholders and fail closed on stray numbers or promise words (en/es).
   - Held tool calls return immediately and are never parked.
5. **Re-sequence the schedule.**
   - Thursday night: a walking-skeleton deploy (two arm64 containers, PyO3 + cvc5 + one SymCC proof, SSE to Safari via same-origin CloudFront, the cookie).
   - Friday morning: the Opus held-tool and latency spike, and Stripe `tools/list`.
   - Run parallel lanes, keep a protected docs block, and use the explicit cut line above.
