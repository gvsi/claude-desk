# Claude Desk Prototype — Plan 07: The About this prototype readers

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill (`.agents/skills/`): a fresh implementer and a task review per task, in this plan's worktree, landing through the two PRs in "Landing" after the review panel. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 builds on `main` as it is; Tasks 2–6 build on the web app's run 1 (plan 04, Tasks 1–7) as merged.

**Goal:** Two long-form reading pages inside the prototype, one for the product proposal and one for the capability prediction, opened from an "About this prototype" group in the owner sidebar. Each page is a standalone reader with a back link to the Desk: a centered serif title and one-line summary, a lead figure (the v1 architecture for the proposal, Claude's τ³-Banking scores for the prediction), a numbered contents list, the document in a serif reading column, an author, date and reading-time column, one pull quote, and a card to the other document. The text of both documents lives in the repo as Markdown under `docs/`, so the repo's docs check covers it and a reader of the repo reads the same words.

**Architecture:** Three parts. (1) The two documents as Markdown in `docs/`, shipped docs under the docs check, with HTML comments marking where a figure goes and a relative link from the proposal to the prediction. After Task 1 these files are the source of truth ("Document lifecycle"). (2) A Markdown reader in `web/src/about/` that parses the subset these documents use into typed blocks when its lazily loaded route module first runs (no HTML passes through, no `dangerouslySetInnerHTML`), maps the relative document link to the other page's route, and renders the reader layout and three page-specific figures from design-system tokens and components. Vitest's real-document tests, which CI runs on every push, are the gate that keeps a malformed document out of a deploy; an error boundary keeps a parse error inside `/about/*`. (3) Two static routes, `/about/proposal` and `/about/prediction`, that make no API request and read no session, plus the sidebar's `about` group in the owner shell (the design session's `Sidebar` prop). The owner shell imports only `web/src/about/links.ts`, which holds no document and no parser, so a document that can't be parsed never reaches the app's entry module. They are readable without the passcode, as plan 04's vision pages are, and carry `noindex` (project owner, 2026-10-29), since the repo is still private.

**Tech Stack:** the web app's toolchain as plan 04 pins it (React 18.3.1, TypeScript 6.0.3, Vite 8.3.4, Vitest 5.0.4 with the browser provider, Playwright 1.64.0, `react-router` 7.18.4 with route `lazy`, `axe-core` 4.14.0, `@axe-core/playwright` 4.13.0). Vite's `?raw` import brings the two Markdown files in as strings. No new dependencies: the Markdown subset parser is about 150 lines of our own code with its own tests.

