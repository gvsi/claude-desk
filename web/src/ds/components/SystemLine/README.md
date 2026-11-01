# SystemLine

`SystemLine` is a quiet line about the chat itself, centered between two hairlines: someone joined, Claude is back, a visitor confirmed it's them.

## When to use

- When the owner joins: "Mike Turner joined the chat", from `EvOwnerJoined.name`.
- When the owner hands back: "Claude is helping again.", for `EvOwnerLeft`.
- When a visitor confirms it's them. The verification form's `VerifiedLine` builds on it and adds the simulated label for every session but the owner's own.
- Not for checkpoint results. Those are margin receipts.

## What the consumer provides

- `text`: the line, in the reader's language. It shows no time, because no contract carries one and visitor surfaces show no clock times outside the public header's open status.
- `initials` (optional): a person's initials, shown in a small circle beside the words and hidden from screen readers.

## Look and behavior

- A secondary caption, centered, with a 1 px `line-hairline` rule on each side. The rules share the room left over equally and keep at least 16 px each, so a long line wraps rather than pushing them out.
- `role="status"`, so a screen reader announces it, and inside the transcript's log it arrives in order.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. |
| `initials` | `string` | Optional. A blank value shows no circle. |
