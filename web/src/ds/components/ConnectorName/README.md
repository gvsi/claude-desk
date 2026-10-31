# ConnectorName

`ConnectorName` is a connector's name with what kind it is beside it: "Built in", or the "Mock" badge for an app connected from outside.

## When to use

- Every time a connector is named: the hub's sections, a connector's page title, a tool's "From Stripe" line, the change review's meta lines, the picker, offer cards. Because every component names connectors through it, "Mock" sits beside every external connector's name, everywhere.
- People read "Connectors", never "Integrations".

## What it shows

- The name, then, separated by a real space (drawn as the flex gap):
  - a built-in connector (`source.kind: 'built_in'`): "Built in" in `.cd-type-caption`, `text-secondary`, unless `hideBuiltIn` (the Rules page's sections and the Connectors page's rows, which already group connectors);
  - an external one: an outlined `Pill` "Mock". Every external connector in the demo is a mock, and `ConnectorView.source` requires `mock: true` for it, so the badge can't be left out.
- `size="page"`: the name in serif `.cd-type-page-title`, the badge 10 px off. `section`: `.cd-type-section`, 8 px off. `inline`: the surrounding line's type.
- `level` makes it a heading (`h1` on a connector's page); without it, a `span`.
- The name wraps on a narrow line, and the badge moves under it only when both can't share the line.

## ConnectorSummary

`ConnectorSummary` is the start of a row in a list of connectors to choose from, shared by `ConnectorPicker` and `SetupToolsList`: the connector's 36 px `ConnectorIcon`, then its words, `ConnectorName` (`inline`, weight 520, the badge or "Built in" 8 px off) over its description in secondary meta, 2 px under it. It returns the tile and the words as siblings, so each list's row places them beside what it puts at the end and keeps its own breakpoint. Props: `connector`, and `hideBuiltIn` where the list's group already says it.

## Types

`ConnectorView = { id: string; name: string; icon: ConnectorIconName; description: string; source: { kind: 'built_in' } | { kind: 'external'; mock: true } }`, the screen's view of one connector. The web app owns which tools each connector groups and every word in it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. |
| `size` | `'page' \| 'section' \| 'inline'` | Required. |
| `level` | `1 \| 2 \| 3` | A heading at this level; a `span` when left out. |
| `hideBuiltIn` | `boolean` | Leaves out "Built in". The "Mock" badge always shows. |
