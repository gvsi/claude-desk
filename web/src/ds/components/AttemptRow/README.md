# AttemptRow

`AttemptRow` is one stopped attempt in the Safety list: when, what they tried, where it came from, and the checkpoint that stopped it, as one link to the attempt.

## When to use

- In the Safety page's attempts list, one per attempt, each in a list item (`ul` > `li`).
- `CheckpointMeter`, exported from this folder, on its own in an attempt's detail ("See how it was stopped").

## What it shows

- A row link at `radius-control`, at least 50 px tall, in three columns:
  - the time in `meta` type, `text-secondary`, with tabular figures;
  - what they tried in `control` type, and under it where it came from in `caption` type, `text-secondary`, each on one line with an ellipsis. A replayed attempt (`recorded`) puts a `RecordedTag` `space-10` after where it came from, on the same baseline; those words ellipsize before the tag;
  - the `CheckpointMeter`.
- In a list narrower than 400 px, the meter moves under the words, beside the time's column.
- The attempt open beside the list is `aria-current="true"` on `bg-selected`. Other rows fill with `fill-hover` on hover.

## CheckpointMeter

- Four `size-dot` dots in the order the checks run: "Who's asking", "Action checkpoint", "Auto reviewer", "Reply checkpoint".
- The checks it passed are filled and the ones it never reached are hollow, both in `line-control-hover`. The one that stopped it is a `status-refused` dot.
- Under the dots, that checkpoint's name in words, in `caption` type, `text-secondary`. A screen reader hears "Stopped by: Action checkpoint".
- The dots are `aria-hidden`: the name says the same, so the status is never shown by color alone.

## What the consumer provides

- `time` as the screen writes it ("9:52 am"); the design system formats no times.
- `title`: what they tried, in one line (the attempt's summary, or its reason). Mark any words quoted from a visitor with `data-copy="user"`.
- `who`: where it came from ("From chat", "From the chat service").
- `stoppedBy`: the checkpoint that stopped it.
- `href`, the attempt's detail page, and `current` for the one that is open.
- `recorded` for an attempt the kernel marks as replayed into this copy. Its detail then shows a `RecordedNote`, and the page a `RecordedHistoryLink` beside its summary line.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `time` | `string` | Required. Shown as given. |
| `title` | `ReactNode` | Required. |
| `who` | `string` | Required. |
| `stoppedBy` | `Checkpoint` | Required. `'who' \| 'action' \| 'review' \| 'reply'`. |
| `href` | `string` | Required. |
| `current` | `boolean` | `aria-current="true"` on the selected fill. |
| `recorded` | `boolean` | The Recorded tag after `who`. Its word joins the link's name, before "Stopped by". |

`CheckpointMeter({ stoppedBy })`, `CheckpointMeterProps` and `Checkpoint` are exported with the row. The hover fill changes at `motion-instant`; nothing moves under reduced motion.
