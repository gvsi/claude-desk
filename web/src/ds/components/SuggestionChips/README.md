# SuggestionChips

`SuggestionChips` is a row of at most `max` suggestion chips (three by default) under a composer, each a thing to ask, handed to the screen when picked.

## When to use

- Under the owner's composer on Today and Rules ("What happened overnight?"), for the things-to-try ideas a reviewer can send into the chat, and under setup's box, the examples a description can start from.
- Not for options someone chooses between: use `Chip` with `asRadio` in a `radiogroup`.

## What the consumer provides

- `label`, the group's name ("Suggestions").
- `suggestions`: at most `max` things to ask (three by default), in the person's words, sentence case, phrased as what they would type. Only the first `max` show. A suggestion can also be a short label for longer text the screen puts in its place, as setup's examples are ("A tax preparer" stands for a whole description). The words must be unique within a row: the screen tells which chip was picked by them, and React keys the chips by them.
- `onPick`, which gets the picked suggestion's words, exactly as given. The screen decides what a pick does: fill the composer or send it, or look up the longer text a label stands for and put that in place.
- `disabled` while what a pick would change can't change: setup's examples, while a start is being settled and the box is read-only. The chips stay where they are, so nothing under them moves, dimmed as a disabled `Button` is, and `onPick` is never called.
- `inertSuggestions` is for the vision pages only (the city office's), which make no requests. The chips keep their look, focus and tab order, but a pick does nothing and `onPick` is never called. The first pick shows "This is a vision page, so nothing is sent." (`VISION_INERT_LINE`) in a polite `role="status"` line, a secondary caption 8 px under the chips; later picks change nothing. The line is there, empty and taking no room, from the start, so its change is announced. Once it shows, it is brought into the nearest scroller's view (`scrollIntoView` with `block: 'nearest'`), as the chips can end a scroll region, such as the conversation on a public page, right above its pinned composer; the focus stays on the chip. Never on a real page.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The `role="group"`'s `aria-label`. |
| `suggestions` | `readonly string[]` | Required. At most `max` show (three by default); unique within the row. |
| `max` | `number` | Three by default. Raise it only for setup's four starters. |
| `onPick` | `(suggestion: string) => void` | Required. Gets the picked chip's words. |
| `inertSuggestions` | `boolean` | Vision pages only: a pick does nothing and the first one shows the vision line. `false` by default. |
| `disabled` | `boolean` | Every chip off, in place and dimmed; `onPick` is never called. `false` by default. |

Chips are 28 px and 8 px apart, and the row wraps. A long suggestion wraps inside the line instead of overflowing it on a phone.

The agent panel composes two instances with an 8 px token gap: tasks without money first, payment tasks second. Each row wraps independently; a Desk without payment tasks omits the second instance and its gap.

On a touch screen (`pointer: coarse`) each chip takes a tap through an unseen hit area centred on it (`::after`), which reaches toward `size-touch` (44 px) but only halfway across the 8 px gap to each neighbour, beside it or, once the row wraps, above and below it. A one-line chip takes a tap 4 px past each edge, 36 px tall in all, and a tap between two chips lands on the nearer one. Nothing is drawn and no chip moves, and where the chips end a scroll region flush, as on a vision page's conversation, it scrolls no further: each chip has layout containment there, which keeps its hit area out of the region's extent. A full 44 px would need the rows 16 px apart, which would change how the row looks.
