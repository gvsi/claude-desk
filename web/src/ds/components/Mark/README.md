# Mark

`Mark` draws the Claude Desk mark, a hand-drawn service bell: an uneven clay dome under ink lines (the dome's outline, a looped knob, a small reflection, two sound waves and the counter line), the ink set slightly off the clay like a print that slipped.

## When to use

- It is the only mark. Its colors (`mark-clay`, `mark-ink`, `mark-ink-light`, `mark-tile`, `mark-hairline`) are its own: fixed, the same in every theme, and used nowhere else. Never recolor it, never set it inside another tile or frame (the app icon's clay field is the one exception, and it counts as part of the mark), and never place it beside a Claude or Anthropic logo.
- The bell has no tile (owner, 2026-10-30). Where it shows, and how:

| Where | Size | Look |
| --- | --- | --- |
| The owner app's sidebar, in the lockup with the `Wordmark` and its "Preview" badge | 36 px | No tile, light ink |
| The phone top bar, beside the business's name | 20 px | No tile, light ink |
| "Powered by Claude Desk" in the public page's footer | 16 px | No tile, light ink |
| The first-visit intro dialog, beside the `Wordmark` and its "Preview" badge | 20 px | No tile, light ink |
| A standalone page and the owner app while it opens, beside the `Wordmark` | 20 px | No tile, light ink |
| The intro illustration's reply card, alone in an avatar's place | 32 px | No tile, dark ink (`ground="light"`) |
| The About pages' top bar, the app's lockup: beside the `Wordmark` with its "Preview" badge on the desktop bar | 36 px | No tile, light ink |
| The About pages' phone top bar, beside the name alone | 32 px | No tile, light ink |
| The About pages' app icon (`MarkAppIcon`), above the article's title | 80 px in the 120 px icon, 58 px in the 88 px one | The white tile (`tile`), on the icon's clay field |
| The browser tab (`favicon.svg`) | The browser's | No tile: dark ink on a light tab bar, light ink on a dark one |

- On the app's grounds (`ground="dark"`, the default) the ink is `mark-ink-light` in the dark theme and the drawing's dark ink, `mark-ink`, in the light theme, whose grounds are paper (`Mark.css` follows the theme chosen in the browser or the system's). The table's "light ink" is the dark theme's. The clay dome stays `mark-clay` in both: it is the logo's own, exempt from contrast, and the ink lines set the bell off the paper. On a light ground, `ground="light"`, it keeps the drawing's dark ink, `mark-ink`, in either theme.
- `tile` draws the white tile with its hairline edge and the drawing's dark ink. Only `MarkAppIcon` uses it (owner, 2026-10-30): the About pages' top bar shows the app's lockup with no tile, and the tile moved into the app icon above the article's title. A guard (`mark_tile_only_in_the_app_icon` in `web/src/app/guards.test.ts`) reads every TypeScript file under `web/src/` and allows a tile in two places only: once in `web/src/ds/components/Mark/Mark.tsx`, inside `MarkAppIcon`, and in the design system's stories. Every other file fails it, the About pages and the mark's other files included, whether the `Mark` tag passes `tile` itself, under an imported or local name (`Mark as Bell`, `const Bell = Mark`), as a namespace's member (`<DS.Mark tile />`), or through a spread of props that could carry it.
- `MarkAppIcon` is the Claude Desk app icon: the tiled bell centred on a clay field, at two thirds of it, with corners a quarter of its size. `large` is 120 px (an 80 px bell, 30 px corners) on the About pages' desktop layout, and `compact` 88 px (a 58 px bell, 22 px corners) on their phone layout, as N-Docs-Hero-Proposal and its phone board draw it (option A, signed 2026-10-30). The field counts as part of the mark, so its clay stays in this folder: a guard in each of `web/src/ds/guards.test.ts` and `web/src/app/guards.test.ts` allows clay only here, in the intro dialog's folder and in Claude's writing dots (`WritingIndicator`) and their story's color check. Claude's writing dots show with the words for screen readers. The icon is decorative (`aria-hidden`): the top bar above it names the product in words, and the article's title names the page, so a labelled picture would only say "Claude Desk" again before the title.

## What the consumer provides

- A `size` from the table above, and a `ground` only on a light ground.
- The name written out next to it (`Wordmark`, or text): the mark is `aria-hidden`.

## Props

`Mark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `size` | `16 \| 20 \| 24 \| 32 \| 36 \| 58 \| 80` | 20 by default. 58 and 80 are the tiled bell inside `MarkAppIcon`, and nowhere else. |
| `ground` | `'dark' \| 'light'` | `dark` by default: the light ink. `light` keeps the drawing's dark ink. Not with `tile`. |
| `tile` | `boolean` | The white tile, in the drawing's own colors. Only inside `MarkAppIcon`. |

`MarkAppIcon`:

| Prop | Type | Notes |
| --- | --- | --- |
| `size` | `'large' \| 'compact'` | Required. `large` 120 px, `compact` 88 px. |

`Wordmark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `preview` | `boolean` | Adds the "Preview" badge 8 px to the name's right: a `Pill` with `caps`, its word drawn in capitals by `.cd-type-badge-caps`, the product's one all-caps label. |

`Wordmark` sets "Claude Desk" in serif (`.cd-type-wordmark`), on one line with its badge, centred; the name never wraps. In the sidebar and on the About pages' desktop top bar the lockup is the 36 px mark, then the wordmark 10 px on, all centred on one line (owner, 2026-10-30); the About pages' phone bar sets a 32 px mark 8 px from the name, with no badge.

## Geometry

`mark.svg`, in this folder, is the mark's signed drawing, on a 100-unit grid: the white tile, then the bell in the drawing's colors. `npm run gen:mark` (`scripts/gen-mark.mjs`) reads it strictly and generates two files from it, never edited by hand:

- `markGeometry.ts`, `MARK_GEOMETRY`: the tile (x 0.5, y 0.5, 99 by 99, corner radius 22), the transform that places the bell inside it, one clay path, and the ink's six paths and twelve round dots. `Mark` draws from it, with the tile or without.
- `favicon.svg`, the page's icon: the bell without its tile, its ink the drawing's dark ink, and the light ink under `@media (prefers-color-scheme: dark)` inside the icon, so one file reads on a light tab bar and on a dark one. `web/index.html` links it, so the build emits it under a hashed name.

The light ink (`LIGHT_INK`, `#faf9f5`) is the generator's one variant of the drawing. A unit test (`scripts/gen-mark.test.mjs`) fails when either file or the `mark-*` tokens drift from the drawing, and `node scripts/gen-mark.mjs --check` fails when either file is stale. The reader refuses anything else in the drawing, so a redraw keeps the same structure: the tile, then the clay group, then the ink group.
