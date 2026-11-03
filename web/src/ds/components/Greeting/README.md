# Greeting

`Greeting` is the top of Today: a greeting in Claude's serif voice, one quiet line about who is talking to the Desk right now, and at the right of its line the public link with a button to copy it, then the screen's own actions.

## When to use

- Once, at the top of Today, as the page's title (`h1`). Other pages use `PageHeader`.

## What the consumer provides

- `text`, the greeting the screen builds from the owner's local time and name: "Good morning, Mike". The design system formats no times.
- `presence`, when there is something to say about who is here:
  - `line`, the words: "Two people and one agent are talking to your Desk right now.", "Quiet right now."
  - `people`, one `{ kind: 'person' | 'agent', initials? }` per visitor. The first three are drawn beside the line as small glyphs (a person's initials when given, else the person or agent glyph). They are `aria-hidden`: the line says it in words.
- `link`, the public link as the screen shows it (`label`) and `onCopy`, which copies it. The button is "Copy your Desk link".
  - `copied`, true for a short while after a copy that worked. The screen owns the clipboard and the timer: Today sets it for `COPIED_FOR_MS` (1.6 s), starts again on each copy that works, and clears it on a failed copy or when Today unmounts. While it is true, the link's words give way to "Copied" in `text-primary`, and the copy icon to a check. The button keeps its name.
  - "Copied" is laid over the link's words, in the same cell, so the pill keeps its width and nothing beside it moves. It takes no pointer or selection, so the link can still be selected by hand.
  - "Copied" and the check are `aria-hidden`. The screen says it to screen readers in its own `role="status"` line ("Your Desk link is copied."), as Today does.
- `actions`, the screen's own controls, after the link pill: usually one `Button`. Today puts "Chat as a customer" there (secondary, `href` and `external`). The design system draws no action of its own.

## Layout

- From 640 px the text sits at the left and the pill and the actions at the right of the greeting's line, 24 px apart at least, in a row 12 px apart that wraps. That row has a 4 px top, so the pill and a button sit level with the greeting's first line (TOD-04). On a line too narrow for both, the row drops under the text, 16 px under it.
- Under 640 px the greeting, the presence line and the row stack, 16 px apart, from the same left edge; the pill and the actions wrap onto lines of their own as they need.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. `.cd-type-greeting` (serif, 36/44, weight 300). Balanced when it wraps, as `PageHeader`'s title is: on a phone, "Good morning, Maximiliana" takes two lines with the name whole on the second. |
| `presence` | `{ line: string; people: PresenceGlyph[] }` | The line in `body` type, `text-secondary`. At most three glyphs. |
| `link` | `{ label: string; onCopy: () => void; copied?: boolean }` | An outlined pill at the right; it drops under the text on a narrow line. `copied` says "Copied" with a check, at the same width. |
| `actions` | `ReactNode` | After the pill, in the same row. |

## Motion

- The presence glyphs are the screen's one small moment: their opacity breathes between 60% and 100% over `motion-breathe`, each half a breath out of step with the one before. At the faintest point a glyph's initials still read against its circle by 4.5:1, as text must, and its icon by more than 3:1, as a mark must (at 50% the initials fell to about 4.1:1).
- The copy button presses in on `:active` (`scale(0.97)`, `motion-fast`), with the check over it.
- When `copied` turns on or off, the link's words and "Copied" crossfade over `motion-fast`. The copy icon fades and shrinks out as the check fades and settles in (from `scale(0.8)`, on the emphasis ease), both over `motion-fast`.
- Under `prefers-reduced-motion: reduce` the glyphs are still at full opacity, the button doesn't press in, and "Copied" and the check draw at once.
