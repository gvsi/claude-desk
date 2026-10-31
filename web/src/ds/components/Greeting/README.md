# Greeting

`Greeting` is the top of Today: a greeting in Claude's serif voice, one quiet line about who is talking to the Desk right now, and the public link with a button to copy it.

## When to use

- Once, at the top of Today, as the page's title (`h1`). Other pages use `PageHeader`.

## What the consumer provides

- `text`, the greeting the screen builds from the owner's local time and name: "Good morning, Maria". The design system formats no times.
- `presence`, when there is something to say about who is here:
  - `line`, the words: "Two people and one agent are talking to your Desk right now.", "Quiet right now."
  - `people`, one `{ kind: 'person' | 'agent', initials? }` per visitor. The first three are drawn beside the line as small glyphs (a person's initials when given, else the person or agent glyph). They are `aria-hidden`: the line says it in words.
- `link`, the public link as the screen shows it (`label`) and `onCopy`, which copies it. The button is "Copy your Desk link".

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. `.cd-type-greeting` (serif, 36/44, weight 300). Balanced when it wraps, as `PageHeader`'s title is: on a phone, "Good morning, Maximiliana" takes two lines with the name whole on the second. |
| `presence` | `{ line: string; people: PresenceGlyph[] }` | The line in `body` type, `text-secondary`. At most three glyphs. |
| `link` | `{ label: string; onCopy: () => void }` | An outlined pill at the right; it drops under the text on a narrow line. |

## Motion

The presence glyphs are the screen's one small moment: their opacity breathes between 50% and 100% over `motion-breathe`, each half a breath out of step with the one before. Under `prefers-reduced-motion: reduce` they are still, at full opacity.
