# Policy enforcement and authorization for AI agents: best practices for the Claude Desk safety core

Research date: 2026-10-28

Background research for the Claude Desk design; claims are cited, and anything not confirmed from a source is marked UNVERIFIED.

This complements `safety-landscape.md` and `safety-patterns.md`; it does not repeat what they cover: AgentCore basics, OPA/Cerbos/Permit overviews, the CaMeL/FIDES/Progent summary table, the Rule of Two and the lethal trifecta.
Package versions were read directly from the npm, crates.io, PyPI and GitHub APIs on 2026-10-28. Anything else marked UNVERIFIED comes from secondary sources or was not checked against a primary source.

---

## 1. Cedar: current state, TypeScript use, and formal analysis

**Versions (registry data, 2026-10-28)**
- `cedar-policy` crate 4.14.0 (2026-10-17).
- `@cedar-policy/cedar-wasm` 4.14.0 (2026-10-19). Releases are monthly: 4.12 on 07-28, 4.13 on 09-15, 4.14 on 10-19.
- `cedar-policy-symcc` 0.8.0 (2026-10-17), pinned to cedar-policy 4.14.0.
- Cedar has been a CNCF Sandbox project since 2025-10.

**From TypeScript**
- `@cedar-policy/cedar-wasm` ships `nodejs`, `esm` and `web` builds. The wasm file is about 4.2 MB.
- Exports I checked in the 4.14.0 `.d.ts`:
  - `isAuthorized`, `statefulIsAuthorized` (pre-parsed policies and schema, for a hot path), `isAuthorizedPartial`
  - `validate`, `checkParseSchema`, `checkParsePolicySet`, `checkParseEntities`, `checkParseContext`
  - `getValidRequestEnvsPolicy`, `schemaCompleteness`, `formatPolicies`, plus conversions between text and JSON
- `@cedar-policy/mcp-schema-generator-wasm` 0.7.0 (2026-10-22) is new and directly relevant. `generateSchema(stub, toolsJson)` turns an MCP `tools/list` array into a Cedar schema: one action per tool, with typed `context` for its input arguments. It is the same generator AgentCore uses to build a schema from tools. Owner MCP servers can therefore get a schema automatically.
- Also on npm, but not needed: `@cedar-policy/cedar-authorization` 0.2.0 and `authorization-for-expressjs` 0.3.0.

**Schema validation**
- `validate(policies, schema)` type-checks every policy against the entity, action and context types.
- Symbolic analysis requires *well-typed* policies, so validation is a prerequisite and must run on every owner save.

**Formal analysis (SymCC): yes, the invariant is provable**
- SymCC is the Symbolic Cedar Compiler. It compiles policies into SMT-LIB and runs cvc5 1.3.1.
- It has six checks, each with a `_with_counterexample` variant that returns a concrete request plus entity store:
  - `check_never_errors`
  - `check_always_allows`, `check_always_denies`
  - `check_implies` (subsumption), `check_equivalent`, `check_disjoint`
- The README says the compiler and verifiers "have been formally modeled and verified in Lean". SymCert (Torlak et al., FMCAD 2026) is the Lean framework behind this. It verified five analyses that run in an AWS Cedar analysis service.
- **How to state the invariant.** Write a reference "invariant" policy set:

  ```
  permit(principal, action == Action::"release_document", resource)
  when { principal.verified && resource.owner == principal };
  ```

  Then check `implies(baseline + owner_policies, invariant)` for every request environment. If the check holds, then **for all** principals, resources, entity stores and contexts that fit the schema, a permit means `verified ∧ owner`. If it fails, you get a counterexample request.
- **Spending limits work the same way.** Compare `context.amount` against `principal.limit` or a literal, then use `implies` against a reference set. Cedar `Long` or `decimal` are needed (UNVERIFIED: whether symcc supports every extension type; it was not checked).
- **CLI.** `cedar symcc implies|equivalent|disjoint|always-allows|always-denies|never-errors|matches-*` is in the CLI's *experimental* build. A `cedar-policy-cli-experimental-<target>` archive is attached to each release, with `analyze` and `tpe` enabled. It takes `--principal-type`, `--action` and `--resource-type`, needs cvc5 on PATH, prints `✓ VERIFIED` / `✗ DOES NOT HOLD` with a counterexample, and exits non-zero on failure. The README warns that this surface "can change between releases".
- **No wasm or JS binding for SymCC was found.** It needs a cvc5 process.

**What SymCC does not prove**
- It proves policy logic over *attributes*. It cannot prove that `principal.verified` was set honestly.
- Attribute provenance (identity from OTP/JWT, ownership from the database) must be code you trust and test.

