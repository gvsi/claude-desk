# FactCard

`FactCard` shows one fact on a vision page as a typed card: its label beside a small icon, then the fact and its lines, each exactly as given.

## When to use

- For every price, date, time, status or record a vision page shows that no reply card template covers (N-R2-Vision-TeamDesk, -CityOffice-Resident): "Calendar hold" (the held date and time), "Document, open to colleagues", and a resident's "Permit status" (with the fee due) and "Next steps". The city office's code prompt, open inspection times and about cards are drawn with `ReplyCard` under their templates' labels instead, though some of their lines are a vision of what those templates could carry (the board story's note names each).
- Not for a booking: a booking is the kernel's `booking_confirmed` card through `ClaudeMessage` and `ReplyCard`, labelled "Booked", even on a vision page (the phone's visit and Dana's last visit).
- On a vision page, as on every Desk, Claude's words never state a price, date or status and never confirm a booking on their own: the reply leads into the card ("Here it is."), and the card carries the fact. A booking is confirmed only next to its card.
- Not in a real conversation. There, every fact reaches the visitor as the kernel's rendered block in a `ReplyCard`, whose label comes from its template. `FactCard` is for the static vision pages, whose facts are sample data with labels no template has.
- Only the vision pages may use it. In the design system the guard `fact_card_only_on_the_vision_pages` allows it only in its own folder, the index and the vision boards' page parts (`boards/vision.tsx`). The web app's guard should likewise allow it only under `web/src/vision/` (the web app plan's vision pages, plan 04).

## What the card shows

- An `article` named by `label`, so a screen reader says what kind of fact it is.
- The top line: the 14 px `icon` (`aria-hidden`) and `label`, in a secondary `caption`.
- `title`, 6 px under it, in `body` type at weight 520 in primary ink.
- Each of `lines`, 2 px under the last, in secondary `meta`. Empty lines are left out.
- Nothing is computed or formatted: no date tile, no price column, no link and no button. The card shows its props as they arrive, so a fact reads the same wherever its data comes from.

## What the consumer provides

- `label`: what kind of fact it is, in the page's language.
- `icon`: `document` for a record or a document, `clock` for a deadline or a booked time.
- `title` and `lines`: the fact, already written out in the page's language ("Thursday, November 5, 2:00 pm", "30 minutes with Sam Patel: launch review"). The page's data holds them as typed fields, never as part of Claude's sentences.
- `language`: `es` for a fact in Spanish; it sets `lang` on the card.

## Layout

- A `Card` at most 420 px wide and never wider than its column, padded 12 px 14 px (`space-12`, `space-14`), as the vision boards draw it. On a phone's 358 px line it takes the line's width, and long words wrap.
- It never sits inside another card: in a list of conversations, it sits in the conversation's row, which is a list row, not a `Card`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The top line and the card's name. |
| `icon` | `IconName` | Required. Drawn at 14 px. |
| `title` | `string` | Required. Shown as given. |
| `lines` | `readonly string[]` | Shown as given, in order; empty ones are left out. |
| `language` | `'en' \| 'es'` | `en` by default; set as `lang`. |
