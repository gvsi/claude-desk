# SwitcherMenu

`SwitcherMenu` lets the owner move between their businesses, or start a new business. It lists businesses only: the current business's Desks are picked in the sidebar's Desk picker.

## When to use

- When the sidebar's business row ("Switch business, current: {business}") is pressed (`Sidebar`'s `onSwitchBusiness`). The screen renders it beside the row and removes it in `onClose`.
- Inside the `AppShell`'s compact sheet, render it inside the `sidebar` node (for example, as a sibling of the `Sidebar` in a fragment). The sheet is modal, so a menu outside it would be inert.

## What it shows

- A `role="menu"` named "Switch business", on `bg-surface` with a `line-card` border at `radius-card` and no shadow. The screen positions it.
- Each business: an initials monogram (`aria-hidden`), the name, and how many Desks it has ("2 Desks", "1 Desk"). The current business has a check.
- A hairline, then "New business", always last.
- A business with no Desks says "No Desks yet" and can't be picked (`aria-disabled`).
- Business names are shown as written (`data-copy="user"`).
- Never the current business's Desks: those are in the sidebar's Desk picker ("Switch Desk, current: {name}").

## Keyboard and focus

- It opens with focus on the current business (or the first item).
- Down and Up move through every item and wrap; Home and End go to the first and last. Only the focused item is in the tab order.
- Enter, Space or a click picks an item. Escape, Tab or a press outside the menu closes it.
- When it closes, focus returns to the control that opened it, unless the owner has moved focus somewhere else (Tab, or a click on another control).

## What a pick does

| Item | Calls |
| --- | --- |
| Another business | `onPick({ businessId, deskId })` with its first Desk, then `onClose()` |
| The current business | `onClose()` only: nothing changes |
| New business | `onNewBusiness()`, then `onClose()` |

## What the consumer provides

- `businesses` in the order to list them, each with its Desks in order (the count, and the first is where a pick opens); `currentBusinessId`.
- `onClose`, which removes the menu. It is called after every pick too, so the screen closes the menu in one place.
- A press on the control that opened the menu is left to the screen, so that control can toggle it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `businesses` | `SwitcherBusiness[]` | Required. `{ id: string; name: string; desks: { id: string; name: string }[] }`. |
| `currentBusinessId` | `string` | Required. |
| `onPick` | `(pick: SwitcherPick) => void` | Required. `SwitcherPick` is `{ businessId: string; deskId: string }`. |
| `onNewBusiness` | `() => void` | Required. |
| `onClose` | `() => void` | Required. Escape, Tab, a press outside, and after every pick. |

`SwitcherBusiness` and `SwitcherPick` are exported with the component. Rows fill on hover and focus at `motion-instant`; the menu appears in place, and nothing moves under reduced motion.
