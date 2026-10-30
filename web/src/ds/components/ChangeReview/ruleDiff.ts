import type { RuleCard } from '../../../api/contracts.ts';

/**
 * A part of a rule card a change can touch: what it applies to, its outcome, who it is for, its
 * limits (amount and discount), its hours, its review gate and its reason.
 */
export type RuleField = 'applies_to' | 'mode' | 'who' | 'limits' | 'hours' | 'review' | 'reason';

/** One card that differs between two rule sets, keyed by `card_id`. */
export interface RuleDiffRow {
  cardId: string;
  change: 'added' | 'removed' | 'changed';
  before: RuleCard | null;
  after: RuleCard | null;
  /** For a changed card, the fields that differ, in `RuleField` order; empty for added and removed. */
  fields: RuleField[];
}

/** Each field as one comparable value, with an absent optional field at its contract default. */
const FIELD_VALUES = {
  applies_to: (card) => card.applies_to,
  mode: (card) => card.mode,
  who: (card) => [card.who, card.person_id ?? null, card.agent_key_id ?? null],
  limits: (card) => [card.max_amount_cents ?? null, card.max_discount_bp ?? 0],
  hours: (card) => (card.hours == null ? null : [[...card.hours.days], card.hours.start, card.hours.end]),
  review: (card) => card.review ?? false,
  reason: (card) => card.reason,
} as const satisfies Record<RuleField, (card: RuleCard) => unknown>;

const FIELDS = Object.keys(FIELD_VALUES) as RuleField[];

function changedFields(before: RuleCard, after: RuleCard): RuleField[] {
  return FIELDS.filter((field) => JSON.stringify(FIELD_VALUES[field](before)) !== JSON.stringify(FIELD_VALUES[field](after)));
}

/**
 * Which of the owner's cards a draft adds, removes or changes, and in which fields, by `card_id`
 * in `card_id` order. Default cards (`is_default`) are the compiler's, re-derived on every draft,
 * so they are skipped; unchanged cards are left out. It reports differences and decides nothing:
 * the screen builds the rows it shows from it.
 */
export function ruleDiff(before: readonly RuleCard[], after: readonly RuleCard[]): RuleDiffRow[] {
  const owned = (cards: readonly RuleCard[]) => new Map(cards.filter((card) => card.is_default !== true).map((card) => [card.card_id, card]));
  const was = owned(before);
  const now = owned(after);
  const ids = [...new Set([...was.keys(), ...now.keys()])].sort();
  const rows: RuleDiffRow[] = [];
  for (const cardId of ids) {
    const old = was.get(cardId) ?? null;
    const next = now.get(cardId) ?? null;
    if (old === null && next !== null) rows.push({ cardId, change: 'added', before: null, after: next, fields: [] });
    else if (old !== null && next === null) rows.push({ cardId, change: 'removed', before: old, after: null, fields: [] });
    else if (old !== null && next !== null) {
      const fields = changedFields(old, next);
      if (fields.length > 0) rows.push({ cardId, change: 'changed', before: old, after: next, fields });
    }
  }
  return rows;
}
