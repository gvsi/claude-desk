# ChangeReview

`ChangeReview` shows a proved change before it applies: what each rule enforces before and after, the checks the change passed, and one confirm that works only when they passed.

## When to use

- After the owner drafts a rule change (from an outcome menu, the composer or the Ask Claude panel), turns a connector on, or turns a changed tool back on (N-Conn-10-GCal-Confirm, N-Conn-11b-Payments-Review). The screen builds the rows from `ruleDiff` and the tools it turns on, and the checks from the proof report (Plan 04's `checkStatus`).
- After the owner picks a preset from `PresetMenu` (N-Conn-18-Preset-Review), on its own page under `PageHeader` with the preset's name ("Ask me first", "Recommended rules"), the same page shape as N-Conn-10. The rows come from `reviewChanges` (below), so every review reads the same way. `RecommendedRules` shows rules the preset replaces, rules it leaves to the default ask because it covers only part of them, an added rule, and two it keeps, which don't show.
- After the owner changes the payment limit (N-Conn-20-Ceiling-Review), under `LimitChange`, with `hasOtherChanges`.
- Not for turning a connector off: that only narrows and applies at once, so it has a plain confirm (`ConnectionPanel`, Task 3).
- Renamed from `RuleChangeDiff`.

## What it shows

The app's draft and preset reviews pass `sentenceReview` (B3). Each side supplies `sentence: { parts, meta }` from the shared `ruleSentence`, `ruleMeta` and `ruleQualifiers` wording. A row has one left-column tag, "Changed", "New" or "Removed". Changed shows Before and After; New shows After alone; Removed shows Before alone. A tool activation keeps its "Turned on" tag and its tool title above After, set off as user text; its sentence meta names only that tool, even under a shared rule. Each side is a `RuleSentence` styled as the Rules page's rule cell: the sentence in primary text, then a secondary line with its tools (the review has no tool heading above it), who it is for and its qualifiers ("Payment link · Anyone · Checked by the reviewer · Over $300, it asks you first"), and its outcome, beside the refused or handled bar. Rule changes name tools once per side and keep their user-text treatment, including shared rules whose coverage changes. On phones the tag keeps its column and the outcome stacks under the sentence's meta. A successful check is the line "Checked against the always-on rules and your other rules before you confirm." below the card. Failed and unavailable checks retain their notices and disabled confirm.

Without `sentenceReview`, the existing field review remains available to standalone design-system consumers:

- A "Changes" card (`section`), a row per change under a hairline:
  - A tag in words in an outlined pill: "Added", "Removed", "Changed" or "Turned on".
  - `title` in weight 520, then a meta line: the `connector`'s name with no "Built in" and, for an app, its Mock badge (`ConnectorName`, so a mock is never named without "Mock"), then for an added, removed or turned-on rule its `words`, joined by " · ". The meta line never says what the rule applies to: the title names it, and a side's own line says it when it isn't the title. So a row names its tools once, as a changed row does, and no title sits mid-line. A rule for one person leads its words with who it is for ("Dana Whitfield, verified · Up to $50"), so the row reads as that person's rule.
  - With `shared`, the meta line says "Shared rule" right after the connector's name, in the same join and with no icon, on every kind of row: "Payments · Shared rule" on a changed row (N-Conn-18-Preset-Review), and before the words on the others. The words are English only, as `ChangeReview` takes no language. The screen sets `shared` by one rule:
    - A rule on a group of tools (an effect card, such as Alex Kim's assistant's rule on every tool that charges money) sets `shared: true`. Its `connector` is the one connector all those tools share (Payments, for Payment link and Charge within a signed limit), otherwise none, and then "Shared rule" leads the line ("Shared rule · The record's owner, verified" under the title "Every tool that touches private data").
    - A row whose rule moves between one tool and a group of tools, such as a rule widened from Payment link to every tool that charges money, leaves `shared` unset: the sides' `appliesTo` already show the move (`WidenScope`).
  - Then the rule's side, as a group named by its label: "After" for a rule added or a tool turned on, "Before" for a rule removed. A side is its label in caption type, what its rule applies to (`appliesTo`, on its own line; on a row with one side, only when it isn't the row's title), its words, its `reason`, and at the right of its first line the outcome with its dot, `outcomePhrase(mode)`. It sits beside a 2 px bar: the refused tone for Before, what goes, and the handled tone for After, what applies (N-Conn-10-GCal-Confirm). The words stay neutral; the bar is the one status color, beside the word that says the same. On a narrow screen the rows wrap: at 320 px, a rule with a $10,000 limit fits with no sideways scroll.
  - A `changed` row shows its connector, then a "Before" and an "After" side. On the After side each line whose field is in `changed` is in weight 520 and tagged "Changed" in words: the target line for `applies_to`, the words line for `who`, `limits`, `hours` and `review`, the reason for `reason`, and the outcome for `mode` (`OutcomeChanged`). Status is never shown by color alone.
  - Pass `appliesTo` on both sides whenever a rule's target can change, such as a rule widened from Payment link to every tool that charges money. If `changed` has `applies_to` and a side has no `appliesTo`, the title is tagged "Changed" instead, so the change is never unmarked.
  - An added or turned-on row shows its after side; a removed row the rule it removes.
- No rows: "No rules change." and no confirm button. With `hasOtherChanges` (the draft changes something the screen shows above it, such as the money limit) it reads "Your rules stay the same." instead, and the controls stay.
- With `cancelsLinks`, the fixed line "Open payment links I made on my own that the new rules don't allow will be cancelled." in secondary body text, between the checks and the buttons. Applying a preset or a lower payment limit cancels the open auto-allowed payment links the new rules no longer allow (master "Cancellation at activation"); a link still inside the new rules stays payable. The screen sets it for a preset switch or a lowered limit, never for a raise; the design system never decides it.
- A card for the checks, headed by `checks.status`: "Checked before you confirm", "This change can't be applied" or "Rules can't be checked right now", with `checks.lines` as a list in secondary meta: the screen's words from the proof report.
- The primary `confirmLabel` ("Confirm change" by default; "Confirm and turn on") is enabled only when the status is `checked`. One click calls `onConfirm` once and waits, busy, until `pending` has come and gone, an error is delivered, the promise `onConfirm` returned rejects, or `onConfirm` throws (`useSendOnce`, as every send-once button). An error is delivered each time one appears or another replaces it, so a confirm that fails with the same words as last time (the screen clears its error when a confirm starts) can be tried again; clearing an error releases nothing. While it waits, and while `pending`, it keeps its label under the busy spinner, at the same width, with `aria-busy`; the secondary button waits beside it without a spinner.
- The secondary `cancelLabel` ("Keep my rules" by default; "Back") calls `onCancel`; it waits while a confirm is in flight.
- `error` shows the screen's message in an error `Notice` (an alert), and confirm works again.

## Types

- `RuleTarget = ToolTitles | string`: what a rule is about. Tools are named by their titles, `{ titles: ['Payment link', 'Refund'] }`, drawn "Payment link and Refund" with each title its own `data-copy="user"` span (`ToolTitleList`), since a tool's title is its own words (a business's job from setup), not the app's. Each is set off as user text (`.cd-user-name`, text-primary at weight 520, isolated for text direction) and starts its line: a row's title and a side's target line. A string is the screen's own words for a group of tools, "Every tool that charges money", drawn as it is.
- `ChangeSide = { sentence?: Pick<RuleSentenceProps, 'parts' | 'meta'>; appliesTo?: RuleTarget; mode: RuleMode; limit?: string; reason: string; words: RuleWord[] }`. `appliesTo` is what the rule covers (`{ titles: ['Payment link'] }`, "Every tool that charges money"); the design system formats none.
- `ChangeRowView = { key: string; change: 'added' | 'removed' | 'changed' | 'turned_on'; title: RuleTarget; connector?: ConnectorView; shared?: boolean; before: ChangeSide | null; after: ChangeSide | null; changed: RuleField[] }`. `shared` marks a rule on a group of tools, by the rule above; the screen decides it, as `RuleRow`'s `shared` does.

