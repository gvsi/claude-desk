# KnowledgeList

`KnowledgeList` is "What Claude knows" on Knowledge: each thing the Desk answers from, with a line under it and who can see it.

## When to use

- On Knowledge, above "Add something" (`KnowledgeAdd`), as N-Run2-Settings-Knowledge draws it.
- Not for adding an item or changing who sees it: an item's "Customers can see this" switch is in `KnowledgeAdd`'s "Added" card, right after it is added. The rows here are read only.

## Knowledge list route

The web app reads `GET /api/owner/desks/{desk_id}/knowledge` for the owner's knowledge list. The API serves the route; its `KnowledgeRow` comes from `openapi.gen.ts`. Stories use fixture rows.

Two kinds of item are owner-only, and only one loses its title:

- An item the owner keeps private (readers `["owner"]`, the switch off) keeps its title and text. Its row shows its own title and "Only you".
- An item the kernel forces owner-only reaches the web with its title and text withheld (`kernel_ro.knowledge_items` nulls them). Its row can only ever be drawn as the board draws its third row: "A note only you can see", and "Only you".

## What the consumer provides

- `items`, in the order the screen lists them. With none, nothing is drawn: no board draws the list empty, so the page leaves the section out.
- Each item's `id` (`KnowledgeItem.item_id`), the row's key.
- `title`: the item's own title, shown as its owner's words (`data-copy="user"`), whether customers can see the item or only the owner. Pass `null` only when the kernel withheld it, for an item it forces owner-only: the row then reads "A note only you can see", in the design system's words.
- `detail`: the line under the title, in the screen's words: where the item came from ("From your answers in setup", "turner-plumbing.example, read during setup") or when it was added ("Added Oct 27", formatted by the screen). The row formats nothing.
- `readers`: the item's `label.readers`, exactly as the kernel returned them. The row says "Customers can see this" when they include "public", and "Only you" otherwise. A withheld item always says "Only you", whatever its label, since the kernel withholds only what it forces owner-only.

## What it shows

- The section's heading, "What Claude knows" (`SectionHeader`, an `h2` that names the section and the list), then 8 px under it a `Card` of rows with no padding of its own.
- Each row padded 12 px 16 px, with a `line-hairline` above every row but the first: the title in `body` type at weight 520, `text-primary`, over the detail in `meta` type, `text-secondary`, 2 px apart. A title and a detail that each fit one line make a 64 px row, or 65 px with its separator. With `detail: null`, no detail element or empty line is drawn: the title sits 12 px from the top and bottom of a 44 px one-line row (45 px with a separator). Wrapped words make the row taller.
- Who can see it, in a `Pill` at the row's right, centered on the row. The words wrap beside the pill, which keeps its line. Below 640 px, tiled rows move the pill under the text; untiled rows keep it at the right. Neither layout scrolls sideways on a phone.

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
| `title` | `string \| null` | Required. The item's title, or `null` only when the kernel forced it owner-only and withheld it. |
| `detail` | `string \| null` | Required. The line under the title, in the screen's words; null leaves the line out. |
| `readers` | `readonly string[]` | Required. `label.readers` as returned; "public" reads "Customers can see this". |

The optional `kind` selects a 36 px tile with a 20 px icon: `globe`, `list`, `note`, or `document`. `fileTag` adds a PDF or DOCX caption in the `file-tag` type style. `pill` can replace the readers pill with Mock or Coming later; null draws none. The optional `title`, `caption`, and `note` let the page reuse the same card for its two static preview sections. A note sits 12 px above the card.
