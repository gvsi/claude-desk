# Reference boards

The design system is checked against the design canvas boards the project owner signed off, listed once each in `REFERENCE_BOARDS` (`boards.ts`). Every story names its board in `parameters.canvas`, or says `'none'` with a `canvasNote` naming the nearest board, and the project's story hooks fail a story that doesn't.

## How a board is checked

- **A board story.** Each board is rebuilt by one `Boards/*` story in `web/src/ds/boards/`, from the components and the fixtures. What no component draws, because the web app (plan 04) owns that page's layout, is composed beside the stories in `boards/parts.tsx` and `boards/boards.css`, on the tokens. Each story's `canvasNote` lists what differs from its board.
- **Its play.** It asserts the board spec below with `expectComputed`, checks that receipts sit 8 px under their message on its side, and walks the page with Tab (`focus_order_is_logical`). The spec rows are `boards/spec.ts`.
- **By eye.** Each story is compared with its board's render at 1280×820, then checked at 1440×900 and 390×844 for sideways scroll and clipped text, with a keyboard walk that shows the 2 px blue ring at every stop.
- **The renders stay out of the repository.** They are rendered from the canvas to a folder on the checking machine. `boards.test.ts` checks there is one per board, 1280×820, when `DS_REFERENCE_DIR` names that folder, and skips otherwise:

```sh
cd web
DS_REFERENCE_DIR=/path/to/reference npx vitest run --project unit src/ds/reference
npx vitest run --project storybook src/ds/boards
```

## Board spec

| Element | Expected |
|---|---|
| Sidebar | width 264px; background `rgb(34, 34, 32)`; right border 1px `rgba(250, 249, 245, 0.12)` |
| Active nav row | height 36px; background `rgb(60, 57, 47)`; radius 8px; 14px/20px weight 420 |
| Page title / greeting | Source Serif 4, 24px/32px weight 460 / 36px/44px weight 300 |
| Content column | max-width 960px; main padding 24px 40px 20px; on the conversation pages, the page fills the main area (below) |
| Claude's reply | Source Serif 4, 15px/23px weight 360, color `rgba(250, 249, 245, 0.92)` |
| Visitor bubble | background `rgba(250, 249, 245, 0.06)`; radius 12px; padding 8px 14px; 15px/21px |
| Receipt under its message | attached 8px directly under the message it belongs to, at every width (no margin column), on its side: starting at the message's left edge, or ending at a visitor's or an agent's bubble's right edge; 12px/17px, color `rgba(250, 249, 245, 0.64)`; dot 6px |
| Card | background `rgba(250, 249, 245, 0.03)`; border 1px `rgba(250, 249, 245, 0.14)`; radius 12px; padding 20px, or 16px where the board draws a compact card |
| Secondary button (main) | height 40px; radius 8px; background `rgba(250, 249, 245, 0.1)`; 14px/20px weight 420 |
| Primary button | background `rgb(239, 236, 228)`; color `rgb(28, 27, 25)` |
| Composer | background `rgb(42, 41, 39)`; radius 16px; shadow includes `0px 4px 20px` |
| Concept footer | the exact string, 12px/17px, color `rgba(250, 249, 245, 0.64)` |

### Where the signed renders differ from the plan

The owner signed these boards on 2026-10-29, after the design system screens plan set the spec, so where a render differs, the render's value is the one asserted.

| Row | Plan | Signed render | Why |
|---|---|---|---|
| Content column | Every owner page padded 24px 40px 20px, its content at most 960px wide | The conversation pages fill the main area: no padding and no content width, the conversation list starting at the sidebar's seam | N-Conv-Run1 and N-Conv-Agent-Run1 draw the list column flush with the sidebar and the conversation beside it. `AppShell` gained `fill` for a page with its own columns. |
| Card | Padding 20px | 16px for Today's things to try and the agent's signed limit | Both boards draw those cards compact; 16px is `Card`'s compact padding. |
| Focus order on Today | The switcher, the nav, then the composer, then the first approval answer after the chips | The reviewer bar, the switcher, the nav, Answering, the public link, the things to try, then the first approval answer | Today has no "Ask Claude" composer: N-Today-Run1 signs that asking Claude to change a rule happens on Rules. |

## Boards

One line per board: its story, when it was checked, at which viewports, the deltas fixed and the differences kept.

| Board | Story | Checked | Viewports | Deltas fixed | Kept, and why |
|---|---|---|---|---|---|
| N-Today-Run1 | Boards/Today, needs you | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The public link takes the board's short form, so it sits beside the greeting; the bookings chart sits 12px under its line. | The held quote shows two plain answers and no Deny always, since a limit held it (N-Answers-TwoButtons); the reviewer's first visit is this board, not a story of its own; the board's pins are canvas notes. |
| N-Today-Empty-Run1 | Boards/Today, fresh copy | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | As on Today. | "A quiet night" is `EmptyState` in a `Card`. |
| N-Conv-Run1 | Boards/Conversation, live | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | The page fills the main area (`AppShell` `fill`), so the list starts at the sidebar's seam; the head sits 16px over the captions; only the booking's receipt draws the check. | The fixture's chat with Dana, not the board's water heater and its held discount; the typing bubble where the board writes a line; the board is drawn 1780px tall, so its sidebar's foot sits under the nav, where a window's runs to the window's foot. |
| N-Conv-Agent-Run1 | Boards/Conversation, agent | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | As on the live conversation. | The signed limit is a compact `Card`, 16px all round where the board pads it 12px top and bottom, and says "for an hour" where the board writes the time it ends; the fixture's two requests, where the board has four. |
| N-Intro-D | Boards/First visit, intro | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | None. | Behind the dialog is the signed Today, without its reviewer bar, where the board shows an earlier Today with a composer. |
| N-Typing-Bubble-Run1 | Boards/Typing | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | None. | The board's title, description and "How it behaves" are sign-off notes and stay in the canvas; the reduced-motion panel isn't repeated, as the design system's browser tests render every story under reduced motion. |
| N-Typing-Owner-Busy | Boards/Owner typing and busy | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | None. | Busy buttons show the spinner signed later the same day, not the board's three dots; no red busy row, since only an approval card's Deny is red; panels two to a row. |
| N-Answers-TwoButtons | Boards/Approval answers | 2026-10-29 | 1280×820, 1440×900, 390×844, keyboard | Cards sit in their panels without a second frame. | Only the signed option, menu buttons, on three held requests; the board's earlier rows and other explorations stay in the canvas. |
