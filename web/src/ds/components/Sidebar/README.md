# Sidebar

`Sidebar` is the owner app's navigation: the Claude Desk lockup, the business and Desk switchers, the pages in a fixed order, an optional "About this prototype" group, the owner app's concept line on desktop, the Claude acts for you switch and the owner.

## When to use

- As the `AppShell`'s `sidebar`, on every owner screen. The shell gives it its column (`size-sidebar` on `bg-panel`, with a `line-hairline` seam), or a sheet on a narrow screen.
- Not on visitor surfaces.

## What it shows

- The lockup, on one line and centred (owner, 2026-10-30): the 36 px `Mark` with no tile, in its light ink; 10 px on, the "Claude Desk" wordmark; 8 px on, the "Preview" badge (`Wordmark preview`), a `Pill` drawn in capitals. It links to `hrefs.today` through `linkComponent`, named "Claude Desk Preview, go to Today", without marking it as the current page. The row is 50 px tall with its padding, as the stacked lockup was, so nothing under it moves.
- The business row, "Switch business, current: {business}", outlined with `line-control` and `radius-control`, with no resting fill and `fill-hover` on hover, which calls `onSwitchBusiness` (the screen opens `SwitcherMenu`, which lists businesses and "New business"). A name too long for the row is cut with an ellipsis, and its `title` holds it in full, so it can still be read.
- The Desk picker, "Switch Desk, current: {name}", only when the business has two or more Desks. It is where the owner picks a Desk; `SwitcherMenu` lists none. It opens the business's Desks under it ("Desks in {business}"), the current one marked with a check and `aria-current`. Picking a Desk calls `onSwitchDesk(id)`; picking it, or Escape, closes the list and returns focus to the picker. Escape stops there, so a sheet the sidebar sits in stays open.
- The pages, always in this order: Today, Conversations, {peopleLabel}, Rules, Connectors, Safety, Notifications, Profile, Share, Knowledge, Settings. Each row is `size-nav-row` tall, `space-2` apart, with a 20 px line icon named for its page (Connectors' is a plug, Notifications' a bell). The current page is on `bg-selected` with `aria-current="page"`; there are no accent bars.
- Connectors only when the app has that page: without `hrefs.connectors` there is no Connectors row, and Safety follows Rules one row down, with no gap; nothing else moves. Notifications the same: without `hrefs.notifications` there is no Notifications row, and Profile follows Safety. The owner app has Notifications (REV-NOTIF puts it under Safety), so ten rows, and eleven once Connectors is built; the boards drawn before it have neither, or Connectors alone.
- Counts only on Conversations, Safety and Notifications, as `CountPill`s read by their `label` ("2 need you", "2 blocked", "1 unread"). Safety's `attention` adds a held dot beside its count.
- With `about`, the "About this prototype" group, above the concept line and the Claude acts for you block, behind its own hairline (14 px above its title):
  - the title in `caption` type and `text-secondary`, which also names the group's navigation ("About this prototype");
  - one row per link, laid out like the nav's rows, with the 20 px `document` icon by default; `icon` can name another icon. The app places GitHub after Vision, with `github`, `external: true`, and the repository URL. External rows use a native link with `target="_blank"`, `rel="noreferrer"`, and “(opens in a new tab)” in their accessible name;
  - the link marked `current` is `aria-current="page"` on `bg-selected`, and then the main nav marks no row, so one page is current;
  - in the keyboard order, after the main nav and before Claude acts for you. On a narrow screen, `AppShell`'s sheet shows the same sidebar, so the same group.
  Without `about`, nothing is drawn and nothing else moves: the foot stays at the bottom.
- With `conceptFooter`, the same `ConceptFooter` caption and author link appear directly below About and above Claude acts for you in the wide AppShell. It wraps inside the column using existing spacing tokens. In the compact shell it is absent, and the owner page carries the line at its bottom. Vision sidebars and the landing preview leave the option off.
- When the window is too short for it all, the nav and the about group scroll inside the column, between the pinned top (the lockup, the business row and the Desk picker) and the pinned foot, so the Claude acts for you switch and the owner always show. The scrolling part reaches 4 px past its rows, so a focused row's edge is never clipped, and at normal heights every row sits where it would without it.
- At the foot, above a hairline: the "Claude acts for you" `Switch` with "Within your rules" while on and "Taking messages only" while off, then the owner: an initials avatar (`aria-hidden`, the first letters of the first and last words of the name, as written) beside the name and a status line. The owner row isn't a control.

