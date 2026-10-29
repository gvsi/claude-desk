# MockCheckout

`MockCheckout` is the page a visitor opens from a payment link card: a test checkout in the design system's own look, which shows a test card filled in and locked, so it collects nothing, and says in every state that this is a test payment and that the page is part of a chat with an AI.

## When to use

- As the whole body of the mock checkout page (`/pay/{token}`), from the link's `PaymentLinkView`.
- Nowhere else. A payment is offered in the chat as a `payment_link` reply card, whose button opens this page.

## What it does

- Every state shows the `DisclosureLine` above the card ("This page is part of a chat with Claude, an AI.", without the business's name, since the page can be opened on its own) and the `ConceptFooter` below it. Inside the card, every state shows the merchant at the top left with a "Test mode" `Pill` and its held dot at the top right, the link's title as the page's heading, and "Test payment, no money moves" as the card's last line, the same note every reply card about money moving carries (`TEST_PAYMENT` in `ReplyCard/chrome.ts`).
- Only `issued` can be paid. It shows the amount large, exactly as the page gives it (nothing here formats money), "This link works once.", the test card and the two buttons, "Pay {amount}" and "Cancel payment".
- The test card is fixed copy, never props: number 4242 4242 4242 4242, expiry 12 / 34, security code 123, with a lock beside the number, and the name on the card. The values are shown, not asked for: the page has no form and no field, so there is nothing to type and nothing to send. "Test card, filled in for you" says why, with a lock. A screen reader reads each value with its name ("Card number", "Expiry date", "Security code").
- One click on Pay calls `onPay` once and one on Cancel calls `onCancel` once. The pressed button then spins in place of its words (`busy`) and the other waits in its busy colors (`waiting`). Both keep focus, say `aria-disabled`, and ignore every click, even a second one that lands before the page has drawn the first, until the screen changes `state` or reports `error`. The screen's `busy` does the same with nothing pressed here, spinning Pay.
- With `error`, an error `Notice` (`role="alert"`) under the buttons reads "That didn’t go through. Reload this page to see where the payment stands." The request is over, so both buttons are at rest again. A second try is safe: the kernel completes a link only while it is `issued`.
- Every other state drops the amount, the test card and the buttons, and shows one line with its dot that says what happened and where to go next (the table below). Paid adds the sage check, drawn once.
- A state this build doesn't know shows no buttons and reads as `unknown`, still being confirmed, with the chat as where the result shows.
- When the link closes while the page is open (a pay or a cancel went through, or the link expired), the buttons go with it. If focus was on one of them, the state's line takes focus, so a screen reader reads it. Focus elsewhere on the page stays where it is, and a page that opens on a closed link moves nothing.
- Nothing here fetches.

| `state` | Shows |
| --- | --- |
| `issued` | The amount, "This link works once.", the test card, "Pay {amount}" and "Cancel payment". |
| `paid` | Handled dot and the check: "Paid. Go back to the chat to see it there." |
| `expired` | Info dot: "This payment link expired. Ask in the chat for a new one." |
| `cancelled` | Info dot: "This payment was cancelled. Nothing was charged." |
| `cancelled`, `cancelReason: 'rules_changed'` | Info dot: "This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay." Never the generic cancelled line. |
| `unknown` | Held dot: "This payment is still being confirmed. The chat will show the result." |

## What the consumer provides

- `merchant`: the business's name. `PaymentLinkView` doesn't carry it, so the screen takes it from the Desk the link belongs to.
- `title`, `state`, `language` and `cancelReason`: the link's `PaymentLinkView.title`, `state`, `language` and `cancel_reason`.
- `amount`: the page's amount string, made from `PaymentLinkView.amount_cents`. It shows exactly as given, large and in "Pay {amount}".
- `cardName`: optional. The page opens for anyone who holds the link, so pass a name only when the link's own view carries one, never a visitor's name from somewhere else. Without it, or with a blank one, the card reads "Test customer" / "Cliente de prueba".
- `onPay` and `onCancel`: complete or cancel the link through the API's payment routes. Set `error` back to false when a request starts: the buttons come back when `state` or `error` changes, so a retry that fails the same way still brings them back.
- `busy` while a request is in flight, `error` when it fails with anything but an answer that says the link's state.

## Copy (`checkoutCopy.ts`)

| | English | Spanish |
| --- | --- | --- |
| Badge | Test mode | Modo de prueba |
| Footnote | Test payment, no money moves | Pago de prueba, no se mueve dinero |
| Under the amount | This link works once. | Este enlace funciona una sola vez. |
| Card group | Card information | Datos de la tarjeta |
| Value names (read only by screen readers) | Card number, Expiry date, Security code | Número de tarjeta, Fecha de vencimiento, Código de seguridad |
| Name group | Name on card | Nombre en la tarjeta |
| Name without one | Test customer | Cliente de prueba |
| Hint | Test card, filled in for you | Tarjeta de prueba, ya rellenada |
| Pay | Pay {amount} | Pagar {amount} |
| Cancel | Cancel payment | Cancelar pago |
| Error | That didn’t go through. Reload this page to see where the payment stands. | No se pudo completar. Recarga esta página para ver el estado del pago. |
| Paid | Paid. Go back to the chat to see it there. | Pagado. Vuelve al chat para verlo allí. |
| Expired | This payment link expired. Ask in the chat for a new one. | Este enlace de pago venció. Pide uno nuevo en el chat. |
| Cancelled | This payment was cancelled. Nothing was charged. | Este pago se canceló. No se cobró nada. |
| Cancelled by a rule change | This link was cancelled because the business changed its rules. Nothing was charged. Ask in the chat if you still want to pay. | Este enlace se canceló porque el negocio cambió sus reglas. No se cobró nada. Pregunta en el chat si todavía quieres pagar. |
| Unknown | This payment is still being confirmed. The chat will show the result. | Este pago aún se está confirmando. El chat mostrará el resultado. |

The merchant, the title and a given card name are someone's own words, marked `data-copy="user"`. The page sets `lang` to `language`.

## Layout

- One column centered on the page, at most `size-checkout` (420 px) wide with its padding, padded `space-28` on top, `space-24` at the sides and `space-20` at the bottom: the disclosure line, the card and the footer, `space-14` apart.
- The card: `fill-card` in a 1 px `line-card` border at `radius-card`, padded `space-24`, its parts `space-14` apart. The merchant in `meta` type and `text-secondary`, the badge level with it at the right. The title in `section` type, an `h1`.
- The amount in `amount` type (sans 32/40, weight 500, -0.3 px), "This link works once." `space-2` under it in `meta`, `text-secondary`.
- Each group's label in `meta`, `text-secondary`, `space-6` over its values. The test card in one `line-control` outline at `radius-control`: the number across the top with a 14 px lock at its right, the expiry and the security code side by side under it, half each, split by the same line. Each value is `size-control-main` tall inside its lines, padded `space-12`, in `body` type and `text-secondary`. The name is one value in its own outline, the hint `space-6` under it in `caption` type with a 14 px lock.
- Pay (primary) over Cancel (secondary), both main buttons as wide as the card's content, `space-8` apart. Any error line follows.
- A final state's line in `body` type and `text-primary`: the dot, then the words, `space-10` apart, the dot and the paid check on the middle of the first line, the check `space-6` before the words.
- The footnote in `caption` type and `text-secondary`, `space-12` under a `line-hairline` rule.
- The paid check draws once at `motion-base`; the buttons follow `Button`. Nothing moves under reduced motion.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `merchant` | `string` | Required. The business's name. |
| `title` | `string` | Required. `PaymentLinkView.title`. |
| `amount` | `string` | Required. The page's amount string. |
| `state` | `PaymentLinkState` | Required. `'issued' \| 'paid' \| 'expired' \| 'cancelled' \| 'unknown'`. |
| `cancelReason` | `'rules_changed'` | `PaymentLinkView.cancel_reason`; read only when `state` is `cancelled`. |
| `language` | `'en' \| 'es'` | Required. `PaymentLinkView.language`. |
| `cardName` | `string` | The name on the test card; see above. |
| `busy` | `boolean` | A request is in flight. |
| `error` | `boolean` | The last request failed. |
| `onPay` | `() => void` | Required. |
| `onCancel` | `() => void` | Required. |
