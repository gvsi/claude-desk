# Runtime authorization and guardrails for AI agents: landscape as of 2026-10-28

Research date: 2026-10-28

Background research for the Claude Desk design; claims are cited, and anything not confirmed from a source is marked UNVERIFIED.

Scope: systems that check an agent's tool calls, outgoing messages or identity before anything runs or reaches a person, and what each one means for **Claude Desk**. Claude Desk is a public, always-on agent for a small business. Strangers and other agents talk to it, and it answers, books, quotes, releases documents and takes payments under the owner's rules.

Research method: web search and fetches on 2026-10-28. I used primary sources (vendor docs, specs, papers) wherever I could reach them. Claims backed only by third-party or launch-site copy are marked **UNVERIFIED**. Vendor benchmark and latency figures are vendor claims even where the source is primary.

---

## 1. Two products identified by name

| Name searched | What it actually is | Confidence |
|---|---|---|
| "AIF / harden" | **Harden AIF (Agentic Integrity Foundation)**, from Harden (harden.run). It is a local firewall that runs before tool execution, built for *coding agents* (Claude Code, Codex, Cursor, Gemini CLI, Kiro, OpenClaw, Hermes). It launched on Product Hunt on 2026-09-09; the Product Hunt slug spells it "Agent Integrity Foundation". | High. Identified from the vendor trust page and the GitHub README. |
| "kastra" | **Kastra** (Kastra Labs Inc., kastra.ai) is a runtime authorization layer for AI agents. A deterministic policy engine returns allow, deny or hold (send to a human) before prompts, tool calls, shell commands or API calls execute. It ships as Kastra Edge (local, for coding agents), a proxy compatible with the OpenAI and Anthropic APIs, and a REST API. It launched on Product Hunt on 2026-07-22. | High on identity. Many product details are UNVERIFIED (see below). |

Both are young, aimed at developer and enterprise *coding-agent* governance, and neither is built for a customer-facing agent. Their **design patterns** are what matters for Claude Desk, not the products.

---

## 2. Comparison table

Legend for *Mechanism*: **D** = deterministic policy or rules; **M** = model-based classifier or judge; **D+M** = both. For *Where*: **PRE-TOOL** = before tool execution; **IN** = on inbound user or tool content; **OUT** = on model output or outgoing message; **ID** = identity or delegation layer; **PAY** = payment authorization.

