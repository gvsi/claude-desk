# PresetMenu

`PresetMenu` is the Rules page's "Start from a preset" menu: a menu button that offers the two presets, each with a line on what it does.

## When to use

- In the Rules page's `PageHeader` actions (N-Conn-17-Presets, N-Conn-22-Phone-Presets).
- Picking a preset only asks the screen to draft it. The screen opens the review on its own page, titled with the preset's name (`ChangeReview` with `cancelsLinks`, N-Conn-18-Preset-Review), and nothing changes until the owner confirms.

## What it shows

- A secondary `Button` at the main height (40 px), "Start from a preset", with the menu button's chevron, `aria-haspopup="menu"` and `aria-expanded`.
- Its menu: a popover 6 px under it, 360 px wide, its right edge on the button's, on `bg-surface` with a `line-card` border, `radius-card` and `shadow-dialog`. It holds two `menuitem`s from `PRESET_ITEMS`, in order. Each has its title (`.cd-type-control`) over its line (`.cd-type-caption`, `text-secondary`); it is named by the title and described by the line.
  - "Ask me first": "Quotes, bookings, documents and payments wait for your answer."
  - "Recommended rules": "Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first."
- No item is checked or current: the Desk's rules are its own, whichever preset they started from.
- Under 640 px of the window (a phone) the button fills its line, its words at the left and the chevron at the right, and the menu opens under it at the same width. The consumer gives it the whole line.

## Keyboard and pointer

As the approval answers' menus:

- Enter, Down or a click opens it on the first item; Up opens it on the last.
- Down and Up move and wrap, and Home and End jump.
- Enter, Space or a click chooses. A held key never chooses: the Enter that opened the menu is ignored until it comes up.
- Escape or Tab closes it and gives focus back to the button. A press outside, or focus leaving the button and its menu, closes it.
- Choosing an item closes the menu, puts focus back on the button and calls `onPick` once with its preset (`ask_first` or `auto`).
- While `pending` (the picked preset's draft in flight), the button keeps its label under the busy spinner and the menu stays shut.

## Words

`PRESET_ITEMS` (in `OutcomeMenu/outcomeWords.ts`) holds each preset's title and description. The descriptions describe the master plan's preset cards (`desk.presets.PRESETS`). `outcomeWords.test.ts` checks each claim against those cards, read from their generated export (`web/src/api/presets.gen.json`), and is skipped until that export exists.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `onPick` | `(preset: 'ask_first' \| 'auto') => void` | Required. Called once per pick. |
| `pending` | `boolean` | The picked preset's draft is in flight: busy, and the menu stays shut. |
