# ToolPageHeader

`ToolPageHeader` is the top of a tool's page: the tool's name, what it does, which connector it comes from and whether it is on.

## When to use

- At the top of each tool's page under Rules (`rules/:connector/:tool`), under its `Breadcrumb`.
- While the tool `needs_review`, a `ToolReviewCard` follows it; after the owner turns it back on, the screen passes "Definition reviewed today" and shows an info `Notice` under it.
- The demo's "Simulate a tool change" is built later, with the mode switch and the money-limit line, so the header has no control for it.

## What it shows

- `name` as the page's `h1` in serif `.cd-type-page-title`, then `description` 4 px under it in body type, `text-secondary`.
- The source line, 8 px under that, in `.cd-type-meta`: the connector's `ConnectorIcon` at `inline` size (24 px), "From {name}" with "Built in" or the Mock badge (`ConnectorName` at `inline` size), and 16 px on, the status in words with its dot:
  - `enabled`: handled "On", followed by " · {definitionNote}" when given ("On · Definition unchanged").
  - `needs_review`: info "Off until you review a change".
  - `disabled`: info "Off".
  - A status this build doesn't know reads "Off until you review a change", never "On".
- On a narrow line the status wraps under the source.

## What the consumer provides

- `definitionNote` only for a connected tool, whose definition is pinned by its hash: "Definition unchanged", or "Definition reviewed today" after a review. A built-in tool has no pinned definition, so it gets none.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `description` | `string` | Required. What it does, then its effects (`describeEffects`). |
| `connector` | `ConnectorView` | Required. |
| `status` | `ToolStatus` | Required. The profile's status. |
| `definitionNote` | `string` | Shown after "On" only. |
