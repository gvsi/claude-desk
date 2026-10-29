# Transcript

`Transcript` is the conversation's log: a polite live region that holds every message, system line and receipt, in order.

## When to use

- Around the rows of any conversation, on the public page and in the owner's conversation view.
- Put replies, receipts, system lines and the writing state inside it, so a screen reader announces each one as it arrives. A receipt outside the log is never announced.
- One per conversation. The composer, the header and the take-over bar sit outside it.

## What the consumer provides

- `label`: the log's accessible name, such as "Conversation with Dana Whitfield".
- `children`: the rows, oldest first. The log adds no rows, times or separators of its own.

## Layout

- A flex column with a `space-14` gap between rows, as on the conversation board.
- An inline-size container named `cd-transcript`, so what is inside can lay out by the log's width with `@container cd-transcript (…)` instead of by the window's. The log takes the width of its column, and each `TranscriptRow` is its reading column, with receipts attached under each message.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. Becomes `aria-label` on the `<section role="log" aria-live="polite">`. |
| `children` | `ReactNode` | Required. |
