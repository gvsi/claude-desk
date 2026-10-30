# Reference boards

The design system is checked against the design canvas boards the project owner signed off, listed once each in `REFERENCE_BOARDS` (`boards.ts`). Every story names its board in `parameters.canvas`, or says `'none'` with a `canvasNote` naming the nearest board, and the project's story hooks fail a story that doesn't.

## How a board is checked

- **A board story.** Each board is rebuilt by one `Boards/*` story in `web/src/ds/boards/`, from the components and the fixtures. What no component draws, because the web app (plan 04) owns that page's layout, is composed beside the stories in `boards/parts.tsx` and `boards/boards.css`, on the tokens. Each story's `canvasNote` lists what differs from its board.
- **Its play.** It asserts the board spec below with `expectComputed`, checks that receipts sit 8 px under their message on its side, and walks the page with Tab (`focus_order_is_logical`). The spec rows are `boards/spec.ts`; a row that differs between boards is one row per board.
- **By eye, and by the pixel.** Each story is compared with its board's render at 1280×820, where the values the spec asserts are also read off the render (colors, edges and spacing, pixel for pixel), then checked at 1440×900 and 390×844 for sideways scroll and clipped text, with a keyboard walk that shows the 2 px blue ring at every stop. A value the render shows is the one the story matches; only content, and the decisions signed after a board, may differ from it.
- **The renders stay out of the repository.** They are rendered from the canvas to a folder on the checking machine. `boards.test.ts` checks there is one per board, 1280×820, when `DS_REFERENCE_DIR` names that folder, and skips otherwise:

```sh
cd web
DS_REFERENCE_DIR=/path/to/reference npx vitest run --project unit src/ds/reference
npx vitest run --project storybook src/ds/boards
```

## Board spec

| Element | Expected |
|---|---|
| Sidebar (Today, Safety, the switcher, the take-over) | width 264px; background `rgb(34, 34, 32)`; right border 1px `rgba(250, 249, 245, 0.12)` |
| Sidebar (the conversation boards, N-Conv-Run1 and N-Conv-Agent-Run1) | width 264px; background `rgb(28, 27, 25)`, the app ground; no right border; at its own height, its Answering switch 4px under the pages |
| Active nav row | height 36px; background `rgb(60, 57, 47)`; radius 8px; 14px/20px weight 420 |
| Page title / greeting | Source Serif 4, 24px/32px weight 460 / 36px/44px weight 300 |
| Today's figures (N-Today-Run1) | the booked total in `figure`, Hanken Grotesk 32px/40px weight 500, -0.3px; the stopped count in `figure-small`, 24px/32px weight 420; both tabular |
| Content column | max-width 960px; main padding 24px 40px 20px; on the conversation pages, the page fills the main area (below) |
| Claude's reply | Source Serif 4, 15px/23px weight 360, color `rgba(250, 249, 245, 0.92)` |
| Visitor bubble | background `rgba(250, 249, 245, 0.06)`; radius 12px; padding 8px 14px; 15px/21px |
| Receipt under its message | attached 8px directly under the message it belongs to, at every width (no margin column), on its side: starting at the message's left edge, or ending at a visitor's or an agent's bubble's right edge; 12px/17px, color `rgba(250, 249, 245, 0.64)`; dot 6px |
| Card | background `rgba(250, 249, 245, 0.03)`; border 1px `rgba(250, 249, 245, 0.14)`; radius 12px; padding 20px, or as the board draws a compact card: 16px for Today's things to try, 12px 16px for an agent's signed limit |
| Secondary button (main) | height 40px; radius 8px; background `rgba(250, 249, 245, 0.1)`; 14px/20px weight 420 |
| Primary button | background `rgb(239, 236, 228)`; color `rgb(28, 27, 25)` |
| Composer | background `rgb(42, 41, 39)`; radius 16px; shadow includes `0px 4px 20px` |
| Concept footer | the exact string, 12px/17px, color `rgba(250, 249, 245, 0.64)` |
| Brand header (public page) | 76px high; padding 12px 40px, or 12px 16px below 720px of page width (each state of the handoff board is 640px) |

### Where the signed renders differ from the plan

