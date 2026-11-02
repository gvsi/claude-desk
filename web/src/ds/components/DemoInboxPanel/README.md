# DemoInboxPanel

`DemoInboxPanel` is where the demo's verification codes and alerts arrive, standing in for a phone or email inbox.

## When to use

- Beside a visitor's chat, with `viewer="visitor"`, so they can read the code the Desk sent to the contact on record.
- In the owner's Demo inbox, with `viewer="owner"`, for codes, alerts and ledger checkpoints across the demo copy.
- Not for chat messages or checkpoint results. Those are messages and margin receipts.

## What it shows

- On `bg-panel`: the title "Demo inbox" (a level-2 heading that names the panel's region) and "Stands in for a phone or email inbox. Nothing is really sent." For the owner the line under the title is "What Claude would have sent you by text or email. Nothing is really sent."
- With `action`, a control at the right of the title's line, centered on it: the sheet's "Close" (`DemoInboxSheet`).
- The entries, newest first, each in a quiet box: who it went to ("To •••• 0142"), and for the owner only the time the screen passes in, at the right of that line. Then:

| Item | Shows |
| --- | --- |
| `entry` with the notice's `entry_id` | The kind ("Verification code", "Alert" or "Ledger checkpoint") and `entry.body` word for word, which may hold a code. A ledger checkpoint's body reads in the trace's monospace. |
| `viewer="owner"`, `language="en"` and an opened `entry` with a `title` | The `title` in the kind's place: the kernel gives one only to an alert to the owner, its fixed preview line ("Urgent callback requested", "A request needs your answer"). A `title` that is missing, `null` or blank reads as the kind, "Alert". The titles are English only, so the owner's panel in Spanish shows the kind, "Aviso", and a visitor's panel always shows the kind. |
| `viewer="owner"`, an opened `alert` and a `requestHref` | Also "Open the request" under the body, a `TextLink` to the held request the alert is about, as N-R2-Inbox-Sheet-Owner draws it. A code or a checkpoint never shows it. |
| `entry: null`, not failed | The notice's `preview` and a waiting `Notice` "Opening" (`role="status"`). Never a code. |
| `failed`, or an `entry` with another `entry_id` | The `preview`, an error `Notice` "Couldn’t open this entry." and "Try again", which calls `onRetry(entry_id)`. An entry fetched for another notice never shows under this one. |
| `viewer="visitor"` and a notice to `owner` | Nothing, whether its entry is opening, failed to open or open. |
| `viewer="visitor"` and its own `entry` of any kind but `verification_code`, or one the kernel addressed to `owner` | Nothing. |
| `viewer="visitor"`, its own entry not yet fetched, and a recipient that isn't clearly a contact (blank, or the owner's word written another way) | Nothing, until the fetched entry proves it is a verification code. |

- A visitor never sees the owner's alerts or checkpoints, whatever `items` the screen passes in: before its own entry arrives, a row shows (opening or failed to open) only for a notice to a masked contact on record, the legitimate state of a code on its way.
- Each entry shows once. Replaying events after a reconnect can append a notice the screen already holds, so the panel keeps only the item that arrived last for each `entry_id`, in that item's place, before it decides what a visitor may see. An earlier copy never shows, even when the latest one doesn't.
- With nothing to show: "Nothing here yet. Codes and alerts you’d get by text or email show up here."
- No time ever shows on a visitor's panel, even when an item carries one, no request link and no entry's `title` either.

## Accessibility

- The panel is a `section` named by its title, with `lang` set to `language`.
- The entries, or the empty line, sit in an `aria-live="polite"` region that is always there, so a notice that arrives later is read out, and so is its entry once fetched. The title and subtitle are outside it and are read once.

## What the consumer provides

