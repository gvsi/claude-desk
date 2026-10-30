# RecordedTag

`RecordedTag` is the quiet mark on a replayed row: a small history icon and the word "Recorded", saying the row is recorded history replayed into this copy of the demo.

## When to use

- On every replayed row: a conversation in the list (`ConversationListItem` `recorded`), a stopped attempt (`AttemptRow` `recorded`) and a lead on People, which the web app composes itself, putting the tag at the end of the lead's second line.
- With `RecordedHistoryLink` on the page that lists the rows, and `RecordedNote` in a replayed conversation's or attempt's detail.
- Only on rows the kernel marks as replayed. A live row never carries it.

## What it shows

- An inline row, `space-4` between its parts, in `caption` type and `text-secondary`, on one line (`white-space: nowrap`):
  - the 14 px `history` icon, `aria-hidden`;
  - the word "Recorded", which carries the meaning, so a screen reader hears it as part of the row.
- It never shrinks. Where its line runs short, the words before it ellipsize first.

## What the consumer provides

- Nothing but its place. The copy is fixed English: the owner app is English only.
- `className` to place it in a composed row, such as `margin-left: auto` to push it to the end of the line.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `className` | `string` | Added after the tag's own classes. |
