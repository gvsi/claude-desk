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
- A click anywhere on the box that isn't one of its controls (its padding, the empty part of the row under the text) focuses the text box with the caret at the end, as on claude.ai. Its buttons and the counter keep their own click, words selected in the text box stay selected, a selection started in the text box and released on the box is kept, and a disabled composer does nothing.

## What the consumer provides

- `label`, the text box's name, and `placeholder`, shown in the empty box. On a visitor surface both are in the visitor's language, and so is `sendLabel` ("Enviar").
- `helper` when one plain line says what happens to the words ("Rule changes are shown to you before they apply."). It is the text box's description.
- `maxLength` to cap the text (2000 for a chat message). From 90% of it a counter shows ("1800 / 2000"), in numbers only so it reads the same in English and Spanish, and joins the description.
- `onAttach` and `onSpeak` only when they do something: without a handler there is no button, so no control is dead.
- `onSend` gets the trimmed text, never empty. The composer clears itself. To keep a message that failed, show it in the transcript with a way to try again, or keep it in the composer with `failed` (below), as the setup interview does with an owner's answer.
- `sendHeld` while Claude's reply is coming in (waiting for it, its stream, its reveal): typing works and the text box keeps focus, but Send is disabled and Enter does nothing (Shift+Enter still starts a new line). The text stays, and Send works again once the screen lifts it. No words say so; the disabled Send is the visible state. Keep `disabled` for a box nothing may be typed in (no session, a paused chat, a finished step).
- `inertSend` is for the vision pages only (the phone and Claude account vision pages), which make no requests: typing works and Send keeps its look (disabled while the box is empty), but Send and Enter do nothing, `onSend` is never called, and the text stays. Never on a real chat. The first press shows `VISION_INERT_LINE`, "This is a vision page, so nothing is sent.", once, in a secondary caption 8 px under the composer, in a polite live region (`role="status"`) that is there from the start and takes no room until then; later presses change nothing and announce nothing. While `failed` is set, the failed box shows instead and no vision line is drawn; once it clears, the composer is inert as before.

## A send that failed

`failed` (N-R2-Setup-04-Answer-Failed) keeps what was sent in the composer until the screen tries again:

- `line`, the screen's own words for what happened and what to do ("I couldn't answer just now. Your answer is still here; try again."), as an error `Notice`: a refused dot, read out at once. It sits 20 px over the box.
- The box keeps the composer's surface, radius and shadow, without its hairline, as the board draws it, padded 12 px 14 px. In it, `text`, the words as `onSend` got them, in `.cd-type-body` marked `data-copy="user"`, keeping their line breaks, then 12 px after them a primary "Try again" (`retryLabel`, for a screen in another language: "Intentar de nuevo"), both on the box's bottom line: 56 px high around one line. The box is a group named by `label`. Kept text is capped at six lines and scrolls internally, so Try again stays in view. It is a tab-focusable region named by the same `label`; arrow keys scroll its words, and keyboard focus shows the standard 2 px `ring-focus` ring at a 2 px offset. Short text keeps its existing size and layout.
- Nothing can be typed while it shows, and the helper, the counter and the other buttons are left out. "Try again" calls `onRetry()`: the screen sends `text` again and passes `disabled` while that send is in flight, so the button waits (`aria-disabled`, focus kept) and a second press calls nothing. It clears `failed` once the send goes through, and the text box comes back empty.
- Focus follows only from the composer's own control: when the text box had focus as the failure arrived, "Try again" takes it, and when "Try again" had it, the text box takes it back. Focus the owner left elsewhere, on another control or on the page itself, stays there, and a composer that opens failed takes no focus.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | `'owner' \| 'visitor' \| 'whisper'` | Required. The layout and the send button's default name. |
| `label` | `string` | Required. A visually hidden `<label>`. |
| `placeholder` | `string` | Required. |
| `helper` | `string` | In the controls row (`owner`) or under the box (`visitor`, `whisper`). |
| `sendLabel` | `string` | "Send" (`owner`, `visitor`) or "Send whisper" (`whisper`) by default. |
| `disabled` | `boolean` | Nothing can be typed or sent; with `failed`, "Try again" waits. |
| `sendHeld` | `boolean` | A reply is coming in: typing works and focus stays, but Send and Enter wait. `false` by default. |
| `maxLength` | `number` | Caps the text; a counter from 90% of it. |
| `onSend` | `(text: string) => void` | Required. |
| `onAttach` | `() => void` | Adds "Add a photo or file". |
| `onSpeak` | `() => void` | Adds "Speak instead". |
| `failed` | `{ text: string; line: string; retryLabel?: string; onRetry: () => void }` | A send that failed: `line` over the box, which keeps `text` beside "Try again" (`retryLabel`). Pass `disabled` while the send is in flight again. |
| `inertSend` | `boolean` | Vision pages only: Send and Enter do nothing and the text stays. `false` by default. |

`bg-surface`, `radius-composer`, an inset `line-hairline` and `shadow-composer`. The text is `.cd-type-message`. While the text box has focus it shows its caret, by pointer or keyboard, and no ring, and the box's inset edge goes from `line-hairline` to `line-field` (3.1:1 on `bg-surface`), so focus shows while the caret blinks off (owner, 2026-11-01, WCAG 2.4.7). A button inside it (attach, speak, send) shows its own ring on keyboard focus. The single-row composer is 52 px high with one line of text.

On a touch screen each `IconButton` takes a tap in the 44 px square centred on it, but its hit area reaches only halfway across the gap to the control beside it: 2 px between adjacent buttons in the owner's tools, which are 4 px apart, and 4 px in the visitor's row, whose controls and text box are 8 px apart. A sole Send in the owner's tools keeps its full 44 px square. A tap between two controls lands on the nearer one.
