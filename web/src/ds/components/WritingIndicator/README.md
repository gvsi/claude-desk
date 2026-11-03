# WritingIndicator

`WritingIndicator` shows Claude writing as three clay dots that bounce gently on Claude's side, with "Claude is writing" for screen readers only. It reads as a reply coming, not a status message. A person's typing can be a line of words, a bubble on a visitor's side, or their initials and name with three dots on theirs.

## When to use

- The line, while a visitor's turn is between `EvWriting` and the delivered message or the turn's end: three dots where Claude's reply will appear, with "Claude is writing" for screen readers only.
- In the setup interview while Claude prepares its next question.
- The bubble (`variant="bubble"`) when the visitor is typing, with their name, on the owner's conversation screen: on their side, where their next bubble will appear, which is the left there (`Transcript`'s `variant="owner"`) and the right elsewhere.
- The person form (`variant="person"`) when the owner or another person is typing on their side, at the left: on the public page after a take-over, with the name their messages show ("Mike Turner").
- Put the bubble or the person form in a `TranscriptRow` at the end of the `Transcript`, where the next message will appear; the message replaces it.
- Claude never types in a bubble or a person form: Claude's writing is always the line.

## What the consumer provides

- `language`: the reader's language.
- `who`: a person's name when they are the one typing. Without it, the line is about Claude. The bubble and the person form need it: a blank name shows nothing, never "Claude is writing".
- `variant`: `line` (the default), `bubble` or `person`.

It takes no message text. Claude's draft is checked by the kernel before anyone sees it, and a person's draft is theirs until they send it, so the screen shows this indicator until the delivered message replaces it.

## Copy

| | English | Spanish |
| --- | --- | --- |
| Claude | Claude is writing | Claude está escribiendo |
| A person | {who} is typing | {who} está escribiendo |

Claude's copy is for screen readers only (`.cd-sr-only`). A person's name is their own words: it is set off as user text (`.cd-user-name`, `data-copy="user"`) at the start of the line, so a visitor who calls themselves "Claude" reads as a name, never as Claude writing. The rest is interface copy. The bubble says the whole line to screen readers, visually hidden; the person form shows the name and says the rest, visually hidden, after it.

## Look and motion

Claude's line:

- Three `size-dot` round dots in `clay`, `space-4` apart, at the left where Claude's first line of words will start. No indent, bubble or fill.
- The dots' box uses `cd-type-reply` and is one Claude reply line tall (`1lh`, 23 px), with the dots centered on it, so the reply takes their place without moving anything.
- The dots bounce 4 px up and back over `motion-dots` (1.2 s), eased with `motion-ease-bounce`, `motion-stagger` apart. Only their transform changes: the box stays the same size and the color stays clay. Under reduced motion they stay still in clay.

A person's line (`who` provided):

- One line in the meta type, in `text-secondary`, aligned where the consumer places it.
- It pulses over `motion-writing` (1.6 s): the words move between `text-secondary` and `text-primary` and back. Every moment of the pulse keeps the contrast of those two tokens.

The bubble:

- Three `size-dot` round dots, `space-4` apart, in a bubble with the visitor bubble's fill (`fill-bubble`) and radius (`radius-card`), padded `space-14` at the sides and one message line tall (37 px, as a one-line bubble is), so the message that replaces it doesn't move what is around it.
- It ends at the right of the row, where the visitor's bubbles end, or starts at the left in the owner's conversation view, where they start there.

The person form:

- `PersonMessage`'s own frame (`PersonFrame`): the 28 px initials circle (`size-avatar`, `bg-selected`) and the name in the meta type, `space-10` apart, at the left of the row. Under the name, `space-4` down, three `size-dot` dots, `space-4` apart, in one message line (21 px), starting where the name starts: where the first line of their words will start. No fill and no bubble: on the public page a bubble on that side could read as Claude typing.
- Their message takes its place in place: the initials, the name and the first line of words sit exactly where the initials, the name and the dots were, so nothing jumps.

The dots of the bubble and person forms pulse one after another over the same `motion-writing` loop, `motion-stagger` apart, between `text-secondary` and `text-primary` (6.6:1 and 12.0:1 on `fill-bubble` over `bg-app`; 7.3:1 and 13.9:1 on `bg-app`).

All forms:

- A `role="status"` line, so a screen reader announces "{who} is typing" (or "Claude is writing") once, politely, when it appears: the indicator itself for the line and the bubble, and the line that names the person in the person form. The dots and the initials are `aria-hidden`, and motion is drawn by the stylesheet alone, so nothing in the live region changes while it moves and it is never announced again.
- Under `prefers-reduced-motion: reduce` they stay still: Claude's dots in `clay`, a person's line and dots in `text-secondary`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `language` | `'en' \| 'es'` | Required. Sets `lang` on the live line. |
| `variant` | `'line' \| 'bubble' \| 'person'` | `line` by default. |
| `who` | `string` | Optional for the line, required for the bubble and the person form. A blank name is treated as absent. |
