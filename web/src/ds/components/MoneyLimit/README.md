# MoneyLimit

`MoneyLimit` shows the most Claude takes or pays out in one payment without asking, and lets the owner change it through a reviewed draft.

## When to use

- Inside `HowClaudeWorks`, as its `children`, at the top of the Rules page (N-Conn-17-Mode, N-Conn-19-Money-Cap, N-Conn-22-Phone-Mode).
- The limit is the active rules version's money cap (master "Money cap"). It changes only through a draft the owner confirms on its review page (`LimitChange` above `ChangeReview`, N-Conn-20-Money-Cap-Review).

## What it shows

- Reading:
  - `line` in body type at weight 520 ("Most I take without asking: $500", or "Nothing: every charge and payout asks you" at 0), then `help` 2 px under it in `.cd-type-meta`, `text-secondary`.
  - A secondary "Change" at the right, centered on them, which calls `onEdit()`.
- Editing, in a form:
  - A `TextField` named by `label` ("Most I take without asking, in dollars" by default), at most 360 px wide, holding `value` exactly as typed, with `hint` under it and, when given, `error` (the field is then `aria-invalid` and the error is announced).
  - 12 px under it, a primary "Review change" and a secondary "Cancel".
- Opening the field moves focus into it; closing it moves focus back to "Change". Only a change of `editing` moves focus, never the first render.
- It lays out by its own width: under 640 px (a phone) "Change" sits under the help at its own width, 10 px under it.

## Behavior

- Typing calls `onChange` with the raw text, every time. Nothing here parses, trims, checks or formats it.
- "Review change", or Enter in the field, calls `onReview()` with nothing in it: the screen checks the value it holds. When the value is out of range the screen passes `error` ("No single payment can be above $10,000.") and sends nothing; otherwise it drafts the change and opens its review.
- "Cancel" calls `onCancel()`; the screen closes the field.
- `disabled` (a draft in flight) puts every button in its waiting state (`aria-disabled`, focus kept), and nothing is sent.

## What the consumer provides

- Every string in its own words: the limit and the hint with the amount formatted by the web app ("Now $500."), and the error from its own check of the value (whole dollars, 0 to 10,000, the per-payment limit).
- The help copy: "The most Claude takes or pays out in one payment without asking you. Above it, Claude always asks."

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `line` | `string` | Required. The limit in words. |
| `help` | `string` | Required. What the limit means. |
| `editing` | `boolean` | Required. The field is open. |
| `label` | `string` | The field's label; "Most I take without asking, in dollars" by default. |
| `value` | `string` | Required. What the owner typed. |
| `hint` | `string` | Required. The line under the field. |
| `error` | `string` | The screen's check of the value. |
| `onEdit` | `() => void` | Required. "Change". |
| `onChange` | `(value: string) => void` | Required. The raw text. |
| `onReview` | `() => void` | Required. "Review change" or Enter; passes nothing. |
| `onCancel` | `() => void` | Required. "Cancel". |
| `disabled` | `boolean` | A draft in flight: the buttons wait. |
