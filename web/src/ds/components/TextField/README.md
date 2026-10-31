# TextField

`TextField` is a labelled text input, or a four-line text area, with a hint and an error under it.

## When to use

- For words the owner types into a form: the demo passcode, a business description, a Desk's name.
- Not for chat. Messages, whispers and answers to Claude go in the `Composer`.
- Not for the six-digit verification code, which has its own form.

## What it shows

- The label above the field, in control type. It always shows and names the field, so the outline is never the only sign that this is a field.
- The field on the page's own ground: a 1 px `line-field` outline at `radius-control`, `size-control-main` tall, with the text in `body` type. The outline is the field's boundary, so it reads 3:1 against the ground (3.2 on `bg-app`, 3.1 on `bg-surface`), on hover too. Focus shows the 2 px `accent-blue` ring at a 2 px offset.
- With `multiline`, a text area four lines tall. Enter adds a line, it can be dragged taller but never wider, and long words wrap.
- The hint under the field in `meta` type, `text-secondary`.
- With `maxLength`, a counter at the right of the hint line from 90% of the limit ("1350 / 1500"), in `caption` type, `text-secondary`. It is numbers only, so it reads the same in English and Spanish, and it shows "1500 / 1500" when the field is full.
- The error under that: a refused dot beside the words, in `text-primary`. The outline stays neutral, so the error is never shown by color alone.

## Held fields

A read-only field, single or multiline, uses a `line-control` outline on `fill-secondary`, with a default cursor. Its words stay at full `text-primary` contrast, selectable and in the tab order, with the same focus ring. The muted fill says the words are held while a request settles; they can still be read and copied, so the field does not look disabled (owner, 2026-10-31, option B, “muted fill”; N-Explore-ReadOnly-B).

## Accessibility

- The label is a `<label>` tied to the field.
- The error, the hint and the counter describe the field (`aria-describedby`, in that order). An error also sets `aria-invalid="true"`.
- The error sits in a polite live region that is always there, so an error that appears after a submit is announced even though focus is on the submit button.

## What the consumer provides

- `value` and `onChange`. The field shows whatever `value` the form passes back.
- `error` in plain words that say what to do, never a code: "That passcode didn't work. Check it and try again." Clear it when the owner fixes the field or submits again.
- `autoComplete` where the browser can help: `current-password` for the passcode.
- `maxLength` where the text has a limit: 1500 for the business description that starts setup. Typing and pasting stop there, and the counter shows from 90% of it.
- `readOnly` while what was sent from the field is still being settled: setup's description after a start whose answer was lost, which "Try again" sends as it was. The text stays readable and selectable.
- `fieldRef` where the screen moves focus to the field itself: setup's box takes focus once an example is put in it.
- The form around it, and its submit button. The field doesn't submit anything itself.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. Shown above the field. |
| `value` | `string` | Required. |
| `onChange` | `(value: string) => void` | Required. Called with the new text. |
| `type` | `'text' \| 'password'` | `text` by default. Not used with `multiline`. |
| `multiline` | `boolean` | A four-line text area. |
| `hint` | `string` | One line under the field. |
| `error` | `string` | Shown under the hint; sets `aria-invalid`. |
| `autoComplete` | `string` | Passed to the field. |
| `maxLength` | `number` | Caps the text; a counter from 90% of it. |
| `readOnly` | `boolean` | Shows the text but takes no typing. |
| `fieldRef` | `Ref<HTMLInputElement \| HTMLTextAreaElement>` | The input or text area, for moving focus to it. |

Nothing moves: the outline keeps its color on hover, and focus shows the ring.
