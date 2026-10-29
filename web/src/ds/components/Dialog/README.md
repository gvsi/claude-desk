# Dialog

`Dialog` asks the owner before something happens: a question, what will happen, and a button to do it or leave things as they are.

## When to use

- Before something the owner can't easily undo: "Start over with a fresh copy?", "Delete Emergencies?".
- With `tone="danger"` when it can't be undone at all, such as deleting a Desk.
- Not for errors or news, which are a `Notice`, and not for anything a visitor sees.

## What it shows

- A native modal dialog centered over the page, which is dimmed and inert behind it. It is `bg-surface` with a `line-card` border at `radius-card`, 440 px wide at most, and has no shadow.
- The title in `section` type. `danger` adds a refused dot beside it; the words still say what will happen, and the buttons stay neutral.
- The body in `body` type, `text-secondary`.
- At the right, a secondary button that leaves things as they are (`cancelLabel`), then the primary button that does it (`confirmLabel`). Both say what happens: "Keep it", "Delete Desk".
- It appears in place; nothing slides or fades.

## Keyboard and focus

- When it opens, focus moves to the cancel button, the least destructive answer.
- Tab and Shift+Tab cycle between the buttons and never leave the dialog.
- Escape calls `onCancel`, as the cancel button does, and so does the browser's own close request (a back gesture, say).
- If the browser closes the dialog itself, as Android can after a repeated back gesture, it calls `onCancel` too, even while `pending`, so the screen removes it and its opener works again. A confirmation already sent goes on.
- When the screen removes it, focus returns to the control that opened it, unless the screen has moved focus somewhere else.

## States

- `pending` while the confirmation is being sent: the confirm button shows the busy spinner (`aria-busy`), the cancel button steps to its busy colors without one (`Button`'s `waiting`), both keep focus and ignore clicks, the dialog is `aria-busy`, and Escape does nothing. If the request fails, clear `pending` and say so with a `Notice` on the screen.

## What the consumer provides

- Rendering it opens it, and removing it closes it. `onCancel` and a finished `onConfirm` should remove it.
- `title`, a question that names the dialog (`aria-labelledby`), and `body`, which describes it (`aria-describedby`).

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required. The dialog's name. |
| `body` | `ReactNode` | Required. Its description. |
| `confirmLabel` | `string` | Required. The primary button. |
| `cancelLabel` | `string` | Required. The secondary button, focused first. |
| `tone` | `'default' \| 'danger'` | `danger` adds a refused dot beside the title. |
| `pending` | `boolean` | Confirm spins, cancel waits without a spinner; neither can be pressed, and Escape does nothing. |
| `onConfirm` | `() => void` | Required. |
| `onCancel` | `() => void` | Required. The cancel button, Escape, and a close by the browser. |
