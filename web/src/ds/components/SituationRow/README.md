# SituationRow

`SituationRow` is one real situation run against the draft rules in setup: what happens and who is asking, and what the rules do about it.

## When to use

- On the setup interview's situations step, one row per `SituationResult`, in a card under "Real situations".
- Not for what happened in a real conversation, which is a receipt or a Safety row, and not for the safety check's tricks, which are `SafetyCheckRow`.

## What the consumer provides

- `title` and `who` as the check describes the situation: "A visitor asks for 10% off if they pay cash", "A visitor, not verified".
- `outcome`, `dependsOnReview` and `reason` from the probe's result: `outcome`, `depends_on_review` and the kernel's `reason_plain`, as written.
- `matches`: false when the outcome isn't the one the setup interview planned.
- `index`, the row's place in the list from 0, and `live`, for situations just tried: they land one by one, as the safety check's tricks do. Leave `live` off for results read again, such as a step opened with its results already there (a reload), and clear it once the rows have landed, so nothing replays them.
- Put each row in a list item, in a list named by the step ("Real situations"), inside a card padded 16 px.

## What it shows

- A hairline over the row, which is padded 14 px top and bottom.
- At the left, the situation in `control` type at weight 520 and who is asking 2 px under it, in `meta`, `text-secondary`.
- At the right, in a 300 px column 24 px from the situation, the outcome in words beside its dot, in `meta`, `text-primary`, and the reason 2 px under it in `meta`, `text-secondary`:

| `outcome` | Words | Dot |
| --- | --- | --- |
| `allow` | Does it | `status-handled` |
| `hold` | Asks you | `status-held` |
| `refuse` | Never | `status-refused` |
| any, with `dependsOnReview` | Does it if Claude’s second look agrees | `status-handled` |

- `dependsOnReview` alone decides the second-look row, whatever `outcome` says: the kernel reports a planned situation that waits on Claude's second look (`allow_if_reviewed`) as `outcome: 'hold'` with `depends_on_review: true`, and the signed board draws it as "Does it if Claude’s second look agrees" beside a handled dot.

- When `matches` is false, "Not what we planned" in `caption`, `text-primary`, 6 px under who is asking, beside a 2 px `status-held` bar, 8 px from it. The words carry it; the bar only echoes them.
- Below 560 px of row width, as on a phone, the outcome and reason drop under who is asking, 8 px under it, from the same edge.
- One line on each side: 69 px with the hairline.

## Motion

- Live rows land one by one, in the order tried, as a `SafetyCheckRow` does: each rises `space-4` and fades in over `motion-base` on `motion-ease-emphasis`, `motion-stagger` after the one before it (`index` × `motion-stagger`), the first at once, its dot growing from half size with it.
- A row that isn't live is drawn still.
- Under reduced motion every row is there at once, its dot whole.

## Accessibility

- The rows are in the page from the start, only faded while they land, so a screen reader reads them all in order.
- The dot and the bar are decoration beside words that say the same thing. The dot is `aria-hidden`.
- The words read in order: the situation, who is asking, any "Not what we planned", the outcome, the reason.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. The situation. |
| `who` | `string` | Required. Who is asking in it. |
| `outcome` | `'allow' \| 'hold' \| 'refuse'` | Required. The probe's outcome. |
| `dependsOnReview` | `boolean` | Required. The probe's `depends_on_review`; it sets the second-look words and dot, whatever `outcome` is. |
| `reason` | `string` | Required. The kernel's `reason_plain`. |
| `matches` | `boolean` | Required. False adds "Not what we planned". |
| `index` | `number` | The row's place, from 0, which sets when a live row lands. Default `0`. |
| `live` | `boolean` | The situation was just tried: the row lands. Default `false`, drawn still. |
