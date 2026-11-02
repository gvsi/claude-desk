# SegmentedControl

`SegmentedControl` chooses one of a few named options, shown side by side on a faint track with the chosen one raised.

## When to use

- Two to four short options that are all worth seeing at once: a view of the Safety page ("Attempts", "Every entry", N-Safety-Run1).
- Not for the Rules page's presets: a preset is a starting point the owner reviews, so it is a menu (`PresetMenu`), with nothing selected.
- Not for an on/off setting (use `Switch`), and not for long lists (use a menu).

## What the consumer provides

- `label`, what is being chosen. It is the radio group's accessible name ("What to show"); put a visible label beside the control when the page doesn't already say it.
- `options` as `{ value, label }`, in the order shown, with short sentence-case labels.
- `value` and `onChange`. The control is controlled: a click or an arrow key calls `onChange` with the new value, and the control shows the `value` the screen passes back. Choosing the option that is already chosen calls nothing.

## Keyboard

The group is one tab stop, on the chosen option (the first one when none is). Arrow Right or Down chooses the next option and moves focus to it, Arrow Left or Up the previous one, wrapping at both ends; Home and End choose the first and the last.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required; the `radiogroup`'s `aria-label`. |
| `options` | `readonly { value: T; label: string }[]` | Required. `T` is a string union. |
| `value` | `T` | Required; that option has `aria-checked="true"`. |
| `onChange` | `(value: T) => void` | Required. |

Track `fill-count` at `radius-control` with a `space-2` inset; options 28 px tall in meta size at the control weight, `text-secondary`, with `fill-hover` on hover; the chosen option is `bg-selected` with `text-primary` and a 1 px `line-field` edge, which reads 3:1 on the track in both themes, so the choice shows by more than its ink. The other options keep a clear edge of the same width, so choosing moves nothing. Colors change at `motion-instant`; nothing moves under reduced motion.

On a coarse pointer, each option takes taps through an unseen, centred `size-touch` (44 px) target. Adjacent options cap their inline reach at half the 2 px gap; a single option can reach 44 px on both axes. The track, labels and inline baseline stay in place. A tighter surrounding layout can cap the block reach with `--cd-touch-reach-block`, like `Button`.
