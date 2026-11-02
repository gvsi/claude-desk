# Review: Claude Desk spec and master plan v1 (GPT-6 Astra)

- **Reviewer:** GPT-6 Astra (extra-high reasoning)
- **Date:** 2026-10-28
- **Target:** the design spec and master plan v1 (commit `40d302a`)

Findings were triaged into master plan v2; some were declined. This is the review as written, lightly edited for publication.

**Fix the kernel trust boundary before writing the subsystem plans.** Both documents were read in full.

**Safety blockers: trust and disclosure**

1. **Blocker — The API can manufacture authority.**  
   **Location:** [Master — Kernel HTTP API](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L148).  
   `/decide` and `/check_reply` trust a caller-supplied `Principal`; `/approvals/sign` trusts the API’s assertion that an owner answered; `/policy/activate` carries no owner authorization. A compromised API can impersonate a verified customer, request approval signatures, or install generous owner policies without stealing a business credential. Localhost does not prevent this.  
   **Fix:** Make the kernel authoritative for sessions, verification and owner grants. Accept session references instead of asserted identities. Require independently verifiable owner authorization bound to the exact approval or policy change. Forwarded bearer credentials alone do not establish fresh owner consent against a compromised API.

2. **Blocker — Database and AWS permissions can bypass the kernel.**  
   **Location:** [Master — Architecture](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L7), [Task 2 — database](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
   No database privilege boundary is specified. API write access to policies, principals, facts or native booking records would bypass authorization; broad read access would bypass privacy. ECS task-role permissions are available to containers throughout the task, so granting runtime secret retrieval to the kernel’s task also grants it to the API. [AWS task-role documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html).  
   **Fix:** Specify separate database roles and kernel-owned authoritative tables. Inject business secrets only into the kernel through the execution role; give the shared runtime task role no access to those secrets. Test forbidden database writes and secret retrieval from the API container.

3. **Blocker — Check-then-reveal is voluntary for a compromised API.**  
   **Location:** [Master — Architecture and Global Constraints](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L7), [Shared contracts — `ReplyVerdict`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L135).  
   The API owns SSE and can send unchecked text, alter an approved reply, or replay private content it previously received. A plain `ReplyVerdict` does not enforce release. Signing replies prevents alteration only if the client verifies them; it does not protect plaintext already available to the API.  
   **Fix:** Use kernel-signed reply envelopes bound to recipient, session, turn, sequence and exact content, verified by the independently hosted client. For confidentiality against API compromise, keep private payloads out of the API and use kernel-mediated delivery. Otherwise explicitly exclude API compromise from the confidentiality guarantee.

4. **Blocker — Free-text extraction cannot provide the promised deterministic commitment guarantee.**  
   **Location:** [Spec — Decisions log, enforcement and defaults](../specs/2026-10-28-claude-desk-design.md), [Master — `ReplyDraft`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L129).  
   Haiku extraction plus a list of cited facts cannot prove that arbitrary English or Spanish contains no additional promise. A reply can cite a valid quote while adding “future repairs are included,” or cite availability while claiming a confirmed booking. Citation existence is insufficient.  
   **Fix:** Replace commitment-bearing prose with typed reply clauses rendered from authorized facts and approved bilingual templates. Bind each clause to its fact, fields, status and expiry. Unrestricted model prose cannot retain the absolute “no off-charter promise” guarantee.

5. **Blocker — Fixed demo codes cannot establish possession of a contact.**  
   **Location:** [Master — Global Constraints, verification](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L22), [Spec — Verification and messages](../specs/2026-10-28-claude-desk-design.md).  
   A visitor who knows a seeded contact can submit `424242` without accessing that person’s inbox. Expiry, attempt limits and delivery to the correct record do not change this. Calling the resulting session genuinely verified conflicts with private-document protection.  
   **Fix:** Preserve fixed codes, but explicitly scope them to synthetic demo identities and documents. Record `assurance=demo`, isolate the fixture data, and prohibit this assurance from authorizing real private records. Present the demonstration as simulated verification.

**Safety blockers and audit integrity**

6. **Blocker — Tool profiles do not establish the actual operation or resource owner.**  
   **Location:** [Spec — Tool profiles and confirming profiles](../specs/2026-10-28-claude-desk-design.md), [Master — `ToolProfile`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L86).  
   Model-drafted effects and argument paths can misclassify a private read or use caller-supplied ownership. Owner approval cannot make an unprofiled operation satisfy unknown baseline requirements. Stripe currently exposes generic `stripe_api_read` and `stripe_api_write` tools; one profile per tool name cannot capture their different operations. [Stripe MCP documentation](https://docs.stripe.com/mcp).  
   **Fix:** Start with a narrow operation allowlist and reviewed adapters. Resolve ownership, totals, currency and recipients from authoritative records. Pin the operation mapping, profile and server/account identity. Disable unknown operations—even after approval—until baseline checks are possible. A pinned schema does not prove unchanged server behavior.

7. **Blocker — Labels do not cover all data paths, and untrusted text can become “facts.”**  
   **Location:** [Master — `Label`, `Fact`, `ExecResult`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L113), [Spec — Runtime enforcement](../specs/2026-10-28-claude-desk-design.md).  
   `ExecResult.output` is unlabelled; transcript history, knowledge, whispers, errors and receipts have no propagation rules. Tool output labelled public is still untrusted and must not become authorization evidence. The reviewer can receive visitor instructions embedded in action arguments or tool text despite never receiving the original message.  
   **Fix:** Separate confidentiality labels from source authority. Filter before model access, propagate restrictions through derived content, and validate tool results into typed facts. Give reviewers bounded structured inputs. Keep whispers owner-only and outside policy authority. Apply release checks to cards, errors, attachments and links; disallow arbitrary HTML and remote-image rendering.

8. **Blocker — Cedar’s three-way decision and reviewer restriction are not defined.**  
   **Location:** [Master — Global Constraints](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L20), [Rust module surface](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L157).  
   Cedar returns Allow/Deny, not Hold. A failed permit must not automatically become approval-eligible. Also, putting `context.review` inside a permit does not guarantee that it only restricts existing authority: another permit, or an `OR`, can broaden access. Cedar skips errored policies, including forbids. [Cedar authorization semantics](https://docs.cedarpolicy.com/auth/authorization.html).  
   **Fix:** Define explicit execution eligibility, auto-allow and approval eligibility, with refusal/error precedence. Prove both `AutoAllow(request, review) ⇒ OwnerAutoAuthority(request)` and the independent baseline for every valid review value. Enforce the allowed policy structure during compilation. Use bounded integer scores, define partial-evaluation errors/timeouts, and fail closed.

9. **Blocker — Approval and execution lack the bindings needed to prevent stale or duplicate actions.**  
   **Location:** [Master — Review Focus](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L36), [Kernel HTTP API](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L148).  
   Token contents, expiry, consumption and execution transitions are unspecified. Approval can race cancellation, policy changes, tool changes or another execution. “Visitor left” and “run cancelled” need different semantics. Procrastinate retries are not an exactly-once side-effect guarantee, and stalled jobs require explicit recovery. [Procrastinate recovery documentation](https://procrastinate.readthedocs.io/en/stable/howto/production/retry_stalled_jobs.html).  
   **Fix:** Bind approval to the immutable call digest, actor, copy/Desk/session, policy/profile versions, answer, expiry and nonce. Revalidate before execution; consume atomically. Use stable provider idempotency keys and reconciliation after ambiguous failures. Cancelled runs must reject late execution. Persist held runs and enqueue resumption transactionally.

10. **Important — A signed chain does not establish a complete, current ledger.**  
    **Location:** [Master — Ledger API and Rust surface](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L155), [Task 2 — `ledger_entries`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
    A valid prefix remains valid after tail deletion. Concurrent appends can fork without serialized head updates. API-supplied `chain_ok` provides no independent assurance, and no event contract covers verification, cancellation, approvals or policy changes.  
    **Fix:** Canonicalize signed payloads with copy/Desk, sequence, previous hash and key ID. Lock and update each head transactionally; deny API mutation. Persist intent before side effects and record outcomes/reconciliation. Verify against a pinned public key and independently retained signed head. Define typed security events and separate owner/visitor projections.

**Contract and interface gaps**

11. **Important — Demo-copy ownership, visitor sessions and returning identity are conflated.**  
    **Location:** [Master — `Principal`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L80), [Task 2 — copies, people and sessions](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L207).  
    `cd_copy` allocation is not an ownership authorization design. A colleague opening a shared Desk link needs visitor access to the correct copy without becoming its owner. `people.verified_at` cannot authenticate subsequent sessions. `Level` also cannot cleanly express owner roles or an agent acting for a verified human.  
    **Fix:** Separate actor kind, role, assurance, verified subject and delegation. Add session expiry/revocation and scoped verification challenges. Define kernel session/verification calls and require session binding on `/decide`. Add tenant-qualified references and cross-copy isolation tests for every lookup, download and event stream.

12. **Important — “Signed spending limit” is represented as an unsigned number.**  
    **Location:** [Spec — Agent identity and signed limits](../specs/2026-10-28-claude-desk-design.md), [Master — `Principal.agent_limit_cents`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L84).  
    The contract omits the signed grant, trusted issuer, audience, currency, expiry and consumption state. A self-signed declaration proves control of a key, not authority to spend someone else’s money. Repeated individually compliant calls can exceed a cumulative limit.  
    **Fix:** Define a kernel-verified delegation envelope and trusted demo issuer. Specify per-transaction versus cumulative limits; reserve and consume cumulative budgets atomically. Bind grants to the agent, represented person, merchant/Desk, allowed actions and validity period. Keep real agent execution disabled until these tests pass.

13. **Important — Policy drafting, confirmation and activation have no versioned workflow.**  
    **Location:** [Spec — Rules and owner answers](../specs/2026-10-28-claude-desk-design.md), [Master — `PolicyActivation` and `/policy/activate`](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L140).  
    Raw Cedar plus `active/rejected` cannot represent draft cards, proof progress, owner confirmation, stale edits or fallback templates. “Allow only for this person” and “Deny always” have no typed scope. Suggested autonomy increases could silently become permission increases.  
    **Fix:** Add draft, compile/prove, preview/diff, confirm and activate contracts. Bind confirmation and proof artifacts to the same schema/baseline/profile/policy digest and expected previous version. Render cards from the effective policy. Persistent person rules require a verified subject; autonomy increases always require confirmation.

14. **Important — Native business state is missing from the shared schema.**  
    **Location:** [Spec — Native tools and prototype scope](../specs/2026-10-28-claude-desk-design.md), [Master — Task 2](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L200).  
    The declared schema has no defined storage or constraints for appointment inventory, quote validity, document blobs/entitlements or payment state. Generic facts and action JSON do not specify double-booking prevention, expiring quotes, download authorization or whether a payment link was paid.  
    **Fix:** Assign these records and transitions to Plans 01/02. Add typed tool arguments/results, currency and timezone rules, booking uniqueness, document delivery authorization and payment reconciliation. Distinguish available, proposed and committed facts. Replace table-existence-only tests with transactional invariants; the current list also contains 12 tables, not 13.

15. **Important — Handoff, take-over, whispers and translation lack executable contracts.**  
    **Location:** [Spec — Owner conversation controls](../specs/2026-10-28-claude-desk-design.md), [Visitor experience](../specs/2026-10-28-claude-desk-design.md), [Master — Shared contracts](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L73).  
    There is no controller state, take-over epoch, callback request, whisper visibility or translation representation. An in-flight agent can continue executing or reveal a queued reply after Mike takes over. `language="en"|"es"` supplies neither unsupported-language routing nor owner translations.  
    **Fix:** Add conversation ownership transitions that invalidate stale work, authenticated whisper/owner-message operations, callback state and language metadata. Keep translations owner-only. Specify how owner-authored commitments interact with the universal baseline and reply checkpoint.

**Delivery, evaluation and unowned work**

16. **Important — Task 1 does not test the risky toolchain, and its SymCC command is wrong.**  
    **Location:** [Master — Tech Stack](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L9), [Task 1](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L182).  
    Upstream enables SymCC with `analyze`, not `experimental-symcc`; the executable is `cedar`. A version-returning PyO3 function proves neither proof integration nor deployment compatibility. [Cedar CLI features](https://github.com/cedar-policy/cedar/blob/main/cedar-policy-cli/Cargo.toml).  
    **Fix:** Pin matching Cedar library/CLI, cvc5, PyO3 and maturin versions/features. Make the first spike produce a successful invariant proof, a replayable counterexample and fail-closed timeout/error results. Build and import the Python 3.13 extension in the actual Linux deployment image. Define how each invariant maps to a supported SymCC query. [SymCC interface](https://github.com/cedar-policy/cedar/blob/main/cedar-policy-symcc/README.md).

17. **Important — Hosted integration risks are deferred until Sunday.**  
    **Location:** [Master — Schedule and Plan 05](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L162).  
    Express Mode supports sidecars through custom task definitions, but the plan does not exercise that deployment path, worker lifecycle, native dependencies or SSE reconnection early. [AWS sidecar support](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-advanced-customization.html).  
    **Fix:** Deploy a thin vertical slice Thursday/Friday: kernel health, RDS, one checked reply, one held/resumed job and one restricted Stripe MCP operation. Test restart/reconnect, tool inventory and provider idempotency support. Use actual SSE heartbeat bytes and durable event IDs; HTTP/2 PING does not reset ALB idle timeout. [ALB timeout documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html).

18. **Important — The attack gate can pass while the product is unusable or unsafe outside the prompts.**  
    **Location:** [Spec — Enforcement and Decisions layer](../specs/2026-10-28-claude-desk-design.md), [Master — Plan 04](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L177).  
    Fifty hostile conversations do not cover forged kernel calls, cross-copy access, replay, cancellation races, truncation or extraction omissions. An implementation that holds everything can achieve zero violations. Tuning and reporting on the same suite overstates calibration.  
    **Fix:** Run deterministic security/integration tests from the first vertical slice. Separate calibration and held-out attacks; include legitimate task-completion and false-hold rates. Test English, Spanish, mixed-language and unsupported-language cases. Gate rendered output and side effects, not reviewer labels. Report full-turn latency alongside the required finish-to-reveal measurement.

19. **Important — Several promised features have no explicit plan owner or acceptance condition.**  
    **Location:** [Spec — Product and Owner experience](../specs/2026-10-28-claude-desk-design.md), [Master — Plan index](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L172).  
    “Owner APIs” and “owner app” leave knowledge ingestion, setup’s live safety check, People/lead capture, notification policy, Answering-off behavior, reports and deletion unassigned. Website fetching also creates a route toward localhost/kernel or cloud metadata unless explicitly constrained.  
    **Fix:** Add a requirement-to-plan matrix marked real/mock/cut. Assign knowledge and native state to 01/02, workflows to 02, surfaces/share kit to 03, setup attack execution to 04, and lifecycle/deletion to 02/05. Restrict website fetching to public destinations across DNS resolution and redirects. Freeze a reviewed spec revision instead of silently re-exporting before each subsystem.

20. **Important — The schedule has no credible integration buffer or enforceable cut checkpoint.**  
    **Location:** [Master — Schedule](https://github.com/gvsi/claude-desk/blob/1fec277c157eb746d72e09b8b8da203ba6759e53/docs/plans/2026-10-28-00-master-plan.md?plain=1#L162), [Spec — Minimum cut](../specs/2026-10-28-claude-desk-design.md).  
    Friday combines most enforcement work with the conversation runtime; Saturday combines remaining backend work with the entire UI; Sunday combines first deployment, evaluation, agents and documentation. Cutting only vision mocks cannot recover a late kernel or deployment failure.  
    **Fix:** Allocate the first 4–6 builder hours to feasibility and a hosted slice. Require a working quote/book/document/approval path by Friday evening. If it slips, freeze breadth to one business template, a narrow Stripe operation allowlist, synthetic knowledge and controlled bilingual replies; mock agents and remaining vision surfaces. Preserve proofs, labels, reply checks and the attack gate. Reserve Sunday for verification, fixes and documentation.

**Top 5 recommended changes to the master plan**

1. **Replace caller-asserted authority with kernel-owned authorization.** Document session, owner-consent, database, IAM and reply-delivery boundaries, including the exact limits of API-compromise protection.
2. **Replace prose-based safety contracts with typed operations and reply clauses.** Include authoritative resource resolution, fact provenance, label propagation and bilingual rendering.
3. **Specify the security state machines before subsystem work.** Define Cedar eligibility/hold/refuse semantics, proof artifacts, approval consumption, cancellation, idempotency and ledger heads.
4. **Make Task 1 a deployed feasibility gate.** Exercise SymCC counterexamples, the Linux PyO3 build, durable approval resumption, SSE reconnect and a restricted Stripe MCP operation.
5. **Insert a Friday 18:00 scope-freeze checkpoint.** Attach the minimum runnable slice, explicit real/mock/cut ownership, and a Sunday feature freeze to that checkpoint.