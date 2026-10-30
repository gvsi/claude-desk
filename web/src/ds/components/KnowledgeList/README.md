# KnowledgeList

`KnowledgeList` is "What I know now" on Settings › Knowledge: each thing the Desk answers from, with a line under it and who can see it.

## When to use

- On Settings › Knowledge, above "Add something" (`KnowledgeAdd`), as N-Run2-Settings-Knowledge draws it.
- Not for adding an item or changing who sees it: an item's "Customers can see this" switch is in `KnowledgeAdd`'s "Added" card, right after it is added. The rows here are read only.

## Waiting on an API

The list waits on an API that returns a Desk's knowledge items to its owner (the web app's plan, plan 04, Open question 1). Until it lands, the web app draws no list, and the stories draw the board's three rows from fixture data. An item the kernel keeps to the owner reaches the web with its title and text withheld (`kernel_ro.knowledge_items` nulls them), so such an item can only ever be drawn as the board draws its third row.

## What the consumer provides

- `items`, in the order the screen lists them. With none, nothing is drawn: no board draws the list empty, so the page leaves the section out.
- Each item's `id` (`KnowledgeItem.item_id`), the row's key.
- `title`: the item's own title, shown as its owner's words (`data-copy="user"`). Pass `null` when the kernel withheld it: the row then reads "A note only you can see", in the design system's words.
- `detail`: the line under the title, in the screen's words: where the item came from ("From your answers in setup", "rivera-plumbing.example, read during setup") or when it was added ("Added Oct 27", formatted by the screen). The row formats nothing.
- `readers`: the item's `label.readers`, exactly as the kernel returned them. The row says "Customers can see this" when they include "public", and "Only you" otherwise. A withheld item always says "Only you", whatever its label, since the kernel withholds only what it keeps to the owner.

## What it shows

- The section's heading, "What I know now" (`SectionHeader`, an `h2` that names the section and the list), then 8 px under it a `Card` of rows with no padding of its own.
- Each row padded 12 px 16 px, with a `line-hairline` above every row but the first: the title in `body` type at weight 520, `text-primary`, over the detail in `meta` type, `text-secondary`, 2 px apart. A row with one line each is 64 px tall.
- Who can see it, in a `Pill` at the row's right, centered on the row. The words wrap beside the pill, which keeps its line, so nothing scrolls sideways on a phone.

## Accessibility

- The list says `role="list"` and is named by the section's heading.
- Who can see an item is words in the pill, never a color.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `items` | `readonly KnowledgeRowView[]` | Required. With none, nothing is drawn. |

`KnowledgeRowView`:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Required. `KnowledgeItem.item_id`. |
| `title` | `string \| null` | Required. The item's title, or `null` when the kernel withheld it. |
| `detail` | `string` | Required. The line under the title, in the screen's words. |
| `readers` | `readonly string[]` | Required. `label.readers` as returned; "public" reads "Customers can see this". |