| System | Category | Mechanism | Where | Maturity / availability | Pricing (public) | Fit for Claude Desk prototype (1–2 months) |
|---|---|---|---|---|---|---|
| **Kastra** | Runtime authZ PDP for agents | D (own DSL, `policy.dsl`); separate `infer.guard` post-inference validation | PRE-TOOL, IN (prompts), OUT (model output before it reaches a system) | Launched Jul 2026; managed cloud, VPC or air-gapped; native SDKs "coming soon" | Pro trial 15 days; Team and Enterprise have no list price; free tier mentioned | **Mirror** (allow/deny/hold, hash-chained audit, shadow mode). Don't adopt: coding-agent focus, no SDKs yet, open-source claim unverified |
| **Harden AIF** | Local pre-execution firewall for coding agents | D decides; local 8B model is *advisory only* in v0.x | PRE-TOOL (hooks to a loopback daemon) | v0.x beta; closed-source binary, Apache-2.0 SDKs; macOS and Linux | Free for individual developers; Enterprise custom (pricing UNVERIFIED from primary) | **Mirror** the "hard floor" invariants and fail-closed defaults. Not usable as-is (desktop and coding only) |
| **AWS Bedrock AgentCore Policy** | Managed Cedar PDP at the agent→tool gateway | D (Cedar); LLM translates natural language to Cedar, checked by schema validation and formal analysis | PRE-TOOL (AgentCore Gateway) | GA 2026-03-03, 13 regions | ~$0.000025 per authorization request (UNVERIFIED, third-party); NL authoring billed per 1k tokens | **Mirror closely** (default-deny, principal attributes from token claims, bounded tool arguments, tools hidden when always denied). Adopt only if you're already on AWS |
| **Cedar** (language and engine) | Open-source policy language | D, formally analyzable | Embeddable PDP | CNCF Sandbox since 2025-10-08; Apache-2.0 | Free | **Adopt** as the owner-rules language (embedded library; no service needed) |
| **OPA / Rego** | Open-source general PDP | D | Sidecar or library PDP | CNCF graduated; Styra's founding team moved to Apple in Aug 2025 (secondary sources) | Free | Workable but heavier; Cedar fits better for owner-authored rules |
| **Cerbos** | Open-source PDP + Hub | D (YAML policies) | PDP called from MCP or tool middleware | Apache-2.0; FastMCP and MCP SDK middleware integrations (vendor) | PDP free; Hub commercial | Workable alternative to Cedar; YAML is friendlier to non-engineers |
| **Permit.io** | Hosted authZ + MCP Gateway | D (RBAC/ABAC/ReBAC; OPA/OPAL-based) | PRE-TOOL via MCP Gateway; PDP | GA SaaS; MCP Gateway is a newer product | Community free: 1,000 MAU, 20 tenants, unlimited checks | Possible hosted PDP; useful reference for "MCP auth ≠ tool-call authZ" |
| **Oso (Oso for Agents)** | AuthZ + agent least privilege | D enforcement, with behavior monitoring | PRE-TOOL (action boundary) | Agent features in private beta, access via sales | Not public | Skip for prototype |
| **Auth0 for AI Agents** | Agent identity, token vault, async approval (CIBA) | ID (OAuth/OIDC); human-in-the-loop approval | ID, approval step | GA 2025-11-19; email CIBA is a paid add-on | Free plan includes 2 Token Vault apps; AI add-on priced per MAU (UNVERIFIED, from German pricing page) | **Mirror** CIBA-style owner approval for HOLD. Optionally adopt for OTP and magic link plus CIBA |
| **Okta Cross App Access (XAA) / ID-JAG** | Enterprise IdP-governed agent→app access | ID | ID | MCP Enterprise-Managed Authorization extension Stable 2026-06; ID-JAG is an IETF draft | Okta enterprise | Not relevant to small-business stranger traffic |
| **Arcade.dev** | Managed tool runtime with per-user OAuth for tools | ID + runtime | ID, PRE-TOOL (user-scoped credentials) | GA SaaS | Free 2,000 tool calls/month; Team $25/month + $0.01/call | Optional if Claude Desk needs the owner's Google, Calendar or other third-party tools; not a policy engine |
| **MCP Authorization spec** | Protocol standard | ID (OAuth 2.1, RFC 9728, RFC 8707, CIMD) | ID at connection level, plus step-up via `insufficient_scope` | Spec 2025-11-25; 2026-07-28 revision (stateless, DCR deprecated, issuer validation) | Free | **Adopt** for Claude Desk's own MCP endpoint. It does **not** authorize individual tool calls |
| **A2A security schemes + signed Agent Cards** | Protocol standard | ID (declared schemes; JWS-signed card, JCS canonicalization); `AUTH_REQUIRED` task state | ID | A2A v1.0 (Linux Foundation) | Free | **Adopt**: publish a signed card; use `AUTH_REQUIRED` for step-up |
| **Web Bot Auth / Visa TAP** | Signed HTTP requests that identify agents | ID (RFC 9421 signatures, JWKS directory) | ID (who operates the calling agent) | IETF draft-00, 2026-09; adopted by Cloudflare, Visa, Mastercard, OpenAI (secondary) | Free | Verify when present; treat as an operator signal, not customer identity |
| **AP2** | Payment mandates for agents | D (signed verifiable digital credentials, i.e. mandates) | PAY | v0.2 (Apr 2026), donated to the FIDO Alliance; pre-release | Free (Apache-2.0) | **Mirror** the mandate concept; don't implement yet |
| **Stripe ACP / Shared Payment Tokens** | Agentic checkout rail | D (token scope, usage limits, expiry) | PAY | SPT objects; some APIs in private preview (2026-04 changelog) | Stripe fees | Likely the real rail for receiving agent payments later; for the prototype use plain Stripe Checkout |
| **Invariant Guardrails** (Snyk) | Rule engine for agent traces | D rules (Python-like) + M detectors (prompt injection) | PRE-TOOL, IN, OUT via gateway or library | Apache-2.0; Snyk acquired Invariant in Jun 2025; activity after early 2026 unclear | Free OSS | **Mirror** dataflow rules (e.g. private read → external send). Usable as a library, but check maintenance first |
| **Lakera Guard → Check Point AI Guardrails** | Hosted guardrail API | M (+ allow/deny tool lists, custom regex) | IN, OUT, tool calls, tool outputs, tool definitions | GA SaaS; Check Point acquired Lakera in 2025 | Free community tier ~10k requests/month (UNVERIFIED); enterprise otherwise | **Adopt (optional)** as a second-layer screen on inbound and outbound text |
| **Prompt Security** (SentinelOne) | Enterprise AI security and MCP gateway | M + policy (allow/block/filter/redact) | IN, OUT, MCP calls | Acquisition announced 2025-08-05 | Enterprise | Not a fit (enterprise workforce focus) |
| **Protect AI → Prisma AIRS** (Palo Alto) | Enterprise AI runtime security | M | IN, OUT, agent inventory | Prisma AIRS 3.0 (Mar 2026); open-source LLM Guard **archived** | Enterprise | Avoid (archived OSS; enterprise product) |
| **NVIDIA NeMo Guardrails** | Open-source rails framework | D (Colang flows) + M (NemoGuard NIMs, LLM self-check) | IN, retrieval, dialog, execution (tool), OUT | v0.24.1 latest listed; Apache-2.0 | Free OSS; NIMs extra | Heavy for a 1–2 month build; borrow the "output rail" concept |
| **Microsoft Prompt Shields** (+ Spotlighting, Task Adherence) | Hosted classifiers | M | IN (user prompt, documents), tool response (Preview); Task Adherence flags misaligned tool calls (Preview) | Prompt Shields GA; doc page updated 2026-08-28 | Azure Content Safety metered | Usable via REST; Task Adherence is an interesting idea, but in preview |
| **Google Model Armor** | Hosted screening API | M (+ SDP/DLP templates) | IN (`SanitizeUserPrompt`), OUT (`SanitizeModelResponse`) | GA; doc updated 2026-10-26; inspect-only or inspect-and-block | Token-metered; ~2M tokens/month free, then ~$0.10 per 1M (UNVERIFIED, third-party) | **Adopt (optional)** as a cheap OUT screen (PII, malicious URLs) |
| **Meta LlamaFirewall** (PromptGuard 2, AlignmentCheck, CodeShield) | Open-source agent guardrail framework | M (classifier, LLM judge) + D (Semgrep/regex) | IN (PromptGuard on user and tool content), PRE-TOOL (AlignmentCheck after each proposed action) | Paper Apr/May 2025; Llama license | Free (self-host) | **Adopt** PromptGuard 2 (22M/86M) as a local inbound classifier; AlignmentCheck needs a large model and is experimental |
| **Claude Agent SDK permissions/hooks** | Agent framework controls | D (your code), optional model "auto" mode | PRE-TOOL (`PreToolUse` hook, deny rules, `dontAsk`, `always_ask` tools) | GA | Included | **Adopt**: this is the enforcement point Claude Desk actually controls |
| **OpenAI Agents SDK guardrails** | Agent framework controls | D or M (your function) | IN, OUT, tool input/output guardrails (JS) | GA | Included | Reference design (tripwire, `rejectContent`) |
| **CaMeL** (Google DeepMind paper) | Research: capability/dataflow security | D (interpreter + capability tags) | PRE-TOOL (policy at every tool call) | Research code; 77% of AgentDojo tasks solved with provable security (v2) | Free | **Mirror lightly**: tag data with provenance and audience; check at sinks |

