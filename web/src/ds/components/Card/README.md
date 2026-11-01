# Card

`Card` is a quiet container: a faint fill, a 1 px border and the card radius, set apart from the page without a shadow.

## When to use

- One thing a person reads or acts on as a unit: a held request on Today, a capability on Rules, a typed reply card.
- `padding={20}` (the default) for a card a screen is about; `padding={16}` for compact cards side by side in a grid; `padding={0}` for a card of rows that pad themselves, such as a connector's section on the Rules page, so their hairlines run edge to edge.
- Never inside another card. Group things inside one card with spacing or a `line-hairline` rule instead. In development a nested Card throws, so the mistake fails its story; a production build renders it.
- One exception, `holdsCards`: a frame whose content includes cards of their own, one level deep. Only the agents page's "Send an agent" card uses it, which holds the agent's run and so the Desk's reply cards (N-R2-Agents-04-Run). The cards directly in it may be cards; a card inside one of those still throws, and a frame throws anywhere but the top level, inside a card or inside another frame. The web app may use it only in `SendAgentPanel` (the guard `only_the_send_agent_panel_holds_cards`). Don't use it to put a card in a card anywhere else.
- Never as a colored tile, with a colored edge or with a shadow. Status inside a card is a `StatusLabel` in its top line.

## What the consumer provides

- `as`: the element. `article` for a thing that stands on its own (a held request, a capability), `li` when the card is a list item, `section` for a region with its own heading, `div` otherwise.
- `label`, the name a screen reader announces for an `article` or `section` card: its heading's words ("Quotes"), or what it is about when it has no heading ("Held for you: 50% cash discount").
- Or `labelledBy`, the id of the element in the card whose text names it, when that text is Claude's words rendered as Markdown, such as setup's docked question: the name then reads as the text does, without the Markdown's marks.
- The content and its layout. The card adds only its fill, border, radius and padding, and lets long words wrap.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `as` | `'div' \| 'article' \| 'section' \| 'li'` | `div` by default. |
| `label` | `string` | The `aria-label`. A named `div` card gets `role="group"`, since a plain `div` can't carry a name. |
| `labelledBy` | `string` | The `aria-labelledby`: the id of the element that names the card, in place of `label`. A `div` card named this way is a group too. |
| `padding` | `0 \| 16 \| 20` | `20` by default (`space-20`); `16` is `space-16`; `0` leaves the padding to the rows. |
| `holdsCards` | `boolean` | A frame that holds cards one level deep: the agents page's "Send an agent" card only. |
| `children` | `ReactNode` | Required. |

Fill `fill-card`, border 1 px `line-card`, radius `radius-card`. Text inside meets contrast on `fill-card` over `bg-app` (`CONTRAST_PAIRS`).
