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
- `reveal` on a message that arrived live, on a page already open, never on one read from history: a load, a reload, a reopened chat, recorded history.

## Arriving live

The kernel checks the whole reply before the browser has any of it, and the screen shows Claude's writing dots until then. With `reveal`, the delivered message then comes in as the signed visitor reveal boards draw it (N-MD-02, N-MD-03, N-MD-06):

- Its words show word by word, from the first, with `ChatMarkdown`'s reveal: about 200 characters a second, never more than about 3 s. Prose blocks come one after another, at one pace set by all their words, so the whole reply still takes at most about 3 s. The reveal only shows more of words the browser already holds whole, in order.
- Its cards wait unseen in their places, so nothing below them moves when they come. Once the words are whole, they fade and rise `space-4` in, one by one, `motion-follow` apart, each over `motion-base`: the first a beat after the words, or at once with no words before them, and each card a beat after the one before, however many there are.
- In a `TranscriptRow` drawn `live`, what the row attaches waits for the words too, then follows the cards, one beat after another (`TranscriptRow`, "Arriving live").
- Until everything in it has come in (its words whole and settled, its cards in), the message is `aria-busy`, so assistive technology may wait for the whole reply rather than read it out word by word, or twice.
- `reveal` is read once, when the message is first drawn: changing it later neither starts nor stops the reveal. Once the cards have come in, the message is like any other.

Under reduced motion it shows whole at once, its cards with it, and nothing fades.

## What it shows

- Each `prose` block as Markdown with `ChatMarkdown`, in the reply type (15/23, weight 360): paragraphs, headings, bold, italic, lists, tables, links, inline code, quotes and rules, with Claude's line breaks kept inside a paragraph. A blank prose block takes no space.
- Links in prose are clickable (`links="open"`, set by `PROSE_LINKS`): each shows its text only and opens in a new tab with `rel="noopener noreferrer"`. The kernel's reply check reads Markdown links and holds every link to the business's contact. Payment and booking links come from cards, as before. Stopped drafts keep inert links, and `ChatMarkdown` still defaults to inert mode.
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
| `reveal` | `boolean` | The message arrived live: its words are revealed, then its cards fade in (Arriving live). Read when first drawn. `false` by default. |
| `inertDownload` | `boolean` | Vision pages only: passed to each `ReplyCard`, so a document card's Download goes nowhere. `false` by default. |
| `plainProse` | `boolean` | Vision pages only: each prose block as written, one plain paragraph, never Markdown. `false` by default. |
