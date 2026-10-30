# ConnectorOfferCard

`ConnectorOfferCard` is Claude's card in the Ask Claude panel when the owner asks for a connector: what it is, the tools it brings, and one button into its review.

## When to use

- Inline in the `AskClaudePanel` conversation, under Claude's answer, when the owner asks to add, connect, turn off or disconnect a connector ("Add Payments, so clients can pay their invoices online").
- It only leads into the same review as the picker: `ConnectorReview` and `ChangeReview` to add or connect, `ConnectionPanel`'s plain confirm to turn off or disconnect. Nothing turns on or off from the card.

## What it shows

- A `Card` (`article`, named by the connector, 16 px padding).
- The connector's `ConnectorIcon` at `section` size beside its `ConnectorName` at weight 520 (with "Built in" or the Mock badge) and `toolsLine` in secondary meta.
- `coverage` in secondary meta, when given: what already covers the tools.
- The one button, a primary `Button` by `action`: "Review and add", "Review and connect", "Review and turn off" or "Review and disconnect" → `onReview()`. `coming_soon` shows "Coming soon in this demo." in secondary meta and no button. An action this build doesn't know offers nothing to press.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. |
| `toolsLine` | `string` | Required. "2 tools · Payment link, Charge within a signed limit". |
| `coverage` | `string` | What covers the tools. |
| `action` | `'add' \| 'connect' \| 'turn_off' \| 'disconnect' \| 'coming_soon'` | Required (`ConnectorOfferAction`). |
| `onReview` | `() => void` | Required. Opens the review. |
