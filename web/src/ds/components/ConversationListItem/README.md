# ConversationListItem

`ConversationListItem` is one conversation in a list: who it is with, when, and its status, as one link to the conversation.

## When to use

- In the Conversations list and in Today's "Live now", one per conversation, each in a list item (`ul` > `li`).
- Not for a stopped attempt, which is an `AttemptRow`.

## What it shows

- A row link at `radius-control`, at least 48 px tall, padded 6 px by 10 px.
- First line: the name in `control` type, shown as written (`data-copy="user"`, since a visitor may have given it), then the time at the right in `caption` type, `text-secondary`, with tabular figures.
- Preview line: what the visitor last wrote (`quote`), in curly quotes, “Tuesday at 2 works.”, in `meta` type, `text-secondary`, 2 px under the name and time, marked `data-copy="user"`. Blank or missing quotes leave this line out.
- Status line: a `size-dot` dot beside the words that say the same ("Needs you", "Agent"), in `caption` type, `text-secondary`, below the preview when there is one. A replayed conversation (`recorded`) ends that line with a `RecordedTag`, pushed to its end under the time. With no status, the line holds the tag alone; with neither, there is no status line. A row with only its name and time centers them in its 48 px.
- Each line stays on one line and ends in an ellipsis when it doesn't fit. Status words ellipsize before the Recorded tag; the tag keeps its whole width. Names and previews give way while the time stays at the right.
- The conversation open beside the list is `aria-current="true"` on `bg-selected`. Other rows fill with `fill-hover` on hover.

## What the consumer provides

- `name` as the owner's screen names the visitor: their name, "Visitor", "Agent" or "Your preview".
- `time` as the screen writes it ("12:04 pm"); the design system formats no times.
- `status` from the screen's one status table: a `StatusTone` for the dot and the words. Leave it out when the name already says all the status would ("Visitor" for someone who gave no name), so the row never says it twice.
- `href`, the conversation's page, and `current` for the one that is open.
- `recorded` for a conversation the kernel marks as replayed into this copy. The page then shows a `RecordedHistoryLink` under its title.
- `quote` (optional), `latest_visitor_text` as the API gives it. Conversations passes it for visitor chats; agents, owner chats, the owner's preview and chats without a visitor message have no preview. It is untrusted and renders as text only, never markup.
- `quoteWithStatus` defaults to `true`. Today's "Live now" sets it to `false` to keep its existing two-line layout: a status that asks for the owner, such as "Needs you", takes the quote's place. Live now leaves out identity statuses ("Visitor", "Verified customer") beside a quote.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `time` | `string` | Required. Shown as given. |
| `status` | `{ tone: StatusTone; text: string }` | The dot is `aria-hidden`; the words carry the status. Left out when the name already says it. |
| `href` | `string` | Required. |
| `current` | `boolean` | `aria-current="true"` on the selected fill. |
| `recorded` | `boolean` | The Recorded tag at the end of the status line. Its word joins the link's name. |
| `quote` | `string` | The visitor's own words, quoted below the name and time and above the status or tag. They join the link's name. A blank quote is left out. |
| `quoteWithStatus` | `boolean` | Defaults to `true`. Set to `false` for Live now's layout, where a status or Recorded tag takes the quote's place. |

The hover fill changes at `motion-instant`. Nothing moves under reduced motion.
