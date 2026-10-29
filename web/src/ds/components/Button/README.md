# Button

`Button` starts an action, in one of three weights and two heights, and says exactly what happens.

## When to use

- `primary` for the one action a view is about ("Send counter-offer", "Join the chat"): an inverted neutral, at most one per view.
- `secondary` for the other actions beside it, such as the four answers on an approval card.
- `ghost` for quiet actions that shouldn't compete ("Start over", "Mark done").
- `size="main"` for a screen's main actions (`size-control-main`, 40 px); `inline` (`size-control`, 32 px) everywhere else.
- With `href`, the same look as a link: the button a payment or document card ends with ("Open payment page").

## What the consumer provides

- The label, in words that say what happens. Never "OK" or "Continue" when a verb can say more, and never an arrow.
- `busy` while the click's request is in flight. The button keeps focus, dims a little (its label still reads at 4.5:1), announces `aria-busy` and ignores further clicks; change the label too if the wait is long ("Sending").
- `disabled` only when the action can't be taken at all. A disabled button is dimmed and leaves the tab order.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'ghost'` | Required. |
| `size` | `'inline' \| 'main'` | `inline` by default. |
| `type` | `'button' \| 'submit' \| 'reset'` | `button` by default, so it never submits a form by accident. |
| `href` | `string` | Renders an `<a rel="noopener noreferrer">`. A disabled or busy link loses its `href` and says `aria-disabled`. |
| `disabled` | `boolean` | Native `disabled`. |
| `busy` | `boolean` | `aria-busy` and `aria-disabled`; clicks are swallowed. |
| `onClick` | `(event) => void` | Not called while disabled or busy. |
| `children` | `ReactNode` | The label, in `.cd-type-control` (primary at weight 500). |

Hover fills change at `motion-instant`; a press scales to 0.98 at `motion-fast` with `motion-ease-emphasis`. Nothing moves under reduced motion.
