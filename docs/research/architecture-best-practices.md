# Claude Desk: architecture best practices

Research date: 2026-10-29

Background research for the Claude Desk design; claims are cited, and anything not confirmed from a source is marked UNVERIFIED.

Scope: a public, always-on Claude agent for small businesses. Strangers chat with it. It calls native tools and the owner's MCP servers. Safety checkpoints run in code on every tool call and every reply. Some actions wait minutes to hours for owner approval. Replies stream. Two front ends (owner app, public chat). Constraints: one engineer, about one week, TypeScript, AWS credits, Anthropic API.

Unless marked as vendor content or UNVERIFIED, the sources below are primary: AWS docs and announcements, Anthropic docs, and ai-sdk.dev.

---

## 1. Backend shape: separate agent/safety-core service or a full-stack framework

**Findings**
- The current guidance agrees on one thing: an agent run does not belong to an HTTP request. A run outlives the request (tab closed, approval waiting hours) and has to survive a deploy or restart. Even the Vercel AI SDK docs say resumable streams require you to persist messages and active streams yourself (Redis via `resumable-stream`, plus `after()` in Next.js). They also say a client disconnect should not cancel generation, and stopping a run should go through its own endpoint. Source: ai-sdk.dev "Chatbot Resume Streams" (v5/v7 docs, current 2026).
- Practitioners name serverless or edge request handlers, which have short timeouts and bill by duration while waiting on the model, as the main reason teams move agents to an always-on backend. Sources: Render, "Real-time AI chat infrastructure" (Jan 2026, vendor); Upstash "realtime-ai-sdk" (vendor, run the work in a background job and let the client resubscribe).
- Anthropic's Agent SDK hosting guide (code.claude.com, current) assumes a long-lived container that exposes HTTP or WebSocket, with sessions pinned to one container and state persisted outside it. It does not describe a request-scoped function.

**Trade-offs**
- *Full-stack framework* (Next.js, RR7, SvelteKit): you get one deploy and shared types. The cost: Next.js on AWS without Vercel means OpenNext or a standalone container. Server actions and route handlers push you toward request-scoped work. Long-lived SSE and background runners end up fighting the framework's conventions.
- *Separate TS service* (agent core + API + SSE) with thin SPA front ends: the safety core is easy to see and test as one module. The run loop is a worker, not a request handler. Both front ends call the same API. Cost: two deployables, or one container that also serves static assets.

**Recommendation:** use a separate Node service that owns runs, safety checks, and streaming. Build both front ends as static SPAs (Vite + React) served from that container or from S3+CloudFront. A pnpm monorepo with a shared `types`/zod package keeps the main benefit of a full-stack framework, end-to-end types.

## 2. TypeScript backend framework for streaming on Node

**Findings**
- Hono and Fastify are effectively tied on throughput. Fastify's own benchmark page (updated 2026-08-17, vendor-run): Fastify about 88k req/s, Hono 4.13 about 82k, Express 5.2 about 58k. A third-party test on Node 24 had Hono and Fastify within 1%. No public benchmark covers SSE specifically (UNVERIFIED for SSE at scale).
- Hono offers web-standard Request/Response and a built-in `streamSSE` helper. It runs on any runtime (Node via `@hono/node-server`) and has a typed RPC client (`hc`) that shares route types with SPAs. Fastify is Node-only, with a mature plugin and schema ecosystem. NestJS is heavyweight for a one-week, one-engineer build. Express 5 works but is slower and has weaker typing. Sources: pkgpulse / techplained 2026 comparisons (third-party, low-to-medium quality).
- Prefer SSE over WebSockets for token streaming. It is plain HTTP, passes through ALB, and supports `Last-Event-ID` reconnection. Send user input (chat messages, approvals) as normal POSTs.

**Recommendation:** Hono on Node 22/24, SSE via `streamSSE`, zod validation, and the `hc` typed client in both SPAs. Choose Fastify instead only if you want its plugin ecosystem. Either is fine.

## 3. Durable execution and human-in-the-loop pauses

