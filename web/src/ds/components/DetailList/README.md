# DetailList

`DetailList` shows read-only details in one card, such as the business on Settings › General: a row each, its label over its value.

## When to use

- On Settings › General, under the `SectionHeader` "Your business": Business, This Desk, Customers see you as, Time zone and Hours, as N-Run2-Settings-General and N-Run2-Settings-Phone draw them.
- Not for a connection's details beside their terms, which are `ConnectionPanel`'s, and not for anything the owner turns on or off, which is a `Switch`.

## What the consumer provides

- `items`, in order: each detail's `label` ("Customers see you as") and its `value` in words ("Mike Turner"). The screen writes the values: the time zone's name and the Desk's hours ("Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm"); nothing here formats a time.
- The heading over the card and the section that holds it: a `section` `aria-labelledby` its `SectionHeader`, 8 px over the card.

## What it shows

- One card (`Card` with no padding: `fill-card`, a `line-card` border at `radius-card`), ruled in `line-hairline` between its rows.
- Each row padded 12 px by 16 px: the label in `meta`, `text-secondary`, and 2 px under it the value in `body`, `text-primary`. A one-line row is 64 px, 65 with its hairline. A long value wraps inside its row; nothing scrolls sideways.
- Read-only: no buttons, links or fields, and no "Change" control. The boards draw a ghost "Change" at the right of each row; the details stay read-only, with no Change (owner decision, 2026-10-30).

## Accessibility

- A description list: each label a term (`dt`) and each value its definition (`dd`), grouped in a row, so a screen reader reads them as pairs.
- The values are the owner's own settings, marked `data-copy="user"`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `items` | `{ label: string; value: string }[]` | Required, in order. |
