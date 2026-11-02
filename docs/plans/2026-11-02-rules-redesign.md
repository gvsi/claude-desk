# Rules redesign: rules first, one rule sentence, one outcome vocabulary

> Web only. No kernel, prompt, API or contract change. Each task is its own pull request in one stack (see Delivery).

**Goal:** the owner reads every rule the same way, in every screen. Each rule is one sentence led by Claude, with its key value set off ("Claude can send payment links up to **$300**"). It sits under one of three outcomes, Allow, Ask me first or Never, and those three words replace every other word for a rule's outcome.

**Source:** the project owner picked boards REV-RULES-B (rules first, grouped by outcome: B1 Rules, B3 Change review, B4 Setup, B5 Everywhere) and REV-RULES-C (C1 sentences at 1512, C3 at 390, C4 tools and the rules that cover them, C5/C6 the advanced details) on 2026-11-02. They are on the design canvas's In review page. The UX audit of how rules render today drove them. Where B and C differ, C's words win: "Allow", not "Automatic"; rule sentences led by Claude.

**Architecture:**
- **Data:** every screen keeps reading what it reads today: `GET /rules` (the active version's cards, the money cap, and the tools with their covering cards and `shared`), the setup state, the held items and the Safety entries.
- **Sentences:** one pure function, `ruleSentence`, builds a rule's sentence from a per-tool phrase table plus the card's own fields.
- **Display:** one design-system component, `RuleSentence`, draws it. Each screen composes those two; no screen words a rule on its own.

## Global constraints

- Design system v2 tokens only. Key values use the interface font's medium weight and `font-variant-numeric: tabular-nums`, so amounts line up. c7's type-scale change (landing about 12:30) may rename size tokens: use the token names, never pixel values.
- Copy is the boards' words. A phrase for a tool no board shows follows the boards' pattern. It's listed in the PR description as needing the owner's sign-off.
- **Out of every screen:** tool parameters (input schemas), Cedar text and the reviewer's internals. "Checked by the reviewer" moves into the advanced details (Task G).
- **Outcome words, everywhere a rule's outcome shows:**
  - `auto` → "Allow";
  - `ask` → "Ask me first";
  - `never` → "Never".

  Event words are not outcomes and stay as they are: "Waiting for your answer", "Turned down", "handled on its own" on Today, and receipts.
- Phone (390) shows the same content as desktop: nothing is dropped, and the outcome sits beside or under the sentence.
- Sentence case, no all-caps labels, no "→" on buttons (AGENTS.md, Names and copy).
- Tests first, one at a time (AGENTS.md). Run web tests through `tools/testbox/run`. Also run `web/src/app/guards.test.ts` before pushing.
- Design PR rules apply: captures at 1440×900 and 390×844 of every changed screen and story, a short recording of every changed interaction, and the owner's sign-off before merge.

## Task A: the rule sentence and the outcome words (foundation)

**Files:**
- `web/src/ds/components/OutcomeMenu/outcomeWords.ts` (and its test);
- new `web/src/owner/rules/ruleSentence.ts` and `ruleSentence.test.ts`;
- new `web/src/ds/components/RuleSentence/` (component, CSS, story, test);
- new `web/src/ds/components/EffectTags/` (component, story, test);
- `web/src/ds/index.ts`.

**Produces:**
- `OUTCOME_WORDS = { auto: 'Allow', ask: 'Ask me first', never: 'Never' }`. `OUTCOME_GROUP_WORDS` takes the same three words. `outcomePhrase(mode)` returns only the outcome word: a limit now lives in the sentence, never in the outcome.
- `type SentencePart = { text: string; key?: boolean }`.
- `ruleSentence(card: RuleCard, words: { business: BusinessTools; people?: PeopleOut | null; agents?: AgentNames }): SentencePart[]`:
  - **Lead by mode:** `auto` "Claude can ", `ask` "Claude asks you before ", `never` "Claude never ".
  - **Tool phrase** from `TOOL_PHRASES`: per built-in tool and effect group, a `can` phrase and a `before` phrase, in the boards' words. Examples:
    - `native.quote`: "send quotes from your price list", before "any discount" for the discount hold past a list-price quote rule, and "any quote" for an ask card on every quote (listed for the owner's sign-off, since no board draws it);
    - `native.book`: "book visits";
    - `native.create_payment_link`: "send payment links";
    - `native.charge_mandate`: "take agent payments";
    - `payments.create_refund`: before "any refund";
    - `native.release_document` with `native.list_charges`: "share customers' own documents and charges".
  - **A business tool (`desk.*`):** its definition's title, lowercased into "use {title}" unless the table has it.
  - **Conditions from the card's fields, as key parts:**
    - amount: " up to **$300**";
    - no discount on a quote: ", at **list price**";
    - a discount: " with up to **10%** off";
    - hours: " on **weekdays, 8:00 am to 6:00 pm**", from `formatHours`;
    - verified or the record's owner: ", once they've confirmed it's them".
- `ruleMeta(card, words)`: the tools it covers (names, with "and" before the last) and who ("Anyone", "Signed agents", "The record's owner, verified" and so on, as `whoWords` gives today).
- `holdSentence(cards)`: for auto cards with an amount limit, one Ask me first sentence that joins them. Example: "Claude asks you before payment links over **$300** or agent payments over **$20**".
- `moneyCapSentence(cents)`:
  - with a cap: "Claude asks you before any payment over **$500**, whatever the other rules say";
  - with a cap of 0: "Claude asks you before any payment".
- `ALWAYS_ON_SENTENCES`: C1's four Never rows, each with its tools and "Everyone":
  - "Claude never says it's anything but an AI";
  - "Claude never shows private data to anyone but its verified owner";
  - "Claude never sends a code anywhere but the contact on record";
  - "Claude never moves money without your rule or a signed limit".
- **`<RuleSentence parts meta outcome? changed?>`:**
  - the sentence, with key parts in `<strong>` (medium weight, tabular figures);
  - under it the meta line, with tool names set off as the owner's text (as #849 does) and " · " before who;
  - an optional outcome at the right (a dot plus the word, `OUTCOME_TONE`), stacked under the sentence on a phone.
- **`<EffectTags effects reversible>`:** small fixed tags "Money", "Can't be undone" and "Private data", as C4 draws them with the design review's v339 wording (matching the tool line and the signed N-Conn-19), 8 px after the tool title and 4 px between tags. They replace the effect sentences ("Changes something. Can be undone.") wherever a tool shows.

**Tests:**
- `ruleSentence` and `ruleMeta` on the Rivera fixture's cards give C1's exact rows, for example:
  - "Claude can send quotes from your price list, at **list price**" with meta "Quote · Anyone";
  - "Claude can send payment links up to **$300**" with meta "Payment link · Anyone".
- A business tool reads "Claude can use {title}".
- An unknown tool never shows its raw name.
- Each story renders at 1440 and 390.

## Task B: Rules (`/rules`), rules first

**Boards:** B1 and C1 (1512), C3 (390).

**What the page shows:**
- The connector sections and the jobs block become one card with three groups: Allow, Ask me first, and "Never · always on, every Desk".
- Each row is a `RuleSentence` with its meta, from the active version's cards. Jobs are rules over their business tools, so they sort into the groups like any other card.
- Ask me first also holds `holdSentence` and `moneyCapSentence`.
- Never holds `ALWAYS_ON_SENTENCES`.
- Under the card: "Anything not listed here, Claude asks you first."
- New subtitle: "What Claude can do, in your words. Each rule names the tools it covers."
- These stay: Ask Claude, its suggestion chips, "See all rules" (once) and "Start from a preset".

**Removed:** "Anything else here: ask me.", the per-connector $500 lines, the "Version N…" line and the three-column tool rows.

**Tests:** update `rules.screen.test.tsx`, `hub.test.ts` and `landing.test.ts`. Rivera's mock page gives C1's rows in C1's order. Keep Back and review-exit place restore (`reachPlace`) and the first-load wait.

## Task C: All rules (`/rules/all`), as "Your tools"

**Board:** C4.

**What the page shows:**
- Title "Your tools", subtitle "Your connectors, their tools, and the rules that cover each."
- The intro line: Each connector brings tools; each tool lists the rules that cover it. A rule shared with other tools says so once, then reads "the same rule as above".
- **One card per connector:** its icon, its name with "Built in" or "Mock", and its line.
- **Each tool:** its name, its `EffectTags` and its one-line description. Then the covering cards (`ToolRow.cards`, or `rulesForTool`), each as a `RuleSentence`.
  - An auto card with a limit adds its hold line ("Over **$300**, Claude asks you first").
  - **The design review's changes to C4 (canvas v339):** the outcome words live in the sentence, and the right side shows only the status dot, with no label.
  - **A shared rule** (`shared`, or the money cap) reads "Shared rule. Also applies to:", with the other tools' titles on the next line, set off as #849 sets titles. Under the other tools it's one quiet line, "{sentence} · Shared rule, as above".
  - **The money cap** uses C4's own wording ("Any payment over **$500** asks you first"), as a variant beside Task A's C1 sentence.
  - **Verified wording** follows C1 (", once they've confirmed it's them"). The PR flags C4's ", once verified" for the owner.
- The reviewer note and "Anything else here: ask me." go.

**Tests:** a screen test for Rivera's Payments and Stripe cards with C4's exact lines, and one that a shared rule shows in full once.

## Task D: change review and preset review

**Board:** B3.

**What the review shows:**
- One tag per row, in a left column: "Changed", "New" or "Removed".
- A Changed row shows Before and After as `RuleSentence`s, each with its outcome at the right, under a red (Before) or green (After) rule line from the tokens. New shows After alone, and Removed shows Before alone.
- Under the card: "Checked against the always-on rules and your other rules before you confirm."
- The buttons stay "Confirm change" and "Keep my rules".
- This applies to Ask Claude's draft review (`RuleDraftReview`, `changeRows.ts`) and the preset review.

**Removed:** the four "Changed" tags per row, the repeated tool titles and the meta and tier blocks.

**Tests:** `changeRows.test.ts` and `drafts.screen.test.tsx` for a changed, a new and a removed row. A shared-rule row names its tools once.

## Task E: setup's Tools and Your rules

**Boards:** the REV-SETUP boards at canvas v343, which the owner signed. They refine B4, and where this section and the boards differ, the boards win:
- **Connector review:** its box is "The rules that will cover them", with one rule line per tool, so private data never sits beside "Anyone".
- **Your rules:** Refund and a See charges row move under Ask me first. Never holds only the four always-on rules, headed "Never · always on, on every Desk".
- **Real situations:** the retainer reason reads "Claude asks you before any payment over **$250**".

**Connector review** ("Review what Claude could do with Payments"):
- Each tool shows its name, its `EffectTags` and its line.
- Then "The rule that will cover them": a `RuleSentence` for the card setup will start them on, with its outcome.
- Then "Until you set a limit in Rules, every payment asks you first." on a money connector.
- **Job review:** its tool row takes the same rule box.

**Your rules step:**
- The groups take the three words.
- Rows become `RuleSentence`s.
- The banner stays.

**Real situations and the safety check:** each outcome reads Allow, Ask me first or Never ("Does it", "Asks you" and "Blocked" go). Their prose stays.

**Tests:** setup screen tests for the connector review, a job review and the Your rules groups.

## Task E2: setup's situations, safety check and the chat's job card

**Boards:** canvas v343. The owner signed these three additions on 2026-11-02:
1. **Real situations:** each reason line becomes the rule's Claude-led sentence, with `RuleSentence` parts and the key value at weight 520 in tabular figures. The outcome label above it stays, and so do the situation's title and who.
2. **Safety check:** each row drops its "Action checkpoint" line, and nothing replaces it. Outcomes read Never and Ask me first.
3. **The chat's job proposal card:** a box with a 1 px card line and the control radius, inside the card's indent. It sits after the card's Who, Uses and Next for you rows, and before Set it up and Not now.
   - **Label:** "The rule it will start under" (caption type, secondary text).
   - **Content:** the job's `RuleSentence`, its tools · who line, and its outcome at the right. The outcome comes from the job's autonomy: auto → Allow, ask → Ask me first.

**Tests:** setup screen tests for a situation's sentence, a safety check row without the label, and the job card's rule box for an auto job and an ask job.

## Task F: held cards, Safety and the agents page

**Board:** B5.

**The owner's answers:**
- Conversations' decision receipt starts "Allowed." where it said "Automatic.". The other event words stay.
- The agents page's outcome per ability is Task H, not this task.

**Held card**, on Today's Needs you and Conversations' held card:
- A "Your rule" box: the `RuleSentence` of the rule that held it, with its outcome.
- Which rule: the active card whose `reason` matches the item's `held_by`. Past an automatic rule's limit (`held_by` null with an amount), it's the auto card whose limit it passed, shown with its hold line.
- With neither, there's no box.
- The box replaces "Held by your rule: …", working on top of #865's change.

**Safety:**
- A turned-down entry whose rule the page can name (an always-on rule by its key, or an owner card by ID) shows "The rule that turned it down" with that `RuleSentence` and Never.
- Others are unchanged.

**Agents page:** any outcome word the web draws reads as the three words. The ability lines come from the kernel and are out of scope, so list what B5 draws that needs data the API doesn't send. That's a follow-up for the owner, not built.

**Tests:** screen tests for a held quote with a discount (B5's "Any discount" box), a hold past a limit and a Safety turned-down entry.

## Task G: the details disclosure

**Board:** REV-RULES-D in its shipping state (canvas v339), which the owner signed and which replaces C5 and C6. It leaves out Parameters and the compiled Cedar until the kernel can read them.

**What it shows:**
- **The Details button:** every tool (Your tools) and every rule (Rules) ends with a quiet "Details" button with a chevron, in control type with secondary text and `aria-expanded`. On a rule it sits after the status dot. Expanded, the chevron turns down, the button gets the hover fill, and a panel opens under the row: surface background, card line, control radius.
- **Tool panel:** a label and value list, with a 104 px label column in meta type.
  - Name: trace mono, the tool's ID.
  - Source.
  - Claude sees: its confirmed description.
  - Effects: "Charges money · Can't be undone".
  - Status.
  - Pinned: "Matches its pin" with a handled dot, or "Needs your review".
  - Then a code block, "As your Desk lists it": the `ToolRow` fields as JSON.
- **Rule panel:**
  - Rule: the card ID, in mono.
  - Version: "7, proved against the always-on rules".
  - Policy hash: `cedar_sha256`, in mono, shortened.
  - Then a code block, "The rule as you set it": the `RuleCard` as JSON.
- **Code blocks:**
  - **Layout:** pretty JSON with a 2-space indent, in `<pre class="cd-type-trace">` on the secondary fill, with the control radius, 12 px padding, `white-space: pre`, horizontal scroll and `font-variant-ligatures: none`.
  - **Tint:** keys in accent blue, strings in primary text, numbers and booleans in secondary, punctuation in tertiary. No status colours.
  - **Label row:** the label in meta type, and a ghost "Copy" button that reuses CopyField's "Copied.".
- **Never shown:** input schemas, Cedar text, or empty "coming later" blocks.

**Tests:**
- It's collapsed by default, and opens and closes with the keyboard.
- The JSON matches the card and the row, and Copy copies it.
- No input schema or Cedar text is anywhere in the page.

## Task H: the agents page's outcome per ability (kernel, public API and web)

The owner asked for this today, kept minimal:
- **Words:** each ability the public agents page lists shows only its outcome: "Allowed", "Asks first" or "Never" (in Spanish "Permitido", "Pregunta primero", "Nunca"). It names nobody, and carries no limit, amount or private rule data.
- **Where it's computed:** the kernel's public card, from the active version's anyone cards and the baseline, as a closed key. Person- and agent-key-scoped cards never count and never show.
- **How it ships:** on its own branch from the integration branch, rebased onto `main` once the integration PR lands. It keeps both review seats and gets an eval pass of its own this afternoon.

## Delivery

- **One stack of pull requests**, bottom to top: A, C, B, D, E, E2, F. G sits on top of B and C once those are up. H is separate, as above.
- **Parallel work:** B to F start in their own worktrees from A's head. Each rebases onto the PR below it before pushing.
- **Reviews:** each task gets a task review (Sol). Each web-only PR then gets the Sol seat alone (owner, 2026-11-02), and H gets both seats.
- **Merge:** the stack merges together once every PR is green, panel-clean and signed by the owner.

## Review ledger

(empty)
