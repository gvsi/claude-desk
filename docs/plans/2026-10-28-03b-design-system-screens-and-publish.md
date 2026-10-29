# Claude Desk Prototype — Plan 03b: Design system screens and publish

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill (`.agents/skills/`): a fresh implementer and a task review per task, in the plan's worktree, landing through its PRs after the two-reviewer panel and the project owner's sign-off on their screenshots and recordings (AGENTS.md "Design PRs"). Steps use checkbox (`- [ ]`) syntax for tracking. Browser work follows `.agents/skills/using-browsers`.

**Goal:** The rest of design system v2 on Plan 03a's package: the first-visit intro dialog, the verification, Demo inbox, checkout, rules, integrations and setup components, board stories checked against every design canvas board they cite, and the Design System artifact published from the repository with one repeatable build command.

**Architecture:** Components follow Plan 03a's pattern (plain CSS `cd-` classes over token custom properties plus typed React components in `web/src/ds/components/<Comp>/`, contract-shaped props, stories on fixtures under axe and the copy check). `Boards/*` stories compose the components into the canvas boards and assert the board spec with `expectComputed`, then get a by-eye comparison with rendered references. A build script turns the same sources into the artifact's `project/` folder (tokens, brand book, an IIFE bundle on `window.ClaudeDesk`, previews generated from the stories) for the coordinator to publish.

**Tech Stack:** Plan 03a's `web/` toolchain (Node 24.21.0, React 18.3.1, TypeScript 6.0.3, Vite 8.3.4, Storybook 10.6.2, Vitest 5.0.4 with Playwright 1.64.0), plus esbuild 0.28.2 for the artifact bundle, pinned exactly and published at least two weeks before this plan; `agent-browser` for the by-eye checks (`using-browsers`). References: [Storybook accessibility testing](https://storybook.js.org/docs/writing-tests/accessibility-testing), [Vitest browser mode](https://vitest.dev/guide/browser/), [WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum), [esbuild API](https://esbuild.github.io/api/).

**Spec / master plan:** `docs/specs/2026-10-28-claude-desk-design.md` ("Look and feel"); `docs/plans/2026-10-28-00-master-plan.md` ("Shared contracts v2" and the `events.py` SSE union, "Reply check and visitor-visible text", "Payments (mocked)", "Rivera seed", "Kernel HTTP API v2", "Session state responses", "Fail-closed behavior", "Shared seams", the plan index); Plan 03a (`docs/plans/2026-10-28-03a-design-system-core.md`), whose package, contract types, fixtures, guards and components this plan builds on. Designs: the design canvas's "Claude Desk ·" boards.

## Global Constraints

