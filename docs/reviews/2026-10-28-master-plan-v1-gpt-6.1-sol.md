# Review: Claude Desk spec and master plan v1 (GPT-6.1 Sol)

- **Reviewer:** GPT-6.1 Sol (extra-high reasoning)
- **Date:** 2026-10-28
- **Target:** the design spec and master plan v1 (commit `40d302a`)

Findings were triaged into master plan v2; some were declined. This is the review as written, lightly edited for publication.

**Fix the kernel trust boundary before writing subsystem plans.**

### Blockers: authority and disclosure

1. **Blocker — The kernel trusts identities supplied by the process it is meant to constrain.**  
   **Location:** Master plan, [Shared contracts / Kernel HTTP API](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L148).  
   `/decide` and `/check_reply` accept a caller-created `Principal`; `/approvals/sign` trusts authentication performed by the API. A compromised API can impersonate a verified person or owner without stealing any business credential. **Fix:** make the kernel verify session identity independently. Owner approval and policy activation must require confirmation bound to the exact operation, through a kernel-authenticated channel or client-held signing key. A reusable bearer token visible to the API does not solve this threat.

2. **Blocker — Check-then-reveal is unenforceable against a compromised API.**  
   **Location:** Master plan, [Architecture](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L7), [Global Constraints](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L19).  
   The API owns SSE and receives plaintext tool results. It can skip `/check_reply`, replace the verdict, or send one visitor’s data to another. **Fix:** put protected delivery under kernel authority, with audience-bound checked messages and an authenticated channel that keeps private payloads opaque to the API. Otherwise explicitly include the API in the trusted computing base for confidentiality and reply delivery; the current architecture cannot claim compromised-API resistance for either.

