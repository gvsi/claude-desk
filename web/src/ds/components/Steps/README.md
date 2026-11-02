# Steps

`Steps` shows where a person is in a flow of a few steps, such as adding a connector or setting up a Desk.

## When to use

- At the top of each page of the add-a-connector flow: "Choose", "Sign in", "Review tools", "Confirm" for an app connected from outside, or "Choose", "Review tools", "Confirm" for a built-in connector.
- In setup, with its five steps: "Questions", "Tools", "Rules", "Safety check", "Live".
- Not for a flow of one or two steps, and never as navigation: the steps are not links.

## What it shows

- An ordered list in a row, named by `label`, in `.cd-type-meta`, its steps joined by 28 px hairlines (`line-hairline`).
- While `current` is null, no step is marked and the phone line keeps its place without naming a step.
- Each step is a 22 px circle and its name, 8 px apart. The circle is drawn only (`aria-hidden`), since the list already numbers the steps.
  - Before `current`: a 14 px `check` on `fill-secondary`, and the name in `text-secondary`, read "{name}, done".
  - `current`: the primary button's fill (`button-primary`) with its number in `button-primary-text`, the name in `text-primary`, and `aria-current="step"` on the item.
  - After `current`: its number in `text-secondary` on `fill-secondary`, and the name in `text-secondary`.
  - With `finished`, as setup is once the Desk is live: the current step is done too. Its number gives way to the same 14 px `check` on the current step's fill, it reads "{name}, done" and keeps `aria-current="step"`, so every step reads done. With `drawCheck` as well, that check draws once as the person reaches it, short arm first as a hand writes a check (its stroke over `motion-base`, on `motion-ease-emphasis`); without it, as when the page opens on a finished flow, it is drawn from the start. Under `prefers-reduced-motion: reduce` it is always drawn from the start. This follows setup's going-live board, signed on 2026-10-30 as an addition to N-R2-Setup-14-Live.
- It lays out by its own width (a container query on its frame). Under 480 px, as on a phone (N-R2-Setup-16-Phone-Questions), the list is read but not drawn, and one line in `.cd-type-meta` says where the person is: "Step 1 of 5: " in `text-secondary`, then the current step's name in `text-primary`. The line is `aria-hidden`, since the list says the same to screen readers, every step's name and `aria-current` included. Nothing scrolls sideways. This narrow layout follows the setup board on a phone, signed on 2026-10-30. The count ends in a colon, not a "·", following the brand book's rule against "·" separators.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. What the steps are of: "Connect Google Calendar", "Set up your Desk". |
| `steps` | `readonly string[]` | Required. Each step's name, in order. |
| `current` | `number \| null` | Required. The step the person is on, counted from 0, kept within the steps: the list and the phone's line name the same step. Null until known. With no steps there is no line. |
| `finished` | `boolean` | Optional, false by default. The flow is done: the current step shows a check and reads done as well. |
| `drawCheck` | `boolean` | Optional, false by default. With `finished`, the current step's check draws once. Static under reduced motion. |
