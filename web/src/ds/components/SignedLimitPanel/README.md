# SignedLimitPanel

`SignedLimitPanel` shows a visiting agent's signed spending limit: what one charge can be, what its charges can add up to, what they have used so far when the screen says, how long the limit lasts, and whose wallet signed it.

## When to use

- In the agents page's "Send an agent" card, between its line and the tasks to send the agent on, before and during a run (N-R2-Agents-03-Send, N-R2-Agents-05-Over-Limit).
- On the owner's view of an agent's conversation, under the conversation's head, with what the agent has used (`used`, N-Conv-Agent-Run1).
- Not for the Desk's own payment limit, which is `MoneyLimit`, and not for a change to it, which is `LimitChange`.

## Where the values come from

The panel sits on a visitor page, which never formats money (the web app's guard `visitor_code_never_formats_money_or_dates`). So every value is the page's own static copy, in English and Spanish, for the built-in agent's signed mandate (`Mandate` in the contract, which `POST /agents/demo` returns in `DemoAgentIssued.mandate`). It is never Claude's prose and never the agent's:

- `perCharge` ("$20") and `total` ("$100") stand for the mandate's `per_charge_cents` and `total_cents`. The page's test (`limits_line_matches_the_seed`, the web app's plan, Task 11) checks them equal to the seed's mandate, as the panel's story does with the Turner fixture's `DemoAgentIssued.mandate`.
- `duration` ("One hour") is how long the mandate lasts, from when it was signed to its `expires_at`. The built-in agent's mandate always lasts one hour (the master plan's "Agent demo" row).
- `used` ("$20") is what the agent has used of the limit: the kernel's committed amount for the mandate (its `committed_cents`), passed to the owner's screen through an owner-view field. The contract has no such field yet, so the conversation board passes the board's own words. A screen never adds it up from the conversation's text or its receipts. Whether a pending payment link's reservation (the kernel's `reserved_cents`) counts toward it is open until that field is in the contract. The screen formats it like the other figures: the design system formats no amount. Without it, the panel has no Used term, as on the agents page before a run.
- `source` says whose wallet signed it ("Signed limit from Alex Kim’s demo wallet"). On the agents page the built-in agent acts for Alex Kim, the demo's own fixed name. A name a third party chose, such as another wallet's `on_behalf_of`, never goes in this line: it would run into the word "Signed". That agent's name is set off on its own, as `AgentMessage` sets it.
- A value that is blank or only spaces draws no panel at all, `used` included when it is given, so the panel never shows part of a limit.

The panel shows the mandate the built-in agent will carry before the run starts, and the same limit while it runs.

## What it shows

- An inset in the card look: `fill-card`, a 1 px `line-card` border at `radius-card`, padded 12 px 16 px, 63 px tall with one line each. In the "Send an agent" card it sits on the card's own fill, as the board draws it, so its words read on `fill-card` over `fill-card` (12.0 and 6.6, `CONTRAST_PAIRS`). It is not a `Card`, so it may sit in one.
- The terms, 16 px apart, as a description list: "Per charge", "In total", "Used" when `used` is given, and "For" ("Por cargo", "En total", "Usado" and "Durante" in Spanish, `SIGNED_LIMIT_COPY`), each name in `caption` type, `text-secondary`, over its value in `body` type at weight 520, `text-primary`, as N-Conv-Agent-Run1 draws them.
- `source` at the right in `caption` type, `text-secondary`, centered on the panel.
- Below 480 px of its own width, as in a phone's card, `source` takes its own line under the terms, from their start. The terms wrap before anything scrolls sideways.

## Accessibility

- The panel is a region named "Signed limit" ("Límite firmado"), with `lang` set to the page's language. Its terms are a `dl`, so a screen reader pairs each name with its amount ("Per charge, $20").

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `perCharge` | `string` | Required. The page's words for `Mandate.per_charge_cents`: "$20". |
| `total` | `string` | Required. The page's words for `Mandate.total_cents`: "$100". |
| `used` | `string` | The kernel's committed amount for the mandate, from an owner-view field, in the screen's words: "$20". Optional; shown as "Used" after "In total". Blank or only spaces draws no panel. |
| `duration` | `string` | Required. How long the mandate lasts, in the page's words: "One hour". |
| `source` | `string` | Required. Whose wallet signed it, in the page's words. |
| `language` | `'en' \| 'es'` | Required. The panel's own words and its `lang`. |
