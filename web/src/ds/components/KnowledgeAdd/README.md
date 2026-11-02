# KnowledgeAdd

`KnowledgeAdd` is "Add something" on Knowledge: a note to type or a file to pick, and once the kernel has stored it, an "Added" card whose switch lets customers see it.

## When to use

- On Knowledge, under "What Claude knows" (`KnowledgeList`), as N-Run2-Settings-Knowledge draws it.
- Not for changing an item added before: the list's rows are read only, and only the item just added carries the switch.

## What the consumer provides

- `note` exactly as typed, and `onNoteChange`, called with the raw text on every change. Enter adds a line.
- `onAddNote()`: "Add a note". The screen checks the note it holds and adds it for the owner only (`addKnowledge`, readers `["owner"]`).
- `onAddFile(file)`: a file picked with "Add a file", the `File` as the browser gives it, unread. The screen checks it (`.txt` or `.md`, up to 100 KB), reads it as text and adds it for the owner only, or passes `error`.
- `busy` while something is in flight: `'note'` or `'file'` for an add, `'switch'` for the switch's change.
- `error`: what went wrong, in plain words, never a code ("That file is too big. Add files up to 100 KB."). With none, no line is drawn.
- `added`, once the kernel has answered with the stored item:
  - `readers`: the returned item's `label.readers`, never the ones asked for. The switch is on only when they include "public", so an item the kernel keeps to the owner stays off.
  - `onPublicChange(makePublic)`: the switch was turned. The screen re-posts the item with readers `["public"]` or `["owner"]`, passes `busy: 'switch'` while it waits, and passes back the readers the answer returns.
  - `note`, optional: a line under the switch, in the screen's own words, such as why the kernel kept the item to the owner ("This note stays private: it includes a customer’s document.") or why a change didn't go through. The design system writes none of it.

## What it shows

- The section's heading, "Add something" (`SectionHeader`, an `h2` that names the section), then 12 px apart:
  - A `TextField` with `multiline`, labelled "A note", with the hint "Up to a few paragraphs. Only you can see it until you make it public."
  - "Add a note", the view's one primary button, and "Add a file", secondary, both at a screen's main size, 8 px apart.
  - "Text or Markdown files, up to 100 KB." in `caption` type, `text-secondary`, which describes "Add a file".
  - With `error`, the screen's words as an error `Notice`.
- With `added`, 20 px under the form, a `Card` named "Added": an info `Notice`, "Added. Only you can see it until you make it public.", and 12 px under it a `Switch`, "Customers can see this", described by "Claude can quote it to visitors when it answers."
- Once the returned readers include "public", the switch is on and the line says only "Added.", since only the owner seeing it is no longer true. The board draws only the off state, so this state is not drawn on the board.
- With `added.note`, the screen's line 8 px under the switch, in `meta` type, `text-secondary`, lined up with the switch's words. Not drawn on the board.

## Behavior

- "Add a file" opens the browser's file picker for text and Markdown files (`accept=".txt,.md,text/plain,text/markdown"`). The file picked goes to `onAddFile`, and the picker is emptied, so picking the same file again is a new pick.
- With `busy` set to an add, that add spins and the other waits (`aria-busy`, `aria-disabled`, focus kept), and neither calls back or opens the picker. The switch is also disabled (`aria-disabled`, presses ignored), without being announced as busy.
- With `busy: 'switch'`, the switch waits (`Switch`'s `waiting`: `aria-busy`, `aria-disabled`, presses ignored) and both adds wait too, so nothing else is sent until the change lands.
- The switch and the line above it show `added.readers` and nothing else: turning the switch calls `onPublicChange` and leaves both as they were until the screen passes back new readers.
- Nothing here reads, checks, sizes or sends a file or a note.

## Accessibility

- The note's field is named by its label and described by its hint. "Add a file" is described by the line about files, so a screen reader hears what it accepts.
- The file input is hidden and out of the tab order: "Add a file" is the control.
- An error is an `alert`, read out at once; the "Added" line is a `status`; the screen's note under the switch sits in a polite live region, there from the start, so it is read out when it comes.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `note` | `string` | Required. As typed. |
| `onNoteChange` | `(note: string) => void` | Required. The raw text. |
| `onAddNote` | `() => void` | Required. "Add a note". |
| `onAddFile` | `(file: File) => void` | Required. The file picked, unread. |
| `busy` | `'note' \| 'file' \| 'switch'` | What is in flight: an add, or the switch's change. |
| `error` | `string` | What went wrong, in plain words. |
| `added` | `KnowledgeAddedView` | The item just added: the "Added" card and its switch. |

`KnowledgeAddedView`:

| Field | Type | Notes |
| --- | --- | --- |
| `readers` | `readonly string[]` | Required. The returned `label.readers`; "public" turns the switch on. |
| `onPublicChange` | `(makePublic: boolean) => void` | Required. The switch was turned. |
| `note` | `ReactNode` | The screen's line under the switch, in its own words. |

Under the file caption, “A website” holds a local value with the example “turner-plumbing.example/blog”. “Add a website” is a secondary button beside a Mock pill. It is inert and sends no request. The caption explains: “Claude doesn’t read websites you add in this prototype yet.”
