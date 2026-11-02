# AppShell

`AppShell` is the owner app's frame: an optional banner across the top, the sidebar in its column, and the page beside it.

## When to use

- Once, around every owner screen. Visitor surfaces use `PublicShell`.

## Layout

- The shell is the height of the window. The `banner` runs full width across the top. Under it, the sidebar column and the page scroll on their own. The document itself never scrolls: the main area and the column are positioned, as is the Ask Claude panel's conversation, so anything absolutely placed in them, such as a receipt's screen-reader label, scrolls with them instead of stretching the document behind the shell. Because the main area is positioned, anything from the banner, the column or the top bar that reaches over the page sets `z-index: 1`, as the business switcher does.
- The column is `size-sidebar` wide on `bg-panel`, with a `line-hairline` seam at its right. It is an `aside` named "Claude Desk", holding the `Sidebar`.
- The page is a `main` (the target of Skip to content), padded 24 px at the top, 40 px at the sides and 20 px at the bottom (16 px at the top and sides on a phone). Its content is at most `size-content` wide, centered.
- With `fill`, the page takes the whole main area instead: no padding and no content width, so a page with its own columns, such as Conversations' list beside the open conversation, starts where the sidebar ends and runs the window's height. Such a page pads its own columns and draws its own dividers. `fill` changes only the main area, so moving between a padded page and a filled one never restyles the sidebar.
- The sidebar looks the same on every page, the column above with the Claude acts for you switch and the owner at its foot (owner decision 2026-10-29: one sidebar look on every page; the conversation boards are drawn with the one sidebar). There is no option to draw it another way.
- Below 768 px, or with `layout="compact"`, a top bar on the panel replaces the column. It is 56 px high and holds the mark, the business name and a ghost "Menu" button drawn as its icon alone, as the phone boards draw it, its name for screen readers (`aria-expanded`). A business name too long for the bar is cut with an ellipsis, and its `title` holds it in full, so it can still be read.
- Only the navigation changes at the breakpoint. The page stays mounted, so resizing the window or turning a phone keeps an unsent draft and the rest of the page's state.
- Menu opens the sidebar as a modal sheet from the left, with focus inside it, over the page dimmed by `scrim`, as behind `DemoInboxSheet` and `Dialog`. Escape, "Close menu", the dimmed page or going to a page closes it, and focus returns to Menu. Escape inside the sidebar's Desk list closes only the list.
- The sheet appears in place; nothing slides.
- On a coarse pointer, Menu keeps its visible 32 px square and takes taps through an unseen, centred `size-touch` (44 px) hit area, like `IconButton`. The top bar and page keep their size, position and scroll extents.
- "Skip to content" is the first Tab stop on every page, ahead of the banner (the reviewer bar's Start over) and the navigation. It is out of sight until keyboard focus reaches it, as `.cd-sr-only` hides text; a click never shows it, since it shows only while it matches `:focus-visible`. Then it shows at the shell's top left, 8 px in, over the banner and the sidebar: `control` type in `text-primary` on `bg-surface`, the raised surface menus sit on, `size-control` tall at `radius-control`, with the standard focus edge, 1 px of `line-focus` just inside it. Activating it moves focus to the page's `main`, which has an `id` and `tabindex="-1"` for it, so the next Tab is inside the page; the address stays as it is, since a page such as Today reads its fragment. The page takes focus with nothing drawn: it is not a control. While a panel is a modal sheet, the link is inert with the rest of the shell.
- `panel`, when given, sits at the right of the main area at its height, and the page narrows to make room (the Ask Claude panel beside Rules, N-Conn-12-Chat). Below 768 px the top bar runs above the page and the panel.
- A panel that opens beside the page arrives from where it lives, and the page moves rather than jumping (the open and closed states stay as N-Conn-12-Chat and N-Conn-17-Presets draw them; only the move between them is new):
  - Opening, the panel slides `space-24` in from the right and fades up. The page is laid out at its new width at once and glides from where it was to its new place on `transform` alone (a FLIP, never a width animation), so the chip the owner pressed doesn't leap from under the pointer. Both run on `motion-base` with `motion-ease-emphasis`.
  - The new width can move parts of the page up or down too: beside the panel at 1440 px, Rules' subtitle takes a second line, so everything under the header sits 20 px lower, and at 1512 px the summary lines inside the Payments rows move though the rows keep their height. Each block that moved glides there from where it was, on the same time and ease, so nothing jumps vertically either. The shell finds them itself and the page needs to do nothing:
    - It looks down to 16 levels under the page's content, and inside a block only where the block's width or height changed (a fill page's fixed-height column still lays out what is in it anew).
    - A block glides on its `translate` property, added to any it has, which moves it outside its own `transform` and `scale`. Inside a box that scales it, the move is divided by that scale, so it is the same distance on screen. A block that is turned, skewed, in 3D or sets a `perspective`, or sits inside one, takes no glide and lands in place: no move is converted through those.
    - Only what can be seen moving glides: a block out of sight both before and after lands in place, decided once it has been measured both times. What is in it is still judged on its own, since it may be drawn outside the block's box, unless the block clips what is inside it (`overflow` other than visible, or `contain: paint`).
    - At most 200 blocks glide at once; past that, the rest land in place, as the page itself does.
  - Closing reverses on `motion-fast`: the panel leaves the row at once, so the page takes its full width and glides back, while the panel slides out over the page's right edge, `inert`, and then goes. A panel given again while one is leaving is a new one.
  - A move taken over starts from where things are drawn: closed mid-entrance, the panel slides out from where it had got to, never flashing back to fully open; opened again mid-exit, the new panel comes in from where the last one was, and the page glides on from where it is.
  - While they move, the page can be drawn past the main area's edge, and the panel past the window's, for a moment: both are clipped rather than scrolling sideways. A sheet fixed over the window isn't clipped.
  - A panel that takes no room beside the page, a modal sheet such as `AskClaudePanel` under 1024 px, neither slides nor moves the page, and nor does anything under `prefers-reduced-motion: reduce`: the end state at once. A panel shown when the shell first draws doesn't move either.
- A panel that becomes a modal sheet, as `AskClaudePanel` does under 1024 px, says so through `AppShellPanelContext`. While it does, the banner, the navigation and the page are `inert`: the attribute is part of every render, so whatever the shell draws there as the window changes (the top bar replacing the column) stays out of reach. If Menu's sheet is open when that starts (the window narrowed with the top bar showing), it closes, and focus moves into the panel rather than back to Menu. When the panel stops being a sheet the page is live again; if the panel was removed with focus in it, the shell returns focus to the element the panel names.

## What the consumer provides

- `sidebar`, the `Sidebar`.
- `business`, the current business's name for the top bar. The `Sidebar` carries it too, but the top bar shows when the sidebar doesn't.
- `banner`, such as the `ReviewerBar` in the demo.
- `panel`, such as `AskClaudePanel`, while the screen shows it.
- `children`, the page. The shell adds no footer: the owner sidebar carries `ConceptFooter` under About this prototype in the wide layout; the owner page carries it at the bottom in the compact layout.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `sidebar` | `ReactNode` | Required. |
| `business` | `string` | Required. Shown in the compact top bar, as written, and as its `title`. |
| `todayHref` | `string` | Required. The current Desk's Today, linked from the compact bar's mark. |
| `linkComponent` | `ComponentType<SidebarLinkProps>` | The router's link component, as on Sidebar; a plain anchor by default. |
| `banner` | `ReactNode` | Full width, above everything. |
| `layout` | `'auto' \| 'compact'` | `auto` (the default) switches to the top bar below 768 px. |
| `fill` | `boolean` | The page fills the main area, unpadded, for a page with its own columns. The sidebar is unchanged. |
| `panel` | `ReactNode` | A panel at the right of the page. While it says it is a modal sheet, everything else is inert. Beside the page it slides in and out, and the page glides. |
| `children` | `ReactNode` | Required. |

## Loading shapes

With `skeleton`, the compact bar draws the mark, business line and Menu as shapes. The sidebar column and main area use divs with the real layout classes instead of aside/main landmarks; the full-page loader supplies one real main and its hidden heading outside the layer. `sidebar`, `banner`, `fill` and `children` still determine the layout. Put the shell in `SkeletonScreen`'s hidden, inert layer and pass `SidebarSkeleton` and `ReviewerBarSkeleton`. The skeleton shell carries no skip link, main target id, main ref or tabindex; only the real shell owns them while both shells are mounted during the fade. The content ref stays attached in both modes for panel layout. The Skeleton stories compare both frames within 2 px at 1512 and 390 and check that the one skip link targets and focuses the real main.

## Layout-dependent content

`AppShellOnly` renders its children only for `layout="wide"` or `layout="compact"`, using the shell's existing breakpoint and forced compact layout. The other layout's content is absent from the DOM. Owner footer placements use it so there is one visible, accessible concept line. Outside a shell it defaults to wide.
