# AdvancedDetails

`AdvancedDetails` is a tool's or a rule's details, as REV-RULES-D draws them: a quiet "Details" button in the row, collapsed by default, that opens a panel under the row with a label and value list and, when there is data, a block of pretty JSON with a Copy button.

## When to use

- On every tool and every rule on Your tools, and on every rule on Rules, as the signed board's shipping state (canvas v339) draws them: after a tool's title, after a rule's status dot.
- Only for what the owner API already returns. It never shows a tool's input schema, the compiled Cedar or a "coming later" block: the screen leaves a field or the block out when it has nothing to put in it.
- Not for one value a developer copies, which is a `CopyField`, or for a ledger entry, which is the `FullTrace`.

## What the consumer provides

- `children(toggle)`: draws the row, with the Details button where the row puts it. The panel follows whatever it returns, so it opens under the row.
- `fields`: the list, in order, each `{ label, value, mono? }`. A value is the screen's words, a status label or a connector's name; `mono` sets machine text (an ID, a hash) in the trace type, marked `data-copy="code"` and `translate="no"`.
- `code`: `{ label, value }`, the block's label ("As your Desk lists it", "The rule as you set it") and its data. Leave it out when there is none.
- `onCopy`: writes the block's text to the clipboard. The component never touches the clipboard; a throw or a rejection means it couldn't.
- `describedBy`: the id of the words the row is about (a tool's title, a rule's sentence), so each "Details" reads as its own.

## What it shows

- **The button:** "Details" and a 14 px `chevron-right`, in `.cd-type-control` and the secondary ink, 2 px by 6 px at the control radius, so a line is 24 px tall (WCAG 2.2's least target). It has no fill until hovered. It carries `aria-expanded` and `aria-controls`. Open, it keeps the hover fill and the chevron turns down, at `motion-fast`.
- **The panel:** under the row, on `bg-surface` inside a `line-card` border at the control radius, padded 12 px by 16 px, 8 px under the row. It stays out of the page until it's opened: its container is `hidden` and empty.
- **The list:** one line per field, 4 px above and below. The label sits in a 104 px column in `.cd-type-meta`, secondary; the value is in `.cd-type-meta`, primary, wrapping anywhere.
- **The block:**
  - The label in `.cd-type-meta`, secondary, with a ghost inline "Copy" `Button` at the right, described by the label.
  - The JSON (`jsonText`) in a `<pre class="cd-type-trace">` on `fill-secondary` at the control radius, padded 12 px, with `white-space: pre`, `font-variant-ligatures: none` and its own horizontal scroll. It is focusable, so a keyboard can scroll a long line into view; the page never scrolls sideways.
  - The tint: keys in `accent-blue`, strings in `text-primary`, numbers, booleans and null in `text-secondary`, and punctuation in `text-tertiary`. No status color, since nothing in the block is a verdict. Every pair reads 4.5:1 on `fill-secondary` over `bg-surface` (`contrast.ts`).
- **After a press:** CopyField's line: "Copied.", or "Copy didn’t work. The text is selected, so copy it yourself." with the block's text selected (`useCopyText`, `copyResultLine`). It sits beside the Copy button, as a `status`, and only the latest copy on the page shows it.

## A row without Details

- `DetailsSlot` is the place Details takes, left empty, for a row that has none, such as an always-on rule or "Anything not listed here". Every status dot then sits in one column just left of Details, as REV-RULES-D v351 draws it.
- It is drawn as the button is, with the same words and chevron, so it is the same width, but it is `visibility: hidden` and `aria-hidden`: never seen, read or focused.

## The JSON

- `jsonText(value)` gives a 2-space indent and one field per line. A list of plain values stays on one line (`["charge"]`); a list holding objects or lists puts one entry per line.
- It reads back as the same value (`JSON.parse`), and a field left undefined is left out, as `JSON.stringify` leaves it out.
- `jsonTokens(value)` gives the same text as runs to tint.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `(toggle: ReactElement) => ReactNode` | Required. Draws the row with the button in it. |
| `fields` | `readonly DetailsField[]` | Required. `{ label: string; value: ReactNode; mono?: boolean }`. |
| `code` | `DetailsCode` | `{ label: string; value: unknown }`. Left out, no block is drawn. |
| `onCopy` | `(text: string) => Promise<void> \| void` | Required. Copies the block's text. |
| `describedBy` | `string` | The id of the row's words. |

`DetailsSlot` takes no props.
