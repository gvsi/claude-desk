# Switch

`Switch` turns one setting on or off, as a row with its label, a line saying what "on" means, and a neutral track.

## When to use

- A setting that can be turned back: "Claude acts for you" in the sidebar, "Customers can see this" on a knowledge note. The owner layout confirms changes to "Claude acts for you" with a `Dialog` before saving.
- Not for a choice between named options (use `SegmentedControl`). Actions that aren't settings use a `Button`, followed by a `Dialog` when they need confirmation.

## What the consumer provides

- `label`, the setting's name. It is the switch's accessible name.
- `description`, one line saying what "on" means ("Within your rules"). It is the accessible description, so the name stays short.
- `checked` and `onChange`. The switch is controlled: it calls `onChange` with the new value and shows the `checked` the screen passes back, so a screen that is still saving can keep the old value until the save lands. While it saves, `waiting` makes the switch ignore presses.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required; `.cd-type-control`. |
| `description` | `string` | `.cd-type-caption` in `text-secondary`; `aria-describedby`. |
| `checked` | `boolean` | Required; `aria-checked`. |
| `onChange` | `(checked: boolean) => void` | Required. Click, Enter and Space all call it. |
| `disabled` | `boolean` | Another write prevents changes: `aria-disabled`, focus kept and presses ignored, without `aria-busy`. |
| `waiting` | `boolean` | A change is being saved: `aria-busy` and `aria-disabled`, focus kept, presses ignored, and the look of the state last passed. |

The row is a `button` with `role="switch"` and fills its container's width. On: a `button-primary` track with a `bg-app` knob at the end. Off: a `fill-secondary` track with a `text-secondary` knob at the start, so the state reads from the knob's place and contrast, not from color alone. The row takes `fill-hover` on hover, and the knob slides at `motion-fast`; nothing moves under reduced motion.
