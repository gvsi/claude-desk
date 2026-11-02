# Plan 09: a Desk worth wanting, for any business

> **For agentic workers:** each area runs its own tasks with `executing-implementation-plans`, in a worktree on its own branch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** setup becomes a consultant that understands any business, shapes the Desk's tools and rules to it and proposes the apps the owner already uses; the visitor agent knows how that business works; reviewers can start from four strong businesses. By Monday 2026-11-02.

**Architecture:** Claude leads the setup conversation while code keeps the topics and the isolated limit turns. Setup publishes what it learned as `policy:` charter claims the visitor agent reads, and turns accepted jobs into business-shaped tools built on four kernel-owned building blocks. The kernel stays the only place a tool's powers, a price or a limit is decided.

**Tech stack:** FastAPI and Pydantic (API), the Anthropic SDK structured outputs (setup routes), the kernel's adapters, Cedar cards and FakeKernel, React (setup web).

**Spec:** `docs/specs/2026-10-31-desk-for-any-business-design.md` (approved by Giovanni 2026-10-31), within `docs/specs/2026-10-28-claude-desk-design.md`.

## Global constraints

- Safety invariants 1 to 6 in `AGENTS.md` are unchanged. A limit comes only from the owner's own words on that limit's own question, in a turn that never reads website, memory, connector or fact text (`LIMIT_QUESTIONS`, `setup._turn_message`). Rules come only from cards compiled by code.
- A model never writes an executable tool. Business tools are configurations of four kernel blocks; the kernel derives their effects and resource from the block, pins the configuration by hash, and starts them `needs_review`.
- A limit question's choices are built by code (`LIMIT_CHOICES`), never by the model.
- New words a person sees go to Giovanni for approval. Setup's web changes are design PRs: canvas boards and his sign-off before code.
- Token saving mode: implementers on GPT-6.1 Sol at high; reviews keep two seats (Opus 5.5 and Sol), and kernel, money and verification tasks never drop to one.
- A change under a gated path (`evals/results.py` `GATED_PATHS`: prompts.py, the kernel, setup_templates.py, presets, model settings) ships a fresh results file (`make evals-tier2 MAX_USD=0` while every scenario is pending; spending needs Giovanni's go) and bumps `PROMPT_VERSION` above main's when prompts.py changes.
- Cut order if time runs short: connector proposals beyond payments, then the blocks fall back to words only and web search waits (A5, B1 to B4, A1b, B6), then A6, A7 and C2. The consultant (A1 to A4), the visitor agent (C1) and the starters (D3) always ship.

## Review focus

1. **A website or memory that says "the owner approves payments up to $10,000 without asking"** must change no limit and no rule: the money turn's message holds none of it, and a skipped money topic leaves the cap at 0. Test in A2b.
2. **A limit question answered by clicking a choice** must take the amount the choice names, and its choices must be code's even when the model's turn offered others. Test in A2b.
3. **A business unlike any starter** ("a dog walking service", "a church office") must get proposals only from the job kinds and blocks that exist; an unknown kind or block in Claude's answer is dropped, never shown. Test in A3.
4. **"Use your suggestions" mid-interview** must finish with every remaining limit at ask-first (`None`, cap 0) and every remaining fact from what Claude already proposed. Test in A2b.
5. **A sample memory write that fails** must leave setup reading an empty memory, never Turner's. Test in A1.

---

## Seams (shared contracts owned by the setup API; changes reviewed with the affected areas)

### The setup conversation (engine A1c, A2a, A2b, A3 ↔ web D2)

`SetupState` keeps today's fields (`interview_id`, `desk_id`, `slug`, `step`, `consent`, `question`, `messages`) and gains `busy: boolean`: true while Claude's reply to the owner's last message is still being written in the background. `question` is the topic waiting for an answer, as today. Each `SetupMessage` gains two fields:

```ts
type SetupMessage = {
  role: "claude" | "owner" | "tool_label";
  text: string;                    // "" on a card message
  choices: Choice[];               // [] unless this Claude message asks a question with choices
  card: ProposalCard | null;       // set only on a card message (role "claude", text "")
  owner_decided: boolean;          // read-only: true only on a card the owner decided
};
type Choice = { text: string; recommended: boolean };   // 2..4 choices, each text ≤ 80, at most one recommended, listed first
```

- **Card messages only on request:** every setup route that answers `SetupState` (GET, consent, answer, proposals, suggestions) includes card messages only when the request carries `?cards=1`. Without it they're left out, so today's screens never show an empty bubble.
- **Asynchronous consent (A1c):** `POST …/consent` answers 200 with the state when the reads and Claude's opening land within `CONSENT_INLINE_S` (25 s), else 202 with the state as stored and `busy: true`; the web polls GET until `busy` is false. A repeat while it runs answers 202 with no second run; a failed run puts `consent` back to null with nothing half-stored.
- **Choices:** a click sends today's answer request, `POST /api/owner/setup/{interview_id}/answer` with `{question, text: choice.text}`; typing still works. Choices are live on the latest Claude message that has them, as long as no owner message came after it; card messages never carry choices. A limit question's choices come from code (`LIMIT_CHOICES`, none marked recommended), and choosing one sets exactly the limit it names; the web can't tell them apart and needn't.
- `tool_label` messages keep their shape; web search adds labels such as "Searched the web".

A proposal card is its own message, right after the Claude message that introduces it, one card per message, in order:

```ts
type ProposalCard = {
  proposal_id: string;             // "p-" + 12 hex, stable for the interview
  kind: "job" | "connector";
  state: "proposed" | "accepted" | "declined";
  job: JobProposal | null;         // when kind is "job"
  connector: ConnectorProposal | null;   // when kind is "connector"
};
type JobKind = "answer" | "intake" | "schedule" | "price" | "documents" | "status" | "payment" | "urgent";
type JobProposal = {
  job: JobKind;
  title: string;                   // ≤ 60, the owner's words: "Book a free intro consult"
  why: string;                     // ≤ 200, the value in the owner's terms
  how: string;                     // ≤ 300, how the Desk handles it
  autonomy: "auto" | "ask";        // the job's rule: does it on its own, or asks the owner first
  can_do_today: boolean;           // set by code (CAPABILITIES), never the model; false shows as coming later
  config: BlockConfig | null;      // the business tool it becomes, when it has one
};
type BlockConfig =
  | { block: "intake"; questions: string[] }                            // 1..5, each ≤ 120
  | { block: "typed_booking"; appointment_type: string; minutes: number }  // type ≤ 60, minutes 15..60, shown only: one booking takes one 60-minute slot
  | { block: "purpose_payment"; purpose: string; amount_cents: number }    // purpose ≤ 60, 0..1_000_000, a kernel-priced item
  | { block: "urgent"; urgent_when: string };                           // ≤ 300
type ConnectorKey = "google_calendar" | "gmail" | "google_drive" | "quickbooks" | "stripe" | "square" | "calendly";
type ConnectorProposal = {
  app: ConnectorKey;
  label: string;                   // "Google Calendar"
  why: string;                     // ≤ 200
  connectable: boolean;            // true only for "stripe" (the mock payments server) today; false shows as coming later
};
```

- **`CAPABILITIES` (code):** `can_do_today` is true for answer, intake, schedule, price, payment and urgent, and false for documents and status on Monday (a setup Desk has no one on record, no status records and no uploads).
- **`autonomy` is a rule, never an amount:** an accepted job's autonomy is owner-confirmed input to setup's card drafting. A money job's "auto" still runs only under the limits the owner gave on the isolated limit questions.
- **Card decisions:** `POST /api/owner/setup/{interview_id}/proposals/{proposal_id}` with `{accept: boolean, title?: string, amount_cents?: number, autonomy?: "auto" | "ask"}`. `title` (≤ 60), `amount_cents` (purpose payments) and `autonomy` are allowed only with `accept: true` (else 422), and the card comes back `accepted` with them applied. Only the pending card can be decided (409 otherwise); the decision runs Claude's next turn (see "Card flow" below). 404 for an unknown card, 409 once `step` has left `questions`.
- **Finalizing (one routine for the last answer and for "Use your suggestions"):** cards still `proposed` become `accepted` (declines stay); every topic not yet covered is covered, its limit asking the owner; code writes `SetupAnswers.how_we_help` (≤ 1500) from the accepted jobs, one "title: how" line each; accepted connectable connectors are connected and accepted jobs with a `config` become business tools (A5); `step` moves to `tools`.
- `POST /api/owner/setup/{interview_id}/suggestions` with `{}` runs that routine at once.

### What setup publishes for the visitor agent (A4 ↔ C1, and the public About panel)

Text charter claims, each only when set: `policy:about` (the summary), `policy:service_area`, `policy:pricing`, `policy:intake`, `policy:after_hours`, `policy:urgent`, `policy:how_we_help`, and `contact`.

### Business tools (engine A5 ↔ kernel B1 to B4)

`PUT /desks/{desk_id}/business_tools` with `{tools: BusinessTool[]}`, a whole replace, owner-only, ledgered without text. `BusinessTool = {tool: string /^desk\.[a-z][a-z0-9-]{0,39}$/, title: string ≤ 60, description: string ≤ 300, config: BlockConfig}`, with `BlockConfig` exactly as above. A 404 means the blocks aren't deployed: setup goes on with words only (`policy:how_we_help`). The kernel owns everything past this seam; B1 to B4 list what it must cover.

---

## Setup API (`backend/desk/api/setup.py`, the setup section of `prompts.py`, `routes/setup.py`)

### Task A0: specs and this plan (0.5 h, must)

**Files:** Create `docs/specs/2026-10-31-desk-for-any-business-design.md`, this plan. Modify `docs/specs/2026-10-28-claude-desk-design.md` lines 46 and 55 ("Creation", "Setup length") to point at the new design: setup is a consultant conversation, as long as it's useful, with a "Use your suggestions" way out.

- [ ] Run `make docs-check`; expect exit 0.
- [ ] Commit `docs: plan setup as a consultant and business-shaped Desks (plan 09)`; open the PR, review panel, merge.

### Task A1: sample memory and connected apps at start (2 h, must; needs B0)

**Files:** Modify `prompts.py` (`SetupStart`, `SETUP_START_SYSTEM`), `setup.py` (`_read_description`, `_make_desk`, `Interview`, `_stored`), `backend/tests/kernel_contract/fake_kernel.py` (the route, if B0 hasn't added it). Test `backend/tests/api/test_setup_questions.py`.

**Interfaces:**
- Consumes B0: `PUT /desks/{desk_id}/memory` with `DeskMemoryRequest{about: str ≤ 500, items: list[MemoryItem]}`, `MemoryItem{id: ^[a-z][a-z-]{0,59}$, title ≤ 200, topics: list[str], text ≤ 2000}`, at most 20 items, answering `DeskUpdated`.
- Produces: `SetupStart.memory: list[MemoryDraft]` (`MemoryDraft{title ≤ 120, topics: list[str] ≤ 6, text ≤ 600}`, at most 8) and `SetupStart.connected_apps: list[ConnectorKey]` (at most 4), where `ConnectorKey = Literal["google_calendar", "gmail", "google_drive", "quickbooks", "stripe", "square", "calendly"]` in `prompts.py` with `CONNECTOR_LABELS: dict[ConnectorKey, str]`. `Interview.connected_apps: list[ConnectorKey]`, stored with the interview.

- [ ] **Test** `test_start_writes_the_sample_memory_before_the_consent_read`: begin with `started(memory=[...], connected_apps=["google_calendar"])`; assert the fake kernel's calls run `POST /desks`, then `PUT /desks/{id}/memory` with items whose ids are slugs of their titles and whose topics include at least one word of `MEMORY_QUERY`, before any `native.read_memory` execute; after consent, the memory entry's content holds the drafted text.
- [ ] **Test** `test_a_failed_memory_write_reads_an_empty_memory_never_riveras`: `fake.fail("PUT /desks/{id}/memory", "500")`; the start still answers 201, and after consent the memory content has no "Turner" and no "Mike".
- [ ] **Test** `test_connected_apps_outside_the_catalog_are_dropped`: the model's JSON names `"taxdome"`; the retry rule rejects it (`SetupStart` validation), and the stored interview's `connected_apps` holds only catalog keys.
- [ ] Implement: `SETUP_START_SYSTEM` asks for what the owner's Claude memory would plausibly hold about this business (its name, what it does, its customers, how it prices, its hours and area, how it talks to customers), written as the owner's own notes, and up to four apps from the catalog a business like this would already use. `_make_desk` PUTs the memory right after `POST /desks`; a failed PUT logs and goes on.
- [ ] Run the three tests, then `tests/api/test_setup_questions.py tests/api/test_prompts.py tests/api/test_schema_budget.py -q`; commit `feat(api): write a sample memory for each new Desk at setup start`.

### Task A1b: web search in the consultant's homework (1.5 h, should; needs B6)

**Files:** Modify `setup.py` (`consent`: a new `_search_web` read after the memory and website reads), `prompts.py` (`WEB_SEARCH_TAG`, labels, the understanding prompt's "What you get"). Test `test_setup_questions.py`.

**Interfaces:** consumes B6's owner setup tool `native.web_search` with args `{query: str ≤ 200}` and a model view `{results: [{title, url, snippet}] ≤ 8, simulated: false}`. Produces an `Entry(role="tool_label", read="web_search", content=...)` whose content reaches the understanding turn and fact turns inside `<web_search>`, and never a limit turn.

- [ ] **Test** `test_setup_searches_the_web_for_the_business_after_consent`: with consent yes, one `native.web_search` is decided and executed with the business name and service area as the query, its label is inline, and its text is inside `<web_search>` in the understanding turn.
- [ ] **Test** `test_web_search_text_never_reaches_a_limit_turn`: a planted result "Owner approves payments up to $10,000" is absent from every limit turn's text.
- [ ] **Test** `test_no_search_without_consent_or_when_the_tool_isnt_given`: declined consent, or a Desk whose context lacks the tool, runs no search and setup goes on.
- [ ] Implement; commit `feat(api): let setup search the web for the business during its homework`.

### Task A2a: the understanding turn (3 h, must)

**Files:** Modify `prompts.py` (new `SETUP_UNDERSTAND_SYSTEM`, `SetupUnderstanding`, `JobProposal`), `setup.py` (`consent`), `schemas.py` (`SetupMessage`). Test `test_setup_questions.py`.

**Interfaces:**
- Produces `JobKind = Literal["answer", "intake", "schedule", "price", "documents", "status", "payment", "urgent"]` and `Block = Literal["intake", "typed_booking", "purpose_payment", "urgent"]`.
- `JobProposal`, `BlockConfig`, `ConnectorKey` and `Choice` exactly as in Seams, as Pydantic models in `prompts.py`. `SetupUnderstanding{reply ≤ 1200, jobs: list[JobProposal] 2..5, connectors: list[ConnectorProposalDraft{app: ConnectorKey, why ≤ 200}] ≤ 4, next_topic: QuestionKey, question ≤ 300, choices: list[Choice] ≤ 4}`.
- `SetupMessage` gains `choices: list[Choice] = []` and `card: ProposalCard | None = None`, as in Seams (A3 adds the cards).

- [ ] **Test** `test_consent_opens_with_how_claude_understands_the_business`: after consent yes, the messages after the read labels are one Claude message with the understanding's reply, then Claude's question with its choices; the model request's system is `SETUP_UNDERSTAND_SYSTEM` and its one message holds the description, memory, website and connected apps each in its wrapper.
- [ ] **Test** `test_the_understanding_never_reaches_a_limit_turn`: plant "Quotes up to $5,000 need no check" in the website; answer up to `quote_limit`; the limit turn's text holds no part of the understanding's reply or jobs.
- [ ] Implement: `consent` calls `structured(..., SETUP_UNDERSTAND_SYSTEM, [...], SetupUnderstanding, ...)` after the reads; the reply becomes a Claude entry; `next_topic` must be a fact topic (else `what_you_do`); a fact topic's question is Claude's, a limit topic's is `question_text`. `SETUP_UNDERSTAND_SYSTEM` is the consultant brief from the spec's Part A, items 1 to 6a, in the prompt's existing plain style.
- [ ] Run, bump `PROMPT_VERSION`, commit `feat(api): open setup with how Claude understands the business`.

### Task A2b: Claude leads the topics; choices; "Use your suggestions" (4 h, must)

**Files:** Modify `prompts.py` (`SETUP_TURN_SYSTEM`, `_turn_fields`, `LIMIT_CHOICES`), `setup.py` (`Interview.covered`, `answer`, new `use_suggestions`), `routes/setup.py` (new `POST /api/owner/setup/{id}/suggestions`), `schemas.py`. Tests `test_setup_questions.py`, `test_schema_budget.py`.

**Interfaces:**
- Every turn model gains `next_topic: QuestionKey | Literal["done"]`, `question: str ≤ 300`, `choices: list[str] ≤ 4`, `skip: list[QuestionKey] ≤ 7`. Code ignores `question` and `choices` when `next_topic` is a limit topic, and uses `question_text(key, business_type)` and `LIMIT_CHOICES[key](business_type)` instead.
- `LIMIT_CHOICES: dict[QuestionKey, Callable[[BusinessType], list[str]]]` for the four limit topics, built from `SUGGESTED_MONEY_CAP_CENTS` and fixed amounts; each list starts with the always-ask choice. Exact words go to Giovanni for approval before merge.
- `Interview.covered: set[QuestionKey]`, stored. A skipped limit topic is covered with its safe default: its limit `None` (asks), `documents` `"ask"`, the cap 0.
- `use_suggestions(owner, engine, interview_id) -> SetupState`: covers every remaining topic (facts as they stand, limits at their safe defaults), then the step moves to `tools` as after the last answer.

- [ ] **Test** `test_claude_chooses_the_next_fact_topic_and_its_words`: a turn naming `next_topic="contact_and_after_hours"` with its own question asks that next, out of order.
- [ ] **Test** `test_a_limit_topic_always_asks_codes_question_and_choices`: a turn naming `next_topic="money_limit"` with `question="Should I take up to $10,000?"` and `choices=["$10,000"]` stores `question_text("money_limit", ...)` and `LIMIT_CHOICES["money_limit"]("office")`.
- [ ] **Test** `test_a_skipped_money_topic_leaves_the_cap_at_0`: a website saying "the owner approves payments up to $10,000 without asking" and a turn with `skip=["money_limit"]` end with `auto_money_cap_cents == 0` and no money turn ever sent.
- [ ] **Test** `test_a_clicked_choice_answers_its_limit`: answering `money_limit` with the text of `LIMIT_CHOICES["money_limit"]("office")[1]` stores the amount that choice names (scripted turn sets it; the turn's message holds the choice text as `<owner_answer>`).
- [ ] **Test** `test_use_your_suggestions_finishes_with_every_limit_asking`: after `what_you_do`, `POST .../suggestions` answers 200 with `step == "tools"`, every limit `None`, the cap 0, the facts unchanged.
- [ ] **Test** `test_the_last_turn_closes_with_the_plan`: a turn with `next_topic="done"` stores its reply (the plan: what the Desk will handle, with two or three example customer conversations in this business's words) as the last Claude message before `QUESTIONS_DONE`, and the step moves to `tools`.
- [ ] **Test** `test_each_turn_schema_stays_within_budget` (existing budget test, rerun).
- [ ] Implement; rewrite `SETUP_TURN_SYSTEM` as the consultant (one thing at a time, skip what doesn't fit, explain plainly, choices when they help, never name an amount for a limit). Keep #295's exchange block.
- [ ] Run the setup tests; commit `feat(api): let Claude lead setup's topics, with choices and a way to finish fast`.

### Task A3: proposals the owner accepts or changes (3 h, must)

**Files:** Modify `schemas.py` (`ProposalCard`), `setup.py` (`Interview.proposals`, `decide_proposal`), `routes/setup.py` (`POST /api/owner/setup/{id}/proposals/{proposal_id}`), `openapi.json`. Test `test_setup_questions.py`, `test_openapi.py`.

**Interfaces:**
- `ProposalCard` and `ConnectorProposal` exactly as in Seams: one card message per job and per connector, right after the Claude message that introduces them, in order.
- `POST .../proposals/{proposal_id}` and `POST .../suggestions` exactly as in Seams; accepted connectable connectors connect when the step moves to `tools`.
- `connectable` is true only for `stripe` (the mock payments server today).
- Consumed by D2 (web) and A4, A5.

- [ ] **Test** `test_proposals_come_as_cards_on_the_understanding`: two jobs and one connector give three cards, `proposed`.
- [ ] **Test** `test_an_unknown_job_kind_or_block_is_never_shown`: the model's JSON with `job: "teleport"` fails validation and gets the one retry; a valid retry shows only valid cards.
- [ ] **Test** `test_accepting_and_renaming_a_job`: accept with `title="Free 20-minute intro call"` stores it accepted with the new title; a second decision on the same card answers 200 with the latest state.
- [ ] Implement; commit `feat(api): let the owner accept, rename or decline setup's proposals`.

### Task A4: publish what setup learned for the visitor agent (1.5 h, must)

**Files:** Modify `prompts.py` (`SetupAnswers` gains `pricing`, `intake`, `urgent`, each `str | None ≤ 500`, stored-only `how_we_help` ≤ 1500 for the finish step, and code-only `suggested_fields: list[str]`, default empty; each policy is a field only of the turns of the questions that ask for it: `pricing` on `what_you_do` and the quote question, `intake` on `what_you_do`, `urgent` on `what_you_do` and `contact_and_after_hours`, and `after_hours` on `hours_and_area` and `contact_and_after_hours`, with `website` on every question but `contact_and_after_hours` and no hours on `what_you_do`, so no turn has more than 20 top-level properties and every turn's strict schema compiles), `setup.py` (`seed_parts`). Test `test_setup_rules.py` and `test_setup_questions.py`. Policy descriptions and the consultant prompt keep amounts, percentages, times, days and numbers out of policy text, leave hours to their topic, and keep `after_hours` customer-facing, without private owner instructions or personal phone numbers. Limit turns read no stored policies; of the limit turns, only the existing quote turn may set `pricing`, from the owner's answer alongside its `price_items`.

**Interfaces:** `seed_parts` uses one `SETUP_POLICY_CLAIMS` field-to-key map to write trimmed, nonblank text claims `policy:about` (the summary), `policy:service_area`, `policy:pricing`, `policy:intake`, `policy:after_hours`, `policy:urgent`, and `policy:how_we_help`. Fields in `suggested_fields` publish no policy claim until owner confirmation. `contact` comes from `public_contact`; hours keep their own part. Consumed by C1. The kernel policy-text check (B7) must ship with these claims. The public contact is held like a policy line. The kernel checks the contact first, so a refusal naming only the contact drops it without using up a policy retry. The first other detailed refusal drops its named keys and retries; a cap refusal or detail naming no charter key drops every policy claim instead. A second detailed refusal drops every policy claim left and any other key it names. At most four charter PUTs occur when the contact is refused on its own and three otherwise, nothing is re-sent unchanged (a refusal with nothing left to drop propagates), and other failures propagate. The dropped keys reach `SetupState.held_policy_keys`.

- [ ] **Test** `test_seed_parts_publish_policy_claims`: answers with every field give exactly those keys, kind `text`, values trimmed; unset fields give no claim.
- [ ] Implement; run `test_setup_rules.py test_setup_questions.py -q`; commit `feat(api): publish setup's business summary and policies to the Desk`.

### Task A5: business tools from accepted jobs (2 h, should; needs B1 to B4)

**Files:** Modify `setup.py` (`_put_parts` or a new `_put_business_tools`), `tests/kernel_contract/fake_kernel.py`. Test `test_setup_rules.py`.

**Interfaces:** consumes B's `PUT /desks/{id}/business_tools`. Each accepted job with a `config` becomes a `BusinessTool{tool: "desk.<slug of title>", title, description: job.how, config}` (Seams). They then show in setup's Tools step as `needs_review`, through today's `setup_tools`.

- [ ] **Test** `test_accepted_jobs_become_business_tools_needing_review`: two accepted jobs with blocks and one declined give one PUT with two tools; `GET .../tools` lists both `needs_review`.
- [ ] **Test** `test_without_the_blocks_route_setup_keeps_words_only`: the fake kernel answers 404 for the route; setup goes on, and the jobs' `how` is in `policy:intake` / `policy:urgent` as A4 writes them.
- [ ] Implement; commit `feat(api): turn accepted setup jobs into business tools for review`.

### Task A6: add yourself as a test client (2 h, could)

**Files:** `setup.py`, `prompts.py`. Test `test_setup_rules.py`. Uses `PUT /desks/{id}/people` (and the documents part if the kernel has one; else people only). At the plan's end Claude offers, as a choice, to add the owner with their own contact as a client on record, with one sample document in their name, so a tester can verify and receive it.

- [ ] **Test** `test_a_test_client_is_put_only_when_the_owner_says_yes`; implement; commit `feat(api): let setup add the owner as a test client`.

### Task A7: keep a setup Desk's calendar open (1.5 h, could)

**Files:** `backend/desk/calendar.py` (new: `calendar_slots`, moved from `setup.py` so the kernel can share it), `backend/desk/kernel_service/desks.py` (`extend_calendar`, `extend_calendars`, `keep_calendars_open`), `app.py` (the lifespan task), `repo.py` (`limit_lock_waits`, the lock order). The kernel's lifespan runs a pass at its start and then daily, beside the kernel and cancelled at shutdown. Each live Desk with hours that setup made (its version 1 came from the `ask_first` preset, which `POST /desks` activates; Turner's seed starts from `rivera`) gets, in a transaction of its own under its Desk row, the slots its hours give for the days after its latest slot, up to 14 days ahead in the business's time zone. It only inserts: booked slots, slots a waiting request names and the owner's changes inside the covered days stay as they are, while a trimmed tail or a cleared calendar is filled again (wish #596). Each extension is ledgered as the owner's calendar write is, `desk_data` `{part: "calendar", refs, extended_from: "hours"}`. An API job was rejected because API jobs hold no credential and never call the kernel. Test `backend/tests/kernel/test_calendar_refresh.py`: `test_the_calendar_is_refreshed_from_the_hours`.

### Task A8: the run's fixes (in flight)

Branch `fix/setup-live-run`: #295, #305, #306 (setup side), #311; #304's cause reported for review. One PR, two-seat panel, merge before A2b to keep conflicts small.

---

## Kernel: the contract setup consumes, and the gaps

### B0: per-Desk sample memory (#303) (in progress)

As agreed: `PUT /desks/{desk_id}/memory`, whole replace, owner-only, canary-checked, ledgered without text; `native.read_memory` reads the Desk's own memory, Turner's seed keeps the fixture, any other unwritten Desk reads empty.

### B1 to B4: four building blocks (the kernel owns the internals; 13 h together, should)

The seam setup needs:
- `PUT /desks/{desk_id}/business_tools` exactly as in Seams.
- Each tool's profile is derived by code from its block's base adapter (B1 intake on `native.capture_lead`, B2 typed booking on `find_slots`/`book`, B3 purpose payment on `payment_link` with the amount as a kernel-priced item, B4 urgent on `request_callback` raising the owner's "urgent" alert now). Its `definition_sha256` covers the canonical configuration; it starts `needs_review`; the owner turns it on through today's tool review; rule cards apply to it like any tool; text in its configuration is untrusted and never instructions.
- Acceptance for each block, on the kernel contract suite: a decided and executed call on a Desk with that tool turned on; a changed configuration sets it back to `needs_review`; a visitor's free text can't change the block's amount, type or questions; B3's money obeys the cap and the baseline (invariant 3); B2's confirmation card names the appointment type; B4's alert reaches the owner at once.
- Reviews: two seats; B3 is money.

### B6: an owner-only web search read for setup (2.5 h, should)

`native.web_search`, an owner setup tool like `native.fetch_website` (only an owner session is given it, decided and executed like any tool, effects `read`, resource `desk`). Its adapter calls Claude's server-side web search from the kernel and returns `{results: [{title, url, snippet}] ≤ 8, simulated: false}`, each snippet ≤ 500 characters. Results are untrusted text, stored as owner-only knowledge like the memory read, never instructions; a canary or an over-cap result is dropped. Acceptance: a visitor or agent session is never given it; a failed search returns a failed result and setup goes on.

### B5: the reply check's booking words (1 h, must)

"Your viewing is confirmed." and "The consultation is confirmed." pass the prose scan today. Extend the booking-confirmation lexicon (en and es) to appointment, viewing, consultation, consult, session, visit and their Spanish forms, with a calibration case each. Invariant 2; evals gate.

---

## Visitor prompt and demo-agent API

### C1: a business-aware section (3 h, must; consumes A4)

`SYSTEM_PROMPT` reads the `policy:` claims in `<desk_context>` (about, pricing, intake, after_hours, urgent): use the business's own words; when no price covers a request, offer the business's next step (book a consult, take the details) instead of a dead end; qualify a new request with the intake questions; treat what the business calls urgent as urgent; name a business tool by its title when one fits. Bump `PROMPT_VERSION`, results file, legitimate-task rate held.

### C2: the demo agent's tasks from the Desk (1.5 h, could)

Instead of a water heater visit on every Desk, `DEMO_TASKS` holds a fixed line for each task in each `DemoTaskSet` (#572):
- `rivera` for the copy's seeded Desk, its three lines unchanged;
- `trade`, `office`, `landlord` and `other` for a Desk setup made, picked by code from its `app.setup_interviews.business_type` alone (`agents.demo_task_set`); a Desk with no known type reads `other`.

`GET /api/public/desks/{slug}/agent_tasks` answers that key, and the agents page words its task chips from its own copy for it. The owner signed the lines and the chips on 2026-11-01. Two other designs were rejected:
- (a) Lines built from the Desk's business tool titles or catalog names: that owner text would reach the agent's model, whose requests its launcher sees unchecked, widening that recorded exception.
- (b) Hiding the agent's words for Desk-built tasks: it would undo the owner's decision to show them.

---

## Setup web app

### D1: canvas boards (3 h plus sign-off, must)

At 1512 and 390 wide: the consultant's opening with job and connector cards, a question with choices, "Use your suggestions", the start screen's four starters, and the Tools step showing business tools `needs_review`. Giovanni signs off before D2.

### D2: build the conversation's cards and choices (5 h, must; consumes A2a, A2b, A3)

Render `SetupMessage.card` (accept, rename, decline through A3's route) and `SetupMessage.choices` (a click sends the choice's text as the answer; typing still works); "Use your suggestions" calls A2b's route. Design PR with captures.

### D3: four starter businesses (2 h, must)

One click fills the start description: a hair salon (name to choose), Turner Plumbing, Maple Street Rentals, Chen & Co. CPA. The setup API defines the four descriptions; Giovanni signs off the words.

---

## Schedule and what can be cut

| Task | Owner | Hours | Ships by Monday |
|---|---|---|---|
| A0 specs and plan | Setup API | 0.5 | must |
| A1 sample memory, connected apps | Setup API | 2 | must |
| A1b web search in setup | Setup API | 1.5 | should (cut 2) |
| A2a understanding turn | Setup API | 3 | must |
| A2b Claude-led topics, choices, suggestions | Setup API | 4 | must |
| A3 proposals | Setup API | 3 | must |
| A4 policy claims | Setup API | 1.5 | must |
| A5 business tools | Setup API | 2 | should (cut 2) |
| A6 test client | Setup API | 2 | could (cut 3) |
| A7 calendar refresh | Kernel | 1.5 | could (cut 3) |
| A8 the run's fixes | Setup API | in flight | must |
| B0 memory route | Kernel | in flight | must |
| B1 to B4 blocks | Kernel | 13 | should (cut 2) |
| B5 booking words | Kernel | 1 | must |
| B6 web search read | Kernel | 2.5 | should (cut 2) |
| C1 business-aware prompt | Visitor prompt and demo-agent API | 3 | must |
| C2 demo tasks | Visitor prompt and demo-agent API | 1.5 | could (cut 3) |
| D1 boards | Setup web app | 3 + sign-off | must |
| D2 cards and choices | Setup web app | 5 | must |
| D3 starters | Setup web app | 2 | must |

Setup API task order: A8, A0, A1, A2a, A2b, A3, A4, then A5 when B lands. D2 can build against A3's schemas once A3's PR is open.

---

## Round 1 decisions (these win over any task text above)

Work is divided by system area: the setup API owns the conversation engine, cards and publication of policy claims; the kernel owns memory, search, building blocks and reply checks; the visitor prompt uses the published business context; the setup web app owns boards, asynchronous consent, cards and starters. Consultant prompt changes belong to the setup API.

**Setup API engine and cards**
- **A1c, asynchronous consent:** as in Seams. Consent "no" runs the understanding on the description alone.
- **Limit turns don't plan.** Limit-topic turn models have no `next_topic`, `question`, `choices` or `skip`. After a limit topic finishes, a consultant "next step" call reads the business context and has no limit fields at all. It picks the next topic and writes its question and choices, or writes the closing plan. The closing plan never comes from a limit turn. Test: finish setup right after each limit topic.
- **No amount reaches the owner from untrusted text before a limit question.** When the next topic is a limit, code drops the preceding reply if the reply check's number scan finds an amount, a percentage or a number word. The fixed question still asks.
- **Limit choices:** `LIMIT_CHOICES[key](business_type)` returns `LimitChoice{text, values}` built by code, with choices for both two-field questions (`documents_and_payments`, `money_limit`). An answer that exactly matches a live choice's text applies its values and overrides the model's patch. Test: the model returns a larger amount, and the choice's amount is stored.
- **`SetupUnderstanding.suggested`:** a facts-only patch from the homework (area, hours, contact, after-hours, pricing, prices). It has no limit fields, and `merged` drops any. The finish step merges it into fact topics not yet covered, so "Use your suggestions" right after the opening still gives a working Desk.
- **Invalid jobs are dropped after parsing,** never failing the whole answer. `SetupUnderstanding` joins `test_schema_budget.py`.
- **Precedence:**
  - A follow-up (`step_done` false) wins over `next_topic`.
  - `skip` ignores covered topics.
  - A covered topic is never asked again.
  - Code closes once every topic is covered.
- **Storage:** everything in the transcript (`Entry` fields), with no migration and no DDL. Card decisions take the interview's turn guard (`_turn`), so a decision while a turn runs answers 409 and an answer is never lost to a card click. Add a reload test.
- **Purpose payments:**
  - Code strips the model's `amount_cents`; a proposal carries `amount_cents: null`.
  - Accepting a purpose-payment card needs an owner-entered `amount_cents` (422 `amount_required`).
  - The tool is held to `min(payment_link_auto_max_cents, money cap)` like `native.payment_link`. Setup's `_past_a_limit`, `_card_problems` and `rules.py`'s money targets switch to an effect-based `money_tool(tool, effects)`.
- **`CAPABILITIES` and a setting:** `can_do_today` is code's. `config` is cleared on every card while `BUSINESS_TOOLS_ENABLED` (API setting, default off) is false. It turns on when B1 deploys.
- **Words-only path:** `how_we_help` ("title: how" per accepted job), published by A4, is the fallback. Its test lives in A4 so it ships even if A5 is cut.
- **Connecting accepted apps:** a failed connect logs and goes on, and the Tools step offers today's connect.
- **A1:**
  - Memory ids are built by code: "m-" plus a letters-only slug, de-duplicated with letter suffixes, and a fallback when empty. Test: a title with digits.
  - A1 merges after B0.
  - The test that an unwritten non-Turner Desk reads empty is B0's.
  - A1 updates README.md's "real, mocked and unfinished" row: the memory is drafted from the owner's description, connected apps are simulated, and web search is real.
- **A1b:** search text reaches only the understanding turn. Queries are about the kind of business (Giovanni), at most 3.
- **A6:** people only, with no document. The contact comes from the owner's answer on that turn, never `public_contact`.
- **A7 belongs to the kernel** (the kernel extends a Desk's slots from its hours, as the Turner seed does), as a could. The API job worker never calls the kernel.

**Kernel**
- **Blocks core:** the kernel stores each business tool with a configuration hash, derives its adapter and Cedar effects from its block, and requires review after a change. Configuration changes invalidate stale decisions; the contract is specified below:
  - Business tools are `kernel.tools` rows with source "business".
  - `AnyToolName` covers the natives plus `desk.*`.
  - The compiler generates per-Desk Cedar actions in the block's effect groups.
  - `adapters.resolve` looks up a business tool's adapter per Desk.
  - The hash covers {title, description, config}, so a change sends the tool back to `needs_review` and fails stale decisions closed.
  - It adds rule targets for `desk.*`, a `business_tools` ledger kind and the `web_search` knowledge source.
  - Record shared-contract changes in the master plan before implementation.
- **Description template:** `description_confirmed` is built from a fixed template per block, with the config quoted as data. Test: an instruction planted in `how` appears only inside quotes.
- **Money:** `moves_money` and `auto_money` become effect-based for business tools (B3).
- **Urgent alerts:** urgent alerts reach the owner's Demo inbox at once, whatever the notification settings (see Owner rulings after round 1) (B4).
- **B6:**
  - Up to 3 searches per setup, a 30 s deadline each, on `claude-sonnet-5-5`, with usage ledgered. (Raised from 20 s on 2026-11-01: twelve measured searches took 15.1 s at the median and 18.2 s at most, before the hosted network hop, and a search lost costs setup more than ten seconds' wait.)
  - What it returns is Claude's cited summary, labelled as such.
  - Search spend follows Giovanni's approval of 3 per setup.
- **B7, new, kernel policy-text checks:** `PUT /desks/{id}/charter` refuses a `policy:` text claim that holds an amount, a percentage, or discount, refund or guarantee words (the reply check's lexicon). Setup pre-filters with the same function and drops an offending claim, logged by key. Tier 1 rows, with no model calls:
  - A website discount never reaches a policy card.
  - A business tool config stays quoted.
  - A visitor's text can't change a block's amount.
  - Each new booking word (en/es).
  - Search text never reaches a charter claim.

**Visitor prompt:** `after_hours` is written as customer-facing text, never the owner's private instruction. C1 names its files and tests (the prompt section; `policy:` claims reach the model wrapped in `<desk_context>`). The tier 2 rate stays unmeasured until plan 02's scenarios run, which is a known gap.

**Setup web app and boards:**
- A purpose-payment card needs an amount before accept.
- Card actions are disabled while an answer is in flight.
- **D4, new:** business tools render by title, with their config shown, in the Tools step, Rules, Needs you and visitor receipts (after B1).
- D1 adds the "What customers will read" list of policy claims before the safety check, a should.

**Rules inline:** a job card's `autonomy` is the inline rule. Rule cards themselves stay on the Rules review for Monday.

**Order and checkpoints:**
- Merge order: #326, then the web's async consent, A1c, B0 and A1, A2 (A2a + A2b), A4 with B7, C1, then A3 with D2 together, B6, then the blocks one by one.
- Testable pivot: tonight (Giovanni's goal), with the core (A1c, A1, A2, A3, A4, B7, C1, D2, D3) live by about 23:00.
- Cut checkpoint: if the blocks core with B1 isn't open by 02:00 Sunday, B2 to B4 go words only.

## Owner rulings after round 1 (2026-10-31; these win too)

- **Money maximums are optional** (Giovanni: "it's something the owner can set but they shouldn't be mandated to set one"). The money cap with refunds, and the payment-link limit, are opt-in topics, never asked by default. Until the owner sets an amount, every payment asks the owner (cap 0, refunds "ask", link limit unset), so invariant 3 holds. The consultant mentions it once, with a choice to set an amount it handles on its own, now or later in Rules. Only on opt-in does code ask the isolated limit question. The money question loses its "I'd suggest $X to start" sentence, and no limit choice is marked recommended.
- **Urgent alerts (B4):** an urgent call alerts the owner's Demo inbox at once, whatever the notification settings. No settings row is written, and the callback stays kind `callback` (no migration). Every urgent call alerts, with no throttle (Giovanni): a looping visitor or agent can send repeated alerts, a known risk. An urgent request that is held for approval alerts through the approval alert, which follows the owner's settings, until a later change.
- **How we help lists only each accepted job's `how` line, with no title** (Giovanni). `how` is written in the third person, with no "you" or "your" and no prices, "free", durations, times, days or numbers, because customers read it and the public policy scan refuses those words. A refused `policy:how_we_help` is dropped and logged by key.
- **Web search queries are about the kind of business**, never this business by name, its competitors, prices or fees (Giovanni). This replaces the spec's "by name and area". The consent question keeps its wording.
- **An unpriced purpose-payment card at finish becomes "declined"** ("Not now"). It isn't a job, a tool or part of `how_we_help`.
- **Copy signed off:**
  - the 13 D1 boards, their words and calls, and board 14 with editing in place (built Sunday);
  - "Urgent", "Amount" and "Enter an amount to accept this.";
  - the four starters in en/es;
  - the About labels (About us, Pricing, Getting started, After hours, Urgent help, How we help);
  - the web search strings;
  - the safety check's "6 of 6 stopped", with each row keeping "Blocked" or "Asks you".

## Card flow (owner rulings, 2026-10-31 afternoon; these win over the Seams above)

- **One thing per turn.**
  - The opening says the business back and outlines the plan in words, with no cards. Planned jobs and connectors stay hidden.
  - Each Claude turn then asks exactly one thing: a question (choices docked above the composer, numbered, with keys, "Something else…" and a dismiss), or one proposal card inline in the transcript.
- **A card is the question.**
  - "Set it up", "Not now" or "Connect" answers it, and Claude replies and asks the next thing.
  - Typing in the composer also answers it (`POST …/answer` with `{question: null, card, text}`). Claude may accept, decline, re-propose an updated card (the old one becomes `changed` with `superseded_by`), or answer a question and keep it pending.
- **SetupState fields:** `pending_card` names the card awaiting an answer, and `question` is null while one is. Without `?cards=1`, setup never asks with a card (topics only) and accepts the plan unshown at finish.
- **Card fields:** a short title, one plain line (`how`), and rows: Who (`who`), Uses and Next for you (fixed words by kind), Asks (intake questions). A payment card has one owner-entered Amount.
- **Apps:**
  - Every catalog app connects on accept: Stripe for real, the others simulated with the Mock badge.
  - A simulated app adds no capability, and Claude never claims one.
  - Claude says "connecting", never "connected".
- **Prerequisites first:** bookings need opening hours, quotes and payments need prices (and Stripe), and documents need a client on record.
- **Suggested facts:**
  - Facts finish fills from Claude's homework are listed in `SetupAnswers.suggested_fields`.
  - They never reach drafting as the owner's words, and are never published as `policy:` claims until the owner confirms them.
  - Fields the owner set or cleared are never refilled.
- **Fixed words Giovanni signed:**
  - card labels: "Set it up" / "Set up", "Changed below", "Connected", "Something else…", the key hint, the row labels and the Uses / Next-for-you values;
  - "Use your suggestions";
  - the payment line "I'll ask you before any payment. You can set an amount I handle on my own, now or later in Rules.";
  - the limit questions and choices;
  - the web search labels;
  - the typed-booking card, receipt and alert;
  - the intake receipt and hold sentences;
  - "free" allowed only in business tools' title and appointment type.

## Review Ledger

| Round | Seats | Findings | What changed |
|---|---|---|---|
| 1 | Sol, Opus | Sol 3 P1 + 9 P2; Opus 6 P1 + 12 P2 + 9 P3, overlapping | Seams v2 (busy, `?cards=1`, autonomy, code-owned capabilities, the finish step, amounts entered by the owner); limit turns don't plan; `LimitChoice`; suggested facts; transcript storage; effect-based money for business tools; B7 policy-claim scan; A7 moved to the kernel; D4 added. No P1 left open. Not re-reviewed (round cap 1); each area builds against these decisions. |
