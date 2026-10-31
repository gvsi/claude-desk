# PersonRules

`PersonRules` shows the rules just for one person on their page, read only, with the way to change them on the Rules page.

Built against the person page board in review (N-Run2-People-Person); sign-off pending.

## When to use

- On a person's page under People, beside their contact on record: the cards whose `person_id` is theirs.
- Not to change a rule: rules are changed on the Rules page, which "Change them on Rules" opens.

## What it shows

- A `section` named by its heading, "Rules for {name}" (`SectionHeader`), with "Change them on Rules" at the right, a link to `rulesHref` in `.cd-type-meta`, `text-secondary`, that turns `text-primary` and underlined on hover.
- In the heading, "Rules for" is the component's words and the name is the person's, in its own `<bdi data-copy="user">`: marked as user text, and isolated, so a direction mark in the name (such as U+202E) can't reorder the words around it.
- 8 px under it, a card of rows that reach its edges, each padded 12 px 16 px under a hairline but the first:
  - at the left, what the rule is on (`title`, "Book a visit") in `.cd-type-control` at weight 520, over its reason in `.cd-type-meta`, `text-secondary`, 2 px under it;
  - then what it enforces, the `words` joined by " · " (`ruleWordsLine`), in `.cd-type-meta`, `text-secondary`;
  - and its outcome, `OutcomeMenu` without `onChange`: its dot and words, nothing to press. On a crowded row the outcome wraps between its words, never inside one: it shrinks only to its longest word, and the rest of the row gives way first.
- With no rules, "No rules just for {name}." in body type, `text-secondary`, in place of the card, the name marked as user text the same way; the link stays.
- A rule's `reason` and its `words` are the screen's strings, shown as they are: a name inside them isn't marked.
- It lays out by its own width (a container query): under 480 px, what a rule enforces and its outcome go under its reason.

## Types

- `PersonRuleView = { key: string; title: string; rule: Pick<RuleCard, 'card_id' | 'mode' | 'reason'>; words: RuleWord[]; limit?: string }`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Required. The person's name, as their page shows it. Shown marked as user text and isolated (`<bdi data-copy="user">`) in the heading and in the no-rules line. |
| `rules` | `PersonRuleView[]` | Required. Their rules alone. |
| `rulesHref` | `string` | Required. The Rules page. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
