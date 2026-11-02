# AskClaudePanel

`AskClaudePanel` is the owner's conversation with Claude about rules and connectors, in a panel beside the Rules page.

## When to use

- As `AppShell`'s `panel`, when the owner sends from the Rules page's "Ask Claude to change a rule" composer (N-Conn-12-Chat). The screen keeps the conversation and passes it as `children`.
- Nothing turns on, off or changes from the panel itself: Claude's cards lead into the same reviews as the page (`ConnectorOfferCard` opens the connector review, a drafted rule shows in `ChangeReview`).

## What it shows

- A complementary region named by its heading, "Ask Claude", `size-side-panel` (400 px) wide on `bg-panel`, with a `line-hairline` seam on its left and 24 px of padding (20 px at the bottom).
- Beside the page it slides in as it opens and out as it closes, and the page glides to make room; `AppShell` runs that move (see its README). As a sheet it appears and goes at once.
- Under 1024 px it is a modal sheet instead (`role="dialog"`, `aria-modal`). The rule is that the page beside the panel never gets under 360 px: the sidebar's 264 px column and the panel's 400 px leave it 360 px at 1024 px, and an upright tablet (768 px) would leave it 104 px.
  - From 640 px to 1023 px (a tablet) the sheet is the panel as it is beside the page, 400 px wide with its padding and seam, docked at the window's right edge at its full height, so the conversation keeps the panel's measure. `scrim` covers the rest of the window, as behind `Dialog` and the other sheets, with no shadow.
  - Under 640 px (a phone) it is the whole window, with 16 px of padding, no seam and no scrim.
  - A press on the scrim, or on the sheet's own padding, does nothing: the sheet stays open, keeping a half-written question, and focus stays on the control that had it. Only Close and Escape close it.
  - A press on text inside the sheet that can't take focus (the heading, the conversation) lands on the sheet itself (`tabIndex={-1}` while it is a sheet), never on the page: Escape still closes it, and Tab and Shift+Tab go to its first and last controls.
- As a sheet it asks `AppShell` to make everything else inert, through `AppShellPanelContext`, so render it as the shell's `panel`. Focus moves to its composer, and stays inside it: Tab and Shift+Tab wrap, and a focus that lands outside it, by a key or a script, goes back to the last control inside, with or without a shell around it. When the screen removes it with focus inside, focus returns to what opened it.
- If the window widens to 1024 px or more while it is open, it is a panel beside the page again, the page is live, and focus stays where it is; narrowing again makes it a sheet again. It is the same element at every width, so crossing 1024 px keeps the composer's draft.
- A header: "Ask Claude" (`h2`, `.cd-type-section`) and an `IconButton` "Close" calling `onClose`.
- The conversation in a `role="log"` region with `aria-live="polite"`, so replies are announced: the owner's words (a `VisitorMessage` bubble, `text-primary` on `fill-bubble` over `bg-panel`, 11.0:1), Claude's serif replies (`ClaudeMessage`) and their cards, 16 px apart. It scrolls between the header and the composer. While `busy`, Claude's writing dots (`WritingIndicator`) show at its end, with "Claude is writing" for screen readers; no draft is ever shown. The composer holds Send meanwhile (`Composer`'s `sendHeld`): the owner can type the next question and keeps focus, and it sends once the answer has come in.
- An owner `Composer` at the bottom, labelled "Ask Claude", with an example question as its placeholder, "What happens if someone asks for a discount?" (`ASK_CLAUDE_PLACEHOLDER`); it calls `onSend` with the trimmed words. The example is a question, not a rule change, so it can't be taken for a change waiting to apply.
- Escape anywhere inside the panel calls `onClose`, unless something inside (an open menu) handled it first. Beside the page, the screen returns focus to what opened the panel; as a sheet, the panel and the shell do.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `onClose` | `() => void` | Required. |
| `onSend` | `(text: string) => void` | Required. |
| `busy` | `boolean` | Shows the writing indicator, and holds the composer's Send and Enter. |
| `children` | `ReactNode` | The conversation. |

## What it returns focus to

As a sheet, the panel notes what opened it when it appears: the control that had focus outside it, or else the control the click that opened it landed on, since Safari focuses no button a click presses and leaves focus on the page's body. A capture listener on the document notes each click's control for that click's task only (`clickedControl.ts`), so a panel that opens later never takes an old click for its opener.

## Extra exports

| Export | What it is |
| --- | --- |
| `ASK_CLAUDE_PLACEHOLDER` | The composer's placeholder, "What happens if someone asks for a discount?". |
| `useAskClaudeIsSheet()` | Whether the panel is a modal sheet over the page at this window's width (under 1024 px), rather than beside it, kept up to date as the width crosses that breakpoint. The panel uses it to choose; a page uses it to wait for the sheet to close before showing something the sheet would cover, as Rules does with a confirmed change. |
