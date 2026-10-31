# TextLink

`TextLink` is an inline link in `accent-blue` with a quiet underline that firms up on hover.

## When to use

- Links inside or beside text: "See rule", "See the briefing", "Open the full trace".
- For an action that changes something, use a `Button`; a link only goes somewhere.

## What the consumer provides

- `href` and words that say where the link goes, never "click here".
- `external` when the link leaves Claude Desk: it opens a new tab with `rel="noopener noreferrer"`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `href` | `string` | Required. |
| `children` | `ReactNode` | Required. |
| `external` | `boolean` | Adds `target="_blank"` and `rel="noopener noreferrer"`. |

The underline is always there, so a link in a sentence never depends on its color alone; it sits at 40% strength and goes solid on hover.

## On a touch screen

Under a coarse pointer, a link on its own line, such as Today's "Open Safety" or "See all", takes a tap anywhere in a `size-touch` (44 px) band centred on its words, through an unseen hit area (`::after`). Nothing is drawn and no word moves. Where links sit closer together, the reach stops halfway to the neighbour, so two hit areas never overlap:

- A link in a list item reaches half of `space-8` above and below, as the public page's links for agents sit 8 px apart.
- A link in a reading page's running text (`article-body`, `article-body-phone`) keeps no hit area beyond its words: its line sits a few px from the next, where another link may be.
- A layout can cap the reach itself, at half its gap, with `--cd-touch-reach-block` (above and below) and `--cd-touch-reach-inline` (either side).
