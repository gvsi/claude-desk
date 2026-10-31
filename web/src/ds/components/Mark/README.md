# Mark

`Mark` draws the Claude Desk mark, a hand-drawn service bell: an uneven clay dome under ink lines (the dome's outline, a looped knob, a small reflection, two sound waves and the counter line), the ink set slightly off the clay like a print that slipped.

## When to use

- It is the only mark. Its colors (`mark-clay`, `mark-ink`, `mark-ink-light`, `mark-tile`, `mark-hairline`) are its own: fixed, the same in every theme, and used nowhere else. Never recolor it, never set it inside another tile or frame, and never place it beside a Claude or Anthropic logo.
- The bell has no tile (owner, 2026-10-30). Where it shows, and how:

| Where | Size | Look |
| --- | --- | --- |
| The owner app's sidebar, in the lockup with the `Wordmark` and its "Preview" badge | 36 px | No tile, light ink |
| The phone top bar, beside the business's name | 20 px | No tile, light ink |
| "Powered by Claude Desk" in the public page's footer | 16 px | No tile, light ink |
| The first-visit intro dialog, beside the `Wordmark` and its "Preview" badge | 20 px | No tile, light ink |
| A standalone page and the owner app while it opens, beside the `Wordmark` | 20 px | No tile, light ink |
| The intro illustration's reply card, alone in an avatar's place | 32 px | No tile, dark ink (`ground="light"`) |
| The About pages' top bar, beside the `Wordmark`: with its "Preview" badge on the desktop bar, the name alone on the phone bar | 20 px | The white tile (`tile`) |
| The browser tab (`favicon.svg`) | The browser's | No tile: dark ink on a light tab bar, light ink on a dark one |

- On the dark grounds (every ground in the app) the ink is `mark-ink-light`. On a light ground, `ground="light"`, it keeps the drawing's dark ink, `mark-ink`.
- `tile` draws the white tile with its hairline edge and the drawing's dark ink. Only the About pages' top bar uses it. A guard (`mark_tile_only_on_the_about_top_bar` in `web/src/app/guards.test.ts`) reads every TypeScript file under `web/src/` and allows a tile in two places only: once in `web/src/about/ReaderPage.tsx`, inside its `Brand` (the About top bar), and in the design system's stories. Every other file fails it, the About pages' other files included, whether the `Mark` tag passes `tile` itself, under an imported or local name (`Mark as Bell`, `const Bell = Mark`), as a namespace's member (`<DS.Mark tile />`), or through a spread of props that could carry it.

## What the consumer provides

- A `size` from the table above, and a `ground` only on a light ground.
- The name written out next to it (`Wordmark`, or text): the mark is `aria-hidden`.

## Props

`Mark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `size` | `16 \| 20 \| 24 \| 32 \| 36` | 20 by default. |
| `ground` | `'dark' \| 'light'` | `dark` by default: the light ink. `light` keeps the drawing's dark ink. Not with `tile`. |
| `tile` | `boolean` | The white tile, in the drawing's own colors. Only on the About pages' top bar. |

`Wordmark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `preview` | `boolean` | Adds the "Preview" badge 8 px to the name's right: a `Pill` with `caps`, its word drawn in capitals by `.cd-type-badge-caps`, the product's one all-caps label. |

`Wordmark` sets "Claude Desk" in serif (`.cd-type-wordmark`), on one line with its badge, centred; the name never wraps. In the sidebar the lockup is the 36 px mark, then the wordmark 10 px on, all centred on one line (owner, 2026-10-30).

## Geometry

`mark.svg`, in this folder, is the mark's signed drawing, on a 100-unit grid: the white tile, then the bell in the drawing's colors. `npm run gen:mark` (`scripts/gen-mark.mjs`) reads it strictly and generates two files from it, never edited by hand:

- `markGeometry.ts`, `MARK_GEOMETRY`: the tile (x 0.5, y 0.5, 99 by 99, corner radius 22), the transform that places the bell inside it, one clay path, and the ink's six paths and twelve round dots. `Mark` draws from it, with the tile or without.
- `favicon.svg`, the page's icon: the bell without its tile, its ink the drawing's dark ink, and the light ink under `@media (prefers-color-scheme: dark)` inside the icon, so one file reads on a light tab bar and on a dark one. `web/index.html` links it, so the build emits it under a hashed name.

The light ink (`LIGHT_INK`, `#faf9f5`) is the generator's one variant of the drawing. A unit test (`scripts/gen-mark.test.mjs`) fails when either file or the `mark-*` tokens drift from the drawing, and `node scripts/gen-mark.mjs --check` fails when either file is stale. The reader refuses anything else in the drawing, so a redraw keeps the same structure: the tile, then the clay group, then the ink group.
