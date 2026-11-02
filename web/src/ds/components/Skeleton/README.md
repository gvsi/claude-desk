# Skeleton

`Skeleton` draws a page, or a part of one, as its own quiet shapes while its first read is out, with one band of light sweeping across them; `SkeletonScreen` is the region that waits, sweeps, speaks and fades, and `SkeletonCard` is a real card holding shapes.

## When to use

- A page or a part of a page whose first read is out: the owner app's full-page loader, a page's list while it is read, the visitor's chat while it opens. The shapes stand where the content will be, so the content lands where they were.
- Not an action at work, such as a click in flight: that is a busy `Button`. Not someone writing: that is `WritingIndicator`.
- Not the loaders that keep `LoadingLine`: a customer's page, All rules, a rule draft and its change, the Demo inbox's open sheet, the connector review inside setup's tools step, setup's live step while its Desks are read on a reload, and the agents page's run panel, whose line is an action at work.
- A revisit whose reads are cached draws the page at once: `loading` is false from the start, so no skeleton mounts.

## What the consumer provides

- `SkeletonScreen`'s `loading`: true while a read the part's first view depends on is out, with no data and no failure yet. A part keeps its skeleton until every read that shapes its first view has settled, data or error, secondary reads included.
- `status`: the existing loading words, in the reader's language ("Opening your Desk", "Abriendo el chat"). A skeleton draws no words of its own.
- `skeleton`: the part's shapes, built from its own components' sizes (below).
- `children`: the part itself, drawn once `loading` is false: its content, its empty state or its error with "Try again".
- `lang`, when the status's language differs from the page's, as the public chat's does in setup's preview.

## Building a page's skeleton

- Build it from the page's own layout classes and its components' own classes, so each shape sits where the real element will: a `PersonRow`'s shapes inside a `div.cd-person-row`, a card's inside a `SkeletonCard` with the real card's padding. Then the content lands where the shapes were, and nothing jumps.
- Draw what a fresh copy's first view draws. Where a part comes and goes with the Desk's data, draw it as a fresh copy shows it.
- Name the shapes a screen test compares with `anchor`; each lands as `data-skeleton-anchor`.
- Keep real what the page already knows: a page's header inside the app, the public chat's footer. The one text a skeleton draws is the real `ConceptFooter`, wherever the real page shows it.
- Never put a price, a date, a name, a message or a status on a skeleton.

## The shapes

Shapes are `fill-hover`. A line is a `radius-full` pill centred in its type style's line box, so a line and the words that replace it share their top edge and can be compared within 2 px. A line takes the style's `cd-type` class and is `1lh` tall, so its box follows the type tokens.

| `text` | Line box (px) | Pill (px) |
| --- | --- | --- |
| `caption`, `meta`, `pill` | 17, 18, 16 | 10 |
| `body`, `control`, `section`, `message`, `reply` | 20, 20, 20, 21, 23 | 12 |
| `brand-name`, `summary` | 22, 27 | 14 |
| `page-title`, `figure-small` | 32, 32 | 24 |
| `figure`, `greeting` | 40, 44 | 32, 36 |

- A line is as wide as its row unless it is given a `width`.
- A block takes its `width`, its `height` and its corners: `radius-control` by default, or `radius-card`, `radius-composer` or `radius-full`.
- A circle is `size-avatar` across unless it is given a `size`.
- `SkeletonCard` is `Card`'s own classes: the 1 px `line-card` border, `fill-card`, `radius-card` and Card's padding, 20, 16 or 0. Cards keep their real border and fill. As with `Card`, a card with no padding holds rows that pad themselves (12 px by 16 px for a connector section's), so the hairlines between them run edge to edge; never bare shapes against its border.

## The sweep

- One band of light sweeps the whole screen, left to right: `size-skeleton-band` (900 px) wide, `fill-secondary` at its centre and transparent at both ends, over each shape's `fill-hover`, on `motion-writing` (1.6 s, the writing indicator's loop) at an even speed, from one band's width left of the viewport to one band's width right of it.
- Its ends are transparent, not `fill-hover` as the signed boards draw them: a `fill-hover` end paints the translucent fill twice inside the band and once outside it, which draws a hard edge stronger than the light itself (41, then 53 one pixel inside the band on `bg-app`). The peak is the boards'.
- Every shape shows the same band at the same moment. As a shape mounts, it starts its sweep at the document's time 0 (Web Animations), so a shape that mounts later, or in a region that takes over from another, is at the same point of the loop.
- The band lines up in viewport coordinates on every browser, by each shape's measured offset, not a fixed background: iOS Safari ignores a fixed background, and a phone is where most people open a public chat link. As a shape mounts it takes its left edge in the viewport as `--cd-skeleton-x`, which the sweep subtracts from the band's offset, so every shape shows the band at the same viewport x. Its `SkeletonScreen` places every shape again when the region resizes (one `ResizeObserver`) or the window does (which can move a region without resizing it), and once more on the next frame, so a responsive layout that commits after those callbacks (the app shell dropping its column) can't leave stale offsets. Vertical scrolling doesn't move a horizontal band, so scroll needs no measuring.
- Both ends of the sweep's keyframes are written out: WebKit takes an implicit start from the shape's style as it is drawn mid-sweep when `--cd-skeleton-x` changes, which puts the band in the wrong place.
- `Skeleton.browser.test.tsx` (Chromium) and `Skeleton.webkit.test.tsx` (WebKit, the `ds-webkit` project) check that the band's centre sits at the same viewport x on every shape, within 1 px, after a resize and after a layout that moves shapes without resizing their region, and that the band's edge draws no step on `bg-app`.
- Under `prefers-reduced-motion: reduce` the shapes are still: `fill-hover`, with the band out of view.
- This sweep, while a page loads, is the one exception to "no shimmer or gradient washes" in the design system.

