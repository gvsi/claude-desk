# ApprovalCard

`ApprovalCard` is a request the owner's rules held: what was asked, the rule that held it, and only the answers the kernel offers while it is held.

## When to use

- On Today under "Needs you", one card per held decision, and in a conversation after the receipt of the hold. Keep answered cards on screen with their final line until the owner moves on.
- Held cards stay answerable in every conversation mode: a take-over or a breaker pause doesn't cancel a held action.
- Not for a live handoff ("Wants you live"): that is a `Card` with its own buttons.

## What the card shows

- An `article` named "Held for you: {reason_plain}".
- The status line: the dot from `receiptTone` and "Waiting for your answer" while held, with `waiting` at the right ("Web chat, 2 min ago").
- `reason_plain` in serif (`.cd-type-summary`), `context` in `.cd-type-meta`, then "Held by your rule: {heldBy}".
- A `role="group"` "Your answer" with one main button per answer in `decision.answers`, in this order and only those: "Allow this time" (`allow_once`, `secondary`), "Deny this time" (`deny_once`, `danger`, the soft red fill), "Allow only for this person" (`allow_person`, `ghost`), "Deny always" (`deny_always`, `danger-ghost`, red words). Answers show only while `state` is `held`; with no answers there is no group.
- The answers that save a rule (`allow_person`, `deny_always`) come after the one-time answers. With one of them, the answers share one row, the rule answer after a thin `line-hairline` divider. With both, the one-time answers take the first row, and the rule answers a second row after the label "Or save a rule:" in `caption`, a group named by that label.
- A row never wraps. Under about 480 px of the card's own width (a container query on the answers, so it follows the card, not the window), the answers become one column of full-width buttons in the same order, with no divider and no label.
- Under them, a line for the offered answers that also save a rule:
  - "Deny always also saves a rule, so Claude declines requests like this on its own. You'll see the rule before it applies."
  - "Allow only for this person and Deny always also save a rule, so Claude handles requests like this on its own. You'll see the rule before it applies."
  - "Allow only for this person also saves a rule, so Claude allows requests like this from this person on its own. You'll see the rule before it applies." No board shows this answer without Deny always; the line is the card's own, in the same pattern.
- The card is owner-facing and English only, like the rest of the owner app.
- No counter-offer: on the canvas it is static vision.

## Answering

- One click calls `onAnswer` once and every answer waits (`aria-disabled`, `aria-busy`) until `decision_id` or `state` changes, until the screen reports that the answer failed (`error` on and `pending` off, after either changed since the click), or until the promise `onAnswer` returned rejects. Return the request's promise: a screen that keeps the same `error` on between tries and never sets `pending` still gets the answers back after each failure.
- `pending` shows "Sending your answer" in a status line under the answers. Every answer keeps its look and fades a little: the neutral ones to 60%, the red ones to 80%, so each label still reads at 4.5:1 in the card.
- `error` shows "We couldn't confirm your answer. Try again, or reload to see where it stands." (`true`), or the screen's own line (a string), as an alert, and the answers can be tried again. A retry is safe: the kernel resolves a request once, and on `conflict` the screen re-reads the decision.
- When the answers go while one of them has focus, focus moves to the status line.

## Final lines

After an answer or an event, the final line takes the place of "Waiting for your answer", with its `receiptTone` dot (`satisfies Record<DecisionState, string>`, so a state left out is a compile error). A state this build doesn't know offers no answers and asks for a reload.

| `decision.state` | Status line | Dot |
| --- | --- | --- |
| `held` | "Waiting for your answer", with the answers | held |
| `approved` | "You allowed this." | handled |
| `executed` | "You allowed this. It's done." | handled |
| `failed` | "You allowed this, but it didn't go through. Nothing was done." | refused |
| `unknown` | "You allowed this. Still confirming whether it went through." | held |
| `refused_at_execution` | "Your rules changed before this ran, so it wasn't done." | refused |
| `denied` | "You denied this." | refused |
| `expired` | "This request expired before you answered. Nothing was done." | info |
| `cancelled` | "The visitor cancelled before you answered. Nothing was done." | info |
| `allowed` | "Your rules allowed this." | handled |
| `refused` | "Your rules refused this." | refused |

## What the consumer provides

- `decision` as the kernel returned it. The card never decides which answers apply: `state` and `answers` do.
- `heldBy`: `NeedsYouItem.held_by`, the reason on the rule card that held it, shown as the owner's words.
- `context`: "From the visitor: “{from_the_visitor}”", with the visitor's words in a `data-copy="user"` span.
- `waiting`: where and when it was held, formatted by the screen.
- `onAnswer`, returning the request's promise, then `pending` while it is sent and `error` if it fails. On success, pass the decision the kernel returned.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `decision` | `Decision` | Required. |
| `heldBy` | `string` | The rule that held it. |
| `context` | `ReactNode` | One line of context. |
| `waiting` | `string` | Required. |
| `onAnswer` | `(answer: ApprovalAnswer) => void \| Promise<unknown>` | Required. A rejected promise lets the owner answer again. |
| `pending` | `boolean` | "Sending your answer". |
| `error` | `boolean \| string` | `true` for the card's line, or the screen's line. |

The answers are `size-control-main` buttons, `space-8` apart, with `space-10` between the two rows. The canvas boards are N-Answers-Final (three answers, and the phone column) and N-Answers-Verified (four answers, its layout B).
