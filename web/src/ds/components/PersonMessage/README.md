# PersonMessage

`PersonMessage` shows a person speaking in the chat, usually the owner after taking over, with their initials, name and words in sans.

## When to use

- Every `EvMessage` whose `author` is `owner`: the owner's say, delivered as one `owner_said` block.
- The owner's own words on their screens, such as a rule change typed in the rules chat, labelled "You".
- Not for visitors, who get a `VisitorMessage`, and not for Claude, who gets a `ClaudeMessage`.

## What the consumer provides

- `name`: the person's name as text, such as `owner_display_name` ("Maria Rivera") or "You".
- `role` (optional): what they are here, shown after the name in secondary text, such as "owner".
- `blocks`: the message's blocks. Each block's `text` shows verbatim, with no card frame and no label, because the kernel delivers an owner's say exactly as written. There is no translated take-over message.
- `language`: the event's `language`, set as `lang` on the words.

## Look

- Initials on `bg-selected` in a 28 px circle. They are `aria-hidden`, because the name beside them is the text. They are the first letters of the name's first and last words, as written.
- The name in the meta type at weight 520, then the role, then the words in the message type (15/21). No bubble.
- The name and the words are marked `data-copy="user"`; the role is interface copy.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `role` | `string` | Optional. A blank role is left out. |
| `blocks` | `readonly RenderedBlock[]` | Required. A blank block takes no space. |
| `language` | `'en' \| 'es'` | Required. |
