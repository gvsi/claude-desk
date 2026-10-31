# Sidebar

`Sidebar` is the owner app's navigation: the Claude Desk mark, the business and Desk switchers, the pages in a fixed order, an optional "About this prototype" group, the Answering switch and the owner.

## When to use

- As the `AppShell`'s `sidebar`, on every owner screen. The shell gives it its column (`size-sidebar` on `bg-panel`, with a `line-hairline` seam), or a sheet on a narrow screen.
- Not on visitor surfaces.

## What it shows

- The mark and the "Claude Desk" wordmark with "Beta" beneath. They are not a link.
- The business row, "Switch business, current: {business}", which calls `onSwitchBusiness` (the screen opens `SwitcherMenu`, which lists businesses and "New business").
- The Desk picker, "Switch Desk, current: {name}", only when the business has two or more Desks. It is where the owner picks a Desk; `SwitcherMenu` lists none. It opens the business's Desks under it ("Desks in {business}"), the current one marked with a check and `aria-current`. Picking a Desk calls `onSwitchDesk(id)`; picking it, or Escape, closes the list and returns focus to the picker. Escape stops there, so a sheet the sidebar sits in stays open.
- The pages, always in this order: Today, Conversations, {peopleLabel}, Rules, Connectors, Safety, Share, Settings. Each row is `size-nav-row` tall, `space-2` apart, with a 20 px line icon named for its page (Connectors' is a plug). The current page is on `bg-selected` with `aria-current="page"`; there are no accent bars.
- Connectors only when the app has that page: without `hrefs.connectors` there is no Connectors row, and Safety follows Rules one row down, with no gap; nothing else moves. With it, there are eight rows.
- Counts only on Conversations and Safety, as `CountPill`s read by their `label` ("2 need you", "2 blocked"). Safety's `attention` adds a held dot beside its count.
- With `about`, the "About this prototype" group, just above the Answering block behind its own hairline (14 px above its title):
  - the title in `caption` type and `text-secondary`, which also names the group's navigation ("About this prototype");
  - one row per link, laid out like the nav's rows, with the 20 px `document` icon;
  - the link marked `current` is `aria-current="page"` on `bg-selected`, and then the main nav marks no row, so one page is current;
  - in the keyboard order, after the main nav and before Answering. On a narrow screen, `AppShell`'s sheet shows the same sidebar, so the same group.
  Without `about`, nothing is drawn and nothing else moves: the foot stays at the bottom.
- When the window is too short for it all, the nav and the about group scroll inside the column, between the pinned top (the mark, the business row and the Desk picker) and the pinned foot, so the Answering switch and the owner always show. The scrolling part reaches 4 px past its rows, so a focused row's ring is never clipped, and at normal heights every row sits where it would without it.
- At the foot, above a hairline: the "Answering" `Switch` with its line, "Claude answers under your rules" unless the Desk passes its own (`answeringDescription`), then the owner: an initials avatar (`aria-hidden`, the first letters of the first and last words of the name, as written) beside the name and a status line. The owner row isn't a control.

## What the consumer provides

- `business`, `desks`, `currentDeskId` and `owner` from the owner's Desks; names are shown as written.
- `current` and `hrefs`, one per `NavKey`, where `connectors` may be left out until the app has a Connectors page; `linkComponent` when the app has a router link (it gets `href`, `className`, `aria-current` and `children`, like `<a>`).
- `peopleLabel`, the business's word for the people it serves ("Customers", "Clients").
- `counts`, each `{ n, label }`, with the number in the label's words.
- `answering` and `onAnsweringChange`. The switch shows whatever `answering` the screen passes back, so a failed change can revert it.
- `answeringDescription`, only where a Desk answers someone other than the public or under someone else's rules, as the vision boards draw it: "Claude answers your team under your rules" on a team Desk (N-R2-Vision-TeamDesk). Left out, the owner app's line.
- `about`, for the prototype's own documents: the group's `title` and its `links`, each `{ id, label, href, current? }`. The words are the screen's.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `business` | `string` | Required. |
| `onSwitchBusiness` | `() => void` | Required. |
| `desks` | `{ id: string; name: string }[]` | Required. The picker shows with two or more. |
| `currentDeskId` | `string` | Required. |
| `onSwitchDesk` | `(deskId: string) => void` | Required. Not called for the current Desk. |
| `current` | `NavKey` | Required. `'today' \| 'conversations' \| 'people' \| 'rules' \| 'connectors' \| 'safety' \| 'share' \| 'settings'`. With no Connectors href, `'connectors'` marks no row. |
| `hrefs` | `SidebarHrefs` | Required. An href for every `NavKey`; `connectors` is optional, and without it the row isn't drawn. |
| `peopleLabel` | `string` | Required. The third row. |
| `counts` | `{ conversations?: NavCount; safety?: NavCount & { attention?: boolean } }` | `NavCount` is `{ n: number; label: string }`. |
| `answering` | `boolean` | Required. |
| `onAnsweringChange` | `(answering: boolean) => void` | Required. |
| `answeringDescription` | `string` | The switch's line. "Claude answers under your rules" by default. |
| `owner` | `{ name: string; status: string }` | Required. |
| `linkComponent` | `ComponentType<SidebarLinkProps>` | A plain `<a>` by default. The about links use it too. |
| `about` | `SidebarAbout` | `{ title: string; links: { id: string; label: string; href: string; current?: boolean }[] }`. Left out, no group. |

`NavKey`, `NavCount`, `SidebarHrefs`, `SidebarLinkProps`, `SidebarAbout` and `SidebarAboutLink` are exported with the component, and `initialsOf(name)`, the owner avatar's initials, which `SwitcherMenu`'s monograms share.
