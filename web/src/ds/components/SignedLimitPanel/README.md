# SignedLimitPanel

`SignedLimitPanel` shows a visiting agent's signed spending limit: what one charge can be, what its charges can add up to, how long the limit lasts, and whose wallet signed it.

## When to use

- In the agents page's "Send an agent" card, between its line and the tasks to send the agent on, before and during a run (N-R2-Agents-03-Send, N-R2-Agents-05-Over-Limit).
- On the owner's page of an agent's conversation, above its signed requests, with `usedCents` (`Boards/Conversation, agent`).
- Not for the Desk's own payment limit, which is `MoneyLimit`, and not for a change to it, which is `LimitChange`.

## Where the values come from

Every value comes from the agent's signed mandate (`Mandate` in the contract, which `POST /agents/demo` returns in `DemoAgentIssued.mandate`), never from prose, Claude's or the agent's:

- `perChargeCents` is the mandate's `per_charge_cents` and `totalCents` its `total_cents`, as whole cents. The panel writes each with the page's `formatCents`; the design system formats no money itself. An amount that isn't a whole number of cents, zero or more, draws no panel at all, so the panel never shows a limit the mandate doesn't hold.
- `duration` is how long the mandate lasts, from when it was signed to its `expires_at`, in the page's words ("One hour"). The built-in agent's mandate always lasts one hour (the master plan's "Agent demo" row), and the page's words are tested against the seed's mandate.
- `source` says whose wallet signed it, in the page's words ("Signed limit from Alex Kim’s demo wallet"). On the agents page the built-in agent acts for Alex Kim, the demo's own fixed name. A name a third party chose, such as another wallet's `on_behalf_of`, never goes in this line: it would run into the word "Signed". That agent's name is set off on its own, as `AgentMessage` sets it.
- `usedCents`, on the owner's page only: what the agent's charges under this mandate have added up to, summed by the screen from the charges the ledger records.

On the agents page the panel shows the mandate the built-in agent will carry before the run starts, so the page passes the seed's mandate values (`per_charge_cents: 2000`, `total_cents: 10000`), tested equal to the Rivera fixture's `DemoAgentIssued.mandate`.

## What it shows

- An inset in the card look: `fill-card`, a 1 px `line-card` border at `radius-card`, padded 12 px 16 px, 63 px tall with one line each. In the "Send an agent" card it sits on the card's own fill, as the board draws it, so its words read on `fill-card` over `fill-card` (12.0 and 6.6, `CONTRAST_PAIRS`). It is not a `Card`, so it may sit in one.
- The terms, 16 px apart, as a description list: "Per charge", "In total", "Used" when given, and "For", each name in `caption` type, `text-secondary`, over its value in `body` type at weight 520, `text-primary`.
- `source` at the right in `caption` type, `text-secondary`, centered on the panel.
- Below 480 px of its own width, as in a phone's card, `source` takes its own line under the terms, from their start. The terms wrap before anything scrolls sideways.

## Accessibility

- The panel is a region named "Signed limit". Its terms are a `dl`, so a screen reader pairs each name with its amount ("Per charge, $20").

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `perChargeCents` | `number` | Required. `Mandate.per_charge_cents`, whole cents. |
| `totalCents` | `number` | Required. `Mandate.total_cents`, whole cents. |
| `usedCents` | `number` | What its charges have used, whole cents. The owner's page only. |
| `formatCents` | `(cents: number) => string` | Required. The page's money formatter, the web app's `formatCents`. |
| `duration` | `string` | Required. How long the mandate lasts, in the page's words: "One hour". |
| `source` | `string` | Required. Whose wallet signed it, in the page's words. |
