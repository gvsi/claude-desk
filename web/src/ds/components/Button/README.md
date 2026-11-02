# Button

`Button` starts an action, in one of three weights and two heights, with two red variants for answers that refuse, and says exactly what happens.

## When to use

- `primary` for the one action a view is about ("Send counter-offer", "Join the chat"): an inverted neutral, at most one per view.
- `secondary` for the other actions beside it, such as "Allow this time" on an approval card.
- `ghost` for quiet actions that shouldn't compete ("Start over").
- `danger` for an answer that refuses, once: "Deny this time", a soft `button-danger-fill` behind `button-danger-text`.
- `danger-ghost` for a quieter refusal beside it: `button-danger-text` with no fill.
- The red variants are only for refusing. They are never a status, a warning or decoration, and their words still say exactly what happens.
- `size="main"` for a screen's main actions (`size-control-main`, 40 px); `inline` (`size-control`, 32 px) everywhere else.
- With `href`, the same look as a link: the button a payment or document card ends with ("Open payment page").
- With `href` and `external`, a link that opens in a new tab, as `TextLink`'s `external` does: `target="_blank"` with `rel="noopener noreferrer"`, and no change to its look. Today's "Open your public page" and "Chat as a customer" use it, so Today stays open.
- With `menuOpen`, a menu button: its words, then a 16 px `chevron-down` icon, with `aria-haspopup="menu"` and `aria-expanded`. A held request's card uses it for a side of the answer that has two answers ("Allow", "Deny"). The screen draws the menu, opens it on a click, Enter, Space or Down, and moves focus into it.

## What the consumer provides

- The label, in words that say what happens. Never "OK" or "Continue" when a verb can say more, and never an arrow.
- `busy` while the click's request is in flight. A small spinner takes the label's place, at the same width: the label, and a menu button's chevron, keep their places unseen, so nothing around the button moves. The button steps down to its busy colors (the table below), and the spinner takes its label's busy color: a `size-spinner` (16 px) ring at 30% with a quarter arc on it, both 2 px wide, turning once every `motion-spin` (0.8 s) at an even speed, and a still arc under reduced motion. The button keeps focus, is still named by its label, announces `aria-busy` and `aria-disabled`, and ignores further clicks. If the wait needs words, a status line says them, as a held request's "Sending your answer" does: read out from the card's status region and visually hidden, since the spinner carries the wait on screen. Dots mean someone is typing (`WritingIndicator`), never a busy button.
- Every busy color is a listed contrast pair (`contrast.ts`) on the grounds its pairs are listed for: a page (`bg-app`), a card on it (`fill-card` over `bg-app`) and a dialog (`bg-surface`), the sidebar (`bg-panel`) and the reviewer bar (`bg-muted`) too for a ghost button, and a page or a card for the red answers. There the busy label color reads 4.5:1 or more on the busy fill, so the spinner's arc, a graphic that needs 3:1, reads 5.3:1 or more; the faint ring behind it is decoration.
- A ground for it among those. No Button sits on `bg-selected`, the selected row's ground: a busy secondary label would read 4.45 there and a busy danger one 3.98, so the guard `no_button_on_the_selected_ground` keeps Buttons off it until its pairs are listed, with colors that clear 4.5.
- `waiting` on the buttons beside a busy one whose request they wait for, such as the other answer on a held request: they step to the same busy colors without the spinner and ignore clicks.
- `disabled` only when the action can't be taken at all. A disabled button is dimmed and leaves the tab order.
- For a menu button, `menuOpen` (`true` while its menu shows), an `id` the menu can be labelled by, and `onKeyDown` for the keys that open it. A busy menu button ignores clicks like any busy button; the screen ignores its keys too. Only a button opens a menu: `menuOpen` and `onKeyDown` with `href` are a type error (`ButtonProps` is a union of a button and a link), and a link never takes the menu look.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger' \| 'danger-ghost'` | Required. |
| `size` | `'inline' \| 'main'` | `inline` by default. |
| `type` | `'button' \| 'submit' \| 'reset'` | `button` by default, so it never submits a form by accident. |
| `href` | `string` | Renders an `<a rel="noopener noreferrer">`. A disabled or busy link loses its `href` and says `aria-disabled`. Not with `menuOpen` or `onKeyDown`. |
| `external` | `boolean` | Only with `href`: adds `target="_blank"` (dropped with the `href` while disabled or busy). Not with `menuOpen`. |
| `disabled` | `boolean` | Native `disabled`. |
| `busy` | `boolean` | A spinner in place of the label, at the same width; `aria-busy` and `aria-disabled`; clicks are swallowed. Never dimmed as a whole: its colors are listed contrast pairs. |
| `waiting` | `boolean` | Another button's request is in flight, such as the answer a held request's owner didn't choose: the busy colors without the spinner, its words still shown, `aria-disabled`, and clicks are swallowed. |
| `menuOpen` | `boolean` | Makes it a menu button: a chevron, `aria-haspopup="menu"`, `aria-expanded`. Leave it out for a plain button. Not on a link. |
| `id` | `string` | The element's `id`. |
| `describedBy` | `string` | The `id` of the words that tell it apart from buttons named alike (`aria-describedby`): each payment limit's "Change" points at its own line. |
| `onClick` | `(event) => void` | Not called while disabled or busy. |
| `onKeyDown` | `(event) => void` | Keys pressed on the button. Not on a link. |
| `buttonRef` | `Ref<HTMLButtonElement>` | The `<button>`, for a screen that has to know about it. React lets go of it (a callback gets `null`) before the button leaves the page, so whether it had focus can still be read then, as `PublicShell` does for "Ask for {owner}". Not on a link. |
| `children` | `ReactNode` | The label, in `.cd-type-control` (primary at weight 500), held as one run of text, so words around a name stay together and the gap only separates them from a menu button's chevron. A label with a status, such as Safety's "1 held for you", is a whole `StatusLabel`, which keeps the one line `size-control` tall. |