**Background**
- Cedar was built with "verification-guided development": a Lean model with proofs (soundness of validation, authorizer properties) plus differential random testing of the Rust code against the Lean model. Sources: "How We Built Cedar: A Verification-Guided Approach" (FSE 2024 Companion, arXiv 2407.01688) and the Cedar OOPSLA 2024 paper.

**Usable from TypeScript within a short build window?**
- Runtime authorization and validation: **yes**, about one day.
- Symbolic proofs: **yes, if run as a CI step or on owner save**. Shell out to `cedar symcc` or to a 50-line Rust binary, with cvc5 in the container. Allow one or two days, mostly for the cvc5 install and the schema.

Sources:
- https://docs.rs/cedar-policy-symcc (0.8.0)
- https://static.crates.io/readmes/cedar-policy-symcc/cedar-policy-symcc-0.8.0.html
- https://docs.rs/crate/cedar-policy-cli/4.11.1/source/src/command/symcc.rs
- https://docs.rs/crate/cedar-policy-cli/4.12.0/source/README.md
- https://www.amazon.science/publications/symcert-verifying-smt-based-policy-analyses (2026)
- https://arxiv.org/abs/2407.01688
- npm `@cedar-policy/cedar-wasm`, `@cedar-policy/mcp-schema-generator-wasm`

---

## 2. Alternatives and complements

**OPA / Rego**
- Version: v1.21.4 (2026-10-23).
- Strengths: a general-purpose Datalog-like language with huge ecosystem reach. Gateways commonly use it to gate `tools/call`.
- Weaknesses for us:
  - No equivalent of SymCC for proving properties (Rego is not designed for decidable analysis).
  - The JS wasm SDK `@open-policy-agent/opa-wasm` is at 1.10.0 and was last modified 2024-11.
  - Rego is harder for owners to read than Cedar.
- Verdict: no advantage over Cedar for Claude Desk.

**OpenFGA / SpiceDB (Zanzibar-style relationship checks)**
- Versions: OpenFGA v1.22.1 (2026-10-28), SpiceDB v1.57.0 (2026-10-20).
- What they answer: "is X related to Y through a chain of relations" (owner of, member of, shared with), at scale.
- Agent-related material in 2026:
  - AuthZed: a LangChain–SpiceDB integration (2026-03-09) and agentic-RAG posts. The thesis is that authorization is hard-coded into the pipeline, never a prompt instruction.
  - OpenFGA: an agent-authorization guide (updated 2026-09).
- Fit: both need a separate server. A small business has shallow relations (customer → their orders and documents), and those fit in Cedar entity attributes or parents loaded from our database per request.
- Verdict: not needed at Claude Desk scale. If the relationship graph grows, use them as the *attribute source* that feeds Cedar, not as a replacement.

**Amazon Verified Permissions**
- Hosted Cedar: $5 per million single `IsAuthorized` calls after the 2025-06 price cut.
- Adds policy stores, an audit trail via CloudTrail, and a Cognito/OIDC token path.
- Offers nothing that embedded Cedar lacks for us, and adds network latency and AWS lock-in. Skip for the prototype.

**Bedrock AgentCore Policy + Gateway: what exactly is enforced**
- **Placement.** The Gateway sits between the agent and its tools (MCP servers, Lambda, OpenAPI/Smithy targets). A Policy engine attached to it evaluates every tool invocation. The model is default-deny with forbid-wins.
- **Principal.** `AgentCore::OAuthUser` comes from the JWT `sub` claim, with other claims available as tags. `AgentCore::IamEntity` is the IAM ARN. Either way, the principal comes from the token and never from the model.
- **Actions.** Each tool is an action named `AgentCore::Action::"Target__tool"`. Wildcard actions are not allowed; tools are grouped by target.
- **Context.** Tool input arguments.
- **`tools/list`.** Treated as a meta-action evaluated *without* argument context. Partial evaluation hides tools that would always be denied.
- **Modes.**
  - The engine runs in `ENFORCE` or `LOG_ONLY`.
  - Individual policies are `ACTIVE` or `LOG_ONLY`; log-only results appear in traces and CloudWatch but are never combined into the decision. This is a good pattern to copy for "shadow" owner rules.