- Deadline Monday 2026-11-02, with a scope gate Friday 18:00 ("Schedule, lanes and gates"). Never cut: proofs at activation, data labels, reply checks, the attack gate.
- Models: `claude-opus-5-5` (conversations), `claude-sonnet-5-5` (auto reviewer), `claude-haiku-5-5` (soft-promise check, triage, owner translations), set up as "Model cost and latency budget" says, and the same three on every provider: local evals may send the API's and the simulated visitor's calls to Amazon Bedrock (`MODEL_PROVIDER=bedrock`, Plans 02a and 05b), while the hosted demo stays on the Claude API. Structured outputs use `output_config.format`, never forced `tool_choice`, which returns 400 on Opus 5.5 and Sonnet 5.5.
- The API holds only `ANTHROPIC_API_KEY`, the `desk_api` role and the built-in agent's demo key (and locally, with `MODEL_PROVIDER=bedrock`, a Bedrock-only credential that can call nothing but the three models, never the default AWS credential chain and never in production, Plan 02a), sends the kernel no principal, person, level or assurance, and can't write kernel tables ("Trust boundary").
- Every tool call except `send_reply` goes through `/decide` and executes only on a fresh `allow` or a single-use owner approval, both re-decided at execution ("Decision semantics"). Every visitor-visible message, card and status line passes the kernel and leaves through `deliver()`, except the kernel-served items listed under Delivery ("Reply check and visitor-visible text").
- Amounts come only from the kernel; prices, discounts, dates and policies appear only in clauses rendered from facts; documents and messages go only to entitled recipients ("Decision semantics", "Reply check and visitor-visible text", "Invariants").
- Rules: Claude drafts rule cards, `compiler.py` emits Cedar, proofs gate activation, the owner confirms. No hand-written or model-written owner policy is ever activated (the baseline is hand-written and reviewed in the repo). Review scores are integer basis points that can only narrow ("Decision semantics").
- Always-on baseline, each item enforced where named: AI disclosure on every visitor surface and A2A response (static notice, `A2AResponse.disclosure`, soft-promise check); private data only to the verified record owner, recipients only `owner` or `verified_contact`, no `pay_out` for agents, and an `Agent` `charge` requires `principal has mandate_remaining_cents && context has amount_cents && context.amount_cents <= principal.mandate_remaining_cents` (forbids in `cedar/baseline.cedar`, proved by `invariants/always/`); verification codes only to the contact on record (`/verify/start`); no `charge` or `pay_out` without an owner card or approval (step 5, `money_needs_card`); auto-allowed money ≤ the Desk's charter cap `auto_money_cap_cents` (unset is 0, so every charge and payout asks) and never above `AUTO_MONEY_HARD_CAP_CENTS`, the $10,000 platform ceiling per action (baseline forbid, compiler cap, `invariants/auto/`; "Charter money cap"); every attempt logged (same-transaction ledger entries, "Data model").
- Also constraints, each in its section: demo-code verification with no real email, SMS or push; payments fully mocked, with no provider account, SDK or keys; per-visitor copies of the Rivera Plumbing seed, a shared Desk link granting visitor access only; the $500 monthly limit shared by evals and the demo.
- Accessibility: WCAG 2.2 AA contrast for every token pair; status never by color alone; keyboard paths for chat, approvals and take-over; `aria-live` for replies and receipts; reduced motion respected; Plan 03 runs axe on every story.
- Product name "Claude Desk"; copy is sentence case, plain, no door/knock wordplay; footer "Concept prototype by Giovanni Alcantara, not an Anthropic product"; no Claude/Anthropic logos. Design system v2 tokens (warm dark: app #1C1B19, panel #222220, surface #2A2927, selected #3C392F; Source Serif 4 for Claude's voice and titles; Hanken Grotesk UI; clay #E08968 only in the mark and the first-visit intro dialog's illustration; checkpoint results as receipts attached under each message, at every width). Where the design canvas differs from this plan, this plan wins; canvas-only interactions (a counter-offer answer, a translated take-over message) stay static vision.
- Git: small conventional commits, written for readers of the public history, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Specific to this plan:

- **Canvas sources:** only `N-*` boards on "Claude Desk ·" pages, each listed once in `REFERENCE_BOARDS` (Plan 03a Task 3) and checked in Tasks 4–6; where canvas copy conflicts with a contract, the contract wins and `parameters.canvasNote` says so. Parts with no board (Demo inbox, writing state, checkout, setup pieces) use `parameters.canvas: 'none'`, naming the nearest board in `canvasNote`.
- **Dark only:** one theme, `{"id": "dark", "name": "Dark"}`.
- **Tokens only:** raw colors and durations live only in `tokens.json` and `tokens.css`; `--clay` only in `components/Mark/` and `components/IntroDialog/` (the intro illustration's clay field, Task 0); status colors only as 6 px dots or thin bars beside words that say the same thing.
- **Nothing computes or formats money, dates or discounts** in `web/src/ds/` (no `Intl`, `toLocale*`, `Date`, `toFixed` outside tests, stories, fixtures); cards show only the block's kernel-rendered fields (Plan 03a Task 6), rule limits arrive as the consumer's `RuleWord`s (Task 2), other components take display strings.
- **Card chrome is fixed en/es copy** per `ClauseTemplate`, with no amounts, dates or promises. Payment link and payment confirmed cards and the checkout always say "Test payment, no money moves" / "Pago de prueba, no se mueve dinero".
- **Visitor status lines are the kernel's:** a visitor receipt shows exactly the signed event's `visitor_plain`, its dot from one exhaustive table (Plan 03a Task 8). Visitor surfaces show no clock times.
- **Demo inbox codes come only from fetched `DemoInboxEntry` bodies**, never from `EvDemoInbox` notices; a visitor panel renders only `verification_code` entries.
- **Errors are static copy** (Plan 03a Task 5): visitor turns by `EvError.code` (Plan 02's codes), owner requests by `KernelError.code`, every code with a message, never showing the code. Silent turn endings belong to the SSE layer and use no copy.
- **No network:** components and stories never fetch; fixtures hold no prose a reply check would block (Plan 03a Task 2).
- **Accessibility detail:** contrast pairs live once in `CONTRAST_PAIRS` (text 4.5:1, or 3:1 at 24 px and up; 3:1 for the focus ring, dots and the mark); a 2 px `--accent-blue` focus ring at 2 px offset, also on the composer (the canvas's 55% ring is 2.9:1); dots `aria-hidden`; replies and receipts inside the transcript's `role="log"`.
- **Copy and motion:** no "→", all-caps words (two or more capitals outside the acronym list; initials avatars and monograms are `aria-hidden` beside the name as text) or exclamation marks; buttons say what happens; Claude speaks in the first person in serif, people in sans; English and Spanish wherever a visitor reads. Transitions 60–200 ms from `motion` tokens, at most one small moment per screen, all static under `prefers-reduced-motion: reduce`.
- **Task check:** every component task's Step 4 ends with `npm run check:ds` (Plan 03a Task 3: guards, the `ds-browser` project and `tsc --noEmit`).

## What this plan serves

- The rest of the owner's side of "can't be talked around": rule changes shown with their enforced limits before confirming, and a plain review when a tool changes its definition.
- Verification by a code from the Demo inbox, labelled simulated, with the code never reaching Claude.
- A first-time visitor meets one dialog that says what Claude Desk is, lists what to try and takes the passcode, and can't be dismissed without it.
- A first-time visitor sees a clearly labelled test checkout that says no money moves and that they are dealing with an AI.
- Every cited canvas board rebuilt from the components and checked against it, so the app looks like the designs.
- The same tokens and components published as the Design System artifact, built from the repository.

## Interfaces consumed / produced

**Consumed:**
- Plan 03a: the `web/` package, `contracts.ts` types and the Rivera and Chen fixtures, tokens and the brand book, every component and helper exported from `web/src/ds/index.ts` (`receiptFromEvent`, `errorCopy`, `MARK_GEOMETRY` included), `assertCleanCopy`, `expectComputed`, `REFERENCE_BOARDS`, the project-level story hooks and `npm run check:ds`.
- Contracts (through Plan 03a's `contracts.ts`, named as in "Shared contracts v2" and `events.py`): `RenderedBlock`, `ClauseTemplate`, `RuleCard`, `ToolProfile`, `ToolName`, `Effect`, `Assurance` (`demo_code` is labelled simulated), `InboxNotice`, `DemoInboxEntry`, `PaymentLinkState`, `Decision`, `DecisionState`, `SessionMode`, `LedgerEntry`, `LedgerPage`.
- Kernel API models (`kernel_api.py`): `VerifyStarted.message` (the verify card's uniform text, shown by the `verify_prompt` card, never repeated by the form), `PaymentLinkView` (the mock checkout), `PublicDesk` (board stories).
- SSE (`SseEvent`): `EvDemoInbox` (a notice only; codes come from fetched entries), and in board stories `EvMessage`, `EvReceipt`, `EvHeld`, `EvResolved`, `EvOwnerJoined` through Plan 03a's components.
- Components only raise callbacks. Plan 04 screens reach the kernel calls behind them (`GET /demo_inbox`, `GET /payment_links/{token}` with complete and cancel, `POST /verify/check`, `POST /tools/confirm`, `POST /tools/simulate_change`, `POST /policy/confirm`) only through Plan 02's API routes (Plan 04's route table). No kernel endpoint, Rust function, table, prompt or policy is touched, so this plan has no evals gate.

**Produced** (for Plan 04 and the artifact): `IntroDialog`, `IntroThing`, `IntroErrorCode` and `INTRO_ERROR_COPY` with the tokens `scrim`, `shadow-dialog` and `intro-title` (Task 0, shipped early by its own design PR); the components of Tasks 1–3, exported with their `<Comp>Props` from `web/src/ds/index.ts`; `describeEffects`, `ruleDiff` and `RuleWord` (Task 2); `Boards/*` stories as Plan 04's reference compositions and `web/src/ds/reference/README.md` (Tasks 4–6); `build-ds-artifact.mjs` and the published artifact (Task 7).

Component folders are named for their main export; extra exports are documented in the folder's README and get no artifact card. Each task's Files line names the canvas boards its stories cite.

## Review Focus owned

No master Review Focus line names Plan 03 (now 03a and 03b); the matrix's accessibility row and the Global Constraints (axe on every story) do. This plan's share:

| Accessibility requirement | Task and test |
|---|---|
| Status never by color alone | Task 2 `diff_shows_enforced_values` |
| Keyboard paths: chat, approvals and take-over | Task 3 `confirm_names_the_reviewed_hash` (by keyboard); Tasks 4–6 `focus_order_is_logical` and keyboard walks |
| Keyboard paths: the first-visit dialog | Task 0 `tab_stays_inside_with_a_real_keyboard`, `escape_never_closes_it_with_a_real_keyboard` and the `Default` play (focus starts in the field, Enter submits) |
| `aria-live` for replies and receipts | Task 1 `inbox_announces_new_entries` |
| Axe on every story | every story here runs under Plan 03a's project annotations (`parameters.a11y.test = 'error'`, the copy and canvas hooks) |

Supporting tests (the kernel stays the authority) and failure modes this plan owns:

| Scenario | Task and test |
|---|---|
| Owner confirms a rule change → sees the enforced who, limits, hours and review, before and after | Task 2 `same_reason_new_limit_is_changed`, `diff_shows_enforced_values`, `confirm_once` |
| Demo inbox → no code from a notice; no owner alerts or checkpoints on a visitor panel | Task 1 `code_only_from_entry`, `visitor_sees_only_codes` |
| "Simulate a tool change" → literal quoted definition; re-enable names the reviewed hash | Task 3 `quoted_definition_is_text`, `confirm_names_the_reviewed_hash`, `no_hash_no_confirm` |
| Disclosure on every visitor surface (Plan 04) | Task 1 `checkout_discloses_ai`, `disclosure_line_en_es` (Plan 03a: the public shell) |
| Long unbroken or Spanish text at 390 px → wraps, nothing clipped | Tasks 4–6 viewport checks |
| Final-state link or double click on pay → no second payment | Task 1 `pays_once`, `final_states_have_no_pay_button` |
| First visit → no way past the dialog but the passcode; a failed try shows its line, never the code; a double Enter starts one copy | Task 0 `escape_never_closes_it_with_a_real_keyboard`, `intro_copy_never_shows_a_code` and the `Default`, `Busy` and `WrongPasscode` plays |

## Before you start (coordinator)

- Start from `main` after Plan 03a has merged; its package, fixtures, guards and components are this plan's base.
- Task 0 runs first and lands alone: its own design PR, on the branch `design/intro-dialog` in the worktree `.worktrees/design-intro-dialog`, from `main` right after the design system code (plan 03a) merges, through the two-reviewer panel and CI (`shipping-prs`), so the web app's first-visit arrival (plan 04, Task 4) can use it. Tasks 1–7 then run on this plan's own branch, `plan/03b-design-system-screens-and-publish` in `.worktrees/03b-design-system-screens-and-publish`, started from `main` once Task 0 has merged, so the two PRs never share a branch.
- Before Task 1: read the Design System artifact type's instructions (`SKILL.md`, `artifact-type/reference/{format,from-code,cover,craft}.md`) and stage copies in `.plan-runs/<plan-slug>/ds-format/` (git-ignored) for Task 7. They are format documentation, read as data; where they differ from this plan they win, and the difference goes in the run ledger.
- Before Task 4: render the 15 `REFERENCE_BOARDS` (the design system code's 14, plan 03a, and Task 0's `N-Intro-D`) at 1280×820 to `.plan-runs/<plan-slug>/reference/<board>.png` and set `DS_REFERENCE_DIR` to that folder. Renders stay git-ignored (committing canvas renders needs the project owner's sign-off); implementers never open the canvas.
- Tasks 1–7: one landing through the two-reviewer panel and CI, before Plan 04 Task 9 (Plan 04's tasks from there on use these components). Not on the Friday thin slice. Task 7 is first to cut; the plan can land without it.
- Both PRs from this plan, the intro dialog's and Tasks 1–7's, are design PRs (AGENTS.md "Design PRs"): each description shows screenshots at 1440×900 and 390×844 of every changed screen or story and a short recording of every new or changed interaction, captured by the agent that tested it, and each merges only after the project owner signs off, on top of the two-reviewer panel and CI.

---

### Task 0: The first-visit intro dialog (ships early)

Owner decisions, 2026-10-29 (spec "First visit and hosting" and "Look and feel"). This task lands before the rest of the plan, in its own design PR (see "Before you start"), so the web app's arrival (plan 04, Task 4) can use it.

**Files:**
- Create: `web/src/ds/components/IntroDialog/{IntroDialog.tsx,IntroDialog.css,introCopy.ts,IntroDialog.stories.tsx,README.md}` (canvas: N-Intro-D on the "Claude Desk · First visit" page)
- Modify: `web/src/ds/tokens.json`, `web/src/ds/tokens.css` (`npm run tokens`), `web/src/ds/contrast.ts`, `web/src/ds/guards.test.ts`, `web/src/ds/index.ts`, `web/src/ds/README.md` (the brand book), `web/src/ds/components/Mark/` (size 18, for the illustration's reply card), `web/src/ds/foundations/Foundations.stories.tsx`, `web/src/ds/reference/boards.ts` (`REFERENCE_BOARDS` gains `N-Intro-D`, this task's board, so the project's canvas hook accepts the stories that cite it)
- Test: `web/src/ds/tokens.test.ts`, `web/src/ds/components/IntroDialog/introCopy.test.ts`, `web/src/ds/components/IntroDialog/IntroDialog.browser.test.tsx`, the stories

**Interfaces:**
- Consumes: the design system code's (plan 03a) tokens, contrast pairs, guards, icons, `Button`, `Pill`, `Notice`, `Mark`, `Wordmark` and `ConceptFooter`.
- Produces:
  - Tokens. `scrim` `rgba(0,0,0,0.5)`, behind a dialog that blocks the page (decorative: nothing sits on it). `shadow-dialog` `0 4px 8px rgba(11,11,11,0.08), 0 12px 28px -2px rgba(0,0,0,0.24)`, a dialog over the scrim, so `shadow-composer` is no longer the only shadow. Type style `intro-title`: serif 28/35, weight 460, opsz 28, letter-spacing -0.2px. The dialog also adds tokens it alone uses: `line-field` (a text field's 3:1 outline), `size-intro` 880px, `size-intro-illustration` 400px, `shadow-illustration-card` and the illustration's `illustration-*` colors. Each new color is in `CONTRAST_PAIRS` or in `DECORATIVE_COLORS` with its reason, and `clay`'s usage and the brand book name its one place besides the mark.
  - The clay guard. `clay_only_in_the_mark` becomes `clay_only_in_the_mark_and_the_intro_dialog`: clay (`--clay`, `#e08968`, `224, 137, 104`) is allowed in `components/Mark/` and in one more folder, `components/IntroDialog/`, for the illustration's field. The match is by whole folder, so a sibling such as `components/IntroDialogBanner/` is still outside.
  - `IntroDialog({ title; intro; thingsToTry: IntroThing[]; submitLabel; onSubmit: (passcode: string) => Promise<void>; busy?; error?: IntroErrorCode })`, with `IntroThing = { title; detail?; icon?: IconName }`, `IntroErrorCode = 'wrong_passcode' | 'rate_limited' | 'unreachable'` and `INTRO_ERROR_COPY` (`satisfies Record<IntroErrorCode, string>`), all exported from `web/src/ds/index.ts`.
  - What the consumer passes: the title, the intro, the things to try, the button label, `busy` and `error`. What the component owns: the mark and wordmark with a "Demo" pill, the "Things to try" heading, the "Passcode" label, the error lines, the `ConceptFooter` and the illustration. The error lines are `wrong_passcode` "That passcode didn’t work. Check the message that shared this link, then try again.", `rate_limited` "That’s a lot of tries. Wait a few minutes, then try again." and `unreachable` "We couldn’t reach the demo. Try again in a moment."; a code this build doesn't know reads as `unreachable`.
  - The illustration fills the right half: light cards on a clay field, `aria-hidden`, nothing focusable, not drawn under 720 px. Its cards are the product's only light surface, and its names and date are fixed illustration copy, never a real booking.
  - Behavior: a native modal `<dialog>`, opened with `showModal()`, over its own `scrim`, so the page behind is inert. It can't be dismissed: no close button, and a press on the scrim does nothing. Escape does nothing, by two means: the dialog's `keydown` handler calls `preventDefault()` on Escape, so the browser never turns the key into a close request, and the dialog's `cancel` event is also prevented, with `closedby="none"` set where the browser supports it. Preventing `cancel` alone isn't enough, since Chrome lets a page refuse a close request only after a user activation, and a dialog opened on load has had none. The `<dialog>` is labelled by its title (`aria-labelledby`) and described by the intro (`aria-describedby`), so its accessible name is the `title` prop. The passcode field is labelled "Passcode" and is `type="password"` with `autocomplete="off"`, so the passcode never shows on screen. Focus starts in the passcode field and Tab stays inside the dialog. Enter submits once with the trimmed passcode. The button is disabled while the field is empty and reads "Starting" while `busy`, and a second submit before the first settles does nothing. With `error`, the line shows under the field (`role="alert"`, the field `aria-invalid` and described by it) and the field takes focus with its text selected; the code itself never shows. Nothing fetches.

- [ ] **Step 1: Write the failing tests.**
  - `tokens.test.ts`: `intro_dialog_tokens_match_the_board` (the values above, the new contrast pairs and the decorative entries).
  - `guards.test.ts`: `clay_only_in_the_mark_and_the_intro_dialog`, replacing `clay_only_in_the_mark`.
  - `introCopy.test.ts`: `every_intro_error_has_copy`; `intro_copy_never_shows_a_code`.
  - `IntroDialog.browser.test.tsx` (real key presses): `escape_never_closes_it_with_a_real_keyboard` (Escape once before any other input, then twice after typing in the field; after each press the dialog is still open, `dialog.open` is true, and the passcode field still has focus); `tab_stays_inside_with_a_real_keyboard`.
  - Stories `Intro/IntroDialog`, with `parameters.canvas: 'N-Intro-D'` and the board's copy as args (title "A Claude front desk for your business", the four things to try with the icons `person`, `safety`, `check` and `plus`, "Start the demo"): `Default` (a dialog named by its title, "A Claude front desk for your business"; a "Passcode" field of type password with `autocomplete="off"`; no close button; Escape and a press on the scrim leave it open; focus in the field; Enter submits once with the trimmed passcode; empty disables the button), `Busy`, `WrongPasscode`, `RateLimited`, `Unreachable` (each line under the field, the code nowhere in the page) and `Phone` (390 px: no illustration, no horizontal scroll).
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/tokens.test.ts src/ds/guards.test.ts src/ds/components/IntroDialog && npx vitest run --project ds-browser src/ds/components/IntroDialog && npx vitest run --project storybook src/ds/components/IntroDialog` → FAIL.
- [ ] **Step 3: Implement** the tokens (`npm run tokens`), the contrast entries, the guard, the component with its README and the brand book lines.
- [ ] **Step 4: Run** the same commands plus `npm run check:ds` → PASS (4 unit tests, 2 browser tests, 6 stories).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add the first-visit intro dialog that takes the demo passcode, with its tokens"`, then land it as its own design PR, with the stories' screenshots and a recording of Escape, Tab and a wrong passcode in its description, after the project owner signs off.

### Task 1: Verification, the Demo inbox, the mock checkout and the disclosure line

**Files:**
- Create under `web/src/ds/components/`: `VerifyCodeForm/`, `DemoInboxPanel/`, `MockCheckout/`, `DisclosureLine/` (canvas: N-Public-Verify; no board for the other three)
- Modify: `web/src/ds/index.ts`

**Interfaces:**
- Consumes: `InboxNotice`, `DemoInboxEntry`, `Assurance`, `PaymentLinkState` (Plan 03a Task 2); `ReplyCard` (Plan 03a Task 6); `SystemLine` (Plan 03a Task 7); Plan 03a Tasks 4 and 5.
- Produces (every visitor string en / es):
  - `DisclosureLine({ language; businessName? })`: "{businessName} answers with Claude, an AI." / "{businessName} responde con Claude, una IA."; without a name "This page is part of a chat with Claude, an AI." / "Esta página es parte de un chat con Claude, una IA."; never hidden.
  - `VerifyCodeForm({ state: 'idle' | 'checking' | 'failed'; onSubmit: (code: string) => void; onAskForOwner; language })`, under the `verify_prompt` card, which carries the kernel's uniform message (the form repeats no text): an input labelled "6-digit code" / "Código de 6 dígitos" (`inputmode="numeric"`, `autocomplete="one-time-code"`, `maxLength` 6, paste allowed) and "Confirm" / "Confirmar" ("Checking" / "Comprobando" while `checking`); `failed` (wrong, expired or exhausted alike, as the kernel's uniform 422 `invalid`) → "That code didn't work. Check the newest code, or ask me for a new one." / "Ese código no funcionó. Revisa el más reciente o pídeme uno nuevo."; "I can't get the code" / "No me llega el código" → `onAskForOwner`. The screen posts through Plan 02's verify route (kernel `POST /verify/check`); the code never reaches Claude.
  - `VerifiedLine({ text; assurance: Assurance; language })` (from `VerifyCodeForm/`): a `SystemLine` that appends "Simulated verification" / "Verificación simulada" when `assurance === 'demo_code'`.
  - `DemoInboxItem = { notice: InboxNotice; time?; entry: DemoInboxEntry | null; failed? }`; `DemoInboxPanel({ viewer: 'owner' | 'visitor'; items; language; onRetry: (entryId) => void })`: on `--bg-panel`, titled "Demo inbox" / "Bandeja de demostración", subtitle "Stands in for a phone or email inbox. Nothing is really sent." / "Hace de bandeja de teléfono o correo. No se envía nada de verdad.", newest first, in an `aria-live="polite"` region. Each item shows `notice.to` (and `time` for the owner only), then:

| Item | Shows |
|---|---|
| `entry` present (same `entry_id`) | the kind ("Verification code" / "Código de verificación", "Alert" / "Aviso", "Ledger checkpoint" / "Punto de control del registro") and `entry.body` verbatim, which may hold a code |
| `entry: null`, not failed | `notice.preview` and "Opening" / "Abriendo" (`role="status"`); never a code |
| `failed` | `notice.preview`, "Couldn't open this entry." / "No se pudo abrir esta entrada." and "Try again" / "Intentar de nuevo" → `onRetry(entry_id)` |
| `viewer: 'visitor'` and `entry.kind` is not `verification_code` | nothing |

  Empty: "Nothing here yet. Codes and alerts you'd get by text or email show up here." / "Aún no hay nada. Aquí aparecen los códigos y avisos que recibirías por mensaje o correo." The screen fetches bodies when an `EvDemoInbox` notice arrives.
  - `MockCheckout({ title; amount; state: PaymentLinkState; language; busy?; error?; onPay; onCancel })`: the body Plan 04 mounts at `/pay/{token}`, with `PaymentLinkView.title`, its `language` and the page's amount string (it formats nothing). A `DisclosureLine` (no business name) and a held-dot `Pill` "Test payment, no money moves" / "Pago de prueba, no se mueve dinero" top every state; `ConceptFooter` at the bottom.

| `state` | Shows |
|---|---|
| `issued` | title, amount, "This link works once." / "Este enlace funciona una sola vez.", primary "Complete test payment" / "Completar pago de prueba" → `onPay`, secondary "Cancel payment" / "Cancelar pago" → `onCancel` |
| `paid` | handled dot and the check that draws once: "Paid. Go back to the chat to see it there." / "Pagado. Vuelve al chat para verlo allí." |
| `expired` | info dot: "This payment link expired. Ask in the chat for a new one." / "Este enlace de pago venció. Pide uno nuevo en el chat." |
| `cancelled` | info dot: "This payment was cancelled. Nothing was charged." / "Este pago se canceló. No se cobró nada." |
| `unknown` | held dot: "This payment is still being confirmed. The chat will show the result." / "Este pago aún se está confirmando. El chat mostrará el resultado." |

  After one click both buttons disable until `state` changes; `busy` adds `aria-busy`; `error` shows an error `Notice`: "That didn't go through. Reload this page to see where the payment stands." / "No se pudo completar. Recarga esta página para ver el estado del pago."

- [ ] **Step 1: Write the stories:** `Status/DisclosureLine` (`WithBusiness`, `Spanish`), `Verification/VerifyCodeForm` (`Idle` under the fixture `verify_prompt` card, `Checking`, `Failed`, `Spanish`, `VerifiedSimulated`, `VerifiedSimulatedEs`), `Verification/DemoInboxPanel` (`WithCode`, `Opening`, `OpenFailed`, `OwnerAlerts`, `VisitorGivenAlert`, `SpanishVisitor`, `Empty`), `Payments/MockCheckout` (`Issued`, `IssuedEs`, `Paying`, `Paid`, `Expired`, `Cancelled`, `Unknown`, `Error`). Play: `disclosure_line_en_es`; `submits_six_digits` ("482913", Enter → `onSubmit('482913')`); `rejects_non_digits`; `form_does_not_repeat_the_card` (`Idle`: the card's text appears once); `demo_code_is_labelled_simulated` (en and es); `spanish_labels` (`Spanish` and `SpanishVisitor` show their es labels and no English one); `inbox_newest_first`; `inbox_announces_new_entries` (inside an `aria-live="polite"` region); `code_only_from_entry` (`Opening` shows the preview and "Opening", no entry body text); `visitor_sees_only_codes` (`VisitorGivenAlert` shows neither its `alert` nor its `head_checkpoint` body, and no time); `retry_on_open_failure` ("Try again" → `onRetry(entry_id)`); `checkout_discloses_ai` and `test_payment_label_always_shown` (every `MockCheckout` story; Spanish in `IssuedEs`); `pays_once` (two clicks → `onPay` once; `Paying` has both buttons disabled and `aria-busy="true"`); `final_states_have_no_pay_button` (`Paid`, `Expired`, `Cancelled`, `Unknown`); `error_says_to_reload`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project storybook src/ds/components/{DisclosureLine,VerifyCodeForm,DemoInboxPanel,MockCheckout}` → FAIL.
- [ ] **Step 3: Implement** with READMEs (`DisclosureLine`, `DemoInboxPanel` and `MockCheckout` use `parameters.canvas: 'none'`; the checkout follows N-Public-Rivera's type and spacing).
- [ ] **Step 4: Run** the same command plus `npm run check:ds` → PASS (23 story tests).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add the verification code form, the Demo inbox panel, the mock checkout and the AI disclosure line"`.

### Task 2: Rules components

**Files:**
- Create under `web/src/ds/components/`: `CapabilityCard/` (also `describeEffects.ts`), `RuleRow/`, `AlwaysOnList/`, `RuleChangeDiff/` (also `ruleDiff.ts`) (canvas: N-Rules-Rivera, N-Rules-ChatChange)
- Modify: `web/src/ds/index.ts`, `web/src/ds/fixtures/rivera.ts` (`ruleWords`: display words per `rv-*` card, as Plan 04's `ruleWords` renders them)
- Test: `web/src/ds/components/CapabilityCard/describeEffects.test.ts`, `web/src/ds/components/RuleChangeDiff/ruleDiff.test.ts`, the stories

**Interfaces:**
- Consumes: `RuleCard`, `Effect` (Plan 03a Task 2); Plan 03a Tasks 4 and 5.
- Produces:
  - `RuleWord = { field: 'who' | 'limits' | 'hours' | 'review'; text: string }`: the consumer's code-rendered words for what a card enforces (Plan 04's `ruleWords(card, people)`, e.g. "Verified customers", "Discounts up to 10%"); the design system formats none.
  - `describeEffects(effects, reversible): string`, first match wins: `pay_out` "Moves money out."; `charge` "Moves money."; `private_data` "Touches someone's private data."; `send_message` "Sends a message out."; `change` "Changes something."; `read` "Only reads."; then " Can be undone." or " Can't be undone." (`read` alone has no suffix).
  - `CapabilityCard({ title; poweredBy: { kind: 'native' } | { kind: 'integration'; name; initials }; effects; reversible; rules: RuleCard[]; words: (card: RuleCard) => RuleWord[]; fallback; footnote?; onChangeRule? })`: title, "Built in" or the integration pill (initials `aria-hidden`), the effects line, a `RuleRow` per card, `fallback` ("Anything else here: ask me.").
  - `RuleRow({ card; words: RuleWord[]; newNote?; onChange? })`: `card.reason`, the `words` beneath in secondary meta, and an outlined outcome control from `mode` (`auto` "Do it" handled, `ask` "Ask me" held, `never` "Never" refused), named "{reason}: {outcome}. Change"; read-only without `onChange`.
  - `AlwaysOnList()`, lock icons, no controls: "Always says it's an AI", "Private data only to its verified owner", "Codes only go to the contact on record", "No money moves without your rule or a signed limit", "Every attempt is logged and shown to you".
  - `ruleDiff(before: RuleCard[], after: RuleCard[]): RuleDiffRow[]`: rows by `card_id`, `is_default` cards skipped, unchanged cards omitted; `RuleDiffRow = { cardId; change: 'added' | 'removed' | 'changed'; before: RuleCard | null; after: RuleCard | null; fields: RuleField[] }`, `RuleField = 'applies_to' | 'mode' | 'who' | 'limits' | 'hours' | 'review' | 'reason'` (`person_id` and `agent_key_id` count as `who`; `max_amount_cents` and `max_discount_bp` as `limits`).
  - `RuleChangeDiff({ before; after; words: (card: RuleCard) => RuleWord[]; onConfirm; onCancel; confirmDisabled?; pending?; error? })`: a row per `ruleDiff` row marked "Added", "Removed" or "Changed"; a changed row shows "Before" and "After" (outcome word, `words`, reason), each changed line tagged "Changed" in text; no rows → "No rules change." and no Confirm. Primary "Confirm change" (disabled by `confirmDisabled`, Plan 04's proof status, and after one click until `pending` clears; `pending` → "Confirming", `aria-busy`), secondary "Keep my rules"; `error` shows an error `Notice` and re-enables Confirm.

- [ ] **Step 1: Write the failing tests.** `describeEffects.test.ts`: `money_out_wins`, `charge_reversible`, `read_only_has_no_suffix`. `ruleDiff.test.ts`: `same_reason_new_limit_is_changed` (`max_discount_bp` 1000 → 5000, `reason` unchanged → one `changed` row, `fields` `['limits']`); `defaults_and_unchanged_are_omitted`; `added_and_removed_rows`; `subject_change_is_who` (a new `person_id` → `['who']`). Stories: `Rules/CapabilityCard` (`Quotes`, `RefundsViaMockPayments` with integration "Mock payments", initials "MP"), `Rules/RuleRow` (`DoIt`, `AskMe`, `NeverNew`), `Rules/AlwaysOnList` (`Default`), `Rules/RuleChangeDiff` (`RaiseDiscount`, `AddAndRemove`, `ConfirmUnavailable`, `Confirming`). Play: `outcome_named_for_screen_readers`; `always_on_has_no_controls` (no buttons or inputs); `diff_shows_enforced_values` (`RaiseDiscount`: the same reason on both sides, "Discounts up to 10%" before and "Discounts up to 50%" after, the after line tagged "Changed"); `confirm_once` (two clicks → `onConfirm` once); `confirm_disabled_when_unavailable`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/components/{CapabilityCard,RuleChangeDiff} && npx vitest run --project storybook src/ds/components/{CapabilityCard,RuleRow,AlwaysOnList,RuleChangeDiff}` → FAIL.
- [ ] **Step 3: Implement** with READMEs (`RuleRow`'s `canvasNote`: the board shows sentences only; the enforced words are added because the owner confirms what is enforced).
- [ ] **Step 4: Run** the same commands plus `npm run check:ds` → PASS (7 unit, 10 story tests).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add capability cards, rule rows with their enforced limits, the always-on list and the rule change diff"`.

### Task 3: Integrations and setup pieces

**Files:**
- Create under `web/src/ds/components/`: `ToolStatusRow/`, `ToolReviewCard/`, `SubNav/`, `Steps/`, `ToolLabel/` (canvas: N-Settings-Integrations, N-Settings-ToolChanged; `Steps` and `ToolLabel` use `'none'`, following the setup boards)
- Modify: `web/src/ds/index.ts`

**Interfaces:**
- Consumes: `ToolProfile` (Plan 03a Task 2), for the `ToolRowView` `Pick`; `describeEffects` (Task 2); Plan 03a Tasks 4 and 5.
- Produces:
  - `type ToolRowView = Pick<ToolProfile, 'tool' | 'source' | 'effects' | 'reversible' | 'status' | 'description_confirmed' | 'definition_sha256' | 'pending_definition_text' | 'pending_sha256'>`, exported from the components' types and re-exported from `web/src/ds/index.ts`, so both a `ToolProfile` and the API's `ToolRow` fit.
  - `ToolStatusRow({ title; profile: ToolRowView; onReview?; onSimulateChange? })`: `title`, `describeEffects(…)`, and the status in words with a dot: `enabled` handled "On"; `needs_review` held "Needs your review" with "Review"; `disabled` info "Off". While `enabled`, `onSimulateChange` adds a ghost "Simulate a tool change" captioned "Demo only. Changes this tool on the mock payments server so you can see what happens."
  - `ToolReviewCard({ title; integration; profile: ToolRowView; noticed; onTurnBackOn: (definitionSha256: string) => void; onKeepOff: (definitionSha256: string) => void; pending?; error? })` for a `needs_review` tool: held dot, "Needs your review", `noticed` ("Noticed today at 9:14, when the tools were listed again"); in serif `.cd-type-summary`: "{integration} changed “{title}”, so it's turned off until you review it." and "Until you decide, it can't run at all."; "What you confirmed before" with `description_confirmed` and the effects line; "What the integration says now", a `blockquote` labelled "Quoted from the integration. Claude never sees this text; it sees only the description you confirmed." holding `pending_definition_text` as literal text (`.cd-type-trace`, `pre-wrap`, `overflow-wrap: anywhere`, `data-copy="user"`), never parsed as markup; primary "Turn back on" and secondary "Keep off", each called with `profile.pending_sha256`, under "Turning it back on trusts the new definition and checks your rules again before it runs." (kernel `POST /tools/confirm` drafts a version to prove; the tool stays `needs_review` until it is confirmed). Without `pending_sha256` both are disabled under "This change can't be reviewed right now. Reload the page." `pending` disables both with `aria-busy`; `error` shows the screen's message (`conflict`: "The tool changed again while you were reviewing. Review the newest version."). No before/now table or "Turn back on with Ask me" (open question 1).
  - `SubNav({ label; items: { key; label; href }[]; current; linkComponent? })`: vertical links, `aria-current="page"`, `--size-nav-row`; a horizontal scroller at phone width.
  - `Steps({ label; steps; current; done })`: ordered list, current `aria-current="step"`, done "{name}, done".
  - `ToolLabel({ text })`: an inline tool label (icon, `.cd-type-meta`) for setup's `tool_label` messages ("Searched your Claude memory").

- [ ] **Step 1: Write the stories:** `Integrations/ToolStatusRow` (`On`, `NeedsReview`, `Off`), `Integrations/ToolReviewCard` (`CreateRefundChanged`, `Sending`, `ChangedAgain`, `NoHash`), `Navigation/SubNav` (`Settings`), `Navigation/Steps` (`ThirdOfFive`), `Conversation/ToolLabel` (`Memory`, `Website`, `CouldNotRead`). Play: `simulate_only_when_on` (in `On`, absent from `NeedsReview` and `Off`); `quoted_definition_is_text` (`CreateRefundChanged` has no `img` element, the quote's text equals the fixture exactly, and the summary and quote label read as above); `confirm_names_the_reviewed_hash` (Tab to "Turn back on", Enter → `onTurnBackOn` once with the fixture's `pending_sha256`); `no_hash_no_confirm` (`NoHash`: both disabled, notice visible); `current_is_marked`; `current_step_marked`; `tool_label_is_text`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project storybook src/ds/components/{ToolStatusRow,ToolReviewCard,SubNav,Steps,ToolLabel}` → FAIL.
- [ ] **Step 3: Implement** with READMEs.
- [ ] **Step 4: Run** the same command plus `npm run check:ds` → PASS (12 story tests).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add tool status rows, the tool review card, the settings sub-nav and the setup steps and tool labels"`.

### Task 4: Visual check of the owner boards

**Files:**
- Create: `web/src/ds/reference/README.md`, `web/src/ds/boards/TodayNeedsYou.stories.tsx`, `ConversationLive.stories.tsx`, `ConversationAgent.stories.tsx`, `ReviewerArrival.stories.tsx`, `IntroArrival.stories.tsx`
- Test: `web/src/ds/reference/boards.test.ts`, the board stories

**Interfaces:**
- Produces: board stories `Boards/Today, needs you`, `Boards/Conversation, live`, `Boards/Conversation, agent`, `Boards/First visit`, `Boards/First visit, intro` (`layout: 'fullscreen'`, `parameters.canvas` set to the board).

**Board spec** (from the canvas; each board story's play asserts the rows that apply with `expectComputed`):

| Element | Expected |
|---|---|
| Sidebar | width 264px; background `rgb(34, 34, 32)`; right border 1px `rgba(250, 249, 245, 0.12)` |
| Active nav row | height 36px; background `rgb(60, 57, 47)`; radius 8px; 14px/20px weight 420 |
| Page title / greeting | Source Serif 4, 24px/32px weight 460 / 36px/44px weight 300 |
| Content column | max-width 960px; main padding 24px 40px 20px |
| Claude's reply | Source Serif 4, 15px/23px weight 360, color `rgba(250, 249, 245, 0.92)` |
| Visitor bubble | background `rgba(250, 249, 245, 0.06)`; radius 12px; padding 8px 14px; 15px/21px |
| Margin column and receipt | width 220px; gap 24px; 12px/17px, color `rgba(250, 249, 245, 0.64)`; dot 6px |
| Card | background `rgba(250, 249, 245, 0.03)`; border 1px `rgba(250, 249, 245, 0.14)`; radius 12px; padding 20px |
| Secondary button (main) | height 40px; radius 8px; background `rgba(250, 249, 245, 0.1)`; 14px/20px weight 420 |
| Primary button | background `rgb(239, 236, 228)`; color `rgb(28, 27, 25)` |
| Composer | background `rgb(42, 41, 39)`; radius 16px; shadow includes `0px 4px 20px` |
| Concept footer | the exact string, 12px/17px, color `rgba(250, 249, 245, 0.64)` |

- [ ] **Step 1: Write the failing tests.** `boards.test.ts`: `every_reference_board_has_a_render` (with `DS_REFERENCE_DIR` set, `<board>.png` exists for every `REFERENCE_BOARDS` entry and is 1280×820, read from the PNG header; unset, as in CI, it skips with a message); `board_stories_name_reference_boards`. Board stories compose components and fixtures (receipts through `receiptFromEvent`; Conversation, live has the whisper composer and `TakeOverBar` in `ai` mode; First visit has `ReviewerBar`, `Greeting` and the sidebar, its `canvasNote` naming the things-to-try list as Plan 04's; First visit, intro has `IntroDialog` with the board's copy over a still render of Today, its `canvasNote` naming that preview as Plan 04's); play runs the applicable spec rows and `focus_order_is_logical` (Tab reaches the business switcher, the nav in order, then the composer, then on Today the first approval card's first answer after the chips). Each `canvasNote` lists content differences.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/reference && npx vitest run --project storybook src/ds/boards` → FAIL (board stories missing, or spec mismatches).
- [ ] **Step 3: Build the board stories** and fix components (never assertions) until the spec rows pass; a value that truly differs from the canvas goes in the reference README with the reason.
- [ ] **Step 4: Compare by eye** per `using-browsers` (headless `agent-browser`, its worktree session). With `npm run storybook -- --ci` in the background, per board: `set viewport 1280 820`, open `http://localhost:6006/iframe.html?id=<story-id>&viewMode=story`, screenshot to `.plan-runs/<plan-slug>/shots/` and compare with `$DS_REFERENCE_DIR/<board>.png` (type, colors, spacing, radii, hairlines, receipts beside the right messages, at most one motion moment). At `1440 900` and `390 844`, `eval "document.documentElement.scrollWidth <= innerWidth"` is `true` and nothing is clipped. A keyboard walk shows the 2 px blue ring at every stop. Fix deltas in components; rerun Step 2.
- [ ] **Step 5: Record** one line per board in `reference/README.md` (board, story, date, viewports, deltas fixed, deviations kept and why); the renders themselves stay out of the repo.
- [ ] **Step 6: Run** `cd web && npm test && npm run typecheck` → PASS (all unit and story tests).
- [ ] **Step 7: Commit** `git add web && git commit -m "test(ds): check the owner app boards against the design canvas"`.

### Task 5: Visual check of the public boards and take-over

**Files:**
- Create: `web/src/ds/boards/PublicBooked.stories.tsx`, `PublicHandoff.stories.tsx`, `ConversationTakeOver.stories.tsx`
- Modify: `web/src/ds/reference/README.md`

**Interfaces:**
- Produces: `Boards/Public page, booked` (N-Public-Rivera), `Boards/Ask for Maria` (N-Public-Handoff, both states side by side as on the board) and `Boards/Conversation, taken over` (N-Conv-TakeOver: `TakeOverBar` in `owner` mode, `PersonMessage`, the owner composer).

- [ ] **Step 1: Write the board stories** with play assertions: brand header 76px high, padding 0px 40px; the AI disclosure; the composer row per the board spec; the booking card is a `ReplyCard` with template `booking_confirmed`; `SystemLine` "Maria Rivera joined the chat" has `role="status"` and no time (`canvasNote`: the board's time is left out, as no contract carries it); visitor receipts are read-only `MarginReceipt`s stacked under their messages (the `canvasNote` notes the boards draw none, and that the header's phone is the `contact` charter block); `focus_order_is_logical` ("Ask for Maria Rivera", any card action, the composer; on the take-over board, "Hand back to Claude" then the composer).
- [ ] **Step 2: Run** `cd web && npx vitest run --project storybook src/ds/boards/{PublicBooked,PublicHandoff,ConversationTakeOver}.stories.tsx` → FAIL until the stories and fixes land.
- [ ] **Step 3: Compare by eye** as in Task 4 Step 4 at 1280×820 against the three references, then 1440×900 and 390×844, with a keyboard walk; check the Spanish story at 390×844 for clipped buttons.
- [ ] **Step 4: Record** three README lines.
- [ ] **Step 5: Run** `cd web && npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git add web && git commit -m "test(ds): check the public page and take-over boards against the design canvas"`.

### Task 6: Visual check of the verification, rules, safety, switcher and settings boards

**Files:**
- Create: `web/src/ds/boards/ChenVerify.stories.tsx`, `RulesRivera.stories.tsx`, `RulesChatChange.stories.tsx`, `Safety.stories.tsx`, `Switcher.stories.tsx`, `SettingsIntegrations.stories.tsx`, `SettingsToolChanged.stories.tsx`
- Modify: `web/src/ds/reference/README.md`, `web/src/ds/reference/boards.test.ts`

- [ ] **Step 1: Write the failing test and the board stories.** `boards.test.ts` adds `every_reference_board_has_a_board_story` (each `REFERENCE_BOARDS` entry is named by a `Boards/*` story). Stories, with the applicable Task 4 spec rows plus: Chen verify shows `VerifiedLine` with "Simulated verification" and a `document_link` card; Rules shows four capability cards with their rule words and the always-on list; the chat change shows `RuleChangeDiff` with a changed limit; Safety shows the attempts list and one `FullTrace`; Switcher shows the menu open over Today; Settings, integrations shows `SubNav` and both `payments.*` `ToolStatusRow`s; Settings, tool changed shows the `ToolReviewCard` for `payments.create_refund` with a `ToolStatusRow` for `payments.list_charges` still on (`canvasNote`: the board's payment provider is the mock payments server with two tools; no before/now table, open question 1); each has `focus_order_is_logical`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/reference && npx vitest run --project storybook src/ds/boards` → FAIL until the stories and fixes land.
- [ ] **Step 3: Compare by eye** as in Task 4 Step 4 for all seven boards at 1280×820, 1440×900 and 390×844, with a keyboard walk.
- [ ] **Step 4: Record** seven README lines.
- [ ] **Step 5: Run** `cd web && npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git add web && git commit -m "test(ds): check verification, rules, safety, switcher and settings boards against the design canvas"`.

### Task 7: Publish to the Design System artifact (first to cut)

The Design System artifact comes from the "Design System" artifact type; its instructions, staged before Task 1 ("Before you start"), define every file. This task builds the files; the coordinator publishes them to the private artifact (approved by the project owner; no sharing or access changes).

**Files:**
- Create: `web/scripts/build-ds-artifact.mjs`, `web/src/ds/artifact/entry.ts`, `web/src/ds/artifact/storybook-test-stub.ts`, `web/src/ds/artifact/cover.html`, `web/src/ds/artifact/logos-README.md`
- Modify: `web/package.json` (script `build:ds-artifact`, devDependency `esbuild` 0.28.2)
- Test: `web/scripts/build-ds-artifact.test.mjs`

**Interfaces:**
- Consumes: `web/src/ds/index.ts` exports, every `*.stories.tsx`, fixtures, `tokens.json`, `MARK_GEOMETRY`, each component's `README.md`, the staged format documents.
- Produces: `node scripts/build-ds-artifact.mjs --out <dir> [--index-from <file> | --new-index] [--mark-blob <id> --mark-size <bytes>] [--by <name>] [--note <text>] [--check]`, writing `<dir>/project/` and `<dir>/publish-files.json`.

Output under `<dir>/project/`:

| Path | From |
|---|---|
| `tokens.json` | `tokens.json` without `motion`, plus `meta` (`source` "github", `repo` from the git remote, `ref` `<branch>@<short sha>`, `package` "web", `paths`, `components` mapping each to its `.tsx`, `synced`) |
| `README.md` | the brand book plus a "Not synced" note: motion tokens live in `bundle.css`; fonts are Google-hosted; components were built from the repository |
| `components/bundle.js` | esbuild of `artifact/entry.ts` (`window.ClaudeDesk = { ...components, fixtures, previews }`): `format: 'iife'`, minified, `process.env.NODE_ENV` `"production"`, a resolver plugin mapping `react`, `react-dom` and `react/jsx-runtime` to `window.React` / `window.ReactDOM` (JSX runtime shimmed over `createElement`) and `storybook/test` to the stub (`fn` returns a no-op; play functions never run); `previews` maps each component to its stories (`story.render?.(args) ?? createElement(meta.component, args)`, args merged, decorators applied); line 1 `/* @ds-bundle: {"format":4,"namespace":"ClaudeDesk","components":[{"name":"…"}…]} */` |
| `components/bundle.css` | `:root` motion properties, `.cd-type-*`, `base.css` and every component's CSS (no token properties: the page generates those from `tokens.json`) |
| `components/index.d.ts` | every exported `<Comp>Props`, the contract types they name, and `export declare function <Comp>(props: <Comp>Props): JSX.Element` per component (TypeScript compiler API) |
| `components/<Comp>/README.md` | copied from each component folder |
| `components/<Comp>/preview.html` | generated: line 1 `<!-- @dsCard group="<first segment of the stories' title>" height=<meta parameters.dsCard.height, default 240> -->`, the Google Fonts link, and a script mounting `window.ClaudeDesk.previews.<Comp>`; no `<iframe`, `<frame`, `<object`, `<embed`, `<portal` or `<noscript` |
| `components/Cover/preview.html` | `artifact/cover.html`: mark, wordmark, "A public Claude for your business that answers, books and takes payments under your rules.", a two-message transcript with receipts, the concept footer |
| `assets/Logos/claude-desk-mark.svg` | from `MARK_GEOMETRY`, stroke `#e08968`; an upload, never in `publish-files.json` |
| `assets/Logos/README.md` | `artifact/logos-README.md`: single ink clay `#e08968`, dark grounds only, 16 px minimum, never recolored, never beside a Claude or Anthropic logo |
| `design-system.json` | only with `--index-from` or `--new-index` |

Index rules: `--new-index` writes the staged `format.md`'s index shape with its `createdOnFiles` marker: title "Claude Desk", namespace "ClaudeDesk", react and react-dom 18 as libraries, a Logos asset group holding `claude-desk-mark.svg` (`blob`, `size`, `image/svg+xml`), `docs.readme` `project/README.md`, `lastChange` `{by, at, via: "Claude Code", note}`. `--index-from` keeps every key of the existing index (marker and `title` included) and changes only `namespace`, `libraries`, the Logos asset record and `lastChange`. An existing index with neither `createdOnFiles` nor `convertedFrom` → exit 1, "Existing index has no marker; not writing over it."

- [ ] **Step 1: Write the failing tests** in `build-ds-artifact.test.mjs` (build into a temp dir): `tokens_have_no_motion_and_one_theme`; `meta_records_the_source` (`source === 'github'`, `package === 'web'`); `bundle_header_lists_every_component` (header JSON parses; names equal the component folders); `bundle_is_safe_to_inline` (no `</script`, no `<!--`, under 6 MB); `previews_are_generated_with_markers` (one per component folder, line 1 matches `^<!-- @dsCard group="[^"]+" height=\d+( subtitle="[^"]*")? -->$`, reads `window.ClaudeDesk`, no forbidden element); `no_forbidden_paths` (no dot segments, `package.json`, lockfiles, `tsconfig.json`, `AGENTS.md`; at most 255 paths); `publish_files_exclude_upload_and_index`; `new_index_has_the_marker` (`createdOnFiles.v === 1`); `index_merge_keeps_unknown_keys` (an extra key and `createdOnFiles.at` survive; `lastChange.by` updates); `refuses_index_without_marker`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit scripts/build-ds-artifact.test.mjs` → FAIL (script missing).
- [ ] **Step 3: Implement** the script, entry, stub, cover and Logos README. `--check` validates the output and renders every preview and the cover in headless Chromium with React 18.3.1 UMD files from `node_modules`, a `tokens.css` compiled as the page compiles it, `bundle.css` and `bundle.js`; requests to `fonts.googleapis.com` and `fonts.gstatic.com` get an empty 200, any other request or any page or console error fails, and each root must be non-empty.
- [ ] **Step 4: Run** `cd web && npx vitest run --project unit scripts/build-ds-artifact.test.mjs && npm run build:ds-artifact -- --out dist/ds-artifact --check` → PASS (10 tests; every preview renders).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): build the Design System artifact files from the repository"`.
- [ ] **Step 6 (coordinator): Publish.** In the worktree:
  1. Re-read the type's instructions (Artifact `read` with `path`); if they changed since staging, update this build first and note it in the run ledger.
  2. Artifact `read` `project/design-system.json`: missing → `--new-index`; present without a marker → stop and report.
  3. If the index records `claude-desk-mark.svg` at the same size, reuse its blob id; otherwise build once without an index, upload `web/dist/ds-artifact/project/assets/Logos/claude-desk-mark.svg` with `asset: true`, and note the `/_blob/<id>`.
  4. `npm run build:ds-artifact -- --out dist/ds-artifact --index-from <saved index> --mark-blob <id> --mark-size <bytes> --by "Giovanni Alcantara" --note "Synced from web/src/ds at <sha>" --check`.
  5. One Artifact `publish` with `url` (the artifact), `root` the absolute path of `web/dist/ds-artifact`, `file_path` the absolute path of `project/design-system.json`, `files` from `publish-files.json`; no `capabilities` or `contract`. Re-read the index first if more than a few minutes have passed.
  6. Verify: Artifact `read` `project/README.md` and `project/tokens.json`; in the QA Chrome (`--cdp 19232 --pin-tab`; at a login wall, stop and name the site) check that Colors, Typography, Spacing, Logos and every component card render. Report the link to the project owner only.

---

## Open questions for the master plan

1. **Tool review needs the changed tool's new profile.** N-Settings-ToolChanged shows the new effects, reversibility and payee and offers "Turn back on with Ask me"; `ToolProfile` has only `pending_definition_text` and `pending_sha256`, and `POST /tools/confirm` takes no mode. Proposal: adapter-drafted `pending_effects` and `pending_reversible`, and whether a re-enabled `pay_out` tool forces an ask card.

## Review Ledger

Split (2026-10-29): Plan 03 (the design system plan) became Plan 03a (its Tasks 1–11, PR A below) and this plan (its Tasks 12–18, PR B below, renumbered 1–7: 12→1, 13→2, 14→3, 15→4, 16→5, 17→6, 18→7), so each lands through its own worktree and PR. Tasks moved verbatim; only cross-references changed. `ToolStatusRow` and `ToolReviewCard` stay here: Plan 04 first uses them in its Tasks 12 and 14, after this plan lands. Plan 03's open question 1 is this plan's open question 1; its open question 2 is Plan 03a's. The round-1 ledger below is Plan 03's and uses its task numbers.

Round 1 (2026-10-29): seats GPT-6.1 Sol (1 P1, 8 P2, 2 P3) and Opus 5.5 (1 P1, 10 P2, 12 P3). Major findings and changes:
- Landing: PR A (Tasks 1–11, with a new Task 11) holds every component Plan 04 Tasks 1–8 use; PR B (Tasks 12–18) the rest, the board checks and the artifact.
- Rule confirm: `RuleRow` and `RuleChangeDiff` show the consumer's `RuleWord`s and `ruleDiff` marks changed fields, so a limit change under the same reason is visible.
- Every `KernelError.code` has owner copy; one visitor chat-ended line. Plan 03 owns the seven components Plan 04 was adding; the checkout carries the AI disclosure.
- Toolchain: Node 24.21.0, TypeScript 6 `types`, closed generated types with `ActorKind` and `ToolName`, no setup file, failure screenshots ignored.
- Tests that can fail: hook negatives, emulated reduced motion, `check:ds` (typecheck) in every task, a stronger fixture lexicon, final-state fixtures with answers.
- Canvas renders git-ignored; every cited board is checked (take-over, reviewer arrival, integrations added). Copy: tool review credits the kernel; Spanish in verification and the inbox; no visitor times; honest approval error line; accent decorative.
- Artifact: format documents staged before Task 1; previews generated from stories, fonts stubbed in `--check`; guard scope defined.

Deferred: a pointer instead of the copied Global Constraints (Sol 11, Opus 18): the part-plan brief requires the copy; a coordinator call across plans.

Master plan changes requested: none new; open questions 1 and 2 stand.

Owner decisions, 2026-10-29: the copied Global Constraints now read the auto-money cap as each Desk's charter cap under the $10,000 `AUTO_MONEY_HARD_CAP_CENTS` platform ceiling (master "Charter money cap"). No component changes: Plan 04 shows the cap with the existing rule components.

Fix round, 2026-10-29: the copied Global Constraints follow the master's Models and API-holdings lines; nothing else changes.

Owner decisions, 2026-10-29, after the fix round: the platform ceiling is $10,000, the per-payment limit (master "Charter money cap"); the copied Global Constraints follow. The copied design line now allows clay in the first-visit intro dialog's illustration (spec "Look and feel"). New Task 0 adds `IntroDialog`, the first-visit dialog that takes the passcode over a static preview of Today, owned here and shipped early by its own design PR right after the design system code (plan 03a) merges, before the web app's arrival (plan 04, Task 4). It adds the tokens `scrim` (`rgba(0,0,0,0.5)`), `shadow-dialog` and the type style `intro-title` (serif 28/35), plus the few tokens the dialog alone uses, and the clay guard's one allowed folder besides the mark, `components/IntroDialog/`, for the illustration's clay field. Task 0 adds its board, `N-Intro-D`, to `REFERENCE_BOARDS`, so its own stories can cite it before Task 4 exists, and Task 4 checks it by eye.

Round 2 (seam review, 2026-10-29): seam-20: `ToolStatusRow` and `ToolReviewCard` take `profile: ToolRowView`, a `Pick` of `ToolProfile` that includes `definition_sha256`, so the API's `ToolRow` fits as well as a `ToolProfile`.
