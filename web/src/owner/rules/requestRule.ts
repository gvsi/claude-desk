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
 * How specific a card is, as the kernel ranks the cards behind a hold (`specificity` in
 * `backend/desk/always_on.py`, which `rulesForTool` follows): a rule for one person or agent above
 * one for a group, then a tool's own rule above a rule on its effect; a default card below every
 * other.
 */
function rank(card: RuleCard): number {
  if (card.is_default === true) return -1;
  return (card.who === 'person' || card.who === 'agent' ? 2 : 0) + (card.applies_to.startsWith('effect:') ? 0 : 1);
}

/** `cards` by ID. */
const byId = (cards: readonly RuleCard[]): RuleCard[] => [...cards].sort((a, b) => (a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0));

/** The most specific of `cards`, the first by ID among equals; null for none. */
function mostSpecific(cards: readonly RuleCard[]): RuleCard | null {
  const top = Math.max(...cards.map(rank));
  return byId(cards.filter((card) => rank(card) === top))[0] ?? null;
}

/**
 * The cards that decided a hold, among the cards behind it, as the kernel's `hold_decider` reads
 * them: the most specific, and of those the ask cards when there are any (an ask card wins a tie
 * with an automatic rule's hold); by ID.
 */
function decidingCards(behind: readonly RuleCard[]): RuleCard[] {
  if (behind.length === 0) return [];
  const top = Math.max(...behind.map(rank));
  const tied = behind.filter((card) => rank(card) === top);
  const asks = tied.filter((card) => card.mode === 'ask');
  return byId(asks.length > 0 ? asks : tied);
}

/** Whether `card` is a rule on the action's tool, or on one of its effects. */
function onTheTool(card: RuleCard, action: NonNullable<Decision['action']>): boolean {
  if (card.applies_to === action.tool) return true;
  return card.applies_to.startsWith('effect:') && (action.effects as readonly string[]).includes(card.applies_to.slice('effect:'.length));
}

/** An owner's ask card, in its own sentence. */
function askRule(card: RuleCard, words: SentenceWords): NamedRule {
  return { parts: ruleSentence(card, words), meta: ruleMeta(card, words), outcome: 'ask' };
}

/**
 * What an automatic card that decided a hold says the request went past, as its hold line: a
 * discount past a quote rule's "Claude asks you before **any discount**", an amount past a limit
 * "Claude asks you before payment links over **$300**", each for the card's own people
 * (`holdRows`); null for anything else it held for (its hours, the reviewer), which no line words.
 */
function pastTheLimit(card: RuleCard, action: NonNullable<Decision['action']>, words: SentenceWords): NamedRule | null {
  const discount = action.discount_bp ?? 0;
  const discountParts = card.applies_to === 'native.quote' && discount > (card.max_discount_bp ?? 0) ? discountHoldSentence(card) : null;
  if (discountParts !== null) return { parts: discountParts, meta: ruleMeta(card, words), outcome: 'ask' };
  const amount = action.amount_cents;
  const [row] = amount != null && card.max_amount_cents != null && amount > card.max_amount_cents ? holdRows([card], words) : [];
  return row === undefined ? null : { ...row, outcome: 'ask' };
}

/**
 * The rule that held a request, among the active version's `cards`, as B5 names it. First the card
 * that decided the hold, as the kernel picks it (`decidingCards`) among the active cards behind it
 * (the decision's `card_ids`, on the request's tool); then its sentence:
 * - the owner's Ask me first card whose reason is the item's `held_by`, in its own sentence. When the
 *   active rules no longer hold the hold's cards (a newer version), the most specific ask card of
 *   that reason on the request's tool;
 * - past an automatic rule's limit (`held_by` null), that rule's hold line (`pastTheLimit`);
 * - otherwise none: a hold only the default ask decided, one an automatic rule held for its hours,
 *   or one whose rule has changed. A less specific card never stands in for the one that decided.
 */
export function heldRule(item: Pick<NeedsYouItem, 'held_by'> & { decision: Decision }, cards: readonly RuleCard[], words: SentenceWords): NamedRule | null {
  const { decision } = item;
  const action = decision.action;
  const behind = cards.filter((card) => decision.card_ids.includes(card.card_id) && (action === null || onTheTool(card, action)));
  const deciding = decidingCards(behind);
  if (item.held_by !== null) {
    const asks = (pool: readonly RuleCard[]) => pool.filter((card) => card.mode === 'ask' && card.is_default !== true && card.reason === item.held_by);
    if (behind.length > 0) {
      const [card] = asks(deciding);
      return card === undefined ? null : askRule(card, words);
    }
    const card = action === null ? null : mostSpecific(asks(cards).filter((ask) => onTheTool(ask, action)));
    return card === null ? null : askRule(card, words);
  }
  if (action === null) return null;
  for (const card of deciding) {
    if (card.mode !== 'auto' || card.is_default === true) continue;
    const rule = pastTheLimit(card, action, words);
    if (rule !== null) return rule;
  }
  return null;
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