The owner signed these boards on 2026-10-29, after the design system screens plan set the spec, so where a render differs, the render's value is the one asserted.

| Row | Plan | Signed render | Why |
|---|---|---|---|
| Content column | Every owner page padded 24px 40px 20px, its content at most 960px wide | The two Run 1 conversation pages fill the main area: no padding and no content width, the conversation list starting where the sidebar ends | N-Conv-Run1 and N-Conv-Agent-Run1 draw the list column beside the sidebar and the conversation beside it. `AppShell` gained `fill` for a page with its own columns; it changes only the main area. The earlier take-over board keeps the padded page. |
| Sidebar | `rgb(34, 34, 32)` with a 1px seam, on every board | On the two Run 1 conversation boards, `rgb(28, 27, 25)` with no seam, at the sidebar's own height (its Answering switch at y 386, under the pages); on Today, Safety, the switcher and the take-over, the panel and the seam | Read off each render. `AppShell`'s `sidebarLook="ground"` draws the conversation boards' sidebar that way, apart from `fill`; the other boards keep the panel. Which look the app uses on every page is the project owner's decision, as the sidebar stays on every page. |
| Card | Padding 20px | 16px for Today's things to try; 12px 16px for the agent's signed limit, 10px under the conversation's head | Both boards draw those cards compact. Today's is `Card`'s compact padding; the signed limit is composed on the card's tokens, as no `Card` padding is 12px. |
| Public page gutters | 40px at the sides from 640px of page width up | 16px below 720px: each state of the handoff board is a whole page 640px wide with 16px gutters and the open status at the right of the name | Read off N-Public-Handoff-Run1. `PublicShell` now takes 16px gutters below 720px, and wraps the open status under the name only below 640px, as the open-status board draws a phone; at 760px and up (the open-status board's desktop header, the public page) it keeps 40px. |
| Brand header | Padding 0px 40px | 12px 40px, still 76px high when its content fits on one line | The signed open-status board grows the header by that padding when a closed status takes two lines or a phone wraps it under the name; on one line it reads the same. |
| Focus order on Today | The switcher, the nav, then the composer, then the first approval answer after the chips | The reviewer bar, the switcher, the nav, Answering, the public link, the things to try, then the first approval answer | Today has no "Ask Claude" composer: N-Today-Run1 signs that asking Claude to change a rule happens on Rules. |

### The sidebar's eighth page

The project owner signed Connectors as its own page on 2026-10-29, after the owner boards above. Each of them draws seven pages in the sidebar; every story draws eight, Connectors after Rules with its plug icon, as the Connectors boards (N-Conn-23-Connectors, N-Conn-17-Presets) draw it. The rows keep the boards' 36px height and 2px gap, so on the two Run 1 conversation boards the Answering switch still sits 4px under the pages, 38px lower than the render's y 386. This applies to every owner board, so the board stories' notes don't repeat it.

### Where a story keeps a value the signed render doesn't draw

An accessibility requirement wins over a render. Each value below is asserted as the story draws it, and the board story's `canvasNote` names both.

| Row | Signed render | Story | Why |
|---|---|---|---|
| The verification code field (N-Public-Verify-Run1) | 1px `rgba(250, 249, 245, 0.22)`, `line-control`, 2.0:1 against the page | 1px `rgba(250, 249, 245, 0.36)`, `line-field`, 3.2:1, the same on hover | An empty field has no words of its own to say what it is, so its outline is its boundary and needs 3:1 (WCAG 1.4.11). `line-control` is kept for controls whose own words name them, and every other text field uses `line-field`. |

## Boards

One line per board: its story, when it was checked, at which viewports, the deltas fixed and the differences kept.

| Board | Story | Checked | Viewports | Deltas fixed | Kept, and why |
|---|---|---|---|---|---|
| N-Today-Run1 | Boards/Today, needs you | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The public link takes the board's short form, so it sits beside the greeting; the bookings chart sits 12px under its line. | The held quote shows two plain answers and no Deny always, since a limit held it (N-Answers-TwoButtons); the reviewer's first visit is this board, not a story of its own; the board's pins are canvas notes. |
| N-Today-Empty-Run1 | Boards/Today, fresh copy | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | As on Today. | "A quiet night" is `EmptyState` in a `Card`. |
| N-Conv-Run1 | Boards/Conversation, live | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The page fills the main area (`AppShell` `fill`) and the sidebar sits on the app ground with no seam at its own height (`sidebarLook="ground"`), matching the render pixel for pixel; the head sits 16px over the captions, the visitor's name in the section style; only the booking's receipt draws the check. | The fixture's chat with Dana, not the board's water heater and its held discount; the typing bubble where the board writes a line, signed after it. |
| N-Conv-Agent-Run1 | Boards/Conversation, agent | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | As on the live conversation; the signed limit is padded 12px 16px, 10px under the head, matching the render pixel for pixel. | The limit says "for an hour" where the board writes the time it ends; the fixture's two requests, where the board has four. |
| N-Intro-D | Boards/First visit, intro | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | None. | Behind the dialog is the signed Today, without its reviewer bar, where the board shows an earlier Today with a composer. |
| N-Typing-Bubble-Run1 | Boards/Typing | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The panels take the board's widths (720px, the phone's 390px and 520px) and paddings. | The board's title, description and "How it behaves" are sign-off notes and stay in the canvas, so the panels start at the sheet's top; the reduced-motion panel isn't repeated, as the design system's browser tests render every story under reduced motion; the phone panel is taller where the fixture's words wrap. |
| N-Typing-Owner-Busy | Boards/Owner typing and busy | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | Three panels to a row at the board's widths (380px, 380px, 376px, 32px apart) and the phone's 390px. | Busy buttons show the spinner signed later the same day, not the board's three dots; no red busy row, since the guards keep the red look to an approval card's Deny; the sign-off notes stay in the canvas. |
| N-Answers-TwoButtons | Boards/Approval answers | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | Cards sit in their panels without a second frame, 588px wide and 24px apart, as on the board. | Only the signed option, menu buttons, on three held requests; the board's earlier rows and other explorations stay in the canvas. |
| N-Public-Rivera-Run1 | Boards/Public page, booked | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard; the Spanish page at 390×844 | None. | The fixture's chat with Dana up to the booking, where the board ends with a held discount; each action's line comes before the reply check; the about column holds the whole charter, five cards where the board shows three. |
| N-Public-Handoff-Run1 | Boards/Ask for Maria | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | Each state is the board's 640px and the window's height, with 16px gutters (`PublicShell` below 720px), its composer and its own footer at its foot, and the divider opaque over the headers, matching the render pixel for pixel. | Each state is the public page embedded, since one document can't hold two pages' landmarks, its footer passed under its composer; the board labels the states in their headers. |
| N-Conv-TakeOver | Boards/Conversation, taken over | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The board's own page: the title with the day's count, today's conversations across the top, the head across the page and the messages in the reading column, within 3px of the render; Maria's own messages read "You" beside her MR initials (`PersonMessage` `initials`). | Receipts sit under each message, signed after this board, where it draws a margin column; Hand back to Claude sits above the composer, where `TakeOverBar` places it; "Claude suggests", "Lucía saw:" and the translated composer line are static vision; the fixture's chat. |
| N-Public-Verify-Run1 | Boards/Confirm it’s you | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | Each page is the window's height with its composer and its own footer at its foot, matching the render pixel for pixel; the play types the code, so Confirm is ready as on the board. | Both pages are embedded, their footers passed under their composers; the inbox entry is the kernel's longer code message; no "Verification started" receipt, which the fixture doesn't carry; the code field's outline is `line-field`, 3:1, where the board draws it fainter (above). |
| N-Safety-Run1 | Boards/Safety | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The held request's dot keeps its gap (`StatusLabel` in the button); the chain check's bar sits 20px under the title; the disclosures use the board's chevrons; the kinds are one radio group, one tab stop with the arrow keys (`Chip`). | The board's open questions are canvas notes. |
| N-Safety-Record-Run1 | Boards/Safety, full record | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The open row's corners are rounded, as on the board. | The ledger is the fixture's three entries with the held quote's decision open, where the board lists entries 48 to 39 and opens a refused refund. |
| N-Switcher-Run1 | Boards/Switcher | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | None. | Behind the menu is the signed Today, where the board shows Today from before that sign-off; where the web app anchors the menu is its own. |
