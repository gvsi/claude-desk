# VerifyCodeForm

`VerifyCodeForm` is where a visitor types the six-digit code that confirms it's them, under the verify card in the chat.

## When to use

- Under the latest message that carries a `verify_prompt` card, while the visitor hasn't confirmed yet. Once the code works, the screen takes the form away and shows `VerifiedLine` in its place. If focus was in the form, the screen moves it to the line (`lineRef`, with `tabindex="-1"`, so it draws no edge and raises no phone keyboard) rather than letting it fall to the page.
- Not for the demo passcode or any other text. `TextField` and the first-visit dialog have their own fields.

## What it does

- The verify card above it carries the kernel's uniform message. The form repeats none of it: it shows only its label, its two buttons and, after a failed try, one line.
- The field is labelled "6-digit code" and is `inputmode="numeric"` and `autocomplete="one-time-code"`, so phones offer the number pad and a code from a text message.
- Only digits enter the field, six at most. Letters, spaces and dashes are dropped, and full-width digits count as the digits they are. The field has no `maxlength`: the browser would cut a code at six characters before its spaces or dash are dropped, so the form keeps the first six digits itself, however the code comes in (typed, pasted, dropped, or from a keyboard's clipboard suggestion). "482 913", "48 29 13", "482-913" and "Code: 482 913" all become 482913. Text that brings six digits or more of its own, such as a pasted or suggested code, is the new code: its first six digits replace whatever the field held, so the newest code pasted after a failed try is the one sent. Once six digits are in, anything typed, pasted or dropped with nothing selected is refused, and the six digits and the caret stay as they were; an input method's composition, which can't be refused before it lands, is undone the same way. Typing or pasting over a selection replaces it: "77" pasted over the 9 of 482913 gives 482771, while typing "77" there gives 482713, since the second 7 meets a whole code.
- Confirm is disabled until all six digits are in. Enter in the field or Confirm calls `onSubmit` with exactly those six digits. A second Enter or click before the screen moves the form to `checking` sends nothing more, so a double press can't spend a second try on the same code; changing the code or a new state allows another.
- While `checking`, Confirm keeps its words and is busy (`aria-busy="true"`, focusable but inert), the form has `aria-busy="true"`, and nothing more is sent. "I can’t get the code" still works.
- With `failed`, an error `Notice` (`role="alert"`) under the field reads "That code didn’t work. Check the newest code, or ask me for a new one." It is the same line for a wrong, expired or used-up code, as the verify route answers all three alike, and it never names the reason. The field gets `aria-invalid="true"`, is described by the line, and takes focus with its code selected, ready to type over. The line isn't shown while `checking`, so every failure is a new alert and is read out.
- "I can’t get the code" calls `onAskForOwner`.
- Nothing here fetches. The component holds the typed code and gives it only to `onSubmit`.

## What the consumer provides

- `state`: `checking` while the code is with the verify route, `failed` when it answers that the code didn't work, `idle` otherwise.
- `onSubmit`: post the code through the API's verify route. The code goes to the kernel, never to Claude.
- `onAskForOwner`: the same as the page's "Ask for" the owner.
- `askWaits` while a reply is coming in: "I can't get the code" waits (`aria-disabled`, focus kept, presses do nothing) until it has, as the composer's Send does.
- `language`: the visitor's language. The form sets `lang` to it.

## Copy (`verifyCopy.ts`)

| | English | Spanish |
| --- | --- | --- |
| Label | 6-digit code | Código de 6 dígitos |
| Button | Confirm | Confirmar |
| Failed try | That code didn’t work. Check the newest code, or ask me for a new one. | Ese código no funcionó. Revisa el más reciente o pídeme uno nuevo. |
| Way out | I can’t get the code | No me llega el código |
| Simulated label | Simulated verification | Verificación simulada |

## Layout

- At most 520 px wide, like the reply card above it.
- The label above the field in `control` type, 6 px over it. The field is `size-control-main` tall at `radius-control`, on the page's own ground in a 1 px `line-field` outline, the same on hover, as `TextField`'s, with the digits in `body` type and tabular figures. Confirm is a primary main button beside it, 8 px away, on the same line and as tall. The failed line and the ghost button "I can’t get the code" follow 10 px apart.
- The outline is the field's boundary: an empty field has no words of its own to say what it is, so the outline keeps 3:1 against the page (WCAG 1.4.11). The signed board N-Public-Verify-Run1 draws it in the fainter `line-control` (2.0:1), which the tokens keep for controls whose own words name them; the field follows every other text field instead (see the reference README).
- Nothing in the form moves; the buttons follow `Button`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `state` | `'idle' \| 'checking' \| 'failed'` | Required. `VerifyCodeState`. |
| `onSubmit` | `(code: string) => void` | Required. Called with six ASCII digits. |
| `onAskForOwner` | `() => void` | Required. |
| `askWaits` | `boolean` | A reply is coming in: "I can't get the code" waits. `false` by default. |
| `language` | `'en' \| 'es'` | Required. |

## VerifiedLine

`VerifiedLine` is the chat line once the code works: a `SystemLine` in the visitor's language, with "Simulated verification" / "Verificación simulada" after the screen's words. A code from the Demo inbox shows that the code went to the contact on record, not that the visitor holds that contact, so the line says the verification was simulated. It fails toward the label: every assurance but `owner_session` carries it, `demo_code`, `none` and any value this build doesn't know alike, and only the owner's own session shows the words alone.

| Prop | Type | Notes |
| --- | --- | --- |
| `text` | `string` | Required. The screen's words: "Verified with a code sent to •••• 0142". |
| `assurance` | `Assurance` | Required. Anything but `owner_session` adds the label, after a full stop. |
| `language` | `'en' \| 'es'` | Required. The label's language and the line's `lang`. |
| `lineRef` | `Ref<HTMLDivElement>` | The line's own element, for a screen that moves focus to it once the form it replaces goes. |
