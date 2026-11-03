/**
 * A rules draft as the owner reviews it: the cards before and after, the check, the payment limit
 * before and after, and the tools it turns on. Built from what the API answered alone, so a review
 * shows the same rows after a reload; the rows themselves are `changeRows`'.
 */
import type { ProofReport, RuleCard } from '../../api/contracts.ts';
import type { PolicyVersionOut, RulesDraft, RulesPreset, ToolRow } from '../../api/views.ts';

/** A draft as the review shows it. */
export interface RuleDraft {
  version: number;
  /**
   * The owner's cards the draft changes or drops, then the cards it keeps as they are, so a dropped
   * card is matched against every card of the draft. Default cards never appear.
   */
  before: RuleCard[];
  /** The cards the draft adds or changes, then the cards it keeps, as the draft has them. */
  after: RuleCard[];
  /** The draft's check; null when there is none, which can't be confirmed. */
  proof: ProofReport | null;
  /** The API's summary, kept for callers; the review reads every rule through the shared sentence wording. */
  summary: RulesDraft['summary'] | null;
  /** The payment limit in force and the draft's, when they differ. */
  moneyCap: { before: number; after: number } | null;
  /** The preset that drafted it, which only titles the review. */
  preset: RulesPreset | null;
  /** The rows of the tools a tool confirm turns on; empty for a card draft. */
  turnedOn: ToolRow[];
}

/** A version's money cap; a missing one is 0, the kernel's default, under which every payment asks. */
export function capOf(version: { auto_money_cap_cents?: number | null }): number {
  const cap = version.auto_money_cap_cents;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 0 ? cap : 0;
}

/**
 * The limit change a draft makes: the active version's cap, which applies until the owner
 * confirms, and the draft's, when they differ, raised or lowered; else null.
 */
export function moneyCapChange(activeCap: number, draftCap: number): { before: number; after: number } | null {
  return activeCap === draftCap ? null : { before: activeCap, after: draftCap };
}

const owned = (cards: readonly RuleCard[]): RuleCard[] => cards.filter((card) => card.is_default !== true);

/**
 * The two sides of a card change: `touched` before and after, then the draft's other cards on both
 * sides, as the draft has them, so they make no row but still govern what a dropped card covered.
 */
function sides(touchedBefore: readonly RuleCard[], touchedAfter: readonly RuleCard[], draftCards: readonly RuleCard[]) {
  const touched = new Set([...touchedBefore, ...touchedAfter].map((card) => card.card_id));
  const kept = owned(draftCards).filter((card) => !touched.has(card.card_id));
  return { before: [...owned(touchedBefore), ...kept], after: [...owned(touchedAfter), ...kept] };
}

/** The card in `cards` with each of `wanted`'s ids, in `wanted`'s order; an id `cards` lacks is skipped. */
function byIds(wanted: readonly RuleCard[], cards: readonly RuleCard[]): RuleCard[] {
  const found = new Map(cards.map((card) => [card.card_id, card]));
  return wanted.flatMap((card) => {
    const match = found.get(card.card_id);
    return match === undefined ? [] : [match];
  });
}

/**
 * The draft an "always" answer proposes (Today's card diff, drafted through `draftRules`): before,
 * the active cards whose `card_id` is in the diff; after, the draft's cards for those ids, so the
 * review shows what the draft would apply.
 */
export function draftFromAnswer(active: PolicyVersionOut, cardDiff: readonly RuleCard[], draft: RulesDraft): RuleDraft {
  const touchedBefore = byIds(cardDiff, active.cards);
  const touchedAfter = byIds(cardDiff, draft.cards);
  return {
    version: draft.version,
    ...sides(touchedBefore, touchedAfter, draft.cards),
    proof: draft.proof ?? null,
    summary: null,
    moneyCap: moneyCapChange(capOf(active), capOf(draft)),
    preset: null,
    turnedOn: [],
  };
}

/**
 * A draft from its diff (a chat's, a preset's, a payment limit's, or one read again by its version):
 * before, the removed cards and each changed pair's first; after, the added cards and each pair's
 * second. A draft with no diff has nothing to compare with, so all its cards show as New sentences.
 * `preset` names the preset that drafted it, which only titles the review.
 */
export function draftFromDiff(draft: RulesDraft, active: PolicyVersionOut, preset?: RulesPreset): RuleDraft {
  const common = {
    version: draft.version,
    proof: draft.proof ?? null,
    moneyCap: moneyCapChange(capOf(active), capOf(draft)),
    preset: preset ?? null,
    turnedOn: [],
  };
  const { diff } = draft;
  if (diff === null) return { ...common, before: [], after: owned(draft.cards), summary: draft.summary ?? null };
  return {
    ...common,
    ...sides([...diff.removed, ...diff.changed.map(([was]) => was)], [...diff.added, ...diff.changed.map(([, now]) => now)], draft.cards),
    summary: null,
  };
}

/**
 * A tool confirm's draft (`ToolConfirmed.draft`), shown inline where the tools were turned on: the
 * active version's cards against the drafted version's, and `turnedOn`, the rows of the tools the
 * confirm named. Never at `rules/drafts/:version`, since a read of the draft can't say which tools
 * it turns on.
 */
export function draftFromVersion(active: PolicyVersionOut, version: PolicyVersionOut, turnedOn: readonly ToolRow[]): RuleDraft {
  return {
    version: version.version,
    before: owned(active.cards),
    after: owned(version.cards),
    proof: version.proof ?? null,
    summary: null,
    moneyCap: moneyCapChange(capOf(active), capOf(version)),
    preset: null,
    turnedOn: [...turnedOn],
  };
}
