# Composer

`Composer` is the text box people write in: a raised surface at the composer radius that grows with the text up to six lines, with a round send button.

## When to use

- `owner`: the hero composer on Today and Rules ("Ask Claude about your Desk, or change a rule"), and wherever the owner answers Claude in their own words. The controls sit in a row under the text, with the helper line between them.
- `visitor`: the public page ("Message Rivera Plumbing"), one row with the send button at the end.
- `whisper`: a conversation while Claude answers ("Whisper to Claude. Dana won't see it."), one row, its send button named "Send whisper". Put a `TakeOverBar` above it.
- Not for a form field with a label above it: use `TextField`.

## Keys

- Enter sends the trimmed text and clears the composer; the text box keeps focus for the next message.
- Shift+Enter starts a new line.
- An Enter that confirms an IME word (during composition, or reported as key code 229 after it, as Safari does) does neither.
- Nothing is sent while the text is empty or only spaces: Enter does nothing and the send button is disabled.

## What the consumer provides

- `label`, the text box's name, and `placeholder`, shown in the empty box. On a visitor surface both are in the visitor's language, and so is `sendLabel` ("Enviar").
- `helper` when one plain line says what happens to the words ("Rule changes are shown to you before they apply."). It is the text box's description.
- `maxLength` to cap the text (2000 for a chat message). From 90% of it a counter shows ("1800 / 2000"), in numbers only so it reads the same in English and Spanish, and joins the description.
- `onAttach` and `onSpeak` only when they do something: without a handler there is no button, so no control is dead.
- `onSend` gets the trimmed text, never empty. The composer clears itself; to keep a message that failed, show it in the transcript with a way to try again.
- `inertSend` is for the vision pages only (the phone and Claude account vision pages), which make no requests: typing works and Send keeps its look (disabled while the box is empty), but Send and Enter do nothing, `onSend` is never called, and the text stays. Never on a real chat.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | `'owner' \| 'visitor' \| 'whisper'` | Required. The layout and the send button's default name. |
| `label` | `string` | Required. A visually hidden `<label>`. |
| `placeholder` | `string` | Required. |
| `helper` | `string` | In the controls row (`owner`) or under the box (`visitor`, `whisper`). |
| `sendLabel` | `string` | "Send" (`owner`, `visitor`) or "Send whisper" (`whisper`) by default. |
| `disabled` | `boolean` | Nothing can be typed or sent. |
| `maxLength` | `number` | Caps the text; a counter from 90% of it. |
| `onSend` | `(text: string) => void` | Required. |
| `onAttach` | `() => void` | Adds "Add a photo or file". |
| `onSpeak` | `() => void` | Adds "Speak instead". |
| `inertSend` | `boolean` | Vision pages only: Send and Enter do nothing and the text stays. `false` by default. |

`bg-surface`, `radius-composer`, an inset `line-hairline` and `shadow-composer`. The text is `.cd-type-message`. While the text box has focus the whole composer shows the focus ring (`ring-composer`, 2 px at a 2 px offset), because the canvas's 55% ring is 2.9:1. A button inside it (attach, speak, send) shows its own ring instead, so there is only ever one. The single-row composer is 52 px high with one line of text.
