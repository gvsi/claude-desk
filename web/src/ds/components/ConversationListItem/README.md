# ConversationListItem

`ConversationListItem` is one conversation in a list: who it is with, when, and its status, as one link to the conversation.

## When to use

- In the Conversations list and in Today's "Live now", one per conversation, each in a list item (`ul` > `li`).
- Not for a stopped attempt, which is an `AttemptRow`.

## What it shows

- A row link at `radius-control`, at least 48 px tall, padded 6 px by 10 px.
- First line: the name in `control` type, shown as written (`data-copy="user"`, since a visitor may have given it), then the time at the right in `caption` type, `text-secondary`, with tabular figures.
- Second line: the status as a `size-dot` dot beside the words that say the same ("Needs you", "Agent"), in `caption` type, `text-secondary`. A replayed conversation (`recorded`) ends that line with a `RecordedTag`, pushed to its end under the time. With no status, the line holds the tag alone; with neither, there is no second line, and the first sits centered in the row's 48 px.
- A row with no status and no tag can quote what the person last wrote (`quote`) on its second line instead: their words in curly quotes, “Tuesday at 2 works.”, in `meta` type, `text-secondary`, 2 px under the first line, marked `data-copy="user"`. A status or the tag keeps that line and the quote doesn't show, so status always wins.
- Each line stays on one line and ends in an ellipsis when it doesn't fit. On the second line the status words ellipsize first; the tag keeps its whole width.
- The conversation open beside the list is `aria-current="true"` on `bg-selected`. Other rows fill with `fill-hover` on hover.

## What the consumer provides

- `name` as the owner's screen names the visitor: their name, "Visitor", "Agent" or "Your preview".
- `time` as the screen writes it ("12:04 pm"); the design system formats no times.
- `status` from the screen's one status table: a `StatusTone` for the dot and the words. Leave it out when the name already says all the status would ("Visitor" for someone who gave no name), so the row never says it twice.
- `href`, the conversation's page, and `current` for the one that is open.
- `recorded` for a conversation the kernel marks as replayed into this copy. The page then shows a `RecordedHistoryLink` under its title.
- `quote` (optional), what the person last wrote, as the API gives it. Only Today's "Live now" passes it; the Conversations list doesn't. Beside a quote, Live now passes only a status that asks for the owner, such as "Needs you", and leaves out what the person is ("Visitor", "Verified customer"), so their words take that line. It is untrusted and renders as text only, never markup.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `time` | `string` | Required. Shown as given. |
| `status` | `{ tone: StatusTone; text: string }` | The dot is `aria-hidden`; the words carry the status. Left out when the name already says it. |
| `href` | `string` | Required. |
| `current` | `boolean` | `aria-current="true"` on the selected fill. |
| `recorded` | `boolean` | The Recorded tag at the end of the status line. Its word joins the link's name. |
| `quote` | `string` | The person's own words, quoted on the second line when there is no status or tag. They join the link's name. A blank quote is left out. |

The hover fill changes at `motion-instant`. Nothing moves under reduced motion.
