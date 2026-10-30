# Reference boards

The design system is checked against the design canvas boards listed once each in `REFERENCE_BOARDS` (`boards.ts`); every story names its board in `parameters.canvas`, or says `'none'` with a `canvasNote` naming the nearest board, and the project's story hooks fail a story that doesn't.

## How a board is checked

- Each story is compared with its board's render, rendered from the canvas to a folder on the checking machine and kept out of the repository. The connectors boards render at 1512×982 (a phone board at 390×844), at full height.
- The comparison is by eye and by the pixel: the story's component and the same part of the render are cropped and compared pixel for pixel, and their edges and lines of text measured.
- Then each story is checked at 1440×900 and 390×844 for sideways scroll and clipped text, with a keyboard walk that shows the 2 px blue ring at every stop.
- A board that draws a whole page is checked through the components it is made of; the page around them is the web app's (plan 04). Each story's `canvasNote` lists what differs from its board.

## Boards

One line per board: its story, when it was checked, at which viewports, the deltas fixed and the differences kept.

| Board | Story | Checked | Viewports | Deltas fixed | Kept, and why |
|---|---|---|---|---|---|
| N-Conn-17-Presets | Rules/PresetMenu, `Open` (opened by keyboard for the check) | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the button (40px, secondary, its chevron), the menu (360px wide, 6px under the button, its right edge on the button's) and its items (55px and 72px) match the render. | The board draws the button's focus ring and its open fill together with the first item's hover fill; the story shows the state a keyboard leaves, the first item's own ring. Only the menu: the Rules page around it is the web app's. |
| N-Conn-18-Preset-Review | Rules/ChangeReview, `AskMeFirst` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | A built-in connector is named alone in a change row ("Quotes"), as the redrawn board does; the checks card, the line about cancelled payment links and the buttons sit as on the board, 62px from the checks card to the buttons. | The board's red Before and green After bars, its quieter Before outcome and its changed values at weight 520 come with the change review's own update for the signed connector boards. The rows are Rivera's eight own rules and Dana Whitfield's personal booking rule, which the board doesn't draw, without the board's illustrative shared rule. The breadcrumb and the page header, the preset's name, are the web app's. |
| N-Conn-19-Ceiling | Rules/MoneyLimit, `Reading` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the row, 57px with its hairline, matches the render pixel for pixel. | The group's head above it is a stand-in in the story; the Payments and Stripe groups are the web app's. |
| N-Conn-19b-Ceiling-Edit | Rules/MoneyLimit, `Editing` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the row, 163px with its hairline, matches the render pixel for pixel but for the text the story's play types into the field. | As on N-Conn-19-Ceiling. |
| N-Conn-20-Ceiling-Review | Rules/LimitChange, `Raise`, above Rules/ChangeReview, `LimitOnly` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the card's size and padding and the old amount's place match the render. | The new limit is about 2% narrower: the board sets it at the serif's optical size 18, and the summary style is optical size 20 on every summary line (a held request's card, the changed-tool review). `LimitOnly` keeps its own checks line. The page title and the breadcrumb are the web app's. |
| N-Conn-21-Simulate | Connectors/ToolPageHeader, `WithSimulate` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the strip's border, padding, caption and button match the render pixel for pixel. | Straight apostrophes, as in all the repository's copy. |
| N-Conn-22-Phone-Presets | Rules/PresetMenu, `Phone`; Rules/MoneyLimit, `Phone` | 2026-10-29 | 390×844 against the render, 1440×900, keyboard | None: the button fills its line with its words 14px in and the chevron at the right, and the payment limit's row, 107px with "Change" 10px under its words, matches the render pixel for pixel; no sideways scroll. | The board draws the button open and focused; the story shows it at rest. |
