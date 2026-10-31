# VisionBar

`VisionBar` is the line across the top of every vision page, saying the page is vision and nothing on it is live.

## When to use

- Once, at the very top of each vision page: the city office, the team Desk, the Claude account and the phone (N-R2-Vision-CityOffice, -TeamDesk, -ClaudeAccount, -Phone).
- Not on Settings › Channels: the app's Channels page follows N-Run2-Settings-Channels, with no bar. N-R2-Vision-Channels, the same page under the bar, is a vision story only (`Boards/Vision, channels`).
- Over an owner page, pass it as `AppShell`'s `banner`, so it runs the window's width above the sidebar and the page. Over a public page or a page of its own, put it first, above everything else.
- Not for a Settings section the prototype only sketches (Notifications, Billing): those open with the vision note inside the page (`Pill` README, "A vision note").

## What it shows

- A `role="note"` named "Vision": the `Pill` "Vision", then "Vision, not in the prototype. Nothing here is live." (`VISION_LINE`), word for word as the boards write it, then the `TextLink` "Back to your Desk" at the right.
- The words are fixed: no prop changes them or hides the bar, so a vision page always says what it is.
- It holds one tab stop, the link.

## What the consumer provides

- `backHref`, where "Back to your Desk" goes: the owner's Today on the Desk they came from.

## Layout

- 40 px tall (`size-control-main`) on `bg-panel`, a `line-hairline` under it, padded 24 px at the sides; the pill, the line `space-12` after it in `meta` and `text-secondary`, and the link at the right edge in `meta`.
- Under 640 px of window width the gutters are 16 px, the line wraps beside the pill, and the link drops under it at the left; the bar grows with them, so nothing is clipped and nothing scrolls sideways.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `backHref` | `string` | Required. "Back to your Desk". |

Also exported: `VISION_LINE`, the line's words.
