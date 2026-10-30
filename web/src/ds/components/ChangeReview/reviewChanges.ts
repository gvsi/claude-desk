import type { Effect, RuleCard, ToolName } from '../../../api/contracts.ts';
import { containsScope, rulesForTool } from '../ToolRulesCard/toolRules.ts';
import { ruleDiff, type RuleField } from './ruleDiff.ts';

/**
 * One row of a rules change, as cards: the screen gives each side its words and builds the
 * `ChangeRowView` from it. `after` null is the compiler's default ask: the screen's default side.
 */
export interface ReviewChange {
  change: 'changed' | 'added';
  /** The owner's card the draft changes or drops; null for a card the draft adds. */
  before: RuleCard | null;
  /**
   * The draft's card: the changed card, the card that governs a dropped card's whole scope, or the
   * added card; null when nothing in the draft covers a dropped card, which then asks by default.
   */
  after: RuleCard | null;
  /** What differs (`ruleDiff`'s fields), or `['mode']` for a fall to the default ask that changes the outcome. */
  fields: RuleField[];
}

/** Seconds since midnight of a contract time ("17:00:00"); an end at 00:00 is midnight, the day's end. */
function seconds(time: string, end = false): number {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  const total = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return end && total === 0 ? 24 * 3600 : total;
}

/** True when `outer`'s window holds all of `inner`'s: any time holds every window, and no window holds any time. */
function hoursCover(outer: RuleCard['hours'], inner: RuleCard['hours']): boolean {
  if (outer == null) return true;
  if (inner == null) return false;
  return (
    inner.days.every((day) => outer.days.includes(day)) &&
    seconds(inner.start) >= seconds(outer.start) &&
    seconds(inner.end, true) <= seconds(outer.end, true)
  );
}

/** True when `card` decides for everyone, and at every time, that `dropped` did. */
function coversScope(card: RuleCard, dropped: RuleCard): boolean {
  return containsScope(card, dropped) && hoursCover(card.hours, dropped.hours);
}

/**
 * The draft's card that will decide everything a dropped card decided: of the cards that govern its
 * target in the draft (`rulesForTool` for a tool, most specific first; the cards on the same effect
 * for an effect card), the first that covers its whole scope, its people, days and hours. None when
 * no card does: then the default ask decides at least part of it, and the row says it asks, so it
 * never claims an outcome the draft doesn't enforce.
 */
function governingCard(dropped: RuleCard, draft: readonly RuleCard[], effectsOf: (tool: ToolName) => readonly Effect[]): RuleCard | undefined {
  const candidates = dropped.applies_to.startsWith('effect:')
    ? draft.filter((card) => card.is_default !== true && card.applies_to === dropped.applies_to)
    : rulesForTool({ tool: dropped.applies_to as ToolName, effects: effectsOf(dropped.applies_to as ToolName) }, draft);
  return candidates.find((card) => coversScope(card, dropped));
}

/**
 * The rows of a rules change, from the owner's cards `before` and the draft's `after`, so a preset's
 * review, a chat draft and a tool's draft all read the same way (the compiler's default cards never
 * show):
 * - A card the draft keeps by its id is a `changed` row where `ruleDiff` finds it different.
 * - A card the draft drops is a `changed` row to the draft's card that covers its whole scope (its
 *   people, days and hours), tagged where they differ, or, with none, to the default ask
 *   (`after` null), tagged `mode` only when the outcome changes. A pair that differs only in its id
 *   has no row.
 * - A draft card no dropped card goes to is an `added` row; one a dropped card goes to shows as that
 *   row's After instead.
 * Rows follow `before`'s order, then the added cards in `after`'s.
 */
export function reviewChanges(
  before: readonly RuleCard[],
  after: readonly RuleCard[],
  effectsOf: (tool: ToolName) => readonly Effect[],
): ReviewChange[] {
  const owned = (cards: readonly RuleCard[]) => cards.filter((card) => card.is_default !== true);
  const draft = owned(after);
  const draftIds = new Map(draft.map((card) => [card.card_id, card]));
  const ownerIds = new Set(owned(before).map((card) => card.card_id));
  const mapped = new Set<string>();
  const rows: ReviewChange[] = [];
  for (const card of owned(before)) {
    const kept = draftIds.get(card.card_id);
    if (kept !== undefined) {
      const [diff] = ruleDiff([card], [kept]);
      if (diff !== undefined) rows.push({ change: 'changed', before: card, after: kept, fields: diff.fields });
      continue;
    }
    const governing = governingCard(card, draft, effectsOf);
    if (governing === undefined) {
      rows.push({ change: 'changed', before: card, after: null, fields: card.mode === 'ask' ? [] : ['mode'] });
      continue;
    }
    mapped.add(governing.card_id);
    const [diff] = ruleDiff([card], [{ ...governing, card_id: card.card_id }]);
    if (diff !== undefined) rows.push({ change: 'changed', before: card, after: governing, fields: diff.fields });
  }
  for (const card of draft) {
    if (!ownerIds.has(card.card_id) && !mapped.has(card.card_id)) rows.push({ change: 'added', before: null, after: card, fields: [] });
  }
  return rows;
}
