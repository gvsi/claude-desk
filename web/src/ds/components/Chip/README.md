# Chip

`Chip` is an outlined pill button for a suggestion, a filter or one option among a few.

## When to use

- Suggestions under the composer ("What happened overnight?"): no `selected`, so there is no state to announce.
- Filters that toggle on and off: pass `selected`, announced as `aria-pressed`.
- One choice among a few: `asRadio` with `selected`, announced as `role="radio"` and `aria-checked`.

## What the consumer provides

- The words, short and in sentence case.
- For radio chips, the `role="radiogroup"` element around them with an `aria-label`, and the selection itself: a chip only reports clicks.

## Keyboard

- Radio chips take the radio group's keyboard themselves (WAI-ARIA radio group). The group is one tab stop: the chosen chip, or the first while none is chosen.
- Right and Down move to the next chip, Left and Up to the previous, wrapping at the ends; Home and End go to the first and the last. The chip they land on is chosen, through its `onClick`. Space chooses the focused chip.
- A chosen chip shows a check as well as the `bg-selected` fill, so being chosen never rests on the fill alone.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required; in `.cd-type-pill`. |
| `selected` | `boolean` | Left out for a suggestion. |
| `asRadio` | `boolean` | `role="radio"` with `aria-checked`, one tab stop per group and the arrow keys. |
| `disabled` | `boolean` | Off: dimmed to 40%, as a disabled `Button` is, with no hover or press, out of the tab order, and a press does nothing. |
| `onClick` | `(event) => void` | Required. |

28 px tall with a 1 px `line-control` outline, `line-control-hover` and a `fill-hover` fill on hover. The outline is decorative: the chip's words identify it.

On a coarse pointer, an unseen, centred hit area reaches `size-touch` (44 px) wherever there is room. Safety's filter rows and their design boards cap both axes at half their 8 px gaps, giving one-line chips a 36 px tall target without overlapping adjacent chips or rows. Layout containment on those flex-row chips prevents added scroll; standalone inline chips keep their text baseline. Nothing visible changes.

Custom layouts with closer neighbours must set `--cd-touch-reach-block` and `--cd-touch-reach-inline` to half their gaps, like `Button`. `SuggestionChips` keeps its existing row-specific hit area and scroll containment.
