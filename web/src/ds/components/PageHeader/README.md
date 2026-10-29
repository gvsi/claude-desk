# PageHeader

`PageHeader` is the top of an owner page: its title in serif, left-aligned, an optional subtitle and the page's actions at the right.

## When to use

- At the top of every owner page except Today, whose `Greeting` is its title: "Rules", "Safety", "Settings".
- Not for sections inside a page: those are `SectionHeader`, in sans.

## What the consumer provides

- `title`, in sentence case. It is the page's one `h1`.
- `subtitle`, one plain line that says what the page is for. Leave it out when the title says enough.
- `actions`, usually one `Button` (secondary, or primary when it is the page's main action). They sit at the right end of the title's line and wrap under the title on a narrow line.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required. `.cd-type-page-title` (serif, 24/32) in `text-primary`. |
| `subtitle` | `ReactNode` | `.cd-type-body` in `text-secondary`, under the title. |
| `actions` | `ReactNode` | At the right of the title's line. |

The header has no outer margin; the `AppShell` pads the page above it, and the page spaces what follows.
