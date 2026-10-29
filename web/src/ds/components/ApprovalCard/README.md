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
- Under about 480 px of the card's own width (a container query on the answers, so it follows the card, not the window), Allow and Deny share the line, each half of it and 44 px tall, and wrap only if their words can't fit side by side. A menu opens inline as a full-width list under them, with no shadow and items 48 px tall, and pushes the card down.
- The card is owner-facing and English only, like the rest of the owner app.
- No counter-offer: on the canvas it is static vision.

## Menus and keyboard

- A menu button says `aria-haspopup="menu"` and `aria-expanded`. Its menu is a `role="menu"` named by the button ("Allow", "Deny"); each item is a `menuitem` named by its words, with its line as its description (`aria-describedby`).
- A click, Enter, Space or Down opens a menu with focus on its first item; Up opens it on its last. In the menu, Down and Up move and wrap, Home and End jump to the first and last, and Enter, Space or a click chooses. A held key never chooses: Enter held on a menu button opens its menu, and the menu ignores repeated Enter and Space, and the Enter that opened it until that key comes up.
- Escape or Tab in the menu closes it and gives focus back to its button. With focus on the button of an open menu (after a press dragged off it, say), Escape closes the menu, and Down or Up moves focus back into it.
- A click outside, or focus leaving the button and its menu for anything else on the page, closes the menu and leaves focus where it went. A second click on the button closes it too. However a menu closes, focus that was in it goes back to its button, never to the page.
- One menu is open on the page at a time: opening one closes any other, Allow's when Deny's opens, or a menu on another card.
- A menu opens only on the owner's click or key. When an answer starts to be sent, or the answers it was opened on change (a side drops to one answer, or `decision.answers`, `decision_id` or `state` changes), it closes for good and never comes back by itself. Each side keeps one button, so focus stays on Allow when it turns from a menu button into "Allow this time" and back.
- An item draws the focus ring just inside its edge (a 2 px `accent-blue` outline at -2 px), not 2 px outside as elsewhere, so the ring clears the menu's 4 px padding and the next item; `accent-blue` reads 5.2 on `fill-hover` over `bg-surface`. An open menu's button keeps its hover fill, so the menu reads as its own.
- Choosing an item calls `onAnswer` with that answer, closes the menu and leaves focus on its button while the answer is sent.

## Answering

- One click on a plain button, or one choice in a menu, calls `onAnswer` once, and both controls wait (`aria-disabled`, `aria-busy`, and no menu opens) until `decision_id` or `state` changes, until the screen reports that the answer failed (`error` on and `pending` off, after either changed since the click), or until the promise `onAnswer` returned rejects. Return the request's promise: a screen that keeps the same `error` on between tries and never sets `pending` still gets the answers back after each failure.
- `pending` shows "Sending your answer" in a status line under the answers. Both controls keep their look and fade a little: Allow to 60%, the red Deny to 80%, so each label still reads at 4.5:1 in the card.
- `error` shows "We couldn't confirm your answer. Try again, or reload to see where it stands." (`true`), or the screen's own line (a string), as an alert, and the answers can be tried again. A retry is safe: the kernel resolves a request once, and on `conflict` the screen re-reads the decision.
- When the answers go while one of them has focus, focus moves to the status line. If an answer starts to be sent while a menu is open, from this card or from elsewhere, the menu closes and focus waits on its button.

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
- `personName`: `NeedsYouItem.session.display_name` when the session is verified, so Allow's rule answer names the person. Leave it out for an agent or an unverified visitor. It is shown as user text (`.cd-user-name`, `data-copy="user"`).
- `onAnswer`, returning the request's promise, then `pending` while it is sent and `error` if it fails. On success, pass the decision the kernel returned.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `decision` | `Decision` | Required. |
| `heldBy` | `string` | The rule that held it. |
| `context` | `ReactNode` | One line of context. |
| `waiting` | `string` | Required. |
| `personName` | `string` | The verified person's name on record; "this person" without it. |
| `onAnswer` | `(answer: ApprovalAnswer) => void \| Promise<unknown>` | Required. A rejected promise lets the owner answer again. |
| `pending` | `boolean` | "Sending your answer". |
| `error` | `boolean \| string` | `true` for the card's line, or the screen's line. |

The answers are `size-control-main` buttons, `space-8` apart. The canvas board is N-Answers-TwoButtons, option 2 ("Menu buttons"), signed off by the project owner on 2026-10-29; it replaces N-Answers-Final and N-Answers-Verified.
