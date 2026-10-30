# Claude Desk Prototype — Plan 07: The About this prototype readers

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill (`.agents/skills/`): a fresh implementer and a task review per task, in this plan's worktree, landing as one design PR after the review panel. Steps use checkbox (`- [ ]`) syntax for tracking. This plan builds on the web app's run 1 (plan 04, Tasks 1–7) as merged.

**Goal:** Two long-form reading pages inside the prototype, one for the product proposal and one for the capability prediction, opened from an "About this prototype" group in the owner sidebar. Each page is a standalone reader with a back link to the Desk: a centered serif title and one-line summary, a lead figure (the v1 architecture for the proposal, Claude's τ³-Banking scores for the prediction), a numbered contents list, the document in a serif reading column, an author, date and reading-time column, one pull quote, and a card to the other document. The text of both documents lives in the repo as Markdown under `docs/`, so the repo's docs check covers it and a reader of the repo can read the same words.

**Architecture:** Three parts. (1) The two documents as Markdown in `docs/`, added to the docs check's shipped docs, with HTML comments marking where a figure goes and a relative link from the proposal to the prediction. (2) A small Markdown reader in `web/src/about/` that parses the subset these documents use into typed blocks at build time (no HTML passes through, no `dangerouslySetInnerHTML`), maps the relative document link to the other page's route, and renders the reader layout and three page-specific figures with design tokens only. (3) Two static routes, `/about/proposal` and `/about/prediction`, that make no API request, plus the sidebar's `about` group in the owner shell (the design session's `Sidebar` prop). Both routes are public static pages like the vision mocks (plan 04, Task 17): the documents are public in the repo, so nothing here needs a session.

**Tech Stack:** the web app's toolchain as plan 04 pins it (React 18.3.1, TypeScript 6.0.3, Vite 8.3.4, Vitest 5.0.4 with the browser provider, Playwright 1.64.0, `react-router` 7.18.4, `axe-core` 4.14.0, `@axe-core/playwright` 4.13.0). Vite's `?raw` import brings the two Markdown files in at build time. No new dependencies: the Markdown subset parser is about 150 lines of our own code with its own tests.

**Spec / master plan:** `docs/specs/2026-10-28-claude-desk-design.md` ("Look and feel", "First visit and hosting"); `docs/plans/2026-10-28-00-master-plan.md` ("Global Constraints", "Plan index"); the web app plan (plan 04: Global Constraints, Task 4's owner shell, Task 17's vision pages and route checks); the design system plans (plans 03a and 03b: tokens, `Mark`, `Wordmark`, `ConceptFooter`, `TextLink`, `Icon`); the design session's sidebar change on `design/recorded-tag-and-sidebar` (`Sidebar.about`). Boards on the design canvas, page "9 · About this prototype": `N-Docs-Proposal`, `N-Docs-Prediction`, `N-Docs-Proposal-Phone`, `N-Docs-Prediction-Phone` and `N-Docs-Sidebar`. The project owner picked two pages over one (2026-10-29) and signed `N-Docs-Sidebar` (20:20); the four reader boards are in review until he signs them.

## Global Constraints

The master plan's Global Constraints, copied:

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

