# ConnectorList

`ConnectorList` is the Rules hub's list of connectors: a summary line, one item per connector's section, and "Add a connector" at the end.

## When to use

- Once on the Rules page, under the "Ask Claude to change a rule or a connector" composer and above `AlwaysOnList` (N-Conn-01-Rules).
- Its children are `ConnectorSection`s, one per connector the Desk has: built in first, then the ones it connected.

## What it shows

- `summary` in secondary `.cd-type-meta`: the screen's words from the active rules version, such as "6 built-in connectors and 1 you connected · Version 7, checked against the always-on rules".
- A list named "Connectors", one item per child, 20 px apart.
- A secondary main "Add a connector" after the last item, calling `onAddConnector`; the page header has the same action at the top.
- It lays out by its own width: under 640 px (N-Conn-16-Phone-Rules) the items are 16 px apart, and the summary and the last button go, as the phone board draws them. The page header's "Add a connector" stays.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `summary` | `string` | Required. |
| `onAddConnector` | `() => void` | Required: the screen opens the picker. |
| `children` | `ReactNode` | The `ConnectorSection`s. |
