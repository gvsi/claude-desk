# AlwaysOnList

`AlwaysOnList` shows the always-on rules, the baseline every Desk enforces whatever is connected, with no way to change them.

## When to use

- At the end of the Rules page, after the connectors (N-Conn-12-Chat; the first Rules boards it was drawn on, N-Conn-01-Rules and N-Conn-16-Phone-Rules, are archived), and wherever the owner needs to see what can't be turned off.

## What it shows

- A `section` named by its heading: a `SectionHeader` "Always on" (an `h2`, or `h3` with `level={3}`) with the caption "On every Desk, whatever is connected. They can't be turned off.", which drops under the title on a narrow line.
- Then one line each, in `.cd-type-body` beside a 14 px `lock` (`aria-hidden`, `text-secondary`):
  - "Always says it's an AI"
  - "Private data only to its verified owner"
  - "Codes only go to the contact on record"
  - "No money moves without your rule or a signed limit"
  - "Every attempt is logged and shown to you"
- No buttons, switches, links or inputs. These words are the owner's view of the baseline the kernel enforces (`cedar/baseline.cedar` and the invariants), so they are fixed copy, not data.
- `ALWAYS_ON` exports the rules' words, so a page's skeleton (setup's draft) can measure the lines they take in the current fonts without drawing them.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `level` | `2 \| 3` | The heading's level; `2` by default. |
