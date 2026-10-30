# ConnectorPicker

`ConnectorPicker` is "Add a connector": a modal dialog that lists the built-in connectors and the apps a Desk can add, and leads into the chosen one's review.

## When to use

- From "Add a connector" on the Rules page, and from an offer card's "Review and add" or "Review and connect" when the screen wants the owner to choose first.
- Choosing only starts the flow: nothing turns on from the picker. Each tool starts at "Ask me first" in `ConnectorReview`, and the proved change shows in `ChangeReview` before it applies.

## What it shows

- A native modal `<dialog>` (`showModal()`), 640 px wide and 48 px from the top of the window, over `scrim`, with `shadow-dialog`, `bg-surface`, a `line-card` border at `radius-card` and 28 px of padding. A long list scrolls inside it.
- Its serif title "Add a connector" (`.cd-type-page-title`), which names it, and a Close `IconButton` at the right. The board draws no Close; it lets the dialog close by pointer as well as by Escape.
- "Add what fits {business}. Each tool you add starts at Ask me first unless one of your rules already covers it, and you review them before anything turns on." in secondary body type, which describes it.
- Two lists, each named by its heading: "Claude Desk" (built in) and "Other apps" (connected from outside). A row per connector under a hairline: its `ConnectorIcon` at `section` size, its `ConnectorName` with "Built in" or the Mock badge at weight 520 over its description in secondary meta, and at the right, by `state`:
  - `available`: a secondary "Add" (built in) or "Connect" (an app), named "Add Payments", "Connect Stripe" → `onChoose(id)`;
  - `added`: "Added"; `connected`: "Connected"; `coming_soon`: "Coming soon in this demo", each in secondary meta with no button. A state this build doesn't know shows nothing to press.
- Under the lists, in secondary meta: `note` when given, then, whenever an app is listed, "Mock connectors stand in for the real apps. No account is used and nothing is sent to them."
- Under 720 px it sits 16 px from the window's edges with 20 px of padding.

## Keyboard and focus

- Focus starts on the first connector's "Add" or "Connect", or on Close when there is none.
- Tab and Shift+Tab stay inside the dialog.
- Escape, Close and the browser's own close request call `onClose`. When the screen removes it, focus returns to whatever opened it.

## What the consumer provides

- `builtIn` and `external` from the Desk's connectors and the catalog. Verification is never listed, since every Desk has it.
- Rendering it opens it, and removing it closes it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `business` | `string` | Required. |
| `builtIn` | `PickerItem[]` | Required. `{ connector: ConnectorView; state: 'available' \| 'added' \| 'connected' \| 'coming_soon' }`. |
| `external` | `PickerItem[]` | Required. |
| `note` | `string` | A note under the lists. |
| `onChoose` | `(id: string) => void` | Required. |
| `onClose` | `() => void` | Required. |
