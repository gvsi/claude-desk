# AppShell

`AppShell` is the owner app's frame: an optional banner across the top, the sidebar in its column, and the page beside it.

## When to use

- Once, around every owner screen. Visitor surfaces use `PublicShell`.

## Layout

- The shell is the height of the window. The `banner` runs full width across the top. Under it, the sidebar column and the page scroll on their own. The document itself never scrolls: the main area and the column are positioned, as is the Ask Claude panel's conversation, so anything absolutely placed in them, such as a receipt's screen-reader label, scrolls with them instead of stretching the document behind the shell. Because the main area is positioned, anything from the banner, the column or the top bar that reaches over the page sets `z-index: 1`, as the business switcher does.
- The column is `size-sidebar` wide on `bg-panel`, with a `line-hairline` seam at its right. It is an `aside` named "Claude Desk", holding the `Sidebar`.
- The page is a `main`, padded 24 px at the top, 40 px at the sides and 20 px at the bottom (16 px at the top and sides on a phone). Its content is at most `size-content` wide, centered.
- With `fill`, the page takes the whole main area instead: no padding and no content width, so a page with its own columns, such as Conversations' list beside the open conversation, starts where the sidebar ends and runs the window's height. Such a page pads its own columns and draws its own dividers. `fill` changes only the main area, so moving between a padded page and a filled one never restyles the sidebar.
- The sidebar looks the same on every page, the column above with the Answering switch and the owner at its foot (owner decision 2026-10-29: one sidebar look on every page; the conversation boards are drawn with the one sidebar). There is no option to draw it another way.
- Below 768 px, or with `layout="compact"`, a top bar on the panel replaces the column. It is 56 px high and holds the mark, the business name and a ghost "Menu" button drawn as its icon alone, as the phone boards draw it, its name for screen readers (`aria-expanded`).
- Only the navigation changes at the breakpoint. The page stays mounted, so resizing the window or turning a phone keeps an unsent draft and the rest of the page's state.
- Menu opens the sidebar as a modal sheet from the left, with focus inside it, over the page dimmed by `scrim`, as behind `DemoInboxSheet` and `Dialog`. Escape, "Close menu", the dimmed page or going to a page closes it, and focus returns to Menu. Escape inside the sidebar's Desk list closes only the list.
- The sheet appears in place; nothing slides.
- `panel`, when given, sits at the right of the main area at its height, and the page narrows to make room (the Ask Claude panel beside Rules, N-Conn-12-Chat). Below 768 px the top bar runs above the page and the panel.
- A panel that becomes a modal sheet, as `AskClaudePanel` does under 640 px, says so through `AppShellPanelContext`. While it does, the banner, the navigation and the page are `inert`: the attribute is part of every render, so whatever the shell draws there as the window changes (the top bar replacing the column) stays out of reach. If Menu's sheet is open when that starts (the window narrowed to a phone), it closes, and focus moves into the panel rather than back to Menu. When the panel stops being a sheet the page is live again; if the panel was removed with focus in it, the shell returns focus to the element the panel names.

## What the consumer provides

- `sidebar`, the `Sidebar`.
- `business`, the current business's name for the top bar. The `Sidebar` carries it too, but the top bar shows when the sidebar doesn't.
- `banner`, such as the `ReviewerBar` in the demo.
- `panel`, such as `AskClaudePanel`, while the screen shows it.
- `children`, the page. The shell adds no footer: the owner layout puts one `ConceptFooter` under its content.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `sidebar` | `ReactNode` | Required. |
| `business` | `string` | Required. Shown in the compact top bar, as written. |
| `banner` | `ReactNode` | Full width, above everything. |
| `layout` | `'auto' \| 'compact'` | `auto` (the default) switches to the top bar below 768 px. |
| `fill` | `boolean` | The page fills the main area, unpadded, for a page with its own columns. The sidebar is unchanged. |
| `panel` | `ReactNode` | A panel at the right of the page. While it says it is a modal sheet, everything else is inert. |
| `children` | `ReactNode` | Required. |
