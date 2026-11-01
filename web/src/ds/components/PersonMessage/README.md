# PersonMessage

`PersonMessage` shows a person speaking in the chat, usually the owner after taking over, with their initials, name and words in sans.

## When to use

- Every `EvMessage` whose `author` is `owner`: the owner's say, delivered as one `owner_said` block.
- The owner's own words on their screens, such as a rule change typed in the rules chat, labelled "You".
- Not for visitors, who get a `VisitorMessage`, and not for Claude, who gets a `ClaudeMessage`.

## What the consumer provides

- `name`: the person's name as text, such as `owner_display_name` ("Mike Turner") or "You".
- `initials` (optional): the initials beside the name when the name shown isn't the person's own. On the owner's own screen his message reads "You" beside his own initials ("MT"), never a "Y" taken from the label.
- `role` (optional): what they are here, shown after the name in secondary text, such as "owner".
- `blocks`: the message's blocks. Each block's `text` shows verbatim, with no card frame and no label, because the kernel delivers an owner's say exactly as written. There is no translated take-over message.
- `language`: the event's `language`, set as `lang` on the words.

## Look

- Initials on `bg-selected` in a 28 px circle. They are `aria-hidden`, because the name beside them is the text. They are the first letters of the name's first and last words, as written, unless `initials` gives the person's own.
- The name in the meta type at weight 520, then the role, then the words in the message type (15/21). No bubble.
- The name and the words are marked `data-copy="user"`; the role is interface copy.
- The frame, the initials and the line that names them over the words, is `PersonFrame`, which `WritingIndicator`'s person form draws too while they type, with three dots where the words will start. Their message then takes its place without moving.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `initials` | `string` | Optional. The person's own initials, when `name` is "You". |
| `role` | `string` | Optional. A blank role is left out. |
| `blocks` | `readonly RenderedBlock[]` | Required. A blank block takes no space. |
| `language` | `'en' \| 'es'` | Required. |