- **Static and offline.** The two routes make no request: no `fetch`, no React Query hook, no `EventSource`; the screen tests check `mockStore.requests` gains nothing, as plan 04's vision pages do. They need no copy or session and show nothing from one, so they render the same for a stranger, a signed-in owner and a crawler.
- **No HTML passthrough.** The Markdown reader turns text into typed blocks and React elements only. Raw HTML in a document is an error, except the figure comments this plan defines (`<!-- figure: architecture -->`, `<!-- figure: tau3 -->`, `<!-- figure: readiness -->`), which render as the named figure or nothing. No `dangerouslySetInnerHTML` anywhere under `web/src/about/` (a source guard checks it).
- **Links.** A link target is `https://…`, or one of the two document file names, which become the other page's route. Anything else fails the parser's test. External links open in a new tab with `rel="noopener noreferrer"`, as `TextLink`'s `external` does.
- **The words are the documents'.** The reader shows the Markdown's text unchanged, with three exceptions, each named and tested: the one-line summary under each title and the pull quote, both in `web/src/about/documents.ts` (the pull quote must be a sentence of its document, checked by a test); and one sentence the proposal's page replaces, because it reads oddly on the hosted page itself (project owner, 2026-10-29): "The prototype, v1's enforced core, is at [owner: hosted URL; the passcode comes with the link], with the code at [owner: repo link]." becomes "You're in it. The code is at [owner: repo link]." The replacement matches exactly once or the test fails, so a later edit to the proposal can't silently skip it. The proposal keeps its framing as written (project owner, 2026-10-29): no line is added to say it isn't Anthropic's plan; the byline and the concept footer carry that.
- **Placeholders stay visible.** `[measured: …]` and `[owner: …]` render as quiet pending pills with their text, never as blanks and never as invented values, until the Sunday evals report and the deploy fill them in the Markdown (`make docs-check FINAL=1`, or the checker's `--final`, then fails on any left).
- **Figures say only what the text says.** The τ³-Banking chart plots the seven Claude pass^1 scores and the top score as listed on Sierra's leaderboard (`web/src/about/tau3.ts`, with the source URL and the date read), the 80% bar, the prediction date, and the straight-line fit in log-odds through all seven Claude scores, computed in code. A test pins the fit's 80% crossing to 2027-10-03 and the five Opus scores' to 2027-06-12, matching the prediction's "October 2027 (all seven Claude models)" and "the five Opus scores give June 2027". The architecture figure uses the proposal's own words and no claim beyond them; any change to a safety sentence or to a figure label that states a safety property goes through the kernel and safety session first.
- **Type.** Long-form reading pages use Source Serif 4 for body text (owner decision, 2026-10-29), an exception scoped to these two pages that the master and AGENTS.md record before this plan's build PR merges. Headings are Hanken Grotesk 620; the title and summary are Source Serif 4. Everything else follows plan 04's copied design line: tokens only (a source guard rejects hex, `rgb(` and `hsl(` under `web/src/about/` outside `tau3.ts`'s data), no clay outside the mark.
- **Owner UI words.** Plan 04's banned owner-copy words (policy, Cedar, MCP, SymCC, kernel, proof and the rest) don't apply to the documents' own text, which a reader expects to name the architecture; they do apply to the reader's own chrome (top bar, contents list, meta column, card labels).
- **Viewports.** Desktop at 1440×900 and phone at 390×844, no horizontal scroll or clipped text at either. On a phone the contents list folds into one disclosure row, figures stack, and the measures table becomes a list (boards `N-Docs-*-Phone`).

## What this plan serves

- A reviewer who opens the prototype can read the product proposal and the capability prediction where the product is, in a page that reads like a well-made long-form article, and go back to the Desk in one click.
- The repo carries the same two documents as Markdown, checked like every shipped doc, so the hosted page, the repo and the written submission say the same thing.

## Interfaces consumed / produced

**Consumed, plan 04 (run 1):** `web/src/app/routes.tsx` and its router; the owner shell from Task 4 (the `AppShell` and `Sidebar` props it passes); the screen test project and `mockStore.requests`; `e2e:mock` and its helpers (`startCopy`); `readLocal('lastDesk')` for the back link.

**Consumed, design system (plans 03a and 03b, and the design session's sidebar PR):** `Mark`, `Wordmark`, `ConceptFooter`, `TextLink`, `Icon` (`document`), the tokens; `Sidebar({ about?: { title: string; links: { id: string; label: string; href: string; current?: boolean }[] } })` and the same group in `AppShell`'s compact sheet.

**Produced:**
- `docs/product-proposal.md` and `docs/capability-prediction.md`, in `SHIPPED_DOCS` (`tools/desk_tools/check_docs.py`).
- Routes `/about/proposal` and `/about/prediction` (extensionless, so the edge's `spa_rewrite` serves `index.html`, plan 06b).
- `web/src/about/`: `markdown.ts` (`parseDocument(md): Block[]`), `documents.ts` (`ABOUT_DOCUMENTS`), `tau3.ts` (scores and `logOddsFit`), `ReaderPage.tsx`, `figures/{ArchitectureFigure,Tau3Chart,ReadinessScale,MeasuresTable}.tsx`, `reader.css` (classes built only from tokens).
- `ABOUT_LINKS` for the owner shell's `about` prop: `{ title: "About this prototype", links: [{ id: "proposal", label: "Product proposal", href: "/about/proposal" }, { id: "prediction", label: "Capability prediction", href: "/about/prediction" }] }`.

## Review Focus owned

None of the master's Review Focus lines. This plan adds no kernel, prompt, policy or API change and no visitor-facing chat surface, so the master's "Evals gate" doesn't apply. Its own risks, each with a test: HTML or script reaching the page from Markdown (`markdown_has_no_html_passthrough`, `no_dangerous_html_in_about`); a page showing words its document doesn't have (`only_named_changes_to_the_text`); a figure claiming more than the text (`fit_crosses_the_bar_when_the_text_says`, `chart_scores_match_the_leaderboard_file`); a request from a static page (`about_pages_make_no_requests`).

## Before you start (coordinator)

- The web app's run 1 (plan 04, Tasks 1–7) on `main` before Task 2; Task 1 doesn't need it.
- The project owner's signature on the four reader boards before Task 3; Tasks 1 and 2 don't depend on the look.
- The design session's sidebar PR (`design/recorded-tag-and-sidebar`, `Sidebar.about`) on `main` before Task 5. If it hasn't merged when Task 5 starts, Task 5 waits; Tasks 1–4 don't touch the sidebar.
- The serif-body exception in AGENTS.md, the spec and the master (the coordinator session's docs change) before the build PR merges, not before the build starts.
- The current text of both documents comes from the alignment Doc's "Doc drafts" tabs, which the product docs session keeps. Task 1 copies them as they stand on its day; later wording changes reach `docs/*.md` as minor docs-only commits (AGENTS.md "Working rules"), and a change to a safety sentence goes through the kernel and safety session first.
- The build PR is a design PR (AGENTS.md "Design PRs"): screenshots at 1440×900 and 390×844 of both pages and the sidebar, a short recording of opening a document from the sidebar, switching to the other and going back, and the project owner's sign-off, on top of the review panel and CI.
- Not on Friday's gate path. It targets Saturday's 18:00 checkpoint and yields to the gate.

---

### Task 1: The two documents in the repo

**Files:**
- Create: `docs/product-proposal.md`, `docs/capability-prediction.md`
- Modify: `tools/desk_tools/check_docs.py` (`SHIPPED_DOCS` gains both), `tools/tests/test_docs.py`

**Interfaces:**
- Produces: the two documents with a `# ` title, a byline line (`Giovanni Alcantara · October 29, 2026`), `## ` sections exactly as the Doc has them, links as `[text](https://…)`, the proposal's link to the prediction as `[capability prediction](capability-prediction.md)`, `estimate:` labels in code spans, the measures and readiness tables as Markdown tables, `<!-- figure: architecture -->` where the Doc places the v1 diagram, `<!-- figure: tau3 -->` at the end of "Why it's coming" and `<!-- figure: readiness -->` directly before the readiness table. Placeholders stay as the Doc has them.

- [ ] **Step 1: Write the failing tests** in `tools/tests/test_docs.py`, one at a time: `about_documents_are_shipped_docs` (both names in `SHIPPED_DOCS`); `about_documents_pass_the_docs_check` (`check_private` and `check_links` find nothing in them); `about_documents_have_only_known_figures` (every HTML comment in them is one of the three figure markers, and no other HTML appears).
- [ ] **Step 2: Run** `cd tools && uv run pytest tests/test_docs.py -v` → FAIL.
- [ ] **Step 3: Implement:** copy both documents from the Doc's tabs as they stand, in Markdown, and add them to `SHIPPED_DOCS`.
- [ ] **Step 4: Run** `make docs-check && cd tools && uv run pytest -q` → PASS. `make docs-check FINAL=1` (or `--final`) still fails on the placeholders, as expected until Sunday.
- [ ] **Step 5: Commit** `git add docs tools && git commit -m "docs: add the product proposal and capability prediction to the repo as shipped docs"`.

### Task 2: The Markdown reader and the document registry

**Files:**
- Create: `web/src/about/markdown.ts`, `web/src/about/documents.ts`, `web/src/about/markdown.test.ts`, `web/src/about/documents.test.ts`
- Modify: `web/vite.config.ts` (`server.fs.allow` includes `../docs` for the dev server; the build and Vitest read the `?raw` imports directly)

**Interfaces:**
- Produces:
  - `type Inline = { kind: 'text', text } | { kind: 'strong', children } | { kind: 'code', text } | { kind: 'link', href, children, internal: boolean } | { kind: 'placeholder', text }`.
  - `type Block = { kind: 'heading', depth: 1 | 2, text, id } | { kind: 'paragraph', children: Inline[] } | { kind: 'list', items: Inline[][] } | { kind: 'table', head: Inline[][], rows: Inline[][][] } | { kind: 'figure', name: 'architecture' | 'tau3' | 'readiness' } | { kind: 'byline', text }`.
  - `parseDocument(md: string, resolve: (file: string) => string | null): Block[]`: throws `MarkdownError` with a line number on anything outside the subset (raw HTML other than the figure comments, images, nested lists, headings deeper than `##`, a link target that is neither `https://` nor a known file).
  - `ABOUT_DOCUMENTS: Record<'proposal' | 'prediction', { route, title, summary, pullQuote, hero: 'architecture' | 'tau3', next: 'proposal' | 'prediction', replacements: { from: string; to: string }[], blocks: Block[] }>`, with the summaries as the project owner kept them: proposal "What Claude Desk is, who it’s for, what v1 enforces in code, and how we’ll know it works."; prediction "What a generally available Claude model will do for a small business by October 2027, and what will still hold it back." Pull quotes: proposal "Talking Claude around can't make it act past the owner's rules."; prediction "It will still be talked around often enough that its limits must sit in code."
  - `readingMinutes(blocks): number` at 230 words a minute, rounded, at least 1.

- [ ] **Step 1: Write the failing tests**, one at a time: `parses_every_construct_the_documents_use` (each block and inline kind from a small fixture); `markdown_has_no_html_passthrough` (`<b>`, `<script>`, `<img>`, an unknown comment and a raw URL in angle brackets each throw); `links_resolve_to_https_or_the_other_document`; `placeholders_parse_as_placeholders` (`[measured: …]` and `[owner: …]`, not as links); `both_documents_parse_fully` (the two real files, no throw, one `#` heading, every `##` with a unique id); `only_named_changes_to_the_text` (the proposal's replacement matches exactly once; with it applied, every paragraph's text appears in the Markdown unchanged); `pull_quotes_are_sentences_of_their_documents`; `reading_time_matches_word_count` (proposal 7, prediction 4 at today's text).
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/about` → FAIL.
- [ ] **Step 3: Implement** `markdown.ts` and `documents.ts`.
- [ ] **Step 4: Run** the same → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): parse the two About documents into typed blocks, with no HTML passthrough"`.

### Task 3: The three figures

**Files:**
- Create: `web/src/about/tau3.ts`, `web/src/about/figures/{ArchitectureFigure,Tau3Chart,ReadinessScale,MeasuresTable}.tsx`, `web/src/about/reader.css`, `web/src/about/figures.screen.test.tsx`, `web/src/about/tau3.test.ts`

**Interfaces:**
- Produces:
  - `tau3.ts`: `TAU3_SOURCE = { url: "https://taubench.com/leaderboard", read: "2026-10-29" }`; `CLAUDE_SCORES` (Sonnet 4.5 2025-09-29 25.3, Opus 4.5 2025-11-24 24.7, Opus 4.6 2026-02-05 27.3, Opus 4.7 2026-04-16 40.2, Opus 4.8 2026-05-28 39.7, Fable 5 2026-06-09 39.7, Opus 5 2026-07-24 48.7); `TOP_SCORE` (Qwen 3.8 Max 2026-07-19 55.2); `logOddsFit(points): { a, b, crosses(p): Date }`.
  - `Tau3Chart`: an inline SVG (`role="img"`, labelled by its caption) with the seven Claude points in `--accent-blue`, the top score as a hollow point, the dashed 80% bar, the prediction-date rule at October 2027, the shaded band from April to October 2027 where the text's fits cross, and the all-seven fit as a dashed line from Opus 5 onward; direct labels only on Opus 4.5, Opus 5 and the top score; each point has a `<title>` for hover. A phone variant (`compact`) drops the long labels, as board `N-Docs-Prediction-Phone` shows. Under it, "Figure 1" and the caption from the board, with the source.
  - `ArchitectureFigure`: the board's figure built from `div`s (Visitor ⇄ Chat layer → Kernel with Decide → Runs, Owner decides, Refused; Check reply → Shown, Handed off; the signed ledger), each outcome a pill with a status dot and its word, so status is never color alone; `compact` stacks it for phones.
  - `ReadinessScale`: from the readiness table's rows, each axis a row with a four-step scale (Lagging, Early, Gated, Near) marking its rating, then its evidence and "Watch for"; a rating outside the four words throws.
  - `MeasuresTable`: the measures table as a table on desktop and a definition list on phones.
  - `reader.css`: classes for the layout and figures built only from tokens.

- [ ] **Step 1: Write the failing tests**, one at a time: `fit_crosses_the_bar_when_the_text_says` (all seven → 2027-10-03; the five Opus scores → 2027-06-12; both dates within a day); `chart_scores_match_the_leaderboard_file` (the chart renders seven points and one hollow point with the listed values in their titles); `chart_claims_match_the_prediction` (the prediction's Markdown contains "24.7%", "48.7%", "October 2027" and "June 2027"); `readiness_marks_each_rating` (five rows, each with one marked step whose word is its rating); `readiness_rejects_an_unknown_rating`; `architecture_outcomes_have_words` (five pills, each with text); `figures_use_tokens_only` (a source guard on `web/src/about/` outside `tau3.ts`: no hex, `rgb(` or `hsl(`); `figures_pass_axe` (each figure at both sizes).
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/about/tau3.test.ts && npx vitest run --project screens src/about/figures.screen.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the data, the fit and the four figures against the boards.
- [ ] **Step 4: Run** the same → PASS.
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): add the architecture, τ³-Banking and readiness figures for the About pages"`.

### Task 4: The reader pages and their routes

**Files:**
- Create: `web/src/about/ReaderPage.tsx`, `web/src/about/about.screen.test.tsx`
- Modify: `web/src/app/routes.tsx` (`/about/proposal`, `/about/prediction`)

**Interfaces:**
- Produces: `ReaderPage({ id })`, laid out as boards `N-Docs-Proposal` and `N-Docs-Prediction` (desktop) and their phone boards:
  - Top bar: `Mark` and `Wordmark`, the two documents as pills (the current one with `aria-current="page"`), and "Back to {business}" to the last Desk's Today (`readLocal('lastDesk')`), or "Back to the prototype" to `/` when there is none. The top bar names no business it would have to fetch: with no last Desk it uses the second label.
  - Hero: "About this prototype", the title (`h1`), the summary, the lead figure.
  - Body: the numbered contents list (`nav`, "On this page"), the article, the meta column ("Written by", "Date", "Reading time", "Also read"); on a phone the contents list is one `<details>` row ("On this page · 7 sections") and the meta folds into a line under the summary.
  - The article: the parsed blocks with the replacements applied; the pull quote after the first section; a figure marker renders its figure (the hero's own marker renders nothing a second time); the "Read next" card to the other document; `ConceptFooter`.
  - `document.title`: "Product proposal · Claude Desk" and "Capability prediction · Claude Desk".

- [ ] **Step 1: Write the failing tests**, one at a time: `about_pages_render_their_document` (title, summary, every `##` in the contents list in order, the lead figure); `about_pages_make_no_requests` (`mockStore.requests` unchanged); `proposal_says_youre_in_it` (the replaced sentence shows, the hosted-URL placeholder doesn't); `placeholders_show_as_pending` (each `[measured: …]` renders as a pill with its text); `no_raw_markdown_in_the_page` (no `**`, `](`, backtick or `<!--` in the rendered text); `documents_link_to_each_other` (the proposal's "capability prediction" link and both "Read next" cards go to the other route, client-side); `external_links_open_in_a_new_tab`; `back_link_goes_to_the_last_desk` (with and without `lastDesk`); `no_dangerous_html_in_about` (a source guard: no `dangerouslySetInnerHTML` under `web/src/about/`); `about_pages_pass_axe` (both pages at 1440 and 390 wide).
- [ ] **Step 2: Run** `cd web && npx vitest run --project screens src/about` → FAIL.
- [ ] **Step 3: Implement** `ReaderPage` and the two routes.
- [ ] **Step 4: Browser QA** with the `using-browsers` skill: both pages at 1440×900 and 390×844 against the four boards (type roles, spacing, figure geometry, no horizontal scroll, no clipped text). Fix deltas; rerun.
- [ ] **Step 5: Run** `cd web && npm run typecheck && npm test` → PASS.
- [ ] **Step 6: Commit** `git add web && git commit -m "feat(web): add the About this prototype reading pages for the proposal and the prediction"`.

### Task 5: The sidebar's About group

**Files:**
- Modify: the owner shell from plan 04's Task 4 (where it renders `AppShell`), `web/src/about/documents.ts` (`ABOUT_LINKS`)
- Test: the owner shell's screen test, `web/e2e/about-readers.spec.ts`

**Interfaces:**
- Consumes: `Sidebar.about` and `AppShell`'s compact sheet (the design session's PR).
- Produces: the owner shell passes `about={ABOUT_LINKS}` on every owner page, so the group shows above Answering on desktop and in the compact sheet on a phone (board `N-Docs-Sidebar`).

- [ ] **Step 1: Write the failing tests**, one at a time: `owner_shell_links_the_about_pages` (both links, in order, with their routes); in `about-readers.spec.ts` on the mock: `open_a_document_from_the_sidebar` (from Today, "Product proposal" opens the reader; the "Capability prediction" pill switches; "Back to Rivera Plumbing" returns to Today), `about_pages_fit_phone_width` and `about_pages_pass_axe` (both routes at 1440×900 and 390×844, in a fresh context with no cookie and in a signed-in one).
- [ ] **Step 2: Run** `cd web && npx vitest run --project screens src/owner && npm run e2e:mock -- about-readers` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd web && npm run typecheck && npm test && npm run build && npm run check:build && npm run e2e:mock` → PASS.
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): link the About pages from the owner sidebar"`.

### Task 6: Screenshots, recording and the design PR

**Files:** none in the repo; the PR description carries the media.

- [ ] **Step 1:** With the `using-browsers` skill, capture both pages at 1440×900 and 390×844 (top of page, the lead figure, the readiness scale, the measures table, the end of the page) and the sidebar group on desktop and in the compact sheet, plus one recording: Today → "Product proposal" → the "Capability prediction" pill → "Read next" → "Back to Rivera Plumbing".
- [ ] **Step 2:** Open the PR with `shipping-prs`, run the review panel (Opus 5.5 and GPT-6.1 Sol at `xhigh`), fix what it validates, and ask the project owner for sign-off with the media in the description.

## Landing

One design PR, `plan/07-about-readers`, after the web app's run 1 and the design session's sidebar PR, with the panel clean, CI green and the project owner's sign-off. Its description names the serif-body exception and the docs change that records it.

## Open questions

1. **The diagram on GitHub.** A reader of `docs/product-proposal.md` on GitHub sees no architecture figure (the comment renders as nothing). A committed SVG export of `ArchitectureFigure` would fix that; not in this plan unless the project owner wants it.
2. **The plan index line for 06b.** The master's index says the drafts stay out of the repo in `.local/`; this plan puts them in `docs/`. The coordinator session's docs change updates that line.

## Review Ledger

(empty)
