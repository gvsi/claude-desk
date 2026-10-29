# EmptyState

`EmptyState` fills the space where a list will be, saying what will appear there and what to do next.

## When to use

- A list or page with nothing in it yet: "No conversations yet", "No customers yet", "Nothing stopped this week".
- Not for a list that failed to load (use an error `Notice`), and not while it is loading.

## What the consumer provides

- `title`: what isn't here, plainly ("No conversations yet").
- `body`: what will appear, and when or how ("When someone writes to your Desk, it shows up here.").
- `action` only when there is a useful next step, such as a `Button` that shares the Desk link. Never a button that goes nowhere.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required; `.cd-type-section` in `text-primary`. Not a heading: the section around it has one. |
| `body` | `ReactNode` | Required; `.cd-type-meta` in `text-secondary`. |
| `action` | `ReactNode` | The next step, under the body. |

Centered, with `space-40` above and below. No illustration, icon or dashed box.
