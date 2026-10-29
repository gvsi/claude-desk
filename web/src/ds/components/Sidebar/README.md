# Sidebar

`Sidebar` is the owner app's navigation: the Claude Desk mark, the business and Desk switchers, the seven pages in a fixed order, the Answering switch and the owner.

## When to use

- As the `AppShell`'s `sidebar`, on every owner screen. The shell gives it its column (`size-sidebar` on `bg-panel`, with a `line-hairline` seam), or a sheet on a narrow screen.
- Not on visitor surfaces.

## What it shows

- The mark and the "Claude Desk" wordmark with "Beta" beneath. They are not a link.
- The business row, "Switch business, current: {business}", which calls `onSwitchBusiness` (the screen opens `SwitcherMenu`).
- The Desk picker, "Switch Desk, current: {name}", only when the business has two or more Desks. It opens the business's Desks under it ("Desks in {business}"), the current one marked with a check and `aria-current`. Picking a Desk calls `onSwitchDesk(id)`; picking it, or Escape, closes the list and returns focus to the picker. Escape stops there, so a sheet the sidebar sits in stays open.
- The pages, always in this order: Today, Conversations, {peopleLabel}, Rules, Safety, Share, Settings. Each row is `size-nav-row` tall with a 20 px line icon. The current page is on `bg-selected` with `aria-current="page"`; there are no accent bars.
- Counts only on Conversations and Safety, as `CountPill`s read by their `label` ("2 need you", "2 blocked"). Safety's `attention` adds a held dot beside its count.
- At the foot, above a hairline: the "Answering" `Switch` ("Claude answers under your rules"), then the owner: an initials avatar (`aria-hidden`, the first letters of the first and last words of the name, as written) beside the name and a status line. The owner row isn't a control.

## What the consumer provides

- `business`, `desks`, `currentDeskId` and `owner` from the owner's Desks; names are shown as written.
- `current` and `hrefs`, one per `NavKey`; `linkComponent` when the app has a router link (it gets `href`, `className`, `aria-current` and `children`, like `<a>`).
- `peopleLabel`, the business's word for the people it serves ("Customers", "Clients").
- `counts`, each `{ n, label }`, with the number in the label's words.
- `answering` and `onAnsweringChange`. The switch shows whatever `answering` the screen passes back, so a failed change can revert it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `business` | `string` | Required. |
| `onSwitchBusiness` | `() => void` | Required. |
| `desks` | `{ id: string; name: string }[]` | Required. The picker shows with two or more. |
| `currentDeskId` | `string` | Required. |
| `onSwitchDesk` | `(deskId: string) => void` | Required. Not called for the current Desk. |
| `current` | `NavKey` | Required. `'today' \| 'conversations' \| 'people' \| 'rules' \| 'safety' \| 'share' \| 'settings'`. |
| `hrefs` | `Record<NavKey, string>` | Required. |
| `peopleLabel` | `string` | Required. The third row. |
| `counts` | `{ conversations?: NavCount; safety?: NavCount & { attention?: boolean } }` | `NavCount` is `{ n: number; label: string }`. |
| `answering` | `boolean` | Required. |
| `onAnsweringChange` | `(answering: boolean) => void` | Required. |
| `owner` | `{ name: string; status: string }` | Required. |
| `linkComponent` | `ComponentType<SidebarLinkProps>` | A plain `<a>` by default. |

`NavKey`, `NavCount` and `SidebarLinkProps` are exported with the component, and `initialsOf(name)`, the owner avatar's initials, which `SwitcherMenu`'s monograms share.
