# Chip

`Chip` is an outlined pill button for a suggestion, a filter or one option among a few.

## When to use

- Suggestions under the composer ("What happened overnight?"): no `selected`, so there is no state to announce.
- Filters that toggle on and off: pass `selected`, announced as `aria-pressed`.
- One choice among a few: `asRadio` with `selected`, announced as `role="radio"` and `aria-checked`.

## What the consumer provides

- The words, short and in sentence case.
- For radio chips, the `role="radiogroup"` element around them with an `aria-label`, and the selection itself: a chip only reports clicks.
- A chosen chip shows a check as well as the `bg-selected` fill, so being chosen never rests on the fill alone.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required; in `.cd-type-pill`. |
| `selected` | `boolean` | Left out for a suggestion. |
| `asRadio` | `boolean` | `role="radio"` with `aria-checked`. |
| `onClick` | `(event) => void` | Required. |

28 px tall with a 1 px `line-control` outline, `line-control-hover` and a `fill-hover` fill on hover. The outline is decorative: the chip's words identify it.
