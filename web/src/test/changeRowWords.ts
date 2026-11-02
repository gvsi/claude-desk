/**
 * A rules review's rows as they read, for tests that compare their words: each row's title and each
 * side's target as one string, a group's words as they are and tools' titles joined as
 * `ChangeReview` shows them ("Payment link and Refund"). The rows themselves keep each title apart,
 * so the review can show it as user text.
 */
import type { ChangeRowView, ChangeSide, RuleTarget } from '../ds/index.ts';
import { listWords } from '../lib/format.ts';

/** A target as it reads. */
export function targetText(target: RuleTarget): string {
  return typeof target === 'string' ? target : listWords(target.titles);
}

/** A side with its target as it reads. */
export type ChangeSideWords = Omit<ChangeSide, 'appliesTo'> & { appliesTo?: string };

/** A row with its title and its sides' targets as they read. */
export type ChangeRowWords = Omit<ChangeRowView, 'title' | 'before' | 'after'> & {
  title: string;
  before: ChangeSideWords | null;
  after: ChangeSideWords | null;
};

function sideWords(side: ChangeSide | null): ChangeSideWords | null {
  if (side === null) return null;
  const { appliesTo, ...rest } = side;
  return appliesTo === undefined ? rest : { ...rest, appliesTo: targetText(appliesTo) };
}

/** `row` as it reads. */
export function rowWords(row: ChangeRowView): ChangeRowWords {
  return { ...row, title: targetText(row.title), before: sideWords(row.before), after: sideWords(row.after) };
}
