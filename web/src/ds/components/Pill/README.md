# Pill

`Pill` is a short label in a thin outline, such as a visitor's level.

## When to use

- A visitor's level beside their name: "Public", "Verified", "Agent".
- A short standing fact about a page or a payment, such as "Vision" or "Test payment, no money moves"; put a `StatusDot` first when the fact has a status.
- Not for actions (use a `Chip`) and not for counts (use a `CountPill`).
- `caps` is the lockup's "Preview" badge (`Wordmark preview`) and nothing else: the product's one all-caps label.

## What the consumer provides

- One or two words in sentence case, optionally led by a `StatusDot`.

## A vision note

A page the prototype only sketches (Settings › Alerts and Billing) opens with a vision note, as N-Run2-Settings-Notifications and N-Run2-Settings-Billing draw it: the `Pill` "Vision", then `space-12` after it, one line in `meta`, `text-secondary`, saying what the prototype does instead ("In this prototype, alerts arrive in Notifications.", "Nothing is billed in this prototype."), the two centered on one row. The screen lays the row out; the Pill is the only component in it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required; in `.cd-type-pill`. |
| `caps` | `boolean` | Only for the "Preview" badge: `.cd-type-badge-caps`, 11 px with 0.06em tracking, its word drawn in capitals, marked `data-ds="preview-badge"` for the copy check. |

20 px tall, outlined in `line-control`, never filled and never colored.
