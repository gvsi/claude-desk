# WritingIndicator

`WritingIndicator` says that someone is writing, "Claude is writing" or "Dana is typing", and nothing more: as one line, or, for a person, as a typing bubble on their side of the transcript.

## When to use

- The line, while a visitor's turn is between `EvWriting` and the delivered message or the turn's end: "Claude is writing", on Claude's side.
- In the setup interview while Claude prepares its next question.
- The bubble (`variant="bubble"`) when a person on the other side is typing, with their name: the visitor on the owner's conversation screen (`side="visitor"`, the right), or the owner after a take-over on the public page (`side="person"`, the left). Put it in a `TranscriptRow` at the end of the `Transcript`, where their next message will appear; the message replaces it.
- Claude never types in a bubble: Claude's writing is always the line.

## What the consumer provides

- `language`: the reader's language.
- `who`: a person's name when they are the one typing. Without it, the line is about Claude. The bubble needs it: a blank name shows no bubble, never "Claude is writing".
- `variant`: `line` (the default) or `bubble`.
- `side` (bubble only): `visitor` (the default) or `person`.

It takes no message text. Claude's draft is checked by the kernel before anyone sees it, and a person's draft is theirs until they send it, so the screen shows this indicator until the delivered message replaces it.

## Copy

| | English | Spanish |
| --- | --- | --- |
| Claude | Claude is writing | Claude está escribiendo |
| A person | {who} is typing | {who} está escribiendo |

The name is someone's own words: it is set off as user text (`.cd-user-name`, `data-copy="user"`) at the start of the line, so a visitor who calls themselves "Claude" reads as a name, never as Claude writing. The rest is interface copy. The bubble says the same words to screen readers, visually hidden.

## Look and motion

The line:

- One line in the meta type, in `text-secondary`, aligned where the consumer places it.
- It pulses over `motion-writing` (1.6 s): the words move between `text-secondary` and `text-primary` and back. Every moment of the pulse keeps the contrast of those two tokens.

The bubble:

- Three `size-dot` round dots, `space-4` apart, in a bubble with the visitor bubble's fill (`fill-bubble`) and radius (`radius-card`), padded `space-14` at the sides and one message line tall (37 px, as a one-line bubble is), so the message that replaces it doesn't move what is around it.
- On the visitor's side it ends where their bubbles end, at the right; on the person's side it starts at the left, where their words appear.
- The dots pulse one after another over the same `motion-writing` loop, `motion-stagger` apart, between `text-secondary` and `text-primary` (6.6:1 and 12.0:1 on `fill-bubble` over `bg-app`).

Both:

- `role="status"`, so a screen reader announces the words once when they appear. The bubble's dots are `aria-hidden`, and the pulse is drawn by the stylesheet alone, so nothing in the live region changes while it pulses and it is never announced again.
- Under `prefers-reduced-motion: reduce` they stay still: the line in `text-secondary`, the dots in `text-secondary`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `language` | `'en' \| 'es'` | Required. Sets `lang` on the indicator. |
| `variant` | `'line' \| 'bubble'` | `line` by default. |
| `who` | `string` | Optional for the line, required for the bubble. A blank name is treated as absent. |
| `side` | `'visitor' \| 'person'` | Bubble only. `visitor` (the right) by default. |
