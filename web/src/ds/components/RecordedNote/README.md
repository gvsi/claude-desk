# RecordedNote

`RecordedNote` is the line at the top of a replayed conversation or attempt, once it is open, saying it is recorded history that happened before the owner arrived.

It reads, word for word: "Recorded history, replayed into your copy. It happened before you arrived."

## When to use

- In a replayed conversation, between its head and the transcript, and in a replayed attempt's detail, under its status line. The list row it was opened from carries a `RecordedTag`.
- Only for what the kernel marks as replayed. A live conversation or attempt never shows it.

## What it shows

- One `p` in `caption` type and `text-secondary`:
  - the 14 px `history` icon, `aria-hidden`, 2 px down (`space-2`) so it sits on the first line;
  - `space-6` after it, the words, which wrap under themselves, never under the icon.

## What the consumer provides

- Nothing. The words are fixed English, as the owner app is English only, and their first sentence is the title of the ledger's explanation that `RecordedHistoryLink` opens.

## Props

None.
