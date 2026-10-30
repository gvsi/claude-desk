# ConnectorList

`ConnectorList` is the Rules hub's list of connectors: a summary line, one item per connector's section, and "Add a connector" at the end.

## When to use

- Once on the Rules page, under the "Ask Claude to change a rule or a connector" composer and above `AlwaysOnList` (N-Conn-12-Chat). Connectors are added from the Connectors page, so the Rules page passes no `onAddConnector`.
- Its children are `ConnectorSection`s, one per connector the Desk has: built in first, then the ones it connected.

## What it shows

- `summary` in secondary `.cd-type-meta`: the screen's words from the active rules version, such as "6 built-in connectors and 1 you connected · Version 7, checked against the always-on rules".
- A list named "Connectors", one item per child, 20 px apart.
- With `onAddConnector`, a secondary main "Add a connector" after the last item, calling it. Without it, none.
- It lays out by its own width: under 640 px the items are 16 px apart, and the summary and the last button go, as the first phone Rules board drew them (archived).

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `summary` | `string` | Required. |
| `onAddConnector` | `() => void` | Adds "Add a connector" at the end; the screen opens the picker. |
| `children` | `ReactNode` | The `ConnectorSection`s. |