**Options (as of late 2026)**
- **DB-persisted run state (Postgres state machine + job queue).** Store each run as rows: `runs(status: running|awaiting_approval|...)`, `messages`, `tool_calls(status, approval_id)`, `run_events(seq)`. When a tool needs approval, persist the pending `tool_use`, set the run to `awaiting_approval`, and end the worker. Nothing waits in memory. When the owner approves, enqueue a "resume run" job. The worker reloads history, runs the approved tool through the safety core, appends `tool_result`, and continues the Claude loop. A Claude turn is naturally a checkpoint: the messages array is the state. A Postgres-backed queue (pg-boss or graphile-worker) adds no new infrastructure. Lowest complexity, and every pause is visible in your own DB for the owner UI.
- **AWS Lambda durable functions** (GA; "execute for up to one year", waits suspend "without incurring compute charges", JS/TS SDK `@aws/durable-execution-sdk-js` with `waitForCallback`/`createCallback`; resumed via `SendDurableExecutionCallbackSuccess`). Source: docs.aws.amazon.com/lambda/latest/dg/durable-functions.html (current); the launch date is UNVERIFIED (appears to be re:Invent 2025). Caveats: replay requires determinism, every LLM call and tool call has to be wrapped in steps, streaming tokens to a browser needs a separate pub/sub channel, and TS signatures differ between doc pages (UNVERIFIED API stability).
- **Step Functions `.waitForTaskToken`** (Standard workflows, up to 1 year). Reliable, but you write the agent loop in ASL/JSON, which fits a dynamic tool loop poorly and makes token streaming awkward.
- **Temporal** is the most mature. A Sept 2026 funding report (agentwiki, UNVERIFIED) says it raised a $550M Series E. It needs Temporal Cloud or a self-hosted cluster plus workers, which is too much infrastructure for a one-week build.
- **Restate** runs as a single self-hostable binary or cloud service, with durable promises and awakeables for HITL. **Inngest** is SaaS with `step.waitForEvent` and a timeout. Both are good fits but add a vendor or service. Vendor content says HITL "maps directly" to their suspend/resume primitives (inngest.com blog, 2026, vendor).
- Framework-level: Vercel AI SDK v7 tool approvals are stateless. A `tool-approval-request` goes to the client, and you resume by re-sending history with a `tool-approval-response`. An optional HMAC `experimental_toolApprovalSecret` prevents forged approvals. `needsApproval` is only for `WorkflowAgent` (durable). Source: ai-sdk.dev/docs/agents/tool-approvals (current). This is a client-held approval model, which is the wrong trust model when the approver (the owner) is not the chatter (a stranger).

**Recommendation:** at prototype scale, the community default is explicit DB state plus a queue. Approvals that wait hours do not need a durable-execution engine when the loop is checkpointed at turn boundaries. Make tool execution idempotent with a key per `tool_use_id`, so a crash mid-tool never runs it twice. Keep Lambda durable functions or Restate as the upgrade path if runs grow multi-step beyond the turn boundary.

## 4. AWS deployment

**Compute**
- **App Runner: avoid.** It is closed to new customers from **2026-04-30** and in maintenance mode, with no new features. AWS recommends **ECS Express Mode** instead. Sources: AWS App Runner docs "what is apprunner" (2026); encore.dev "end of App Runner" (2026, third-party).
- **ECS Express Mode** (announced 2025-11-21, all regions, no extra charge). From a container image it provisions a Fargate service, an ALB with HTTPS:443 and TLS, autoscaling, CloudWatch, and an `*.ecs.<region>.on.aws` domain. Up to 25 services share one ALB. All resources stay in your account. Source: aws.amazon.com/about-aws/whats-new/2025/11/announcing-amazon-ecs-express-mode; InfoQ Dec 2025. This is the fastest path to Fargate for one engineer.
- **Lambda**: response streaming now allows 200 MB (2025-07-31), and API Gateway REST supports response streaming with integration timeouts up to 15 min (2025-11-19). Still a poor fit: a 15-minute cap, duration billing while streaming, no long-lived in-process state, and MCP client connections re-established on every invoke. Sources: AWS What's New 2025/07 and 2025/11.

**Database**
- **RDS for PostgreSQL** (single-AZ t4g.small or similar) is predictable, cheap, and always on, and it supports `LISTEN/NOTIFY` for SSE fan-out across tasks.
- **Aurora Serverless v2** can scale to 0 ACU with auto-pause (since Nov 2024, Postgres and MySQL), but it resumes on first connection, reportedly in under 15 s (DEV post, UNVERIFIED). Scale-to-zero conflicts with an always-on agent. At min 0.5 ACU it costs more than a small RDS instance. Source: AWS Aurora user guide "aurora-serverless-v2-auto-pause" (current).

**Realtime**
- **SSE through ALB**: the idle timeout is configurable from 1 to 4000 s (default 60). ALB does not count HTTP/2 PING frames as activity, so send real bytes (an SSE `:keepalive` comment every 15-20 s). Set the app keep-alive higher than the ALB timeout to avoid 502s. Source: ELB docs "edit load balancer attributes" (current).
- **API Gateway WebSockets**: workable, but adds a connection table and per-message Lambda plumbing. Not needed.
- **AppSync Events** (WebSocket pub/sub since 2025-03-13, $1.00 per million operations, OnPublish/OnSubscribe handlers): a good managed fan-out if you later go multi-region or serverless. Overkill now. Source: AppSync Events developer guide and pricing (current).

