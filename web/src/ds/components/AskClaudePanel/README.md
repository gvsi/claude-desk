# AskClaudePanel

`AskClaudePanel` is the owner's conversation with Claude about rules and connectors, in a panel beside the Rules page.

## When to use

- When the owner sends from the Rules page's "Ask Claude to change a rule or a connector" composer (N-Conn-12-Chat). The screen keeps the conversation and passes it as `children`.
- Nothing turns on, off or changes from the panel itself: Claude's cards lead into the same reviews as the page (`ConnectorOfferCard` opens the connector review, a drafted rule shows in `ChangeReview`).

## What it shows

- An `aside` named by its heading, "Ask Claude", `size-side-panel` (400 px) wide on `bg-panel`, with a `line-hairline` seam on its left and 24 px of padding (20 px at the bottom). Under 640 px it takes the full width, with 16 px of padding and no seam.
- A header: "Ask Claude" (`h2`, `.cd-type-section`) and an `IconButton` "Close" calling `onClose`.
- The conversation in a `role="log"` region with `aria-live="polite"`, so replies are announced: the owner's words (a `VisitorMessage` bubble, `text-primary` on `fill-bubble` over `bg-panel`, 11.0:1), Claude's serif replies (`ClaudeMessage`) and their cards, 16 px apart. It scrolls between the header and the composer. While `busy`, `WritingIndicator` says "Claude is writing" at its end; no draft is ever shown.
- An owner `Composer` at the bottom, labelled "Ask Claude", with the placeholder "Ask Claude"; it calls `onSend` with the trimmed words.
- Escape anywhere inside the panel calls `onClose`, unless something inside (an open menu) handled it first. The screen returns focus to what opened the panel.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `onClose` | `() => void` | Required. |
| `onSend` | `(text: string) => void` | Required. |
| `busy` | `boolean` | Shows the writing indicator. |
| `children` | `ReactNode` | The conversation. |
