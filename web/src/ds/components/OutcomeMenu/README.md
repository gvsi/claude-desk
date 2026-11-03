# OutcomeMenu

`OutcomeMenu` is a rule's outcome, its dot and its words, and, when the owner can change it, a menu button that offers the three outcomes.

## When to use

- At the right of every `RuleRow`, and on each tool of a `ConnectorReview` (Task 3).
- Without `onChange` where the outcome is only shown: a read-only rule, a review of a proved change.
- The owner's pick never applies here: the screen drafts the change, proves it and shows it in `ChangeReview`, and the button keeps showing `value` until the screen passes a new one.

## What it shows

- The outcome's dot (`OUTCOME_TONE`: Allow handled, Ask me first held, Never refused, `aria-hidden`) beside `outcomePhrase(value)`. Status is never shown by the dot alone.
- `limit` is no longer shown: the outcome is its word alone, and an auto card's limit lives in its rule's sentence (`RuleSentence`: "Claude can send payment links up to $300").
- Read-only: the words in `.cd-type-meta`.
- With `onChange`: a 32 px (`size-control`) button outlined in `line-control` (`line-control-hover` on hover and while open), radius 8 px, no fill, in `.cd-type-control`: the dot, the phrase and `chevron-down`. Neither form keeps its width: on a narrow line a long phrase wraps, inside the button or on its own lines, so nothing scrolls sideways.
- The button is named "{phrase}. Change the outcome of: {label}" (`label` is the rule's reason), with `aria-haspopup="menu"` and `aria-expanded`.
- Its menu is a popover 6 px under it, aligned to its right edge, on `bg-surface` with a `line-card` border, `radius-card` and `shadow-dialog`: three `menuitemradio`s, "Allow", "Ask me first" and "Never", the current one checked (`aria-checked`, with a check mark).

## Keyboard and pointer

As on `ApprovalCard`'s menus:

- Enter, Space, Down or a click opens it on the first item; Up opens it on the last.
- Down and Up move and wrap, Home and End jump. Enter, Space or a click chooses. A held key never chooses: the Enter that opened the menu is ignored until it comes up.
- Escape or Tab closes it and gives focus back to the button. Escape on the button of an open menu closes it too.
- A press outside, or focus leaving the button and its menu, closes it and leaves focus where it went.
- Picking another outcome calls `onChange` once and closes the menu, focus on the button; picking the current one only closes it.
- One outcome menu is open on the page at a time.

## Words

`outcomeWords.ts`, also exported:

- `RuleMode = RuleCard['mode']`.
- `OUTCOME_WORDS` (`satisfies Record<RuleMode, string>`): `auto` "Allow", `ask` "Ask me first", `never` "Never". Used wherever a rule's outcome shows.
- `OUTCOME_TONE`: `auto` handled, `ask` held, `never` refused.
- `OUTCOME_GROUP_WORDS` (`satisfies Record<RuleMode, string>`): the same three words as `OUTCOME_WORDS`, the headings of the setup's groups of rules by outcome (`OutcomeGroups`), each beside its `OUTCOME_TONE` dot.
- `outcomePhrase(mode)`: the outcome's word alone.
  - `RulesPreset = 'ask_first' | 'auto'`, the master plan's two presets. There is no Custom mode: the Desk's rules are its own, whichever preset they started from.
  - `PRESET_WORDS`, in that order, each with its `label` and its `description`, as the signed presets board words them: "Ask me first" ("Quotes, bookings, documents and payments wait for your answer.") and "Recommended rules" ("Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first."). The Rules page's "Start from a preset" menu (`PresetMenu`) offers them. The descriptions describe the master plan's preset cards (`desk.presets.PRESETS`); `preset_descriptions_match_the_presets` checks each claim against those cards, read from the generated presets export, `web/src/api/presets.gen.json`, and is skipped until that export exists.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | What the outcome is for, in the button's name: the rule's reason. |
| `value` | `RuleMode` | The outcome the screen shows. |
| `limit` | `string` | The formatted amount limit of an auto card. |
| `onChange` | `(mode: RuleMode) => void` | Makes it a menu. |
| `disabled` | `boolean` | The button can't be pressed. |