## States

| Variant | Rest | Hover | Disabled | Busy |
| --- | --- | --- | --- | --- |
| `primary` | `button-primary`, `button-primary-text` | `button-primary-hover` | Rest fill | `button-primary-hover`, spinner in `button-primary-text` |
| `secondary` | `fill-secondary`, `text-primary` | `fill-secondary-hover` | Rest fill | Rest fill, spinner in `text-secondary` |
| `ghost` | No fill, `text-primary` | `fill-hover` | No fill | No fill, spinner in `text-secondary` |
| `danger` | `button-danger-fill`, `button-danger-text` | `button-danger-fill-hover` | Rest fill | `button-danger-fill-hover`, spinner in `button-danger-text` |
| `danger-ghost` | No fill, `button-danger-text` | `fill-hover` | No fill | `fill-hover`, spinner in `button-danger-text` |

A menu button keeps its variant's look, and its hover fill while its menu is open (`aria-expanded="true"`); its padding is `space-14` before the words and `space-10` after the chevron (`space-12` and `space-8` inline), because the icon carries its own margin.

Disabled dims every variant to 40%. Busy never dims, even on a button that is disabled too: busy wins, and each variant steps to its busy colors and shows its spinner, as `busy` above says. Keyboard focus draws an edge just inside the button, never a ring outside it, so nothing moves: 1 px of `line-focus` on secondary, ghost, danger and danger-ghost, and 2 px of `bg-app` on the primary, whose cream fill hides the warm line. A click shows none.

A label longer than its line, such as a long name on a phone or in the take-over bar's controls column, wraps inside the button in balanced lines, and the button grows taller with the same padding. A word wider than the line, such as a name with no spaces, breaks inside the button too (`overflow-wrap: anywhere`), even in a row of buttons. It is never wider than its container, and one line of label keeps it exactly `size-control` (or `size-control-main`) tall.

On a touch screen (`pointer: coarse`), a button under `size-touch` (44 px) tall or wide reaches it with an unseen hit area centred on it (`::after`), so a 32 px button takes a tap 6 px above or below it. Nothing is drawn and nothing moves. A layout that puts controls closer together than the hit area would reach caps it at half its gap, with `--cd-touch-reach-block` (above and below) and `--cd-touch-reach-inline` (either side), so neighbours' hit areas never overlap; buttons in a row are already wider than 44 px, so theirs only grow up and down.

Hover fills change at `motion-instant`; a press scales to 0.98 at `motion-fast` with `motion-ease-emphasis`; a busy spinner turns once every `motion-spin`. Nothing moves under reduced motion.

## One press at a time

`useSendOnce(pending, error?)` in `useSendOnce.ts` holds a press whose result the screen reports later, for components that send one, such as `ConnectionPanel`, `ConnectorReview` and `ToolReviewCard`. `send(key, call)` calls `call` once and notes which button was pressed (`pressed`, for its `busy` spinner), and every button `waiting` ignores further presses until the screen's `pending` has come and gone, an error is delivered (one appears, or another replaces it), or the promise the call returned rejects. Clearing an error releases nothing, so the same failure twice can be retried. It is used inside the design system and is not exported from the package.
