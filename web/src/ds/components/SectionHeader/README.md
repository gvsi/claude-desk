# SectionHeader

`SectionHeader` names a section of a page in the interface's section style, with an optional count and a quiet caption at the right.

## When to use

- Above a group on a page: "Needs you" on Today, "What Claude can do here" on Rules.
- With `count` when the number matters at a glance ("2 things need you"). The count is a `CountPill`, never a colored badge.
- With `caption` for one line that puts the section in context ("Everything else overnight stayed inside your rules."). On a narrow screen the caption drops under the title, left-aligned.
- Not for page titles: those are `page-title` in serif (`PageHeader`).

## What the consumer provides

- `title`, in sentence case. A title wider than the line wraps inside it, and a word with no break in it (an address, a long name) breaks rather than leaving the line.
- `level`, so the headings nest under the page's `h1`: `2` by default, `3` for a section inside a section.
- `id` when the section is `aria-labelledby` its heading.
- `count` as `{ n, label }`: the number shown and the words read instead of it, with the number in them.
- `caption`, a plain sentence.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required. `.cd-type-section` in `text-primary`. |
| `level` | `2 \| 3 \| 4` | `2` by default. |
| `id` | `string` | The heading's `id`. |
| `count` | `{ n: number; label: string }` | A `CountPill` beside the title. |
| `caption` | `ReactNode` | `.cd-type-meta` in `text-secondary`, at the right. |

The header has no outer margin; the page spaces its sections.
