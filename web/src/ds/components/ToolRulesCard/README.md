# ToolRulesCard

`ToolRulesCard` is a tool with every rule that governs it: on a connector's page the tool's name and line as a link to its page, then a row per rule, then what happens to anything else.

## When to use

- On a connector's page, one card per tool, named by the tool, with `tool` for its header link (N-Conn-02-Payments).
- On a tool's own page, one card named "Your rules for {tool}", without `tool` (N-Conn-05-Refund).

## What it shows

- A `Card` (`section`, named `label`, 16 px padding).
- With `tool`: its name in `.cd-type-section`, marked `data-copy="user"` since a tool's title is its own words (a business's job from setup) and not the app's, and its `description` in secondary `.cd-type-meta`, as one link to `tool.href` with `chevron-right` (`aria-hidden`). An empty description draws no description line (the "Name only" story). Without `tool.href` (the tool's page isn't built yet, as on All rules), the same words are plain text, with no chevron and no tab stop (the "Without a link" story).
- A `RuleRow` per entry of `rules`, each under a hairline, in a list. Build them from `rulesForTool` (below), with each card's `ruleWords`, its formatted `limit` for an auto card with `max_amount_cents`, and `shared` for an effect card (its group's words and the titles of the tools it covers, which `RuleRow` shows as user text).
- `fallback` (true unless the screen passes false): "Anything else here: ask me." in secondary meta, with a ghost "Add a rule" calling `onAddRule` when given. The screen passes false when a `never` card for anyone covers the tool, since nothing is left to ask about. It is what the compiler's default ask card does, so default cards never get a row of their own.
- Whatever comes first in the card has no hairline above it.

## Choosing the rows: `rulesForTool`

`rulesForTool(tool, cards): RuleCard[]` (in `toolRules.ts`, also exported) lists the cards that govern a tool, as the master plan's "Coverage and overlap (most specific wins)" defines them, most specific first. It lists cards and decides nothing; the kernel decides every request.

- The tool's own cards (`applies_to` names it), always.
- A card for one of its effects (`effect:charge`) when it covers the tool and none of the tool's own cards outranks it for everyone it reaches there:
  - an `auto` effect card covers a tool only when every effect of the tool has an `auto` effect card at the same specificity that one principal can satisfy with it: cards for groups of people combine, and a card for one person or agent combines only with that same person's or agent's cards (`effect:send_message` alone doesn't cover Share a document, which also touches private data, and agent A's private-data card with agent B's send-message card covers nobody);
  - an `auto` group card that covers the tool jointly reaches only the narrowest group in its widest combination: anyone's private-data card with the record owners' send-message card reaches record owners on Share a document, so the tool's ask card for verified people outranks both, and only it shows;
  - a tool card outranks an effect card for everyone it reaches, so a group rule for anyone is hidden under a tool with its own rule for anyone;
  - a card for one person or agent outranks a card for a tool, so an agent's shared charge rule still governs Payment link for that agent, beside the tool's rule for everyone else;
  - a tool card for fewer people (record owners only) leaves the group rule deciding for everyone else, so both show;
  - a `never` effect card always shows, since a never card always wins.
- Default cards (`is_default`) are left out: the fallback row says what they do.
- Order: cards for one person or agent on the tool, then on its effects, then the tool's cards, then its effect cards, each in the order given.

`groupsOverlap(a, b)` (also in `toolRules.ts`) says whether two cards' groups of people share someone. Anyone, verified people and record owners nest, so any two do; a card for one person or agent is no group. The presets' description check uses it: a group's refusal refuses part of any audience it overlaps, since a never card always wins.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | The card's name. |
| `tool` | `{ name; description; href? }` | The header link, on a connector's page; plain text without `href`. |
| `rules` | `RuleRowProps[]` | Required. |
| `fallback` | `boolean` | `true` by default. |
| `onAddRule` | `() => void` | Adds "Add a rule". |
| `landed` | `number` | The owner's confirmed change changed the tool's rules since they opened the page (a business's own job on Rules). "Updated" sits 8 px after the tool's name, centered on it, growing from 95% as it fades in on `motion-base`; each rule's reason and words cross-fade to the new ones (`RuleRow`'s `fade`); and the card lights up in `bg-selected` out to its edge, behind its words, on `motion-fast`, holds 1.6 s, then lets go on `motion-base`. A card that offers "Add a rule" takes no fill, since a Button can't sit on the selected ground. The card's content carries `data-landed`, so a screen can find a landing's rows. Each new value lights it up again; under reduced motion it is at its end state at once. See the "Landed" story. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. It gets `href`, `className`, `aria-label`, `aria-describedby` and `children`, like `<a>`. `RulesLinkProps` is also exported, and `ConnectorSection` takes the same. |
