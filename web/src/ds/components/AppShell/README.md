# AppShell

`AppShell` is the owner app's frame: an optional banner across the top, the sidebar in its column, and the page beside it.

## When to use

- Once, around every owner screen. Visitor surfaces use `PublicShell`.

## Layout

- The shell is the height of the window. The `banner` runs full width across the top. Under it, the sidebar column and the page scroll on their own.
- The column is `size-sidebar` wide on `bg-panel`, with a `line-hairline` seam at its right. It is an `aside` named "Claude Desk", holding the `Sidebar`.
- The page is a `main`, padded 24 px at the top, 40 px at the sides and 20 px at the bottom (16 px at the sides on a phone). Its content is at most `size-content` wide, centered.
- With `fill`, the page takes the whole main area instead: no padding and no content width, so a page with its own columns, such as Conversations' list beside the open conversation, starts where the sidebar ends and runs the window's height. Such a page pads its own columns and draws its own dividers. `fill` changes only the main area, so moving between a padded page and a filled one never restyles the sidebar.
- The sidebar looks the same on every page, the column above with the Answering switch and the owner at its foot (owner decision 2026-10-29: one sidebar look on every page; the conversation boards are being redrawn to match). There is no option to draw it another way.
- Below 768 px, or with `layout="compact"`, a top bar on the panel replaces the column. It holds the mark, the business name and a ghost "Menu" button (`aria-expanded`).
- Only the navigation changes at the breakpoint. The page stays mounted, so resizing the window or turning a phone keeps an unsent draft and the rest of the page's state.
- Menu opens the sidebar as a modal sheet from the left, over a dimmed page, with focus inside it. Escape, "Close menu", the dimmed page or going to a page closes it, and focus returns to Menu. Escape inside the sidebar's Desk list closes only the list.
- The sheet appears in place; nothing slides.

## What the consumer provides

- `sidebar`, the `Sidebar`.
- `business`, the current business's name for the top bar. The `Sidebar` carries it too, but the top bar shows when the sidebar doesn't.
- `banner`, such as the `ReviewerBar` in the demo.
- `children`, the page. The shell adds no footer: the owner layout puts one `ConceptFooter` under its content.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `sidebar` | `ReactNode` | Required. |
| `business` | `string` | Required. Shown in the compact top bar, as written. |
| `banner` | `ReactNode` | Full width, above everything. |
| `layout` | `'auto' \| 'compact'` | `auto` (the default) switches to the top bar below 768 px. |
| `fill` | `boolean` | The page fills the main area, unpadded, for a page with its own columns. The sidebar is unchanged. |
| `children` | `ReactNode` | Required. |
