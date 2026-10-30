# ToolPageHeader

`ToolPageHeader` is the top of a tool's page: the tool's name, what it does, which connector it comes from and whether it is on.

## When to use

- At the top of each tool's page under Connectors (`connectors/:connector/:tool`), under its `Breadcrumb`.
- While the tool `needs_review`, a `ToolReviewCard` follows it; after the owner turns it back on, the screen passes "Definition reviewed today" and shows an info `Notice` under it.
- In the demo, with `onSimulateChange`, a connected tool's page offers "Simulate a tool change" (N-Conn-21-Simulate), the master's owner-side demo action ("Connected integration").

## What it shows

- `name` as the page's `h1` in serif `.cd-type-page-title`, then `description` 4 px under it in body type, `text-secondary`.
- The source line, 8 px under that, in `.cd-type-meta`: the connector's `ConnectorIcon` at `inline` size (24 px), "From {name}" with "Built in" or the Mock badge (`ConnectorName` at `inline` size), and 16 px on, the status in words with its dot:
  - `enabled`: handled "On", followed by " · {definitionNote}" when given ("On · Definition unchanged").
  - `needs_review`: info "Off until you review a change".
  - `disabled`: info "Off".
  - A status this build doesn't know reads "Off until you review a change", never "On".
- On a narrow line the status wraps under the source.
- The demo's strip, 20 px under the source line, only for an external connector's tool while it is `enabled` and only with `onSimulateChange`: a bordered row (`line-card`, `radius-card`, no fill, padding 10 px 14 px) with "Demo only. Changes this tool's definition on the mock {connector name} server, so you can see what happens." in `.cd-type-meta`, `text-secondary`, at the left, and a ghost `Button` "Simulate a tool change" at the right. On a narrow line the button wraps under the caption. A built-in tool has no mock server, and a tool that is off or waiting for a review has nothing to simulate, so neither gets the strip.

## Simulating a change

- One press calls `onSimulateChange()` once, with nothing in it. The button then waits, busy (its spinner in place of the label, at the same width, `aria-busy`), until `simulatePending` has come and gone, or the promise `onSimulateChange` returned rejects; further presses send nothing.
- `simulatePending` from the screen makes the button busy too.
- What follows is the existing flow: the tool turns `needs_review`, so the strip goes, and the screen shows the review (N-Conn-13 on Today, N-Conn-14 on the tool page).

## What the consumer provides

- `definitionNote` only for a connected tool, whose definition is pinned by its hash: "Definition unchanged", or "Definition reviewed today" after a review. A built-in tool has no pinned definition, so it gets none.
- `onSimulateChange` (`POST /tools/simulate_change` through the API) and `simulatePending` while it runs, only in the demo.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. |
| `description` | `string` | Required. What it does, then its effects (`describeEffects`). |
| `connector` | `ConnectorView` | Required. |
| `status` | `ToolStatus` | Required. The profile's status. |
| `definitionNote` | `string` | Shown after "On" only. |
| `onSimulateChange` | `() => void \| Promise<unknown>` | The demo's strip, for a connected tool that is on. Called once per press. |
| `simulatePending` | `boolean` | The simulated change is in flight: the button stays busy. |