---

## 3. Notes on each system

### 3.1 Harden AIF (Agentic Integrity Foundation)
- **What it is:** an on-device firewall for coding and personal agents. Hook adapters call a daemon bound to loopback (127.0.0.1:47391), which returns **Allow / Block / Ask / Redact / Log only / Model error** before the tool runs.
- **Mechanism:** the deterministic engine decides. A local model (ZAYA1-8B base, about 5.5 GB, run on llama.cpp) runs *after* the decision and has *zero decision authority* in v0.x. The vendor will promote it to deciding only once measured agreement reaches at least 90% and false positives are at most 1%.
- **Hard floor (always blocked):** a secret (credential file, environment variable or known secret format) reaching network egress, a write outside the repo, or an MCP tool argument. Destructive actions are a preview: `rm -r` outside the repo and force-push to the default branch.
- **Threat model:** in scope is the *negligent* agent. Adversarial or prompt-injected agents that obfuscate flows are **explicitly out of scope**.
- **Fail-closed by default** (daemon unreachable for more than about 2 s means block), with documented fail-open paths per host agent (Gemini CLI, Codex/Hermes timeouts, OpenClaw, Copilot CLI, Kiro SIGKILL).
- **Vendor numbers:** 100% recall and precision on a 196-case corpus (41 known-gap cases excluded); 0.25% wrong hard blocks over 24,809 dogfood decisions (2026-07-24 to 2026-08-01); P99 70.2 ms. These come from one machine and the vendor's own sessions.
- **Availability:** closed-source binary under the "AIF Beta License"; client SDKs `@hardenrun/aif` and `harden-aif` are Apache-2.0. Free for individual developers; Enterprise adds MDM, air-gap and SLA. The pricing detail comes from a third-party review (UNVERIFIED on primary).
- **Fit:** not usable for Claude Desk, which is server-side and customer-facing. **Patterns worth copying:** a small, fixed hard floor that config can't switch off; model as advisor only until it has measured agreement; explicit fail-closed behavior; a local decision store with a viewer.
- Sources: https://aif.harden.run/trust.md (dates inside: 2026-07-17 / 07-18 / 08-01; fetched 2026-10-28); https://github.com/hardenrun/aif (README, ©2026); https://docs.harden.run; https://chatgate.ai/post/harden (third-party review, Sept 2026); https://www.producthunt.com/products/agent-integrity-foundation-aif (launch 2026-09-09).

### 3.2 Kastra
- **What it is:** "the authorization layer for AI systems" from Kastra Labs Inc. A deterministic, hot-reloadable policy graph evaluates *identity, scope, intent, content, destination* before an action executes. Its components:
  - `policy.dsl`: a typed, versioned DSL, with rules like *deny `shell.exec` when an argument matches a destructive pattern*.
  - `infer.guard`: validates what the model returns before it reaches a real system.
- **Verdicts:** the homepage says allow/deny, the platform page says allow/block/transform, and the maker's Product Hunt comment says Allow/Deny/**Hold**. Hold means human approval with the full execution context, approved through the desktop app, web console or macOS notification. A commenter reports a 3-minute auto-reject on unanswered holds (UNVERIFIED).
- **Audit:** an ed25519-signed, hash-chained, per-tenant-encrypted audit vault with a verification API, plus SOC 2/HIPAA/GDPR/EU AI Act evidence exports. **Shadow mode** runs policies against live traffic, and dry-run replays them on past runs.
- **Latency claims:** p50 ~0.4 ms, p99 <1 ms (vendor).
- **Deployment:** managed cloud, single-tenant VPC, or air-gapped. **Kastra Edge** runs locally for coding agents (`brew install kastra-labs/tap/kastra-edge`). The integration path today is a proxy compatible with the OpenAI and Anthropic APIs, or REST. TypeScript/Python/Go SDKs are "coming soon".
- **Open source:** the maker says the "runtime and policy pack library are open source". **UNVERIFIED**: I found no public repository, and the kastra.ai pages make no open-source claim.
- **Pricing:** Pro (15-day trial), Team, Enterprise; no list prices published.
- **Fit:** the closest conceptual match to Claude Desk's "stop bad tool calls before they execute", but built for engineering-org governance. **Mirror:** the three-way verdict (allow/deny/hold), a decision log that records the matched policy, shadow then enforce rollout, and replaying policy against past transcripts.
- Sources: https://kastra.ai/ and https://kastra.ai/platform (©2026, fetched 2026-10-28); https://kastra.ai/pricing; https://www.producthunt.com/products/kastra (launch 2026-07-22, maker comments); https://chatgate.ai/post/kastra (third-party).

