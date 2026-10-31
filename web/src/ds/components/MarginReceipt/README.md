# MarginReceipt

`MarginReceipt` is a checkpoint result attached under the message it explains: a 6 px status dot and one line in a secondary caption, like an editor's note.

## When to use

- In a `TranscriptRow`'s `margin`, attached under its message at every width, for every signed status event (`EvReceipt`, `EvHeld`, `EvResolved`) and for each delivered message's reply check (`EvMessage.visitor_plain`).
- On visitor surfaces it is plain text with no trace hint. On owner screens, give it `onOpenTrace` and it becomes a button that opens the `FullTrace` for its ledger entry.
- Keep receipts inside the `Transcript`'s log, so a screen reader announces each one as it arrives.
- Not for owner notes that aren't checkpoint results (a lead saved, a whisper applied): use `MarginNote`.

## What the consumer provides

- `source`, `plain` and `ledgerSeq`, from `receiptFromEvent(event)`. Never write a status mapping or status copy on a screen.
- `plain` is always the event's `visitor_plain`, unchanged, with no clock time.
- On owner screens only, for the receipt that reports what the kernel decided (a decision's first receipt when its state is in `OWNER_REASON_STATES`: `held`, `refused`, `executed` or `allowed`):
  - `reason`: the decision's `reason_plain`. It is written once, at decide time, so it explains only that receipt.
  - `cardBelow`: the request's `ApprovalCard` is drawn right under this receipt's row.
- `drawCheck` for an executed booking or a paid link. The sage check draws once, and only when the receipt is handled.
- Nothing for a reply that arrives live: under a `TranscriptRow` with `live`, the receipt lands on its own `motion-stagger` beat, its dot growing from half size with it and its check drawing as it lands. Its words, order and dot color don't change. One attached after the row has landed, and any under reduced motion, shows at once.

## The line

A `reply` receipt always shows `plain`, whatever `reason` and `cardBelow` say. So does a `decision` receipt whose state isn't in `OWNER_REASON_STATES`, even with a `reason`: the reason was written at decide time, and on a later state it could say something false ("Automatic" for a hold the owner later allowed). A decision receipt in one of those four states shows the first of these that applies:

1. `cardBelow` and state `held`: the owner's words alone, "Held for you", with no period, like the kernel's lines. The card's headline already gives the reason. `cardBelow` on any other state is ignored.
2. A `reason` that isn't empty after trimming: "{words}. {reason}", e.g. "Stopped. Someone asked for another customer's invoice."
3. Otherwise `plain`, unchanged.

The words are `OWNER_STATE_WORDS[state]`: the owner's words for the receipt that reports what the kernel decided, not general outcome words. They sit in their own span (`cd-margin-line__lead`) in `text-primary`, with the period after them when the reason follows; the rest of the line stays `text-secondary`, in the same caption size and weight. Hover brightens the whole line.

| State | Words |
| --- | --- |
| `held` | Held for you |
| `refused` | Stopped |
| `executed` | Automatic |
| `allowed` | Running |

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
| `OWNER_REASON_STATES`, `OwnerReasonState` | `['held', 'refused', 'executed', 'allowed'] as const` and its type: the states of the receipt that reports what the kernel decided, the only ones `reason` applies to. Owner screens use it to pick the receipt that gets the reason. |
| `OWNER_STATE_WORDS` | The owner's words for those states, which lead that receipt's line (the table above). It `satisfies Record<OwnerReasonState, string>`, so a state left out, or one added, is a compile error. |
| `ReceiptSource`, `ReceiptView` | The types of `receiptTone`'s argument and `receiptFromEvent`'s result. |

`MarginLine.tsx` is the line itself, shared with `MarginNote`; it isn't exported. Neither is `receiptLine` in `receiptTone.ts`, which applies the rules under "The line" for `MarginReceipt`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `source` | `ReceiptSource` | Required. `{ kind: 'reply'; handoff }` or `{ kind: 'decision'; state }`. |
| `plain` | `string` | Required. The event's `visitor_plain`, unchanged. |
| `ledgerSeq` | `number` | Required. The entry the event was signed with. |
| `reason` | `string` | Owner screens only. The decision's `reason_plain`, for the receipt that reports what the kernel decided: a `decision` receipt in `OWNER_REASON_STATES` reads "{words}. {reason}" (see "The line"). Ignored on a `reply` and on any other state; an empty one keeps `plain`. |
| `cardBelow` | `boolean` | Owner screens only. The request's `ApprovalCard` is right under this row: a `held` decision reads "Held for you" alone. Ignored on a `reply` and on any other state. |
| `onOpenTrace` | `(ledgerSeq: number) => void` | Owner screens only. Makes the receipt a button named "{line} Open the full trace.", e.g. "Stopped. Someone asked for another customer's invoice. Open the full trace."; Enter or a click calls it once with `ledgerSeq`. |
| `drawCheck` | `boolean` | Adds the check that draws once, only when the tone is handled. Static under reduced motion. |

The dot is `aria-hidden`: the line names the state, in the kernel's words or, on an owner's decision receipt, the owner's words that lead it. Every tone reaches 3:1 on the app, panels, raised surfaces and cards (`CONTRAST_PAIRS`).
