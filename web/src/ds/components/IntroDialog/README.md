# IntroDialog

`IntroDialog` is the first visit's front door: a dialog over the dimmed page that says what Claude Desk is, lists what to try and takes the demo passcode, beside a clay illustration of a booked visit.

## When to use

- Once, on a first visit before a demo copy exists, over a static preview of Turner's Today that can't be used yet.
- Not for confirming or cancelling something: this dialog has no way out but the passcode.

## What it does

- It is a native modal `<dialog>` that draws its own scrim (`scrim`, fixed to the whole window), so the page behind is inert and the consumer needs no portal or stacking order. While it is open the page behind doesn't scroll.
- It can't be dismissed. There is no close button. Escape does nothing: the key is stopped before the browser handles it, a cancel is always refused, and `closedby="none"` is set where browsers support it (Chrome otherwise closes a modal on a second Escape). A press on the scrim does nothing, and doesn't move focus either.
- The field is labelled "Passcode" and its placeholder says "Enter the passcode", never the passcode itself.
- Focus starts in the passcode field. Tab and Shift+Tab go round the dialog's own controls and nowhere else.
- Enter in the field or the button calls `onSubmit` once, with the trimmed passcode. The button is disabled while the trimmed field is empty.
- While `busy`, the button shows the busy spinner in place of its words, like every busy `Button`, and is still named by `submitLabel`; a status line seen only by screen readers says "Starting the demo", and the form has `aria-busy="true"`. The button stays focusable but inert (`aria-disabled="true"`, a press is ignored), so a person who pressed it keeps their place. Only the empty state is truly `disabled`. A second submit does nothing, and neither does one sent before the last `onSubmit` promise settles, so a quick double Enter can't start two copies.
- A rejected `onSubmit` promise is ignored: the page reports failures through `error`.
- With `error`, an error `Notice` (`role="alert"`) under the field gives the line from `INTRO_ERROR_COPY`. The field gets `aria-invalid="true"` and its `aria-describedby` names the line. The line isn't shown while `busy`, so every failure is a new alert and is announced, even when the page leaves `error` set to the same code through a retry. When a line appears, the field takes focus with its text selected, ready to type over. The code itself never appears in the page, and a code this build doesn't know reads as `unreachable`.
- It is the first visit's one moment. The panel arrives (`opacity` 0 to 1 and `scale(0.98)` to 1, `motion-base`, `motion-ease-emphasis`), then the illustration plays its conversation once, in about 1.1 s with today's motion tokens: Dana's card rises 6 px and fades in at about 290 ms, Claude's card follows at about 600 ms, the booking's check draws (`motion-base`, as on the board, short arm first as a hand writes one) at about 860 ms, and the two receipts tick in from 4 px to the left at about 1000 and 1150 ms, `motion-stagger` apart. Every start is a sum of motion tokens, so the times move with them. Once the last receipt is in, the illustration is marked played and rests where the story ended, so it doesn't play again when the window narrows under 960 px and widens again, or a tablet turns. The content column doesn't move, and the passcode field has focus from the first frame. This is the illustration's own conversation, not a page-entrance cascade: the page around it stays still.
- With `leaving`, the passcode worked and the next page is ready, so the dialog lets go of it in `motion-fast` (`motion-ease`): the scrim fades to clear and the panel goes to `opacity` 0 and `scale(0.98)`. While it leaves it is still starting the demo: the spinner and the status line stay, and nothing more is sent. It closes the native dialog when the scrim's fade ends (`animationend`), then calls `onClosed` once. It can never stay open: with no exit to run it closes at once, and if the animation's end never reaches it, a timer closes it after the exit's length plus `motion-instant`. If the page stops rendering it before then (the owner went elsewhere), `onClosed` is never called. Once set, `leaving` stays set. A wrong passcode never starts it: only the page knows the passcode worked.
- Under reduced motion none of it runs: the dialog appears with the illustration already whole, the check drawn, and on `leaving` it closes at once, before a frame of the exit is drawn. The button's own transitions stop too.

