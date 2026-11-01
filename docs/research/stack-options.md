# Claude Desk: stack options (prepared, not decided)

Research date: 2026-10-28.

Background research for the Claude Desk design; claims are cited, and anything not confirmed from a source is marked UNVERIFIED.

Scope: a hosted prototype, built within a short build window with agentic coding. It covers three options, a shared core, risks, costs, a recommendation and the decisions left to the project owner.
Inputs: the Claude Desk design decisions and design system as they stood then, `safety-anthropic.md`, `safety-landscape.md` and `safety-patterns.md`, plus the primary docs listed under Sources (fetched today).
**UNVERIFIED** means I could not confirm it from a primary source today. Nothing was signed up for, and no product code was written.

---

## 0. Platform facts that shape every option (checked today)

| Fact | Value | Why it matters |
|---|---|---|
| Vercel Functions max duration (Fluid compute) | Hobby 300 s (default and maximum). Pro and Enterprise: 300 s default, 800 s maximum, 1800 s beta | A visitor turn plus the reviewer and reply check fits easily. A turn that *waits for the owner* does not, so held approvals can't be "a function that waits". |
| Vercel WebSockets | Public beta since 2026-06-22. Same 300/800 s caps. A connection is pinned to one instance, so cross-instance fan-out needs Redis or a similar external store | Possible, but it adds Redis. A hosted pub/sub service is simpler for "the owner clicks Allow and the visitor sees it live". |
| Vercel Workflows (Workflow SDK `workflow` 5.2.3) | `'use workflow'` / `'use step'`, `createHook` + `resumeHook(token, payload)`, no limit on sleep or run duration. Hobby includes 50k events/month; on-demand $0.02 per 1k events | A durable "wait for Mike" primitive on Vercel. It's optional: the park-and-resume design below doesn't need it. |
| Vercel cron | Hobby: once per day, ±59 min. Pro: once per minute | An hourly demo reset needs Pro, or a manual "Reset demo" button. |
| Claude Agent SDK runtime (`@anthropic-ai/claude-agent-sdk` 0.3.312, published 2026-10-27) | Spawns a `claude` CLI **subprocess** per session, with local disk for transcripts. Needs Node 18.14+. Docs suggest "1 GiB RAM, 5 GiB disk, and 1 CPU per agent" as a starting point. Durable cross-host resume needs a `SessionStore`. On Vercel, Claude Code runs only inside a Vercel Sandbox via `durable-harness/claude-code`, which is **experimental** | It doesn't fit plain serverless. Realistically it needs a container worker (Fly or Railway) or an experimental Vercel Sandbox path. |
| Agent SDK `PreToolUse` → `"defer"` | Ends the turn with `stop_reason: "tool_deferred"`. Resume later with no prompt and the hook decides. **Only works when Claude makes a single tool call in the turn**: with parallel calls, defer "is ignored with a warning and the tool proceeds through the normal permission flow". If the MCP server isn't connected on resume, you get `tool_deferred_unavailable` | A real gotcha for held approvals. The safer pattern is deny-with-"held" plus your own resume (see Option B). |
| Agent SDK output gate | No hook blocks final assistant text (`MessageDisplay` only changes what's displayed) | The reply checkpoint must be a `send_reply` tool, or app-side delivery, in every option. |
| Managed Agents (beta, `managed-agents-2026-04-01`) | Custom tools leave the session idle (`requires_action`) until you send `user.custom_tool_result`, with no stated timeout. MCP toolsets default to `always_ask`, answered with `user.tool_confirmation`. **While `requires_action`, a `user.message` returns 400** (only settle events are accepted). Text you relay in `user.message` "counts as your intent". Runtime costs $0.08/session-hour plus tokens. Not ZDR-eligible | Held approvals are native here, but the visitor can't keep chatting while an approval is pending, and stranger text becomes "operator intent". |
| Messages API with Claude Opus 5.5 (`claude-opus-5-5`, $4/$20 per MTok, cache reads $0.20) and Haiku 5.5 (`claude-haiku-5-5`, $0.10/$0.50) | On Opus 5.5, thinking can't be disabled (use `effort: "low"` for chat; the default is `medium`). **Forced `tool_choice` any/tool returns 400.** Preserved thinking needs **append-only history**. Mid-conversation `role: "system"` messages are the operator channel and must follow a user message | You can't *force* Claude to call `send_reply`, so the app must treat any plain text as a reply candidate and check it too. An owner's whisper fits neatly as a mid-conversation system message. Parked tool calls are append-only, so they're safe. |
| MCP connector in the Messages API (`mcp_servers` + `mcp_toolset`) | Anthropic calls the MCP server **server-side** inside the request | It can't be gated per call by your Cedar engine. For a gated MCP connection, **the app must be the MCP client** (`@modelcontextprotocol/sdk` 1.32.2). |
| Stripe MCP (`https://mcp.stripe.com`) | OAuth, or an **agent API key** as bearer. From December 2026 it rejects restricted keys that lack the Agent tag. Exposes generic `stripe_api_read` and `stripe_api_write` (any POST, including Create refund and Create payment link) | The "Refunds → ask me" profile has to be **argument-level** (classify by the `method` argument), not tool-level. That makes a great demo of tool profiles, and it's also a sharp edge. |
| Cedar | `@cedar-policy/cedar-wasm` 4.14.0 (2026-10-19). Apache-2.0, CNCF Sandbox. `forbid` always overrides `permit` | The always-on baseline becomes `forbid` policies that owner `permit`s can't relax. Next.js WASM bundling details are UNVERIFIED (the npm page returned 403). |
| A2A | Spec 1.0.0. Card at `/.well-known/agent-card.json`. Bindings: JSON-RPC, gRPC, HTTP+JSON. `SendStreamingMessage` (SSE), `SubscribeToTask`, `TASK_STATE_AUTH_REQUIRED`, `TASK_STATE_INPUT_REQUIRED`, push notifications. `@a2a-js/sdk` 1.3.0 | Fits a per-Desk card and endpoint. A held action maps to an interrupted task state plus `SubscribeToTask` or push. |
| Supabase Realtime | Free: 200 concurrent connections, 100 msgs/s. Pro: 500 and 500. Free projects **pause after ~7 days inactive** (secondary sources) | A pause would break a demo link that sits idle for weeks. Pay for Pro while the demo must stay up, or keep the project warm (UNVERIFIED whether a cron ping counts as activity). |
| Neon free tier | 100 CU-hours/project/month, scales to zero after 5 min, 0.5 GB | A fine alternative database, but it has no realtime, so it needs Ably, Pusher or similar. |
| Resend free tier | 3,000 emails/month, 100/day | Enough for email OTP and magic links during a demo period. |
| Twilio SMS | Test credentials only simulate (no real delivery). I found no doc saying Verify accepts test credentials (UNVERIFIED). US SMS to arbitrary numbers usually needs A2P 10DLC registration (UNVERIFIED for timeline) | Plan on **real email OTP plus SMS in clearly labelled test mode**, not real SMS during the build. |
| Fly.io | No free tier for new organizations. shared-cpu-1x 1 GB is $6.70/month; shared-cpu-2x 2 GB is $13.39/month; extra RAM $6/GB | Prices the Agent SDK worker. |
| Railway | Hobby $5/month including $5 usage. RAM $10/GB-month, vCPU $20/month | An alternative worker host, more expensive per GB. |

---

## 1. Shared core (identical in all options; the options differ only in where the agent loop runs)

**Web app.** Next.js 16 (App Router, TypeScript) on Vercel. One codebase holds the owner app (dark v2 tokens), the public Desk page at `/d/{deskSlug}`, the A2A endpoints and the webhooks. Data lives in Postgres: businesses, desks, charter, rules (Cedar text plus plain-language card), tool_profiles (pinned definition hash), customers and records, conversations, messages (raw Claude content blocks, append-only), approvals, ledger (every decision with the matched rule), otp_challenges, payments and documents.

**Safety pipeline.** This is the same code in every option. Only the hook point changes.
1. **Edge.** A passcode cookie gates the whole app (signed, httpOnly). Per-visitor, per-IP and per-Desk rate limits use Upstash Ratelimit or a Postgres token bucket. A per-conversation token budget and an Anthropic workspace spend limit sit in the Console.
2. **Identity tier → tool list.** The tier is public, verified or agent. It comes only from the app's own session record, never from the model. Tools that are always denied for the tier are not offered at all.
3. **Action checkpoint (code, Cedar).** It sees the typed call, the tool profile and the tier. The tool profile (effect class: read, change, money, message_out or private_data; reversible or not; argument roles for amount, recipient, time and record owner) supplies typed context. Three outcomes come from two Cedar actions: if `Action::"execute"` is allowed, do it. Otherwise, if `Action::"request_owner"` is allowed, hold. Otherwise refuse.
   - The baseline is `forbid` policies: no private data unless verified and entitled, no money without a rule or a signed limit, and codes only to the contact on record.
   - Owner rules are `permit` policies compiled from the plain-language cards. Each rule is validated against the schema built from the tool profiles, and the diff is shown back to the owner.
   - A changed MCP tool definition (hash mismatch) disables the tool until it's re-reviewed. Errors fail closed.
4. **Auto reviewer.** This is a separate Messages API call (Haiku 5.5 by default, Opus 5.5 for money). It returns a structured `{verdict: allow|hold|block, reason}`.
   - Its inputs are the charter, the matched rules, the typed proposed action or reply claims, and the verified facts (tier, ledger entries). **The visitor's raw text and the agent's prose are never passed in.** That is enforced by the function signature, not by a prompt.
   - It can only *tighten*: an allow from Cedar can become hold or block, never the reverse.
   - It runs on "unusual" calls (no exact rule match, first-time patterns, high value) and on every reply that carries a commitment.
5. **Reply checkpoint.** Visitor-facing text goes only through a `send_reply(text, claims[])` tool. Because forced tool choice isn't allowed on Opus 5.5, any plain final text is routed through the same check before it's shown.
   - Deterministic step: every money amount, percentage, date or time, and promise phrase in `text` must match a declared claim. Each claim must reference a ledger entry (a quote tool result, a booked slot, a rule). Anything else is blocked and rewritten to "Let me check with Mike."
   - The reviewer then gets the claims only.
6. **Owner loop.** An approvals row moves through pending, allowed, denied or expired. The four answers work like this: "Allow only for this person" and "Deny always" write Cedar rules, and every decision is written to the ledger.

**Streaming vs the reply checkpoint (a real tension).** If every reply is checked before the visitor sees it, raw token streaming to the visitor is impossible. Two shapes work, and Decision 3 asks the project owner to pick one:
- **Progressive release.** Stream `send_reply` input as it arrives (`eager_input_streaming`). Release text sentence by sentence. Any sentence containing a commitment token is held until the claim check passes, which takes milliseconds of code. The visitor sees streaming, and only risky sentences pause.
- **Check, then reveal.** Show a "Claude is writing" shimmer, check the full reply, then reveal it with a fast type-in. It's simpler and slightly slower.

Either way, the owner's live view can stream raw output, because the owner is trusted.

**Held approvals ("park and resume"), the recommended pattern, which works on plain serverless.** When Cedar says hold, the loop **stops without sending a tool_result**. It stores the pending `tool_use` block plus an approvals row and tells the visitor via an app-rendered card (not Claude): "Waiting for Mike. You can stay or leave; we'll text or email you."
- When the owner answers, a server action records the decision, executes the tool deterministically if allowed, appends the real `tool_result`, and runs one more model turn whose output streams to the visitor's channel. The history stays append-only (preserved-thinking safe), and **no process waits**.
- If the visitor types while the approval is pending, the app closes the parked call with an interim "pending owner" result so the conversation can continue. When the decision lands, it's delivered as a mid-conversation system message after the next visitor message, or as an app-rendered outcome card. This edge case needs a short design pass (UNVERIFIED that the API accepts every placement; test on day 1).

**Realtime.** The recommended path is Supabase Postgres plus Supabase Realtime: a per-conversation channel for visitor and owner, and per-Desk channels for the queue and presence.
- The visitor's own turn can still be a direct streamed response. Async events (owner decisions, takeover, held resumes, payment confirmations from the Stripe webhook) are published to the channel.
- Simplest uniform design: the POST returns 202, the turn runs in `after()`/`waitUntil` (within the 300 s cap), and every chunk is broadcast.

**Verification.** OTP or magic link goes **only to the contact on record** (email via Resend; SMS via Twilio *test mode* with the code shown in a labelled "test inbox" panel). Codes are hashed, expire in 10 minutes, are limited to 5 attempts, and raise the session's tier in Postgres.

**Payments.** Stripe test mode. The app creates server-priced Payment Links or Checkout Sessions. The `checkout.session.completed` webhook updates the ledger and drives the "check draws once" moment. Card data never reaches the model.

**MCP (one real server).** The candidates are Stripe's hosted MCP with an agent API key (realistic, but exposes generic `stripe_api_write`) or a small self-hosted MCP server the app owns (e.g. "Turner calendar", reliable and resettable). Either way the app is the MCP client, lists tools at connect time, drafts profiles and pins hashes (Decision 4).

**A2A.**
- Each Desk serves a card at `/d/{slug}/.well-known/agent-card.json`. A root card at `/.well-known/agent-card.json` lists the Desks, but spec support for per-path cards is UNVERIFIED, so this should be checked.
- The JSON-RPC endpoint (via `@a2a-js/sdk`) maps a visiting agent to the "agent" tier.
- Requests for private data or money return `TASK_STATE_AUTH_REQUIRED`, completed by a *human* OTP. Held actions return `TASK_STATE_INPUT_REQUIRED` (or stay working) and resolve via `SubscribeToTask` or push. SSE streams are capped at 300/800 s, so clients reconnect.
- The built-in "send an agent" panel is a Haiku-driven A2A client calling the real endpoint.
- "Connect your own Claude" would mean also exposing the Desk as a remote MCP server for claude.ai custom connectors. Whether authless connectors are allowed is UNVERIFIED (Decision 4).

**Multi-tenant and demo.** Tenancy runs business → desks. Turner Plumbing is seeded by an idempotent script. Reset options are a per-user copy (clone Turner on passcode entry) or one shared demo that resets on a button, nightly on Hobby or hourly on Pro (Decision 5).

---

## Option A: Next.js on Vercel, with your own Claude API tool-use loop (Messages API)

**What runs where**
- Vercel runs everything: the owner app, the public Desk page, `/api/turn` (the agent loop as about 200 lines of TypeScript on `@anthropic-ai/sdk` 1.3.0, a manual loop rather than the tool runner, because the loop must be able to *park* a call), the reviewer call, the Cedar engine (wasm, in-process), the MCP client, A2A routes, and Stripe and Resend webhooks.
- Supabase provides Postgres, Realtime and Storage (owner documents). Upstash handles rate limits (optional). Stripe test mode, Resend and Twilio test mode cover the rest.

**How each safety layer is implemented**
- Tool gate: a plain `gate(call, session)` function called by the loop before *every* tool execution, native or MCP. The tool list is filtered per tier.
- Cedar: cedar-wasm in the Node function, with policies per Desk loaded from Postgres and cached.
- Reviewer: `messages.create` on Haiku 5.5 with structured output, taking a typed input object with no visitor-text field.
- Reply checkpoint: the `send_reply` tool plus a plain-text fallback check, with progressive release.
- Owner whisper: a mid-conversation system message. Takeover: owner messages are appended as app-authored turns and the model is paused for that conversation.

**How held approvals resume**
- Park and resume as described in §0 and §1. No process waits and no workflow engine is needed.
- A Vercel Workflows hook (`createHook`/`resumeHook`) is an optional upgrade if turns ever outgrow 300/800 s.

**Risks**
- You own the loop's edge cases: parallel tool calls with mixed outcomes (return all `tool_result`s in one message), `refusal` stop reasons, the preserved-thinking append-only rule, and prompt caching.
- Cedar wasm bundling in Next.js may need `serverExternalPackages` (UNVERIFIED).
- The Supabase free tier pauses (pay for Pro or keep it warm).
- It doesn't run on an Anthropic agent harness. Mitigation: document how the loop mirrors the Agent SDK's evaluation order (hooks, deny, ask, mode, allow) and the auto-mode reviewer design.

**Feasibility within a short build window: GREEN.** There's one deployable and no containers. The risk sits in product work (rule cards, the reply checkpoint, seeded demo polish), not infrastructure. Rough plan:
- Day 1: shell, database, auth and passcode.
- Day 2: loop, Cedar and tools.
- Day 3: approvals, realtime and the reply checkpoint.
- Day 4: OTP, Stripe and MCP.
- Day 5: A2A and the agent panel.
- Day 6: seed and reset, then the red-team suite.
- Day 7: polish and deploy.

**Cost ballpark**
- Infrastructure: $0–45/month. That's Vercel Hobby $0 or Pro $20/seat; Supabase Free $0 or Pro about $25 (UNVERIFIED price); free tiers for Upstash, Resend and Stripe test; Twilio trial credit.
- Model: about $0.30–0.50 per 8-turn visitor conversation on Opus 5.5 at low effort with caching, plus about $0.001 for Haiku reviewer calls (UNVERIFIED estimate: about 16 calls × (2k uncached input + 10k cached + 400 output)).
- Build-period testing and red-team evals: about $100–500. Demo period after the build: about $20–100 (UNVERIFIED).

---

## Option B: Next.js on Vercel (UI) plus a Claude Agent SDK worker on Fly.io (or Railway)

**What runs where**
- Vercel runs the UI, public page, webhooks, A2A front door and OTP.
- A Fly.io Machine (Docker, Node, `@anthropic-ai/claude-agent-sdk`) runs one `query()` subprocess per active conversation. Built-in tools are disabled. Native tools come from an in-process SDK MCP server, and Stripe or the demo MCP server is attached as `mcpServers`.
- Transcripts persist via a `SessionStore` adapter to Postgres, which allows hybrid resume.
- Supabase handles the database and realtime. The worker publishes stream chunks to Realtime, or Vercel proxies an SSE or WebSocket stream from the worker.

**How each safety layer is implemented**
- Tool gate: a `PreToolUse` hook with no matcher. It covers native and `mcp__*` tools, runs in every permission mode, and returns allow, deny or `updatedInput` (clamp to list price or entitled document ID).
- Mode: run in `dontAsk`, so anything not explicitly allowed is denied.
- Do **not** use SDK `permissionMode: "auto"`. Its classifier treats user-turn text as intent, and here that text belongs to a stranger.
- Cedar runs inside the hook. The reviewer is a separate Messages API call inside the hook.
- Reply checkpoint: `send_reply` as a native tool, checked in its `PreToolUse`. The app delivers only `send_reply` output, since there is no hook on final text. `PostToolUse` `updatedToolOutput` redacts tool results above the visitor's tier before Claude sees them.

**How held approvals resume**
- Option (a), `defer`: works only when the turn has a single tool call, so parallel calls must be prevented through the prompt, and the guarantee isn't hard. Then `resume` with no prompt once the owner answers. The hook is re-run and returns allow or deny.
- Option (b), recommended: the hook returns deny with "held for owner, approval #123". The model tells the visitor, and on the owner's answer the worker starts a new turn (`resume` + a prompt carrying the outcome as an app event). This is the same park-and-resume idea, implemented on SDK sessions.
- `canUseTool` can stay pending indefinitely, but it pins a live subprocess and is lost on restart, so don't rely on it.

**Risks**
- Two deployables plus a container. The CLI binary has to match the container's architecture and libc.
- About 1 GiB RAM per concurrent session (docs starting point), so 4–8 concurrent sessions need 4–8 GB.
- Subprocess cold start adds latency to the first turn (UNVERIFIED magnitude).
- The SDK moves fast: 0.3.x patch releases almost daily, so pin a version.
- The Claude Code harness is built for coding agents. You'd turn off most of it (settingSources `[]`, a custom system prompt, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, per-tenant `CLAUDE_CONFIG_DIR`/`cwd`).
- The `defer` single-call limit, if you use it.
- The upside: it is built on the same permission engine as Claude Code.

**Feasibility within a short build window: AMBER.** It's doable, but expect to spend about 1.5 days on worker infrastructure, the session store and streaming plumbing before product work starts. It's the most likely of the three to cause "slow or flaky", which is a stated anti-goal.

**Cost ballpark**
- Infrastructure: Option A's $0–45/month plus a Fly worker. That's about $13–30/month for 2–4 GB always-on (shared-cpu-2x 2 GB is $13.39, plus $6/GB extra), or Railway at about $5 plus $10/GB-month. Call it **$15–75/month**.
- Model cost: about the same as A, plus some Claude Code system-prompt overhead unless it's fully replaced (UNVERIFIED).

---

## Option C: Next.js on Vercel plus Claude Managed Agents (beta) as the agent runtime

**What runs where**
- Anthropic hosts the loop. There's one Agent config per Desk version, created with `ant apply`, not in the request path.
- Agent toolset: disabled, since a Desk needs no bash or files.
- Native actions and `send_reply` are **custom tools**, so the app executes and gates them. The real MCP server is an `mcp_toolset` with `always_ask`, and its credentials live in a vault.
- One Session per visitor conversation.
- Vercel routes send `user.message` and consume the session's SSE events; Managed Agents webhooks (configured in the Console) can trigger handling of `requires_action`. Supabase handles the database and realtime fan-out to visitor and owner.

**How each safety layer is implemented**
- Tool gate:
  - On `agent.custom_tool_use`, the app runs Cedar and the reviewer, then executes the tool and sends `user.custom_tool_result`, or holds, or sends a refusal result.
  - On `agent.mcp_tool_use` with `evaluated_permission: "ask"`, the app runs Cedar and sends a `user.tool_confirmation` of allow, or deny with `deny_message`.
  - Never use `auto` for the visitor runtime. Anthropic's docs warn that relayed end-user text "counts as your intent".
- Reviewer and reply checkpoint: the same code as A, running in the event handler.
- Session budgets cap model spend per conversation, which is a nice built-in.

**How held approvals resume (native)**
- Don't answer the custom tool or tool confirmation. The session sits idle in `requires_action` until the owner decides, then the app sends the result and the session continues.
- **Catch:** while it waits, the visitor's new messages return 400, so the app must queue them or close the call with an interim "pending" result.

**Risks**
- Beta on every model.
- Not ZDR-eligible. Transcripts persist at Anthropic until deleted (fine for a demo, but worth saying).
- Streaming granularity for custom-tool input (`send_reply` text) through `event_delta` previews is UNVERIFIED, which could force check-then-reveal.
- Every turn adds an extra round trip through custom-tool events.
- Webhook coverage for each event type is UNVERIFIED.
- Tool-definition pinning is harder because Anthropic fetches the MCP tool list (UNVERIFIED whether the app can see definitions to hash).
- Holds block the visitor.
- It's the least time-tested path.

**Feasibility within a short build window: AMBER-RED** as the sole runtime. A safer variant: use Managed Agents only for the **owner-side setup interview** (reading the owner's website with `web_fetch`, drafting charter and profiles), which is a long-running, owner-trusted task, and keep the visitor runtime on Option A's loop.

**Cost ballpark**
- Infrastructure: about the same as A ($0–45/month), plus session runtime at $0.08/session-hour, which is negligible (a 10-minute conversation is at most about $0.01).
- Whether idle time is billed is UNVERIFIED. The docs say "session running time".
- Model cost: the same as A.

---

## Comparison

| | A: own loop on Vercel | B: Agent SDK worker | C: Managed Agents |
|---|---|---|---|
| Deployables | 1 (Vercel) | 2 (Vercel + Fly/Railway container) | 1 (Vercel) plus an Anthropic-hosted runtime |
| Fit with serverless limits | Turns under 300 s; nothing waits | The worker is long-lived; Vercel is UI only | Nothing of yours waits; the session idles at Anthropic |
| Action checkpoint hook | Your `gate()` before every call | `PreToolUse` (all tools, all modes) | Custom tool handler + `always_ask` confirmations |
| Held approval | Park the `tool_use` in the DB, resume on decision | Deny-as-held + resume (or `defer`, single-call only) | Native `requires_action`; visitor messages blocked meanwhile |
| Reply checkpoint and streaming | Full control (progressive release) | `send_reply` tool; streaming via worker relay | `send_reply` custom tool; preview streaming UNVERIFIED |
| Real MCP gating | App is the MCP client, so per-call Cedar | Hooks on `mcp__*` | `always_ask` → app confirms |
| Built on Anthropic's agent runtime | Medium (mirrors SDK and auto-mode design) | High | High (but beta) |
| Infra $/month | $0–45 | $15–75 | $0–45 + about $0 runtime |
| Short-build-window verdict | Green | Amber | Amber-red (green for the owner-setup sidecar) |

---

## Recommendation (for the project owner to accept or override)

**Option A**: Next.js 16 on Vercel, Supabase (Postgres, Realtime, Storage), your own Messages API loop with Opus 5.5 (effort low or medium) plus a Haiku 5.5 reviewer, cedar-wasm in-process, the app as MCP client, park-and-resume approvals, Resend email OTP with Twilio in test mode, and Stripe test mode. Optionally run the owner setup interview on Managed Agents.

Why A:
- Every Desk tool is a custom business tool, so the Agent SDK's main asset (Claude Code's built-in file and bash harness) is unused here, and its subprocess model fights serverless.
- The whole loop, with its visible `gate()` → Cedar → reviewer → `send_reply` check pipeline, can be read in one file.
- Park-and-resume needs no waiting process, so the hosting is simple and the "owner answers, visitor sees it live" moment is reliable.

Write a short ADR explaining why A rather than B or C, citing the `defer` single-call limit, the subprocess resource model, and the Managed Agents intent warning.

---

## Decisions for the project owner

1. **Agent runtime:** own loop (A), Agent SDK worker (B), or Managed Agents (C). Also decide whether to use Managed Agents just for the owner setup interview. This trades control, speed and robustness against building on Anthropic's harness.
2. **Hosting tier and providers:** Vercel Hobby ($0, 300 s, daily cron, non-commercial use) or Pro ($20/seat, 800 s, per-minute cron). Supabase (database plus realtime, but the free tier pauses after about 7 days) or Neon plus Ably or Pusher. Whether to pay for about a month of Pro tiers so the demo link never sleeps.
3. **Streaming vs the reply checkpoint UX:** progressive release (streams, and only risky sentences pause) or check-then-reveal (simpler, slightly slower). This also settles whether visitors can keep chatting while an approval is pending, or see a "Waiting for Mike" state.
4. **The one real MCP server and "connect your own Claude":**
   - Stripe hosted MCP (real third party; generic `stripe_api_write` needs argument-level profiles; needs an agent API key before the December cutoff) or a self-hosted demo MCP server (reliable, resettable).
   - Also whether to expose each Desk as a remote MCP server so people can add it to claude.ai (an extra 0.5–1 day).
5. **Demo isolation and verification channels:**
   - Per-user copies of Turner Plumbing or one shared demo with a reset.
   - Real email OTP plus SMS in labelled test mode (recommended), or chasing real SMS (needs Twilio number registration with an uncertain timeline).
   - The project owner also has to create the accounts (Vercel, Supabase, Anthropic Console with a spend limit, Stripe sandbox and agent key, Resend domain, Twilio, optionally Upstash and Fly). I created none.

---

## Sources (accessed 2026-10-28)
- Vercel Functions limits: https://vercel.com/docs/functions/limitations
- Vercel WebSockets KB: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Vercel Workflows and pricing: https://vercel.com/docs/workflows, https://vercel.com/docs/workflows/pricing
- Vercel durable agent harnesses: https://vercel.com/docs/agent-harnesses
- Vercel durable approval pattern: https://vercel.com/kb/guide/durable-ai-agents
- Vercel cron limits: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Agent SDK hosting: https://code.claude.com/docs/en/agent-sdk/hosting
- Agent SDK hooks: https://code.claude.com/docs/en/agent-sdk/hooks
- Hooks reference ("Defer a tool call for later"): https://code.claude.com/docs/en/hooks.md
- Managed Agents overview: https://platform.claude.com/docs/en/managed-agents/overview
- Managed Agents permission policies, events, custom tools and pricing: Anthropic API docs (platform.claude.com/docs/en/managed-agents/*), accessed 2026-10-06
- Models and pricing (Opus 5.5, Haiku 5.5), MCP connector, forced tool choice, preserved thinking, mid-conversation system messages: Anthropic API docs (platform.claude.com), accessed 2026-10-06
- A2A spec 1.0.0: https://a2a-protocol.org/latest/specification/
- Stripe MCP: https://docs.stripe.com/mcp
- Supabase Realtime limits: https://supabase.com/docs/guides/realtime/limits
- Neon free plan: https://neon.com/faqs/free-plan-limits-and-quotas
- Supabase inactivity pause (secondary): https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/
- Resend pricing: https://resend.com/pricing
- Fly.io pricing: https://docs.fly.io/about/pricing
- Railway plans: https://docs.railway.com/reference/pricing/plans
- Twilio test credentials: https://www.twilio.com/docs/iam/test-credentials
- npm registry versions (`@cedar-policy/cedar-wasm` 4.14.0, `@anthropic-ai/claude-agent-sdk` 0.3.312, `@anthropic-ai/sdk` 1.3.0, `@modelcontextprotocol/sdk` 1.32.2, `@a2a-js/sdk` 1.3.0, `workflow` 5.2.3, `next` 16.4.3)
- Related research: `safety-anthropic.md`, `safety-landscape.md`, `safety-patterns.md` (same folder)
