# LimitChange

`LimitChange` shows a change to the Desk's payment limit before the owner confirms it: the new limit, and what it was.

## When to use

- On the review page for a payment-limit change, "Change your payment limit" under the "Rules" breadcrumb (N-Conn-20-Ceiling-Review), above `ChangeReview`, which the screen passes `hasOtherChanges`, so a draft that changes only the limit reads "Your rules stay the same." and keeps "Confirm change".
- The web app's `RuleDraftReview` (plan 04) shows it whenever the draft sets `moneyCap`.

## What it shows

- A `Card` (`section`, named "Payment limit", padding 20 px).
- `now` in Claude's serif, `.cd-type-summary` (18/27), `text-primary`, at the left.
- `was` in `.cd-type-meta`, `text-secondary`, at the right, on the same baseline.
- On a narrow line `was` wraps under `now`.

## What the consumer provides

- Both lines in its own words, from the drafted and the active rules versions' money caps: "New limit: no payment over $1,000 without asking you." and "Was $500". At 0 the new line says that every payment asks first. Nothing here reads, compares or formats an amount.
- Whether the change can cancel open payment links: a lowered limit can, so the screen passes `cancelsLinks` to `ChangeReview`; a raise can't, so its review has no such line.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `now` | `string` | Required. The new limit, in the screen's words. |
| `was` | `string` | Required. The old limit, in the screen's words. |
