# TakeOverBar

`TakeOverBar` says who is answering a conversation and holds the owner's controls for it, above the composer.

## When to use

- At the foot of the owner's conversation view, above the whisper composer (`ai`), the owner's composer (`owner`), or on its own (`paused`, which has no composer).
- Not on visitor surfaces.

## Modes

| `mode` | Lines | Controls | What the visitor sees |
| --- | --- | --- | --- |
| `ai` | "Whispers steer Claude. {visitorName} never sees them, and your rules still apply." | secondary "Take over" | "{visitorName} sees “{ownerName} joined the chat.”" |
| `owner` | "You're in this chat", "Claude won't send anything here until you hand it back." | secondary "Hand back to Claude" | "{visitorName} sees “Claude is helping again.”" |
| `paused` | The held dot and "Claude paused this chat after repeated blocked attempts." | primary "Resume Claude", secondary "Take over" | None |

A mode this build doesn't know shows the `ai` bar, which offers only Take over. `agent` drops the line about what the visitor sees: agents never receive it.

## What the consumer provides

- `mode` from the session, `visitorName` as the screen names the visitor (`whoLabel`), and `ownerName`, the business's `owner_display_name`, which the visitor sees. Both names are shown as people's own words.
- `onTakeOver`, `onHandBack` and `onResume`, which call the API's take-over, hand-back and resume routes (the kernel's `POST /sessions/{id}/mode` behind them).
- `pending` while the change is sent: every control waits, with `aria-busy` on the bar.
- `error`, the screen's line for a change that failed (`errorCopy`), shown as an alert. It gives way to the next attempt while that is pending.
- Held `ApprovalCard`s stay answerable in every mode.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `mode` | `SessionMode` | Required. |
| `visitorName` | `string` | Required. |
| `ownerName` | `string` | Required. `owner_display_name`. |
| `agent` | `boolean` | An agent's session. |
| `onTakeOver` | `() => void` | Required. |
| `onHandBack` | `() => void` | Required. |
| `onResume` | `() => void` | Required. |
| `pending` | `boolean` | Every control waits. |
| `error` | `string` | The screen's line. |

The lines take the reading column (`size-reading`) and the controls the margin column (`size-margin`), as in the transcript above them; below the two columns' width the controls wrap under the lines. The buttons are `size-control-main`. When the mode changes under a button that had focus, focus moves to the bar's first line, and a button never turns into the opposite one under focus.
