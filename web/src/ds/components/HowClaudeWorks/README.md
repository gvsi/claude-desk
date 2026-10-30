# HowClaudeWorks

`HowClaudeWorks` is the card at the top of the Rules page that says how Claude works on this Desk, as one of two presets or the owner's own rules, with the money limit under it.

## When to use

- At the top of the Rules page, under its `PageHeader` (N-Conn-17-Mode, N-Conn-22-Phone-Mode), in place of a bare `SegmentedControl` and limit line.
- With `MoneyLimit` as its `children`.

## What it shows

- A `Card` (`section`, named "How Claude works"), padded 16 px.
- "How Claude works" as its `h2` (`.cd-type-section`), with the caption for `preset` 2 px under it (`PRESET_CAPTIONS`, `.cd-type-meta`, `text-secondary`):
  - Ask me first: "Claude asks you before it quotes, books, shares a document or takes a payment. It still finds open times, saves leads and confirms who people are."
  - Automatic: "Claude quotes at list price, books weekdays in your hours and sends verified customers their own documents. Payments ask you first."
  - Custom: "Your own rules, tool by tool. Change any of them below."
- At the right, level with the title, a `SegmentedControl` named "How Claude works" with `PRESET_WORDS` ("Ask me first", "Automatic", "Custom"), at `preset`.
- `children` (the money limit) 16 px under a hairline, 16 px under the caption.
- It lays out by its own width: under 640 px (a phone) the card pads 14 px, the switch sits 12 px under the caption at its own width, and the hairline has 12 px on each side. Nothing scrolls sideways at 390 px.

## Behavior

- Choosing "Ask me first" or "Automatic" calls `onPreset` once with `ask_first` or `auto`. The screen drafts the preset and opens its review on its own page (`ChangeReview` under "Switch to Ask me first" or "Switch to Automatic", N-Conn-18-Mode-Review), which says that open payment links the new rules don't allow will be cancelled (`cancelsLinks`).
- The switch keeps showing `preset`, the active rules version's, until the screen passes a new one, after the owner confirms.
- One pick at a time: after a pick, the switch takes no other until the screen passes a new `preset` or its draft (`disabled`) has come and gone, so a double click drafts once.
- Choosing "Custom" calls nothing. Custom is a state, "your rules differ from both presets", not an action: the web app shows it when `RulesView.preset` is `custom`, which it becomes on its own when any tool's rule changes. Choosing the preset already shown calls nothing either.
- `disabled` (a draft in flight) disables the switch: `aria-disabled` on it and each option, so focus stays put, and clicks and keys do nothing. The screen passes `disabled` to `MoneyLimit` too.
- Tool rules stay editable under a preset; changing one makes the rules Custom.

## What the consumer provides

- `preset` from the active rules version (`RulesView.preset`).
- `onPreset`, which drafts the preset (`draftPreset`) and opens its review page.
- `disabled` while that draft is in flight.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `preset` | `RulesPreset` | Required. `ask_first`, `auto` or `custom`. |
| `onPreset` | `(preset: 'ask_first' \| 'auto') => void` | Required. Called once per pick. |
| `disabled` | `boolean` | A draft in flight: the switch takes no pick. |
| `children` | `ReactNode` | The money limit, under a hairline. |

## Words

`PRESET_CAPTIONS` (in `OutcomeMenu/outcomeWords.ts`, beside `PRESET_WORDS`) describe the master plan's presets (`desk.presets.PRESETS`). `preset_captions_match_the_presets` pins each caption to a copy of those presets' cards, so changing a preset fails it until the caption follows.
