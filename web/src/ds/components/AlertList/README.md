# AlertList

`AlertList` shows the alerts a Desk is set to send, read-only: when the owner hears about something, what it covers, and how it reaches them.

## When to use

- On Settings › Alerts, under the business type's `SectionHeader` ("Set for a plumber" on the sample business) with its caption "From your business type", as N-Run2-Settings-Notifications draws it.
- Not for the alerts themselves, which are the Notifications page's, and not for anything the owner changes: the prototype sets alerts from the business type and offers no control.

## What the consumer provides

- `label`: the list's name, the same as the heading over it ("Set for a plumber").
- `items`, in order, each in the screen's words: `when` ("Right away", "In your briefing", "Not at all"), `what` ("Held requests, paused chats and emergencies") and, for alerts that reach the owner, `how` ("Notifications", "Each morning at 7:00 am"). The screen writes the briefing's time; nothing here formats one.

## What it shows

- One card (`Card` with no padding: `fill-card`, a `line-card` border at `radius-card`), ruled in `line-hairline` between its rows.
- Each row padded 12 px by 16 px: `when` in `body` at weight 520, `text-primary`, with `what` 2 px under it in `meta`, `text-secondary`; `how` at the right in `meta`, `text-secondary`, centered on the row. A row is 64 px, 65 with its hairline.
- When `what` and `how` don't fit on a line (a phone), `how` goes under `what`, from its left edge, 2 px under it, and a `how` longer than the row wraps inside it, so the page never scrolls sideways. A row with no `how` shows nothing there.
- No buttons, links or fields.

## Accessibility

- A list (`role="list"`, kept since its markers are removed) named by `label`, one item per row.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The list's name. |
| `items` | `{ when: string; what: string; how?: string }[]` | Required, in order. |
