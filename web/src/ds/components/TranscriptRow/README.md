# TranscriptRow

`TranscriptRow` is one row of a conversation: the message in the reading column, and its margin receipts in the margin column beside it.

## When to use

- For every message in a conversation that has receipts or notes, on the owner's conversation view and on the public page. A message with nothing in the margin can still be a row, so the reading column keeps its width.
- Inside a `Transcript`: the row lays out by the log's width (`@container cd-transcript`), so outside one the margin never stacks.
- `TranscriptHeader` puts the two captions over the columns ("Today at 12:04, web chat from …" and "Notes from the checks. Select one for the full trace."). Put it first inside the `Transcript`.

## What the consumer provides

- `children`: the message (`VisitorMessage`, `ClaudeMessage`, `PersonMessage`, `AgentMessage` or `Whisper`).
- `margin`: its `MarginReceipt`s and `MarginNote`s, in the order they happened. Receipts for an action and for the reply that reports it sit together beside that reply.
- `align`, so the first receipt sits level with the message's first line.
- For the header, the display strings: the screen formats any time in them; the design system formats none.

## Layout

- The reading column is `size-reading` and the margin `size-margin`, at least `space-24` apart, with the margin at the right edge of the content. Receipts in the margin are `space-8` apart.
- `align` sets the margin's top padding so a 17 px caption line sits level with the message's first line: `reply` 3 px (a 23 px serif line), `bubble` 10 px (8 px of bubble padding, then a 21 px line), `top` 0 (a message with a caption above it, as an agent's request).
- In a transcript under 884 px (the two columns and their gap), the margin stacks under the message, full width, `space-8` below it. This is how visitor receipts read on a phone and on the public page.

## Props

`TranscriptRow`:

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required. The message. |
| `margin` | `ReactNode` | Optional. Receipts and notes. |
| `align` | `'reply' \| 'bubble' \| 'top'` | `reply` by default. |

`TranscriptHeader`:

| Prop | Type | Notes |
| --- | --- | --- |
| `left` | `ReactNode` | Required. The caption over the reading column. |
| `right` | `ReactNode` | Required. The caption over the margin. |
