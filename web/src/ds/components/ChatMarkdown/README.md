# ChatMarkdown

`ChatMarkdown` shows Claude's words as Markdown, rendered with Streamdown in the reply type, whole, streaming in, or revealed word by word.

## When to use

- Claude's prose on every chat screen: a delivered reply's prose blocks, the setup consultant's messages, Ask Claude's answers, owner transcripts and Safety's stopped drafts.
- With `streaming` while an owner chat's reply is still arriving: pass the whole text so far on each `delta`, then the saved text without `streaming` once the turn is done.
- With `reveal` for a visitor reply that has just arrived live. The kernel has checked the whole reply before the browser has any of it, so the reveal only shows more of text it already holds, in order. Messages from history, a reload or a reopened chat show whole.
- With `links="inert"` for a stopped draft, which may hold the very link it was stopped for.
- Not for agent-to-agent responses, which are for agents, not screens, or for the Vision pages, which keep plain text.

## What the consumer provides

- `text`: Claude's Markdown, exactly as it arrived. Nothing is added, dropped or reordered: Markdown only changes how the words look.
- `streaming`, `reveal`, `onRevealed` and `links` as needed (Props).
- The place it sits in, such as `ClaudeMessage`, which spaces it among the message's cards.

## What it shows

As the signed Markdown boards (N-MD-01 to N-MD-06) draw it, in the reply type (`cd-type-reply`, serif 15/23):

- Paragraphs `space-10` apart, keeping Claude's line breaks inside a paragraph. A Markdown hard break (two trailing spaces or a backslash) starts one new line, as a line break does.
- Headings at the reply's size, weight 600: 15/23, with `h1` and `h2` at 17/25, `space-16` below what is above them, so a chat reply never gets page-size titles.
- Bold at 600 and italic.
- Lists indented 22 px, items `space-4` apart, their markers in `text-secondary`, `space-4` under the paragraph that leads into them.
- Tables in a hairline card (`line-card`, `radius-card`) that scrolls sideways when the table is wider than the column, as on a phone: serif 14/20, the header row at 600 on `bg-muted`, cells padded `space-8` by `space-12` with hairlines between rows.
- Links in `accent-blue`, underlined, showing their text only.
- Inline code in the mono type on `fill-secondary`; quotes indented behind a hairline in `text-secondary`; rules as a hairline.

## Safety settings

- No images: `![alt](src)` renders its alt text, never an `<img>`.
- No raw HTML: HTML in the text renders as text, never as elements. `rehype-raw` is left out of Streamdown's plugins.
- Links only to whole `http:`, `https:` and `mailto:` URLs, opening in a new tab with `rel="noopener noreferrer"`. A link anywhere else, a path on this site included, renders as its link text, unlinked. A bare `www.` address opens as https, as the reply check reads it, though GitHub Markdown would link it to http; a link that shows or was written with `http://` keeps it.
- With `links="inert"`, a link renders as its text, then its URL in brackets, and nothing is clickable. A bare URL or email address shows once.
- No code highlighting, math or diagrams: Streamdown's plugins for them aren't installed, so their bundles never ship.
- No footnotes: `[^note]` and `[^note]: …` stay as the words written, in place. Rendered, a footnote would move its note to the end under a label and a back link the reply never had.

## Streaming and the reveal

- While `streaming`, the text shows up to its last whole word: a word with nothing after it may be unfinished, so it waits for the next delta. Unfinished Markdown is closed, so a half-open bold or link never shows its markers, and a link shows its text until its address is whole.
- With `reveal`, the reply starts with its first word and grows by whole words on each frame, at about 200 characters a second, faster for a long reply so none takes more than about 3 s. `onRevealed` is called when the last word shows.
- Either way, a cut never falls right after a block's opening marker, so a list item, heading or quote appears with its first word, and never inside a table's head, so a table appears with its header row.
- Each new word settles in over `motion-settle` (150 ms), fading from transparent; a list item's marker comes in with its first word. A word already shown keeps its place and never settles again.

Under `prefers-reduced-motion: reduce` a revealed reply shows whole at once and `onRevealed` is called at once; nothing fades.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. The whole text so far. It may grow between renders and may stop mid-token. |
| `streaming` | `boolean` | `false` by default. The text is still growing. |
| `reveal` | `boolean` | `false` by default. The text is whole; reveal it word by word. Only a message that arrives live passes it. |
| `onRevealed` | `() => void` | Called once, when everything in `text` is shown: at once when not revealing or under reduced motion. |
| `links` | `'open' \| 'inert'` | `open` by default: links are clickable and show their text only. `inert`: link text then the URL, nothing clickable. |
