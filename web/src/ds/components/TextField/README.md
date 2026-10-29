# TextField

`TextField` is a labelled text input, or a four-line text area, with a hint and an error under it.

## When to use

- For words the owner types into a form: the demo passcode, a business description, a Desk's name.
- Not for chat. Messages, whispers and answers to Claude go in the `Composer`.
- Not for the six-digit verification code, which has its own form.

## What it shows

- The label above the field, in control type. It always shows and names the field, so the outline is never the only sign that this is a field.
- The field on the page's own ground: a 1 px `line-control` outline (`line-control-hover` on hover) at `radius-control`, `size-control-main` tall, with the text in `body` type. Focus shows the 2 px `accent-blue` ring at a 2 px offset.
- With `multiline`, a text area four lines tall. Enter adds a line, it can be dragged taller but never wider, and long words wrap.
- The hint under the field in `meta` type, `text-secondary`.
- The error under that: a refused dot beside the words, in `text-primary`. The outline stays neutral, so the error is never shown by color alone.

## Accessibility

- The label is a `<label>` tied to the field.
- The error and the hint describe the field (`aria-describedby`, the error first). An error also sets `aria-invalid="true"`.
- The error sits in a polite live region that is always there, so an error that appears after a submit is announced even though focus is on the submit button.

## What the consumer provides

- `value` and `onChange`. The field shows whatever `value` the form passes back.
- `error` in plain words that say what to do, never a code: "That passcode didn't work. Check it and try again." Clear it when the owner fixes the field or submits again.
- `autoComplete` where the browser can help: `current-password` for the passcode.
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

The outline's color changes at `motion-instant`. Nothing moves under reduced motion.
