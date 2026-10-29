# Mark

`Mark` draws the Claude Desk mark, a rounded square with one horizontal line stroked in clay.

## When to use

- At the top of the owner app's sidebar, beside the `Wordmark`, and in "Powered by Claude Desk" on the public page.
- It is the only mark and the only use of `clay`. Never recolor it, never put it on a light ground, and never place it beside a Claude or Anthropic logo.

## What the consumer provides

- A `size`: 20 px in the sidebar, 16 px at the smallest, 24 px at most.
- The name written out next to it (`Wordmark`, or text): the mark is `aria-hidden`.

## Props

`Mark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `size` | `16 \| 20 \| 24` | 20 by default. |

`Wordmark`:

| Prop | Type | Notes |
| --- | --- | --- |
| `beta` | `boolean` | Adds "Beta" beneath the name in `.cd-type-beta`, `text-secondary`. |

`Wordmark` sets "Claude Desk" in serif (`.cd-type-wordmark`). In the sidebar the lockup is the 20 px mark, 2 px down, then the wordmark, 10 px apart.

## Geometry

`MARK_GEOMETRY` (`markGeometry.ts`) holds the mark's shapes on its 20-unit grid: `rect` x 2.75, y 2.75, 14.5 by 14.5, corner radius 4; `path` `M6.5 11.5h7`; stroke 1.5 with round caps and joins. `Mark` renders from it and so does the design system artifact's standalone SVG, so the two can't drift.
