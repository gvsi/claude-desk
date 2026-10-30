# RecordedHistoryLink

`RecordedHistoryLink` is the quiet "Includes recorded history" caption on a page whose rows include recorded history, as a link to the ledger's explanation of what was replayed into this copy.

## When to use

- Once on each page that lists replayed rows, and only when some are listed:
  - under the Conversations title;
  - beside Safety's summary line, when replayed attempts count in it;
  - under People's Leads header;
  - on Today, by "Since last night" and in "Last 7 days", when replayed rows count there.
- Each replayed row carries a `RecordedTag`; an opened replayed conversation or attempt shows a `RecordedNote`.

## What it shows

- The words "Includes recorded history" in `caption` type and `text-secondary`, underlined 1 px in `line-control`, 3 px under the words.
- On hover the words turn `text-primary`, at `motion-instant`. The underline stays, so the link never depends on its color. Nothing moves under reduced motion.
- The underline is decorative (`DECORATIVE_COLORS`): the link stands on its own line, and its words say where it goes.

## What the consumer provides

- `href`: the ledger's explanation, titled "Recorded history, replayed into your copy". The words are fixed English, as the owner app is English only.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `href` | `string` | Required. |
