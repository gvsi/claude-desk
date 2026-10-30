# AskClaudePanel

`AskClaudePanel` is the owner's conversation with Claude about rules and connectors, in a panel beside the Rules page.

## When to use

- As `AppShell`'s `panel`, when the owner sends from the Rules page's "Ask Claude to change a rule or a connector" composer (N-Conn-12-Chat). The screen keeps the conversation and passes it as `children`.
- Nothing turns on, off or changes from the panel itself: Claude's cards lead into the same reviews as the page (`ConnectorOfferCard` opens the connector review, a drafted rule shows in `ChangeReview`).

## What it shows

- A complementary region named by its heading, "Ask Claude", `size-side-panel` (400 px) wide on `bg-panel`, with a `line-hairline` seam on its left and 24 px of padding (20 px at the bottom).
- Under 640 px it is a modal sheet instead (`role="dialog"`, `aria-modal`): the whole window, with 16 px of padding and no seam. It asks `AppShell` to make everything else inert, through `AppShellPanelContext`, so render it as the shell's `panel`. Focus moves to its composer, and stays inside it: Tab and Shift+Tab wrap, and a focus that lands outside it, by a key or a script, goes back to the last control inside, with or without a shell around it. When the screen removes it with focus inside, focus returns to what opened it. If the window widens past 640 px while it is open, it is a panel beside the page again, the page is live, and focus stays where it is; narrowing again makes it a sheet again. It is the same element at every width, so crossing 640 px keeps the composer's draft.
- A header: "Ask Claude" (`h2`, `.cd-type-section`) and an `IconButton` "Close" calling `onClose`.
- The conversation in a `role="log"` region with `aria-live="polite"`, so replies are announced: the owner's words (a `VisitorMessage` bubble, `text-primary` on `fill-bubble` over `bg-panel`, 11.0:1), Claude's serif replies (`ClaudeMessage`) and their cards, 16 px apart. It scrolls between the header and the composer. While `busy`, `WritingIndicator` says "Claude is writing" at its end; no draft is ever shown.
- An owner `Composer` at the bottom, labelled "Ask Claude", with the placeholder "Ask Claude"; it calls `onSend` with the trimmed words.
- Escape anywhere inside the panel calls `onClose`, unless something inside (an open menu) handled it first. Beside the page, the screen returns focus to what opened the panel; as a phone's sheet, the panel and the shell do.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `onClose` | `() => void` | Required. |
| `onSend` | `(text: string) => void` | Required. |
| `busy` | `boolean` | Shows the writing indicator. |
| `children` | `ReactNode` | The conversation. |
