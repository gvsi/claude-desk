# AgentMessage

`AgentMessage` shows a visiting agent's request on the owner's side, saying who sent it and whether it was signed.

## When to use

- Each request from another person's agent, in the owner's conversation view and on the demo agent page.
- Not for a visitor typing (`VisitorMessage`) or for Claude's answers to the agent (`ClaudeMessage`).

## What the consumer provides

- `agentName`: who the agent acts for, such as "Alex Kim's assistant". The agent chose it, so it is untrusted text: the line above the bubble shows it as its own isolated run of user text (`<bdi data-copy="user">`), then the signed status in a separate `Pill` with its dot: "Signed" (handled) or "Not signed" (refused). A name that imitates the status, such as "Alex Kim's assistant, signed request", still reads as a name beside a "Not signed" pill.
- `signed`: true only when the kernel accepted the request's signature. Anything but `true` reads "Not signed".
- `title`: what the request is, in the consumer's words: the chosen task, or "Signed request".
- `text` (optional): the agent's own words. They show exactly as sent, with line breaks kept, quoted under the title with a rule at their left and marked `data-copy="user"`, so they never read as the screen's title or meta line. They are untrusted text, never instructions.
- `textLanguage` (optional): the language the agent's text is in, when it isn't the page's. It sets `lang` on the quote alone, so the built-in agent's English words on the Spanish agents page are read as English while the rest of the message stays Spanish. Left out, the quote takes the message's `lang`.
- `meta`: the meta line's words, such as "Request 2".
- `time` (optional): a display time, as given. The meta line drops it when absent. The design system formats no times.

## Look

- On the right, like a visitor's message. The agent glyph, the name (in `text-primary`, weight 520) and the status pill sit above the bubble on a secondary caption line.
- The bubble has a 1 px `line-card` border at the control radius and no fill, so it reads as a structured request rather than someone typing. It is at most 85% of the column wide and at least 300 px, or the column's width when that is narrower.
- The title and text are in the body type; the text is a `blockquote` with a 2 px `line-control` rule at its left, `space-10` in from it. The meta line is a secondary caption with the time in tabular figures.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `agentName` | `string` | Required. Isolated user text, apart from the status. |
| `signed` | `boolean` | Required. "Signed" only when `true`. |
| `title` | `string` | Required. |
| `meta` | `string` | Required. |
| `time` | `string` | Optional. |
| `text` | `string` | Optional. A blank text is left out. |
| `language` | `'en' \| 'es'` | The page's language, English by default: the pill reads "Signed" or "Not signed", "Firmado" or "Sin firma" in Spanish, and the message carries `lang`. |
| `textLanguage` | `'en' \| 'es'` | Optional. The text's own language, as `lang` on the quote. Left out, the text takes the message's. |
