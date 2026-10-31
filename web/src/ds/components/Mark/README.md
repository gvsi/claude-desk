# Mark

`Mark` draws the Claude Desk mark, a hand-drawn service bell on a white app tile: an uneven clay dome under black ink lines (the dome's outline, a looped knob, a small reflection, two sound waves and the counter line), the ink set slightly off the clay like a print that slipped.

## When to use

- At the top of the owner app's sidebar, beside the `Wordmark`, and in "Powered by Claude Desk" on the public page.
- It is the only mark. Its colors (`mark-tile`, `mark-clay`, `mark-ink`, `mark-hairline`) are its own: fixed, the same in every theme, and used nowhere else. Never recolor it, never draw it without its tile, and never place it beside a Claude or Anthropic logo.
- The tile's hairline edge sets it off on a light ground, so it can sit on either; on the dark grounds the white tile carries it.

## What the consumer provides

- A `size`: 20 px in the sidebar, 16 px at the smallest, 18 px on the intro illustration's reply card, 24 px at most.
- The name written out next to it (`Wordmark`, or text): the mark is `aria-hidden`.

## Props

`Mark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `size` | `16 \| 18 \| 20 \| 24` | 20 by default. |

`Wordmark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `beta` | `boolean` | Adds "Beta" beneath the name in `.cd-type-beta`, `text-secondary`. |

`Wordmark` sets "Claude Desk" in serif (`.cd-type-wordmark`). In the sidebar the lockup is the 20 px mark, 2 px down, then the wordmark, 10 px apart.

## Geometry

`mark.svg`, in this folder, is the mark's signed drawing, on a 100-unit grid, and the page's icon: `web/index.html` links it, so the build emits it under a hashed name. `npm run gen:mark` reads it into `MARK_GEOMETRY` (`markGeometry.ts`, generated, never edited by hand): the tile (x 0.5, y 0.5, 99 by 99, corner radius 22), the transform that places the bell inside it, one clay path, and the ink's six paths and twelve round dots. `Mark` draws from it, and a unit test (`scripts/gen-mark.test.mjs`) fails when the geometry or the `mark-*` tokens drift from the drawing. The reader refuses anything else in the drawing, so a redraw keeps the same structure: the tile, then the clay group, then the ink group.