- **Analysis.** Validation against a schema generated automatically from tool definitions. The automated-reasoning analysis exposed is only *always-allow / always-deny* detection. No user-supplied invariants were documented (UNVERIFIED that none exist).
- **Authoring.** Natural language is turned into Cedar, then validated and analyzed.
- **Dogwood (new 2026-08).**
  - An Apache-2.0, Cedar-compatible superset, implemented in Rust, with a `dogwood` CLI.
  - Adds `when temporal { … }` conditions over session history (`formerly`, `count_within`, `sum_within`, …), grouped by the `x-amzn-bedrock-agentcore-policy-session-id` header.
  - Adds `when guardrails { … }` information providers (content-safety scores), which can permit, forbid, or *suppress the response*.
  - Use cases are running spend totals and "requires prior approval in this session". The reference interpreter is reportedly "for exploration and testing, not production" (UNVERIFIED, secondary). No npm package exists.
- **Maturity.** Policy has been GA since 2026-03-03. Enforcement covers MCP tool calls through the Gateway only. It does not police the model's *reply text* or flows between data and recipients.
- **Verdict.** Copy the design (JWT-sourced principal, schema built from MCP tools, log-only policies, temporal counters). Don't adopt the service for a non-AWS prototype.

Sources:
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html
- https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GatewayPolicyEngineConfiguration.html
- https://docs.aws.amazon.com/ja_jp/bedrock-agentcore/latest/devguide/policy-scope.html
- https://dogwood-policy.github.io/dogwood/
- https://aws.amazon.com/blogs/opensource/introducing-dogwood-runtime-verification-for-ai-agents/ (2026-08)
- https://www.infoq.com/news/2026/08/aws-dogwood-agent-policy
- https://aws.amazon.com/verified-permissions/pricing/
- https://authzed.com/blog/langchain-spicedb-integration
- GitHub release APIs for OPA, OpenFGA and SpiceDB

---

## 3. Agent-specific enforcement research: what is deployable now

**CaMeL** (DeepMind, arXiv 2503.18813)
- The repo is a research artifact, last pushed 2025-06 (412 stars).
- Take its *capabilities* idea: every value carries its sources and allowed readers, and policies check that metadata at sinks.
- Don't take the custom Python interpreter.

**FIDES** (Microsoft, arXiv 2505.23643)
- **Now shipped:** `agent-framework-core` ≥ 1.3.0, module `agent_framework.security`, announced 2026-05-20. It is marked experimental and the only samples are in Python.
- Labels:
  - Integrity: trusted / untrusted.
  - Confidentiality: public / private / user_identity.
  - Labels propagate through tool calls, and the most restrictive combination wins.
- Enforcement:
  - Tools declare the context they accept. For example, a write tool can refuse untrusted context, and a public-sink tool can require public confidentiality.
  - `approval_on_violation=True` turns a block into a human-approval request.
  - `auto_hide_untrusted` swaps untrusted text for variable references, which a tool-free quarantined LLM then processes.
- Stated limits: labeling is opt-in (unlabeled tools are treated as trusted and public), propagation is conservative, and the quarantined LLM is single-turn.
- **This is the closest production template for Claude Desk's "private data only to entitled readers" and "violation → hold for owner".** Port the idea to TypeScript; there is no TS package.

**Progent** (Berkeley, arXiv 2504.11703)
- The code is now public at `github.com/sunblaze-ucb/progent` (pushed 2026-10-26).
- Policies are JSON-Schema conditions over tool arguments, each with an allow/forbid effect and a fallback. Z3 checks that LLM-proposed policy updates only narrow privileges.
- Lesson: per-tool argument constraints, with the owner (not the model) as the only one who can widen them.
- Cedar `context` conditions express the same thing, with stronger analysis.

**Rule of Two** (Meta, 2025-10-31)
- Already covered in `safety-patterns.md`. Apply it per *turn and tool*: a call that combines visitor input, private data and an external side effect is held unless the deterministic policy fully covers it.

**MCP gateways in practice**
- MCP spec 2025-11-25 security best practices, as MUST-level rules:
  - No token passthrough. Servers "MUST NOT accept any tokens that were not explicitly issued for the MCP server".
  - Per-client consent for proxy servers.
  - Sessions must not be used for authentication.
  - Session IDs are bound to `<user_id>:<session_id>`.
  - Scopes are minimal and progressive.
- Also in that document: blocking SSRF on OAuth discovery, and `notifications/tools/list_changed` can silently change the tool surface.
- Common practice is gateway-side **tool pinning**: hash the full wire `tools/list` object (name, description, inputSchema) at owner approval, and block or re-approve on any drift.
  - One experiment found pinning the raw wire object caught 7 of 8 rug-pull variants, versus 1 of 8 for pinning only what the approval dialog showed (codeongrass blog; UNVERIFIED, single vendor).
- **Credentials stay in the gateway.** Use a per-server vault and never show tokens to the model.
- **Strip or label tool descriptions as untrusted.** Tool descriptions are an injection channel.