## What the consumer provides

- `title`, `intro`, `thingsToTry` and `submitLabel`, as in the stories. An item without an `icon` shows none.
- `onSubmit`: send the passcode to the API's passcode route, with `busy` on while it runs. On failure set `error`: a wrong passcode is `wrong_passcode`, too many tries is `rate_limited`, and a network failure or server error is `unreachable`. On success, once the next page is ready to draw at once, set `leaving`, and go on to that page from `onClosed`, so the dialog lets go of it rather than vanishing in one frame.
- Render it outside the inert preview of Today, not inside it. A modal dialog escapes an inert page and its Tab order still works there, but an `aria-hidden` wrapper would hide it from assistive tech.
- Nothing fetches here.

## Error copy (`introCopy.ts`)

`INTRO_ERROR_COPY` is `satisfies Record<IntroErrorCode, string>`, so a code added without a line is a compile error.

| `error` | Line |
| --- | --- |
| `wrong_passcode` | "That passcode didn’t work. Check the message that shared this link, then try again." |
| `rate_limited` | "That’s a lot of tries. Wait a while, then try again." |
| `unreachable` | "We couldn’t reach the demo. Try again in a moment." |

## Layout

- The panel is at most `size-intro` wide, centered with 40 px of scrim around it: `bg-surface` at `radius-card`, an inset `line-hairline` edge and `shadow-dialog`.
- The passcode field is `size-control-main` tall at `radius-control`, on `fill-card`, outlined in `line-field`: a field's outline is its boundary, so it reaches 3:1 against the dialog.
- The content column (padded 28 px) holds the brand row, the 20 px mark (no tile, light ink) 8 px from the `Wordmark` with its "Preview" badge, the same badge as the sidebar's lockup (owner, 2026-10-30), 8 px from the name and centred on the mark; then the title in `.cd-type-intro-title` with balanced lines (the dialog's name) and the intro (its description), "Things to try" with each icon centered against its title and detail, and at the bottom the passcode form and the `ConceptFooter`.
- The illustration column is `size-intro-illustration` wide: a `clay` field with two soft arcs in `illustration-arc` and two light cards, Dana's request and Claude's booked reply with two receipts. Claude's card shows the 32 px `Mark` alone where Dana's card has her initials, at the same place and size: `ground="light"`, the bell with no tile and no frame, in the drawing's dark ink on the light card. It is `aria-hidden` and holds nothing focusable. Its cards are one of the product's few light surfaces (with a QR code's quiet zone and the white tile of the About pages' app icon), and the `illustration-*` colors are for them alone. Its date and names are fixed illustration copy, never a real booking.
- The breakpoints are media queries, because the dialog always fills the window, so the window's width is the dialog's. Under 960 px, where the panel can't keep both columns at full width, the illustration isn't drawn and the panel is one column at most 560 px wide. Under 720 px the panel has 16 px of scrim around it, and the field and button stack with the button full width. In a short window the panel scrolls inside itself.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. The dialog's name. |
| `intro` | `string` | Required. The dialog's description. |
| `thingsToTry` | `IntroThing[]` | Required, in order. `IntroThing` is `{ title; detail?; icon?: IconName }`. |
| `submitLabel` | `string` | Required. |
| `onSubmit` | `(passcode: string) => Promise<void>` | Required. Called once per submit with the trimmed passcode. |
| `busy` | `boolean` | The demo is starting: the busy spinner, and "Starting the demo" in the status line. |
| `error` | `IntroErrorCode` | `'wrong_passcode' \| 'rate_limited' \| 'unreachable'`. |
| `leaving` | `boolean` | The passcode worked and the next page is ready: the dialog leaves and closes. Stays busy while it does. Once set, stays set. |
| `onClosed` | `() => void` | Called once, when the dialog has closed after `leaving`. |