3. **Blocker — Credential isolation has no corresponding storage or IAM boundary.**  
   **Location:** Master plan, [Architecture](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L7), [Task 2: database](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
   No database permissions prevent the API from changing principals, contacts, policies, facts or decisions that the kernel trusts. A task role allowed to retrieve kernel secrets would also expose that permission to the API container: [ECS task-role permissions are available to containers in the task](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html). **Fix:** define separate database roles and kernel-owned authoritative tables. Inject secrets only into the kernel through the execution role; give the shared runtime task role no secret-reading or signing permissions.

4. **Blocker — Commitment extraction cannot make arbitrary prose deterministically safe.**  
   **Location:** Spec, [Decisions log: full enforcement and commitment extraction](../specs/2026-10-28-claude-desk-design.md); master plan, [ReplyDraft / ReplyVerdict](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L129).  
   A draft can cite a valid quote while promising something different. Haiku can miss implied, negated or Spanish commitments; citation IDs establish no relationship between facts and prose. **Fix:** use typed reply segments and deterministic English/Spanish rendering for commitments, policies and private disclosures. Validate referenced item, terms, audience and validity period. Keep model extraction advisory.

5. **Blocker — Labels do not cover the actual information-flow paths.**  
   **Location:** Master plan, [Label / Fact / ExecResult](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L113); spec, [At runtime](../specs/2026-10-28-claude-desk-design.md).  
   `ExecResult.output` is unrestricted and unlabelled. There are no rules for derived text, mixed-reader results, outgoing tool arguments, attachments, translations or links. An otherwise permitted message tool could carry private data to an unauthorized recipient. **Fix:** label every output path, make unknown labels deny by default, intersect reader sets when combining data, and enforce labels at every delivery/tool sink. Only trusted adapters may issue authoritative commitment facts.

### Blockers: decisions and execution

6. **Blocker — Owner approval can bypass the baseline.**  
   **Location:** Master plan, [Kernel HTTP API: `/execute`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L150).  
   Execution accepts `hold` plus an approval token without requiring a fresh baseline check. The contract also leaves token scope and replay protection undefined. **Fix:** distinguish immutable refusal from owner-approvable holds. Bind a single-use token to copy, Desk, session, principal, canonical arguments, tool/profile version, policy version, expiry and nonce. Recheck the baseline and consume approval atomically; denial answers must never produce execution authority.

7. **Blocker — The authorization algebra and proof obligations are unspecified.**  
   **Location:** Spec, [Decisions layer](../specs/2026-10-28-claude-desk-design.md); master plan, [Rust module surface](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L157).  
   Baseline preservation alone does not prove that review scores cannot widen an owner’s permissions. The three policy sets and Cedar’s allow/deny-to-hold mapping are undefined. **Fix:** specify `auto_allow = baseline_allowed ∧ owner_auto_eligible ∧ review_pass`, with a separate owner-approval eligibility predicate. Prove both subset relationships for every review value and action type. Reject unauthorized uses of `context.review`, validate finite bounded scores, and define fail-closed behavior for evaluation errors and solver uncertainty. Cedar proofs cannot establish correct identity, labels or adapter behavior; those need separate obligations.

8. **Blocker — Model-drafted tool profiles can create their own enforcement blind spots.**  
   **Location:** Spec, [Tool profiles / Confirming profiles](../specs/2026-10-28-claude-desk-design.md); master plan, [ToolProfile](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L86).  
   A malicious description can cause a private read to be classified as harmless and enabled quietly. Approval cannot repair an unprofiled tool whose effects remain unknown. Stripe’s current MCP also exposes generic API read/write tools, so tool-name pinning alone does not identify the operation. **Fix:** ship trusted mappings for a restricted Stripe method allowlist; validate method, resource, arguments and output. Keep unsupported tools disabled. [MCP annotations are untrusted](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/server/tools.mdx); [Stripe documents the generic tools](https://docs.stripe.com/mcp#tools).

9. **Blocker — Decisions are not bound to authoritative resources or execution-time state.**  
   **Location:** Master plan, [ToolCall / Decision](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L96), [Review Focus](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L31).  
   Profiled arguments can claim a record owner, amount or recipient without proving the underlying resource agrees. An allowed decision may also outlive a revoked policy, changed tool or occupied booking slot. **Fix:** resolve resource ownership and financial/time fields inside the kernel; persist an immutable normalized action. Revalidate current authority and resource versions during execution. Add atomic booking reservations, durable idempotency keys and reconciliation after ambiguous external success. Cancellation must invalidate pending execution authority.

10. **Blocker — Demo-copy isolation and shared public links have no authorization model.**  
    **Location:** Master plan, [Global Constraints: copies](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L25), [Task 2: database](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207); spec, [First visit and hosting](../specs/2026-10-28-claude-desk-design.md).  
    A colleague opening another demo visitor’s public link must address that visitor’s Desk without acquiring owner rights to its copy. Neither routing nor kernel contracts establish this distinction. **Fix:** separate owner-copy authority from public Desk addressing and visitor-session authority. Enforce copy/Desk scope on every resource lookup, fact citation, approval, inbox entry and Stripe object. Test cross-copy requests directly.

### Important: integrity and shared contracts

11. **Important — A signed chain does not establish an intact, complete ledger.**  
    **Location:** Master plan, [Rust Ledger surface](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L160), [ledger table](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
    Caller-supplied `prev_hash` permits signed forks unless the kernel owns a serialized head. Valid signatures alone do not detect tail deletion or replacement with an older valid chain. **Fix:** use transactional per-Desk sequence/head updates, canonical serialization and signed copy/Desk/version identifiers. Anchor heads independently and pin the verification key. Persist intent before side effects and reconcile outcomes; redact credentials and private content from traces.

12. **Important — Verification lacks a challenge contract, and fixed codes cannot substantiate real identity.**  
    **Location:** Spec, [Verification and messages](../specs/2026-10-28-claude-desk-design.md); master plan, [Principal](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L80), [Task 2](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
    No challenge binds contact, person, session, expiry, attempts and consumption. `people.verified_at` must not make subsequent unrelated sessions verified. **Fix:** add kernel-owned challenge creation/verification and session-bound verification state. Keep the locked fixed codes, but restrict that path to synthetic demo records and label identity verification as simulated. Public visitors must not receive unrestricted access to the copy’s Demo inbox.

13. **Important — A numeric agent limit is not a signed delegation.**  
    **Location:** Spec, [Agent signed limits](../specs/2026-10-28-claude-desk-design.md); master plan, [Principal](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L80).  
    `agent_limit_cents` omits signer trust, currency, payee, permitted operations, expiry, replay protection and cumulative spending. Repeated individually permitted purchases can exceed the intended budget. **Fix:** define a verified delegation envelope and atomic reserve/commit/release accounting. Separate actor kind from verification level so a verified human’s agent is representable. A visitor’s spending delegation must never authorize withdrawals or refunds from the business.

14. **Important — Policy activation has no reviewable, atomic lifecycle.**  
    **Location:** Spec, [Policy, per door](../specs/2026-10-28-claude-desk-design.md); master plan, [PolicyActivation / `/policy/activate`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L140).  
    Raw Cedar goes straight to activation; there is no draft, exact owner-confirmed diff, expected previous version or binding between proof and activated artifact. **Fix:** add draft → validate/prove → owner-confirm → atomic activation. Bind confirmation and proof to hashes of policy, schema, baseline and relevant profiles. Reconfirm template fallbacks. Persistent approval answers must enter this same flow; whispers must not silently become rules.

15. **Important — Required business resources and knowledge handling have no shared storage contract.**  
    **Location:** Spec, [Knowledge](../specs/2026-10-28-claude-desk-design.md), [native tools](../specs/2026-10-28-claude-desk-design.md); master plan, [Task 2](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
    Tables/contracts omit authoritative calendar inventory, quote terms, document content/entitlements, payment-provider references and knowledge provenance. Facts alone do not define those resources. **Fix:** assign these stores and adapter contracts explicitly to master/Plan 01. Assign ingestion to Plan 02, including upload limits and website-fetch restrictions against loopback, private networks, metadata endpoints and unsafe redirects. Knowledge/tool text must never acquire policy authority.

### Important: product completeness and delivery schedule

16. **Important — Handoff, takeover, whispers and localization lack lifecycle contracts.**  
    **Location:** Spec, [Owner experience](../specs/2026-10-28-claude-desk-design.md), [Visitor experience](../specs/2026-10-28-claude-desk-design.md); master plan, [Shared contracts](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L73).  
    There are no states/calls for owner availability, callback collection, takeover or whisper visibility. A queued model reply can appear after takeover; a whisper or owner-only translation can reach the visitor. **Fix:** add conversation ownership states and generation fencing, typed message visibility, handoff/callback records, language detection and owner-only translations. Apply release checks to every visitor-visible message/card.

17. **Important — Task 1 tests the easiest part of the riskiest dependency.**  
    **Location:** Master plan, [Task 1: Toolchain and repo scaffold](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L182).  
    Printing versions and importing `version()` do not establish that proofs, partial evaluation or deployment work. The installation command’s `experimental-symcc` feature is wrong; the current CLI exposes [`analyze`](https://github.com/cedar-policy/cedar/blob/main/cedar-policy-cli/Cargo.toml). **Fix:** spend the first four builder-hours on a pinned compatibility spike: safe proof, unsafe counterexample, timeout failure, review-dependent evaluation, and Python 3.13 import in the target Linux architecture. Package Cedar/cvc5 in the runtime image and record supported versions.

18. **Important — Deployment and durable resume are deferred until the last integration day.**  
    **Location:** Master plan, [Schedule](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L162), [Plan index](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L172).  
    Worker placement, supervision, migrations, run checkpoints and SSE reconnect behavior remain undefined. **Fix:** deploy a thin slice Thursday/Friday. Express Mode needs a [custom task definition for sidecars](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_CreateExpressGatewayService.html). Specify application SSE heartbeats, event IDs and authenticated replay; [HTTP/2 PING does not reset ALB idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html). Persist paused run state and explicitly configure [stalled-job recovery](https://procrastinate.readthedocs.io/en/stable/howto/production/retry_stalled_jobs.html).

19. **Important — The evaluation gate can pass a useless system and overfit its reviewer thresholds.**  
    **Location:** Master plan, [Plan 04 and Schedule](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L167); spec, [Decisions calibration](../specs/2026-10-28-claude-desk-design.md).  
    Zero attack violations also describes “hold everything.” Calibrating and reporting on the same small suite gives misleading performance evidence. **Fix:** start deterministic boundary tests Thursday; separate calibration and held-out cases. Gate legitimate completion as well as attacks. Include forged kernel requests, cross-copy access, stale approvals, restart races, injected knowledge/tool descriptions/whispers, Spanish paraphrases and unchecked cards/downloads. Assert actual effects and disclosures, not model-judged answers alone.

20. **Important — The schedule lacks a bounded core and explicit ownership for required product work.**  
    **Location:** Spec, [minimum cut](../specs/2026-10-28-claude-desk-design.md), [Owner experience](../specs/2026-10-28-claude-desk-design.md); master plan, [Schedule / Plan index](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L162).  
    Friday combines nearly the entire kernel with chat/approvals; Sunday combines evaluations, agents, deployment and documents. The index does not explicitly allocate go-live self-attacks, People/lead handling, notification defaults, deletion, reporting or share-kit behavior. **Fix:** add a requirement-to-plan matrix marking real/mock/deferred. Require a hosted quote → hold → approve → execute → checked receipt → verified ledger slice by Friday evening. If missed, cut live agents and vision mocks immediately; keep template-backed setup and all locked enforcement. Reserve Sunday for evaluation, fixes and documentation.

### Top 5 recommended changes to the master plan

1. **Rewrite the trust boundary:** specify kernel-verified identity, exact owner authorization, database/IAM permissions and protected delivery—or narrow the compromised-API claims explicitly.
2. **Replace the shared contracts:** add normalized actions, authoritative resource references, typed replies, complete labels, verification challenges and signed delegations.
3. **Specify the safety state machines:** define allow/hold/refuse semantics, proof obligations, atomic policy activation, single-use approvals, cancellation, execution reconciliation and ledger anchoring.
4. **Replace Task 1’s version smoke test with a four-hour deployment spike:** prove/counterexample, Linux PyO3 import, restricted Stripe MCP call, ALB SSE and approval recovery after restart.
5. **Rewrite the schedule around Friday’s hosted vertical slice:** move attacks forward, assign every required feature an owner, set the Friday cut gate, and protect Sunday for evaluation and documents.