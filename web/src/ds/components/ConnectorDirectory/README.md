# ConnectorDirectory

`ConnectorDirectory` is the Connectors page's list: every connector on the Desk, grouped by where it comes from, and the apps that can still be connected.

## When to use

- On the Connectors page (`connectors`, N-Conn-23-Connectors, N-Conn-24-Phone-Connectors), under its `PageHeader` with "Add a connector".
- Not on the Rules page, which lists each connector's tools and their outcomes (`ConnectorList` of `ConnectorSection`s).

It is its own component rather than a mode of `ConnectorList`: the Rules page's list is a section per connector with a row per tool and its outcome, while this one is a row per connector with its state and no outcomes. Sharing one component would mean two row shapes and two layouts behind a flag.

## What it shows

- Up to three groups, 20 px apart, each a `section` named by its `SectionHeader`, and 20 px under it one `Card` of rows that reach its edges, each under a hairline but the first:
  - "Built in", with `builtInCaption` at the right ("Part of Claude Desk. Remove one from this Desk on its own page; Verification is always on."), which drops under the title on a narrow line;
  - "Connected", the apps connected from outside;
  - "Available", the apps that can be connected.
- A group with no rows is left out.
- A row, 14 px 16 px:
  - the connector's 36 px `ConnectorIcon`;
  - its `ConnectorName` with no "Built in" (the group says so) and, for an app, the Mock badge;
  - its description in secondary meta;
  - for a connected app, "Connected" beside a handled dot, then "· {connection}", the account in the screen's words;
  - at the right, in secondary meta, the note ("Always on" for Verification, in caption type) and the count, "1 tool" or "{n} tools".
- A built-in or connected row is one link to the connector's page (`href`, `connectors/<id>`), ending in a `chevron-right`, its focus ring just inside the card. Its name comes from its content: "Stripe Mock Your customers' charges and refunds. Test mode, no money moves. Connected · Rivera Plumbing, test mode (mock) 2 tools".
- An available app has a secondary "Connect" in place of the chevron, named "Connect {name}", which calls `onConnect`. The screen opens the add flow's sign-in from it. Nothing connects from the row itself.
- Under 640 px of its own width (N-Conn-24-Phone-Connectors):
  - each row's count goes under its line, after its note and a dot ("Always on · 1 tool");
  - "Connect" sits under the count;
  - the tile and the chevron stay at the top.

The screen passes every string, and nothing here decides what is connected.

## Types

- `DirectoryRowView = { connector: ConnectorView; tools: number; href?: string; note?: string; connection?: string; onConnect?: () => void }`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `builtIn` | `DirectoryRowView[]` | Required. Verification among them, noted "Always on". |
| `builtInCaption` | `string` | Beside "Built in". |
| `connected` | `DirectoryRowView[]` | Required. Each with its `connection`. |
| `available` | `DirectoryRowView[]` | Required. Each with its `onConnect`. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
