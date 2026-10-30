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
| N-Conn-17-Mode | Rules/HowClaudeWorks, `Custom` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | The hairline sits 14px under the caption with the money limit 14px under it, as the board draws them, where the card had 16px; the card now matches the render pixel for pixel. | Only the card: the Rules page around it is the web app's. |
| N-Conn-18-Mode-Review | Rules/ChangeReview, `SwitchToAskMeFirst` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the checks card, the line about cancelled payment links and the buttons sit as on the board, 62px from the checks card to the buttons. | Rivera's eight own rules, without the board's ninth row, the illustrative shared rule that isn't in Rivera's seed. Each side keeps `ChangeReview`'s layout (its label above, the words before the reason, a rule at its left, "Changed" after the outcome in an outline), since this review uses the component as it is; the board sets the label in a column, the reason first and "Changed" in plain words before the outcome. Straight apostrophes, as in all the repository's copy. The breadcrumb and page header are the web app's. |
| N-Conn-19-Money-Cap | Rules/HowClaudeWorks, `EditingLimit` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the card matches the render pixel for pixel. | None. |
| N-Conn-20-Money-Cap-Review | Rules/LimitChange, `Raise`, above Rules/ChangeReview, `LimitOnly` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the card's size and padding and the old amount's place match the render. | The new limit is 7px narrower: the board sets it at the serif's optical size 18, and the summary style is optical size 20 on every summary line (a held request's card, the changed-tool review). `LimitOnly` keeps its own checks line. |
| N-Conn-21-Simulate | Connectors/ToolPageHeader, `WithSimulate` | 2026-10-29 | 1512×982 against the render, 1440×900, 390×844, keyboard | None: the strip's border, padding, caption and button match the render pixel for pixel. | Straight apostrophes. The source line's Mock badge sits 3px left of the board's; that line is the header's own, checked with N-Conn-05-Refund. |
| N-Conn-22-Phone-Mode | Rules/HowClaudeWorks, `Phone` | 2026-10-29 | 390×844 against the render, 1440×900, keyboard | None: the card matches the render pixel for pixel, with no sideways scroll. | Only the card, as on N-Conn-17-Mode. |
