# ReplyCard

`ReplyCard` shows one typed reply card: the kernel's checked fields under a fixed label in the visitor's language.

## When to use

- Every `RenderedBlock` of kind `card` in a visitor reply, an owner's transcript or an agent's conversation. Prices, dates, discounts and bookings reach a visitor only this way; Claude's own words can't state a price, date or discount, can't make a promise the cards don't back, and can confirm a booking only next to a booking card.
- Never for anything a component made up. The card shows only what the block carries. Plain status lines are margin receipts, not cards.
- When only the prose failed, a blocked reply reaches the visitor as its checked cards, then the kernel's `handoff` card if Claude drafted one. Other blocked replies reach the visitor as the handoff card alone, with its receipt.

## What the consumer provides

- `block`: the `CardBlock` exactly as it arrived in the event. Don't edit, merge or reformat it.
- `language`: the event's `language`, or the public page's `?lang=`. It picks the chrome and sets `lang` on the card, so a screen reader reads Spanish as Spanish.
- `ownerName`: `owner_display_name` ("Maria Rivera"), used only in the "Maria Rivera said" label.

## What the card shows

`cardView(block)` reads the fields and nothing else:

- `headline` is the block's `title`.
- `details` are its non-empty `lines`, in order.
- `options` are its `options`, shown as a plain list of their labels. The visitor answers in the chat, so they aren't buttons. The kernel also writes each open time as a line for the block's plain text, so a line that repeats an option's label is shown once, in the list.
- When a block has no title, lines or options, the card shows its `text`, line by line.
- `href` is kept only on `payment_link` when it matches `/pay/{token}`, and on `document_link` when it matches `/api/d/{token}`. Any other value is no link at all, and the card loses its button but keeps its words. That covers a scheme, another host, a query, a fragment or another path.

The kernel fills these fields for each template (the master plan's "Clauses" row and the kernel's clause rendering):

| Template | Fields the card reads |
| --- | --- |
| `quote`, `charges` | `title`, `lines` |
| `link_cancelled` | `title` (the link's amount), `lines` (what the link was for, then the kernel's line) |
| `booking_options` | `title`, then one line and one option per open time |
| `booking_confirmed` | `title` (the date), `lines` ("{start} to {end}", "With {owner}"; no booking ID) |
| `hours` | `title` (the first window), `lines` (any more windows) |
| `handoff` | `title`, `lines` |
| `payment_link`, `document_link` | `title`, `href` |
| `policy`, `contact`, `verify_prompt`, `owner_said`, `refund_issued`, `charge_confirmed`, `callback_confirmed`, `payment_confirmed` | `title` |

## Chrome

`CARD_CHROME` holds each template's fixed words in English and Spanish: the label on the top line, the button on a link card and the note on a card about money moving. A missing template or language is a compile error. There are no amounts, dates or promises in the chrome.

- Every card about money moving always says "Test payment, no money moves" / "Pago de prueba, no se mueve dinero". `MONEY_TEMPLATES` lists them: `payment_link`, `payment_confirmed`, `charge_confirmed` and `refund_issued`. `chrome.test.ts` fails if one of them lacks the note in either language, or if a template outside the list carries it, so a new money card goes in the list.
- `payment_link` ends with a secondary "Open payment page" button. `document_link` ends with a primary "Download" button. Both go to the proxied path, and the path is never shown as text.
- `link_cancelled`, the Desk's own card for a payment link a confirmed rule change cancelled, says "Payment link cancelled" / "Enlace de pago cancelado" beside the payment link's `card` icon. No money moved, so it has no test-payment note, and the link is gone, so it has no button.

## A vision page's Download (`inertDownload`)

- Vision pages only. A vision page makes no requests, so with `inertDownload` a `document_link` card draws its "Download" exactly as a real one does, as a plain `<button type="button">` with no destination. It ignores any `href` the block carries and needs none, so a vision page's data holds no `/api/d/` path. On the Claude account vision page (N-R2-Vision-ClaudeAccount) it draws Dana's invoice.
- Never on a real card. Without it, a document card draws Download only as a link to the kernel's `/api/d/{token}` path (`cardView`), and a card without that path draws none (`DocumentWithoutItsPath`, `DocumentWithAnotherPath`). The link guard is unchanged.
- The first press shows `VISION_INERT_LINE`, "This is a vision page, so nothing is sent.", once, in a secondary caption 8 px under the button's row, in a polite live region (`role="status"`) that is there from the start and takes no room until then; later presses change nothing and announce nothing.
- Document cards only. It changes no other template: a payment link keeps its "Open payment page" link to the checkout, and only a real `/pay/` path gives it one.
- The guard `inert_controls_only_on_the_vision_pages` lets only these components, the vision boards' page parts and the vision pages (`web/src/vision/`) use it.
- `contact` lines stay text. They never become `tel:` or `mailto:` links.
- `owner_said`, `policy` and `contact` carry the owner's own words verbatim, so their fields are marked `data-copy="user"`.
- `booking_confirmed` and `payment_confirmed` draw a sage check once beside their label, at `motion-base`, short arm first as a hand writes one. Under reduced motion it is drawn from the start. Every other template has a 16 px line icon.
- A template this build doesn't know shows its text in a plain card, with no label, icon or link.

## Why there's no date tile or price column

Card data carries no separate amount or date. The kernel renders money and times into the title and lines in the visitor's language. A date tile or a price column would mean the design system parsing or formatting them, and nothing in it does. The card shows the kernel's strings as they are, so what the visitor reads is exactly what the reply check passed.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `block` | `CardBlock` | Required. Rendered as given. |
| `language` | `'en' \| 'es'` | Required. The chrome's language. |
| `ownerName` | `string` | Required. The owner's display name. |
| `inertDownload` | `boolean` | Vision pages only, document cards only: Download is a button going nowhere. `false` by default. |

The card is a `Card` at most 520 px wide with 16 px padding, an `article` named by its label. Label in secondary `caption`, headline in `section`, details in secondary `meta`, options in `body`, note in secondary `caption`. Also exported: `cardView`, `CARD_CHROME`, `MONEY_TEMPLATES` and the `CardView` and `CardChrome` types.