**Capability tokens per call**
- No standard has been adopted yet. Individual IETF drafts:
  - Transaction Tokens for Agents (Raut, rev -05 to -06, 2026-04).
  - Attenuating Agent Tokens (Niyikiza, 2026-03): JWT-based; holders can only narrow which tools and arguments are allowed.
  - AIP (Prakash, 2026-03): Biscuit chains for multi-hop delegation.
- For a single-process prototype, use a **server-minted, HMAC-signed, single-use "ticket"** binding `{session, principal, tool, sha256(canonical args), decision_id, expiry}`. The executor runs only calls that carry a valid ticket, so a held call approved by the owner executes exactly the approved arguments.

Sources:
- https://devblogs.microsoft.com/agent-framework/ (post 5414, 2026-05-20)
- https://arxiv.org/abs/2505.23643
- https://github.com/sunblaze-ucb/progent
- https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- https://codeongrass.com/blog/mcp-tool-shadowing-defenses-detect-poisoned-descriptions/
- https://datatracker.ietf.org/doc/html/draft-oauth-transaction-tokens-for-agents-06
- https://datatracker.ietf.org/doc/html/draft-niyikiza-oauth-attenuating-agent-tokens-00
- https://www.ietf.org/archive/id/draft-prakash-aip-00.html

---

## 4. Audit: tamper-evident logs, lightweight

**The usual recipe, 2026 consensus.** This is also described in an individual IETF draft, `draft-sahu-agent-action-receipts-00` (2026-08), and in several open-source tools (Signet, aisley; vendor claims UNVERIFIED).
- One JSON record per decision: request, policy IDs that matched, decision, ticket, result hash.
- Canonicalize each record with RFC 8785 (JCS).
- Each record includes `prev = sha256(previous record)`.
- Sign each record, or periodic checkpoints, with Ed25519.
- Store hashes of sensitive arguments rather than the raw values.

**What it detects, and its limit.** A hash chain reveals edits, insertions, deletions and reordering to anyone holding the public key. It cannot stop *truncation or wholesale replacement* by someone with disk access. The mitigation is to anchor the chain head off-host periodically.

**Transparency-log option.**
- Trillian **Tessera** v1.0.4 (2026-07-16) implements the C2SP `tlog-tiles` and `tlog-checkpoint` / signed-note formats. Merkle trees give inclusion and consistency proofs, and witnesses can co-sign checkpoints.
- It is overkill for a prototype, but a good later target. Signed-note checkpoints are tiny and compatible.

