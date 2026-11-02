/**
 * The rule a request names beside it, as the REV-RULES-B5 board draws it: the held card's "Your
 * rule" and Safety's "The rule that turned it down", each one rule sentence (`ruleSentence`) with its
 * outcome. A request names a rule only when the active rules hold the one that decided it: never
 * a guess, and never a rule the owner has since changed. They read the rules and decide nothing:
 * the kernel decided the request.
 */
import type { Decision, RuleCard } from '../../api/contracts.ts';
import type { Attempt, NeedsYouItem } from '../../api/views.ts';
import type { RuleMode } from '../../ds/index.ts';
import {
  ALWAYS_ON_SENTENCES,
  discountHoldSentence,
  holdRows,
  ruleMeta,
  ruleSentence,
  type AlwaysOnSentence,
  type RuleMeta,
  type SentencePart,
  type SentenceWords,
} from './ruleSentence.ts';

/** A rule as a request names it: its sentence, the line under it, and its outcome. */
export interface NamedRule {
  parts: SentencePart[];
  meta: RuleMeta;
  outcome: RuleMode;
}

/**
 * How specific a card is, as the API ranks the cards behind a hold (`holding_card`): a rule for one
 * person or agent above one for a group, then a tool's own rule above a rule on its effect.
 */
function rank(card: RuleCard): number {
  return (card.who === 'person' || card.who === 'agent' ? 2 : 0) + (card.applies_to.startsWith('effect:') ? 0 : 1);
}

/** The most specific of `cards`, the first by ID among equals; null for none. */
function mostSpecific(cards: readonly RuleCard[]): RuleCard | null {
  return cards.reduce<RuleCard | null>((best, card) => {
    if (best === null || rank(card) > rank(best)) return card;
    return rank(card) === rank(best) && card.card_id < best.card_id ? card : best;
  }, null);
}

/** Whether `card` is a rule on the action's tool, or on one of its effects. */
function onTheTool(card: RuleCard, action: NonNullable<Decision['action']>): boolean {
  if (card.applies_to === action.tool) return true;
  return card.applies_to.startsWith('effect:') && (action.effects as readonly string[]).includes(card.applies_to.slice('effect:'.length));
}

/**
 * The rule that held a request, among the active version's `cards`, as B5 names it:
 * - the owner's Ask me first card whose reason is the item's `held_by`, in its own sentence;
 * - past an automatic rule's limit (`held_by` null), the automatic card behind the hold whose limit
 *   the request passed: a discount past a quote rule's "Claude asks you before **any discount**",
 *   an amount past a limit its hold line ("Claude asks you before payment links over **$300**"),
 *   each for that card's own people (`holdRows`);
 * - otherwise none, such as a hold only the default ask decided, or one whose rule has changed.
 */
export function heldRule(item: Pick<NeedsYouItem, 'held_by'> & { decision: Decision }, cards: readonly RuleCard[], words: SentenceWords): NamedRule | null {
  const { decision } = item;
  const owners = cards.filter((card) => card.is_default !== true);
  if (item.held_by !== null) {
    const asks = owners.filter((card) => card.mode === 'ask' && card.reason === item.held_by);
    const card = asks.find((ask) => decision.card_ids.includes(ask.card_id)) ?? mostSpecific(asks);
    return card === null || card === undefined ? null : { parts: ruleSentence(card, words), meta: ruleMeta(card, words), outcome: 'ask' };
  }
  const action = decision.action;
  if (action === null) return null;
  // Only an automatic card the hold names, whose limit the request still passes.
  const behind = owners.filter((card) => card.mode === 'auto' && decision.card_ids.includes(card.card_id) && onTheTool(card, action));
  const discount = action.discount_bp ?? 0;
  const discounted = mostSpecific(behind.filter((card) => card.applies_to === 'native.quote' && discount > (card.max_discount_bp ?? 0)));
  const discountParts = discounted === null ? null : discountHoldSentence(discounted);
  if (discounted !== null && discountParts !== null) return { parts: discountParts, meta: ruleMeta(discounted, words), outcome: 'ask' };
  const amount = action.amount_cents;
  const limited = amount == null ? null : mostSpecific(behind.filter((card) => card.max_amount_cents != null && amount > card.max_amount_cents));
  const [row] = limited === null ? [] : holdRows([limited], words);
  return row === undefined ? null : { ...row, outcome: 'ask' };
}

/**
 * The always-on rule each refusal cause is, where one is: private data only to its verified owner
 * (`B.private_data_record_owner`), codes and messages only to the contact on record
 * (`B.recipient_owner_or_verified_contact`), and no money past a signed limit
 * (`B.agent_charge_within_mandate`). The other causes are checks with no rule of their own.
 */
const ALWAYS_ON_BY_CAUSE: Partial<Record<NonNullable<Attempt['cause']>, AlwaysOnSentence['key']>> = {
  not_verified: 'private_data',
  not_their_record: 'private_data',
  recipient: 'codes',
  agent_limit: 'money',
};

/**
 * The rule that turned a request down, as B5 names it: the always-on rule its cause is
 * (`ALWAYS_ON_BY_CAUSE`), or for the owner's own rule (`owner_rule`) the active Never card the
 * refusal names; otherwise none. Only a turned-down request names one.
 */
export function turnedDownRule(attempt: Pick<Attempt, 'kind' | 'cause' | 'card_ids'>, cards: readonly RuleCard[], words: SentenceWords): NamedRule | null {
  if (attempt.kind !== 'refused' || attempt.cause === null) return null;
  if (attempt.cause === 'owner_rule') {
    const card = mostSpecific(cards.filter((c) => c.mode === 'never' && c.is_default !== true && attempt.card_ids.includes(c.card_id)));
    return card === null ? null : { parts: ruleSentence(card, words), meta: ruleMeta(card, words), outcome: 'never' };
  }
  const key = ALWAYS_ON_BY_CAUSE[attempt.cause];
  const rule = key === undefined ? undefined : ALWAYS_ON_SENTENCES.find((sentence) => sentence.key === key);
  return rule === undefined ? null : { parts: [...rule.parts], meta: rule.meta, outcome: 'never' };
}