**Spec / master plan:** `docs/specs/2026-10-28-claude-desk-design.md` ("Navigation", "Design system v2 (locked)" and its exceptions, "First visit and hosting"); `docs/plans/2026-10-28-00-master-plan.md` ("Global Constraints", "Schedule, lanes and gates", "Plan index"); the web app plan (plan 04: Global Constraints, Task 1's `expectScreenBasics` and guards, Task 4's owner shell, Task 17's vision pages and route checks); the deploy and docs plan (plan 06b: the docs check, the README, "Coordinator operations after the merge"); the design system plans (plans 03a and 03b); the design session's sidebar change on `design/recorded-tag-and-sidebar` (`Sidebar.about`). Boards on the design canvas, page "9 · About this prototype": `N-Docs-Proposal`, `N-Docs-Prediction`, `N-Docs-Proposal-Phone`, `N-Docs-Prediction-Phone` and `N-Docs-Sidebar`, all five signed by the project owner and locked (2026-10-29; he picked two pages over one).

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
- Product name "Claude Desk"; copy is sentence case, plain, no door/knock wordplay; footer "Concept prototype by Giovanni Alcantara, not an Anthropic product"; no Claude/Anthropic logos. Design system v2 tokens (warm dark: app #1C1B19, panel #222220, surface #2A2927, selected #3C392F; Source Serif 4 for Claude's voice and titles, and the reading text (body and the summary under the title) of the two About this prototype reading pages (plan 07); Hanken Grotesk UI; clay #E08968 only in the mark and the first-visit intro dialog's illustration; checkpoint results as receipts attached under each message, at every width). Where the design canvas differs from this plan, this plan wins; canvas-only interactions (a counter-offer answer, a translated take-over message) stay static vision.
- Git: small conventional commits, written for readers of the public history, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Specific to this plan:

- **Static and offline.** The two routes make no request: no `fetch`, no React Query hook that fetches, no `EventSource`; they read the React Query cache only (the back link) and `readLocal('lastDesk')`. They need no copy or session and render the same for a stranger, a signed-in owner and a crawler, with `<meta name="robots" content="noindex">` set while they are mounted, a best effort since the edge serves one `index.html` for every route (open question 2). A source guard and the screen tests check the rest.
- **No HTML passthrough.** The Markdown reader turns text into typed blocks and React elements only. Raw HTML in a document is an error, except the figure comments this plan defines (`<!-- figure: architecture -->`, `<!-- figure: tau3 -->`, `<!-- figure: readiness -->`). No `dangerouslySetInnerHTML` under `web/src/about/`; plan 04's guards (`RAW_HTML`, `RAW_COLOR`) already scan it.
- **Links.** A link target is `https://…`, or one of the two document file names, which become the other page's route. A link to any other repo file is refused by the parser and by a docs-side test, until the repo link is known and such links can map to it. External links open in a new tab with `rel="noopener noreferrer"`, as `TextLink`'s `external` does.
- **The words are the documents'.** The reader shows the Markdown's text in full, in order and unchanged, with only these named changes, each tested:
  - the one-line summary under each title, and the pull quote, both in `web/src/about/documents.ts`; the pull quote is a sentence of its document, compared with apostrophes normalized;
  - one sentence on the proposal's page, which reads oddly on the hosted page itself (project owner, 2026-10-29): the raw Markdown sentence matching `/The prototype, v1['’]s enforced core, is at .+?, with the code at (.+?)\./` becomes "You’re in it. The code is at $1.", applied before parsing, so `$1` carries the repo link whether it is still `[owner: repo link]` or a filled Markdown link. It must match exactly once, with placeholders and with links filled;
  - the `#` title and the byline line, which feed the hero and the meta column instead of the article.
  The proposal keeps its framing as written (project owner, 2026-10-29): no added line says it isn't Anthropic's plan; the byline and the concept footer carry that.
- **Placeholders stay visible.** `[measured: …]` and `[owner: …]` render as the design system's neutral `Pill` with their text, never as blanks or invented values, until the Markdown is filled ("Document lifecycle").
- **Figures say only what the text says.** The τ³-Banking chart's data is the leaderboard as listed (`web/src/about/tau3.ts`, with the source URL and the date read). Every claim on it is pinned to the prediction's text by a test: Claude's 24.7% and 48.7%, the top score's 55.2%, the 80% bar, and the three straight-line fits in log-odds the text cites, computed in code: the best score across labs (each release that set a new top score) crosses 80% on 2027-04-20 ("April 2027"), the five Opus scores on 2027-06-12 ("June 2027"), and all seven Claude scores on 2027-10-03 ("October 2027"). The architecture figure's labels are the alignment Doc's v1 diagram labels, which the kernel and safety session checked; a test holds them to that list, and a change to any of them goes through that session first.
- **Copy checks.** Both pages pass plan 04's `expectScreenBasics(…, { owner: false })` (footer, `assertCleanCopy`, axe) over the whole page, the documents' own words included: the design session adds the acronyms the documents use (AP2, API, SymCC, CEO, CI, MCP, URL, US) to the copy guard's acronym list, so no part of the page is exempt from the voice rules (no arrows, no exclamation marks, sentence case). The owner-jargon check (`assertNoJargon`) runs only over the reader's own strings, whose words this plan writes: the top bar, "On this page", the meta labels, "Read next", "Figure 1" and the figure captions, the back link and `ReaderError`. Text that comes from the documents (the article, the contents-list entries, the architecture figure's labels, the readiness rows) may name the kernel, policies and proofs, since that is what they are about. Figure connectors are drawn in SVG or CSS with `aria-hidden`, never as arrow characters. The page's own strings use curly apostrophes.
- **Type and tokens.** Long-form reading pages use Source Serif 4 for body text, an exception scoped to these two pages (project owner, 2026-10-29) that AGENTS.md, the spec ("Design system v2 (locked)" and its exceptions) and the master record (the coordinator session's docs change, PR #25). The reader's type styles and sizes come from tokens the design session adds (`article-title`, `article-body`, `article-heading`, `article-quote`, `article-caption`; `size-article-measure` 648, `size-article-side` 200; phone sizes through the reader's own breakpoint), so `reader.css` sets no raw `px` font size and no raw color. Blue stays for links and focus: the chart draws its one series in primary ink, rings the latest Claude point, and keeps gridlines and axes in secondary ink and hairlines (design session, 2026-10-29). Design-system components wherever one fits: `Mark`, `Wordmark`, `ConceptFooter`, `TextLink`, `Pill` (placeholders), `Card` ("Read next"), `Icon`. The document switch is two links styled from tokens on the page (a `SegmentedControl` holds in-page state, not navigation).
- **Viewports.** Desktop at 1440×900 and phone at 390×844, no horizontal scroll or clipped text at either; QA compares with the boards at 1512×982 and 390 wide. On a phone the contents list folds into one disclosure row, figures stack, and the measures table becomes a list.

## Document lifecycle

- **Where the words are written.** The owner writes in the alignment Doc's "Doc drafts" tabs; that stays where the wording is written (master, plan index). `docs/product-proposal.md` and `docs/capability-prediction.md` are what the repo and the pages show. A change in the Doc reaches the files only through a PR from the product docs session, which, before plan 06b's operation 3, compares an export of the Doc with the two files and records the result in that PR.
- **Changing the files.** Every edit to the two files goes through a PR, never straight to `main`, which `docs/AGENTS.md` (Task 1) states as a standing rule for these two files. `make docs-check` and, once PR 2 is on `main`, `cd web && npx vitest run --project unit src/about` (the full parse, the only check that runs the real parser) must pass before commit. Task 1's Python test catches the common breaks earlier (raw HTML, images, `###`, nested lists, links that are neither `https://` nor the other document). A change to a safety sentence goes through the kernel and safety session first. Once PR 2 has landed, a change to the files changes shipped screens, so its PR is a design PR (AGENTS.md "Design PRs"): screenshots of the changed sections at both widths and the owner's sign-off. Before then, no design media.
- **Measured numbers and links.** Plan 06b's operation 2 fills the proposal's `[measured: …]` cells in the Doc and in `docs/product-proposal.md` on Sunday, and the owner fills the two `[owner: …]` links. The pages embed the Markdown at build time, so the deploy Monday's gate runs at must ship after those fills: plan 06b's operation 3 (this plan's amendment) checks that only `docs/`, `tools/` and `README.md` changed since operation 1's commit, runs the About unit tests, redeploys at that commit with the owner's go-ahead and checks both live pages show no pending pill. If anything else changed, operation 1 runs again in full at that commit instead. The evals inputs don't change either way (plan 05b's gated paths exclude `docs/` and `web/`).

## What this plan serves

- A reviewer who opens the prototype can read the product proposal and the capability prediction where the product is, in a page that reads like a well-made long-form article, and go back to the Desk in one click.
- The repo carries the same two documents as Markdown, checked like every shipped doc, so the hosted pages, the repo and the written submission say the same thing.

## Interfaces consumed / produced

**Consumed, plan 04 (run 1):** `web/src/app/routes.tsx` and its data router (route `lazy`, error elements); the owner shell, `web/src/owner/OwnerLayout.tsx` (the `Sidebar` it builds and passes as `AppShell`'s `sidebar`; `writeLocal('lastDesk', deskId)`); the `desks` query and its cache key; `readLocal`; `expectScreenBasics`, `assertNoJargon` and the guards in `web/src/app/guards.test.ts`; the screen test project and `mockStore.requests`; `e2e:mock`, `startCopy`.

**Consumed, design system (plans 03a and 03b, and the design session's PRs):** `Mark`, `Wordmark`, `ConceptFooter`, `TextLink`, `Pill`, `Card`, `Icon`, the tokens; the reader's type styles and sizes and the copy guard's added acronyms ("Before you start"); `Sidebar({ about?: { title: string; links: { id: string; label: string; href: string; current?: boolean }[] } })` and the same group in `AppShell`'s compact sheet. The reader is standalone, so `current` is unused.

**Produced:**
- `docs/product-proposal.md` and `docs/capability-prediction.md`, in `SHIPPED_DOCS`; the README's "Documents" links them.
- Routes `/about/proposal` and `/about/prediction` (extensionless, so the edge's `spa_rewrite` serves `index.html`, plan 06b).
- `web/src/about/`: `links.ts` (`ABOUT_LINKS` and each page's route and title; no document, no parser), `markdown.ts` (`parseDocument`), `documents.ts` (`ABOUT_DOCUMENTS`, imported only by the reader), `tau3.ts` (scores and `logOddsFit`), `ReaderPage.tsx`, `ReaderError.tsx`, `figures/{ArchitectureFigure,Tau3Chart,ReadinessScale,MeasuresTable}.tsx`, `reader.css`.
- Plan 06b's operation 2 (Files, Steps 4–6) and new operation 3, and the master's Sunday and Monday rows ("Document lifecycle"), amended in this plan's own PR.

## Review Focus owned

None of the master's Review Focus lines. This plan adds no kernel, prompt, policy or API change and no visitor chat surface, so the master's "Evals gate" doesn't apply. Its own risks, each with a test: HTML or script reaching the page from Markdown (`markdown_has_no_html_passthrough`, plan 04's `RAW_HTML` guard); the page dropping, reordering or changing the documents' words (`article_text_is_the_document` for the parser, `article_shows_every_block_in_order` for the page); a figure claiming more than the text (`chart_claims_are_the_predictions`, `fits_cross_the_bar_when_the_text_says`, `architecture_labels_are_the_checked_list`); a request from a static page (`about_pages_make_no_requests`, `about_has_no_fetching`); a bad document taking the app down (`only_the_reader_imports_the_documents`, `a_parse_error_stays_on_the_about_page`, `a_bad_document_leaves_the_app_up`).

## Before you start (coordinator)

- **For Task 1:** `main` as it is. The product docs session exports the Doc's two "Doc drafts" tabs as Markdown to `.local/about-drafts/` in the main checkout (the Doc refuses some rotated accounts, so the implementer never reads it directly), and the coordinator writes `.local/docs-deny.txt` there with the terms the project keeps out of public text. Copy both into the plan worktree's `.local/` before dispatch; without the export, Task 1 reports BLOCKED.
- **For Tasks 2–6:** PR 1 on `main`, then the web app's run 1 (plan 04, Tasks 1–7) on `main`; the branch starts from `main` after both.
- **For Task 3:** the design session's tokens for the reader and its acronym additions to the copy guard, on `main`. If they aren't there when Task 3 starts, it waits; Task 2 doesn't need them.
- **For Task 5:** the design session's sidebar PR (`Sidebar.about`) on `main`.
- The serif-body exception is recorded on `main` (PR #25).
- PR 2 is a design PR (AGENTS.md "Design PRs"): screenshots at 1440×900 and 390×844 of both pages and the sidebar, a short recording of opening a document from the sidebar, switching to the other and going back, and the project owner's sign-off, on top of the review panel and CI.
- Not on Friday's gate path: PR 2 targets Saturday's 18:00 checkpoint and yields to the gate. **Cut rule:** PR 2 must be on `main` before plan 06b's operation 1 (the final deploy); if it isn't signed by then, it waits until after Monday's gate, the deploy ships without the About routes and the sidebar group, and the two Markdown files (PR 1) stay.
- When the real text uses a construct outside the parser's subset, extend the subset with a test if it is small and safe (an ordered list, emphasis), or ask the product docs session to change the text; never loosen the HTML or link rules.

---

### Task 1: The two documents in the repo (PR 1)

**Files:**
- Create: `docs/product-proposal.md`, `docs/capability-prediction.md` (from `.local/about-drafts/`), `docs/AGENTS.md` (edits to these two files always go through a PR; once the About pages are on `main`, that PR is a design PR)
- Modify: `tools/desk_tools/check_docs.py` (`SHIPPED_DOCS` gains both; when `<root>/.local/docs-deny.txt` is missing, the deny list is read from `git -C <root> rev-parse --path-format=absolute --git-common-dir`'s parent's `.local/`, and any git error means no deny list), `tools/tests/test_docs.py` (its `SHIPPED_DOCS` mirror and the tests below), `README.md` ("Documents": the two `[owner: link]` lines become links to the two files)

**Interfaces:**
- Produces: the two documents, each with a `# ` title, a byline line (`Giovanni Alcantara · October 29, 2026`), `## ` sections exactly as the Doc has them, links as `[text](https://…)`, the proposal's link to the prediction as `[capability prediction](capability-prediction.md)`, `estimate:` labels in code spans, the measures and readiness tables as Markdown tables (readiness columns: axis, readiness, evidence, watch for), `<!-- figure: architecture -->` where the Doc places the v1 diagram, `<!-- figure: tau3 -->` at the end of "Why it's coming" and `<!-- figure: readiness -->` directly before the readiness table. Placeholders stay as the Doc has them.

- [ ] **Step 1: Write the failing tests** in `tools/tests/test_docs.py`, one at a time: `test_about_documents_are_shipped_docs`; `test_about_documents_pass_the_docs_check` (`check_private` and `check_links` find nothing); `test_about_documents_stay_in_the_reader_subset` (every HTML comment is one of the three figure markers and no other HTML appears; no image, no `###`, no nested list; every link is `https://` or the other document's file name); `test_deny_list_falls_back_to_the_main_checkout` (a temporary worktree without `.local/` finds a term listed in its main checkout's file; outside a repository, no deny list and no error).
- [ ] **Step 2: Run** `cd tools && uv run pytest tests/test_docs.py -v` → FAIL.
- [ ] **Step 3: Implement:** write both documents from the export, in Markdown; add them to `SHIPPED_DOCS` and its mirror in `tools/tests/test_docs.py`; add the deny-list fallback; link them from the README; add `docs/AGENTS.md`.
- [ ] **Step 4: Run** `make docs-check && cd tools && uv run pytest -q` → PASS; `make docs-check FINAL=1` lists exactly these and nothing else: in `README.md`, the hosted URL and its `[measured:` rows; in `docs/product-proposal.md`, its five `[measured:` cells, the hosted URL and the repo link.
- [ ] **Step 5: Commit** `git add docs tools README.md && git commit -m "docs: add the product proposal and capability prediction to the repo as shipped docs"`, on `plan/07-about-readers-docs`, then open PR 1 (panel and CI; no design media).

### Task 2: The Markdown reader and the document registry

**Files:**
- Create: `web/src/about/links.ts`, `web/src/about/markdown.ts`, `web/src/about/documents.ts`, `web/src/about/markdown.test.ts`, `web/src/about/documents.test.ts`, `web/src/about/guards.test.ts`
- Modify: `web/vite.config.ts` (in every mode's `server`: `fs: { allow: [searchForWorkspaceRoot(process.cwd()), '../docs'] }`, since setting `allow` turns off Vite's workspace-root detection)

**Interfaces:**
- Produces:
  - `type Inline = { kind: 'text', text } | { kind: 'strong', children } | { kind: 'code', text } | { kind: 'link', href, children, internal: boolean } | { kind: 'placeholder', text }`.
  - `type Block = { kind: 'heading', depth: 1 | 2, text, id } | { kind: 'byline', text } | { kind: 'paragraph', children: Inline[] } | { kind: 'list', items: Inline[][] } | { kind: 'table', head: Inline[][], rows: Inline[][][] } | { kind: 'figure', name: 'architecture' | 'tau3' | 'readiness' }`.
  - `parseDocument(md, resolve): Block[]`: throws `MarkdownError` with a line number on anything outside the subset; the proposal's replacement matching other than exactly once also throws.
  - `documentText(blocks): string[]`: the article's text in order (paragraphs, list items, table cells), for the fidelity test.
  - `ABOUT_DOCUMENTS: Record<'proposal' | 'prediction', { route, title, summary, pullQuote, hero, next, blocks }>` with the replacement applied before parsing, and the summaries and pull quotes as the project owner kept them: proposal "What Claude Desk is, who it’s for, what v1 enforces in code, and how we’ll know it works." and "Talking Claude around can’t make it act past the owner’s rules."; prediction "What a generally available Claude model will do for a small business by October 2027, and what will still hold it back." and "It will still be talked around often enough that its limits must sit in code."
  - In `links.ts` (no document, no parser): `ABOUT_LINKS = { title: "About this prototype", links: [{ id: "proposal", label: "Product proposal", href: "/about/proposal" }, { id: "prediction", label: "Capability prediction", href: "/about/prediction" }] }`.
  - `readingMinutes(blocks)`: words ÷ 230, rounded, at least 1.

- [ ] **Step 1: Write the failing tests**, one at a time: `parses_every_construct_the_documents_use` (each block and inline kind from a small fixture); `markdown_has_no_html_passthrough` (`<b>`, `<script>`, `<img>`, an unknown comment and an angle-bracket URL each throw); `links_resolve_to_https_or_the_other_document`; `placeholders_parse_as_placeholders`; `both_documents_parse_fully`; `the_replacement_matches_once_before_and_after_the_fill` (the real proposal, and a fixture with both links filled: one match each, and the repo link survives as a link); `article_text_is_the_document` (`documentText` equals the expected text, built by stripping the raw Markdown line by line, not with `parseDocument`, in order after the named changes; fixtures with a paragraph dropped, one duplicated and two swapped each fail); `pull_quotes_are_sentences_of_their_documents` (apostrophes normalized); `reading_time_is_computed` (from the word count, not a pinned number); in `guards.test.ts` (unit project): `about_has_no_fetching` (no `fetch(`, `useMutation`, `EventSource` or fetching `useQuery` under `web/src/about/`) and `only_the_reader_imports_the_documents` (outside `ReaderPage.tsx`, its figures and tests, nothing imports `documents.ts`, `markdown.ts` or `*.md?raw`).
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/about` → FAIL.
- [ ] **Step 3: Implement** `markdown.ts`, `documents.ts` and the Vite setting.
- [ ] **Step 4: Run** the same → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): parse the two About documents into typed blocks, with no HTML passthrough"`.

### Task 3: The three figures

**Files:**
- Create: `web/src/about/tau3.ts`, `web/src/about/figures/{ArchitectureFigure,Tau3Chart,ReadinessScale,MeasuresTable}.tsx`, `web/src/about/reader.css`, `web/src/about/tau3.test.ts`, `web/src/about/figures.screen.test.tsx`

**Interfaces:**
- Produces:
  - `tau3.ts`: `TAU3_SOURCE = { url: "https://taubench.com/leaderboard/", read: "2026-10-29" }`; `LEADERBOARD`, every pass^1 row as listed (model, release date, score); `CLAUDE_SCORES` and `TOP_SCORE` drawn from it; `bestSoFar(rows)` (each release that set a new top score); `logOddsFit(points): { crosses(p): Date }`, ordinary least squares of ln(p/(1−p)) on the release date in days, crossing 80% where the line reaches ln 4.
  - `Tau3Chart`: an inline SVG labelled by its caption: the seven Claude points in primary ink, Opus 5 ringed, the top score as a hollow point in secondary ink, the dashed 80% bar, the prediction-date rule at October 2027, a band from the best-score fit's crossing to the all-seven crossing, and the all-seven fit as a dashed line from Opus 5 on; direct labels only on Opus 4.5, Opus 5 and the top score. Its text equivalent, `aria-describedby` on the SVG, is a visually hidden table of all eight points (model, date, score) and one sentence on the fit and the band; `compact` for phones drops the long labels, as board `N-Docs-Prediction-Phone` shows. Under it, "Figure 1" and the board's caption with the source.
  - `ArchitectureFigure`: the board's figure built from `div`s (Visitor and their agent, the chat layer, the kernel with Decide → Runs, Owner decides, Refused and Check reply → Shown, Handed off, and the signed ledger), each outcome a `Pill` with a status dot and its word, connectors in SVG with `aria-hidden`; `compact` stacks it. Its labels are `ARCHITECTURE_LABELS`, the Doc diagram's list.
  - `ReadinessScale`: from the table after `<!-- figure: readiness -->`, each axis a row with a four-step scale (Lagging, Early, Gated, Near) marking its rating, then its evidence and "Watch for"; a rating outside the four words throws.
  - `MeasuresTable`: every other table, as a table on desktop and a definition list on phones.
  - `reader.css`: layout and figure classes from tokens only.

- [ ] **Step 1: Write the failing tests**, one at a time: `fits_cross_the_bar_when_the_text_says` (best so far → 2027-04-20, five Opus → 2027-06-12, all seven → 2027-10-03, each within a day); `chart_claims_are_the_predictions` (the prediction's Markdown contains "24.7%", "48.7%", "55.2%", "April 2027", "June 2027" and "October 2027", and, written out in the test, the Claude scores run from 24.7 (Opus 4.5) to 48.7 (Opus 5) and the top score is 55.2 (Qwen 3.8 Max)); `chart_shows_the_leaderboard` (seven filled points and one hollow, values in their titles); `chart_has_a_text_equivalent` (both variants: a described-by table of eight rows and the fit sentence); `architecture_labels_are_the_checked_list` (the list written out in the test, not imported from the component); `architecture_outcomes_have_words`; `readiness_marks_each_rating` and `readiness_rejects_an_unknown_rating`; `measures_table_reads_as_a_list_on_a_phone`; `figures_pass_axe` (both sizes).
- [ ] **Step 2: Run** `cd web && npx vitest run --project unit src/about/tau3.test.ts && npx vitest run --project screens src/about/figures.screen.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the data, the fits and the four figures against the boards.
- [ ] **Step 4: Run** the same → PASS.
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): add the architecture, τ³-Banking and readiness figures for the About pages"`.

### Task 4: The reader pages and their routes

**Files:**
- Create: `web/src/about/ReaderPage.tsx`, `web/src/about/ReaderError.tsx`, `web/src/about/about.screen.test.tsx`
- Modify: `web/src/app/routes.tsx` (`/about/proposal`, `/about/prediction`, both `lazy`, with `ReaderError` as their error element)

**Interfaces:**
- Produces: `ReaderPage({ id })`, laid out as the four reader boards:
  - Top bar: `Mark` and `Wordmark`, the two documents as router links (the current one with `aria-current="page"`), and the back link: "Back to {business}" when the `desks` query's cache already holds the last Desk's business (after a visit from the owner shell), "Back to your Desk" when only `readLocal('lastDesk')` is known, both to `/app/{lastDesk}/today`; "Back to the prototype" to `/` when there is no last Desk. No request either way.
  - Hero: "About this prototype", the title (`h1`), the summary, the lead figure.
  - Body: the numbered contents list (`nav`, "On this page"), the article, the meta column ("Written by", "Date", "Reading time", "Also read"); on a phone the contents list is one `<details>` row ("On this page" and the section count) and the meta folds into a line under the summary.
  - The article renders every block but the `#` title and the byline; the pull quote after the first section; a figure marker renders its figure, except the hero's own marker, which renders nothing; the "Read next" `Card` to the other document; `ConceptFooter`.
  - Links between the documents (the proposal's link, the top bar, "Read next") are react-router `Link`s styled like `TextLink`, so they stay in the app; external links stay `TextLink external`.
  - `document.title` "Product proposal · Claude Desk" and "Capability prediction · Claude Desk" while mounted, the previous title restored on unmount; `noindex` while mounted.
  - `ReaderError`: "This document can't be shown right now." with the back link and the footer.

- [ ] **Step 1: Write the failing tests**, one at a time: `about_pages_render_their_document` (title, summary, every `##` in the contents list in order, the lead figure); `about_pages_make_no_requests` (`mockStore.requests` unchanged); `about_pages_pass_screen_basics` (`expectScreenBasics(…, { owner: false })` at 1440 and 390 wide); `about_chrome_has_no_jargon` (`assertNoJargon` over the reader's own strings listed in "Copy checks" only); `article_shows_every_block_in_order` (at 1440 and 390 wide, every `documentText` entry, apostrophes normalized and the replaced sentence in its page form, appears in order in the article's visible text, tables and the readiness scale included, with only the pull quote added; a dropped, duplicated or swapped block fails); `proposal_says_youre_in_it`; `placeholders_show_as_pending`; `no_raw_markdown_in_the_page` (no `**`, `](`, backtick or `<!--` in the rendered text); `documents_link_to_each_other` (client-side, from the proposal's link and both "Read next" cards); `external_links_open_in_a_new_tab`; `back_link_names_what_it_knows` (cache present, only `lastDesk`, nothing; after it, the title is the one before); `about_pages_are_noindex`; `a_parse_error_stays_on_the_about_page` (a broken registry renders `ReaderError`, and `/d/<slug>` still renders).
- [ ] **Step 2: Run** `cd web && npx vitest run --project screens src/about` → FAIL.
- [ ] **Step 3: Implement** `ReaderPage`, `ReaderError` and the two lazy routes.
- [ ] **Step 4: Browser QA** with the `using-browsers` skill: both pages at 1512×982 and 390×844 against the four boards (type roles, spacing, figure geometry, no horizontal scroll, no clipped text). Fix deltas; rerun.
- [ ] **Step 5: Run** `cd web && npm run typecheck && npm test` → PASS.
- [ ] **Step 6: Commit** `git add web && git commit -m "feat(web): add the About this prototype reading pages for the proposal and the prediction"`.

### Task 5: The sidebar's About group

**Files:**
- Modify: `web/src/owner/OwnerLayout.tsx` (`about={ABOUT_LINKS}` on the `Sidebar` it passes as `AppShell`'s `sidebar`, imported from `links.ts`)
- Test: the owner shell's screen test (plan 04, Task 4), `web/e2e/about-readers.spec.ts`

**Interfaces:**
- Consumes: `Sidebar.about` and `AppShell`'s compact sheet.
- Produces: the group above Answering on every owner page, and in the compact sheet on a phone (board `N-Docs-Sidebar`).

- [ ] **Step 1: Write the failing tests**, one at a time: `owner_shell_links_the_about_pages` (both links, in order, with their routes); in `about-readers.spec.ts` on the mock: `open_a_document_from_the_sidebar` (from Today, "Product proposal" opens the reader showing "Back to Rivera Plumbing"; the "Capability prediction" link switches; the back link returns to Today), `about_pages_on_a_cold_load` (a fresh tab with only `lastDesk` set shows "Back to your Desk"; one with nothing shows "Back to the prototype"), `about_pages_fit_phone_width` and `about_pages_pass_axe` (both routes at 1440×900 and 390×844, with no cookie and signed in); in the owner shell's screen test, `a_bad_document_leaves_the_app_up` (with `documents.ts` mocked to throw, `/`, `/app/<desk>/today` and `/d/<slug>` render, and `/about/proposal` shows `ReaderError`).
- [ ] **Step 2: Run** `cd web && npx vitest run --project screens src/owner && npm run e2e:mock -- about-readers` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd web && npm run typecheck && npm test && npm run build && npm run check:build && npm run e2e:mock` → PASS.
- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): link the About pages from the owner sidebar"`.

### Task 6: Screenshots, recording and the design PR (PR 2)

**Files:** none in the repo; the PR description carries the media.

- [ ] **Step 1:** With the `using-browsers` skill, capture both pages at 1440×900 and 390×844 (top of page, the lead figure, the readiness scale, the measures table, the end of the page) and the sidebar group on desktop and in the compact sheet, plus one recording: Today → "Product proposal" → the "Capability prediction" link → "Read next" → "Back to Rivera Plumbing".
- [ ] **Step 2:** Open PR 2 with `shipping-prs`, run the review panel (Opus 5.5 and GPT-6.1 Sol at `xhigh`), fix what it validates, and ask the project owner for sign-off with the media in the description.

## Landing

- **PR 1** (Task 1), `plan/07-about-readers-docs` from `main`: the two documents, `docs/AGENTS.md`, the docs check and its tests, and the README's "Documents". Panel and CI; no design media. As soon as the text is ready.
- **PR 2** (Tasks 2–6): `plan/07-about-readers` from `main` after PR 1, a design PR, after the web app's run 1 and the design session's tokens and sidebar PRs, with the panel clean, CI green and the project owner's sign-off. Its description names the serif-body exception and links PR #25. The cut rule in "Before you start" applies.

## Open questions

1. **The diagram on GitHub.** A reader of `docs/product-proposal.md` on GitHub sees no architecture figure (the comment renders as nothing). A committed SVG export of `ArchitectureFigure` would fix that; not in this plan unless the project owner wants it.
2. **A firm noindex.** An `X-Robots-Tag: noindex` response header for `/about/*` at plan 06b's edge (its own cache behavior and response-headers policy) would make the opt-out independent of scripts. Not in this plan; the meta tag is a best effort.

## Review Ledger

Round 1 (2026-10-29): seats GPT-6.1 Sol (2 P1, 3 P2, 1 P3) and Opus 5.5 (1 P1, 10 P2, 10 P3). Major findings and changes:
- One source of truth for the text after Task 1, with an edit path through PRs, docs-side subset tests, and a redeploy after Sunday's fill (plan 06b's new operation 3, the commit Monday's gate runs at) ("Document lifecycle").
- The page's one replaced sentence is a pattern on the raw Markdown that keeps the repo link, tested before and after the owner fills the links.
- The back link names the business only from the query cache, else "Back to your Desk", else "Back to the prototype"; no request.
- Fidelity: the article's text must equal the document's, in full and in order; the chart gains a text equivalent; every chart claim, the April bound included (the best-score fit, 2027-04-20), is pinned to the text; the architecture labels are held to the checked list.
- Lazily loaded routes with an error boundary, so a bad document can't break the rest of the app; parsing is described as happening when that module runs, with Vitest as the gate.
- The design session supplies the reader's type tokens, a chart-point color and a document-text copy exemption; `expectScreenBasics` and `assertNoJargon` cover the chrome.
- Task 1 lands alone as PR 1; a cut rule keeps the Markdown if the design PR misses the final deploy. The docs check reads the deny list from the main checkout when a worktree has none.
- Pages readable without the passcode, with `noindex` (project owner, 2026-10-29).
- P3s taken: the test's `SHIPPED_DOCS` mirror, `searchForWorkspaceRoot` in `fs.allow`, the guards' project and plan 04's existing guards, the subset escape hatch, the renderer's rules for title, byline and tables, curly apostrophes, the chart-point token, standalone reader with QA at 1512, the spec named for the exception, Task 5's file names.
Deferred: none. Not for this plan: the prediction's length against its target, which the project owner kept as is (2026-10-29).

Round 2 (2026-10-29): seats GPT-6.1 Sol (1 P1, 3 P2) and Opus 5.5 (6 P2, 9 P3). Major findings and changes:
- The owner shell imports only `links.ts`, so a document that can't be parsed never reaches the app's entry; a guard keeps the documents and parser inside the reader, and a test with the registry throwing keeps `/`, Today and the public page up.
- The rendered page is checked block by block against the document at both widths, with expected text built from the raw Markdown.
- Where the words are written follows the master: the owner writes in the Doc, the files are what ships, and a Doc change reaches them through a PR checked before the redeploy. Edits to the files always go through a PR (`docs/AGENTS.md`), a design PR once the pages are live.
- Operation 3 checks what changed since operation 1 and runs the About tests, or reruns operation 1 in full; PR 2 must be on `main` before operation 1 or waits until after Monday's gate; the master's Sunday and Monday rows name operation 3.
- Copy checks: the design session adds the documents' acronyms to the copy guard instead of an exemption, so the whole page gets the voice rules; the owner-jargon check covers only the reader's own strings. The chart draws in primary ink, not blue (design session).
- P3s taken: `about` on the `Sidebar`, router links between the documents, the title restored on unmount, PR 1's branch and order and the Doc export for Task 1, tests that write out their expected values, the fit method and the leaderboard URL, Task 1's test names, expected `--final` output and deny-list fallback, noindex described as best effort (open question 2), plan 06b operation 2's Files line and its fallback without PR 1, the master's design line recopied after PR #25.
Deferred: open question 2 (an edge header for noindex).
