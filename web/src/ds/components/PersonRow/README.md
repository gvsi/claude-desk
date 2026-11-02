# PersonRow

`PersonRow` is someone on record in the People list, and `LeadRow` a lead: a name over one quiet line, and for a lead the time it came in.

## When to use

- `PersonRow` for each person on record under "Contacts on record": their name and the masked contact on record.
- `LeadRow` for each lead under "Leads": their name, the time at its right, and what they asked about.
- Not for conversations, which are `ConversationListItem`, and not for attempts, which are `AttemptRow`.

## What the consumer provides

- `name` as the person gave it. It is shown as their own words (`data-copy="user"`).
- `contact`: the contact on record, masked as the kernel sends it ("d•••@example.com"). The row adds "Contact on record:" before it. Never pass an unmasked contact.
- `time` as the screen writes it ("Today, 11:24 am", "Oct 26, 11:10 am"). The row formats nothing.
- `note`: the lead's note, as written. It may come from a visitor, so it is shown as their words too.
- `recorded` for a lead replayed from the recorded history: the `RecordedTag` at the end of the note's line.
- `demoVisitor` for a lead a demo visitor left (an AI the owner started to play a customer): a `Pill` "Demo visitor" 8 px after the name, on its line; the name gives way before the pill.
- `href` when the row opens something, such as the person's page: the whole row becomes one link.
- Put each row in a list item, in a list named by its section ("Contacts on record", "Leads").

## What it shows

- The name in `control` type, `text-primary`; the line under it in `caption` type, `text-secondary`, 2 px under the name. Padded 6 px by 10 px, so a row is 51 px tall.
- A lead's time in `caption` at the right of its name, on the name's baseline, on one line. A replayed lead's Recorded tag sits at the end of the note's line, under the time, and the row keeps its 51 px.
- Below 480 px of row width, as on a phone, the note takes the whole line and the tag a line of its own under it, from the note's start.
- No fill at rest. A row that links takes `fill-hover` on hover at `radius-control`, like a conversation row, and the focus edge. Nothing else moves.
- No separator between facts: "Lead" isn't repeated before the note, because the list's own heading says so.

## Accessibility

- A row that links is one link named by its words: "Dana Whitfield Contact on record: d•••@example.com".
- The time and the tag are text, read in order after the name. The tag's icon is `aria-hidden`.

## Props

`PersonRow`:

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. Their own words. |
| `contact` | `string` | Required. The masked contact on record. |
| `href` | `string` | Their page. The row becomes one link. |

`LeadRow`:

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. Their own words. |
| `time` | `string` | Required. As the screen writes it. |
| `note` | `string` | Required. As written. |
| `recorded` | `boolean` | Replayed from the recorded history: the Recorded tag. |
| `href` | `string` | Where the lead opens. The row becomes one link. |
| `demoVisitor` | `boolean` | Left in a demo visitor's chat: the "Demo visitor" pill after the name. |
