# ClaudeMessage

`ClaudeMessage` shows one delivered message from Claude, or from the Desk itself, as Markdown in the serif reply type and typed reply cards.

## When to use

- Every `EvMessage` whose `author` is `claude` or `desk`. A `desk` message is the kernel's own, such as the `payment_confirmed` card after a test checkout, and it looks the same.
- An `owner` message is a `PersonMessage`, never this.
- Only after delivery. There is no draft or streaming state: until the kernel has checked and delivered the reply, the screen shows the `WritingIndicator`.

## What the consumer provides

- `blocks`: the event's `blocks`, exactly as they arrived, in order.
- `language`: the event's `language`. It picks the card chrome and sets `lang` on the message.
- `ownerName`: `owner_display_name`, for the "Maria Rivera said" card label.

## What it shows

- Each `prose` block as Markdown with `ChatMarkdown`, in the reply type (15/23, weight 360): paragraphs, headings, bold, italic, lists, tables, links, inline code, quotes and rules, with Claude's line breaks kept inside a paragraph. A blank prose block takes no space.
- Links in prose are inert (`links="inert"`): each shows its text, then its address, and opens nothing, because the kernel's reply check doesn't read Markdown link targets yet and a link showing only its text could hide a target nothing checked. One constant, `PROSE_LINKS`, flips this to clickable once that check is on main. Payment and booking links come from cards, as before.
- With `plainProse` (the Vision pages only), each prose block as one plain paragraph exactly as written, never Markdown.
- Each other block as a `ReplyCard`. A card whose template this build doesn't know shows its text in a plain card, as `ReplyCard` does.
- Nothing else: no bubble, no avatar, no name, no time. The blocks are the whole message, and nothing is computed or added.
- Paragraphs and prose blocks sit 10 px apart, and a card sits 12 px from what is above it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `blocks` | `readonly RenderedBlock[]` | Required. |
| `language` | `'en' \| 'es'` | Required. |
| `ownerName` | `string` | Required. |
| `inertDownload` | `boolean` | Vision pages only: passed to each `ReplyCard`, so a document card's Download goes nowhere. `false` by default. |
| `plainProse` | `boolean` | Vision pages only: each prose block as written, one plain paragraph, never Markdown. `false` by default. |