**Prototype practice.**
- Use an append-only SQLite table or a JSONL file, with a hash chain and an Ed25519 key held outside the agent process.
- Write a signed checkpoint `(size, head_hash)` every N entries or hourly. Send it to the owner's dashboard or email, or a separate bucket, so the owner holds a witness copy.
- Add a `verify` CLI. About half a day.
- EU AI Act Art. 12 logging is cited as the regulatory motivation; the obligation applied from 2026-08-02 (UNVERIFIED for whether it applies to Claude Desk's risk class).

Sources:
- https://ftp.kaist.ac.kr/ietf/draft-sahu-agent-action-receipts-00.txt
- https://blog.transparency.dev/tessera-v1-0-is-here
- https://c2sp.org/tlog-checkpoint
- GitHub API for transparency-dev/tessera

---

## 5. Evaluation suites to gate changes (hostile user turn)

| Suite | Status (checked 2026-10-28) | Threat model | Use for Claude Desk |
|---|---|---|---|
| **τ²-bench** (Sierra, arXiv 2506.07982) | PyPI `tau2` 2.4.0 (2026-08-21); GitHub v2.0.0 tag 2026-10-20; leaderboard taubench.com | Customer service with a simulated user and domain policies (airline, retail, telecom dual-control) | **Best harness.** Write a "Claude Desk" domain (policy doc + tools + DB) and run both benign tasks (utility) and *adversarial user personas*. The CRAFT/τ-break attacks covered in `safety-patterns.md` are built on τ-bench. |
| **AgentDojo** (ETH) | PyPI 0.1.35 (2025-10-27); repo pushed 2026-06 | *Indirect* injection through tool outputs; trusted user | Use for owner-MCP-server outputs as the injection channel. Adaptive extension **AutoDojo** (arXiv 2606.15057) shows static defenses collapse under optimization. Run it on the hold/refuse gate. |
| **InjecAgent** (ACL Findings 2024) | 1,054 single-turn cases with simulated tool responses; static | Indirect injection | Cheap smoke test only. It is dated and saturated. |
| **Gray Swan ART** (arXiv 2603.15714, 2026-03 version) | Full dataset shared only with frontier labs and UK AISI / US CAISI; competition environment open-sourced; quarterly arenas | Direct and indirect agent red-teaming; 1.8M attempts, ~62k breaks | Not usable as a public gate. Use its *behavior categories* as a checklist, or commission an arena (UNVERIFIED cost). |
| **AgentHarm** (ICLR 2025; in `inspect-evals` 0.26.0, 2026-10-23) | Public subset | Harmful tasks a *malicious user* asks for | Measures refusal of misuse, not authorization. Run it once. Low priority. |

**Gate recommendation**
- Run on every policy, prompt or model change. The gate has three parts:
  - **Proofs.** SymCC invariants all `VERIFIED`.
  - **Deterministic replay.** A golden set of about 200 recorded calls that must keep their do / hold / refuse decisions.
  - **Adversarial suite.** About 100–300 hostile-visitor scenarios written in τ²-bench format: impersonation, "I'm the owner", discount and refund extraction, document-for-someone-else, injected MCP output, and promise fishing.
- Pass criteria:
  - **0 baseline violations** (hard fail).
  - Attack success rate (ASR) ≤ a threshold on "soft" goals.
  - Benign task success ≥ a threshold, because the utility tax is real.
- Run in Inspect (`inspect-evals`) or τ²'s own runner.

---

## Recommended enforcement design

**Gate placement.** Every tool call, whether native or from an owner MCP server, passes through one in-process gate implemented as the Claude Agent SDK `canUseTool`/PreToolUse hook. The model never holds credentials. MCP servers are reached through our own thin gateway, which:
- keeps per-server credentials server-side;
- pins each approved `tools/list` by SHA-256 of the wire object;
- generates the Cedar schema with `@cedar-policy/mcp-schema-generator-wasm`.

**Building the Cedar request.** The gate builds the request only from trusted sources:
- **Principal:** a `Visitor`/`Agent` entity whose `verified`, `customerId` and `limits` attributes come from our OTP or signed-token verification, never from model text.
- **Action:** the tool.
- **Resource:** loaded from the owner's database, including `owner` and `readers`.
- **Context:** the arguments, plus server-computed counters (spend this session or day) in the style of Dogwood's `sum_within`.

**Deciding do / hold / refuse.** Evaluate with `cedar-wasm` against three policy sets:
1. **Baseline:** ours, immutable, mostly `forbid`.
2. **Owner auto-permits.**
3. **Owner hold-permits.**

The decision rule:
- Baseline forbid → **refuse**.
- Otherwise an auto-permit → **do**.
- Otherwise a hold-permit → **hold**, with an HMAC ticket bound to the exact arguments, executed only after the owner approves.
- Otherwise → **refuse**.

**Proving invariants.** Before any owner policy is activated, the cedar CLI or a Rust helper with cvc5 proves `implies(baseline ∪ owner_auto, invariants)` for each invariant, for example "release_document ⇒ verified ∧ owner" and "refund ⇒ amount ≤ limit". Counterexamples are shown to the owner. New rules can run in log-only mode first, as in AgentCore.

**Checking replies.** Tool results carry FIDES/CaMeL-style labels: allowed readers and integrity. A deterministic reply checker:
- blocks any value whose label does not include the verified principal;
- allows commitments only as references to IDs that a permitted tool actually issued.

Every decision goes into a hash-chained, Ed25519-checkpointed log that the owner can verify.

## What is realistic within a short build window

**Day 1–2**
- Cedar schema (native tools plus generated MCP schemas), baseline policies, the three-set decision function in `cedar-wasm`, and the PreToolUse hook.
- Unit tests built from a golden decision table.

**Day 3**
- SymCC proof step in CI: cvc5 plus the experimental `cedar symcc implies` with 4–6 invariants and counterexample display.
- Owner policy save → validate → prove → activate.

**Day 4**
- Hold flow with HMAC tickets.
- MCP gateway with credential vault, tool-hash pinning and a re-approval prompt on drift.

**Day 5**
- Reader labels on tool results and the deterministic reply checker (commitment-ID and private-field rules).
- Hash-chained audit log, checkpoints and a verify CLI.

**Day 6–7**
- About 50 hostile-visitor τ²-style scenarios plus an AgentDojo-style injected-MCP-output set, wired as a gate with 0 baseline violations as the pass bar.

**Out of scope for this build window:** full CaMeL/FIDES taint propagation through model reasoning, Tessera or witnessing, Dogwood, and OpenFGA/SpiceDB.
