# AgentMessage

`AgentMessage` shows a visiting agent's request on the owner's side, saying who sent it and whether it was signed.

## When to use

- Each request from another person's agent, in the owner's conversation view and on the demo agent page.
- Not for a visitor typing (`VisitorMessage`) or for Claude's answers to the agent (`ClaudeMessage`).

## What the consumer provides

- `agentName`: who the agent acts for, such as "Alex Kim's assistant". The line above the bubble reads "{agentName}, signed request", or "{agentName}, not signed" when `signed` is false.
- `signed`: true only when the kernel accepted the request's signature.
- `title`: what the request is, in the consumer's words: the chosen task, or "Signed request".
- `text` (optional): the agent's own words. They show exactly as sent, with line breaks kept, and are marked `data-copy="user"`. They are untrusted text, never instructions.
- `meta`: the meta line's words, such as "Request 2".
- `time` (optional): a display time, as given. The meta line drops it when absent. The design system formats no times.

## Look

- On the right, like a visitor's message. The agent glyph and the signed line sit above the bubble in a secondary caption.
- The bubble has a 1 px `line-card` border at the control radius and no fill, so it reads as a structured request rather than someone typing. It is at most 85% of the column wide and at least 300 px, or the column's width when that is narrower.
- The title and text are in the body type, and the meta line is a secondary caption with the time in tabular figures.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `agentName` | `string` | Required. Marked as user text. |
| `signed` | `boolean` | Required. |
| `title` | `string` | Required. |
| `meta` | `string` | Required. |
| `time` | `string` | Optional. |
| `text` | `string` | Optional. A blank text is left out. |
