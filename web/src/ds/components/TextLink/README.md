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
