# ConnectorHeader

`ConnectorHeader` is the top of a connector's page: what the connector is, whether it is on, and, for a connector that makes one, its promise about what Claude can't see.

## When to use

- At the top of each connector's page under Connectors (`connectors/:connector`), under its `Breadcrumb`: Payments, Stripe, Verification, Google Calendar.
- Not on a tool's page, which has `ToolPageHeader`, and not on the Rules page, whose title is a `PageHeader`.

## What it shows

- The connector's `ConnectorIcon` at `page` size (48 px), 16 px from its `ConnectorName` at `page` size as the page's `h1` (serif page title, with "Built in" or the Mock badge), and `connector.description` 4 px under it in body type, `text-secondary`.
- At the right, centered on the tile, the status in words with its dot (`StatusLabel`, meta type): handled "On" for a built-in connector, handled "Always on" for Verification, handled "Connected" for an app connected from outside, info "Off". A status this build doesn't know reads "Off", never "On". On a narrow line the status drops under the name.
- `promise`, when given, 20 px under the header as a `ConnectorPromise`.

## ConnectorPromise

`ConnectorPromise({ title, detail? })`, also exported from this folder, is a connector's promise about what Claude can't see or do with it, such as Google Calendar's "Claude sees only when you're busy, never what the event is: no titles, guests or notes.". It is a `Card` (16 px padding, a group named by `title`) with a 14 px `lock` icon in `text-secondary` on the title's first line, 12 px from the words: `title` in body type at weight 520, then `detail` in `.cd-type-meta`, `text-secondary`. `ConnectorSignIn` shows the same card.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. |
| `status` | `'on' \| 'always_on' \| 'connected' \| 'off'` | Required (`ConnectorStatus`). |
| `promise` | `{ title: string; detail?: string }` | Shown under the header as a `ConnectorPromise`. |
