# SuggestionChips

`SuggestionChips` is a row of at most three suggestion chips under a composer, each a thing to ask, handed to the screen when picked.

## When to use

- Under the owner's composer on Today and Rules ("What happened overnight?"), and for the things-to-try ideas a reviewer can send into the chat.
- Not for options someone chooses between: use `Chip` with `asRadio` in a `radiogroup`.

## What the consumer provides

- `label`, the group's name ("Suggestions").
- `suggestions`: up to three things to ask, in the person's words, sentence case, phrased as what they would type. Only the first three show.
- `onPick`, which gets the picked suggestion's words. The screen decides what a pick does: fill the composer or send it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The `role="group"`'s `aria-label`. |
| `suggestions` | `readonly string[]` | Required. At most three show. |
| `onPick` | `(suggestion: string) => void` | Required. |

Chips are 28 px and 8 px apart, and the row wraps. A long suggestion wraps inside the line instead of overflowing it on a phone.
