# TranscriptRow

`TranscriptRow` is one row of a conversation: the message in the reading column, with its margin receipts attached under it.

## When to use

- For every message in a conversation that has receipts or notes, on the owner's conversation view and on the public page. A message with nothing attached can still be a row, so it keeps the reading column's width.
- Inside a `Transcript`, whose log gives the row its width.
- `TranscriptHeader` puts the conversation's captions over the rows, one under the other ("Today at 12:04, web chat from …", then "Notes from the checks. Select one for the full trace."). Put it first inside the `Transcript`.

## What the consumer provides

- `children`: the message (`VisitorMessage`, `ClaudeMessage`, `PersonMessage`, `AgentMessage` or `Whisper`).
- `margin`: its `MarginReceipt`s and `MarginNote`s, in the order they happened. Receipts for an action and for the reply that reports it attach together under that reply. Under a visitor's message that didn't send, the screen's error `Notice` comes last, with its next step ("Try again").
- For the header, the display strings: the screen formats any time in them; the design system formats none.
- `live` on a row that arrived while the page was open (from the visitor's stream, or a new row on the owner's open conversation), never on one read from history: a load, a reload, the owner opening a past chat, recorded history. The screen clears it once the row is shown, so a remount draws it still.

## Layout

- The row is the reading column: at most `--cd-row-max` wide (`size-reading` by default), and the full width of a narrower log. A surface whose own column is already the reading width sets `--cd-row-max: 100%` on an ancestor so its rows fill that column; the public page and the owner’s centred `size-conversation` column do, so their rows end where their composers end. Claude’s prose in the owner’s column still keeps `size-reading`.
- Its receipts attach under the message at every width, `space-8` below it and `space-8` apart, on the message's side: under Claude's and the owner's words they start at the left, as wide as the row; under a visitor's or an agent's bubble on the right they end where the bubble ends and are at most 85% of the row wide, like the bubble. Their lines start together either way, so the dots stay in one column. On the owner's wide screens, on a phone and on the public page alike, each checkpoint result sits right under the message it explains.
- A `Notice` under a bubble on the right keeps the same rule, at every width: its line starts with the lines above it, so the dots stay in one column, and its next step sits `space-8` under the line, at the right, ending where the bubble ends. The line ends there too when it is the widest thing attached. The step never sits beside the line there, so what is attached is only as wide as its widest line.
- The header's captions stack the same way, the receipts' caption second.
- In the owner's conversation view (`Transcript`'s `variant="owner"`, board REV-FLIP) the sides flip: a visitor's or an agent's bubble starts at the left, with what is attached under it starting where it starts, and a row holding Claude's, a whisper's or the owner's own words takes a column `min(520px, 88%)` wide at the right, its receipts in the same column. `Transcript`'s README has the details.

## Arriving live

A row with `live` lands once, in about half a second, at most 650 ms (the last line starts by 450 ms). Its receipts arrive with their reply, a beat apart, so the eye sees the Desk's checks arrive with the reply they explain:

- The message rises `space-4` and fades in, over `motion-base` on `motion-ease-emphasis`.
- What is attached lands one by one, `motion-stagger` apart, the first one beat after the message: each slides in `space-4` from the left and fades in, and a receipt's dot grows from half size with it (`MarginReceipt`). From the third on they share the third beat, so a long list never keeps the reply waiting.
- A booking's or a payment's check (`drawCheck`) draws as its line lands.
- `live` is read once, when the row is first drawn: changing it later neither starts nor stops the motion, and a re-render never replays it.
- It lands once. When the last line has landed, the row is like any other: a line attached later (a held request's outcome, an approval) shows at once, and nothing in it can land again.
- The browser regression for a later line waits until `cd-transcript-row--live` is gone before attaching it. An empty animation list alone can precede the landing re-check and the render that spends it. `LiveReply` shows the live arrival; this test changes no component behavior.
- The motion is visual only. The log announces the row as it does without it, and the words, order and colors are the same.
- Under reduced motion nothing moves: the row and everything attached show at once, and the landing is spent, so turning motion back on never plays it.

### Following a revealed reply

A live row whose message reveals itself (`ClaudeMessage`'s `reveal`, Claude's reply on the visitor chat or the owner's live view of it) arrives as the signed visitor reveal boards draw it (N-MD-02, N-MD-03, N-MD-06), instead of rising:

- The message doesn't rise: its words come in on their own, word by word, then its cards fade in (`ClaudeMessage`, "Arriving live").
- While the words come in, what is attached waits unseen in its place, so nothing below it moves when it comes.
- Then each line fades and rises `space-4` in, over `motion-base`, `motion-follow` apart, from the beat after the message's last card: the message tells the row that beat (`RowArrival`, in `arrival.ts`). Each line has a beat of its own, however many there are. A receipt's dot grows and its check draws on its line's beat.
- The parts come in strictly one after another: the words, then each card, then each line, each starting once the one before has finished (`motion-follow` is never shorter than `motion-base` or `motion-settle`). A line attached while they come in (a newer status, say) waits its turn after whatever is still coming in, and never comes in with it.
- A line already shown before its row arrived (`MarginReceipt`'s `shownBefore`) is already read: it doesn't wait.
- Once the last line has come in, the row is like any other, as after a landing.
- What follows the row can wait for it: `rowComingIn(row)` says whether anything in it is still coming in, on the page's animation clock (`clockNow()`). The owner's held request card waits on it to come in last.
- Under reduced motion the reply shows whole and everything attached shows at once.

## Props

`TranscriptRow`:

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required. The message. |
| `margin` | `ReactNode` | Optional. Receipts and notes, attached under the message. An empty list, or only `null` and `false`, attaches nothing. |
| `live` | `boolean` | Optional. The row arrived live: it lands once, or follows a message that reveals itself (see "Arriving live"). Read when the row is first drawn; spent once the landing has played, or at once under reduced motion. Never for a row read from history. |

`TranscriptHeader`:

| Prop | Type | Notes |
| --- | --- | --- |
| `left` | `ReactNode` | Required. The first caption. |
| `right` | `ReactNode` | Required. The caption about the receipts, under the first. |
