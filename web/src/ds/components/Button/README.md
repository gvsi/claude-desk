# Button

`Button` starts an action, in one of three weights and two heights, with two red variants for answers that refuse, and says exactly what happens.

## When to use

- `primary` for the one action a view is about ("Send counter-offer", "Join the chat"): an inverted neutral, at most one per view.
- `secondary` for the other actions beside it, such as "Allow this time" on an approval card.
- `ghost` for quiet actions that shouldn't compete ("Start over", "Mark done").
- `danger` for an answer that refuses, once: "Deny this time", a soft `button-danger-fill` behind `button-danger-text`.
- `danger-ghost` for a quieter refusal beside it: `button-danger-text` with no fill.
- The red variants are only for refusing. They are never a status, a warning or decoration, and their words still say exactly what happens.
- `size="main"` for a screen's main actions (`size-control-main`, 40 px); `inline` (`size-control`, 32 px) everywhere else.
- With `href`, the same look as a link: the button a payment or document card ends with ("Open payment page").
- With `href` and `external`, a link that opens in a new tab, as `TextLink`'s `external` does: `target="_blank"` with `rel="noopener noreferrer"`, and no change to its look. Today's "Open your public page" and "Chat as a customer" use it, so Today stays open.
- With `menuOpen`, a menu button: its words, then a 16 px `chevron-down` icon, with `aria-haspopup="menu"` and `aria-expanded`. A held request's card uses it for a side of the answer that has two answers ("Allow", "Deny"). The screen draws the menu, opens it on a click, Enter, Space or Down, and moves focus into it.

## What the consumer provides

- The label, in words that say what happens. Never "OK" or "Continue" when a verb can say more, and never an arrow.
- `busy` while the click's request is in flight. The button keeps focus, steps down in token colors (a secondary or ghost label turns `text-secondary`, the primary fill turns `button-primary-hover`, a `danger` fill turns `button-danger-fill-hover` and a `danger-ghost` button takes `fill-hover` under its red words, so every label still reads at 4.5:1 or more on the grounds its pairs are listed for in `contrast.ts`: a page (`bg-app`), a card on it (`fill-card` over `bg-app`) and a dialog (`bg-surface`), the sidebar (`bg-panel`) and the reviewer bar (`bg-muted`) too for a ghost button, and a page or a card for the red answers), announces `aria-busy` and ignores further clicks; change the label too if the wait is long ("Sending").
- A ground for it among those. No Button sits on `bg-selected`, the selected row's ground: a busy secondary label would read 4.45 there and a busy danger one 3.98, so the guard `no_button_on_the_selected_ground` keeps Buttons off it until its pairs are listed, with colors that clear 4.5.
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
| `busy` | `boolean` | `aria-busy` and `aria-disabled`; clicks are swallowed. Never dimmed as a whole: its colors are listed contrast pairs. |
| `menuOpen` | `boolean` | Makes it a menu button: a chevron, `aria-haspopup="menu"`, `aria-expanded`. Leave it out for a plain button. Not on a link. |
| `id` | `string` | The element's `id`. |
| `onClick` | `(event) => void` | Not called while disabled or busy. |
| `onKeyDown` | `(event) => void` | Keys pressed on the button. Not on a link. |
| `children` | `ReactNode` | The label, in `.cd-type-control` (primary at weight 500), held as one run of text, so words around a name stay together and the gap only separates them from a menu button's chevron. |

## States

| Variant | Rest | Hover | Disabled and busy |
| --- | --- | --- | --- |
| `primary` | `button-primary`, `button-primary-text` | `button-primary-hover` | Rest fill |
| `secondary` | `fill-secondary`, `text-primary` | `fill-secondary-hover` | Rest fill |
| `ghost` | No fill, `text-primary` | `fill-hover` | No fill |
| `danger` | `button-danger-fill`, `button-danger-text` | `button-danger-fill-hover` | Rest fill |
| `danger-ghost` | No fill, `button-danger-text` | `fill-hover` | No fill |

A menu button keeps its variant's look, and its hover fill while its menu is open (`aria-expanded="true"`); its padding is `space-14` before the words and `space-10` after the chevron (`space-12` and `space-8` inline), because the icon carries its own margin.

Disabled dims every variant to 40%. Busy never dims, even on a button that is disabled too: busy wins, and each variant steps to listed token colors, as `busy` above says. Focus shows the base stylesheet's 2 px `accent-blue` ring at a 2 px offset on every variant.

A label longer than its line, such as a long name on a phone or in the take-over bar's controls column, wraps inside the button in balanced lines, and the button grows taller with the same padding. A word wider than the line, such as a name with no spaces, breaks inside the button too (`overflow-wrap: anywhere`), even in a row of buttons. It is never wider than its container, and one line of label keeps it exactly `size-control` (or `size-control-main`) tall.

Hover fills change at `motion-instant`; a press scales to 0.98 at `motion-fast` with `motion-ease-emphasis`. Nothing moves under reduced motion.
