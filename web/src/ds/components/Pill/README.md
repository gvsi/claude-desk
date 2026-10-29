# Pill

`Pill` is a short label in a thin outline, such as a visitor's level.

## When to use

- A visitor's level beside their name: "Public", "Verified", "Agent".
- A short standing fact about a page or a payment, such as "Vision" or "Test payment, no money moves"; put a `StatusDot` first when the fact has a status.
- Not for actions (use a `Chip`) and not for counts (use a `CountPill`).

## What the consumer provides

- One or two words in sentence case, optionally led by a `StatusDot`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required; in `.cd-type-pill`. |

20 px tall, outlined in `line-control`, never filled and never colored.
