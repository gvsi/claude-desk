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
- A built-in or connected row is one link to the connector's page (`href`, `connectors/<id>`), ending in a `chevron-right`, its focus edge, 1 px of `line-focus`, just inside the card. Its name comes from its content: "Stripe Mock Your customers' charges and refunds. Test mode, no money moves. Connected · Turner Plumbing, test mode (mock) 2 tools".
- An available app has a secondary "Connect" in place of the chevron, named "Connect {name}", which calls `onConnect`. The screen opens the add flow's sign-in from it. Nothing connects from the row itself.
- `justAdded`, the id of the connector added a moment ago, marks its row with "Added just now" in secondary ink (N-Conn-11-GCal-Done): after a connected app's account ("Connected · Turner Plumbing jobs (mock) · Added just now"), where the only status colour is the dot beside "Connected"; on a built-in connector added back, which has no account, as a line of its own under its description, with no dot (`BuiltInAddedBack`). An available row never says it, since an app still to connect can't have been added (`NotAddedWhileAvailable`). The words are fixed; the screen says only which row.
- An available app the demo can't connect yet has no `onConnect` and its `note` says so, "Coming soon in this demo", before its count; its row has no button and no link (`ComingSoonInTheDemo`). In the demo, Google Calendar is passed this way; the signed board draws the "Connect" it will have once it works.
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
| `available` | `DirectoryRowView[]` | Required. Each with its `onConnect`, or a `note` when it's coming soon in the demo. |
| `justAdded` | `string` | The `connector.id` of a built-in or connected row added a moment ago: "Added just now" on that row. Named for the words it shows, and an id rather than the words, since the list owns them, as `ChangeReview` owns its `cancelsLinks` line. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
