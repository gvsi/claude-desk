# ConnectorSection

`ConnectorSection` is one connector on the Rules hub: a header that opens the connector's page, then a row per tool with its rule words and its outcome.

## When to use

- On the Rules page, one per connector the Desk has, inside a `ConnectorList`: built in first, then the ones the owner connected.
- A connector is where tools come from. People read "Connectors", never "Integrations".

## What it shows

- A `Card` (`section`, named by the connector, no padding: each row pads itself, so the hairlines run edge to edge).
- The header, one link to `href` (14 px 16 px): `ConnectorIcon` at `section` size, `ConnectorName` with "Built in" or the Mock badge, `connector.description` in secondary meta, `addedNote` ("Added just now") in caption when given, "1 tool" or "{n} tools", and `chevron-right`. Its name comes from its content: "Payments Built in Payment links and charges within a signed limit. Test payments, no money moves. 2 tools".
- A row per tool (12 px 16 px, a hairline above): the name in weight 520 over its `description`; at the right its `summary` and the outcome with its dot: `OUTCOME_WORDS[mode]` while it is on, held "Needs your review" when its `status` is `needs_review` (or anything this build doesn't know), info "Off" when `disabled`; then `chevron-right`.
- The tool's name is its link, and the link's overlay covers the row, so the whole row opens the tool's page and draws one focus ring just inside its edge. The link is named "{name}: {summary}, {outcome}. Open", and its line is its description (`aria-describedby`), so the name a screen reader hears starts with the words it shows.
- It lays out by its own width (a container query): under 640 px (N-Conn-16-Phone-Rules) the connector's description and count and each tool's line go, the tile is 32 px with a 17 px mark, the rows pad 12 px 14 px, and each tool's `summary` sits under its name.

## Types and words

- `ToolSummaryView = { key: string; name: string; description: string; summary: string; mode: RuleMode; status: ToolStatus; href: string }`, one tool on the hub. `description` is what the tool does and its effects; `summary` its rule words ("Anyone · No discounts", "2 rules · 1 shared", "Always on").
- `describeEffects(effects, reversible): string` (in `describeEffects.ts`, also exported) gives a connected tool's effects in the boards' words, for the screen to put after what the tool does. First match wins: `pay_out` "Moves money out."; `charge` "Charges money."; `private_data` "Touches private data."; `send_message` "Sends a message out."; `change` "Changes something."; `read` "Changes nothing.". Then " Can be undone." or " Can't be undone." only when an effect changes something (`change`, `charge`, `pay_out`, `send_message`): a tool that only reads, or reads private data, has no second sentence. A tool with no effect this build knows reads "Changes something.", never as harmless.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. |
| `href` | `string` | The connector's page. |
| `tools` | `ToolSummaryView[]` | Required. |
| `addedNote` | `string` | "Added just now", right after it was added. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
