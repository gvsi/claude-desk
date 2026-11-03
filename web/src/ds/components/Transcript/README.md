# Transcript

`Transcript` is the conversation's log: a polite live region that holds every message, system line and receipt, in order.

## When to use

- Around the rows of any conversation, on the public page and in the owner's conversation view (with `variant="owner"` there).
- Put replies, receipts, system lines and the writing state inside it, so a screen reader announces each one as it arrives. A receipt outside the log is never announced.
- One per conversation. The composer, the header and the take-over bar sit outside it.

## What the consumer provides

- `label`: the log's accessible name, such as "Conversation with Dana Whitfield".
- `children`: the rows, oldest first. The log adds no rows, times or separators of its own.

## Layout

- A flex column with a `space-14` gap between rows, as on the conversation board.
- An inline-size container named `cd-transcript`, so what is inside can lay out by the log's width with `@container cd-transcript (…)` instead of by the window's. The log takes the width of its column, and each `TranscriptRow` is its reading column, with receipts attached under each message.

## The owner's view (`variant="owner"`)

Only the owner app's conversation view uses it (board REV-FLIP). It flips the sides of the visitor's own chat, so each side reads its own words on the right. The public chat, setup's preview and every other log keep the default, where the visitor's words are on the right and Claude's on the left.

- The other side is on the left. A visitor's bubble (the same `fill-bubble`), a visiting agent's request and the visitor's typing bubble start at the log's left edge. What is attached under them starts where they start.
- The other side mirrors the Desk's column: a visitor's bubble, the translation under it, an agent's request and what is attached under them are at most `min(520px, 88%)` of the log wide, rather than the default 85%, so in a wide log they never reach far past its middle.
- The Desk's side is on the right. A row holding Claude's reply (`ClaudeMessage`), the owner's whisper (`Whisper`) or the owner's own message (`PersonMessage`) takes one column `min(520px, 88%)` of the log wide, flush with its right edge. On a phone's 358 px log that is about 315 px. Its receipts and notes take the same column and each still opens the full trace.
- Everything in the column starts at its left edge, so prose, cards and receipts share one edge. A reply's cards (`ReplyCard`) fill the column.
- Anything in the log that isn't a message keeps the log's full width, such as a held request's answer card or a full trace. So do the header's captions.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. Becomes `aria-label` on the `<section role="log" aria-live="polite">`. |
| `children` | `ReactNode` | Required. |
| `logRef` | `Ref<HTMLElement>` | Optional. The log can then take focus back when an action in it goes away. |
| `variant` | `'default' \| 'owner'` | Optional, `'default'` when absent. `'owner'` only in the owner app's conversation view (see above). |
