# ConnectorSection

`ConnectorSection` is one connector on the Rules hub: a header that opens the connector's page, then a row per tool with its rule words and its outcome.

## When to use

- On the Rules page, one per connector the Desk has, inside a `ConnectorList`: built in first, then the ones the owner connected.
- A connector is where tools come from. People read "Connectors", never "Integrations".

## What it shows

- A `Card` (`section`, named by the connector, no padding: each row pads itself, so the hairlines run edge to edge).
- The header, one link to `href`, the connector's page under Connectors (`connectors/<id>`) (14 px 16 px): `ConnectorIcon` at `section` size, `ConnectorName` with the Mock badge for an app and no "Built in" (the Rules page groups outcomes, and the Connectors page says where each comes from), `connector.description` in secondary meta, `addedNote` ("Added just now") in caption when given, "1 tool" or "{n} tools", and `chevron-right`. Its name comes from its content: "Payments Payment links and charges within a signed limit. Test payments, no money moves. 2 tools".
- `aboveTools`, when given, in a row of its own under the header, padded as a tool row (12 px 16 px, 12 px 14 px on a phone) under a hairline: the screen's line that holds over every rule below it, the payment limit on Payments and Stripe (`MoneyLimit`, N-Conn-19-Ceiling).
- A row per tool (12 px 16 px, a hairline above): the name in weight 520 over its `description`. The name is the tool's own title, which the app didn't write, so it is user text: marked `data-copy="user"` (inside the link, on its own span, so the link's name stays the app's words around it) with `.cd-user-name` for its isolation for text direction, otherwise styled as before; at the right its `summary` and the outcome with its dot: `outcomePhrase(mode)` while it is on ("Allow", "Ask me first" or "Never"), held "Needs your review" when its `status` is `needs_review` (or anything this build doesn't know), info "Off" when `disabled`; then `chevron-right`.
- The tool's name is its link, and the link's overlay covers the row, so the whole row opens the tool's page and draws one focus edge, 1 px of `line-focus`, just inside it. The link is named "{name}: {summary}, {outcome}. Open", the title first as a part of its own, and its line is its description (`aria-describedby`), so the name a screen reader hears starts with the words it shows.
- **Where a confirmed change landed.** A tool with `landed` carries an "Updated" `Pill` 8 px after its name, centered on it, which grows from 95% as it fades in on `motion-base`. The row lights up in `bg-selected` behind its words on `motion-fast`, holds 1.6 s (eight `motion-base` beats), then lets go on `motion-base`; and when its `summary` changes as it lands, the old words fade out over the new ones as they fade in, on `motion-base`, only the new ones read. Its link's name says so after the tool's name: "Quote, updated: Anyone · No discounts · Weekdays, all day, Automatic. Open". The row carries `data-landed`, so a screen can find a landing's rows. The screen keeps `landed` until the owner leaves the page, so "Updated" stays after the fill has gone; each new value lights the row up again. Under reduced motion the row is at its end state at once: "Updated", the new words, and no fill. The fill and the Pill are `Landing.tsx` (`LandedGlow`, `UpdatedPill`), shared with `ToolRulesCard` and `MoneyLimit`, and the cross-fade is `CrossFade.tsx`, shared with `ConnectorList`, `MoneyLimit` and `RuleRow`; none is exported. This folder draws no Button, which the selected ground can't take (`no_button_on_the_selected_ground`). See the "Landed" story.
- **Without links.** While a screen's connector and tool pages aren't built, it leaves out `href` on the section and on each tool. The header and the rows then draw the same words in the same type and spacing, with no link, no tab stop, no "Open" in any name and no chevron, so nothing on the card looks like it opens. A row's words and outcome keep its right edge. Hover and focus belong to linked rows only. See the "Without links" story.
- It lays out by its own width (a container query): from 640 px up, the name and its line keep at least 240 px; when the row is tight, the words and the outcome share what's left and wrap. Under 640 px (as the first phone Rules board, now archived, drew it) the connector's description and count and each tool's line go, the tile is 32 px with a 17 px mark, the rows pad 12 px 14 px, each tool's `summary` sits under its name, and its outcome on its own line under that, where a long phrase wraps. Nothing scrolls sideways at 320 px.

## Types and words

- `ToolSummaryView = { key: string; name: string; description: string; summary: string; mode: RuleMode; limit?: string; status: ToolStatus; href?: string; landed?: number }`, one tool on the hub; without `href`, its row has nothing to open. `landed` says the owner's confirmed change changed the tool's rules since they opened the page (see "Where a confirmed change landed"). `mode` and `limit` are the tool's outcome and its formatted amount limit: the most that runs on its own for some visitor under the owner's rules (a stranger, a verified customer, a record's owner, or a person or agent a rule names), so the row never reads safer than what runs (`ask` when no rule of the owner's covers it). The screen works it out; the component draws what it gets. `description` is what the tool does and its effects; `summary` its rule words ("Anyone · No discounts", "2 rules · 1 shared", "Always on").
- `describeEffects(effects, reversible): string` (in `describeEffects.ts`, also exported) gives a connected tool's effects in the boards' words, for the screen to put after what the tool does. First match wins: `pay_out` "Moves money out."; `charge` "Charges money."; `private_data` "Touches private data."; `send_message` "Sends a message out."; `change` "Changes something."; `read` "Changes nothing.". Then " Can be undone." or " Can't be undone." only when an effect changes something (`change`, `charge`, `pay_out`, `send_message`): a tool that only reads, or reads private data, has no second sentence. A tool with no effect this build knows reads "Changes something.", never as harmless.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. |
| `href` | `string` | The connector's page. Optional: without it, the header has nothing to open. |
| `tools` | `ToolSummaryView[]` | Required. |
| `addedNote` | `string` | "Added just now", right after it was added. |
| `aboveTools` | `ReactNode` | A line between the header and the tool rows, such as the payment limit. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
