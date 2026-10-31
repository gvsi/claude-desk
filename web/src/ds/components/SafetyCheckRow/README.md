# SafetyCheckRow

`SafetyCheckRow` is one trick the setup safety check tried on the draft rules: what kind of trick it was, the words it tried, and whether the rules stopped it.

## When to use

- On the setup interview's safety check, one row per trick in the `SafetyCheck`, in a card under "{blocked} of {total} blocked".
- Not for an attempt in a live conversation, which is Safety's `AttemptRow`, and not for the situations step, which is `SituationRow`.

## What the consumer provides

- `label`: the kind of trick, in Safety's words ("Posing as you", "Money", "Private data", "Codes", "Hidden instructions").
- `attempt`: the words the check tried, as a visitor would type them. The row puts them in quotes and marks them as someone's own words (`data-copy="user"`).
- `blocked`, and `stoppedBy` for a blocked trick: the checkpoint that stopped it (`'who'`, `'action'`, `'review'` or `'reply'`), named as Safety names it ("Action checkpoint").
- `reason`: the kernel's `reason_plain`, as written.
- `index`: the row's place in the list, from 0, which sets when a live row lands.
- `live`, for the rows of a check the owner just ran: they land one by one. Leave it off for results the owner didn't just ask for, such as a step opened by a reload (its check runs again, but is drawn still), and clear it once the rows have landed, so nothing replays them. Draw each run's rows anew (key the list by the read), so a check run again lands.
- Put each row in a list item, in a list named by the step ("Tricks tried"), inside a card padded 16 px. The count and the line above the card are the screen's words, from the check's own counts.

## What it shows

- Laid out as a `SituationRow` is: a hairline over the row, padded 14 px top and bottom; the trick at the left and the outcome in a 300 px column at the right, 24 px from it.
- At the left, the kind of trick in `control` type at weight 520; the quoted words 2 px under it in `meta`, `text-secondary`; for a blocked trick the checkpoint 4 px under them in `caption`, `text-secondary`. A blocked row is 90 px with its hairline.
- At the right, "Blocked" beside a `status-refused` dot, or "Not blocked" beside a `status-held` dot, in `meta`, `text-primary`, and the reason 2 px under it in `meta`, `text-secondary`.
- Below 560 px of row width the outcome drops under the trick, 8 px under it.

## Motion

- Live rows land one by one, in the order tried: each rises `space-4` and fades in over `motion-base` on `motion-ease-emphasis`, `motion-stagger` after the one before it (`index` × `motion-stagger`), the first at once. Its dot grows from half size with it. Each is held at its start until its turn and let go at its end. It is the step's one moment, and it explains that each trick was tried in turn.
- The screen's count above the card ticks up with the rows; that is the screen's, not the row's.
- A row that isn't live is drawn still.
- Under reduced motion every row is there at once, its dot whole.

## Accessibility

- The dot is `aria-hidden` beside words that say the same thing.
- The rows are in the page from the start, only faded, so a screen reader reads them all in order.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The kind of trick. |
| `attempt` | `string` | Required. The words tried, without quotes. |
| `blocked` | `boolean` | Required. |
| `stoppedBy` | `'who' \| 'action' \| 'review' \| 'reply'` | The checkpoint that stopped a blocked trick. |
| `reason` | `string` | Required. The kernel's `reason_plain`. |
| `index` | `number` | Required. The row's place, from 0. |
| `live` | `boolean` | The row came with a check that just ran: it lands. Default `false`, drawn still. |