- `items` in the order they arrived, oldest first: append each `EvDemoInbox` notice as it comes, with `entry: null`. The panel puts the newest at the top, and shows a notice appended twice once, as its later item.
- The entry for each notice, fetched through the API's Demo inbox route when the notice arrives. Codes come only from those fetched entries, never from a notice. On failure set `failed`; `onRetry` should fetch it again.
- `time` for the owner's panel only, as a display string the screen formats ("2:14 pm"). The panel formats nothing.
- The entry's `title` as the API sends it. The panel draws only the owner's titles, on an English panel, and never builds one from a body or a notice.
- `requestHref` for the owner's alerts only: where the owner app opens the held request, built from the entry's `decision_id` (the kernel sets it only on the owner's alert for a held request, and sends `null` on every other entry), as an in-app path such as `/app/<desk>/today#request-<encodeURIComponent(decision_id)>`, never text taken from an entry. The stories build a place on the page, `#request-<encodeURIComponent(decision_id)>`, with `requestHrefOf` from the fixtures. Only a place on the page (`#…`) or a path in the app (`/…` that a browser resolves to the same site, so not `//…` or `/\…`) draws a link. Without one an alert shows no link.
- On arrival the screen brings the held request's card into view and moves focus to it, as Things to try's "Open the request" does. In the sheet, following the link closes it first, which returns focus to the sheet's button, so the screen moves focus once the sheet has closed.
- `language`: the visitor's language, or the owner's.

## Copy (`inboxCopy.ts`)

| | English | Spanish |
| --- | --- | --- |
| Title | Demo inbox | Bandeja de demostración |
| Subtitle | Stands in for a phone or email inbox. Nothing is really sent. | Hace de bandeja de teléfono o correo. No se envía nada de verdad. |
| Owner's subtitle | What Claude would have sent you by text or email. Nothing is really sent. | Lo que Claude te habría enviado por mensaje o correo. No se envía nada de verdad. |
| Recipient | To {to} | Para {to} |
| Kinds (and an owner's alert without a title, or on a Spanish panel) | Verification code, Alert, Ledger checkpoint | Código de verificación, Aviso, Punto de control del registro |
| Opening | Opening | Abriendo |
| Open failed | Couldn’t open this entry. | No se pudo abrir esta entrada. |
| Retry | Try again | Intentar de nuevo |
| Request link | Open the request | Abrir la solicitud |
| Empty | Nothing here yet. Codes and alerts you’d get by text or email show up here. | Aún no hay nada. Aquí aparecen los códigos y avisos que recibirías por mensaje o correo. |

## Layout

- The panel fills the width it is given, padded 24 px top and bottom and 16 px at the sides, with 10 px between the title, the subtitle, the screen's notice and the entries. The screen places it, as a column beside the chat or in a sheet, and draws any edge it needs.
- The title is `section` type, the subtitle and the empty line `meta` in `text-secondary`.
- Each entry is padded 12 px by 14 px on `fill-card`, in a 1 px `line-card` border at `radius-card`, 10 px apart. The recipient line is `caption` in `text-secondary`, the kind (or an owner's alert's title) `meta` at weight 520 4 px under it, and the body `body` type 2 px under that. An owner's alert puts "Open the request" in `meta` type 8 px under the body. Long words and hashes wrap.
- Nothing moves.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `viewer` | `'owner' \| 'visitor'` | Required. A visitor sees only verification codes and no times. |
| `items` | `DemoInboxItem[]` | Required. Oldest first. |
| `language` | `'en' \| 'es'` | Required. |
| `onRetry` | `(entryId: string) => void` | Required. |
| `action` | `ReactNode` | A control at the right of the title's line. |
| `titleFocusable` | `boolean` | The title takes focus from a script (`tabIndex={-1}`), as `DemoInboxSheet` moves it there when it opens itself. |
| `notice` | `ReactNode` | A line under the subtitle and above the entries, such as a `Notice` that the latest read failed. It is drawn as given, to either viewer, so it holds only the screen's own words about the inbox, never text from an entry or an `InboxNotice`. |

`shownItems(viewer, items)`, exported beside the panel, gives the items the panel would show, newest first and one per entry; `DemoInboxSheet` counts them.

`DemoInboxItem` is `{ notice: InboxNotice; time?: string; entry: DemoInboxEntry | null; failed?: boolean; requestHref?: string }`.
