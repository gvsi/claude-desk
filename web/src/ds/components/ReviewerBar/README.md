# ReviewerBar

`ReviewerBar` is one quiet line above the owner app in the demo: who the reviewer is playing, that this is a concept prototype, and a way to start over.

## When to use

- In the `AppShell`'s `banner`, above the sidebar and the page, full width, on every owner screen of the demo.
- Not on visitor surfaces: a visitor is never playing anyone.

## What the consumer provides

- `ownerName`, the business's `owner_display_name` ("Mike Turner"). The bar reads "You're Mike Turner today. This is a concept prototype.", with the name shown as written.
- `onStartOver`, which asks the owner to confirm (a `Dialog`) before it gets a fresh copy of the demo.
- `actions`, the screen's own controls, just before Start over and in its style: as TOD-04 drew the owner's Demo inbox (`DemoInboxSheet` with `quiet`). The owner app passes none since its notifications moved to the sidebar (REV-NOTIF). They and Start over share one row, 16 px apart, that never wraps. With them, on a phone (under 640 px) the words take the first line and the controls the next, 4 px under them.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `ownerName` | `string` | Required. `owner_display_name`. |
| `onStartOver` | `() => void` | Required. The ghost "Start over" button. |
| `actions` | `ReactNode` | Before Start over, in its row. |

The bar is a `role="note"` on `bg-muted` with a `line-hairline` under it, in `meta` type: 36 px tall on one line, and taller when the words wrap on a phone.

## Loading shapes

`ReviewerBarSkeleton({ ownerName?, inbox? })` keeps this bar's ground, hairline, meta line boxes and control-sized Start over shape. The name defaults to `SEED_OWNER_NAME`, the seed owner's, which the Turner fixture's owner matches (a browser test checks it). Both components use `reviewerBarWords` so their copy, Start over included, stays in sync. A temporary hidden paragraph measures only the naturally wrapped line count in the current font; the pills retain the signed widths: `min(100%, 430px)` first, `75%` thereafter. The same measurement pass reserves the real control width before the first paint, with `measureControlWidth`, the canvas measurement every skeleton control uses. With `inbox`, it draws TOD-04's Demo inbox button before Start over (anchored `inbox`, measured with a count of 1) and lays the bar out as `actions` do. It remeasures on resize and font loading, and leaves no words or controls in the shapes. Render it in `SkeletonScreen`'s hidden layer. Companion stories compare the real bar and its action with the shapes within 2 px at 1512 and 390. Browser tests also resize the mounted bar through 280, 320, 390, 440, 480, 540, 620, 639, 640, 768 and 1440 px; frame reload tests cover 390, 620 and 1440 px.
