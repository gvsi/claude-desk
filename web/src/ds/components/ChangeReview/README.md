# ChangeReview

`ChangeReview` shows a proved change before it applies: what each rule enforces before and after, the checks the change passed, and one confirm that works only when they passed.

## When to use

- After the owner drafts a rule change (from an outcome menu, the composer or the Ask Claude panel), turns a connector on, or turns a changed tool back on (N-Conn-10-GCal-Confirm, N-Conn-11b-Payments-Review). The screen builds the rows from `ruleDiff` and the tools it turns on, and the checks from the proof report (Plan 04's `checkStatus`).
- Not for turning a connector off: that only narrows and applies at once, so it has a plain confirm (`ConnectionPanel`, Task 3).
- Renamed from `RuleChangeDiff`.

## What it shows

- A "Changes" card (`section`), a row per change under a hairline:
  - A tag in words in an outlined pill: "Added", "Removed", "Changed" or "Turned on".
  - `title` in weight 520, then a meta line: the `connector`'s name and badge (`ConnectorName`, so a mock is never named without "Mock"), then the side's `words`, joined by " · ".
  - The side's `reason`, and at the right the outcome with its dot, `outcomePhrase(mode, limit)`.
  - A `changed` row shows its connector, then a "Before" and an "After" group, each with its words, reason and outcome. On the After side each line whose field is in `changed` is tagged "Changed" in words: the words line for `who`, `limits`, `hours` and `review`, the reason for `reason`, the outcome for `mode`. Status is never shown by color alone.
  - An added or turned-on row shows its after side; a removed row the rule it removes.
- No rows: "No rules change." and no confirm button. With `hasOtherChanges` (the draft changes something the screen shows above it, such as the money limit) it reads "Your rules stay the same." instead, and the controls stay.
- A card for the checks, headed by `checks.status`: "Checked before you confirm", "This change can't be applied" or "Rules can't be checked right now", with `checks.lines` as a list in secondary meta: the screen's words from the proof report.
- The primary `confirmLabel` ("Confirm change" by default; "Confirm and turn on") is enabled only when the status is `checked`. One click calls `onConfirm` once and waits, busy, until `pending` has come and gone, `error` shows a new message, or the promise `onConfirm` returned rejects. `pending` reads "Confirming", with `aria-busy`.
- The secondary `cancelLabel` ("Keep my rules" by default; "Back") calls `onCancel`; it waits while a confirm is in flight.
- `error` shows the screen's message in an error `Notice` (an alert), and confirm works again.

## Types

- `ChangeSide = { mode: RuleMode; limit?: string; reason: string; words: RuleWord[] }`.
- `ChangeRowView = { key: string; change: 'added' | 'removed' | 'changed' | 'turned_on'; title: string; connector?: ConnectorView; before: ChangeSide | null; after: ChangeSide | null; changed: RuleField[] }`.

## Diffing rules: `ruleDiff`

`ruleDiff(before: RuleCard[], after: RuleCard[]): RuleDiffRow[]` (in `ruleDiff.ts`, also exported) reports which of the owner's cards a draft adds, removes or changes, and in which fields. It decides nothing.

- Rows by `card_id`, in `card_id` order; `is_default` cards (the compiler's, re-derived on every draft) are skipped; unchanged cards are left out.
- `RuleDiffRow = { cardId; change: 'added' | 'removed' | 'changed'; before: RuleCard | null; after: RuleCard | null; fields: RuleField[] }`.
- `RuleField = 'applies_to' | 'mode' | 'who' | 'limits' | 'hours' | 'review' | 'reason'`, in that order; `person_id` and `agent_key_id` count as `who`, `max_amount_cents` and `max_discount_bp` as `limits`. An absent optional field equals its contract default, so the same reason with a new limit is a `changed` row with `['limits']`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `rows` | `ChangeRowView[]` | Required. |
| `checks` | `{ status: 'checked' \| 'failed' \| 'unavailable'; lines: string[] }` | Required. |
| `confirmLabel` | `string` | "Confirm change" by default. |
| `cancelLabel` | `string` | "Keep my rules" by default. |
| `onConfirm` | `() => void \| Promise<unknown>` | Called once per click; a rejection lets the owner confirm again. |
| `onCancel` | `() => void` | Required. |
| `hasOtherChanges` | `boolean` | Keeps the controls with no rows. |
| `pending` | `boolean` | "Confirming". |
| `error` | `string` | The screen's message; confirm works again. |
