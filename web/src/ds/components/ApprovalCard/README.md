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
- A `role="group"` "Your answer" with one main secondary button per answer in `decision.answers`, in this order and only those: "Allow this time" (`allow_once`), "Deny this time" (`deny_once`), "Allow only for this person" (`allow_person`), "Deny always" (`deny_always`). Answers show only while `state` is `held`; with no answers there is no group.
- Under them, a line naming the offered answers that also save a rule: "Allow only for this person and Deny always also save a rule. You'll see it before it applies." or "Deny always also saves a rule. You'll see it before it applies."
- No counter-offer: on the canvas it is static vision.

## Answering

- One click calls `onAnswer` once and every answer waits (`aria-disabled`, `aria-busy`) until `decision_id` or `state` changes, or until the screen reports that the answer failed: `error` on and `pending` off, after either changed since the click.
- `pending` shows "Sending your answer" in a status line under the answers.
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
- `onAnswer`, then `pending` while it is sent and `error` if it fails. On success, pass the decision the kernel returned.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `decision` | `Decision` | Required. |
| `heldBy` | `string` | The rule that held it. |
| `context` | `ReactNode` | One line of context. |
| `waiting` | `string` | Required. |
| `onAnswer` | `(answer: ApprovalAnswer) => void` | Required. |
| `pending` | `boolean` | "Sending your answer". |
| `error` | `boolean \| string` | `true` for the card's line, or the screen's line. |

The answers are `size-control-main` secondary buttons in a grid of 208 px columns, two to a row on the board's card and one on a phone, so the longest answer never clips.
