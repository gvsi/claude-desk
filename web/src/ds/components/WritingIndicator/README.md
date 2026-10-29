# WritingIndicator

`WritingIndicator` says that someone is writing, "Claude is writing" or "Dana is typing", and nothing more.

## When to use

- While a visitor's turn is between `EvWriting` and the delivered message or the turn's end.
- When a person on the other side is typing, with their name.
- In the setup interview while Claude prepares its next question.

## What the consumer provides

- `language`: the reader's language.
- `who` (optional): a person's name when they are the one typing. Without it, the line is about Claude.

It takes no message text. Claude's draft is checked by the kernel before anyone sees it, so the screen shows this line until the delivered message replaces it.

## Copy

| | English | Spanish |
| --- | --- | --- |
| Claude | Claude is writing | Claude está escribiendo |
| A person | {who} is typing | {who} está escribiendo |

The name is someone's own words: it is set off as user text (`.cd-user-name`, `data-copy="user"`) at the start of the line, so a visitor who calls themselves "Claude" reads as a name, never as Claude writing. The rest is interface copy.

## Look and motion

- One line in the meta type, in `text-secondary`, aligned where the consumer places it.
- `role="status"`, so a screen reader announces it once when it appears.
- It pulses over `motion-writing` (1.6 s): the words move between `text-secondary` and `text-primary` and back. Every moment of the pulse keeps the contrast of those two tokens.
- Under `prefers-reduced-motion: reduce` it stays still in `text-secondary`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `language` | `'en' \| 'es'` | Required. Sets `lang` on the line. |
| `who` | `string` | Optional. A blank name is treated as absent. |
