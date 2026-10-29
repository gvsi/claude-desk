# TranscriptRow

`TranscriptRow` is one row of a conversation: the message in the reading column, with its margin receipts attached under it.

## When to use

- For every message in a conversation that has receipts or notes, on the owner's conversation view and on the public page. A message with nothing attached can still be a row, so it keeps the reading column's width.
- Inside a `Transcript`, whose log gives the row its width.
- `TranscriptHeader` puts the conversation's captions over the rows, one under the other ("Today at 12:04, web chat from …", then "Notes from the checkpoint. Select one for the full trace."). Put it first inside the `Transcript`.

## What the consumer provides

- `children`: the message (`VisitorMessage`, `ClaudeMessage`, `PersonMessage`, `AgentMessage` or `Whisper`).
- `margin`: its `MarginReceipt`s and `MarginNote`s, in the order they happened. Receipts for an action and for the reply that reports it attach together under that reply.
- For the header, the display strings: the screen formats any time in them; the design system formats none.

## Layout

- The row is the reading column: at most `--cd-row-max` wide (`size-reading` by default), and the full width of a narrower log. A surface whose own column is already the reading width sets `--cd-row-max: 100%` on an ancestor so its rows fill that column; the public page does, so its rows end where its composer ends.
- Its receipts attach under the message at every width, `space-8` below it and `space-8` apart, on the message's side: under Claude's and the owner's words they start at the left, as wide as the row; under a visitor's or an agent's bubble on the right they end where the bubble ends and are at most 85% of the row wide, like the bubble. Their lines start together either way, so the dots stay in one column. On the owner's wide screens, on a phone and on the public page alike, each checkpoint result sits right under the message it explains.
- The header's captions stack the same way, the receipts' caption second.

## Props

`TranscriptRow`:

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required. The message. |
| `margin` | `ReactNode` | Optional. Receipts and notes, attached under the message. An empty list, or only `null` and `false`, attaches nothing. |

`TranscriptHeader`:

| Prop | Type | Notes |
| --- | --- | --- |
| `left` | `ReactNode` | Required. The first caption. |
| `right` | `ReactNode` | Required. The caption about the receipts, under the first. |
