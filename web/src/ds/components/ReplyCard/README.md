# ReplyCard

`ReplyCard` shows one typed reply card: the kernel's checked fields under a fixed label in the visitor's language.

## When to use

- Every `RenderedBlock` of kind `card` in a visitor reply, an owner's transcript or an agent's conversation. Prices, dates, times, discounts, bookings and policies reach a visitor only this way; Claude's prose never carries them.
- Never for anything a component made up. The card shows only what the block carries. Plain status lines are margin receipts, not cards.
- A blocked reply reaches the visitor as the kernel's `handoff` card, with its receipt.

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
| `booking_options` | `title`, then one line and one option per open time |
| `booking_confirmed` | `title` (the start), `lines` (the length and the booking number) |
| `hours` | `title` (the first window), `lines` (any more windows) |
| `handoff` | `title`, `lines` |
| `payment_link`, `document_link` | `title`, `href` |
| `policy`, `contact`, `verify_prompt`, `owner_said`, `refund_issued`, `charge_confirmed`, `callback_confirmed`, `payment_confirmed` | `title` |

## Chrome

`CARD_CHROME` holds each template's fixed words in English and Spanish: the label on the top line, the button on a link card and the note on a card about money moving. A missing template or language is a compile error. There are no amounts, dates or promises in the chrome.

- Every card about money moving always says "Test payment, no money moves" / "Pago de prueba, no se mueve dinero". `MONEY_TEMPLATES` lists them: `payment_link`, `payment_confirmed`, `charge_confirmed` and `refund_issued`. `chrome.test.ts` fails if one of them lacks the note in either language, or if a template outside the list carries it, so a new money card goes in the list.
- `payment_link` ends with a secondary "Open payment page" button. `document_link` ends with a primary "Download" button. Both go to the proxied path, and the path is never shown as text.
- `contact` lines stay text. They never become `tel:` or `mailto:` links.
- `owner_said`, `policy` and `contact` carry the owner's own words verbatim, so their fields are marked `data-copy="user"`.
- `booking_confirmed` and `payment_confirmed` draw a sage check once beside their label, at `motion-base`. Under reduced motion it is drawn from the start. Every other template has a 16 px line icon.
- A template this build doesn't know shows its text in a plain card, with no label, icon or link.

## A cancelled payment link (`LinkCancelledCard`)

`LinkCancelledCard`, in this folder and exported from the package, is the card for a payment link a confirmed rule change cancelled. It sits with the reply cards and shares their frame and label line.

- `line`: the kernel's one line for the cancelled link, the `title` of its rendered `link_cancelled` block, shown as written. The kernel renders it from the owner's display name, with no fact, in the session's language.
- `language`: the event's language, or the public page's `?lang=`.
- Its chrome is `LINK_CANCELLED_CHROME`: "Payment link cancelled" / "Enlace de pago cancelado", with the payment link's `card` icon. It has no test-payment note, since no money moved, and no link or button, since the link is gone.
- The line is the card's headline, in `section` type, as `ReplyCard` shows a block's `title`.
- It takes the line, not a `CardBlock`, because `link_cancelled` isn't a `ClauseTemplate` in the generated contract yet. When the kernel payments contract (plan 01c) adds it, the chrome moves into `CARD_CHROME` and `ReplyCard` shows the block itself.

## Why there's no date tile or price column

Card data carries no separate amount or date. The kernel renders money and times into the title and lines in the visitor's language. A date tile or a price column would mean the design system parsing or formatting them, and nothing in it does. The card shows the kernel's strings as they are, so what the visitor reads is exactly what the reply check passed.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `block` | `CardBlock` | Required. Rendered as given. |
| `language` | `'en' \| 'es'` | Required. The chrome's language. |
| `ownerName` | `string` | Required. The owner's display name. |

The card is a `Card` at most 520 px wide with 16 px padding, an `article` named by its label. Label in secondary `caption`, headline in `section`, details in secondary `meta`, options in `body`, note in secondary `caption`. Also exported: `cardView`, `CARD_CHROME`, `MONEY_TEMPLATES`, `LINK_CANCELLED_CHROME` and the `CardView` and `CardChrome` types.
