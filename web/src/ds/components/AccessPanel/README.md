# AccessPanel

`AccessPanel` shows what one colleague can and can't open on a team Desk, as two lists of quiet chips, with the owner's way to change it.

## When to use

- Beside a colleague's conversation on a team Desk (N-R2-Vision-TeamDesk), so the owner sees why Claude opened a file for them or held a request: "Jordan can open" calendar holds, shared docs and team notes; he "Can’t open" budgets or 1:1 notes.
- Only on the team Desk vision page for now: team Desks are vision, and nothing in the prototype grants access by role.

## What it shows

- A `section` `Card`, padded 16 px, named "{name}’s access".
- "{name} can open", the name set off as the owner's own words (`data-copy="user"`, first in its line), then its chips; "Can’t open", then its chips. Each heading line is in `control` type and names its list (`aria-labelledby`), so a screen reader says "Jordan can open, list, 3 items".
- Each chip is a list item, 28 px tall in a thin `line-control` outline, fully rounded, in `meta` and `text-primary`. Chips are words, not controls: no hover, no fill, no tab stop. They wrap 6 px apart, and a long one is cut off with an ellipsis rather than widening the panel.
- A list with nothing in it says "Nothing on this Desk." in secondary `meta` instead of an empty row.
- "Edit access", a secondary `Button`, the panel's one control.

## What the consumer provides

- `name`: the colleague's first name, as the owner wrote it.
- `canOpen` and `cantOpen`: what they can and can't open, in the owner's words and order.
- `onEditAccess`: opens the access editor (vision: the page passes a no-op).

## Layout

- The panel fills its column; the team Desk page gives it 260 px beside the conversation. Its parts stack 12 px apart, with "Can’t open" 16 px under the chips above it, as the board draws it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. The colleague's first name. |
| `canOpen` | `readonly string[]` | Required. In order. |
| `cantOpen` | `readonly string[]` | Required. In order. |
| `onEditAccess` | `() => void` | Required. "Edit access". |
