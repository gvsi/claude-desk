# MarginNote

`MarginNote` is an owner note attached under a message that isn't a checkpoint result: a hollow dot beside one line, laid out like a `MarginReceipt`.

## When to use

- On owner screens, in a `TranscriptRow`'s `margin`, for things worth noting under a message that no check decided: "Name and phone saved to Customers as a new lead.", "Dana never sees whispers. Your rules still apply to what Claude does with them."
- Not for checkpoint results, which are `MarginReceipt`s with their own dot, and never on visitor surfaces.

## What the consumer provides

- `text`: the owner screen's own words, shown exactly as given.
- `onOpen` when there is a trace behind the note. The note becomes a button named "{text} Open the full trace."

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. |
| `onOpen` | `() => void` | Optional. Without it the note is plain text. |

The dot is the hollow `info` dot, `aria-hidden`.
