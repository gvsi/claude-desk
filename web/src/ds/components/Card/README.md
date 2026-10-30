# Card

`Card` is a quiet container: a faint fill, a 1 px border and the card radius, set apart from the page without a shadow.

## When to use

- One thing a person reads or acts on as a unit: a held request on Today, a capability on Rules, a typed reply card.
- `padding={20}` (the default) for a card a screen is about; `padding={16}` for compact cards side by side in a grid; `padding={0}` for a card of rows that pad themselves, such as a connector's section on the Rules page, so their hairlines run edge to edge.
- Never inside another card. Group things inside one card with spacing or a `line-hairline` rule instead. In development a nested Card throws, so the mistake fails its story; a production build renders it.
- Never as a colored tile, with a colored edge or with a shadow. Status inside a card is a `StatusLabel` in its top line.

## What the consumer provides

- `as`: the element. `article` for a thing that stands on its own (a held request, a capability), `li` when the card is a list item, `section` for a region with its own heading, `div` otherwise.
- `label`, the name a screen reader announces for an `article` or `section` card: its heading's words ("Quotes"), or what it is about when it has no heading ("Held for you: 50% cash discount").
- The content and its layout. The card adds only its fill, border, radius and padding, and lets long words wrap.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `as` | `'div' \| 'article' \| 'section' \| 'li'` | `div` by default. |
| `label` | `string` | The `aria-label`. A named `div` card gets `role="group"`, since a plain `div` can't carry a name. |
| `padding` | `0 \| 16 \| 20` | `20` by default (`space-20`); `16` is `space-16`; `0` leaves the padding to the rows. |
| `children` | `ReactNode` | Required. |

Fill `fill-card`, border 1 px `line-card`, radius `radius-card`. Text inside meets contrast on `fill-card` over `bg-app` (`CONTRAST_PAIRS`).
