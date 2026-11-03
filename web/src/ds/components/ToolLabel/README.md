# ToolLabel

`ToolLabel` is a quiet line for something Claude did with a tool during setup, such as "Searched your sample Claude memory".

## When to use

- In setup's conversation, for each `tool_label` message, between Claude's questions and the owner's answers: "Searched your sample Claude memory", "Read turnerplumbing.example", or a line saying a website couldn't be read.
- Not for a visitor's conversation, where what Claude did shows as a receipt under its message (`MarginReceipt`).

## What it shows

- One line in `.cd-type-meta`, `text-secondary`: a 14 px `document` icon (`aria-hidden`), 6 px from the words.
- The words exactly as given, as text: markup in them shows as written. A long label wraps under its words, and a word with no break in it breaks rather than leaving the line.
- Nothing to press.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. The API's words for what Claude did. |
