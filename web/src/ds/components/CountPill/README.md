# CountPill

`CountPill` shows a small number on a faint fill, and screen readers hear what it means.

## When to use

- Counts beside a nav row or a section header: Conversations "2", Needs you "2".
- Never as a colored badge: it is `fill-count` with `text-secondary`, whatever it counts.

## What the consumer provides

- `count`, the number shown.
- `label`, the words read instead of the number, with the number in them: "2 need you", "2 blocked".

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `count` | `number` | Required. |
| `label` | `string` | Required; the `aria-label`. |

The pill has `role="img"` so its label is its name in every screen reader; a plain span's `aria-label` is ignored by some.