## Diffing rules: `ruleDiff`

`ruleDiff(before: RuleCard[], after: RuleCard[]): RuleDiffRow[]` (in `ruleDiff.ts`, also exported) reports which of the owner's cards a draft adds, removes or changes, and in which fields. It decides nothing.

- Rows by `card_id`, in `card_id` order; `is_default` cards (the compiler's, re-derived on every draft) are skipped; unchanged cards are left out.
- `RuleDiffRow = { cardId; change: 'added' | 'removed' | 'changed'; before: RuleCard | null; after: RuleCard | null; fields: RuleField[] }`.
- `RuleField = 'applies_to' | 'mode' | 'who' | 'limits' | 'hours' | 'review' | 'reason'`, in that order; `person_id` and `agent_key_id` count as `who`, `max_amount_cents` and `max_discount_bp` as `limits`. An absent optional field equals its contract default, so the same reason with a new limit is a `changed` row with `['limits']`.

## Building the rows: `reviewChanges`

`reviewChanges(before: RuleCard[], after: RuleCard[], effectsOf: (tool) => Effect[]): ReviewChange[]` (in `reviewChanges.ts`, also exported) pairs the owner's cards with the draft's, so a preset's review, a chat draft and a tool's draft build their rows the same way. It decides no outcome; the screen gives each side its words.

- A card the draft keeps by its `card_id` is a `changed` row where `ruleDiff` finds it different.
- A card the draft drops goes to the draft's card that covers its whole scope: of the cards that govern its target in the draft (`rulesForTool` for a tool, most specific first; the cards on the same effect for an effect card), the first whose people include the dropped card's (`containsScope`) and whose hours hold all of its hours. It is a `changed` row tagged where `ruleDiff` finds the two different, or no row when they differ only in their id.
- With no such card, the dropped card falls to the default ask (`after: null`, the screen's default side), tagged `['mode']` only when its outcome changes. A rule the draft covers only in part, such as weekday bookings from 8:00 am to 6:00 pm under a 9-to-5 rule, falls to it too, so no row claims "Automatic" for times that will ask.
- A draft card no dropped card goes to is an `added` row; one a dropped card goes to shows as that row's After instead.
- It returns rows in `before`'s order, then the added cards in `after`'s; `is_default` cards never show. The screen then orders every row by its tool's place (by connector, by tool within one) in one stable pass, so an added rule follows the changed rows of its own tool: a weekday booking rule a preset adds sits right after the booking rules it replaces, not after every changed row.
- `ReviewChange = { change: 'changed' | 'added'; before: RuleCard | null; after: RuleCard | null; fields: RuleField[] }`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `rows` | `ChangeRowView[]` | Required. |
| `sentenceReview` | `boolean` | B3's one sentence per side and one change tag per row. Each side must supply `sentence`. |
| `checks` | `{ status: 'checked' \| 'failed' \| 'unavailable'; lines: string[] }` | Required. |
| `confirmLabel` | `string` | "Confirm change" by default. |
| `cancelLabel` | `string` | "Keep my rules" by default. |
| `onConfirm` | `() => void \| Promise<unknown>` | Called once per click; a rejection lets the owner confirm again. |
| `onCancel` | `() => void` | Required. |
| `hasOtherChanges` | `boolean` | Keeps the controls with no rows. |
| `cancelsLinks` | `boolean` | Shows the line about cancelled payment links above the buttons. |
| `pending` | `boolean` | The confirm is in flight: its button keeps its label under the busy spinner. |
| `error` | `string` | The screen's message; confirm works again. |
