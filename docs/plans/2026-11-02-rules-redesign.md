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
    - `native.quote`: "send quotes from your price list", before "any discount";
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
- **`<EffectTags effects reversible>`:** small fixed tags "Money", "Can't undo" and "Private data", as C4 draws them. They replace the effect sentences ("Changes something. Can be undone.") wherever a tool shows.

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
- **Each tool:** its name, its `EffectTags` and its one-line description. Then the covering cards (`ToolRow.cards`, or `rulesForTool`), each as a `RuleSentence` with its outcome at the right.
  - An auto card with a limit adds its hold line ("Over **$300**, Claude asks you first").
  - A shared rule (`shared`, or the money cap) shows in full at its first tool with "Also covers …", and later as "… · the same rule as above".
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

**Board:** B4.

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

## Task F: held cards, Safety and the agents page

**Board:** B5.

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

## Task G: the advanced details

**Boards:** C5 and C6. Build them last, from the final boards.

**What it shows:**
- A disclosure under each tool (Your tools) and each rule (Rules), collapsed by default.
- For a rule: the card's own fields as pretty-printed JSON (`mode`, `applies_to`, `who`, limits, `hours`, `review` and `reason`), and "Checked by the reviewer" when `review` is set.
- For a tool: its name, effects, reversible and source.
- Never shown: input schemas, Cedar text or anything the boards leave out.
- **The component:** `<AdvancedDetails>` in the design system, keyboard operable, with `aria-expanded`.

**Tests:** collapsed by default, it opens and closes with the keyboard, and the JSON matches the card.

## Delivery

- **One stack of pull requests**, bottom to top: A, C, B, D, E, F. G sits on top of B and C once those are up.
- **Parallel work:** B to F start in their own worktrees from A's head as soon as A's review is clean. Each rebases onto the PR below it before pushing.
- **Reviews:** each task gets a task review (Sol), then the two-seat panel on its PR.
- **Merge:** the stack merges together once every PR is green, panel-clean and signed by the owner.

## Review ledger

(empty)
