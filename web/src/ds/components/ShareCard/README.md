# ShareCard

`ShareCard` is the card an owner prints and puts where customers already look: the business, the QR code for its Desk's link, the link written out, and who answers there.

## When to use

- On Share and in the setup interview's live step, beside the ready-made words (`CopyList`).
- Not for the owner's own link with Copy link and Open, which is the web app's `CopyLink`.

## What the consumer provides

- `name`: `business_name`; `url`: the Desk's public link as people type it ("desk.example/rivera"); `ownerName`: `owner_display_name`. All three are shown as written.
- `qr`: the QR code for the link, which the web app draws (`QrCode`, plan 04). It fills a 152 px square, centered. The card never makes, fetches or checks a code. A QR code needs its own light quiet zone to scan, which the web app's code draws; nothing else in the design system is light, so that ground stays inside the code.
- `language`: the language the card is printed in.
- `onPrint` to show "Print card" under the card. The screen prints; nothing here does.

## What it shows

- A card 300 px wide (at most its column), in the card look (`fill-card`, a `line-card` border at `radius-card`), padded 20 px, everything centered and 12 px apart: the name in `section` type, the QR code's square, the link in `control` type, and who answers in `meta`, `text-secondary`.
- Who answers is the AI disclosure, which every printed card carries and which can't be left off: "Answered by Claude, an AI. Ask for {owner} any time." / "Responde Claude, una IA. Puedes pedir hablar con {owner} cuando quieras."
- "Print card", a secondary `main` button, 12 px under the card at its left, when `onPrint` is given. Its words are the owner's, in English.
- On a phone (below 768 px of window width) the card takes the whole column and Print card sits centered under it, as N-Run2-Share-Phone draws them.

## Accessibility

- The card is a `figure` named by the business, with who answers as its caption, and `lang` set to its language.
- The QR code is the screen's to name ("QR code for desk.example/rivera"); the link is written out under it, so nobody needs to scan it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. The business. |
| `url` | `string` | Required. The link as people type it. |
| `ownerName` | `string` | Required. Whom a customer can ask for. |
| `language` | `'en' \| 'es'` | Required. The printed card's language. |
| `qr` | `ReactNode` | Required. The web app's QR code. |
| `onPrint` | `() => void` | Shows Print card. |