**Recommendation:** ECS Express Mode (Fargate), at least 2 tasks behind the ALB with idle timeout around 300-900 s. RDS Postgres. SSE with event replay from `run_events`. Secrets Manager for the Anthropic key and MCP credentials.

## 5. Agent frameworks vs a hand-rolled loop

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): it spawns a `claude` CLI subprocess with a shell, a working directory, and JSONL transcripts on disk. That means 1 GiB RAM / 1 CPU per concurrent session as a starting point, a `SessionStore` adapter to survive restarts, and tenant isolation through `settingSources: []`, a per-tenant `CLAUDE_CONFIG_DIR`, and a per-tenant `cwd`. It has `PreToolUse` hooks and `canUseTool` for gating. Source: code.claude.com/docs/en/agent-sdk/hosting (current). Good for coding or filesystem agents. For a public chatbot with strangers it is a poor fit: a built-in shell and file tools are attack surface you would have to disable, memory per session is high, and a `canUseTool` callback cannot wait hours in memory.
- **Claude Managed Agents** (public beta ~2026-04-08 per third-party; `always_ask` policy pauses for a `user.tool_confirmation` event; `auto` mode ~2026-09-10). All dates are from third-party write-ups (UNVERIFIED). Anthropic hosts the loop. Custom tools run in your app. Worth a look later, but it moves the loop and part of the safety boundary out of your code, and the requirement is checkpoints *in your code*.
- **Anthropic TS SDK Tool Runner** (`client.beta.messages.toolRunner`, `betaZodTool`): Anthropic's docs say to use the *manual loop* for human-in-the-loop approval, custom logging, or conditional execution. Source: platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner (current).
- **Vercel AI SDK (now v7)**: the best streaming and UI primitives, and `toolApproval` policies (`approved|denied|user-approval`). The approval model is client-round-trip and stateless, and v7 is fresh (a third-party article says June 2026, UNVERIFIED). Reasonable for the chat UI, but it is another abstraction over Claude-specific features (caching, server tools).
- **Mastra** (v1.x): workflows with suspend/resume and HITL gates, storage-backed. **LangGraph.js**: checkpointers, `interrupt()`, and graph state. Both provide durable HITL, but each brings its own state model and abstraction for one engineer to learn in a week. Sources: 2026 comparison posts (third-party).
- **Rule of thumb:** when *every* tool call and reply has to pass through your own checkpoints, own the loop. A Claude tool loop is about 150 lines: `messages.stream()`, then for each `tool_use` run `safety.preTool`, then approval-gate or execute, then `safety.postTool`. Assistant text goes through `safety.reply` before it is committed. Use the official `@anthropic-ai/sdk` MCP helpers, or `@modelcontextprotocol/sdk` Client, to list and call the owner's MCP tools, and wrap them in the same checkpoint pipeline as native tools.

Note on streaming plus reply safety: if a reply-level checkpoint has to pass *before* the user sees text, you cannot stream tokens raw. Common patterns: stream into a buffer and release per sentence or paragraph after a fast check, or stream optimistically and retract on failure. Pick one explicitly (design choice; no single source).

## 6. Rust option: full Rust backend vs a Rust policy kernel inside a TS app

