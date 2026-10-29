# StatusDot

`StatusDot` is a 6 px dot in a status color, the only way status color appears in Claude Desk.

## When to use

- Beside words that say the same thing: a card's "Waiting for your answer", a receipt's status line, a Desk that is answering.
- `StatusLabel` puts the dot and its words together, in the surrounding type.
- Never on its own, never larger, never as colored text or a colored tile.

## What the consumer provides

- `tone`: `handled` (allowed or done, sage), `held` (needs you, gold), `refused` (blocked, rose) or `info` (a hollow dot in `text-secondary`).
- For `StatusLabel`, the words: "Handled", "Needs you", "Blocked".

## Props

`StatusDot`:

| Prop | Type | Notes |
| --- | --- | --- |
| `tone` | `StatusTone` | Required. The dot is always `aria-hidden`. |

`StatusLabel`:

| Prop | Type | Notes |
| --- | --- | --- |
| `tone` | `StatusTone` | Required. |
| `children` | `ReactNode` | Required; the words the dot stands beside. |

Every tone reaches 3:1 on `bg-app`, `bg-panel`, `bg-surface`, `bg-selected` and a card (`CONTRAST_PAIRS`).
