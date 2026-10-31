# SuggestionChips

`SuggestionChips` is a row of at most three suggestion chips under a composer, each a thing to ask, handed to the screen when picked.

## When to use

- Under the owner's composer on Today and Rules ("What happened overnight?"), and for the things-to-try ideas a reviewer can send into the chat.
- Not for options someone chooses between: use `Chip` with `asRadio` in a `radiogroup`.

## What the consumer provides

- `label`, the group's name ("Suggestions").
- `suggestions`: up to three things to ask, in the person's words, sentence case, phrased as what they would type. Only the first three show.
- `onPick`, which gets the picked suggestion's words. The screen decides what a pick does: fill the composer or send it.
- `inertSuggestions` is for the vision pages only (the city office's), which make no requests. The chips keep their look, focus and tab order, but a pick does nothing and `onPick` is never called. The first pick shows "This is a vision page, so nothing is sent." (`VISION_INERT_LINE`) in a polite `role="status"` line, a secondary caption 8 px under the chips; later picks change nothing. The line is there, empty and taking no room, from the start, so its change is announced. Once it shows, it is brought into the nearest scroller's view (`scrollIntoView` with `block: 'nearest'`), as the chips can end a scroll region, such as the conversation on a public page, right above its pinned composer; the focus stays on the chip. Never on a real page.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The `role="group"`'s `aria-label`. |
| `suggestions` | `readonly string[]` | Required. At most three show. |
| `onPick` | `(suggestion: string) => void` | Required. |
| `inertSuggestions` | `boolean` | Vision pages only: a pick does nothing and the first one shows the vision line. `false` by default. |

Chips are 28 px and 8 px apart, and the row wraps. A long suggestion wraps inside the line instead of overflowing it on a phone.
