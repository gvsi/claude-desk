# ConversationListItem

`ConversationListItem` is one conversation in a list: who it is with, when, and its status, as one link to the conversation.

## When to use

- In the Conversations list and in Today's "Live now", one per conversation, each in a list item (`ul` > `li`).
- Not for a stopped attempt, which is an `AttemptRow`.

## What it shows

- A row link at `radius-control`, at least 48 px tall, padded 6 px by 10 px with a shared left column of `calc(var(--space-10) + 16px)` for read and unread rows.
- First line: the name in `control` type, shown as written (`data-copy="user"`, since a visitor may have given it), then the time at the right in `caption` type, `text-secondary`, with tabular figures.
- A demo visitor's chat (`demoVisitor`) has a `Pill` "Demo visitor" right after the name, 8 px from it, on the same line, so the row is never taken for a real customer's. The name keeps its own width and gives way before the pill; the time stays at the right.
- Preview line: what the visitor last wrote (`quote`), in curly quotes, “Tuesday at 2 works.”, in `meta` type, `text-secondary`, 2 px under the name and time, marked `data-copy="user"`. Blank or missing quotes leave this line out.
- Or, in the same place and drawn the same way, the app's own line (`line`), such as what an agent did: Paid $20 up front. It has no curly quotes and isn't marked `data-copy="user"`, since these are the app's words, not someone's own. A quote wins when both are given; a blank or missing line leaves it out.
- Status line: a `size-dot` dot beside the words that say the same ("Needs you", "Agent"), in `caption` type, `text-secondary`, below the preview when there is one. A replayed conversation (`recorded`) ends that line with a `RecordedTag`, pushed to its end under the time. With no status, the line holds the tag alone; with neither, there is no status line. A row with only its name and time centers them in its 48 px.
- Each line stays on one line and ends in an ellipsis when it doesn't fit. Status words ellipsize before the Recorded tag; the tag keeps its whole width. Names and previews give way while the time stays at the right.
- The conversation open beside the list is `aria-current="true"` on `bg-selected`. Other rows fill with `fill-hover` on hover.
- An `unread` row has a 10 px `accent-blue` dot at left 10 px, top 13 px, hidden from screen readers. A hidden “Unread:” prefix carries the same state in the link's name, as Notifications does. Its name is weight 600 in `text-primary`, its time weight 520 in `accent-blue`, and its preview in `text-primary`. Its fill is `fill-hover`, deepening to `fill-secondary-hover` on hover, including while current. Read rows keep their usual ink and fill.

## What the consumer provides

- `name` as the owner's screen names the visitor: their name, "Visitor", "Agent" or "Your preview".
- `time` as the screen writes it ("12:04 pm"); the design system formats no times.
- `status` from the screen's one status table: a `StatusTone` for the dot and the words. Leave it out when the name already says all the status would ("Visitor" for someone who gave no name), so the row never says it twice.
- `href`, the conversation's page, and `current` for the one that is open.
- `recorded` for a conversation the kernel marks as replayed into this copy. The page then shows a `RecordedHistoryLink` under its title.
- `demoVisitor` for a demo visitor's chat (`ConversationSummary.demo_visitor`): an AI the owner started to play a customer, named by its persona's first name.
- `quote` (optional), `latest_visitor_text` as the API gives it. Conversations passes it for visitor chats; agents, owner chats, the owner's preview and chats without a visitor message have no quote. It is untrusted and renders as text only, never markup.
- `line` (optional), the app's words for the preview line when there is no quote. Conversations passes what an agent did, built from its confirmed outcome and the facts the API read behind it (`agentLine` in `owner/conversations/copy.ts`); an agent with no outcome, or a missing fact, has none. It renders as text only.
- `quoteWithStatus` defaults to `true`. Today's "Live now" sets it to `false` to keep its existing two-line layout: a status that asks for the owner, such as "Needs you", takes the quote's place. Live now leaves out identity statuses ("Visitor", "Verified customer") beside a quote.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `time` | `string` | Required. Shown as given. |
| `status` | `{ tone: StatusTone; text: string }` | The dot is `aria-hidden`; the words carry the status. Left out when the name already says it. |
| `href` | `string` | Required. |
| `current` | `boolean` | `aria-current="true"` on the selected fill. |
| `unread` | `boolean` | Defaults to `false`. Shows the unread dot, stronger ink and tinted fill; the hidden prefix joins the link's name. |
| `recorded` | `boolean` | The Recorded tag at the end of the status line. Its word joins the link's name. |
| `demoVisitor` | `boolean` | The "Demo visitor" pill right after the name. Its words join the link's name. |
| `quote` | `string` | The visitor's own words, quoted below the name and time and above the status or tag. They join the link's name. A blank quote is left out. |
| `line` | `string` | The app's own preview line, unquoted, in the quote's place and style. It joins the link's name. A quote wins over it; a blank line is left out. |
| `quoteWithStatus` | `boolean` | Defaults to `true`. Set to `false` for Live now's layout, where a status or Recorded tag takes the quote's (or the line's) place. |

The hover fill changes at `motion-instant`. Nothing moves under reduced motion.
