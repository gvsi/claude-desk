# IntroDialog

`IntroDialog` is the first visit's front door: a dialog over the dimmed page that says what Claude Desk is, lists what to try and takes the demo passcode, beside a clay illustration of a booked visit.

## When to use

- Once, on a first visit before a demo copy exists, over a static preview of Rivera's Today that can't be used yet.
- Not for confirming or cancelling something: this dialog has no way out but the passcode.

## What it does

- It is a native modal `<dialog>` that draws its own scrim (`scrim`, fixed to the whole window), so the page behind is inert and the consumer needs no portal or stacking order.
- It can't be dismissed. There is no close button. Escape does nothing: the key is stopped before the browser handles it, a cancel is always refused, and `closedby="none"` is set where browsers support it (Chrome otherwise closes a modal on a second Escape). A press on the scrim does nothing, and doesn't move focus either.
- Focus starts in the passcode field. Tab and Shift+Tab go round the dialog's own controls and nowhere else.
- Enter in the field or the button calls `onSubmit` once, with the trimmed passcode. The button is disabled while the trimmed field is empty.
- While `busy`, the button reads "Starting" and the form has `aria-busy="true"`. The button stays focusable but inert (`aria-disabled="true"`, a press is ignored), so a person who pressed it keeps their place. Only the empty state is truly `disabled`. A second submit does nothing, and neither does one sent before the last `onSubmit` promise settles, so a quick double Enter can't start two copies.
- A rejected `onSubmit` promise is ignored: the page reports failures through `error`.
- With `error`, an error `Notice` (`role="alert"`) under the field gives the line from `INTRO_ERROR_COPY`. The field gets `aria-invalid="true"` and its `aria-describedby` names the line. When `error` changes to a code, or a busy try ends with one, the field takes focus with its text selected, ready to type over. The code itself never appears in the page, and a code this build doesn't know reads as `unreachable`.
- Nothing moves beyond the button's own transitions, which stop under reduced motion.

## What the consumer provides

- `title`, `intro`, `thingsToTry` and `submitLabel`, as in the stories. An item without an `icon` shows none.
- `onSubmit`: send the passcode to the API's passcode route, with `busy` on while it runs. On failure set `error`: a wrong passcode is `wrong_passcode`, too many tries is `rate_limited`, and a network failure or server error is `unreachable`. On success, take the dialog away.
- Nothing fetches here.

## Error copy (`introCopy.ts`)

`INTRO_ERROR_COPY` is `satisfies Record<IntroErrorCode, string>`, so a code added without a line is a compile error.

| `error` | Line |
| --- | --- |
| `wrong_passcode` | "That passcode didn’t work. Check the message that shared this link, then try again." |
| `rate_limited` | "That’s a lot of tries. Wait a few minutes, then try again." |
| `unreachable` | "We couldn’t reach the demo. Try again in a moment." |

## Layout

- The panel is at most `size-intro` wide, centered with 40 px of scrim around it: `bg-surface` at `radius-card`, an inset `line-hairline` edge and `shadow-dialog`.
- The passcode field is `size-control-main` tall at `radius-control`, on `fill-card`, outlined in `line-field`: a field's outline is its boundary, so it reaches 3:1 against the dialog.
- The content column (padded 28 px) holds the wordmark and the "Demo" pill, the title in `.cd-type-intro-title` with balanced lines (the dialog's name) and the intro (its description), "Things to try" with each icon centered against its title and detail, and at the bottom the passcode form and the `ConceptFooter`.
- The illustration column is `size-intro-illustration` wide: a `clay` field with two soft arcs in `illustration-arc` and two light cards, Dana's request and Claude's booked reply with two receipts. It is `aria-hidden` and holds nothing focusable. Its cards are the only light surface in the product, and the `illustration-*` colors are for them alone. Its date and names are fixed illustration copy, never a real booking.
- Under 720 px (a media query: the dialog always fills the window, so the window's width is the dialog's) the illustration isn't drawn, the panel has 16 px of scrim around it, and the field and button stack with the button full width. In a short window the panel scrolls inside itself.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. The dialog's name. |
| `intro` | `string` | Required. The dialog's description. |
| `thingsToTry` | `IntroThing[]` | Required, in order. `IntroThing` is `{ title; detail?; icon?: IconName }`. |
| `submitLabel` | `string` | Required. |
| `onSubmit` | `(passcode: string) => Promise<void>` | Required. Called once per submit with the trimmed passcode. |
| `busy` | `boolean` | The demo is starting. |
| `error` | `IntroErrorCode` | `'wrong_passcode' \| 'rate_limited' \| 'unreachable'`. |
