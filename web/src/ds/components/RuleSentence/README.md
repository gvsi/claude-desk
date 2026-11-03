# RuleSentence

`RuleSentence` is one rule as a sentence led by Claude, with its key values set off, the tools it covers and who under it, and its outcome.

## When to use

- Wherever a rule shows: Rules' groups, Your tools, a change's review, setup, a held card's "Your rule" and Safety. No screen words a rule on its own: the owner app's `ruleSentence` builds `parts` from the card and `ruleMeta` its `meta`.

## What it shows

- The sentence in `.cd-type-body`, `text-secondary`: "Claude can send payment links up to **$300**". Each `key` part is a `<strong>` in `text-primary` at weight 520 with `font-variant-numeric: tabular-nums`, so amounts line up. A `user` part is a tool's own title inside the sentence ("Claude can use emergency callback"): its own `data-copy="user"` span, isolated for text direction, never joined into the app's words.
- Under it, with `meta`, the line in `.cd-type-meta`, `text-secondary`: the tools it covers, each its own user-text title (`ToolTitleList`: "Find open times and Book a visit"), or the screen's own words for a group of tools ("Every tool", drawn in the same weight but not marked as user text); then " · " and who ("Anyone", "The record's owner, verified").
- With `outcome`, at the right of the sentence, the outcome's dot (`OUTCOME_TONE`, `aria-hidden`) beside its word (`OUTCOME_WORDS`: Allow, Ask me first, Never) in `.cd-type-meta`, `text-primary`. It never shows a limit: the limit is in the sentence.
- With `changed`, a 2 px line at its left: the refused tone for `before`, the rule as it was, and the handled tone for `after`, the rule as it will be, as `ChangeReview`'s sides draw them.
- It lays out by its own width (a container query): under 480 px, on a phone, the outcome sits on its own line under the meta line, lined up with the sentence, as REV-RULES-C3 draws it. Nothing is dropped at any width.

## Types

- `SentencePart = { text: string; key?: boolean; user?: boolean }`.
- `RuleMeta = { tools: RuleTarget; who: string }`, where `RuleTarget` is `ChangeReview`'s: `{ titles }` or the screen's words for a group.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `parts` | `readonly SentencePart[]` | Required. The sentence, in the screen's words. |
| `meta` | `RuleMeta` | The line under it. Without it, the sentence stands alone (Your tools' rows). |
| `outcome` | `RuleMode` | The outcome at the right. |
| `changed` | `'before' \| 'after'` | A side of a change. |
