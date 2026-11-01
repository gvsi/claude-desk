# ConnectorIcon

`ConnectorIcon` is a connector's square icon: a built-in connector's line icon on a tile, or a third-party app's own mark with no tile, always beside the connector's name.

## When to use

- Beside a `ConnectorName` wherever a connector is named with its icon: a section on the Rules hub, a connector's page, a tool's source line, the picker, an offer card in the Ask Claude panel.
- Never on its own: the icon is `aria-hidden`, and the name beside it says what it is.

## What it shows

- `icon` picks the mark. Built in, on `fill-secondary` with the icon in `text-primary`: `quotes` (`quote`), `bookings` (`calendar`), `leads` (`person`), `verification` (`lock`), `documents` (`document`), `payments` (`card`).
- External, with no tile (owner, 2026-10-30): `stripe` and `google_calendar`, each brand's real mark as inline SVG in its brand color token. Stripe's is white on the dark grounds (`connector-stripe`), as Stripe's guidelines allow; Google Calendar's keeps its own blue (`connector-google-blue`). Nothing is read on them, so their colors are in `DECORATIVE_COLORS`.
- An icon this build doesn't know shows an empty built-in tile.

| `size` | Box | Mark | Where |
| --- | --- | --- | --- |
| `page` | 48 px | 26 px | A connector's page header. |
| `section` | 36 px | 20 px | The hub's sections, the picker, the offer card. |
| `inline`, built in | 24 px | 13 px | A line of meta: "From Quotes". |
| `inline`, brand | 20 px | 20 px | A line of meta: "From Stripe". |

A built-in connector's tile fills the box at the 8 px `radius-control`; at `page` and `section` a brand mark sits in the same box with no tile, so icons line up in a list whichever they are. The line icons are drawn at 20 px and scale with the box, so their stroke matches the boards at every size. In a line of meta a brand mark has no tile to fill, so it fills its box instead, 20 px in a 20 px box, as N-Explore-Connector-Decided draws it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `icon` | `ConnectorIconName` | One of the eight above. |
| `glyph` | `IconName` (optional) | Draws a built-in tile with this glyph, overriding `icon`. |
| `size` | `'page' \| 'section' \| 'inline'` | Required. |

Brand marks: Simple Icons (https://simpleicons.org), CC0.
