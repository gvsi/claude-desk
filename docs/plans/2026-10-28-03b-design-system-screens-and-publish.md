# Claude Desk Prototype — Plan 03b: Design system screens and publish

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill (`.agents/skills/`): a fresh implementer and a task review per task, in the plan's worktree, landing through its PRs after the review panel and the project owner's sign-off on their screenshots and recordings (AGENTS.md "Design PRs"). Steps use checkbox (`- [ ]`) syntax for tracking. Browser work follows `.agents/skills/using-browsers`.

**Goal:** The rest of design system v2 on Plan 03a's package: the first-visit intro dialog, the verification, Demo inbox, checkout, rules and connectors, and setup components, board stories checked against every design canvas board they cite, and the Design System artifact published from the repository with one repeatable build command.

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
- Always-on baseline, each item enforced where named: AI disclosure on every visitor surface and A2A response (static notice, `A2AResponse.disclosure`, soft-promise check); private data only to the verified record owner, recipients only `owner` or `verified_contact`, no `pay_out` for agents, and an `Agent` `charge` requires `principal has mandate_remaining_cents && context has amount_cents && context.amount_cents <= principal.mandate_remaining_cents` (forbids in `cedar/baseline.cedar`, proved by `invariants/always/`); verification codes only to the contact on record (`/verify/start`); no `charge` or `pay_out` without an owner card or approval (step 5, `money_needs_card`); auto-allowed money ≤ the money cap `auto_money_cap_cents` of the Desk's active rules version (unset is 0, so every charge and payout asks) and never above `AUTO_MONEY_HARD_CAP_CENTS`, the $10,000 platform ceiling per action (baseline forbid, compiler cap, `invariants/auto/`; "Money cap"); every attempt logged (same-transaction ledger entries, "Data model").
- Also constraints, each in its section: demo-code verification with no real email, SMS or push; payments fully mocked, with no provider account, SDK or keys; per-visitor copies of the Rivera Plumbing seed, a shared Desk link granting visitor access only; the organization's $1,000 monthly limit shared by evals and the demo.
- Accessibility: WCAG 2.2 AA contrast for every token pair; status never by color alone; keyboard paths for chat, approvals and take-over; `aria-live` for replies and receipts; reduced motion respected; Plan 03 runs axe on every story.
- Product name "Claude Desk"; copy is sentence case, plain, no door/knock wordplay; footer "Concept prototype by Giovanni Alcantara, not an Anthropic product"; no Claude/Anthropic logos. Design system v2 tokens (warm dark: app #1C1B19, panel #222220, surface #2A2927, selected #3C392F; Source Serif 4 for Claude's voice and titles; Hanken Grotesk UI; clay #E08968 only in the mark and the first-visit intro dialog's illustration; checkpoint results as receipts attached under each message, at every width). Where the design canvas differs from this plan, this plan wins; canvas-only interactions (a counter-offer answer, a translated take-over message) stay static vision.
- Git: small conventional commits, written for readers of the public history, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Specific to this plan:

- **Canvas sources:** only `N-*` boards on "Claude Desk ·" pages, each listed once in `REFERENCE_BOARDS` (Plan 03a Task 3) and checked in Tasks 4–6; where canvas copy conflicts with a contract, the contract wins and `parameters.canvasNote` says so. Parts with no board (Demo inbox, writing state, checkout, setup pieces) use `parameters.canvas: 'none'`, naming the nearest board in `canvasNote`.
- **Dark only:** one theme, `{"id": "dark", "name": "Dark"}`.
- **Tokens only:** raw colors and durations live only in `tokens.json` and `tokens.css`; `--clay` only in `components/Mark/` and `components/IntroDialog/` (the intro illustration's clay field, Task 0); status colors only as 6 px dots or thin bars beside words that say the same thing.
- **Nothing computes or formats money, dates or discounts** in `web/src/ds/` (no `Intl`, `toLocale*`, `Date`, `toFixed` outside tests, stories, fixtures); cards show only the block's kernel-rendered fields (Plan 03a Task 6), rule limits arrive as the consumer's `RuleWord`s (Task 2), other components take display strings.
- **Card chrome is fixed en/es copy** per `ClauseTemplate`, with no amounts, dates or promises. Every card about money moving (`MONEY_TEMPLATES`: `payment_link`, `payment_confirmed`, `charge_confirmed`, `refund_issued`) and the checkout always say "Test payment, no money moves" / "Pago de prueba, no se mueve dinero"; a quote and the charges list move no money and don't carry it.
- **Visitor status lines are the kernel's:** a visitor receipt shows exactly the signed event's `visitor_plain`, its dot from one exhaustive table (Plan 03a Task 8). Visitor surfaces show no clock times except the kernel's open-status `text` in the public page header, shown verbatim (Plan 03a Task 10); the web never computes a time.
- **Demo inbox codes come only from fetched `DemoInboxEntry` bodies**, never from `EvDemoInbox` notices; a visitor panel renders only `verification_code` entries.
- **Errors are static copy** (Plan 03a Task 5): visitor turns by `EvError.code` (Plan 02's codes), owner requests by `KernelError.code`, every code with a message, never showing the code. Silent turn endings belong to the SSE layer and use no copy.
- **No network:** components and stories never fetch; fixtures hold no prose a reply check would block (Plan 03a Task 2).
- **Accessibility detail:** contrast pairs live once in `CONTRAST_PAIRS` (text 4.5:1, or 3:1 at 24 px and up; 3:1 for the focus ring, dots and the mark); a 2 px `--accent-blue` focus ring at 2 px offset, also on the composer, which shows that one ring on its box and none on its text box (the canvas's 55% ring is 2.9:1); dots `aria-hidden`; replies and receipts inside the transcript's `role="log"`.
- **Copy and motion:** no "→", all-caps words (two or more capitals outside the acronym list; initials avatars and monograms are `aria-hidden` beside the name as text) or exclamation marks; buttons say what happens; Claude speaks in the first person in serif, people in sans; English and Spanish wherever a visitor reads. Transitions 60–200 ms from `motion` tokens, at most one small moment per screen, all static under `prefers-reduced-motion: reduce`.
- **Task check:** every component task's Step 4 ends with `npm run check:ds` (Plan 03a Task 3: guards, the `ds-browser` project and `tsc --noEmit`).

## What this plan serves

- The rest of the owner's side of "can't be talked around":
  - every tool shown under the connector it comes from, with the rules that cover it;
  - a connector added only after its tools are reviewed, starting at "Ask me first", and the proved change shown before anything turns on;
  - rule changes shown with their enforced limits before confirming;
  - a plain review when a tool changes its definition.
- Verification by a code from the Demo inbox, labelled simulated, with the code never reaching Claude.
- A first-time visitor meets one dialog that says what Claude Desk is, lists what to try and takes the passcode, and can't be dismissed without it.
- A first-time visitor sees a clearly labelled test checkout that says no money moves and that they are dealing with an AI.
- Every cited canvas board rebuilt from the components and checked against it, so the app looks like the designs.
- The same tokens and components published as the Design System artifact, built from the repository.

## Interfaces consumed / produced

**Consumed:**
- Plan 03a: the `web/` package, `contracts.ts` types and the Rivera and Chen fixtures, tokens and the brand book, every component and helper exported from `web/src/ds/index.ts` (`receiptFromEvent`, `errorCopy`, `MARK_GEOMETRY` included), `assertCleanCopy`, `expectComputed`, `REFERENCE_BOARDS`, the project-level story hooks and `npm run check:ds`.
- Contracts (through Plan 03a's `contracts.ts`, named as in "Shared contracts v2" and `events.py`): `RenderedBlock`, `ClauseTemplate`, `RuleCard`, `ToolProfile`, `ToolName`, `ToolStatus`, `Effect`, `Assurance` (`demo_code` is labelled simulated), `InboxNotice`, `DemoInboxEntry`, `PaymentLinkState`, `Decision`, `DecisionState`, `SessionMode`, `LedgerEntry`, `LedgerPage`.
- Kernel API models (`kernel_api.py`): `VerifyStarted.message` (the verify card's uniform text, shown by the `verify_prompt` card, never repeated by the form), `PaymentLinkView` (the mock checkout), `PublicDesk` (board stories).
- SSE (`SseEvent`): `EvDemoInbox` (a notice only; codes come from fetched entries), and in board stories `EvMessage`, `EvReceipt`, `EvHeld`, `EvResolved`, `EvOwnerJoined` through Plan 03a's components.
- Components only raise callbacks. Plan 04 screens reach the kernel calls behind them (`GET /demo_inbox`, `GET /payment_links/{token}` with complete and cancel, `POST /verify/check`, `POST /tools/connect`, `POST /tools/confirm`, `POST /tools/simulate_change`, `POST /policy/confirm`) only through Plan 02's API routes (Plan 04's route table).
- `POST /tools/confirm` takes its batch form (answered 2026-10-29), so a connector is one action both ways: `{desk_id, tools: [{tool, definition_sha256}], enable}`.
  - A native tool's `definition_sha256` is its adapter profile's `profile_sha256`.
  - Enabling drafts one rules version for the whole group, proved live at confirm time for any subset of tools. In bounded mode the owner sees "Rules can't be checked right now".
  - Disabling applies at once and unproved, since it only narrows, and each tool's change is ledgered. The kernel refuses `enable: false` for `native.start_verification`, because Verification is always on.
- No kernel endpoint, Rust function, table, prompt or policy is touched, so this plan has no evals gate.

**What the web app (plan 04) passes** to the rules and connectors pieces (Tasks 2–3). The web app owns the connector table: the six built-in connectors and their native tools, Stripe for the `payments.*` tools, and Google Calendar as catalog-only. It also owns each tool's name and line, and every word built from rules, money and dates.
- **The Rules page** (`rules`, N-Conn-01-Rules, N-Conn-16-Phone-Rules):
  - `PageHeader` with "Add a connector", and the owner `Composer` with its chips.
  - `HowClaudeWorks` with `MoneyLimit` at the top (Task 3c, N-Conn-17-Mode, N-Conn-22-Phone-Mode): the preset from `RulesView.preset` and the money limit from the active version, each change opening its review on its own page.
  - `ConnectorList`, with `summary` from the active version.
  - Per connector, a `ConnectorView` and its `ToolSummaryView`s, built from the Desk's tool rows (`RulesView.tools`: `status` per profile), the active cards (`ruleWords`, coverage per master "Decision semantics") and the connector table.
  - `AlwaysOnList`.
  - The composer opens `AskClaudePanel`. Its conversation holds the chat's answers, with `ConnectorOfferCard`s and `ChangeReview`s inline.
- **A connector's page** (`rules/:connector`, N-Conn-02 to N-Conn-04):
  - `Breadcrumb` and `ConnectorHeader`.
  - A `ToolRulesCard` per tool, with `RuleRow`s (`words` from `ruleWords`; `shared` with the covered tools' names for an effect-group card; `onChangeOutcome` opens the drafted change in `ChangeReview`).
  - `ConnectionPanel`: `consequence`, the connection details for Stripe, and what stops: the connector's tools and the rules that stop applying, read from `RulesView`. "Turn off" or "Disconnect" opens the panel's plain confirm, which lists them, then sends one `POST /tools/confirm {tools, enable: false}`, which applies at once. Verification passes `alwaysOn` instead and has no "Turn off".
- **A tool's page** (`rules/:connector/:tool`, N-Conn-05, N-Conn-06, N-Conn-14, N-Conn-15):
  - `ToolPageHeader`: `status` from the profile; `definitionNote` for a connected tool only; the demo's "Simulate a tool change" (`onSimulateChange` → `POST /tools/simulate_change`, Task 3c).
  - `ToolReviewCard` while `needs_review`. "Turn back on" sends `POST /tools/confirm {tools: [{tool, definition_sha256: pending_sha256}], enable: true}`, and the drafted version shows in `ChangeReview`.
  - `ToolRulesCard`, and the owner `Composer` with the tool's chips.
  - `RecentRequests`: rows from the tool's recent decisions (`reason_plain`, the deciding card's reason, the state in words, the time formatted by the web app), each linking to its Safety record.
- **Adding a connector** (N-Conn-07b to N-Conn-12):
  - `ConnectorPicker` items from the Desk's profiles and the catalog. Verification is never among them, since it is always added.
  - Built in: `ConnectorReview`, with each tool at `ask` and `coveredBy` from the active cards that would cover it and the always-on lines. "Turn it on" sends one `POST /tools/confirm {tools, enable: true}` for the connector's tools, which drafts one version for the group. That proved version shows in `ChangeReview`, then `POST /policy/confirm`.
  - External: `ConnectorSignIn` (a mock that asks for no account details) → `POST /tools/connect`, then the same review and confirm.
  - `Steps` across the pages.
- **Today** (N-Conn-13): a `ToolChangedItem` per `needs_review` tool, first under "Needs you".
- **Settings**: connectors live only under Rules, so Settings' `SubNav` drops its Integrations entry and gains no Connectors entry.
- **Words**: `OUTCOME_WORDS` and `outcomePhrase` for every outcome, `PRESET_WORDS` and `PRESET_CAPTIONS` for the mode switch, and `describeEffects` for a connected tool's line.

**Produced** (for Plan 04 and the artifact): `IntroDialog`, `IntroThing`, `IntroErrorCode` and `INTRO_ERROR_COPY` with the tokens `scrim`, `shadow-dialog` and `intro-title` (Task 0, shipped early by its own design PR); the components of Tasks 1–3, exported with their `<Comp>Props` from `web/src/ds/index.ts`; `describeEffects`, `ruleDiff`, `RuleWord`, `RuleField`, `RuleMode`, `OUTCOME_WORDS`, `OUTCOME_TONE`, `outcomePhrase`, `RulesPreset`, `PRESET_WORDS` and the view types `ConnectorView`, `ToolSummaryView`, `ChangeSide` and `ChangeRowView` (Task 2); `RecentRequestView`, `PickerItem`, `ReviewToolView` and `ToolRowView` (Task 3); `HowClaudeWorks`, `MoneyLimit`, `LimitChange` and `PRESET_CAPTIONS` (Task 3c); `Boards/*` stories as Plan 04's reference compositions and `web/src/ds/reference/README.md` (Tasks 4–6); `build-ds-artifact.mjs` and the published artifact (Task 7).

Component folders are named for their main export; extra exports are documented in the folder's README and get no artifact card. Each task's Files line names the canvas boards its stories cite.

## Review Focus owned

No master Review Focus line names Plan 03 (now 03a and 03b); the matrix's accessibility row and the Global Constraints (axe on every story) do. This plan's share:

| Accessibility requirement | Task and test |
|---|---|
| Status never by color alone | Task 2 `diff_shows_enforced_values` |
| Keyboard paths: chat, approvals and take-over | Task 2 `outcome_menu_by_keyboard`; Task 3 `confirm_names_the_reviewed_hash` and `picker_by_keyboard` (by keyboard); Tasks 4–6 `focus_order_is_logical` and keyboard walks |
| Keyboard paths: the first-visit dialog | Task 0 `tab_stays_inside_with_a_real_keyboard`, `escape_never_closes_it_with_a_real_keyboard` and the `Default` play (focus starts in the field, Enter submits) |
| `aria-live` for replies and receipts | Task 1 `inbox_announces_new_entries`; Task 2 `ask_claude_panel_is_a_log` |
| Axe on every story | every story here runs under Plan 03a's project annotations (`parameters.a11y.test = 'error'`, the copy and canvas hooks) |

Supporting tests (the kernel stays the authority) and failure modes this plan owns:

| Scenario | Task and test |
|---|---|
| Owner confirms a rule change → sees the enforced who, limits, hours and review, before and after | Task 2 `same_reason_new_limit_is_changed`, `diff_shows_enforced_values`, `confirm_once` |
| Demo inbox → no code from a notice; no owner alerts or checkpoints on a visitor panel | Task 1 `code_only_from_entry`, `visitor_sees_only_codes` |
| A connected tool's definition changes → literal quoted definition; re-enable names the reviewed hash | Task 3 `quoted_definition_is_text`, `confirm_names_the_reviewed_hash`, `no_hash_no_confirm` |
| Adding a connector → each new tool at "Ask me first" with what already covers it; nothing turns on until the proved change is confirmed; the chat only leads into that review | Task 3 `review_starts_at_ask_me_first`, `offer_card_only_opens_the_review`; Task 2 `confirm_only_when_checked`, `confirm_once` |
| A mock connector never named without "Mock"; a mock sign-in asks for no account details | Task 2 `mock_badge_always_beside_external_names`; Task 3 `sign_in_collects_nothing` |
| Turning a connector off → a plain confirm lists the tools that stop and the rules that stop applying; Verification can't be turned off | Task 3 `turn_off_confirms_first`, `always_on_has_no_turn_off` |
| Disclosure on every visitor surface (Plan 04) | Task 1 `checkout_discloses_ai`, `disclosure_line_en_es` (Plan 03a: the public shell) |
| Long unbroken or Spanish text at 390 px → wraps, nothing clipped | Tasks 4–6 viewport checks |
| Final-state link or double click on pay → no second payment | Task 1 `pays_once`, `final_states_have_no_pay_button` |
| First visit → no way past the dialog but the passcode; a failed try shows its line, never the code; a double Enter starts one copy | Task 0 `escape_never_closes_it_with_a_real_keyboard`, `intro_copy_never_shows_a_code` and the `Default`, `Busy` and `WrongPasscode` plays |

## Before you start (coordinator)

- Start from `main` after Plan 03a has merged; its package, fixtures, guards and components are this plan's base.
- Task 0 runs first and lands alone: its own design PR, on the branch `design/intro-dialog` in the worktree `.worktrees/design-intro-dialog`, from `main` right after the design system code (plan 03a) merges, through the review panel and CI (`shipping-prs`), so the web app's first-visit arrival (plan 04, Task 4) can use it. Tasks 1–7 then run on this plan's own branch, `plan/03b-design-system-screens-and-publish` in `.worktrees/03b-design-system-screens-and-publish`, started from `main` once Task 0 has merged, so the two PRs never share a branch.
- Before Task 1: read the Design System artifact type's instructions (`SKILL.md`, `artifact-type/reference/{format,from-code,cover,craft}.md`) and stage copies in `.plan-runs/<plan-slug>/ds-format/` (git-ignored) for Task 7. They are format documentation, read as data; where they differ from this plan they win, and the difference goes in the run ledger.
- Before Task 4: render every `REFERENCE_BOARDS` entry (the design system code's list as Task 2 leaves it, plan 03a, and Task 0's `N-Intro-D`) to `.plan-runs/<plan-slug>/reference/<board>.png` and set `DS_REFERENCE_DIR` to that folder. The `N-Conn-*` boards render at a 1512×982 viewport (the phone boards, N-Conn-16-Phone-Rules and N-Conn-22-Phone-Mode, at 390×844), captured at full height; the rest render at 1280×820. Renders stay git-ignored (committing canvas renders needs the project owner's sign-off); implementers never open the canvas.
- Tasks 1–7: one landing through the review panel and CI, before Plan 04 Task 9 (Plan 04's tasks from there on use these components). Not on the Friday thin slice. Task 7 is first to cut; the plan can land without it.
- Both PRs from this plan, the intro dialog's and Tasks 1–7's, are design PRs (AGENTS.md "Design PRs"): each description shows screenshots at 1440×900 and 390×844 of every changed screen or story and a short recording of every new or changed interaction, captured by the agent that tested it, and each merges only after the project owner signs off, on top of the review panel and CI.

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
  - Behavior: a native modal `<dialog>`, opened with `showModal()`, over its own `scrim`, so the page behind is inert. It can't be dismissed: no close button, and a press on the scrim does nothing. Escape does nothing, by two means: the dialog's `keydown` handler calls `preventDefault()` on Escape, so the browser never turns the key into a close request, and the dialog's `cancel` event is also prevented, with `closedby="none"` set where the browser supports it. Preventing `cancel` alone isn't enough, since Chrome lets a page refuse a close request only after a user activation, and a dialog opened on load has had none. The `<dialog>` is labelled by its title (`aria-labelledby`) and described by the intro (`aria-describedby`), so its accessible name is the `title` prop. The passcode field is labelled "Passcode" and is `type="password"` with `autocomplete="off"`, so the passcode never shows on screen. Focus starts in the passcode field and Tab stays inside the dialog. Enter submits once with the trimmed passcode. The button is disabled while the field is empty and shows the busy spinner while `busy`, like every busy `Button` (signed off on 2026-10-29, board N-Typing-Owner-Busy), while a status line seen only by screen readers says "Starting the demo"; a second submit before the first settles does nothing. With `error`, the line shows under the field (`role="alert"`, the field `aria-invalid` and described by it) and the field takes focus with its text selected; the code itself never shows. Nothing fetches.

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
  - `MockCheckout({ title; amount; state: PaymentLinkState; cancelReason?: 'rules_changed'; language; busy?; error?; onPay; onCancel })`: the body Plan 04 mounts at `/pay/{token}`, with `PaymentLinkView.title`, its `language` and the page's amount string (it formats nothing). A `DisclosureLine` (no business name) and a held-dot `Pill` "Test payment, no money moves" / "Pago de prueba, no se mueve dinero" top every state; `ConceptFooter` at the bottom.

| `state` | Shows |
|---|---|
| `issued` | title, amount, "This link works once." / "Este enlace funciona una sola vez.", primary "Complete test payment" / "Completar pago de prueba" → `onPay`, secondary "Cancel payment" / "Cancelar pago" → `onCancel` |
| `paid` | handled dot and the check that draws once: "Paid. Go back to the chat to see it there." / "Pagado. Vuelve al chat para verlo allí." |
| `expired` | info dot: "This payment link expired. Ask in the chat for a new one." / "Este enlace de pago venció. Pide uno nuevo en el chat." |
| `cancelled` | info dot: "This payment was cancelled. Nothing was charged." / "Este pago se canceló. No se cobró nada." |
| `cancelled`, `cancelReason: 'rules_changed'` (`PaymentLinkView.cancel_reason`) | info dot: "This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay." / "Este enlace se canceló porque el negocio cambió sus reglas. No se cobró nada. Pregunta en el chat si todavía quieres pagar." |
| `unknown` | held dot: "This payment is still being confirmed. The chat will show the result." / "Este pago aún se está confirmando. El chat mostrará el resultado." |

  After one click both buttons disable until `state` changes; `busy` adds `aria-busy`; `error` shows an error `Notice`: "That didn't go through. Reload this page to see where the payment stands." / "No se pudo completar. Recarga esta página para ver el estado del pago."

- [ ] **Step 1: Write the stories:** `Status/DisclosureLine` (`WithBusiness`, `Spanish`), `Verification/VerifyCodeForm` (`Idle` under the fixture `verify_prompt` card, `Checking`, `Failed`, `Spanish`, `VerifiedSimulated`, `VerifiedSimulatedEs`), `Verification/DemoInboxPanel` (`WithCode`, `Opening`, `OpenFailed`, `OwnerAlerts`, `VisitorGivenAlert`, `SpanishVisitor`, `Empty`), `Payments/MockCheckout` (`Issued`, `IssuedEs`, `Paying`, `Paid`, `Expired`, `Cancelled`, `CancelledRulesChanged`, `Unknown`, `Error`). Play: `disclosure_line_en_es`; `submits_six_digits` ("482913", Enter → `onSubmit('482913')`); `rejects_non_digits`; `form_does_not_repeat_the_card` (`Idle`: the card's text appears once); `demo_code_is_labelled_simulated` (en and es); `spanish_labels` (`Spanish` and `SpanishVisitor` show their es labels and no English one); `inbox_newest_first`; `inbox_announces_new_entries` (inside an `aria-live="polite"` region); `code_only_from_entry` (`Opening` shows the preview and "Opening", no entry body text); `visitor_sees_only_codes` (`VisitorGivenAlert` shows neither its `alert` nor its `head_checkpoint` body, and no time); `retry_on_open_failure` ("Try again" → `onRetry(entry_id)`); `checkout_discloses_ai` and `test_payment_label_always_shown` (every `MockCheckout` story; Spanish in `IssuedEs`); `pays_once` (two clicks → `onPay` once; `Paying` has both buttons disabled and `aria-busy="true"`); `final_states_have_no_pay_button` (`Paid`, `Expired`, `Cancelled`, `CancelledRulesChanged`, `Unknown`); `rule_change_cancel_says_why` (`CancelledRulesChanged` shows its own line and not the generic cancelled one); `error_says_to_reload`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project storybook src/ds/components/{DisclosureLine,VerifyCodeForm,DemoInboxPanel,MockCheckout}` → FAIL.
- [ ] **Step 3: Implement** with READMEs (`DisclosureLine`, `DemoInboxPanel` and `MockCheckout` use `parameters.canvas: 'none'`; the checkout follows N-Public-Rivera's type and spacing).
- [ ] **Step 4: Run** the same command plus `npm run check:ds` → PASS (24 story tests).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add the verification code form, the Demo inbox panel, the mock checkout and the AI disclosure line"`.

### Task 2: Rules hub and rule pieces

Owner decisions, 2026-10-29 (the signed boards on the design canvas's "Claude Desk · Connectors and rules" page, which replace the Rules and Integrations boards):
- Rules is one page under the Rules nav: the "Ask Claude to change a rule or a connector" composer, one section per connector the Desk has (built in first, then the ones it connected), "Add a connector" at the top and at the end, and the always-on list.
- A connector is where tools come from. People read "Connectors", never "Integrations".
- A built-in connector is a presentation group over native tools, optional per Desk except Verification: Quotes (`native.quote`), Bookings (`native.find_slots`, `native.book`), Leads and callbacks (`native.capture_lead`, `native.request_callback`), Verification (`native.start_verification`), Documents (`native.release_document`), Payments (`native.payment_link`, `native.charge_mandate`). No tool is added.
- Verification is always on. It has no "Turn off", the kernel refuses to disable `native.start_verification`, and the picker never offers it. Its page says "Always on. It's how Claude confirms a customer before sharing anything private."
- Connectors live only under Rules. No Settings menu names them.
- External connectors: Stripe, the mock payments server's `payments.*` tools, with the Mock badge beside its name everywhere and its real brand icon; Google Calendar, catalog-only in the demo ("Coming soon in this demo"), free/busy only when it works.
- Outcome words: "Automatic", "Ask me first", "Never" (replacing "Do it", "Ask me", "Never"). The mode switch reads "Ask me first", "Automatic", "Custom".
- Rivera Plumbing's hub has all six built-in connectors and Stripe. The add-a-built-in example (the picker, the review and the chat) is Chen & Co. CPA adding Payments.

Every string in Tasks 2 and 3 is owner-facing: no visitor reads these screens, so none has Spanish. Components display what the screen passes; nothing here decides an outcome or formats money, dates or times.

**Files:**
- Create under `web/src/ds/components/`: `ConnectorIcon/`, `ConnectorName/`, `OutcomeMenu/` (also `outcomeWords.ts`), `RuleRow/`, `ToolRulesCard/` (also `toolRules.ts`), `ConnectorSection/` (also `describeEffects.ts`), `ConnectorList/`, `AlwaysOnList/`, `ChangeReview/` (also `ruleDiff.ts`), `AskClaudePanel/` (canvas: N-Conn-01-Rules, N-Conn-02-Payments, N-Conn-10-GCal-Confirm, N-Conn-12-Chat, N-Conn-16-Phone-Rules)
- Modify:
  - `web/src/ds/index.ts`.
  - `web/src/ds/icons/index.tsx`: `chevron-right`, `shared` and `quote` join `ICON_NAMES`, drawn as the boards draw them.
  - `web/src/ds/tokens.json`, `web/src/ds/tokens.css` (`npm run tokens`), `web/src/ds/contrast.ts`: the connector tokens below.
  - `web/src/ds/README.md`: the brand book says a connector's brand tile is the one light surface besides the intro illustration's cards.
  - `web/src/ds/reference/boards.ts`: `REFERENCE_BOARDS` drops N-Rules-Rivera, N-Rules-ChatChange, N-Settings-Integrations and N-Settings-ToolChanged, which these boards replace, and gains the eighteen `N-Conn-*` boards (N-Conn-01-Rules to N-Conn-16-Phone-Rules, with N-Conn-07b and N-Conn-11b), so the stories here can cite them before Task 6.
  - `web/src/ds/components/Card/Card.stories.tsx`: canvas N-Conn-01-Rules.
  - `web/src/ds/components/SegmentedControl/SegmentedControl.stories.tsx`: labels from `PRESET_WORDS`, so its play reads "Automatic" where it read "Auto"; canvas `'none'`, naming N-Conn-01-Rules, since no signed board draws the mode switch.
  - `web/src/ds/fixtures/{rivera.ts,chen.ts}`: below.
- Test: `web/src/ds/components/ConnectorSection/describeEffects.test.ts`, `web/src/ds/components/ChangeReview/ruleDiff.test.ts`, `web/src/ds/tokens.test.ts`, the stories

**Interfaces:**
- Consumes: `RuleCard`, `Effect`, `ToolName`, `ToolStatus` (Plan 03a Task 2); `Card`, `Button`, `IconButton`, `Pill`, `StatusLabel`, `StatusTone`, `SectionHeader`, `Notice`, `Composer`, `WritingIndicator`, `Icon` (Plan 03a Tasks 4 and 5); the menu-button keys of `ApprovalCard`'s answers (the design follow-ups PR, #12).
- Produces:
  - **Outcome words.** `RuleMode = RuleCard['mode']`.
    - `OUTCOME_WORDS` (`satisfies Record<RuleMode, string>`): `auto` "Automatic", `ask` "Ask me first", `never` "Never".
    - `OUTCOME_TONE`: `auto` handled, `ask` held, `never` refused.
    - `outcomePhrase(mode, limit?)`: `OUTCOME_WORDS[mode]`, except that an `auto` rule with a `limit` reads "Automatic up to {limit}; over {limit}, ask me first". `limit` is the screen's formatted amount ("$100"). An auto card with `max_amount_cents` holds anything above it for the owner through its hold twin. No mode asks with a limit.
    - `RulesPreset = 'ask_first' | 'auto' | 'custom'` (the master's presets) and `PRESET_WORDS`, in that order: "Ask me first", "Automatic", "Custom", for the screen's `SegmentedControl`.
  - **Rule words.** `RuleWord = { field: 'who' | 'limits' | 'hours' | 'review'; text: string }`: the consumer's code-rendered words for what a card enforces (Plan 04's `ruleWords(card, people)`: "Anyone", "Up to $300", "Checked by the reviewer"). The design system formats none.
  - **Connectors.** `ConnectorView = { id: string; name: string; icon: ConnectorIconName; description: string; source: { kind: 'built_in' } | { kind: 'external'; mock: true } }`, the screen's view of one connector. Plan 04 owns which tools each connector groups. Every external connector in the demo is a mock, and `mock: true` is required, so the badge can't be left out.
  - `ConnectorIcon({ icon: ConnectorIconName; size: 'page' | 'section' | 'inline' })`: a 48, 36 or 24 px tile with an 8 px radius, `aria-hidden`.
    - Built in, on a `--fill-secondary` tile: `quotes` (`quote`), `bookings` (`calendar`), `leads` (`person`), `verification` (`lock`), `documents` (`document`), `payments` (`card`).
    - External, on a light `--connector-tile-brand` tile: `stripe` and `google_calendar`, each brand's real mark as inline SVG.
    - Tokens: `connector-tile-brand` `#FFFFFF`, `connector-stripe` `#635BFF`, and one `connector-google-*` token per color the Google Calendar mark uses. Each is in `DECORATIVE_COLORS` ("a third-party brand mark beside its name; nothing is read on it"), so no raw color enters a component.
  - `ConnectorName({ connector; size: 'page' | 'section' | 'inline'; level?: 1 | 2 | 3 })`: the name, a heading at `level` or else a `span`, in serif `page-title` at `page` size. Beside it, "Built in" in quiet meta for a built-in connector, or a "Mock" `Pill` for an external one. Every component that names a connector uses it, so "Mock" sits beside every external connector's name.
  - `OutcomeMenu({ label; value: RuleMode; limit?: string; onChange?: (mode: RuleMode) => void; disabled? })`:
    - Without `onChange`, a `StatusLabel`: the tone's dot and `outcomePhrase(value, limit)`.
    - With it, a menu button (32 px high, a 1 px `--line-control` border, radius 8 px, transparent; the dot, the phrase and `chevron-down`), named "{phrase}. Change the outcome of: {label}", with `aria-haspopup="menu"` and `aria-expanded`. It opens a `menu` of three `menuitemradio`s, "Automatic", "Ask me first" and "Never", the current one checked.
    - Keys as on `ApprovalCard`'s menus: Enter, Space and Down open it on the first item, Up on the last; the arrows move; Escape closes it and returns focus to the button.
    - Picking another word calls `onChange` once and closes the menu; picking the current word only closes it. The button keeps showing `value` until the screen passes a new one, since a change applies only after its review (`ChangeReview`).
  - `RuleRow({ rule: Pick<RuleCard, 'card_id' | 'mode' | 'reason'>; words: RuleWord[]; limit?: string; shared?: { appliesTo: string }; onChangeOutcome?: (mode: RuleMode) => void })`:
    - `rule.reason`, with the `words` beneath, joined by " · " in secondary meta, and `OutcomeMenu` at the right (`label` the reason; `limit` the screen's amount for an auto card with `max_amount_cents`).
    - `shared` marks a rule on an effect group, such as `effect:charge`: the `shared` icon (`aria-hidden`) and "Shared rule. {appliesTo}", the screen's words for what it covers ("Applies to every tool that charges money: Payment link and Charge within a signed limit."). The screen shows a shared rule under every tool it covers; changing it from any of them changes the one rule.
    - Under 640 px of its own width (a phone, a side panel), the outcome sits on its own line under the words, as the phone board draws it, and a long phrase wraps inside the button.
  - `ToolRulesCard({ label; tool?: { name; description; href }; rules: RuleRowProps[]; fallback?: boolean; onAddRule?: () => void; linkComponent? })`:
    - A `Card` (`section`, named `label`).
    - With `tool` (on a connector's page) it starts with the tool's name and `description` as one link to the tool's page, with `chevron-right`.
    - Then a `RuleRow` per rule.
    - With `fallback` (true unless the screen passes false, as it does when a `never` card for anyone covers the tool), the last row is "Anything else here: ask me.", with a ghost "Add a rule" → `onAddRule` when given.
  - `rulesForTool(tool: { tool: ToolName; effects: Effect[] }, cards: RuleCard[]): RuleCard[]` (`toolRules.ts`), the rules that govern a tool under the master's "Coverage and overlap", most specific first, for the screen to build a tool's `RuleRow`s from. It lists cards and decides nothing:
    - The tool's own cards always; an effect card (`effect:charge`) only where it covers the tool and none of the tool's own cards outranks it for everyone it is for. A tool card outranks an effect card; a card for one person or agent outranks a tool card; a tool card for fewer people (record owners) leaves the group rule deciding for the rest. An `auto` effect card covers a multi-effect tool only jointly, with an `auto` card per effect at its specificity that one principal can satisfy with it: cards for groups of people combine, and a card for one person or agent combines only with that same person's or agent's cards. A `never` effect card always shows. Default cards are left out (the fallback row says what they do).
    - So a group rule for anyone shows under a tool with no card of its own and is hidden under a tool with its own card for anyone.
  - `describeEffects(effects, reversible): string`, in the boards' words, first match wins:
    - `pay_out` "Moves money out."; `charge` "Charges money."; `private_data` "Touches private data."; `send_message` "Sends a message out."; `change` "Changes something."; `read` "Changes nothing.".
    - Then " Can be undone." or " Can't be undone.", only when an effect changes something (`change`, `charge`, `pay_out`, `send_message`). A tool that only reads, or reads private data, has no suffix.
    - The screen calls it for a connected tool's line; components take lines as strings (except `ToolReviewCard`, Task 3).
  - `ToolSummaryView = { key: string; name: string; description: string; summary: string; mode: RuleMode; limit?: string; status: ToolStatus; href: string }`, one tool on the hub (`mode` and `limit` are the outcome and formatted amount limit of the rule that governs it for anyone):
    - `description`: the screen's line for what the tool does and its effects ("Prices a job from your price list. Changes something. Can be undone.").
    - `summary`: its rule words ("Anyone · No discounts", "2 rules · 1 shared", "Always on").
  - `ConnectorSection({ connector; href; tools: ToolSummaryView[]; addedNote?: string; linkComponent? })`, a `Card` section named by the connector:
    - The header is one link to the connector's page (padding 14px 16px): `ConnectorIcon` at `section` size, `ConnectorName`, `connector.description`, `addedNote` ("Added just now") when given, "1 tool" or "{n} tools", and `chevron-right`.
    - Then a link row per tool (padding 12px 16px, a hairline above): the name (weight 520) and `description`; at the right `summary` and the outcome with its dot: `outcomePhrase(mode, limit)`, or held "Needs your review" when `status` is `needs_review`, or info "Off" when `disabled`.
    - Each row is named "{name}: {summary}, {outcome}. Open".
    - Under 640 px (N-Conn-16-Phone-Rules) the connector's description and count and each tool's `description` are hidden, `summary` sits under the tool's name, and the outcome on its own line under that, where a long phrase wraps.
  - `ConnectorList({ summary: string; onAddConnector: () => void; children })`, the hub's list:
    - `summary` in meta ("6 built-in connectors and 1 you connected · Version 7, checked against the always-on rules").
    - A list named "Connectors", one item per `ConnectorSection`.
    - A secondary "Add a connector" → `onAddConnector` after the last item.
    - Under 640 px the summary and the last button are hidden, as the phone board draws them; the page header's "Add a connector" stays.
  - `AlwaysOnList({ level?: 2 | 3 })`: "Always on" with the caption "On every Desk, whatever is connected. They can't be turned off.", then lock icons and no controls: "Always says it's an AI", "Private data only to its verified owner", "Codes only go to the contact on record", "No money moves without your rule or a signed limit", "Every attempt is logged and shown to you".
  - `ruleDiff(before: RuleCard[], after: RuleCard[]): RuleDiffRow[]`, kept from the old Task 2. It reports which fields differ and decides nothing; the screen builds `ChangeRowView`s from it.
    - Rows by `card_id`; `is_default` cards skipped; unchanged cards omitted.
    - `RuleDiffRow = { cardId; change: 'added' | 'removed' | 'changed'; before: RuleCard | null; after: RuleCard | null; fields: RuleField[] }`.
    - `RuleField = 'applies_to' | 'mode' | 'who' | 'limits' | 'hours' | 'review' | 'reason'`; `person_id` and `agent_key_id` count as `who`, `max_amount_cents` and `max_discount_bp` as `limits`.
  - `ChangeSide = { appliesTo?: string; mode: RuleMode; limit?: string; reason: string; words: RuleWord[] }` (`appliesTo` is the screen's words for what the rule covers, "Payment link" or "Every tool that charges money"; the screen passes it on both sides whenever a rule's target can change) and `ChangeRowView = { key: string; change: 'added' | 'removed' | 'changed' | 'turned_on'; title: string; connector?: ConnectorView; before: ChangeSide | null; after: ChangeSide | null; changed: RuleField[] }`.
  - `ChangeReview({ rows: ChangeRowView[]; checks: { status: 'checked' | 'failed' | 'unavailable'; lines: string[] }; confirmLabel?; cancelLabel?; onConfirm; onCancel; hasOtherChanges?; pending?; error?: string })`, renamed from `RuleChangeDiff` (N-Conn-10-GCal-Confirm). It shows a proved change before it applies: a rule draft, a connector turned on, a changed tool turned back on. Turning a connector off needs no proof, so it has a plain confirm instead (`ConnectionPanel`, Task 3).
    - A "Changes" card with a row per change:
      - A tag in words in an outlined pill: "Added", "Removed", "Changed" or "Turned on".
      - `title`, then a meta line: the `connector`'s name and badge, then the side's `words`, joined by " · ".
      - The side's `reason`, and the outcome with its dot at the right (`outcomePhrase(mode, limit)`).
      - A `changed` row shows "Before" and "After", and each line whose field is in `changed` is tagged "Changed" in text.
    - No rows → "No rules change." and no confirm button. With `hasOtherChanges` (the draft changes something the screen shows above it, such as the money limit), no rows reads "Your rules stay the same." instead, and the controls stay.
    - A card for the checks, headed by `status`: "Checked before you confirm", "This change can't be applied" or "Rules can't be checked right now", with `lines` as a list (the screen's words from the proof report, Plan 04's `checkStatus`).
    - The primary `confirmLabel` ("Confirm change" by default; "Confirm and turn on") is enabled only when `status` is `checked`. After one click it waits until `pending` clears. While it waits it keeps its label under the busy spinner, at the same width, with `aria-busy`, and only it spins.
    - The secondary `cancelLabel` ("Keep my rules" by default; "Back").
    - `error` shows the screen's message in an error `Notice` and enables confirm again.
  - `AskClaudePanel({ onClose; onSend: (text: string) => void; busy?: boolean; children })` (N-Conn-12-Chat):
    - An `aside` named "Ask Claude", 400 px wide beside the page (token `size-side-panel`, with a hairline on its left), full width under 640 px.
    - A header "Ask Claude" with `IconButton` "Close" → `onClose`.
    - The conversation (`children`: the owner's words, Claude's serif replies and their cards) in a `role="log"` region with `aria-live="polite"`, and `WritingIndicator` while `busy`.
    - An owner `Composer` at the bottom, labelled "Ask Claude", with the placeholder "Ask Claude".
    - Escape inside the panel calls `onClose`; the screen returns focus to what opened it.
  - **Fixtures.**
    - `rivera.ts` gains `ruleWords`: each `rv-*` card's words as Plan 04's `ruleWords` renders them, in the boards' words. `rv-quote`: "Anyone", "No discounts". `rv-link`: "Anyone", "Up to $300", "Checked by the reviewer". `rv-mandate`: "Signed agents", "Up to $20". `rv-charges`: "The record's owner, verified". `rv-refund`: "The customer who paid, verified". `rv-agent-charges`: "Alex Kim's assistant", "Up to $20". It also gains `ruleLimits`, the formatted amount of each auto card with `max_amount_cents` ("$300", "$20").
    - `rivera.ts` gains `connectors`: the hub on N-Conn-01-Rules, a `ConnectorView` and its `ToolSummaryView`s for Quotes, Bookings, Leads and callbacks, Verification, Documents ("Share a document", under `rv-docs`), Payments and Stripe.
    - `rivera.ts` gains `sharedChargeCard`, for the shared-rule stories, outside `ruleCards`, since Rivera's seed has no shared card and the board's note says the example is illustrative: `{card_id: 'rv-agent-charges', applies_to: 'effect:charge', mode: 'auto', who: 'agent', agent_key_id: 'demo-agent', max_amount_cents: 2000, reason: "Alex Kim's assistant can pay up to $20 from its signed limit."}`, and `sharedChargeAppliesTo`, "Applies to every tool that charges money: Payment link and Charge within a signed limit.". It agrees with the seed: it is the seed's $20 agent limit, for the visiting agent's own key (`who: 'agent'` requires one). A card for one agent outranks each tool's card for anyone, so it governs Payment link and Charge within a signed limit for that agent, beside `rv-link` and `rv-mandate`. Its words are "Alex Kim's assistant", "Up to $20", and its `limit` "$20", so its outcome reads "Automatic up to $20; over $20, ask me first". Its hold twin holds anything above $20 from that agent for the owner.
    - `chen.ts` gains `connectors`: Chen & Co. CPA's hub without Payments: Quotes, Bookings (`cc-consult`, "Ask me first"), Leads and callbacks, Verification and Documents, plus the Payments `ConnectorView` it adds. It also gains `ruleWords`, and the cards its hub and conversations imply: `cc-quote` (quotes auto at list price, so the discounted quote in its Demo inbox held) and `cc-docs` (documents auto for the record's owner, as Raj's return was released).

- [ ] **Step 1: Write the failing tests.**
  - `describeEffects.test.ts`: `money_out_wins` (`['pay_out', 'private_data']`, not reversible → "Moves money out. Can't be undone."); `charge_reversible` ("Charges money. Can be undone."); `read_only_has_no_suffix` ("Changes nothing."); `private_data_alone_has_no_suffix` (reversible → "Touches private data."); `documents_line` (`['private_data', 'send_message']`, not reversible → "Touches private data. Can't be undone.").
  - `outcomeWords.test.ts`: `outcome_phrase_with_limit` (`auto` with "$100" → "Automatic up to $100; over $100, ask me first"; `ask` with "$100" → "Ask me first"; `auto` alone → "Automatic").
  - `ruleDiff.test.ts`: `same_reason_new_limit_is_changed` (`max_discount_bp` 1000 → 5000 with `reason` unchanged → one `changed` row, `fields` `['limits']`); `defaults_and_unchanged_are_omitted`; `added_and_removed_rows`; `subject_change_is_who` (a new `person_id` → `['who']`).
  - `toolRules.test.ts`: `a_tool_card_hides_the_group_rule_it_outranks` (a tool with its own card for anyone doesn't list a group rule for anyone; a tool without one does); `a_person_scoped_group_rule_outranks_tool_cards_for_everyone_else`; `a_narrower_tool_card_leaves_the_group_rule_for_everyone_else`; `an_auto_group_rule_covers_a_tool_only_with_every_effect`; `never_group_rules_always_show_and_defaults_never_do`.
  - `tokens.test.ts`: `connector_tokens_are_decorative` (every `connector-*` color is in `DECORATIVE_COLORS` with its reason; `size-side-panel` is 400px).
  - Stories:
    - `Connectors/ConnectorIcon`: `BuiltIn` (the six tiles), `Brands` (Stripe and Google Calendar).
    - `Connectors/ConnectorName`: `BuiltIn`, `Mock`.
    - `Rules/OutcomeMenu`: `ReadOnly`, `Automatic`, `AutomaticWithLimit`, `AskMeFirst`, `Never`.
    - `Rules/RuleRow`: `PaymentLink` (`rv-link`), `Shared` (`sharedChargeCard`), `ReadOnly`, `NarrowMaxLimit` (320 px), `NarrowColumn` (a row 560 px wide).
    - `Rules/ToolRulesCard`: `PaymentLinkOnPayments` (the tool's header, `rv-link` and the shared card), `RefundOnItsPage` (no header; `rv-refund`), `NoFallback`, `Phone`.
    - `Connectors/ConnectorSection`: `Quotes`, `Payments`, `Stripe`, `NeedsReview` (Refund `needs_review`), `AddedJustNow`, `Phone`, `NarrowMaxLimit` (320 px).
    - `Connectors/ConnectorList`: `RiveraHub` (seven sections), `Phone`.
    - `Rules/AlwaysOnList`: `Default`.
    - `Rules/ChangeReview`: `TurnOnPayments` (Chen: two "Turned on" rows at "Ask me first"), `RaiseDiscount`, `AddAndRemove`, `TurnBackOnRefund` (one "Turned on" row for Stripe's Refund at "Ask me first"), `ChecksFailed`, `ChecksUnavailable`, `Confirming`, `ConfirmingFromTheScreen` (the label and width kept while the screen's `pending` is set), `LimitOnly` (no rows, with `hasOtherChanges`), `NothingChanges` (no rows: "No rules change." and no confirm), `ConfirmFailed` (the screen's error, and confirm works again), `WidenScope` (a rule widened from Payment link to every tool that charges money), `ScopeChangedWithoutTargets`, `RepeatedFailure` (the same failure three times), `NarrowMaxLimit` (320 px).
    - `Rules/AskClaudePanel`: `AddPayments` (Chen's owner: "Add Payments, so clients can pay their invoices"; Claude, in serif: "I can add Payments, so clients can pay with a test payment link. Have a look before anything turns on."), `Writing`, `Phone`.
  - Plays:
    - `mock_badge_always_beside_external_names`: `Mock`, `Brands`, `Stripe` and `RiveraHub` show "Mock" beside every "Stripe" and "Google Calendar".
    - `outcome_named_for_screen_readers`: `Automatic` has the button "Automatic. Change the outcome of: Payment links up to $300, checked by the reviewer.".
    - `outcome_menu_by_keyboard`: Tab to the button, then Enter → a menu with "Automatic" checked. Down twice, then Enter → `onChange('never')` once, and focus is back on the button, which still reads "Automatic". Open again, then Escape → closed, focus on the button, no call.
    - `outcome_read_only_without_on_change`: `ReadOnly` has no button.
    - `limit_reads_automatic_up_to`: `AutomaticWithLimit` and `RuleRow`'s `Shared` read "Automatic up to $20; over $20, ask me first".
    - `shared_rule_says_what_it_covers`: `Shared` shows "Shared rule. Applies to every tool that charges money: Payment link and Charge within a signed limit.".
    - `fallback_and_add_a_rule`: in `PaymentLinkOnPayments`, "Anything else here: ask me." shows and "Add a rule" → `onAddRule` once; `NoFallback` has neither.
    - `section_header_and_rows_are_links`: in `Payments`, the header is a link to its `href` that names "Payments", "Built in" and "2 tools", and each tool row is a link named "{name}: {summary}, {outcome}. Open".
    - `status_shows_in_words`: `NeedsReview` shows "Needs your review" where the outcome was.
    - `phone_hides_descriptions`: both `Phone` stories, at 390 px, hide the descriptions and counts, put `summary` under the name, and have no horizontal scroll.
    - `always_on_has_no_controls`: no buttons or inputs.
    - `diff_shows_enforced_values`: `RaiseDiscount` has the same reason on both sides, "Discounts up to 10%" before and "Discounts up to 50%" after, and the after line tagged "Changed".
    - `rows_are_tagged_in_words`: `AddAndRemove`, `TurnOnPayments` and `TurnBackOnRefund` show each tag's word as text.
    - `confirm_once`: two clicks → `onConfirm` once.
    - `same_failure_can_retry`: in `RepeatedFailure`, a screen that clears its error when a confirm starts and shows the same words when it fails lets the owner confirm three times; confirm is released on each error delivered, not only on new words.
    - `scope_change_is_shown`: `WidenScope` shows "Payment link" before and "Every tool that charges money" after, the after one tagged "Changed"; `ScopeChangedWithoutTargets` tags the title.
    - `limit_phrases_reflow`: at 320 px, "Automatic up to $10,000; over $10,000, ask me first" wraps with no sideways scroll in `RuleRow`'s, `ConnectorSection`'s and `ChangeReview`'s `NarrowMaxLimit`; under 640 px the outcome sits on its own line (`NarrowColumn`, both `Phone` stories).
    - `confirm_only_when_checked`: in `ChecksFailed` and `ChecksUnavailable`, confirm is disabled under their headings and lines.
    - `limit_only_change_keeps_confirm`: `LimitOnly` shows "Your rules stay the same.", "Confirm change" and "Keep my rules", and no "No rules change.".
    - `ask_claude_panel_is_a_log`: in `AddPayments`, an `aside` named "Ask Claude" holds the replies inside a `role="log"` with `aria-live="polite"`. "Close" → `onClose`; Escape → `onClose`; sending "Turn off Payments" → `onSend('Turn off Payments')`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/tokens.test.ts src/ds/components/{ConnectorSection,ChangeReview,OutcomeMenu,ToolRulesCard} && npx vitest run --project storybook src/ds/components/{ConnectorIcon,ConnectorName,OutcomeMenu,RuleRow,ToolRulesCard,ConnectorSection,ConnectorList,AlwaysOnList,ChangeReview,AskClaudePanel,Card,SegmentedControl}` → FAIL.
- [ ] **Step 3: Implement** with READMEs, the tokens (`npm run tokens`), the icons, the fixtures and the two story updates. `canvasNote`s:
  - `RuleRow`'s `Shared` and `ToolRulesCard`'s `PaymentLinkOnPayments`: the shared rule is the demo agent's charges up to $20, automatic, shown as "Automatic up to $20; over $20, ask me first"; the board's example is illustrative. A rule for one agent outranks the tool's own rule, so `rulesForTool` lists it first.
  - `ChangeReview`'s `RaiseDiscount`: the board shows only the after side of a changed row; a changed rule shows both, because the owner confirms what is enforced.
  - `ConnectorList`'s `RiveraHub`: Rivera keeps Documents, so the hub has six built-in connectors.
- [ ] **Step 4: Run** the same commands plus `npm run check:ds` → PASS (16 unit tests; 45 story tests, with the Card and SegmentedControl stories still passing).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add the rules hub pieces: connector sections, rule rows with outcome menus, the change review and the Ask Claude panel"`.

### Task 3: Connector and tool pages, adding a connector, and a changed tool

**Files:**
- Create under `web/src/ds/components/`: `Breadcrumb/`, `ConnectorHeader/` (also `ConnectorPromise`), `ConnectionPanel/`, `ToolPageHeader/`, `RecentRequests/`, `ConnectorPicker/`, `ConnectorSignIn/`, `ConnectorReview/`, `ConnectorOfferCard/`, `ToolChangedItem/`, `ToolReviewCard/`, `Steps/` (canvas: N-Conn-02-Payments to N-Conn-15-Changed-After), and two pieces Plan 04 needs for setup and Settings: `SubNav/`, `ToolLabel/` (`'none'`, naming the nearest board)
- Modify: `web/src/ds/index.ts`, `web/src/ds/fixtures/{rivera.ts,chen.ts}` (below)

**Interfaces:**
- Consumes: Task 2 (`ConnectorView`, `ConnectorIcon`, `ConnectorName`, `OutcomeMenu`, `OUTCOME_WORDS`, `outcomePhrase`, `RuleMode`, `ToolRulesCard`, `ChangeReview`, `describeEffects`); `ToolProfile` (Plan 03a Task 2), for the `ToolRowView` `Pick`; Task 0's `scrim` and `shadow-dialog` tokens; Plan 03a's `Card`, `Button`, `IconButton`, `Dialog`, `StatusLabel`, `Notice`, `Icon`.
- Produces:
  - `Breadcrumb({ items: { label: string; href?: string }[]; linkComponent? })`: a `nav` named "Breadcrumb" holding an ordered list. Every item but the last is a link; the last is plain text with `aria-current="page"`. Between items, "/", the separator the boards draw, `aria-hidden`: "Rules / Stripe / Refund".
  - `ConnectorHeader({ connector; status: 'on' | 'always_on' | 'connected' | 'off'; promise?: { title: string; detail?: string } })`, the top of a connector's page:
    - `ConnectorIcon` at `page` size and `ConnectorName` as the page's `h1` at `page` size, then `connector.description`.
    - At the right, the status in words with its dot: handled "On", "Always on" (Verification) or "Connected", info "Off".
    - `promise` shows under the header as `ConnectorPromise`: a card with the `lock` icon, `title` in weight 520 and `detail` in meta (Google Calendar: "Claude sees only when you're busy, never what the event is: no titles, guests or notes."). `ConnectorPromise({ title; detail? })` is also exported from the folder, for `ConnectorSignIn`.
  - `ConnectionPanel({ connector; details?: { label: string; value: string }[]; off: { kind: 'turn_off'; consequence: string; stops: { tools: string[]; rules: string[] }; onTurnOff: () => void; pending?: boolean } | { kind: 'always_on'; reason: string } })`, the end of a connector's page. `consequence` is the screen's sentence ("Claude stops offering payment links and charges.", "Disconnecting removes its tools from your Desk."). `stops` holds the names of the connector's tools and the reasons of the rules that stop applying, read by the screen from `RulesView`.
    - Built in: "Turn off {name}", then "{consequence} You'll see the change before it applies. Your rules are kept, so you can add it back." and a secondary "Turn off {name}".
    - External: "Connection", then `details` as a description list (Account, Connected, Customers it can see, Tool definitions; the screen's words, any date already formatted). Then "{consequence} You'll see the change before it applies. Your rules for them are kept in case you connect again." and a secondary "Disconnect".
    - The button opens a plain confirm, Plan 03a's `Dialog`, not a proved diff, since turning off only narrows and applies at once:
      - Title: "Turn off {name}?" or "Disconnect {name}?", the latter with the Mock badge after it, so a mock is never named without saying so.
      - Body: "These tools stop at once:" with `stops.tools` as a list, then "These rules stop applying:" with `stops.rules`, or "None of your rules stop applying." when there are none.
      - Then "Your rules are kept, so you can add it back." or "Your rules for them are kept in case you connect again.".
      - Confirm: "Turn off {name}" or "Disconnect". Cancel: "Keep it on" or "Keep it connected".
      - Confirm calls `onTurnOff` once, and the dialog waits (`aria-busy`) until `pending` clears, then closes; the screen says how it went. Cancel and Escape close it with no call.
    - `always_on` (Verification) shows "Always on. {reason}" ("It's how Claude confirms a customer before sharing anything private.") and no button.
  - `ToolPageHeader({ name; description; connector; status: ToolStatus; definitionNote?: string })`, the top of a tool's page:
    - `name` as the page's serif `h1`, then `description` (what the tool does and its effects).
    - The source line: `ConnectorIcon` at `inline` size, "From {name}" with its badge (`ConnectorName` at `inline` size), and the status in words with its dot. `enabled`: handled "On", followed by " · {definitionNote}" when given ("Definition unchanged", "Definition reviewed today"). `needs_review`: info "Off until you review a change". `disabled`: info "Off".
    - The master's owner-side demo action ("Connected integration"), "Simulate a tool change", which changes a connected tool's definition on its mock server, is built in Task 3c, with the mode switch and the money limit. This task's header has no control for it.
  - `RecentRequestView = { key: string; when: string; what: string; why: string; tone: StatusTone; outcome: string; href?: string }` and `RecentRequests({ rows: RecentRequestView[]; linkComponent? })`:
    - "Recent requests under these rules", then a row per request: `when` in meta; `what` (the decision's `reason_plain`); `why` in meta (the rule that decided it, or what happened); and at the right the outcome in words with its dot ("Automatic", "Waiting for your answer", "Stopped", "You allowed it").
    - Each row is a link to its record when `href` is given.
    - Empty: "No requests under these rules yet."
    - The screen passes every string; nothing here formats a time or an amount.
  - `PickerItem = { connector: ConnectorView; state: 'available' | 'added' | 'connected' | 'coming_soon' }` and `ConnectorPicker({ business: string; builtIn: PickerItem[]; external: PickerItem[]; note?: string; onChoose: (id: string) => void; onClose: () => void })` (N-Conn-07b, N-Conn-07):
    - A modal `<dialog>` (`showModal()`, over `scrim`, with `shadow-dialog`), named by its serif title "Add a connector".
    - "Add what fits {business}. Each tool you add starts at Ask me first unless one of your rules already covers it, and you review them before anything turns on."
    - Two lists, "Claude Desk" (built in) and "Other apps" (external). Each item shows `ConnectorIcon`, `ConnectorName` and the description, and at the right, by `state`:
      - `available`: a button "Add" (built in) or "Connect" (external), named "Add {name}" or "Connect {name}" → `onChoose(id)`.
      - `added`: "Added". `connected`: "Connected". `coming_soon`: "Coming soon in this demo".
    - Under the lists: `note` when given ("Google Calendar is coming soon in this demo. Until then, Claude offers the open times you set on Bookings."), and, whenever an external connector is listed, "Mock connectors stand in for the real apps. No account is used and nothing is sent to them."
    - Escape and an `IconButton` "Close" call `onClose`. Focus starts on the first button, and Tab stays inside.
  - `ConnectorSignIn({ connector; provider: string; promise: { title: string; detail?: string }; question: string; choices: { id: string; label: string; detail: string }[]; value: string; onChange: (id: string) => void; onContinue: (id: string) => void; onCancel: () => void; steps: StepsProps })` (N-Conn-08), for an external connector:
    - A modal `<dialog>` with `Steps` at the top, `ConnectorIcon`, and "Connect {name}" with its Mock badge (`ConnectorName`) as its title.
    - "A mock sign-in. No {provider} account is used, and nothing is read from or sent to {provider}.", then `ConnectorPromise`.
    - A radio group named by `question` ("Which calendar shows when you're busy?"), one choice per `choices` (label and detail).
    - "Cancel" → `onCancel`; primary "Continue" → `onContinue(value)`.
    - It asks for no account details: no text field and no password.
  - `ReviewToolView = { key: string; name: string; description: string; mode: RuleMode; coveredBy: { text: string; mode: RuleMode | 'always_on'; limit?: string }[] }` and `ConnectorReview({ connector; intro?: string; tools: ReviewToolView[]; onChangeOutcome?: (key: string, mode: RuleMode) => void; onTurnOn: () => void; onCancel: () => void; pending?: boolean; error?: string })` (N-Conn-09, N-Conn-11b), the review before anything turns on:
    - `ConnectorIcon` and the page's `h1` "Review what Claude could do with {name}", with its badge.
    - Built in: "A built-in connector, so there's nothing to sign in to. Nothing runs until you turn it on." External: "Nothing runs until you turn it on." followed by `intro` (the connector's promise).
    - A card with a row per tool: name and `description`; a line per `coveredBy`, "Covered by your rule: {text} · {outcomePhrase(mode, limit)}", or for an always-on line "Covered by your always-on rule: {text}", or with none, the board's "No rule of yours covers this yet, so it starts at Ask me first."; and `OutcomeMenu` at `mode`. The screen starts every new tool at "Ask me first"; `onChangeOutcome` makes each outcome a menu.
    - Primary "Turn it on" → `onTurnOn()` once, secondary "Cancel", and "You'll see the change to your rules before anything runs." Pressed, or while `pending`, the button keeps its label under the busy spinner (`aria-busy`), as busy buttons do, until `pending` has come and gone or an error is delivered.
    - `error` shows the screen's message in an error `Notice`.
  - `ConnectorOfferCard({ connector; toolsLine: string; coverage?: string; action: 'add' | 'connect' | 'turn_off' | 'disconnect' | 'coming_soon'; onReview: () => void })` (N-Conn-12-Chat), Claude's card in the Ask Claude panel. It leads into the same review as the picker, and nothing turns on or off from it.
    - `ConnectorIcon`, `ConnectorName`, `toolsLine` ("2 tools · Payment link, Charge within a signed limit") and `coverage` ("Covered by your always-on rule: no money moves without your rule or a signed limit.").
    - The button by `action`: "Review and add", "Review and connect", "Review and turn off" or "Review and disconnect" → `onReview()`. `coming_soon` shows "Coming soon in this demo." and no button.
  - `ToolChangedItem({ connector; tool: string; noticed: string; consequence: string; onReview: () => void })` (N-Conn-13), Today's "Needs you" item for a tool that a changed definition switched off:
    - A `Card` (`article`) with a held dot and "{connector name} changed “{tool}”, so it's off until you review it."
    - In meta: "{connector name} · Mock · {noticed}. {consequence}" ("Noticed today at 9:14", "Refunds can't run until you decide.").
    - "Review" → `onReview()`, which opens the tool's page.
  - `type ToolRowView = Pick<ToolProfile, 'tool' | 'source' | 'effects' | 'reversible' | 'status' | 'description_confirmed' | 'definition_sha256' | 'pending_definition_text' | 'pending_sha256'>`, kept, so both a `ToolProfile` and the API's `ToolRow` fit.
  - `ToolReviewCard({ title; connector: ConnectorView; profile: ToolRowView; noticed; onTurnBackOn: (definitionSha256: string) => void; onKeepOff: (definitionSha256: string) => void; pending?; error? })` (N-Conn-14), for a `needs_review` tool, kept from the old Task 3 with the connector's words:
    - A held dot and "Needs your review", with `noticed` at the right ("Noticed today at 9:14, when the tools were listed again").
    - In serif `.cd-type-summary`: "{connector name} changed “{title}”, so it's turned off until you review it. Until you decide, it can't run at all."
    - "What you confirmed before", with `description_confirmed` and `describeEffects(profile.effects, profile.reversible)`.
    - "What the connector says now": a `blockquote` (padding 10px 12px, a hairline border, `--bg-app`), labelled "Quoted from the connector. Claude never sees this text; it sees only the description you confirmed.". It holds `pending_definition_text` as literal text (mono 12/18 `.cd-type-trace`, `pre-wrap`, `overflow-wrap: anywhere`, `data-copy="user"`), never parsed as markup.
    - "Turning it back on trusts the new definition and checks your rules again before it runs.", then primary "Turn back on" and secondary "Keep off", each called with `profile.pending_sha256`. Kernel `POST /tools/confirm` drafts a version to prove, which the screen shows in a `ChangeReview`; the tool stays `needs_review` until that version is confirmed.
    - Without `pending_sha256`, or without `pending_definition_text` to review (missing, empty or only blank space), both buttons are disabled under "This change can't be reviewed right now. Reload the page."
    - `pending` disables both, with `aria-busy`. `error` shows the screen's message (for `conflict`: "The tool changed again while you were reviewing. Review the newest version.").
    - The after-state (N-Conn-15) is the screen's: `ToolPageHeader` with "Definition reviewed today", and an info `Notice` ("Refund is back on. Your rules were checked against its new definition, and refunds still wait for your answer.").
  - `Steps({ label: string; steps: readonly string[]; current: number })` (N-Conn-08 to N-Conn-11b; setup): an ordered list in a row, joined by hairlines. `current` counts from 0, as Plan 04's setup steps do.
    - Steps before `current` show `check` and read "{name}, done".
    - The current step is a filled 22 px circle with its number, with `aria-current="step"`; later steps are quiet numbered circles.
    - The add flow passes "Choose", "Sign in", "Review tools", "Confirm" for an external connector, or "Choose", "Review tools", "Confirm" for a built-in one; setup passes its five steps.
  - `SubNav({ label; items: { key; label; href }[]; current; linkComponent? })`, kept for Settings (Plan 04): vertical links with `aria-current="page"` and `--size-nav-row` rows; a horizontal scroller at phone width.
  - `ToolLabel({ text })`, kept for setup: an inline tool label (icon, `.cd-type-meta`) for setup's `tool_label` messages ("Searched your Claude memory").
  - **Fixtures.**
    - `rivera.ts` gains `recentRequests`, the Refund and Quote rows on N-Conn-05-Refund and N-Conn-06-Quote, and `toolPages`, the `ToolPageHeader` strings for both.
    - `rivera.ts` gains `stripeConnection`, the details on N-Conn-03-Stripe with its consequence and what stops, `paymentsConnection` and `verificationConnection` for the other two panels, and `changedRefund`, the changed tool's words on N-Conn-13 to N-Conn-15.
    - `rivera.ts` gains `googleCalendar`: the catalog-only connector's `ConnectorView` and its flow on N-Conn-04 and N-Conn-07 to N-Conn-11, with its sign-in choices ("Rivera Plumbing jobs", "Personal"), its review row and its change rows.
    - `chen.ts` gains `picker`: Payments to add; Quotes, Bookings, Leads and callbacks, and Documents added; Google Calendar coming soon; Stripe to connect. Verification is never listed, since it is always added.
    - `chen.ts` gains `paymentsReview`: Payment link and Charge within a signed limit, each at "Ask me first", each covered by the always-on "No money moves without your rule or a signed limit".
    - `chen.ts` gains `paymentsOffer`, the card in Chen's Ask Claude panel, and `calendarOffer`, the coming-soon card.

- [ ] **Step 1: Write the stories:**
  - `Navigation/Breadcrumb`: `ToolPage` (Rules / Stripe / Refund).
  - `Connectors/ConnectorHeader`: `Payments`, `Verification`, `Stripe`, `GoogleCalendar` (with its promise), `Off`.
  - `Connectors/ConnectionPanel`: `TurnOffPayments`, `DisconnectStripe`, `DisconnectGoogleCalendar`, `Pending`, `VerificationAlwaysOn`.
  - `Connectors/ToolPageHeader`: `Refund`, `Quote`, `RefundNeedsReview`, `RefundReviewed`, `Off`.
  - `Connectors/RecentRequests`: `Refund`, `Quote`, `WithoutRecords`, `Empty`, `Phone`.
  - `Connectors/ConnectorPicker`: `ChenComingSoon`, `RiveraConnectable`, `Phone`.
  - `Connectors/ConnectorSignIn`: `GoogleCalendar`, `NothingChosen`, `Phone`.
  - `Connectors/ConnectorReview`: `ChenPayments`, `CancelFirst`, `GoogleCalendar`, `CoveredByARule`, `TurningOn`, `Error`, `Phone`.
  - `Connectors/ConnectorOfferCard`: `AddPayments`, `Disconnect`, `ComingSoon`.
  - `Connectors/ToolChangedItem`: `StripeRefund`, `Phone`.
  - `Connectors/ToolReviewCard`: `CreateRefundChanged`, `KeepOff`, `Sending`, `ChangedAgain`, `NoHash`, `NoDefinitionText`, `EmptyDefinitionText`, `BlankDefinitionText`, `IndentedDefinition`, `Phone`.
  - `Navigation/Steps`: `ReviewToolsOfFour`, `SetupThirdOfFive`, `Phone`.
  - `Navigation/SubNav`: `Settings` (General, Knowledge, Notifications, Channels, Billing; connectors live only under Rules), `Phone`.
  - `Conversation/ToolLabel`: `Memory`, `Website`, `CouldNotRead`.
  - Plays:
    - `breadcrumb_marks_the_page`: two links, then "Refund" with `aria-current="page"`; the separators are hidden from screen readers.
    - `connector_status_in_words`: `Payments` shows "On", `Verification` "Always on" and `Stripe` "Connected", each beside a dot.
    - `turn_off_confirms_first`: in `TurnOffPayments`, "Turn off Payments" opens a dialog named "Turn off Payments?" that lists "Payment link" and "Charge within a signed limit" and the rules that stop applying. "Keep it on" closes it with no call. Opening it again and pressing its "Turn off Payments" → `onTurnOff` once, over two clicks. `DisconnectStripe` has the details list, and its dialog reads "Disconnect Stripe?".
    - `always_on_has_no_turn_off`: `VerificationAlwaysOn` shows "Always on. It's how Claude confirms a customer before sharing anything private." and no button.
    - `recent_requests_show_outcomes_in_words`: each row's outcome word beside its dot; `Empty` shows its line.
    - `picker_by_keyboard`: the dialog named "Add a connector" opens with focus on "Add" (Payments). Tab stays inside it. Enter → `onChoose('payments')` once. Escape → `onClose`.
    - `picker_states_in_words`: in `ChenComingSoon`, the added built-ins read "Added", Google Calendar reads "Coming soon in this demo" with no button, Stripe has "Connect", and the mock line shows.
    - `sign_in_collects_nothing`: in `GoogleCalendar`, the only inputs are radios, none of type text, email or password. The mock line names Google. "Continue" → `onContinue('rivera-jobs')`.
    - `review_starts_at_ask_me_first`: in `ChenPayments`, each row's outcome is "Ask me first" with its covered-by line. Two clicks on "Turn it on" → `onTurnOn` once. "Cancel" → `onCancel`. "You'll see the change to your rules before anything runs." shows.
    - `offer_card_only_opens_the_review`: in `AddPayments`, "Review and add" → `onReview` once and no other callback; `ComingSoon` has no button.
    - `tool_changed_item_says_what_and_why`: `StripeRefund` shows the title with “Refund” and "Stripe · Mock", and "Review" → `onReview`.
    - `quoted_definition_is_text`: `CreateRefundChanged` has no `img` element, the quote's text equals the fixture exactly, and the summary and the quote's label read as above.
    - `confirm_names_the_reviewed_hash`: Tab to "Turn back on", then Enter → `onTurnBackOn` once, with the fixture's `pending_sha256`.
    - `no_hash_no_confirm`: in `NoHash`, both buttons are disabled and the notice shows.
    - `current_step_marked`: the current step has `aria-current="step"`, and done steps read "{name}, done".
    - `current_is_marked`: `SubNav`'s current link has `aria-current="page"`.
    - `tool_label_is_text`.
- [ ] **Step 2: Run** `cd web && npx vitest run --project storybook src/ds/components/{Breadcrumb,ConnectorHeader,ConnectionPanel,ToolPageHeader,RecentRequests,ConnectorPicker,ConnectorSignIn,ConnectorReview,ConnectorOfferCard,ToolChangedItem,ToolReviewCard,Steps,SubNav,ToolLabel}` → FAIL.
- [ ] **Step 3: Implement** with READMEs and the fixtures. `canvasNote`s:
  - `ToolReviewCard`: the quote is the fixture's drifted definition, whose markup must show as text, not the board's sentence. "What you confirmed before" shows `description_confirmed`, the text Claude sees, where the board shows the tool's short line.
  - `ToolPageHeader`'s `Quote`: a built-in tool has no pinned definition, so it gets no definition note, where the board shows "Definition unchanged".
  - `ConnectorReview`'s `GoogleCalendar`: an earlier draft of the board started the tool at "Automatic", "from your Bookings rule"; every new tool starts at "Ask me first", with the rules that cover it shown, and the board's current render agrees.
  - `ConnectorPicker`: a "Close" button, which the board doesn't draw, so the dialog closes by pointer as well as by Escape. The mock line also shows under the coming-soon note.
  - `ConnectionPanel`'s `DisconnectStripe`: the line says the change shows first, which the plain confirm does.
  - `ConnectionPanel`'s `VerificationAlwaysOn` and `ConnectorHeader`'s `Verification`: no board draws Verification's page; the owner decided its words.
  - The Google Calendar stories: Google Calendar is catalog-only in the demo, so they show what the components support once it works.
- [ ] **Step 4: Run** the same command plus `npm run check:ds` → PASS (57 story tests).
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(ds): add connector and tool pages, the add-a-connector flow and the changed-tool review"`.

### Task 3c: How Claude works, the money limit and the simulate strip

The project owner asked for these three pieces to be built after Tasks 2–3, in a change of their own that merges only once he signs their boards (owner decision, 2026-10-29). The boards are on the design canvas's "Claude Desk · Connectors and rules" page:

| Board | Screen |
|---|---|
| N-Conn-17-Mode | Rules with the "How Claude works" card: the mode switch at Custom, the money limit reading $500 |
| N-Conn-18-Mode-Review | Switching to Ask me first: the proved change, one Changed row per rule that goes away |
| N-Conn-19-Money-Cap | The money limit's field open in the card (1000 typed) |
| N-Conn-20-Money-Cap-Review | Raising the limit to $1,000: the "New limit" card, "Your rules stay the same.", Confirm change |
| N-Conn-21-Simulate | Stripe's Refund page with the demo-only simulate strip under the header |
| N-Conn-22-Phone-Mode | The card on a 390 px phone |

Owner answers (2026-10-29):
1. A change that can cancel open payment links says so, in one static line: "Open payment links I made on my own that the new rules don't allow will be cancelled." Applying a preset or a lower limit cancels the open auto-allowed links the new rules version no longer allows (master "Cancellation at activation", `POST /policy/confirm`); a link still inside the new rules stays payable. No contract field is added: the screen knows when a change can cancel links.
2. Tool rows stay editable under a preset; editing one makes the mode "Custom". There is no read-only state.
3. A preset's review opens on its own page, like N-Conn-10.
4. On phones each outcome sits on its own line under the tool (N-Conn-16, N-Conn-22).

Every string here is owner-facing (no Spanish). Components display what the screen passes. Nothing here decides an outcome, parses or formats money, or calls the kernel.

**Files:**
- Create under `web/src/ds/components/`: `HowClaudeWorks/`, `MoneyLimit/`, `LimitChange/` (each with `.tsx`, `.css`, `.stories.tsx`, `README.md`).
- Modify:
  - `web/src/ds/components/OutcomeMenu/outcomeWords.ts`: `PRESET_CAPTIONS`.
  - `web/src/ds/components/ToolPageHeader/`: `onSimulateChange`, `simulatePending` and the strip, moved here from Task 3.
  - `web/src/ds/components/ChangeReview/`: `cancelsLinks`.
  - `web/src/ds/components/SegmentedControl/`: `disabled`.
  - `web/src/ds/index.ts`: the new exports.
  - `web/src/ds/reference/boards.ts`: `REFERENCE_BOARDS` gains N-Conn-17-Mode to N-Conn-22-Phone-Mode.
  - `web/src/ds/reference/README.md`: a line per board.
  - `web/src/ds/fixtures/rivera.ts`: `rulesMode`, `askFirstReview` and `limitRaise` (below).

**Moved out of Task 3**, which keeps `ToolPageHeader` otherwise unchanged: its `onSimulateChange` and `simulatePending` props and the "Simulate a tool change" strip, the `Connectors/ToolPageHeader` story `WithSimulate`, the play `simulate_only_when_on`, and the interface `onSimulateChange` → `POST /tools/simulate_change`. `PRESET_WORDS` and the `SegmentedControl` story's relabel stay in Task 2.

**Interfaces:**

- **Words.** `PRESET_CAPTIONS: Record<RulesPreset, string>`, next to `PRESET_WORDS`:
  - `ask_first`: "Claude asks you before it quotes, books, shares a document or takes a payment. It still finds open times, saves leads and confirms who people are."
  - `auto`: "Claude quotes at list price, books weekdays in your hours and sends verified customers their own documents. Payments ask you first."
  - `custom`: "Your own rules, tool by tool. Change any of them below."

  The two preset captions describe `desk.presets.PRESETS` (plan 01a Task 3). A test pins them to that table's cards (`preset_captions_match_the_presets`, below), so a preset change fails it.

- **`HowClaudeWorks({ preset: RulesPreset; onPreset: (preset: 'ask_first' | 'auto') => void; disabled?: boolean; children?: ReactNode })`** (N-Conn-17-Mode, N-Conn-22-Phone-Mode). A `Card` at the top of Rules, under the page header:
  - "How Claude works" as the section's `h2`, the caption `PRESET_CAPTIONS[preset]` in secondary meta, and at the right a `SegmentedControl` labelled "How Claude works" with `PRESET_WORDS`, its value `preset`.
  - Choosing "Ask me first" or "Automatic" calls `onPreset` once; a second press before the screen answers sends nothing. The screen drafts the preset and opens its review. The control keeps showing `preset` (the active version's) until the screen passes a new one, and takes the next pick once the screen passes a new preset or its draft (`disabled`) has come and gone.
  - Choosing "Custom" calls nothing: Custom is a state ("your rules differ from both presets"), not an action. Plan 04 shows Custom when `RulesView.preset` is `custom`, which it becomes on its own when any tool's rule changes.
  - `disabled` (a draft in flight) disables the control: `aria-disabled` on it and each option, so focus stays put, and clicks and keys do nothing. `children`, the `MoneyLimit`, follows a hairline.
  - Under 640 px the switch sits under the caption at its own width (N-Conn-22), with no horizontal scroll at 390.

- **`MoneyLimit({ line: string; help: string; editing: boolean; label?: string; value: string; hint: string; error?: string; onEdit: () => void; onChange: (value: string) => void; onReview: () => void; onCancel: () => void; disabled?: boolean })`** (N-Conn-17-Mode, N-Conn-19-Money-Cap):
  - Reading: `line` ("Most I take without asking: $500", or "Nothing: every charge and payout asks you" at 0, plan 04's words) at body weight 520, then `help` in secondary meta, and a secondary "Change" → `onEdit`.
  - Editing: a `TextField` (`label`, default "Most I take without asking, in dollars"; `value`; `hint` from the screen, e.g. "Whole dollars, from 0 to 10,000. Now $500."; `error`), then a primary "Review change" → `onReview` (Enter in the field too) and a secondary "Cancel" → `onCancel`. Opening the field moves focus into it, and closing it moves focus back to "Change".
  - The component never parses the value. The screen checks it and passes `error` ("No single payment can be above $10,000."), and then sends nothing. `disabled` puts the buttons in their waiting state.
  - `help` copy (new): "The most Claude takes or pays out in one payment without asking you. Above it, Claude always asks."

- **`LimitChange({ now: string; was: string })`** (N-Conn-20-Money-Cap-Review). A `Card` with `now` in serif 18/27 ("New limit: up to $1,000 without asking you.", plan 04's `moneyCapWords`) and `was` ("Was $500") in secondary meta at the right, baseline-aligned. Plan 04's `RuleDraftReview` puts it above `ChangeReview` when the draft changes the limit, with `hasOtherChanges`.

- **`ToolPageHeader`, simulate** (N-Conn-21-Simulate):
  - For an external connector's tool while `status` is `enabled`, `onSimulateChange` adds a strip under the source line: a bordered row (`line-card`, `radius-card`, no fill) with the caption "Demo only. Changes this tool's definition on the mock {connector name} server, so you can see what happens." in secondary meta at the left, and a ghost `Button` "Simulate a tool change" at the right → `onSimulateChange` once.
  - `simulatePending` puts the button in its busy state (spinner in place of the label, same width) until it clears.
  - There's no strip for a built-in tool, a `needs_review` or `disabled` tool, or without `onSimulateChange`.
  - What follows is the existing flow: the tool turns `needs_review` (N-Conn-13 on Today, N-Conn-14 on the tool page).

- **`ChangeReview`, `cancelsLinks?: boolean`.** When set, the fixed line "Open payment links I made on my own that the new rules don't allow will be cancelled." shows above the buttons in secondary body text. The screen sets it when the change can cancel links (a preset switch or a lowered limit); the design system never decides that. A raise cancels no link, so the limit's raise review (N-Conn-20) doesn't set it.

- **The preset review** (N-Conn-18-Mode-Review) is `ChangeReview` as Task 2 builds it, with `cancelsLinks`. The rows are the screen's (plan 04):
  - Each active owner card that the preset drops becomes a `changed` row. `before` is the card's side; `after` is the default side `{ mode: 'ask', reason: 'Not covered by a rule you set, so I ask you.', words: [{ field: 'who', text: 'Anyone' }] }`, the house-rules wording. The default replaces the whole rule, which the row's tag says, so `changed` lists only `mode`, and only when it changes: the "Changed" tag sits beside the outcome only then (Refund already asks, so its row has none).
  - Cards the preset adds are `added` rows.
  - The page is `PageHeader` "Switch to Ask me first" / "Switch to Automatic" with "Here's exactly what changes on your Desk. Nothing changes until you confirm.", then `ChangeReview` with "Confirm change" and "Keep my rules", the same page shape as N-Conn-10.

- **Fixtures** (`rivera.ts`):
  - `rulesMode`: `{ preset: 'custom', capLine: 'Most I take without asking: $500', capHelp: <the help copy>, capHint: 'Whole dollars, from 0 to 10,000. Now $500.' }`.
  - `askFirstReview: ChangeRowView[]`: the eight rows from Rivera's own cards to the default side (Quote; Book a visit ×2; Share a document; Payment link; Charge within a signed limit; See charges; Refund). The board's ninth row, a shared rule for Alex Kim's assistant, is the illustrative shared card, which isn't in Rivera's seed.
  - `limitRaise`: `{ now: 'New limit: up to $1,000 without asking you.', was: 'Was $500' }`.

- [ ] **Step 1: Write the stories and tests:**
  - `Rules/HowClaudeWorks`: `Custom` (Rivera, with `MoneyLimit` reading), `AskMeFirst`, `Automatic`, `Drafting` (`disabled`), `DraftFailed` (the switch takes a pick again once the draft has come and gone), `EditingLimit` (N-Conn-19), `LimitTooHigh` (error "No single payment can be above $10,000."), `UnsetLimit` ("Nothing: every charge and payout asks you"), `Phone` (390 px, N-Conn-22).
  - `Rules/MoneyLimit`: `Reading`, `Editing`, `Waiting` (`disabled`).
  - `Rules/LimitChange`: `Raise`.
  - `Rules/ChangeReview`: `SwitchToAskMeFirst` (`askFirstReview` with `cancelsLinks`, N-Conn-18).
  - `Connectors/ToolPageHeader`: `WithSimulate`, `Simulating`; `Quote`, `RefundNeedsReview` and `Off` pass `onSimulateChange` too.
  - Play tests:
    - `preset_pick_calls_once`: "Automatic", pressed twice → one `onPreset('auto')`.
    - `custom_drafts_nothing`: "Custom" from `AskMeFirst`, by pointer or keyboard → no call.
    - `current_preset_is_checked`: `aria-checked` on the passed preset, with the caption from `PRESET_CAPTIONS`.
    - `drafting_disables_the_switch`.
    - `change_opens_the_field` (`MoneyLimit`'s `Reading`): "Change" → `onEdit`, and focus moves into the field the screen opens.
    - `review_passes_no_value` (`MoneyLimit`'s `Editing`): "Review change" and Enter → `onReview` with no arguments; typing calls `onChange` with the raw string.
    - `limit_error_is_announced`: `LimitTooHigh` marks the field `aria-invalid` and shows the error in a live region.
    - `unset_limit_never_says_zero`: no "$0".
    - `switch_wraps_on_phone`: at 390 the switch's top is below the caption's bottom, and `scrollWidth <= innerWidth`.
    - `limit_change_reads_both_amounts`.
    - `preset_review_tags_only_new_outcomes`: Refund's row has no "Changed" beside its outcome; Quote's does.
    - `cancel_line_only_when_asked`: `SwitchToAskMeFirst` shows the line between the checks and the buttons; `LimitOnly` and `RaiseDiscount` don't.
    - `simulate_only_when_on`: moved from Task 3. `WithSimulate` has the strip; `RefundNeedsReview`, `Off` and `Quote` (built in) don't, even with `onSimulateChange`, and `Refund` has none without it.
    - `simulate_calls_once`.
    - `simulate_busy_keeps_its_width`.
  - Unit: `outcomeWords.test.ts` `preset_captions_match_the_presets`: each caption's claims agree with a copied table of the plan 01a presets, and the Automatic caption names exactly the tools that preset makes automatic beyond Ask me first.
  - Every story has `parameters.canvas` set to its board, or `'none'` naming the nearest board.
  - axe runs on every story.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/components/OutcomeMenu && npx vitest run --project storybook src/ds/components/{HowClaudeWorks,MoneyLimit,LimitChange,ChangeReview,ToolPageHeader}` → FAIL.
- [ ] **Step 3: Build** until they pass. Use tokens only, no raw colors. The strip uses existing tokens (`line-card`, `radius-card`).
- [ ] **Step 4: Run** the same commands plus `npm run check:ds` → PASS (2 unit tests; 36 story tests).
- [ ] **Step 5: Board check:** the six boards against their renders at 1512×982 (the phone board at 390×844), as Task 6 does for N-Conn-01 to 16, one line each in `web/src/ds/reference/README.md`. Task 6's render check treats N-Conn-22-Phone-Mode as a phone board, as it does N-Conn-16-Phone-Rules.
- [ ] **Step 6: Commit** `feat(ds): add the rules mode card, the money limit and the simulate strip`, then `test(ds): check the mode, money limit and simulate boards against the design canvas`.

**For plan 04** (consumers, not built here):
- `RulesPage` uses `HowClaudeWorks` + `MoneyLimit` in place of the bare `SegmentedControl` and limit line, and its labels move from "Auto" to "Automatic".
- `draftPreset` opens the review page (N-Conn-18) rather than an inline review, with `cancelsLinks`; a lowered limit's review sets it too.
- `RuleDraftReview` uses `LimitChange` when `moneyCap` is set.
- The tool page passes `onSimulateChange` → `simulateToolChange`, `simulatePending` while it runs.
- The preset rows come from the dropped cards, as above.

### Task 4: Visual check of the owner boards

**Files:**
- Create: `web/src/ds/reference/README.md`, `web/src/ds/boards/TodayNeedsYou.stories.tsx`, `ConversationLive.stories.tsx`, `ConversationAgent.stories.tsx`, `ReviewerArrival.stories.tsx`, `IntroArrival.stories.tsx`
- Test: `web/src/ds/reference/boards.test.ts`, the board stories

**Interfaces:**
- Produces: board stories `Boards/Today, needs you`, `Boards/Conversation, live`, `Boards/Conversation, agent`, `Boards/First visit`, `Boards/First visit, intro` (`layout: 'fullscreen'`, `parameters.canvas` set to the board).

**Board spec** (from the canvas; each board story's play asserts the rows that apply with `expectComputed`, except the receipt row's placement, which it checks by bounding box as the design system code's `receipts_sit_under_their_message` does, plan 03a):

| Element | Expected |
|---|---|
| Sidebar | width 264px; background `rgb(34, 34, 32)`; right border 1px `rgba(250, 249, 245, 0.12)` |
| Active nav row | height 36px; background `rgb(60, 57, 47)`; radius 8px; 14px/20px weight 420 |
| Page title / greeting | Source Serif 4, 24px/32px weight 460 / 36px/44px weight 300 |
| Content column | max-width 960px; main padding 24px 40px 20px |
| Claude's reply | Source Serif 4, 15px/23px weight 360, color `rgba(250, 249, 245, 0.92)` |
| Visitor bubble | background `rgba(250, 249, 245, 0.06)`; radius 12px; padding 8px 14px; 15px/21px |
| Receipt under its message | attached 8px directly under the message it belongs to, at every width (no margin column), on its side: starting at the message's left edge, or ending at a visitor bubble's right edge; 12px/17px, color `rgba(250, 249, 245, 0.64)`; dot 6px |
| Card | background `rgba(250, 249, 245, 0.03)`; border 1px `rgba(250, 249, 245, 0.14)`; radius 12px; padding 20px |
| Secondary button (main) | height 40px; radius 8px; background `rgba(250, 249, 245, 0.1)`; 14px/20px weight 420 |
| Primary button | background `rgb(239, 236, 228)`; color `rgb(28, 27, 25)` |
| Composer | background `rgb(42, 41, 39)`; radius 16px; shadow includes `0px 4px 20px` |
| Concept footer | the exact string, 12px/17px, color `rgba(250, 249, 245, 0.64)` |

- [ ] **Step 1: Write the failing tests.** `boards.test.ts`: `every_reference_board_has_a_render` (with `DS_REFERENCE_DIR` set, `<board>.png` exists for every `REFERENCE_BOARDS` entry and is 1280×820, read from the PNG header; unset, as in CI, it skips with a message); `board_stories_name_reference_boards`. Board stories compose components and fixtures (receipts through `receiptFromEvent`, attached under their messages, with a `canvasNote` on each board that draws them in a margin column saying the owner moved them under each message on 2026-10-29; on Today the approval card's answers follow the signed-off answer board, N-Answers-TwoButtons option 2 (Allow and Deny, each a plain button or a menu button, with `deny_always` offered only when an ask card held the request, never for a limit hold), not the board's four secondary buttons, as its `canvasNote` says; Conversation, live has the whisper composer and `TakeOverBar` in `ai` mode; First visit has `ReviewerBar`, `Greeting` and the sidebar, its `canvasNote` saying the things-to-try list is drawn by `IntroDialog` (Task 0), with the web app (plan 04) passing its items; First visit, intro has `IntroDialog` with the board's copy over a still render of Today, its `canvasNote` naming that preview as the web app's (plan 04)); play runs the applicable spec rows and `focus_order_is_logical` (Tab reaches the business switcher, the nav in order, then the composer, then on Today the first approval card's first answer after the chips). Each `canvasNote` lists content differences.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/reference && npx vitest run --project storybook src/ds/boards` → FAIL (board stories missing, or spec mismatches).
- [ ] **Step 3: Build the board stories** and fix components (never assertions) until the spec rows pass; a value that truly differs from the canvas goes in the reference README with the reason.
- [ ] **Step 4: Compare by eye** per `using-browsers` (headless `agent-browser`, its worktree session). With `npm run storybook -- --ci` in the background, per board: `set viewport 1280 820`, open `http://localhost:6006/iframe.html?id=<story-id>&viewMode=story`, screenshot to `.plan-runs/<plan-slug>/shots/` and compare with `$DS_REFERENCE_DIR/<board>.png` (type, colors, spacing, radii, hairlines, receipts under the right messages on their side, at most one motion moment). At `1440 900` and `390 844`, `eval "document.documentElement.scrollWidth <= innerWidth"` is `true` and nothing is clipped. A keyboard walk shows the 2 px blue ring at every stop. Fix deltas in components; rerun Step 2.
- [ ] **Step 5: Record** one line per board in `reference/README.md` (board, story, date, viewports, deltas fixed, deviations kept and why); the renders themselves stay out of the repo.
- [ ] **Step 6: Run** `cd web && npm test && npm run typecheck` → PASS (all unit and story tests).
- [ ] **Step 7: Commit** `git add web && git commit -m "test(ds): check the owner app boards against the design canvas"`.

### Task 5: Visual check of the public boards and take-over

**Files:**
- Create: `web/src/ds/boards/PublicBooked.stories.tsx`, `PublicHandoff.stories.tsx`, `ConversationTakeOver.stories.tsx`
- Modify: `web/src/ds/reference/README.md`

**Interfaces:**
- Produces: `Boards/Public page, booked` (N-Public-Rivera), `Boards/Ask for Maria` (N-Public-Handoff, both states side by side as on the board) and `Boards/Conversation, taken over` (N-Conv-TakeOver: `TakeOverBar` in `owner` mode, `PersonMessage`, the owner composer).

- [ ] **Step 1: Write the board stories** with play assertions: brand header 76px high, padding 0px 40px; the AI disclosure; the composer row per the board spec; the booking card is a `ReplyCard` with template `booking_confirmed`; `SystemLine` "Maria Rivera joined the chat" has `role="status"` and no time (`canvasNote`: the board's time is left out, as no contract carries it); visitor receipts are read-only `MarginReceipt`s attached under their messages on the message's side, the rows filling the chat column (the `canvasNote` notes the boards draw none, and that the header's phone is the `contact` charter block); `focus_order_is_logical` ("Ask for Maria Rivera", any card action, the composer; on the take-over board, "Hand back to Claude" then the composer).
- [ ] **Step 2: Run** `cd web && npx vitest run --project storybook src/ds/boards/{PublicBooked,PublicHandoff,ConversationTakeOver}.stories.tsx` → FAIL until the stories and fixes land.
- [ ] **Step 3: Compare by eye** as in Task 4 Step 4 at 1280×820 against the three references, then 1440×900 and 390×844, with a keyboard walk; check the Spanish story at 390×844 for clipped buttons.
- [ ] **Step 4: Record** three README lines.
- [ ] **Step 5: Run** `cd web && npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git add web && git commit -m "test(ds): check the public page and take-over boards against the design canvas"`.

### Task 6: Visual check of the verification, safety, switcher, rules and connectors boards

The connectors boards are drawn as AGENTS.md asks, at a 14-inch laptop's width or a phone's. They are rendered at a 1512×982 viewport (N-Conn-16-Phone-Rules at 390×844), and a board taller than one screen is captured at full height. The Chen verify, Safety and Switcher boards stay at 1280×820.

**Files:**
- Create: `web/src/ds/boards/ChenVerify.stories.tsx`, `Safety.stories.tsx`, `Switcher.stories.tsx`, `ConnectorsHub.stories.tsx`, `ConnectorPages.stories.tsx`, `AddConnector.stories.tsx`, `ToolChanged.stories.tsx`
- Modify: `web/src/ds/reference/README.md`, `web/src/ds/reference/boards.test.ts`, `web/.storybook/preview.tsx` (a `board` viewport, 1512×982)

**Connectors board spec** (from the board sources; each connectors board story's play asserts the rows that apply with `expectComputed`, with Task 4's spec rows):

| Element | Expected |
|---|---|
| Connector section | Task 4's card background, border and radius 12px; no padding of its own (`overflow: hidden`) |
| Section header link | padding 14px 16px; icon tile 36px, radius 8px, background `rgba(250, 249, 245, 0.1)`, or `rgb(255, 255, 255)` behind a brand mark |
| Tool row | padding 12px 16px; top border 1px `rgba(250, 249, 245, 0.12)`; name weight 520 |
| Outcome menu button | height 32px; border 1px `rgba(250, 249, 245, 0.22)`; radius 8px; background `rgba(0, 0, 0, 0)` |
| Change tag | width 64px; border 1px `rgba(250, 249, 245, 0.22)`; fully rounded |
| Steps | circle 22px; the current one `rgb(239, 236, 228)` |
| Quoted definition | padding 10px 12px; border 1px `rgba(250, 249, 245, 0.12)`; radius 8px; background `rgb(28, 27, 25)`; 12px/18px mono; `white-space: pre-wrap` |
| Ask Claude panel | width 400px; left border 1px `rgba(250, 249, 245, 0.12)` |

- [ ] **Step 1: Write the failing tests and the board stories.**
  - `boards.test.ts`:
    - Adds `every_reference_board_has_a_board_story`: each `REFERENCE_BOARDS` entry is named by a `Boards/*` story.
    - Changes `every_reference_board_has_a_render`: an `N-Conn-*` render is 1512 px wide and at least 982 tall; N-Conn-16-Phone-Rules is 390 wide and at least 844 tall; every other board stays 1280×820.
  - Stories, with the applicable Task 4 spec rows:
    - Chen verify shows `VerifiedLine` with "Simulated verification" and a `document_link` card.
    - Safety shows the attempts list and one `FullTrace`.
    - Switcher shows the menu open over Today, listing only businesses and "New business" (`canvasNote`: the board's two columns become one menu of businesses; its Desks, New Desk and their status dots are in the sidebar's Desk picker or left out).
  - The connectors stories, each at the `board` viewport (the phone board's at `phone`), with `parameters.canvas` its board. Every Rules page has `PageHeader` "Rules", subtitle "What Claude can do on this Desk, where each tool comes from, and your rules for it.", and "Add a connector". Its owner `Composer` reads "Ask Claude to change a rule or a connector", with the helper "Claude shows you the change and example situations before anything applies.", above the board's chips.

| Story | Board | Shows |
|---|---|---|
| `Boards/Rules and connectors` (`ConnectorsHub`) | N-Conn-01-Rules | Rivera's Rules page: `ConnectorList` with six built-in sections and Stripe, then `AlwaysOnList` |
| `Boards/Rules on a phone` (`ConnectorsHub`) | N-Conn-16-Phone-Rules | the same at 390 px: sections stacked, each tool's outcome kept, the composer on top (`canvasNote`: the board's placeholder is shorter; the composer keeps one placeholder at every width) |
| `Boards/Google Calendar added` (`ConnectorsHub`) | N-Conn-11-GCal-Done | Rivera's Rules page with an info `Notice` ("Google Calendar is on. Claude now checks when you're busy before offering times, and never sees what an event is.") and Google Calendar's section with "Added just now" |
| `Boards/Ask Claude to add a connector` (`ConnectorsHub`) | N-Conn-12-Chat | Chen's Rules page with `AskClaudePanel`: the owner's words, Claude's serif reply and `ConnectorOfferCard` "Review and add" for Payments |
| `Boards/Payments` (`ConnectorPages`) | N-Conn-02-Payments | `Breadcrumb` Rules / Payments; `ConnectorHeader` "On"; "Tools" with the caption "Each tool with every rule that covers it. Open a tool for its own page."; a `ToolRulesCard` per tool, the shared card under both; `ConnectionPanel` "Turn off Payments" |
| `Boards/Stripe` (`ConnectorPages`) | N-Conn-03-Stripe | `ConnectorHeader` "Connected"; a `ToolRulesCard` per tool; `ConnectionPanel` with the connection details and "Disconnect" |
| `Boards/Google Calendar` (`ConnectorPages`) | N-Conn-04-GoogleCalendar | `ConnectorHeader` with its promise; one tool; the connection and "Disconnect" (`canvasNote`: catalog-only in the demo) |
| `Boards/Refund` (`ConnectorPages`) | N-Conn-05-Refund | `Breadcrumb` Rules / Stripe / Refund; `ToolPageHeader` "On · Definition unchanged"; "Your rules for refund" (`ToolRulesCard`, no header); the composer "Ask Claude to change a rule for refund" with its chips; `RecentRequests` |
| `Boards/Quote` (`ConnectorPages`) | N-Conn-06-Quote | the same for Quote, with no definition note (`canvasNote`: a built-in tool has no pinned definition; the board's chips repeat the Refund page's, so the story's are the Quote page's own) |
| `Boards/Add a connector, coming soon` (`AddConnector`) | N-Conn-07b-Add-Picker-ComingSoon | Chen's Rules page under `ConnectorPicker`: Payments to add, Google Calendar coming soon, Stripe to connect |
| `Boards/Add a connector` (`AddConnector`) | N-Conn-07-Add-Picker | Rivera's Rules page under the picker, every built-in added and Google Calendar to connect (`canvasNote`: catalog-only in the demo) |
| `Boards/Connect Google Calendar` (`AddConnector`) | N-Conn-08-GCal-SignIn | `ConnectorSignIn` over Rivera's Rules page, step 2 of 4 |
| `Boards/Review Google Calendar` (`AddConnector`) | N-Conn-09-GCal-Review | `Breadcrumb`, `Steps` at 3 of 4, `ConnectorReview` with "See when you're free" at "Ask me first", covered by the Bookings rule |
| `Boards/Turn on Google Calendar` (`AddConnector`) | N-Conn-10-GCal-Confirm | `Steps` at 4 of 4, `PageHeader` "Turn on Google Calendar" ("Here's exactly what changes on your Desk. Nothing changes until you confirm."), `ChangeReview` with "Confirm and turn on" and "Back" |
| `Boards/Review Payments` (`AddConnector`) | N-Conn-11b-Documents-Review | Chen adding Payments: `Breadcrumb` Rules / Payments, `Steps` "Choose", "Review tools", "Confirm" at 2 of 3, `ConnectorReview` with both tools at "Ask me first" (the board keeps its name from when it showed Documents) |
| `Boards/A tool changed, Today` (`ToolChanged`) | N-Conn-13-Changed-Today | Today with `ToolChangedItem` first under "Needs you", then the seeded held quote as its `ApprovalCard` (`canvasNote`: the board draws the hold as a short row; held requests keep the signed Today's `ApprovalCard`) |
| `Boards/A tool changed, review` (`ToolChanged`) | N-Conn-14-Changed-Review | the Refund page with `ToolPageHeader` "Off until you review a change" and `ToolReviewCard` above its rules |
| `Boards/A tool changed, after` (`ToolChanged`) | N-Conn-15-Changed-After | "On · Definition reviewed today" and the info `Notice` |

  - Each board story has `focus_order_is_logical`:
    - Rules pages: "Add a connector", the composer, its chips, then each section's header and rows in order, then the last "Add a connector".
    - A board with a dialog: only the dialog's controls.
    - The review boards: the outcome menus, then "Turn it on".
    - The changed tool's review: "Turn back on", "Keep off", then the rules.
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/ds/reference && npx vitest run --project storybook src/ds/boards` → FAIL until the stories and fixes land.
- [ ] **Step 3: Compare by eye** as in Task 4 Step 4.
  - The Chen verify, Safety and Switcher boards at 1280×820.
  - The connectors boards at `set viewport 1512 982` (N-Conn-16-Phone-Rules at `390 844`), with a full-page screenshot for a board taller than one screen, against `$DS_REFERENCE_DIR/<board>.png`.
  - Then every board at 1440×900 and 390×844, with a keyboard walk.
- [ ] **Step 4: Record** a README line per board (21 lines).
- [ ] **Step 5: Run** `cd web && npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git add web && git commit -m "test(ds): check the verification, safety, switcher, rules and connectors boards against the design canvas"`.

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

The old question 1, whether a tool's review needs the changed tool's new profile, is closed. The signed review (N-Conn-14-Changed-Review) shows no new effects and no "Turn back on with Ask me", so `ToolProfile` needs no new field.

None is open. Three questions raised when Tasks 2–3 were re-specified were answered on 2026-10-29, and the master plan carries the answers:
1. **Built-in connectors through `/tools/confirm`.** A native tool's `definition_sha256` is its adapter profile's `profile_sha256`. Enabling goes through a proved draft, and any subset of tools proves live at confirm time. In bounded mode the owner sees "Rules can't be checked right now".
2. **One action per connector.** `POST /tools/confirm {desk_id, tools: [{tool, definition_sha256}], enable}`.
   - Adding drafts one rules version for the group and proves it, then the usual confirm.
   - Turning off applies atomically and at once, unproved, with each tool's change ledgered. The web app shows a plain confirm first.
   - `enable: false` for `native.start_verification` is refused, since Verification is always on.
3. **The shared-rule example.** It is an `auto` card for `effect:charge` with `max_amount_cents` 2000 for the visiting agent's key, whose hold twin holds anything above $20 from that agent for the owner. It reads "Automatic up to $20; over $20, ask me first". No mode asks with a limit. (Until 2026-10-29 it was a card for anyone up to $100. On Rivera both charging tools have their own cards for anyone, `rv-link` and `rv-mandate`, and a tool card outranks a group card for the same people, so that example governed nothing there.)

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

Fix round 2, 2026-10-29: Task 0 adds `N-Intro-D` to `REFERENCE_BOARDS`, since its stories cite the board before Task 4 exists. Its contract names how Escape is ignored (the dialog's `keydown` and `cancel` both prevented, `closedby="none"` where supported), labels the dialog by its title and makes the passcode a password field with autocomplete off, and `escape_never_closes_it_with_a_real_keyboard` presses Escape before any other input and checks focus stays in the field. The early PR runs on `design/intro-dialog` in `.worktrees/design-intro-dialog`, apart from this plan's own branch. Owner decisions, 2026-10-29, on design PRs and receipts: both PRs from this plan are design PRs, with screenshots, recordings and the owner's sign-off (AGENTS.md "Design PRs"), and the board spec and by-eye checks put receipts under each message, with a `canvasNote` on each board that still draws a margin column.

Recheck, 2026-10-29: board plays check the receipt's placement by bounding box, as the design system code's `receipts_sit_under_their_message` does, and its type and color with `expectComputed`; the boards' `canvasNote`s name the web app by what it builds.

Round 2 (seam review, 2026-10-29): seam-20: `ToolStatusRow` and `ToolReviewCard` take `profile: ToolRowView`, a `Pick` of `ToolProfile` that includes `definition_sha256`, so the API's `ToolRow` fits as well as a `ToolProfile`.

PR round 1, 2026-10-29: the copied Global Constraints name the organization's $1,000 monthly limit. Nothing in this plan's tasks changes.

PR round 2, 2026-10-29: `MockCheckout` takes `cancelReason` and says when a rule change cancelled the link (`CancelledRulesChanged`, `rule_change_cancel_says_why`; 24 story tests). `RuleChangeDiff` takes `hasOtherChanges`, so a draft that changes only the money limit keeps Confirm (`LimitOnly`, `limit_only_change_keeps_confirm`; 11 story tests). The copied Global Constraints name the active rules version's money cap.

PR round 3, 2026-10-29: the landing lines name the review panel. Nothing in this plan's tasks changes.

Changes after PR #7 (2026-10-29): where this plan restates Plan 03a, it now says what Plan 03a's components do (Plan 03a's ledger lists the component changes). No task, kernel contract or evals gate changed.
- Matches the code PR #7 shipped: receipts attach under their message on its side, with no margin column, in the board spec and the by-eye checks, and the public page's rows fill its chat column.
- Signed off by the project owner on 2026-10-29: every card about money moving (`MONEY_TEMPLATES`) carries the test-payment note; the kernel's open-status `text` is the one clock time a visitor surface shows, verbatim; the composer shows one focus ring; the Switcher board's menu lists only businesses, with Desks in the sidebar's Desk picker; Today's approval card follows the signed-off answer boards; the things-to-try list on First visit is drawn by `IntroDialog`, added in its own pull request (#11), with Plan 04 passing its items.

Tasks 2–3 re-specified from the owner-signed Connectors and rules boards (2026-10-29). The owner signed eighteen boards on the design canvas's "Claude Desk · Connectors and rules" page (N-Conn-01-Rules to N-Conn-16-Phone-Rules). They replace the Rules and Integrations boards that the old Tasks 2 and 3 followed, so both tasks are rewritten to build them. Task 6 checks the new boards in place of N-Rules-Rivera, N-Rules-ChatChange, N-Settings-Integrations and N-Settings-ToolChanged.
- **The Rules hub.** Rules is one page, with a section per connector the Desk has, built in first, and "Connectors" is the name people read. `CapabilityCard` becomes `ConnectorSection` (and `ConnectorList`), and `ToolStatusRow` becomes the hub's tool rows and `ToolPageHeader`. Connector and tool pages, the add-a-connector flow (`ConnectorPicker`, `ConnectorSignIn`, `ConnectorReview`, `ConnectorOfferCard`) and Today's `ToolChangedItem` are new.
- **Outcomes.** The words are now "Automatic", "Ask me first" and "Never", in `OutcomeMenu`. The mode switch reads "Ask me first", "Automatic" and "Custom" (`PRESET_WORDS`). `RuleRow` marks a shared effect-group rule under every tool it covers.
- **Kept, renamed or dropped.** `RuleChangeDiff` becomes `ChangeReview`: the same before-and-after rows and confirm-once behavior, now also for a connector turned on or off and with the proof's lines. `ToolReviewCard` keeps its contract, speaking of a connector. `AlwaysOnList`, `ruleDiff`, `RuleWord`, `Steps`, `SubNav` and `ToolLabel` stay. The initials pill and "Do it" and "Ask me" are dropped.
- **Copy and data.** `describeEffects` uses the boards' words. Connector brand marks use their own decorative tokens. Components display the screen's strings and decide nothing.
- **Fixtures and reference boards.** Rivera keeps Documents, since the verified-invoice scenario needs it, so its hub has all six built-in connectors and Stripe. Chen & Co. CPA, adding Payments, is the add-a-built-in example. `REFERENCE_BOARDS` swaps the four replaced boards for the eighteen new ones, re-pointing the two stories that cited N-Rules-Rivera. The new boards render at 1512×982, as AGENTS.md draws boards.
- **Interfaces.** "Interfaces consumed / produced" now says what the web app (plan 04) passes for each screen.
- **Open questions.** The old open question 1 is closed. Three new ones cover the master's contracts: native tools through `/tools/confirm`, turning a connector off, and a shared rule with an ask limit.

Answers and owner decisions on the re-specified Tasks 2–3 (2026-10-29):
- **Built-in connectors.** Native tools go through `POST /tools/confirm` with their adapter profile's `profile_sha256`, so a built-in connector turns on through a proved draft.
- **One action per connector.** `/tools/confirm` takes a list of tools, so a connector is one action both ways. Adding proves one version for the group in `ChangeReview`. Turning off or disconnecting applies at once, unproved, after `ConnectionPanel`'s plain confirm, which lists the tools that stop and the rules that stop applying. `ChangeReview` loses its turned-off rows and its optional checks (`TurnBackOnRefund` replaces `TurnOffPayments`).
- **The shared-rule example** is an auto `effect:charge` card up to $100. `outcomePhrase` reads it "Automatic up to $100; over $100, ask me first" (`AutomaticWithLimit`, `limit_reads_automatic_up_to`, `outcome_phrase_with_limit`). Replaced during Task 2, below.
- **Verification is always on**: "Always on" in its header, `ConnectionPanel`'s `always_on` with the owner's line, and never in the picker (`always_on_has_no_turn_off`).
- **Connectors live only under Rules**: the `SubNav` story lists no Connectors entry, and the web app's Settings drops its Integrations entry.
- The three master-plan questions are closed. Task 2 now has 11 unit tests and 35 story tests; Task 3 has 36 story tests.

Rulings during Task 2 (2026-10-29):
- **The shared-rule example agrees with the seed.** A group rule for anyone up to $100 was shadowed on both charging tools by their own cards for anyone (`rv-link`, `rv-mandate`), since a tool card outranks a group card for the same people, so it governed nothing on Rivera. The example is now the seed's $20 agent limit as a shared rule for the visiting agent's key (`rv-agent-charges`, "Automatic up to $20; over $20, ask me first"). `who: 'agent'` needs an `agent_key_id`, so it names the one demo agent rather than every visiting agent. Every auto rule with an amount limit shows its limit phrase through `outcomePhrase`.
- **A tool lists only the rules that govern it.** `rulesForTool` applies the master's "Coverage and overlap": a group rule shows under a tool only where none of the tool's own cards outranks it, so a group rule for anyone never shows under a tool with its own rule for anyone. Plan 04's `capabilities` should take its `rules` from it, rather than every card that covers the tool. The shared example governs Payment link and Charge within a signed limit for the demo agent, since a card for one agent outranks each tool's card for anyone.
- `ChangeReview` gains two stories, `NothingChanges` and `ConfirmFailed`, for its empty and error states; `Card` takes `padding={0}` for a card of rows that pad themselves (`ConnectorSection`). Task 2 has 16 unit tests and 37 story tests.

Task 2 fix round 1 (2026-10-29), from the task review:
- A change of what a rule applies to shows: `ChangeSide.appliesTo` on each side, tagged "Changed" when it moved, and the title tagged when the screen passes no targets.
- Confirm is released on each error delivered, so the same failure twice can be retried.
- Joint coverage needs one principal to satisfy every card: a person's or agent's cards combine only with the same person's or agent's.
- Limit phrases reflow: nothing keeps its width, and under 640 px a rule row's and a hub tool row's outcome sits on its own line, following the updated phone board (N-Conn-16-Phone-Rules), which awaits the owner's sign-off. Hub tool rows show the governing rule's limit phrase (`ToolSummaryView.limit`).
- Task 2 has 16 unit tests and 45 story tests.

Before Task 3 (2026-10-29): the project owner asked for "Simulate a tool change" to be built later, together with the mode switch and the money-limit line, so this task stays on time.
- `ToolPageHeader` takes no simulate props, and the `WithSimulate` story and `simulate_only_when_on` are dropped.
- The changed-tool review keeps its checks, since they belong to `ToolReviewCard`: `quoted_definition_is_text`, `confirm_names_the_reviewed_hash` and `no_hash_no_confirm`.
- Task 3 has 35 story tests.

During Task 3 (2026-10-29):
- "Turn it on" keeps its label under the busy spinner while it waits, as every busy button does, rather than reading "Turning on".
- The changed-tool review also fails closed without the new definition's text, since there is nothing to review (`NoDefinitionText`).
- A new tool that nothing covers reads the board's "No rule of yours covers this yet, so it starts at Ask me first."
- The picker names its buttons by connector ("Add Payments"), the disconnect confirm carries the Mock badge, and the turn-off confirm closes once the screen is done.
- Nineteen more stories cover phone widths, the off states, a tool already covered by a rule, and the answers and states the boards don't draw. Task 3 has 54 story tests.

Task 3 fix round 1 (2026-10-29), from the task review:
- The changed-tool review keeps both answers disabled when the new definition is empty or only blank space, and still quotes a real definition exactly as sent (`EmptyDefinitionText`, `BlankDefinitionText`, `IndentedDefinition`).
- A recent request's row draws the base focus ring, 2 px outside the row.
- The Google Calendar review's note says why every new tool starts at "Ask me first".
- `ChangeReview`'s confirm keeps "Confirm change" under the busy spinner rather than reading "Confirming", as every busy button does (`ConfirmingFromTheScreen`). Task 2 has 46 story tests and Task 3 57.

Task 3c (2026-10-29): the project owner asked for the mode switch, the money limit and the demo's "Simulate a tool change" to be built after Tasks 2–3, in a change of their own that merges once he signs boards N-Conn-17 to N-Conn-22, and answered its open questions: a change that can cancel open payment links says so in one static line (`ChangeReview` `cancelsLinks`, with no contract field); tool rows stay editable under a preset; a preset's review opens on its own page. Task 3c adds `HowClaudeWorks`, `MoneyLimit`, `LimitChange` and `PRESET_CAPTIONS`, moves the simulate strip from Task 3 into `ToolPageHeader`, and gives `SegmentedControl` a `disabled` state. A preset pick and "Simulate a tool change" each send once; "Review change" passes no value. The board check fixed the mode card's hairline spacing; the preset review keeps `ChangeReview`'s own layout for each side, where the board draws them differently. Task 3c has 2 unit tests and 36 story tests across its five component folders.
