# PageHeader

`PageHeader` is the top of an owner page: its title in serif, left-aligned, an optional subtitle and the page's actions at the right.

## When to use

- At the top of every owner page except Today, whose `Greeting` is its title: "Rules", "Safety", "Settings".
- Not for sections inside a page: those are `SectionHeader`, in sans.

## What the consumer provides

- `title`, in sentence case. It is the page's one `h1`.
- `subtitle`, one plain line that says what the page is for. Leave it out when the title says enough.
- `note`, a quieter line under the subtitle that says what a term met on the page means, as All rules says who "the reviewer" is. Meta type in `text-secondary`, 8 px further down than the subtitle's gap, at most 68ch wide; on a phone it runs under the title at the header's full width, as the subtitle does.
- `actions`, usually one `Button` (secondary, or primary when it is the page's main action). They sit at the right end of the title's line and wrap under the title on a narrow line. On a phone (under 640 px) they stay on the title's line and the subtitle runs under both, 8 px under the title, as the phone Connectors board draws it (N-Conn-24-Phone-Connectors).
- `actionsBelowOnPhone`, for the Rules header's See all rules and preset menu: under 640 px the actions share a line, 16 px under the title (or its subtitle), at the header's full width. The consumer gives the link its own width and the preset button the rest of the line; the open menu spans the column (N-Conn-22-Phone-Presets).
- `hideSubtitleOnPhone`: under 640 px the subtitle isn't shown, as the phone presets board draws the Rules page.
- `titleRef`, where the page moves focus to its title after a control that had it goes away (setup's "Try again" after a lost start). The title then takes focus from a script (`tabIndex={-1}`) but is never a Tab stop.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required. `.cd-type-page-title` (serif, 24/32) in `text-primary`. Balanced when it wraps. |
| `subtitle` | `ReactNode` | `.cd-type-body` in `text-secondary`, under the title. |
| `note` | `ReactNode` | `.cd-type-meta` in `text-secondary`, under the subtitle, `margin-top` `space-8`, `max-width` 68ch. |
| `actions` | `ReactNode` | At the right of the title's line. |
| `actionsBelowOnPhone` | `boolean` | Under 640 px, the actions on a line of their own at full width. |
| `hideSubtitleOnPhone` | `boolean` | Under 640 px, no subtitle. |
| `titleRef` | `Ref<HTMLHeadingElement>` | The title's element, for moving focus to it; it then takes `tabIndex={-1}`. |

## Long titles

A title that wraps balances its lines (`text-wrap: balance`): the browser evens them out rather than filling each in turn, so a long business name doesn't leave its last word on a line of its own. "Bayview Heating, Plumbing & Drain Services of Greater Oakland is live" takes two even lines in setup's 720 px column, not a full line and "live". The title keeps the number of lines it would take anyway, so nothing under it moves. A word with no break in it still breaks rather than leaving the line (`overflow-wrap: anywhere`).

The header has no outer margin; the `AppShell` pads the page above it, and the page spaces what follows.

## Loading shapes

`PageHeaderSkeleton` draws the title's line box, subtitle lines and an optional control-sized action block using this header's classes. `subtitleLines` defaults to 1 and accepts a number or `{ wide, phone }`; phone applies below 640 px. `actions`, `actionsBelowOnPhone` and `hideSubtitleOnPhone` follow the real header's placement rules. Use it for full-page loads; in-app loads keep the real header. It draws no heading landmark or words, so the loading page supplies its own hidden heading outside the layer. Companion stories compare both action layouts within 2 px at 1512 and 390.

When the subtitle is known, pass `subtitle` instead of `subtitleLines`: its words are measured without drawing them, giving the text column its natural flex basis and the subtitle its actual line count, including on a phone. Pass `actions={true}` for the default control shape, or an action shape using `Skeleton.measure` to match the real control's width. Safety uses both so its held action wraps beneath its long subtitle at narrow desktop widths.
