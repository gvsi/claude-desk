# VisitorMessage

`VisitorMessage` shows what a visitor typed, in a faint bubble on the right (on the left in the owner's conversation view, `Transcript`'s `variant="owner"`).

## When to use

- Every visitor message in a transcript, on the public page and in the owner's view. The setup interview also uses it for the owner's answers.
- Only for words a person typed. Claude's words are a `ClaudeMessage`, the owner's words after a take-over are a `PersonMessage`, and a visiting agent's request is an `AgentMessage`.

## What the consumer provides

- `text`: the message exactly as typed. It renders as text, never as markup, and keeps its line breaks. It is marked `data-copy="user"`, so the copy check's voice rules don't apply to it; its design rules still do.
- `translation` (optional, owner screens only): Claude's translation of a message in another language. A line under the bubble reads "Translated by Claude:" and then the translation, with the translate icon. A blank translation shows no line.

## Look

- Sans in the message type (15/21), on `fill-bubble`, at the card radius, padded 8 by 14 px.
- At most 85% of the column wide. A long unbroken word wraps inside the bubble (`overflow-wrap: anywhere`), so nothing reaches past a phone's line.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. |
| `translation` | `string` | Optional. The translated words are user text too; the label is not. |
