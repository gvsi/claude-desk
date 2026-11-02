# ApprovalCard

`ApprovalCard` is a request the owner's rules held: what was asked, the rule that held it, and only the answers the kernel offers while it is held.

## When to use

- On Today under "Needs you", one card per held decision, and in a conversation after the receipt of the hold. Keep answered cards on screen, in the place they were answered, with their final line until the owner moves on.
- Held cards stay answerable in every conversation mode: a take-over or a breaker pause doesn't cancel a held action.
- Not for a live handoff ("Wants you live"): that is a `Card` with its own buttons.

## What the card shows

- An `article` named "Held for you: {reason_plain}", its first words from `OWNER_STATE_WORDS.held`, the same words a held receipt leads with.
- The status line: the dot from `receiptTone` and "Waiting for your answer" while held, with `waiting` at the right ("Web chat, 2 min ago").
- `reason_plain` in serif (`.cd-type-summary`), `context` in `.cd-type-meta`, then "Held by your rule: {heldBy}".
- A `role="group"` "Your answer" with two controls, Allow then Deny, built from the answers in `decision.answers` and only those. `allow_once` and `allow_person` are Allow's; `deny_once` and `deny_always` are Deny's. Allow is `secondary`, Deny `danger` (the soft red fill). Answers show only while `state` is `held`; with no answers there is no group, and a side with no answers has no control.
- A side with one answer is a plain main button with that answer's full words: "Allow this time" or "Deny this time" (and, though the kernel never offers them alone, "Allow only for {name}, always" or "Deny always").
- A side with two answers is a menu button: "Allow" or "Deny" and a chevron (`Button`'s `menuOpen`). Its menu offers the one-time answer, then the one that also saves a rule, each over a quieter line in `caption`:

  | Menu | Item | Line |
  | --- | --- | --- |
  | Allow | "This time" (`allow_once`) | "Only this request. Nothing is saved." |
  | Allow | "Only for {personName}, always" (`allow_person`), or "Only for this person, always" | "Saves a rule. You'll see it first." |
  | Deny | "This time" (`deny_once`) | "Only this request. Nothing is saved." |
  | Deny | "Always" (`deny_always`) | "Saves a rule. You'll see it first." |

  The lines stay generic: the design system never composes rule text, and the owner sees the rule itself before it applies. Deny's items are in `button-danger-text`, the red words of a refusal; Allow's in `text-primary`; every line in `text-secondary`.
- When each is offered (the kernel decides; the card shows what it gets): `allow_person` needs a verified person or an agent key, and for money an amount within the rules' money cap. `deny_always` comes only when the tool itself is held, by an ask card or a default ask; a request held by a limit (an amount, a discount, hours, or the reviewer gate) leaves it out. So a limit hold for an unverified visitor shows two plain buttons, and a verified person's request held by an ask card shows two menus.
- On a desktop, a menu is a popover 6 px under its button, as wide as `SwitcherMenu` (`size-sidebar` plus `space-16`), on `bg-surface` with a `line-card` border at `radius-card`, lifted by `shadow-dialog` above the card and anything after it. Items are at least `size-nav-row` tall and fill with `fill-hover` on hover and focus.
- Under about 480 px of the card's own width (a container query on the answers, so it follows the card, not the window), Allow and Deny share the line, each half of it and 44 px tall, and wrap only if their words can't fit side by side: then each takes a full-width line, and words longer than the line, such as a long name on "Allow only for {personName}, always", wrap inside the button, which grows taller. A menu opens inline as a full-width list under them, with no shadow and items 48 px tall, and pushes the card down.
- Wider than that, words that can't sit beside the other side's move it to the next line too, so Deny is never pushed past the card.
- The card is owner-facing and English only, like the rest of the owner app.
- No counter-offer: on the canvas it is static vision.

## Menus and keyboard

- A menu button says `aria-haspopup="menu"` and `aria-expanded`. Its menu is a `role="menu"` named by the button ("Allow", "Deny"); each item is a `menuitem` named by its words, with its line as its description (`aria-describedby`).
- A click, Enter, Space or Down opens a menu with focus on its first item; Up opens it on its last. In the menu, Down and Up move and wrap, Home and End jump to the first and last, and Enter, Space or a click chooses. A held key never chooses: Enter held on a menu button opens its menu, and the menu ignores repeated Enter and Space, and the Enter that opened it until that key comes up.
- Escape or Tab in the menu closes it and gives focus back to its button. With focus on the button of an open menu (after a press dragged off it, say), Escape closes the menu, and Down or Up moves focus back into it.
- A click outside, or focus leaving the button and its menu for anything else on the page, closes the menu and leaves focus where it went. A second click on the button closes it too. However a menu closes, focus that was in it goes back to its button, never to the page.
- One menu is open on the page at a time: opening one closes any other, Allow's when Deny's opens, or a menu on another card.
- A menu opens only on the owner's click or key. When an answer starts to be sent, or the answers it was opened on change (a side drops to one answer, or `decision.answers`, `decision_id` or `state` changes), it closes for good and never comes back by itself. Each side keeps one button, so focus stays on Allow when it turns from a menu button into "Allow this time" and back.
- An item with keyboard focus takes its hover fill and the base focus edge, 1 px of `line-focus` just inside it, which reads 5.8 on `fill-hover` over `bg-surface`. An open menu's button keeps its hover fill, so the menu reads as its own.
- Choosing an item calls `onAnswer` with that answer, closes the menu and leaves focus on its button while the answer is sent.

## Answering

- One click on a plain button, or one choice in a menu, calls `onAnswer` once, and both controls wait (`aria-disabled`, the chosen side's also `aria-busy`, and no menu opens) until `decision_id` or `state` changes, until the screen reports that the answer failed (`error` on and `pending` off, after either changed since the click), or until the promise `onAnswer` returned rejects. Return the request's promise: a screen that keeps the same `error` on between tries and never sets `pending` still gets the answers back after each failure.
- `pending` puts "Sending your answer" in the card's status region, read out and visually hidden (`cd-sr-only`): the busy answer carries the wait on screen, so the card's height changes once, when the answer lands, and nothing below it drops while the answer is out. The side whose answer was chosen here shows the busy spinner in place of its words (and its chevron), as a busy `Button`; the other steps to its busy colors without one (`Button`'s `waiting`), its words still shown. Neither is dimmed: Allow's label or spinner turn `text-secondary` on its fill, and the red Deny takes its hover fill under its red words or spinner, each a listed pair in the card. When the screen reports `pending` for an answer given elsewhere, no side was chosen here, so both wait without a spinner.
- `error` shows "We couldn't confirm your answer. Try again, or reload to see where it stands." (`true`), or the screen's own line (a string), as an alert, and the answers can be tried again. A retry is safe: the kernel resolves a request once, and on `conflict` the screen re-reads the decision.
- When the answers go while one of them has focus, focus moves to the status line. If an answer starts to be sent while a menu is open, from this card or from elsewhere, the menu closes and focus waits on its button.
- `inertAnswers` is for the vision pages only (the phone vision page's held quote), which make no requests: the answers keep their look, focus and tab order, a menu still opens, and choosing an answer does nothing. The card never locks or shows a spinner, and `onAnswer` is never called. Never on an owner screen. The first press shows `VISION_INERT_LINE`, "This is a vision page, so nothing is sent.", once, in a secondary caption 8 px under the answers' row, in a polite live region (`role="status"`) that is there from the start and takes no room until then; later presses change nothing and announce nothing. An inert card never sends an answer, so it never lands one (below).
- The chosen answer presses in a little further than a plain button: `scale(0.97)` while pressed, over `motion-fast`. A button waiting for its answer doesn't press.

## The answer lands

When an answer given on this card comes back with the request's final state, it lands in place instead of swapping in one frame (UXC-P202-After, signed 2026-10-30):

1. The held card fades out over `motion-fast` as the answered card fades in over `motion-base` on `motion-ease-emphasis`. They are two layers in the card's one box. The answered layer is the card itself, so its status line is the one `role="status"` node, and its words change in place. The outgoing layer is a picture of the held card as it left: the chosen answer busy and the other waiting. From its first frame it is `inert` and `aria-hidden="true"`, so nothing in it can be reached or read.
2. Once the held layer has gone, the dot pulses once (scale 1 to 1.8 and back over `motion-base`), and only if its tone left held. The tone always comes from the returned decision through `receiptTone`: Allow that ran ends handled, Deny ends refused, a late answer ends in its state's tone (expired is `info`), and an outcome not yet known (`unknown`) keeps its held dot and doesn't pulse.
3. Over the same `motion-base`, after the crossfade, the card eases from its held height to its answered height, so what follows it glides instead of jumping. The card measures both heights and sets them on its body and on its region (the card and `after`), and the stylesheet's transition carries them. It never animates `height: auto`. Both are cleared on `transitionend` or `transitioncancel`, with a timeout past the transition in case neither comes.
4. Whatever `after` brings with the answer (on Today, the rule an "always" answer drafted, then Dismiss) fades in with the answered layer, inside the easing height, rising into place as the card shrinks.

The card lands only an answer given on it, in this view. A card that mounts with a final state, whose state changes with no answer of its own out, or with `inertAnswers`, draws its final state at once. Under `prefers-reduced-motion: reduce` there is no outgoing layer and no held height: the answered card draws at once, in the same commit. Focus works as above: the answers go from the answered layer in the commit that lands the answer, so the status line takes the focus they had before the browser paints, and focus is never left on the inert layer.

## Final lines

After an answer or an event, the final line takes the place of "Waiting for your answer", with its `receiptTone` dot (`satisfies Record<DecisionState, string>`, so a state left out is a compile error). A state this build doesn't know offers no answers and asks for a reload.

| `decision.state` | Status line | Dot |
| --- | --- | --- |
| `held` | "Waiting for your answer", with the answers | held |
| `approved` | "You allowed this." | handled |
| `executed` | "You allowed this. It's done." | handled |
| `failed` | "You allowed this, but it didn't go through. Nothing was done." | refused |
| `unknown` | "You allowed this. Still confirming whether it went through." | held |
| `refused_at_execution` | The kernel's `decision.owner_plain`, verbatim. When null or absent: "Your rules changed before this ran, so it wasn't done." | refused |
| `denied` | "You denied this." | refused |
| `expired` | "This request expired before you answered. Nothing was done." | info |
| `cancelled` | "The visitor cancelled before you answered. Nothing was done." When the visitor's booking closed it, the kernel's `decision.owner_plain`, verbatim ("The visitor booked before you answered, so this request closed."). | info |
| `allowed` | "Your rules allowed this." | handled |
| `refused` | "Your rules refused this." | refused |

## What the consumer provides

- `decision` as the kernel returned it. The card never decides which answers apply: `state` and `answers` do.
- `heldBy`: `NeedsYouItem.held_by`, the reason on the rule card that held it, shown as the owner's words.
- `context`: "From the visitor: “{from_the_visitor}”", with the visitor's words in a `data-copy="user"` span. The visitor's own words only, never AI-written text such as a triage summary: a visitor could steer one to sway the answer, so it is never in an approval card.
- `waiting`: where and when it was held, formatted by the screen.
- `personName`: `NeedsYouItem.session.display_name` when the session is verified, so Allow's rule answer names the person. Leave it out for an agent or an unverified visitor. It is shown as user text (`.cd-user-name`, `data-copy="user"`).
- `onAnswer`, returning the request's promise, then `pending` while it is sent and `error` if it fails. On success, pass the decision the kernel returned, to the same card: keep one card from held to answered, so the answer can land.
- `after`: what sits under the card, outside it, such as the drafted rule and Dismiss once answered. The card lays it out `space-8` under itself and in a column `space-8` apart.
- `cardRef`: given, the card's own box (without `after`) takes focus (`tabIndex={-1}`), its card's own border turning `line-focus` with keyboard focus, so a screen can bring the request into view and focus.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `decision` | `Decision` | Required. |
| `heldBy` | `string` | The rule that held it. |
| `context` | `ReactNode` | One line of context. |
| `waiting` | `string` | Required. |
| `personName` | `string` | The verified person's name on record; "this person" without it. |
| `onAnswer` | `(answer: ApprovalAnswer) => void \| Promise<unknown>` | Required. A rejected promise lets the owner answer again. |
| `pending` | `boolean` | "Sending your answer", read out from the status region, unseen. |
| `error` | `boolean \| string` | `true` for the card's line, or the screen's line. |
| `inertAnswers` | `boolean` | Vision pages only: the answers do nothing. `false` by default. |
| `after` | `ReactNode` | Under the card; fades in and settles with an answer that brings it. |
| `cardRef` | `(el: HTMLDivElement \| null) => void` | The card's own box, which then takes focus. |

The answers are `size-control-main` buttons, `space-8` apart. The canvas board is N-Answers-TwoButtons, option 2 ("Menu buttons"), signed off by the project owner on 2026-10-29; it replaces N-Answers-Final and N-Answers-Verified.
