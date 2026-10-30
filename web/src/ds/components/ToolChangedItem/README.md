# ToolChangedItem

`ToolChangedItem` is Today's "Needs you" item for a tool that a changed definition switched off, with a button to its review.

## When to use

- On Today, first under "Needs you", one per tool whose status is `needs_review`, counted in the needs-you count.
- Held requests stay `ApprovalCard`s beside it.

## What it shows

- A `Card` (`article`, 16 px padding) named by its title, so "Review" is heard in its context.
- A held dot (`aria-hidden`) on the first line, then "{connector name} changed “{tool}”, so it's off until you review it." in body type, `text-primary`.
- Under it, in secondary meta: "{connector name} · Mock · {noticed}. {consequence}" ("Stripe · Mock · Noticed today at 9:14. Refunds can't run until you decide."). A connector is a mock in words here, since the line is meta; a built-in one would read "Built in".
- A secondary "Review" at the right → `onReview()`, which opens the tool's page. On a narrow line it drops under the words.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. |
| `tool` | `string` | Required. The tool's name. |
| `noticed` | `string` | Required. The screen's words: "Noticed today at 9:14". |
| `consequence` | `string` | Required. "Refunds can't run until you decide." |
| `onReview` | `() => void` | Required. Opens the tool's page. |
