# CodeBlock

`CodeBlock` shows code exactly as written, such as the example request on the agents page, in mono type on a quiet box.

## When to use

- For code or a request a developer reads and copies by hand: the agents page's example request.
- Not for one value with a copy button, which is a `CopyField`, and not for a ledger entry, which is the full trace's.
- Not on owner pages or anywhere a person who isn't a developer reads it.

## What the consumer provides

- `code`, exactly as it should be typed, with lines separated by `\n`. The block changes nothing.
- A visible heading before it when it needs one ("Example request"); the block itself carries no label.

## What it shows

- The code in the `code` type (JetBrains Mono, 13 px on a 20 px line) in `text-primary`, on a `fill-secondary` box at `radius-control`, padded 12 px by 14 px. Inside a card it reads 9.8:1.
- Every line kept, blank lines included. Long lines wrap inside the box, at any character, so the page never scrolls sideways on a phone.
- Marked `data-copy="code"`: machine text, which the copy check reads as written (capitals such as `POST` included). Marked `translate="no"` too, as the full trace is, so a page translator leaves it as written.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `code` | `string` | Required. Shown as written. |
