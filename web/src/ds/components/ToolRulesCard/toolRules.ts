import type { Effect, RuleCard, ToolName } from '../../../api/contracts.ts';

/** A tool as `rulesForTool` reads it: its name and its effects, from its profile or tool row. */
export interface RulesTool {
  tool: ToolName;
  effects: readonly Effect[];
}

/** A card for one person or one agent, which outranks every card for a group of people. */
function personScoped(card: RuleCard): boolean {
  return card.who === 'person' || card.who === 'agent';
}

/** How wide a group of people a card that isn't person-scoped is for: anyone, then verified people, then record owners. */
const GROUP_WIDTH = { anyone: 3, verified: 2, record_owner: 1 } as const;

/** True when every principal `inner` is for is one `outer` is for too. */
function containsScope(outer: RuleCard, inner: RuleCard): boolean {
  if (personScoped(inner)) {
    if (outer.who === 'anyone') return true;
    return outer.who === inner.who && (outer.person_id ?? null) === (inner.person_id ?? null) && (outer.agent_key_id ?? null) === (inner.agent_key_id ?? null);
  }
  if (personScoped(outer)) return false;
  return GROUP_WIDTH[outer.who as keyof typeof GROUP_WIDTH] >= GROUP_WIDTH[inner.who as keyof typeof GROUP_WIDTH];
}

/**
 * An effect card covers the tool: it names one of the tool's effects, and an `auto` one only when
 * every effect of the tool is named by an `auto` effect card at the same specificity (one card per
 * effect, covering it jointly).
 */
function effectCardCovers(card: RuleCard, tool: RulesTool, effectCards: readonly RuleCard[]): boolean {
  if (!tool.effects.some((effect) => card.applies_to === `effect:${effect}`)) return false;
  if (card.mode !== 'auto') return true;
  return tool.effects.every((effect) =>
    effectCards.some((other) => other.mode === 'auto' && other.applies_to === `effect:${effect}` && personScoped(other) === personScoped(card)),
  );
}

/**
 * True when one of the tool's own cards leaves the effect card nothing to decide on this tool: a
 * `never` card for everyone it is for (a never card always wins), or a card for everyone it is for
 * that is more specific (a tool card outranks an effect card unless the effect card is for one
 * person or agent and the tool card isn't).
 */
function outranked(effectCard: RuleCard, toolCards: readonly RuleCard[]): boolean {
  return toolCards.some((own) => {
    if (!containsScope(own, effectCard)) return false;
    return own.mode === 'never' || personScoped(own) || !personScoped(effectCard);
  });
}

/** Most specific first: person-scoped tool cards, person-scoped effect cards, tool cards, effect cards. */
function rank(card: RuleCard): number {
  return (personScoped(card) ? 0 : 2) + (card.applies_to.startsWith('effect:') ? 1 : 0);
}

/**
 * The rules that govern a tool, as the master plan's "Coverage and overlap" defines them, most
 * specific first: the tool's own cards, and each card for one of its effects (`effect:charge`) that
 * covers it and that none of its own cards outranks for everyone the effect card is for. So a
 * shared rule shows under a tool only where it decides something; a tool with its own card for the
 * same people doesn't list it. A `never` effect card always shows, since a never card always wins.
 * Default cards (`is_default`) are left out: the card's fallback line says what they do. It lists
 * cards and decides no outcome; the kernel decides every request.
 */
export function rulesForTool(tool: RulesTool, cards: readonly RuleCard[]): RuleCard[] {
  const owned = cards.filter((card) => card.is_default !== true);
  const toolCards = owned.filter((card) => card.applies_to === tool.tool);
  const effectCards = owned.filter((card) => card.applies_to.startsWith('effect:'));
  const governing = [
    ...toolCards,
    ...effectCards.filter((card) => effectCardCovers(card, tool, effectCards) && (card.mode === 'never' || !outranked(card, toolCards))),
  ];
  return governing.map((card, index) => ({ card, index })).sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index).map(({ card }) => card);
}
