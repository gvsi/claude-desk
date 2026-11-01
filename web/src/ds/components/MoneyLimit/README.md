# MoneyLimit

`MoneyLimit` shows the Desk's payment limit, the most one payment can be before Claude asks, and lets the owner change it through a reviewed draft.

## When to use

- At the top of each group of payment tools on the Rules page, Payments and Stripe, as their `ConnectorSection`'s `aboveTools` (N-Conn-19-Ceiling, N-Conn-19b-Ceiling-Edit, N-Conn-22-Phone-Presets). Each group holds its own copy, and only the one the owner opens edits.
- Above the setup interview's rules, in `OutcomeGroups`' card of its own, with `prominent`, which sets its line in weight 520, and no `onEdit`: the setup's rules step has no "Change" (N-R2-Setup-08-Rules; owner ruling, 2026-10-30).
- The limit is the active rules version's money cap (master "Money cap"), whatever the rules below it say. It changes only through a draft the owner confirms on its review page (`LimitChange` above `ChangeReview`, N-Conn-20-Ceiling-Review).

## What it shows

- The section's line above its tools holds it: padded 12 px 16 px (12 px 14 px on a phone) under a hairline, as a tool row is. It adds no padding or line of its own but for 4 px under the editing buttons.
- Reading: `line` in body type, `text-primary` ("No payment over $500 goes through without asking you, whatever the rules below say.", or "Every payment asks you first." when no limit is set), and a secondary "Change" at the right, centered on it, which calls `onEdit()`. "Change" is described by the line (`aria-describedby`), so the Rules page's two, in Payments and Stripe, say which limit each changes.
- Read only, with no `onEdit`: the line alone, with nothing to press. None of the field's props apply, and the types refuse them.
- Editing, in a form, 16 px above the next hairline in all:
  - A `TextField` named by `label` ("Most a payment can be without asking you, in dollars" by default), at most 360 px wide, holding `value` exactly as typed. `hint` sits under it, and so does `error` when given (the field is then `aria-invalid` and the error is announced).
  - 12 px under it, a primary "Review change" and a secondary "Cancel".
- Opening the field moves focus into it; closing it moves focus back to "Change". Only a change of `editing` moves focus, never the first render.
- It lays out by its own width: under 640 px (a phone) "Change" sits 10 px under the limit at its own width.

## Behavior

- Typing calls `onChange` with the raw text, every time. Nothing here parses, trims, checks or formats it.
- "Review change", or Enter in the field, calls `onReview()` with nothing in it: the screen checks the value it holds. When the value is out of range the screen passes `error` ("No single payment can be above $10,000.") and sends nothing. Otherwise it drafts the change and opens its review.
- "Cancel" calls `onCancel()`; the screen closes the field.
- `disabled` (a draft in flight) puts every button in its waiting state (`aria-disabled`, focus kept), and nothing is sent.

## What the consumer provides

- Every string in its own words: the limit and the hint with the amount formatted by the web app ("Now $500."), and the error from its own check of the value (whole dollars, 0 to 10,000, the per-payment limit).

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `line` | `string` | Required. The limit in words. |
| `editing` | `boolean` | Required with `onEdit`. The field is open. |
| `label` | `string` | The field's label; "Most a payment can be without asking you, in dollars" by default. |
| `value` | `string` | Required with `onEdit`. What the owner typed. |
| `hint` | `string` | Required with `onEdit`. The line under the field. |
| `error` | `string` | The screen's check of the value. |
| `onEdit` | `() => void` | "Change". Without it the limit is read only, and the field's props are left out. |
| `onChange` | `(value: string) => void` | Required with `onEdit`. The raw text. |
| `onReview` | `() => void` | Required with `onEdit`. "Review change" or Enter; passes nothing. |
| `onCancel` | `() => void` | Required with `onEdit`. "Cancel". |
| `disabled` | `boolean` | A draft in flight: the buttons wait. |
| `prominent` | `boolean` | The limit leads the rules under it (the setup's rules step): its line in weight 520. |
| `updated` | `boolean` | With `onEdit`. The owner's confirmed change set this limit since they opened the page: an "Updated" `Pill` follows the line, 8 px after its last word, growing from 95% as it fades in on `motion-base`, and the words that changed cross-fade as the new line arrives (`$500` to `$600`). The line takes no fill, since "Change" is a Button and the selected ground can't take one. Under reduced motion it is at its end state at once. The screen keeps it until the owner leaves the page. The limit then carries `cd-money-limit--updated`, so a screen can find it. |
