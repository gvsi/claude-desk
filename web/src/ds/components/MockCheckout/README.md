# MockCheckout

`MockCheckout` is the page a visitor opens from a payment link card: a test checkout in the design system's own look, which shows a test card filled in and locked, sends nothing typed on it anywhere, and says in every state that this is a test payment and that the page is part of a chat with an AI.

## When to use

- As the whole body of the mock checkout page (`/pay/{token}`), from the link's `PaymentLinkView`.
- Nowhere else. A payment is offered in the chat as a `payment_link` reply card, whose button opens this page.

## What it does

- Every state shows the `DisclosureLine` above the card ("This page is part of a chat with Claude, an AI.", without the business's name, since the page can be opened on its own) and the `ConceptFooter` below it. Inside the card, every state shows the merchant at the top left with a "Test mode" `Pill` and its held dot at the top right, the link's title as the page's heading, and "Test payment, no money moves" as the card's last line, the same note every reply card about money moving carries (`TEST_PAYMENT` in `ReplyCard/chrome.ts`).
- Only `issued` can be paid. It shows the amount large, exactly as the page gives it (nothing here formats money), "This link works once.", the test card and the two buttons, "Pay {amount}" and "Cancel payment".
- The test card is fixed copy, never props: number 4242 4242 4242 4242, expiry 12 / 34, security code 123, with a lock beside the number. The values are shown, not asked for, and "Test card, filled in for you" says so, with a lock. A screen reader reads each value with its name ("Card number", "Expiry date", "Security code").
- The name on the card is `customerName` when the link carries one, shown read-only like the other values and marked as someone's words, with "Test card, filled in for you" under it. Without it, "Name on card" is an empty field to type in, described by its own line, "Any name works. It stays on this page.", and the lock's line moves up under the card, so it never sits under the one field that isn't filled in. What is typed stays in the component's own state: no form surrounds it, Enter sends nothing, and no callback receives it, so it never leaves the page.
- One click on Pay calls `onPay` once and one on Cancel calls `onCancel` once. The pressed button then spins in place of its words (`busy`) and the other waits in its busy colors (`waiting`). Both keep focus, say `aria-disabled`, and ignore every click, even a second one that lands before the page has drawn the first, until the request ends: the screen changes `state`, or reports a new `error`. Clearing an old error, as the screen does when a retry starts, ends nothing, so the retry stays locked and its button keeps spinning. The screen's `busy` does the same with nothing pressed here, spinning Pay.
- With `error`, an error `Notice` (`role="alert"`) under the buttons reads "That didn’t go through. Reload this page to see where the payment stands." The request is over, so both buttons are at rest again. A second try is safe: the kernel completes a link only while it is `issued`.
- Every other state drops the amount, the test card, the name and the buttons, and shows one line with its dot that says what happened and where to go next (the table below). Paid adds a check, drawn once in the line's own ink: status color appears only as the dot.
- Paid, with `chatHref`, keeps the same words and makes "Go back to the chat" ("Vuelve al chat") a `TextLink` inside the sentence (`runningText`), to the visitor's chat in the same tab. A visitor's cancelled checkout keeps its sentence and appends the same link, followed by a period. Only a public chat's own path (`/d/<slug>`, matching `^/d/[a-z0-9-]+$`) is linked: anything else, or no `chatHref`, leaves the original line with no link. The rule-change cancellation and other states keep their existing lines without links.
- A state this build doesn't know shows no buttons and reads as `unknown`, still being confirmed, with the chat as where the result shows.
- The line sits in a result region (`role="status"`, `aria-live="polite"`, `aria-atomic="true"`) that is there in every state: visually hidden and empty while the link is open, and holding the line once it isn't. Each new line is read out whenever it arrives, from issued to paid or from still being confirmed to paid, wherever focus is.
- When the link closes while the page is open (a pay or a cancel went through, or the link expired), the buttons go with it. If focus was in the checkout, on a button the close takes away included, the card's title (`tabindex="-1"`) takes it, so focus doesn't fall to the top of the page; the region reads the line, so focus doesn't read it twice. The checkout knows where focus was from its own `focusin` and `focusout`. Focus elsewhere on the page stays where it is, and so does focus on nothing when it wasn't in the checkout, whether it never was or left for nothing before the link closed. A page that opens on a closed link moves nothing.
- Nothing here fetches.

| `state` | Shows |
| --- | --- |
| `issued` | The amount, "This link works once.", the test card, "Pay {amount}" and "Cancel payment". |
| `paid` | Handled dot, then the check: "Paid. Go back to the chat to see it there." With a `chatHref`, "Go back to the chat" is a link to it. |
| `expired` | Info dot: "This payment link expired. Ask in the chat for a new one." |
| `cancelled` | Info dot: "This payment was cancelled. Nothing was charged." With a valid `chatHref`, appends "Go back to the chat." with the same link as paid. |
| `cancelled`, `cancelReason: 'rules_changed'` | Info dot: "This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay." Never the generic cancelled line. |
| `unknown` | Held dot: "This payment is still being confirmed. The chat will show the result." |

## What the consumer provides

- `merchant`: the business's name, `PaymentLinkView.business_name`.
- `title`, `state`, `language` and `cancelReason`: the link's `PaymentLinkView.title`, `state`, `language` and `cancel_reason`.
- `amount`: the page's amount string, made from `PaymentLinkView.amount_cents`. It shows exactly as given, large and in "Pay {amount}".
- `chatHref`: the visitor's chat as its own path (`/d/turner-plumbing`), when the page knows it. The checkout page knows it from this browser's record of the chat that showed the link's card; the API's link view doesn't carry it.
- `customerName`: `PaymentLinkView.customer_name`, the kernel's first name and last initial ("Dana W.") for a link from a verified session, present only while the link is open. The component shows it as given and formats nothing. Without it, or with a blank one, the name is the empty field above.
- `onPay` and `onCancel`: complete or cancel the link through the API's payment routes. Neither gets any argument. Set `error` back to false when a request starts, so a retry that fails again is a new error and brings the buttons back.
- `busy` while a request is in flight, `error` when it fails with anything but an answer that says the link's state.

## Copy (`checkoutCopy.ts`)

| | English | Spanish |
| --- | --- | --- |
| Badge | Test mode | Modo de prueba |
| Footnote | Test payment, no money moves | Pago de prueba, no se mueve dinero |
| Under the amount | This link works once. | Este enlace funciona una sola vez. |
| Card group | Card information | Datos de la tarjeta |
| Value names (read only by screen readers) | Card number, Expiry date, Security code | Número de tarjeta, Fecha de vencimiento, Código de seguridad |
| Name label | Name on card | Nombre en la tarjeta |
| Hint, with the lock | Test card, filled in for you | Tarjeta de prueba, ya rellenada |
| Under the name to type | Any name works. It stays on this page. | Cualquier nombre sirve. Se queda en esta página. |
| Pay | Pay {amount} | Pagar {amount} |
| Cancel | Cancel payment | Cancelar pago |
| Error | That didn’t go through. Reload this page to see where the payment stands. | No se pudo completar. Recarga esta página para ver el estado del pago. |
| Paid (the link's words, with a `chatHref`: "Go back to the chat", "Vuelve al chat") | Paid. Go back to the chat to see it there. | Pagado. Vuelve al chat para verlo allí. |
| Expired | This payment link expired. Ask in the chat for a new one. | Este enlace de pago venció. Pide uno nuevo en el chat. |
| Cancelled | This payment was cancelled. Nothing was charged. | Este pago se canceló. No se cobró nada. |
| Cancelled, with a valid `chatHref` (the appended words reuse the paid link) | This payment was cancelled. Nothing was charged. Go back to the chat. | Este pago se canceló. No se cobró nada. Vuelve al chat. |
| Cancelled by a rule change | This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay. | Este enlace se canceló porque el negocio cambió sus reglas. No se cobró nada. Pregunta en el chat si todavía quieres pagar. |
| Unknown | This payment is still being confirmed. The chat will show the result. | Este pago aún se está confirmando. El chat mostrará el resultado. |

The merchant, the title and the customer's name are someone's own words, marked `data-copy="user"`. The page sets `lang` to `language`.

## Layout

- One column centered on the page, at most `size-checkout` (420 px) wide with its padding, padded `space-28` on top, `space-24` at the sides and `space-20` at the bottom: the disclosure line, the card and the footer, `space-14` apart.
- The card: `fill-card` in a 1 px `line-card` border at `radius-card`, padded `space-24`, its parts `space-14` apart. The merchant in `meta` type and `text-secondary`, the badge level with it at the right. The title in `section` type, an `h1`.
- The amount in `amount` type (sans 32/40, weight 500, -0.3 px), "This link works once." `space-2` under it in `meta`, `text-secondary`.
- Each group's label in `meta`, `text-secondary`, `space-6` over its values. The test card in one `line-control` outline at `radius-control`: the number across the top with a 14 px lock at its right, the expiry and the security code side by side under it, half each, split by the same line. Each value is `size-control-main` tall inside its lines, padded `space-12`, in `body` type and `text-secondary`. The customer's name is one value in its own `line-control` outline. The field to type a name in has the outline every editable field has, `line-field` (3:1 against the ground), with the typed text in `text-primary`, at the same height. Each hint is `space-6` under what it describes, in `caption` type and `text-secondary`: the lock's line, with a 14 px lock, under the customer's name, or under the card when the name is the field; the name field's own line, with no icon, under the field.
- Pay (primary) over Cancel (secondary), both main buttons as wide as the card's content, `space-8` apart. Any error line follows.
- A final state's line in `body` type and `text-primary`: the dot, then the words, `space-10` apart, the dot and the paid check on the middle of the first line, the check `space-6` before the words, in the same ink. The paid and visitor-cancelled lines' link is `TextLink` in `accent-blue` with its quiet underline, in the sentence's own type.
- The footnote in `caption` type and `text-secondary`, `space-12` under a `line-hairline` rule.
- The paid check draws once at `motion-base`, short arm first as a hand writes one; the buttons follow `Button`. Nothing moves under reduced motion.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `merchant` | `string` | Required. The business's name. |
| `title` | `string` | Required. `PaymentLinkView.title`. |
| `amount` | `string` | Required. The page's amount string. |
| `state` | `PaymentLinkState` | Required. `'issued' \| 'paid' \| 'expired' \| 'cancelled' \| 'unknown'`. |
| `cancelReason` | `'rules_changed'` | `PaymentLinkView.cancel_reason`; read only when `state` is `cancelled`. |
| `language` | `'en' \| 'es'` | Required. `PaymentLinkView.language`. |
| `customerName` | `string` | `PaymentLinkView.customer_name`; see above. |
| `chatHref` | `string` | The visitor's chat, `/d/<slug>`; read when `state` is `paid` or `cancelled` without `cancelReason: 'rules_changed'`. Anything else is ignored. |
| `busy` | `boolean` | A request is in flight. |
| `error` | `boolean` | The last request failed. |
| `onPay` | `() => void` | Required. Called with no arguments. |
| `onCancel` | `() => void` | Required. Called with no arguments. |