**Findings**
- **No official Anthropic Rust SDK.** On 2026-10-29 the `anthropics` GitHub org lists official client SDKs for Python, TypeScript, Go, Java, Ruby, PHP, and C#, plus Agent SDKs for Python and TS. It has none for Rust. Rust options are community crates (`anthropic-ai-sdk`, `anthropic-sdk-rust`, `anthropic`), each self-described as "unofficial". They lag on beta features such as prompt caching variants, server tools, MCP connector, and Files. Sources: github.com/anthropics (checked via API 2026-10-29); docs.rs crate pages.
- **The official MCP Rust SDK (`rmcp`, modelcontextprotocol/rust-sdk) is mature.** It is at 3.8.0 on crates.io (updated 2026-10-26). The 3.x README targets the 2026-07-28 MCP spec, with client and server, streamable-HTTP transport, and OAuth. Source: crates.io API and docs.rs rmcp README (2026). This part is on par with TS.
- **Axum SSE is first-class**: `axum::response::sse::{Sse, Event, KeepAlive}` over any `Stream` gives built-in keep-alive comments, which the ALB needs. Tokio covers long-lived connections well. This is standard and stable, not a risk.
- **Cedar from Node is cheap.** The official `@cedar-policy/cedar-wasm` is at 4.14.0 (published 2026-10-19) and ships `./nodejs` and `./web` entry points (npm registry, 2026-10-29). It runs the same Rust evaluator in-process with no sidecar. Exact JS function names (`isAuthorized`, `validate`, ...) are UNVERIFIED; the npm page returned 403. Cedar's `validate` is exported to WASM (cedar-policy 4.10 source).
- **Formal analysis** (`cedar-policy-symcc`, Cedar Analysis) is Rust-only. It needs an external **cvc5** binary and is at 0.1.x, first published Nov 2025. It proves properties such as always-deny, equivalence, and subsumption between policy sets, and returns counterexamples. Sources: docs.rs/cedar-policy-symcc; AWS Open Source Blog "Introducing Cedar Analysis" (2025). This belongs in **CI or an offline check** ("does the new owner policy still forbid X?"), not in the request path. That makes a sidecar unnecessary: a small Rust CLI run at policy-save time or in CI is enough.
- **Agentic-coding productivity:** there is no controlled 2026 Rust-vs-TS study. Indirect signals: a 13-language Claude Code experiment (dev.to/mame, 2026) found dynamic languages fastest and cheapest for prototype-scale work, with Rust in the middle tier (about 114 s, $0.54 per task). Multi-SWE-bench commentary puts Rust and TS resolution rates in the same low band. The compiler does catch more agent mistakes (vendor analysis, weak methodology). Separately, a Rust build means hand-writing the Claude client, its streaming event types, and the tool loop against a community crate or raw HTTP. Rust compile times also slow the agent edit-test loop. All UNVERIFIED as quantitative claims.

**Options**
- *Full Rust (Axum + rmcp + community Anthropic crate):* best memory per connection and strong typing. Costs: no official Claude SDK, slower iteration, and the front ends still need TS, so types get duplicated or generated. Too risky for a one-week, one-engineer build.
- *Hybrid A: TS app + Cedar via `@cedar-policy/cedar-wasm` in-process:* gets Cedar's verified evaluator and policy validation on every tool-call checkpoint for about one npm dependency. **Recommended if you want a policy language.**
- *Hybrid B: Rust sidecar for Cedar plus SymCC:* only worth it if formal analysis must run live (for example, rejecting an owner's policy edit that would open a forbidden action). Even then, run it as a CLI or Lambda at save time, not a per-request sidecar.

**Verdict:** keep the agent loop and API in TypeScript. If the safety core uses declarative policies, embed Cedar through the official WASM package. Add `cedar-policy-symcc` + cvc5 later as a CI or policy-save-time check (a small Rust binary). Do not write the backend in Rust this week. The lack of an official Anthropic Rust SDK is the deciding factor, and the gains (latency, memory) do not matter at this scale.

---

## Recommended stack (one paragraph)

Build a pnpm TypeScript monorepo. The core is one **Node 22/24 + Hono** service that owns a **hand-rolled Claude loop on `@anthropic-ai/sdk`** (`messages.stream`, manual tool loop, prompt caching). Every native and MCP tool call (`@modelcontextprotocol/sdk` client) and every assistant reply goes through a single in-code **safety pipeline** (pre-tool, approval gate, post-tool, reply check). Allow, deny, and approve decisions optionally come from **Cedar via `@cedar-policy/cedar-wasm`**, with Cedar SymCC analysis deferred to CI. There is no Rust backend, since Anthropic has no official Rust SDK. Run state lives in **Postgres (RDS, single-AZ)** as an explicit state machine (`runs`, `messages`, `tool_calls`, `approvals`, `run_events` with a monotonic seq). Approvals persist the pending `tool_use`, end the worker, and resume through a **pg-boss/graphile-worker** job when the owner decides. Tool execution is idempotent, keyed per `tool_use_id`. Clients get **SSE** with `Last-Event-ID` replay from `run_events`, and `LISTEN/NOTIFY` fans out across tasks. Deploy as one container on **ECS Express Mode (Fargate) behind its ALB** (idle timeout raised, 15 s keepalive comments), with secrets in Secrets Manager. The **owner app and public chat page** are two Vite + React SPAs using Hono's typed `hc` client, served from S3+CloudFront or the same container. Defer Lambda durable functions, Restate/Inngest/Temporal, AppSync Events, Claude Managed Agents, and the Agent SDK until a concrete need appears. App Runner is out, since it is closed to new customers from 2026-04-30.
