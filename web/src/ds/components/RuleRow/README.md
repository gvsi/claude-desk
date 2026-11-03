# RuleRow

`RuleRow` is one rule under a tool: its reason, the words for what it enforces, a line when it is shared, and its outcome.

## When to use

- Inside a `ToolRulesCard`, one row per rule that governs the tool (`rulesForTool`), on a connector's page and on a tool's page.
- The outcome is a menu only when the owner can change it from here (`onChangeOutcome`); the screen drafts the change and shows it in `ChangeReview` before anything applies.

## What it shows

- `rule.reason` in `.cd-type-body`, `text-primary`: the card's own sentence.
- Under it, the `words` joined by " · " in `.cd-type-meta`, `text-secondary`: "Anyone · Up to $300 · Checked by the reviewer". They are the screen's code-rendered words for the card (`ruleWords`); the design system formats none.
- `shared` marks a rule on an effect group, such as `effect:charge`: the `shared` icon (`aria-hidden`) and "Shared rule. {lead}:" in `.cd-type-caption`, with `{titles}` on a line of its own under those words (not under the icon), where `lead` is the screen's words for its group ("Applies to every tool that charges money") and `titles` the tools it covers ("Payment link", "Charge within a signed limit"), so it reads "Shared rule. Applies to every tool that charges money:" over "Payment link and Charge within a signed limit", with no full stop after the titles. Covering none, it reads "Shared rule. {lead}.". A tool's title is its own words (a business's job from setup), not the app's, so each one is its own `data-copy="user"` span (`ToolTitleList`), set off as user text (`.cd-user-name`: text-primary at weight 520, isolated for text direction) and starting its line, never mid-line in the app's words; the joining ", " and " and " stay in the caption's own colour and weight. The screen shows a shared rule under every tool it governs; changing it from any of them changes the one rule.
- At the right, `OutcomeMenu` with the reason as its `label`: "Allow", "Ask me first" or "Never". `limit` is passed on but no longer shown.
- It lays out by its own width (a container query): under 640 px, on a phone or in a side panel, the outcome sits on its own line under the words, lined up with them, as the first phone Rules board (archived) drew it. At 320 px a rule with a $10,000 limit fits with no sideways scroll.

## Types

`RuleWord = { field: 'who' | 'limits' | 'hours' | 'review'; text: string }`: one part of what a card enforces, in the consumer's words. `ChangeReview` uses the field to tag what changed.

`ruleWordsLine(words)` joins them as the row shows them, blank ones left out, with " · "; `PersonRules` shows the same line.

`ToolTitles = { titles: readonly string[] }` names tools by their titles inside the screen's words, and `ToolTitleList({ titles })` (in `ToolTitles.tsx`, both exported) draws them as one list, "Quote", "Quote and Refund", "Quote, Book a visit and Refund": the joining words are the screen's, and each title is its own `data-copy="user"` span with `.cd-user-name`. The list starts its line wherever it is drawn. `RuleRow`'s `shared` and `ChangeReview`'s titles and targets use it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `rule` | `Pick<RuleCard, 'card_id' \| 'mode' \| 'reason'>` | Required. |
| `words` | `RuleWord[]` | Required; empty words leave no line. |
| `limit` | `string` | The formatted amount limit of an auto card. |
| `shared` | `{ lead: string; titles: readonly string[] }` | For a rule on an effect group: its group's words and the titles of the tools it covers. |
| `onChangeOutcome` | `(mode: RuleMode) => void` | Makes the outcome a menu. |
| `fade` | `boolean` | Where a confirmed change landed (a `ToolRulesCard` with `landed`): when its reason or words change, the old fade out over the new as they fade in, on `motion-base`, only the new ones read; at once under reduced motion. |