### 3.3 AWS Bedrock AgentCore Policy, and Cedar
- A policy engine attached to **AgentCore Gateway**, which sits between agent and tools. It is **default deny**: until a Cedar `permit` opens a path, everything is blocked.
- **Principal attributes** (e.g. customer tier) come from **OAuth/JWT claims**, so the LLM can't change them. **Tool arguments** come from the LLM and are bounded by policy conditions, e.g. refund amount ≤ X or quantity ≥ 50.
- **Natural-language authoring:** an LLM drafts Cedar, which is then checked by schema validation (schema generated from MCP tool descriptions) and Cedar Analysis. Analysis catches unsatisfiable, over-permissive and conflicting permit/forbid rules, and an attach fails if analysis finds errors.
- **Partial evaluation hides tools that would always be denied** from `tools/list`, so the agent never sees them.
- **GA:** 2026-03-03. Pricing is reported as ~$0.000025 per authorization request (UNVERIFIED, from third-party roundups; the official page wasn't parsed).
- **Fit:** the reference architecture for Claude Desk's tool gate. Cedar itself is open source (CNCF Sandbox, 2025-10-08) and can be embedded without AWS.
- Sources: https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available (2026-03); https://aws.amazon.com/blogs/security/why-policy-in-amazon-bedrock-agentcore-chose-cedar-for-securing-agentic-workflows/ (2026-05-20); https://aws.github.io/bedrock-agentcore-starter-toolkit/user-guide/policy/overview.html; https://www.cncf.io/projects/cedar/; https://aws.amazon.com/bedrock/agentcore/pricing/.

### 3.4 OPA, Cerbos, Permit.io, Oso
- **OPA/Rego:** CNCF-graduated general policy engine. Reports say Apple hired Styra's founding team in Aug 2025 and that OPA's governance is unchanged (secondary sources: https://cloudnativenow.com/editorial-calendar/best-of-2025/apple-buys-styra-brains-opa-remains-open-2/). Gateways commonly use it for MCP `tools/call` gating. Rego is harder for non-engineers to read than Cedar.
- **Cerbos:** Apache-2.0 PDP with YAML policies; can run as a sidecar, Lambda, or embedded via Hub bundles. It publishes FastMCP and MCP SDK middleware that authorizes each tool call (vendor). https://github.com/cerbos/cerbos ; https://www.cerbos.dev/blog/dynamic-authorization-for-ai-agents-guide-to-fine-grained-permissions-mcp-servers .
- **Permit.io:** hosted policy-based authorization (OPA/OPAL heritage) plus an **MCP Gateway**. The Community tier is free (1,000 MAU, 20 tenants, unlimited checks). Its 2026-07-29 post argues **OAuth is "necessary but not sufficient"**: under the stateless 2026-07-28 MCP spec, each `tools/call` needs its own policy decision on tool, target, parameters and context. https://www.permit.io/blog/mcp-auth-vs-tool-call-authorization-2026-07-28 ; https://www.permit.io/pricing .
- **Oso for Agents:** deterministic enforcement at the action boundary, plus automated least privilege. The agent features are in private beta, with access "via meeting with our CEO". https://www.osohq.com/docs/oso-for-agents/overview ; https://www.osohq.com/docs/get-started/automated-least-privilege .
- **Fit:** none of these is needed for a prototype if Cedar is embedded directly. Cerbos or Permit are reasonable if a hosted policy UI for owners becomes valuable.

### 3.5 Auth0 for AI Agents (async authorization / CIBA)
- **GA on 2025-11-19.** It has four parts:
  - User Authentication.
  - **Token Vault:** stores and refreshes third-party OAuth tokens; 35+ integrations.
  - **Async Authorization:** OpenID CIBA with Rich Authorization Requests, so the approver sees exactly what they are approving and the agent gets a token only after approval.
  - FGA for RAG.
- **Channels:** Guardian push is the default. **Email** CIBA is a paid add-on on Essentials, Professional and Enterprise. `requested_expiry` between 301 s and 72 h routes to email, which is also the fallback when the user has no push authenticator enrolled; an unverified email is rejected. Auth0 itself warns that email is more phishable than push.
- **Pricing:** the free plan includes 2 Token Vault connected apps. A per-MAU "AI Agents add-on" appears on the German pricing page (Essentials from $18/month at 500 MAU; UNVERIFIED in English).
- **Fit:** CIBA maps exactly onto Claude Desk's **HOLD → owner approves on phone**. Auth0 could also supply the visitor OTP and magic link. For a 1–2 month prototype, rolling your own approval link or push is simpler; mirror the RAR-style "show the exact action and parameters" consent.
- Sources: https://auth0.com/blog/auth0-for-ai-agents-generally-available/ (2025-11-19); https://auth0.com/ai/docs/intro/asynchronous-authorization ; https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/email-notifications-with-ciba ; https://auth0.com/de/pricing.md .

### 3.6 Okta Cross App Access (XAA) / ID-JAG
- The enterprise IdP decides whether an agent client may reach an app, by issuing an ID-JAG assertion that is exchanged for an MCP access token. The MCP Enterprise-Managed Authorization extension went Stable in 2026-06 (secondary sources), and ID-JAG is an IETF OAuth WG draft.
- **Fit:** irrelevant to anonymous or small-business customers. It matters only if Claude Desk later serves enterprise buyers whose agents arrive under corporate SSO.
- Sources: https://workos.com/blog/mcp-enterprise-managed-authorization-id-jag ; https://workos.com/blog/id-jag-cross-app-access .

### 3.7 Arcade.dev
- A managed tool runtime that handles per-user OAuth for third-party tools (Gmail, Calendar and so on) and evaluates agent and user permissions together at execution time (third-party description).
- **Pricing (official page):** Free with 2,000 tool calls/month; Team at $25/month + $0.01/call; Enterprise custom with VPC or air-gap. A competitor blog claims Arcade wrote MCP's tool-authorization material (UNVERIFIED).
- **Fit:** helpful only if Claude Desk's tools act inside the owner's SaaS accounts. It is not a business-rules engine.
- Sources: https://www.arcade.dev/pricing ; https://www.mintmcp.com/blog/arcade-dev-alternatives (2026-09).

### 3.8 MCP authorization spec
- **Spec 2025-11-25:**
  - The MCP server is an OAuth 2.1 resource server and MUST publish RFC 9728 Protected Resource Metadata.
  - Clients MUST send an RFC 8707 `resource` parameter and use PKCE S256.
  - Client ID Metadata Documents (CIMD) are the SHOULD path for clients the server has no prior relationship with; DCR is a MAY.
  - Token passthrough is forbidden and audience validation is mandatory.
  - Runtime **step-up** works via `403 insufficient_scope`.
- **2026-07-28 revision** (secondary sources): a stateless core with sessions and `initialize` removed; DCR deprecated in favor of CIMD; RFC 9207 issuer validation; enterprise-managed authorization referenced in the core.
- **Gap:** this is **connection and scope-level** authorization. Nothing in it decides "may *this* caller book *this* slot at *this* price".
- **Fit:** adopt for Claude Desk's inbound MCP endpoint. Visitor verification can be modelled as scopes, for example `docs:read:self` granted after OTP, with per-call checks happening in the policy layer.
- Sources: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization ; https://www.descope.com/blog/post/july-2026-mcp-revision ; https://workos.com/blog/mcp-2026-spec-agent-authentication .

### 3.9 A2A security schemes and signed Agent Cards
- **A2A v1.0:**
  - The Agent Card declares `securitySchemes` and `security` (API key, HTTP, OAuth2, OIDC, mTLS).
  - The server MUST authenticate every request (§7.4).
  - Authorization is implementation-specific and may consider the skill, the action, data policies and scopes (§7.5).
  - An **authenticated extended Agent Card** can expose more skills to authenticated clients (§3.1.11).
  - **In-task authorization (§7.6):** the task moves to `TASK_STATE_AUTH_REQUIRED`; credentials arrive out of band; "Agents MUST NOT treat the `TASK_STATE_AUTH_REQUIRED` transition, by itself, as authorization."
- **Signing (§8.4):**
  - Cards MAY be JWS-signed (RFC 7515) over a JCS-canonicalized card (RFC 8785).
  - The protected header MUST carry `alg` and `kid`, and MAY carry `jku`.
  - Clients SHOULD verify at least one signature, and MUST NOT use expired or revoked keys.
  - The spec text I read doesn't say how to bind a `jku` URL to the provider's domain.
- **Fit:** publish a signed card for each business. Expose a public card with basic skills (FAQ, quote) and an extended card after auth. Use `AUTH_REQUIRED` when another agent asks for a document release or payment, and complete it through the human OTP or magic link.
- Source: https://a2a-protocol.org/latest/specification/ (v1.0.0; fetched 2026-10-28).

### 3.10 Web Bot Auth and Visa Trusted Agent Protocol (identity of *calling* agents)
- Web Bot Auth is an RFC 9421 HTTP Message Signatures profile with a `Signature-Agent` header and a JWKS directory at a well-known URI: draft-ietf-webbotauth-httpsig-protocol-00 (Sept 2026), from Cloudflare and Google authors.
- Visa TAP and Mastercard Agent Pay build on it. Per secondary sources, OpenAI's ChatGPT agent signs requests, and Google's signing is experimental: Google advises keeping IP and rDNS checks primary.
- **Fit:** when another agent calls Claude Desk over HTTP, verify any signature present and log the operator, e.g. "request from ChatGPT agent". This identifies the **operator**, not the end customer, so it must never unlock customer-specific actions alone.
- Sources: https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol-00 ; https://stellagent.ai/insights/visa-tap-trusted-agent-protocol (secondary).

### 3.11 AP2 (Agent Payments Protocol) and Stripe Shared Payment Tokens
- **AP2:** announced 2025-09-16. v0.2 was released and the protocol donated to the **FIDO Alliance** around 2026-04-28 (the date is from secondary sources); it is still pre-release, Apache-2.0.
  - It uses signed **verifiable digital credentials (VDCs)** called mandates. v0.2 names them **Checkout Mandate** (shared with the merchant) and **Payment Mandate** (shared with the credential provider, network and processor).
  - Each mandate has an **Open** state (user constraints such as budget or allowed instruments, used for human-not-present purchases) and a **Closed** state (bound to one finalized cart and amount).
  - Mandates chain into a non-repudiable audit trail. It extends A2A and UCP, and an x402 sample exists.
  - The v0.1 Intent/Cart mandate names appear in older write-ups.
- **Stripe ACP / Shared Payment Tokens:** a scoped reference to a payment method with usage limits (amount, currency, count) and expiry, revocable and monitored via webhooks. `SharedPaymentGrantedToken` with `usage_limits` was added in the 2026-04-22 changelog (preview).
- **Fit:** Claude Desk is the **merchant** side. In the prototype, the agent never handles card data: it creates a server-priced Stripe Checkout or payment link, and the customer pays in Stripe's UI. **Mirror AP2's idea** by recording (a) the owner's standing rules as an "open mandate", (b) the exact cart and price the customer approved as a "closed mandate", and (c) signing both into the audit log. Accepting ACP SPTs or AP2 mandates from buyer agents is a phase-2 item.
- Sources: https://ap2-protocol.org/ ; https://ap2-protocol.org/ap2/specification/ ; https://thepaypers.com/payments/news/google-donates-agent-payments-protocol-to-fido-alliance ; https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens ; https://docs.stripe.com/changelog/dahlia/2026-04-22/shared-payment-granted-token .

### 3.12 Invariant Guardrails (Invariant Labs, now Snyk)
- An Apache-2.0 rule language with Python-like `raise "msg" if: (call: ToolCall) -> (call2: ToolCall) ...` rules over the whole trace. Its canonical example blocks `get_inbox` → `send_email` to an address outside the company domain.
- It has built-in detectors such as `prompt_injection(threshold=0.7)`. It runs through Invariant Gateway (a proxy in front of the LLM and MCP that evaluates before and after each call) or locally with `LocalPolicy`.
- Snyk acquired Invariant Labs in June 2025. Repo activity after early 2026 is unclear (aggregators disagree), and there is no archive notice.
- **Fit:** the best model for **dataflow rules**, e.g. "content from the owner-private corpus may not appear in a reply to an unverified visitor". Mirror the idea in Claude Desk's own gate rather than depend on a library whose maintenance status is unclear.
- Sources: https://github.com/invariantlabs-ai/invariant ; https://siliconangle.com/2025/06/24/snyk-acquires-invariant-labs-expand-ai-agent-security-capabilities/ .

### 3.13 Lakera Guard (now Check Point AI Guardrails)
- A single endpoint, `POST https://api.lakera.ai/v2/guard`, that takes OpenAI-style messages. It screens the latest user input and the latest assistant output.
  - `tool` messages are screened as untrusted, `tool_calls` as agent actions, and the `tools` definitions can be screened too.
  - Detectors: prompt attack, data leakage, PII/profanity/custom regex, a "Dangerous Deviation" detector, and runtime tool allow/deny lists.
  - Detect mode (monitor only) versus Enforce mode, with policy chosen per `project_id`.
- **Pricing:** a free community tier of ~10k requests/month is reported by third parties (UNVERIFIED); otherwise enterprise.
- **Fit:** an easy optional second layer on inbound visitor text and outgoing replies. It is model-based, so treat it as a signal, never as the authorization decision.
- Source: https://docs.lakera.ai/docs/api/guard (Check Point branding; fetched 2026-10-28).

### 3.14 Prompt Security (SentinelOne) and Protect AI (Palo Alto Prisma AIRS)
- **Prompt Security:** an MCP gateway that risk-scores 13k+ MCP servers and can allow, block, filter or redact. SentinelOne announced the acquisition on 2025-08-05. It targets enterprise workforce AI, not this use case. https://www.businesswire.com/news/home/20250805913926/en/
- **Protect AI:** acquired by Palo Alto Networks (announced Apr 2025; one aggregator says it closed 2025-07-22, UNVERIFIED) and folded into Prisma AIRS (3.0 in Mar 2026). **LLM Guard (MIT) is archived** per its GitHub banner, so avoid building on it. https://github.com/protectai/llm-guard ; https://docs.paloaltonetworks.com/content/techdocs/en_US/ai-runtime-security .

### 3.15 NVIDIA NeMo Guardrails
- An Apache-2.0 framework with input, retrieval, dialog, **execution** (validates tool inputs and outputs before and after invocation) and **output** rails, written in Colang 2.0.
- It plugs in NemoGuard NIMs (jailbreak, content safety, topic control) and third parties (Presidio, GLiNER-PII, Prompt Security, ActiveFence and others). The latest listed release is v0.24.1. It has LangGraph support and an OpenAI-compatible server.
- **Fit:** heavyweight for a 1–2 month prototype built on the Claude Agent SDK. The "output rail" concept (every outgoing message passes a rail) is the part to copy.
- Source: https://docs.nvidia.com/nemo/guardrails/latest/index.html .

### 3.16 Microsoft Prompt Shields, Spotlighting and Task Adherence
- **Prompt Shields** classify user-prompt attacks and document (indirect) attacks. For Foundry agents they can also scan **tool responses** (Preview).
  - The standalone API returns `attackDetected` for one `userPrompt` plus up to five documents. It does not block anything itself; the app decides.
  - **Spotlighting** (Preview) base64-encodes untrusted documents. It only works with Chat Completions and is known to make the model mention base64.
  - **Task Adherence** (Preview, from Nov 2025) flags tool calls that are misaligned with the task, giving a signal for blocking or human review.
- **Fit:** callable over REST from any stack. Task Adherence is conceptually close to LlamaFirewall's AlignmentCheck.
- Sources: https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection (ms.date 2026-08-28); https://learn.microsoft.com/en-ie/Azure/foundry/guardrails/task-adherence .

### 3.17 Google Model Armor
- `SanitizeUserPrompt` and `SanitizeModelResponse`, covering:
  - Responsible AI filters with confidence thresholds.
  - Prompt injection and jailbreak.
  - Sensitive Data Protection: basic (cards, SSNs) and advanced templates with de-identification.
  - **Malicious URLs** (first 256 URLs).
  - Documents up to 4 MB.
- Modes are inspect-only or inspect-and-block. It is stateless, single-turn, does not decode encoded content, and works for AI deployed outside Google Cloud too.
- **Pricing:** token-metered; ~2M free tokens/month then ~$0.10 per 1M (UNVERIFIED, third-party).
- **Fit:** a cheap PII/URL scrub on outgoing replies.
- Sources: https://docs.cloud.google.com/security-command-center/docs/model-armor-overview (updated 2026-10-26); https://www.deepinspect.ai/blog/google-model-armor-pricing (secondary).

### 3.18 Meta LlamaFirewall (PromptGuard 2, AlignmentCheck, CodeShield)
- **PromptGuard 2** is a BERT-style classifier in 86M and 22M sizes.
  - 86M: 97.5% recall at 1% false positives (English); about 92 ms on an A100.
  - 22M: about 19 ms on an A100.
  - It runs on user input *and tool outputs*, and flagged content is dropped before it enters the context.
- **AlignmentCheck** is an *experimental* LLM auditor that runs after each proposed action and halts on goal hijack. It needs a large model and can itself be prompt-injected.
- **AgentDojo results:** attack success rate 17.6% → 7.5% with PromptGuard 2, 2.89% with AlignmentCheck, and **1.75% combined**. Utility drops from 47.7% to 42.7%.
- **Fit:** PromptGuard 2 22M is a cheap self-hosted inbound filter. The residual attack success rate is why the classifier must not be the gate.
- Sources: https://arxiv.org/abs/2505.03574 (2025-04-29/05-06); https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/ .

### 3.19 Claude Agent SDK permissions and hooks (enforcement point)
- **Evaluation order:**
  1. `PreToolUse` hook, which can deny, and can't be overridden by later allow logic.
  2. Deny rules, enforced even in `bypassPermissions`.
  3. Ask rules.
  4. Permission mode.
  5. Allow rules.
  6. `canUseTool`.
- **Pitfall:** `canUseTool` is **skipped** for auto-approved tools. For checks that must run on every call, use `PreToolUse`.
- `dontAsk` mode turns every would-prompt into a deny. Custom tools can be marked `always_deny` or `always_ask`.
- **Gap:** this governs *tool calls*, not the final assistant text. Outgoing customer messages need their own gate (see Implications).
- Source: https://code.claude.com/docs/en/agent-sdk/permissions (fetched 2026-10-28).

### 3.20 OpenAI Agents SDK guardrails
- Input and output guardrails act as tripwires; input guardrails can run in parallel with the model or blocking.
- JS **tool guardrails** wrap function tools before and after execution, with behaviors `allow`, `rejectContent` or `throwException`. Hosted and built-in tools bypass them.
- A useful reference for the "reject with a message the model sees" pattern.
- Source: https://openai.github.io/openai-agents-js/guides/guardrails .

### 3.21 CaMeL (Google DeepMind, "Defeating Prompt Injections by Design")
- A privileged LLM writes a plan from the *trusted* query, and a quarantined LLM parses untrusted data without tool access. A custom interpreter tracks **capabilities**: the provenance and allowed readers of each value. Policies are checked at each tool call.
- 77% of AgentDojo tasks are solved with provable security, versus 84% undefended (v2 abstract).
- **Fit:** the full system is too heavy. The lightweight version, tagging every value with *source* and *who may see it* and checking at sinks, is directly useful for document release.
- Sources: https://arxiv.org/abs/2503.18813 ; https://github.com/google-research/camel-prompt-injection .

### 3.22 Not researched in depth (mentioned for completeness)
Guardrails AI (open-source validators), Llama Guard 4 (12B safety classifier, Apr 2025; https://huggingface.co/meta-llama/Llama-Guard-4-12B, not re-verified today), Pangea/CrowdStrike AI Guard, Lasso, Microsoft Entra Agent ID, and Cloudflare AI Gateway guardrails. These are similar classifier or identity offerings with no distinct design lesson for Claude Desk beyond those above.

---

## 4. Cross-cutting observations

1. **Two families, and the boundary is consistent:**
   - *Deterministic policy decision points* (Kastra, AgentCore/Cedar, OPA/Cerbos/Permit/Oso, the Harden floor, Invariant rules, CaMeL) make the **authorization decision**.
   - *Model classifiers* (Lakera, Prompt Shields, Model Armor, PromptGuard, NemoGuard, Harden's advisor model) produce **signals**.
   - Even vendors with models keep the deterministic engine authoritative: Harden's model has zero authority, AgentCore uses the LLM only to *author* Cedar, and Oso says agents aren't reliable enough to control authorization.
2. **Identity standards stop at the connection.** MCP OAuth, A2A schemes and Web Bot Auth tell you *who is connected* and *with what scopes*. Every source that discusses it (Permit, AWS, A2A §7.5) says per-call authorization is a separate layer.
3. **Outgoing-message gating is the least mature area.** Products screen outputs for injection, PII, toxicity or URLs (Lakera, Model Armor, NeMo output rails, LLM Guard, now archived). We found no product that enforces *business* rules on replies, such as "never quote below the floor price", "never promise a slot that isn't booked", or "never reveal document X to an unverified visitor". Claude Desk has to build this.
4. **Human approval is converging on one shape:** allow / deny / **hold-for-human**, with full context shown and a timeout that defaults to deny. Examples are Kastra Hold, Harden Ask (blocks and queues by default), Auth0 CIBA with RAR, and A2A `AUTH_REQUIRED`.
5. **Audit is converging on signed, hash-chained decision logs** that record the matched policy (Kastra, Harden's local store, AP2's mandate chain).

---

## 5. Implications for Claude Desk

1. **Adopt one deterministic, default-deny gate on every tool call**, enforced in a Claude Agent SDK `PreToolUse` hook with `dontAsk` mode. It returns ALLOW / DENY / HOLD. Never rely on `canUseTool`, which is skipped for auto-approved tools.
2. **Adopt Cedar, embedded, as the owner-rules language.** Mirror AgentCore:
   - Principal attributes (anonymous / verified-email / verified-phone, customer ID) come only from Claude Desk's own session token, never from the model.
   - Tool arguments (price, slot, document ID, amount) are bounded by `when`/`unless` conditions.
   - Tools that are always denied are hidden from the tool list per visitor tier.
   - Owners may author rules in plain English that are compiled to Cedar, but only if schema validation passes and the diff is shown back to the owner.
3. **Treat "send message to customer" as a tool and gate it like one.** We found no product that enforces business rules on replies. Deterministic checks come first:
   - Any price or quote must match the server-side price table.
   - Any commitment (booking, discount, refund) must correspond to a tool call that the gate approved.
   - Any document link or content must have been released to *this* verified identity.
   - Then run a classifier pass (Model Armor or Lakera, for PII and malicious URLs) as a non-authoritative signal that can push a reply to HOLD.
4. **Mirror Harden's "hard floor":** a short, code-level set of invariants that owner configuration can't relax. Examples:
   - Never send owner-private data to an unverified party.
   - Never change payment amounts away from server pricing.
   - Never release a document without an OTP- or magic-link-verified identity that matches the release rule.
   - Fail closed if the gate errors.
5. **Mirror CaMeL and Invariant dataflow labels lightly.** Tag every retrieved chunk or document with `source` and `audience`, and check at output sinks (reply, email, A2A response) that the recipient is within the audience. This is how "release documents to verified people" stays deterministic.
6. **HOLD means owner approval, CIBA-style.** Push, SMS or email the owner the exact action and parameters (RAR-like), with an expiry that defaults to deny (Kastra is reported to use 3 minutes; tune per action). Optionally adopt Auth0 (CIBA plus visitor OTP and magic link) if building it yourself slips. Otherwise use your own signed approve/deny links.
7. **Identity:** visitor OTP or magic link issues a short-lived session with verified claims. Inbound MCP follows the 2025-11-25 / 2026-07-28 auth spec (CIMD, `resource`, `insufficient_scope` step-up). Inbound A2A gets a **signed Agent Card**, a public card versus an extended card after auth, and `AUTH_REQUIRED` that routes to a *human* OTP. Verify Web Bot Auth signatures when present, but log them only as operator identity. Another agent's identity never stands in for the customer's.
8. **Payments:** keep card data out of the agent entirely. Server-priced Stripe Checkout or payment links only. Mirror AP2 by storing a signed "open mandate" (owner's standing rules) and a "closed mandate" (the exact cart the customer confirmed) in the audit chain. Defer AP2 and ACP acceptance to phase 2: AP2 is v0.2 pre-release, and ACP SPT APIs are partly private preview.
9. **Use classifiers only as defense in depth on inbound content:** PromptGuard 2 (self-host) or Lakera/Prompt Shields on visitor messages and tool outputs. Even the best combined setup in the LlamaFirewall paper leaves 1.75% attack success on AgentDojo, so the gate, not the classifier, must make any action safe.
10. **Avoid, and copy the ops patterns instead:**
    - Avoid adopting Harden or Kastra (built for desktop coding agents; Kastra's SDKs aren't shipped and its open-source claim is unverified), archived LLM Guard, enterprise suites (Prisma AIRS, Prompt Security, Okta XAA), and any design where a model judge is the final say.
    - Copy their ops patterns: shadow mode before enforce, replaying rules against past transcripts, and a hash-chained decision log recording the matched rule. That log becomes the owner's "why did my agent do that" view.
