# MarginReceipt

`MarginReceipt` is a checkpoint result attached under the message it explains: a 6 px status dot and one line in a secondary caption, like an editor's note.

## When to use

- In a `TranscriptRow`'s `margin`, attached under its message at every width, for every signed status event (`EvReceipt`, `EvHeld`, `EvResolved`) and for each delivered message's reply check (`EvMessage.visitor_plain`).
- On visitor surfaces it is plain text with no trace hint. On owner screens, give it `onOpenTrace` and it becomes a button that opens the `FullTrace` for its ledger entry.
- Keep receipts inside the `Transcript`'s log, so a screen reader announces each one as it arrives.
- Not for owner notes that aren't checkpoint results (a lead saved, a whisper applied): use `MarginNote`.

## What the consumer provides

- `source`, `plain` and `ledgerSeq`, from `receiptFromEvent(event)`. Never write a status mapping or status copy on a screen.
- `plain` is shown exactly as given. Visitor surfaces pass the event's `visitor_plain` unchanged and show no clock time; owner screens may pass the decision's `reason_plain` instead.
- `drawCheck` for an executed booking or a paid link. The sage check draws once, and only when the receipt is handled.

## The dot (`receiptTone`)

`receiptTone(source)` picks the dot, `satisfies Record<DecisionState, StatusTone>`, so a state left out is a compile error. A state this build doesn't know reads as held, never as handled.

| Source | Dot |
| --- | --- |
| A reply that passed its check (`handoff: false`) | handled |
| A reply whose draft was blocked and handed to the owner (`handoff: true`) | held |
| `allowed`, `approved`, `executed` | handled |
| `held`, `unknown` | held |
| `refused`, `denied`, `failed`, `refused_at_execution` | refused |
| `expired`, `cancelled` | info (hollow) |

## Extra exports

| Export | What it is |
| --- | --- |
| `receiptFromEvent(ev)` | `EvMessage` or a status event to `{ source, plain, ledgerSeq }` (`ReceiptView`): a message is a `reply` with its `handoff`, a status event a `decision` with its `state`, and `plain` is the event's `visitor_plain`. |
| `receiptTone(source)` | The `StatusTone` for a `ReceiptSource`, as above. |
| `ReceiptSource`, `ReceiptView` | The types of the two above. |

`MarginLine.tsx` is the line itself, shared with `MarginNote`; it isn't exported.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `source` | `ReceiptSource` | Required. `{ kind: 'reply'; handoff }` or `{ kind: 'decision'; state }`. |
| `plain` | `string` | Required. The line, unchanged. |
| `ledgerSeq` | `number` | Required. The entry the event was signed with. |
| `onOpenTrace` | `(ledgerSeq: number) => void` | Owner screens only. Makes the receipt a button named "{plain} Open the full trace."; Enter or a click calls it once with `ledgerSeq`. |
| `drawCheck` | `boolean` | Adds the check that draws once, only when the tone is handled. Static under reduced motion. |

The dot is `aria-hidden`: the line beside it says the same thing. Every tone reaches 3:1 on the app, panels, raised surfaces and cards (`CONTRAST_PAIRS`).
