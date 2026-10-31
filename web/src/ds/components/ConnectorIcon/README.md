# ConnectorIcon

`ConnectorIcon` is a connector's square tile: a built-in connector's line icon, or a third-party app's own mark on a light tile, always beside the connector's name.

## When to use

- Beside a `ConnectorName` wherever a connector is named with its icon: a section on the Rules hub, a connector's page, a tool's source line, the picker, an offer card in the Ask Claude panel.
- Never on its own: the tile is `aria-hidden`, and the name beside it says what it is.

## What it shows

- `icon` picks the mark. Built in, on `fill-secondary` with the icon in `text-primary`: `quotes` (`quote`), `bookings` (`calendar`), `leads` (`person`), `verification` (`lock`), `documents` (`document`), `payments` (`card`).
- External, on the light `connector-tile-brand` tile: `stripe` and `google_calendar`, each brand's real mark as inline SVG in its brand color token (`connector-stripe`, `connector-google-blue`). The brand tile is one of the product's three light surfaces, with the intro illustration's cards and the mark's own white tile; nothing is read on it, so its colors are in `DECORATIVE_COLORS`.
- An icon this build doesn't know shows an empty built-in tile.

| `size` | Tile | Mark | Where |
| --- | --- | --- | --- |
| `page` | 48 px | 26 px | A connector's page header. |
| `section` | 36 px | 20 px | The hub's sections, the picker, the offer card. |
| `inline` | 24 px | 13 px | A line of meta: "From Stripe". |

Every tile has the 8 px `radius-control`. The line icons are drawn at 20 px and scale with the tile, so their stroke matches the boards at every size.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `icon` | `ConnectorIconName` | One of the eight above. |
| `size` | `'page' \| 'section' \| 'inline'` | Required. |

Brand marks: Simple Icons (https://simpleicons.org), CC0.
