# CopyField

`CopyField` is a value a developer copies, such as the agents page's address or its demo key, in mono type with a button that copies it through the screen.

## When to use

- The agents page's endpoint, with "Copy address", and the demo key shown once, with "Copy key" and its warning.
- The key id over the key, as the same box with no button.
- Not for the owner's public link, which is the web app's `CopyLink`, and not for long code, which is a `CodeBlock`.

## What the consumer provides

- `value`, exactly as it is copied. It is shown as written and marked as machine text (`data-copy="code"`, `translate="no"`), so neither the copy check nor a page translator changes it.
- `copyLabel` in the page's language ("Copy address", "Copiar dirección") and `onCopy`, which writes `value` to the clipboard. Leave both out for a value with no button.
- `onCopy` owns the clipboard and may return a promise. A throw or a rejected promise means it couldn't copy. The field never touches the clipboard or fetches anything.
- `label` for a value that needs one ("Key id", "Private key"). It names the field, a `group`.
- `note` in the page's language, beside the button: "Shown once. It’s a demo key for this Desk, not a business credential."
- `layout`: `inline` for the address, `block` for a key.
- `language`, the page's: the line after a copy, and `lang` on the field.

## What it shows

- `inline`: the value in the `code` type in an outlined box, as every signed board with an inline value draws it (N-R2-Agents-01-Page and -06-Phone, and the setup's live link on N-R2-Setup-14-Live and -15-Copy-Failed): a 1 px `line-field` outline at `radius-control`, no fill, a control's 32 px tall (growing if a long value wraps), the words 12 px in. A secondary `main` button sits 8 px after it, at the right of the line, centered on it. Below 480 px of field width the box takes the whole line and the button goes 8 px under it, at its own width. The outline reads 3.2 to 1 on a card.
- `block`: the label in `meta`, `text-secondary`; 6 px under it the value in a `fill-secondary` box at `radius-control`, padded 12 px by 14 px, 44 px tall for one line; 10 px under the box the button, with the note 12 px after it, in `meta`, `text-secondary`, on the button's middle.
- Long values wrap inside their line or box; nothing scrolls sideways.

## After a press

| Result | Shows |
| --- | --- |
| `onCopy` resolves | "Copied." / "Copiado." under the field |
| `onCopy` throws or rejects | The value's text is selected, ready to copy with the keyboard or the menu, and "Copy didn’t work. The text is selected, so copy it yourself." / "No se pudo copiar. El texto está seleccionado para que lo copies tú." |

- Only the latest copy shows its line. A newer press anywhere clears the older result, whether it succeeded or failed; there is no timed clear. Each press is announced again through `CopyResult` with the hook’s fresh `announcement` key.
- The line is a `status`, in the page from the start so it is read out when its words come, and it takes no room until then. The button keeps its words and isn't busy: a copy is immediate.
- The words are in `COPY_RESULT_COPY` (`useCopyText.ts`), with the `useCopyText` hook that runs a copy and selects the text when it fails, and `copyResultLine(state, { language, what })`, which picks the line. `CopyList` uses the same hook and line.
- A failed copy names what is selected. `what` is `'text'` by default, as here and in `CopyList`; a control that copies the Desk's public link (the web app's `CopyLink`, on Share and setup's live step) passes `what: 'link'`, for "Copy didn’t work. The link is selected, so copy it yourself." / "No se pudo copiar. El enlace está seleccionado para que lo copies tú.", as N-R2-Setup-15-Copy-Failed writes it. The agents page's address stays `'text'`, since its button calls it an address.
- The failure line says the link or the text "is selected", which is true only when the copy goes through `useCopyText` with a target (not `null`): on a failure the hook selects the target's text, an input's or a text area's value inside the field and any other element's text through the document's selection.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `value` | `string` | Required. Shown and copied as written. |
| `language` | `'en' \| 'es'` | Required. |
| `label` | `string` | Names the field. |
| `copyLabel` | `string` | The button's words. Without it, or without `onCopy`, no button. |
| `onCopy` | `(value: string) => Promise<void> \| void` | Copies; a throw or rejection means it couldn't. |
| `note` | `string` | Beside the button, in `block`. |
| `layout` | `'inline' \| 'block'` | `inline` by default. |
