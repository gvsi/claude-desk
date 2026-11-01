import type { Effect, RuleCard } from '../../../api/contracts.ts';
import type { AnyToolName } from '../../../api/views.ts';

/** A tool as `rulesForTool` reads it: its name and its effects, from its profile or tool row. */
export interface RulesTool<Name extends string = AnyToolName> {
  tool: Name;
  effects: readonly Effect[];
}

/** A card for one person or one agent, which outranks every card for a group of people. */
function personScoped(card: RuleCard): boolean {
  return card.who === 'person' || card.who === 'agent';
}

/** How wide a group of people a card that isn't person-scoped is for: anyone, then verified people, then record owners. */
const GROUP_WIDTH = { anyone: 3, verified: 2, record_owner: 1 } as const;

type Group = keyof typeof GROUP_WIDTH;

/**
 * True when two groups of people share someone: each is one of anyone, verified people and record
 * owners, which nest, so any two of them do. A card for one person or agent is no group.
 */
export function groupsOverlap(a: Pick<RuleCard, 'who'>, b: Pick<RuleCard, 'who'>): boolean {
  const widths = [a.who, b.who].map((who) => (who in GROUP_WIDTH ? GROUP_WIDTH[who as Group] : 0));
  return Math.min(...widths) > 0;
}

/** The group of people at each width. */
const GROUP_AT_WIDTH: Readonly<Record<number, Group>> = { 3: 'anyone', 2: 'verified', 1: 'record_owner' };

/** True when every principal `inner` is for is one `outer` is for too. */
export function containsScope(outer: RuleCard, inner: RuleCard): boolean {
  if (personScoped(inner)) {
    if (outer.who === 'anyone') return true;
    return outer.who === inner.who && (outer.person_id ?? null) === (inner.person_id ?? null) && (outer.agent_key_id ?? null) === (inner.agent_key_id ?? null);
  }
  if (personScoped(outer)) return false;
  return GROUP_WIDTH[outer.who as keyof typeof GROUP_WIDTH] >= GROUP_WIDTH[inner.who as keyof typeof GROUP_WIDTH];
}

/**
 * True when one principal can satisfy both cards at the same specificity, so they can cover a tool
 * jointly: both for groups of people (anyone, verified people, record owners, which always share
 * someone), or both for the same one person or agent.
 */
function jointScope(a: RuleCard, b: RuleCard): boolean {
  if (!personScoped(a) && !personScoped(b)) return true;
  return a.who === b.who && (a.person_id ?? null) === (b.person_id ?? null) && (a.agent_key_id ?? null) === (b.agent_key_id ?? null);
}

/**
 * An effect card covers the tool: it names one of the tool's effects, and an `auto` one only when
 * every effect of the tool is named by an `auto` effect card at the same specificity and for the
 * same person or agent, so one principal satisfies them all (one card per effect, jointly).
 */
function effectCardCovers(card: RuleCard, tool: RulesTool<string>, effectCards: readonly RuleCard[]): boolean {
  if (!tool.effects.some((effect) => card.applies_to === `effect:${effect}`)) return false;
  if (card.mode !== 'auto') return true;
  return tool.effects.every((effect) =>
    effectCards.some((other) => other.mode === 'auto' && other.applies_to === `effect:${effect}` && jointScope(card, other)),
  );
}

/**
 * Whom an effect card can decide for on this tool. An `auto` group card on a tool with several
 * effects covers it only jointly, with an `auto` card for each other effect, and one principal must
 * satisfy every card in the combination: so it reaches the narrowest group among them. Its widest
 * combination takes the widest card for each other effect, and reaches the people that combination
 * does. Any other card reaches everyone it is for (a person's or an agent's combination is that
 * person's or agent's).
 */
function jointReach(card: RuleCard, tool: RulesTool<string>, effectCards: readonly RuleCard[]): RuleCard {
  if (card.mode !== 'auto' || personScoped(card)) return card;
  let width: number = GROUP_WIDTH[card.who as Group];
  for (const effect of tool.effects) {
    if (card.applies_to === `effect:${effect}`) continue;
    const partners = effectCards.filter((other) => other.mode === 'auto' && other.applies_to === `effect:${effect}` && jointScope(card, other));
    width = Math.min(width, Math.max(0, ...partners.map((other) => GROUP_WIDTH[other.who as Group])));
  }
  const who = GROUP_AT_WIDTH[width];
  return who === undefined ? card : { ...card, who };
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
 * covers it and that none of its own cards outranks for everyone the effect card reaches on this
 * tool (an `auto` card's widest joint combination, `jointReach`). So a shared rule shows under a
 * tool only where it decides something; a tool with its own card for the same people doesn't list
 * it. A `never` effect card always shows, since a never card always wins.
 * Default cards (`is_default`) are left out: the card's fallback line says what they do. It lists
 * cards and decides no outcome; the kernel decides every request.
 */
export function rulesForTool(tool: RulesTool<string>, cards: readonly RuleCard[]): RuleCard[] {
  const owned = cards.filter((card) => card.is_default !== true);
  const toolCards = owned.filter((card) => card.applies_to === tool.tool);
  const effectCards = owned.filter((card) => card.applies_to.startsWith('effect:'));
  const governing = [
    ...toolCards,
    ...effectCards.filter(
      (card) => effectCardCovers(card, tool, effectCards) && (card.mode === 'never' || !outranked(jointReach(card, tool, effectCards), toolCards)),
    ),
  ];
  return governing.map((card, index) => ({ card, index })).sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index).map(({ card }) => card);
}
