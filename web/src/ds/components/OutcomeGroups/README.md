# OutcomeGroups

`OutcomeGroups` shows a Desk's rules grouped by what Claude does with them: what it does on its own, what it asks the owner about, and what it never does, under the payment limit.

Drawn on the setup board N-R2-Setup-08-Rules, signed on 2026-10-30.

## When to use

- On the setup interview's rules step ("Your rules"), to show the drafted rules before the owner checks real situations, with the payment limit's `MoneyLimit` above them, read only (owner ruling, 2026-10-30: the step has no "Change").
- Not on the Rules page, which lists each connector's tools and their outcomes (`ConnectorList`); the setup groups the same rules by outcome so a new owner reads them at a glance.

## What it shows

- Cards 20 px apart, each padded 16 px.
- `moneyLimit`, when given, first, in a card of its own: the limit holds over every rule below it. Pass `MoneyLimit` with `prominent`, which sets its line in weight 520, as the setup board draws it, and no `onEdit`, so the line stands alone; on the Rules page it keeps the body weight and its "Change".
- A card per outcome that has rules, in order: "Allow", "Ask me first", "Never" (`OUTCOME_GROUP_WORDS`). Each is a `section` named by its `h2`: the outcome's 6 px dot in its `OUTCOME_TONE` (handled, held, refused), 8 px from its name in `.cd-type-control`, on a 20 px line 10 px over the first row's hairline. A group with no rules is left out.
- A row per rule, under a hairline, 10 px over and under a 20 px line: what Claude does in `.cd-type-body`, `text-primary`, at the left, and who it's for in `.cd-type-meta`, `text-secondary`, at the right, at most half the row. A long rule wraps beside it.
- The rows are read only, and so is the payment limit's line. During setup, the payment limit changes by restarting setup (owner ruling, 2026-10-30); after the Desk is live, rules and the limit change on the Rules page.

The screen passes every string; nothing here decides which group a rule is in beyond its `mode`.

## Types

- `OutcomeGroupRow = { key: string; text: string; who: string }`: one rule, in the screen's words ("Quotes from your price list, at list price", "Anyone").

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `rows` | `Partial<Record<RuleMode, OutcomeGroupRow[]>>` | Required. The rules by outcome. |
| `moneyLimit` | `ReactNode` | The payment limit's `MoneyLimit`, with `prominent` and no `onEdit`, above the groups. |
