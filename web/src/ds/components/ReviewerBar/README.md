# ReviewerBar

`ReviewerBar` is one quiet line above the owner app in the demo: who the reviewer is playing, that this is a concept prototype, and a way to start over.

## When to use

- In the `AppShell`'s `banner`, above the sidebar and the page, full width, on every owner screen of the demo.
- Not on visitor surfaces: a visitor is never playing anyone.

## What the consumer provides

- `ownerName`, the business's `owner_display_name` ("Maria Rivera"). The bar reads "You're Maria Rivera today. This is a concept prototype.", with the name shown as written.
- `onStartOver`, which asks the owner to confirm (a `Dialog`) before it gets a fresh copy of the demo.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `ownerName` | `string` | Required. `owner_display_name`. |
| `onStartOver` | `() => void` | Required. The ghost "Start over" button. |

The bar is a `role="note"` on `bg-muted` with a `line-hairline` under it, in `meta` type: 36 px tall on one line, and taller when the words wrap on a phone.
