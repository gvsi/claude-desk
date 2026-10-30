# SegmentedControl

`SegmentedControl` chooses one of a few named options, shown side by side on a faint track with the chosen one raised.

## When to use

- Two to four short options that are all worth seeing at once: the Desk's mode ("Ask me first", "Automatic", "Custom", from `PRESET_WORDS`), or a view of the Safety page ("Attempts", "Every entry").
- Not for an on/off setting (use `Switch`), and not for long lists (use a menu).

## What the consumer provides

- `label`, what is being chosen. It is the radio group's accessible name ("Mode for this Desk"); put a visible label beside the control when the page doesn't already say it.
- `options` as `{ value, label }`, in the order shown, with short sentence-case labels.
- `value` and `onChange`. The control is controlled: a click or an arrow key calls `onChange` with the new value, and the control shows the `value` the screen passes back. Choosing the option that is already chosen calls nothing.
- `disabled` while the control takes no choice, such as while `HowClaudeWorks` drafts a preset: the group and every option carry `aria-disabled` (so focus stays where it is), clicks and keys do nothing, and the control is dimmed to 40%, as a disabled `Button` is.

## Keyboard

The group is one tab stop, on the chosen option (the first one when none is). Arrow Right or Down chooses the next option and moves focus to it, Arrow Left or Up the previous one, wrapping at both ends; Home and End choose the first and the last.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required; the `radiogroup`'s `aria-label`. |
| `options` | `readonly { value: T; label: string }[]` | Required. `T` is a string union. |
| `value` | `T` | Required; that option has `aria-checked="true"`. |
| `onChange` | `(value: T) => void` | Required. |
| `disabled` | `boolean` | Takes no choice; dimmed. |

Track `fill-count` at `radius-control` with a `space-2` inset; options 28 px tall in meta size at the control weight, `text-secondary`, with `fill-hover` on hover; the chosen option is `bg-selected` with `text-primary`. Colors change at `motion-instant`; nothing moves under reduced motion.