## What the consumer provides

- `business`, `desks`, `currentDeskId` and `owner` from the owner's Desks; names are shown as written.
- `current` and `hrefs`, one per `NavKey`, where `connectors` and `notifications` may be left out while the app has no such page; `linkComponent` when the app has a router link (it gets `href`, `className`, `aria-current` and `children`, like `<a>`).
- `peopleLabel`, the business's word for the people it serves ("Customers", "Clients").
- `counts`, each `{ n, label }`, with the number in the label's words.
- `answering` and `onAnsweringChange`. The owner layout asks for confirmation in a `Dialog` before sending the save, for this switch and Settings' switch. Cancelling leaves the setting alone. The switch shows whatever `answering` the screen passes back, so a failed change can revert it.
- `answeringDescription`, an optional replacement for the line while on. All current Desks use "Within your rules". Off always says "Taking messages only".
- `about`, for the prototype's own documents: the group's `title` and its `links`, each `{ id, label, href, current?, external?, icon? }`. The words are the screen's.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `business` | `string` | Required. |
| `onSwitchBusiness` | `() => void` | Required. |
| `desks` | `{ id: string; name: string }[]` | Required. The picker shows with two or more. |
| `currentDeskId` | `string` | Required. |
| `onSwitchDesk` | `(deskId: string) => void` | Required. Not called for the current Desk. |
| `current` | `NavKey` | Required. `'today' \| 'conversations' \| 'people' \| 'knowledge' \| 'rules' \| 'connectors' \| 'safety' \| 'notifications' \| 'profile' \| 'share' \| 'settings'`. With no Connectors or Notifications href, that key marks no row. |
| `hrefs` | `SidebarHrefs` | Required. An href for every `NavKey`; `connectors` and `notifications` are optional, and without one its row isn't drawn. |
| `brandHref` | `string` | The lockup's destination, independent of the nav rows. Defaults to `hrefs.today`; vision pages pass `/`. |
| `brandDestination` | `'today' \| 'home'` | Defaults to `today`. Appends "go to Today" or "home" to the accessible name, after the visible name and Preview badge. |
| `peopleLabel` | `string` | Required. The third row. |
| `counts` | `{ conversations?: NavCount; safety?: NavCount & { attention?: boolean }; notifications?: NavCount }` | `NavCount` is `{ n: number; label: string }`. |
| `answering` | `boolean` | Required. |
| `onAnsweringChange` | `(answering: boolean) => void` | Required. |
| `answeringDescription` | `string` | The line while on. "Within your rules" by default. |
| `owner` | `{ name: string; status: string }` | Required. |
| `linkComponent` | `ComponentType<SidebarLinkProps>` | A plain `<a>` by default. Internal about links use it too; external links use a native anchor. |
| `conceptFooter` | `boolean` | Adds the owner app's concept line under About in the wide shell only. Off by default. |
| `about` | `SidebarAbout` | `{ title: string; links: { id: string; label: string; href: string; current?: boolean; external?: boolean; icon?: IconName }[] }`. Left out, no group. |

`NavKey`, `NavCount`, `SidebarHrefs`, `SidebarLinkProps`, `SidebarAbout` and `SidebarAboutLink` are exported with the component, and `initialsOf(name)`, the owner avatar's initials, which `SwitcherMenu`'s monograms share. `NAV_LABELS` holds each row's label by key (people's row is `peopleLabel`), so a page can name itself, such as its tab's title, in the sidebar's words.

## Loading shapes

`SidebarSkeleton({ rows, about, conceptFooter })` draws the fresh copy's lockup, business row, page rows, About group and footer from the sidebar's own classes. The app passes ten page rows, with Notifications, until Connectors is built and its actual About link count. With `conceptFooter`, it draws the same fixed caption using `ConceptFooter skeleton`, at the landed line's `owner-footer` anchor. It draws no business words or controls; put it inside `SkeletonScreen`'s hidden, inert layer. A business with two Desks lands its picker in one accepted move. The companion stories compare the real column and shapes within 2 px at 1512 and 390.