## The states

`SkeletonScreen` is `div.cd-skeleton-screen`. Its first child is a visually hidden `p[role=status]`, its second `div.cd-skeleton-screen__body`, which holds the layer (`div.cd-skeleton-screen__layer`, with `data-state`) and, once loaded, the part.

| `data-state` | When | What it does |
| --- | --- | --- |
| `waiting` | while loading, for `SKELETON_DELAY_MS` (200 ms) after it mounts | Laid out in flow and invisible, so it already holds the part's space and nothing under it moves when it shows. The status is empty, so a fast load says nothing, as it shows nothing. |
| `shown` | after the wait; or at once when it mounts inside a region whose layer is shown or leaving, or in the commit that region's shown shapes go at once under reduced motion (a hand-off) | The shapes show and sweep. The status holds the loading words. |
| `leaving` | the load ended while the shapes showed | The part draws in flow, and the layer lies over it at the same top-left on `bg-app` and fades out on `motion-fast` with `motion-ease`. It rests at opacity 0, so a layer whose fade can't run is invisible at once, and pointer events pass through it to the part. It goes when its own fade ends or is cancelled, or after a fallback timer if neither comes. |
| (no layer) | the load ended during the wait, or under reduced motion, or it was never loading | The part alone, at once, with no fade. |

- If `loading` turns true again, the region goes back to `waiting`.
- A hand-off lasts while the outer layer fades, or under reduced motion for the commit the part lands in. A region that mounts in the part later, with no shapes on screen, waits as usual.
- There is no minimum time on screen: a load that ends just after the wait shows the shapes briefly, and the fade softens it.
- The body is `aria-busy="true"` only while loading. The region takes `position: relative` only while leaving, so it never changes how the part lays out its own positioned children.

## Accessibility

- The status is in the DOM from the region's mount, outside every busy element, so a screen reader announces the loading words once, when the shapes show. It empties when the load ends.
- The layer is `aria-hidden` and `inert` (set as an attribute, since the pinned React types have no `inert` prop), and nothing in it can take focus. Every shape and `SkeletonCard` is `aria-hidden` too.
- A page that keeps its heading out of view while loading keeps a visually hidden `h1`.
- After a load, axe and the screen basics pass as before.

## Props

`Skeleton`:

| Prop | Type | Notes |
| --- | --- | --- |
| `shape` | `'line' \| 'block' \| 'circle'` | Required. |
| `text` | `SkeletonText` | A line's type style, `body` by default. |
| `width` | `number \| string` | A line or a block: px, or any CSS length or percentage. A line is `100%` by default. |
| `measure` | `ControlMeasurement` | A block for a text-sized control: its existing `label` and control CSS `className`, with optional `tagName`, `contentClassName` and `suffix`. Its browser-measured width takes precedence over `width`. |
| `height` | `number \| string` | A block: px, or any CSS length. |
| `size` | `number` | A circle's diameter in px, 28 (`size-avatar`) by default. |
| `radius` | `'control' \| 'card' \| 'composer' \| 'full'` | A block's corners, `control` by default. |
| `anchor` | `string` | Names the shape for screen tests, as `data-skeleton-anchor`. |
| `className` | `string` | For the screen's own layout: a grid area, a breakpoint rule. |

Use `measure` for a button or chip whose label sets its width. An empty, hidden probe uses the real control's type token, padding and borders; canvas measures the label without putting words in the shape. A suffix can name its own text and CSS, or a CSS width for a fixed icon slot. The measurement requests the font, waits for `document.fonts.ready`, and repeats when later fonts finish loading. A fixed layout slot and an approximate text line can still use `width`.

`SkeletonCard`:

| Prop | Type | Notes |
| --- | --- | --- |
| `padding` | `0 \| 16 \| 20` | As `Card`'s: 20 by default, 16 for a compact card, 0 for rows that pad themselves. |
| `anchor` | `string` | As `Skeleton`'s. |
| `className` | `string` | For the screen's own layout. |
| `children` | `ReactNode` | Required. The shapes it holds. |

`SkeletonScreen`:

| Prop | Type | Notes |
| --- | --- | --- |
| `loading` | `boolean` | Required. True while a read the part's first view depends on is out. |
| `status` | `string` | Required. The existing loading words, in the reader's language. |
| `skeleton` | `ReactNode` | Required. The part's shapes. |
| `children` | `ReactNode` | The part, drawn once `loading` is false. |
| `className` | `string` | Places the region in the screen's layout. |
| `lang` | `string` | The status's language, when it differs from the page's. |

## Stories

The signed boards (`UXC-P1201-After`, `#artboard-dec46cf506e4`, and `UXC-P1202-After`, `#artboard-d122e70134a0`) aren't in the reference list, so the stories say `canvas: 'none'` and name them in their notes.

- `Shapes`: every line, block, circle and card, each named beside it.
- `Sweep`: the head of Today as shapes, sweeping as one band; a part mounts 300 ms later in step.
- `Waits`, `FastLoad`, `Lands`, `Continues` and `Fails`: the states, as Customers loads.
- `Spanish`: the visitor's chat as shapes at 390, with its status in Spanish.

The wait starts after mount observers and checks a monotonic deadline before showing, so a browser timer that fires just short of 200 ms cannot expose an early frame. Unmounting or ending a fast load cancels the pending wait. A wait that comes due just as the part lands, which React can apply after the render that ended the load (a store read through `useSyncExternalStore`, such as React Query's, renders ahead of the wait's update), never brings the shapes back: once the part has landed the region neither waits nor shows, and a part that loads again waits afresh.
