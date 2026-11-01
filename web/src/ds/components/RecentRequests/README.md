# RecentRequests

`RecentRequests` lists the requests that came in under a tool's rules, with what decided each one and how it ended.

## When to use

- On a tool's page, after its rules and the owner's composer: "Recent requests under these rules".
- Not for a conversation's own record, which is the Safety page's.

## What it shows

- A section named by its heading, "Recent requests under these rules" (`SectionHeader`).
- A row per request, newest first, each under a hairline (12 px above and below):
  - `when` in a 120 px column of `.cd-type-meta`, `text-secondary`;
  - `what` in body type, `text-primary`: the decision's `reason_plain`;
  - `why` under it in secondary caption type: the rule that decided it ("Held by your rule: Refunds to a customer wait for your answer.") or what happened ("Refunded to the original payment.");
  - at the right, the outcome in words with its dot (`StatusLabel` in meta type): "Automatic", "Waiting for your answer", "Stopped", "You allowed it".
- With `href`, the row opens its Safety record: `what` is the link, its overlay covers the row and draws the base focus ring (2 px of `ring-focus`, 2 px outside the row), and when, why and the outcome describe it (`aria-describedby`). Without `href`, the row is words only. Nothing around the rows may clip that ring.
- Empty: "No requests under these rules yet." in secondary body type.
- It lays out by its own width (a container query): under 640 px each part sits on its own line, the outcome last.

## What the consumer provides

Every string: the time already formatted, the decision's `reason_plain`, the deciding card's reason or what happened, the state in words and its tone. Nothing here formats a time or an amount.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `rows` | `RecentRequestView[]` | Required. `{ key; when; what; why; tone: StatusTone; outcome; href? }`. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
