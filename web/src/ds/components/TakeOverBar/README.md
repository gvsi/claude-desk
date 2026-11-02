# TakeOverBar

`TakeOverBar` says who is answering a conversation and holds the owner's controls for it, above the composer.

## When to use

- At the foot of the owner's conversation view, above the whisper composer (`ai`), the owner's composer (`owner`), or on its own (`paused`, which has no composer).
- Not on visitor surfaces.

## Modes

| `mode` | Lines | Controls | What the visitor sees |
| --- | --- | --- | --- |
| `ai` | "{visitorName} never sees whispers. Whispers steer Claude, and your rules still apply." | secondary "Take over" | "{visitorName} sees “{ownerName} joined the chat.”" |
| `owner` | "You're in this chat", "Claude won't send anything here until you hand it back." | secondary "Hand back to Claude" | "{visitorName} sees “Claude is helping again.”" |
| `paused` | The held dot and "Claude paused this chat after repeated blocked attempts." | primary "Resume Claude", secondary "Take over" | None |

A mode this build doesn't know shows the `ai` bar, which offers only Take over. `agent` drops the line about what the visitor sees: agents never receive it.

With `takeOverAbove`, the screen draws Take over itself, in the bar at the top of the owner's open conversation (board REV-720 C): while Claude answers, this bar keeps only its line about whispers, with no button and no line about what the visitor sees. The screen spins its Take over only for its own press; other pending changes leave it waiting. When that button goes while focused, the screen moves focus to `.cd-take-over__first`. After its own press ends, the screen brings the alert into view on failure, or, when the mode is now `owner` and focus hasn't reached the controls, brings `.cd-take-over__first` into view instantly with `scrollIntoView({ block: 'nearest' })`. The owner and paused bars are unchanged.

## What the consumer provides

- `mode` from the session, `visitorName` as the screen names the visitor (`whoLabel`), and `ownerName`, the business's `owner_display_name`, which the visitor sees. Both names are shown as people's own words (`data-copy="user"`). The visitor may have chosen their name, so it is set off as user text (`.cd-user-name`) and starts each line it is in: no sentence of the bar's own runs into it.
- `onTakeOver`, `onHandBack` and `onResume`, which call the API's take-over, hand-back and resume routes (the kernel's `POST /sessions/{id}/mode` behind them).
- `pending` while the change is sent: every control waits, unpressable, with `aria-busy` on the bar. The button pressed here shows the busy spinner and the others step to their busy colors without one (`Button`'s `waiting`); a change the screen reports as sent from elsewhere spins none.
- `error`, the screen's line for a change that failed (`errorCopy`), shown as an alert. It gives way to the next attempt while that is pending.
- Held `ApprovalCard`s stay answerable in every mode.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `mode` | `SessionMode` | Required. |
| `visitorName` | `string` | Required. |
| `ownerName` | `string` | Required. `owner_display_name`. |
| `agent` | `boolean` | An agent's session. |
| `takeOverAbove` | `boolean` | The `ai` bar keeps only its line. The screen owns Take over above: spin only for its own press, move focus to `.cd-take-over__first` when the focused button goes, and reveal the alert or owner's first line after its press as described above. |
| `offerTakeOver` | `boolean` | Defaults to `true`. Set to `false` for an ended demo visitor: the paused bar keeps only Resume Claude. |
| `onTakeOver` | `() => void` | Required. |
| `onHandBack` | `() => void` | Required. |
| `onResume` | `() => void` | Required. |
| `pending` | `boolean` | Every control waits; only the one pressed here spins. |
| `error` | `string` | The screen's line. |

The lead lines take at most `size-reading`. In the owner’s open conversation, the bar fills the centred `size-conversation` column and its controls sit below the lead at the left; Take over itself sits in the conversation's bar at the top (`takeOverAbove`). Elsewhere, the controls start at `size-margin` beside the lead and grow into the available width; below the two columns' width they wrap under the lines and fill the row. The visitor hint uses that width instead of staying in a narrow column, so it stays on one line wherever its words fit and wraps naturally on a phone. `AvailableWidth` shows it at the 640 px composer width. The buttons are `size-control-main`. When the mode changes under a button that had focus, focus moves to the bar's first line, and a button never turns into the opposite one under focus.
