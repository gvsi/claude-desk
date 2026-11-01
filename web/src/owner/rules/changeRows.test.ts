/** Business tool titles throughout a rules change, including shared coverage and turned-on rows. */
import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { changeRows } from './changeRows.ts';
import type { RuleDraft } from './drafts.ts';

/** A plain automatic rule, with no scope or limits beyond its target. */
function card(card_id: string, applies_to: string, mode: RuleCard['mode'] = 'auto'): RuleCard {
  return { card_id, applies_to, mode, who: 'anyone', reason: 'The owner allows this.', max_discount_bp: 0, review: false };
}

/** A draft whose card changes and turned-on tools are given by the test. */
function draft(before: RuleCard[], after: RuleCard[], turnedOn: RuleDraft['turnedOn'] = []): RuleDraft {
  return { version: 2, before, after, proof: null, summary: null, moneyCap: null, preset: null, turnedOn };
}

it('names business tools in added rules and shared coverage', () => {
  const intro = card('intro', 'desk.intro-call');
  const shared = card('shared', 'effect:change');
  const rows = changeRows(draft([], [intro, shared]), null, chenBusinessTools);
  expect(rows.find((row) => row.key === 'intro')?.title).toBe('Book a free intro call');
  expect(rows.find((row) => row.key === 'shared')).toMatchObject({ title: 'Book a free intro call', shared: true });
});

it('names business tools on both sides when shared coverage changes', () => {
  const before = card('shared', 'effect:change');
  const after = { ...before, mode: 'ask' as const };
  const [row] = changeRows(draft([before], [after]), null, chenBusinessTools);
  expect(row).toMatchObject({
    title: 'Book a free intro call and New client intake',
    before: { appliesTo: 'Book a free intro call' },
    after: { appliesTo: 'Book a free intro call and New client intake' },
  });
});

it('names a retargeted rule and a turned-on business tool', () => {
  const before = card('intro', 'native.quote');
  const after = { ...before, applies_to: 'desk.intro-call' };
  const intro = chenBusinessTools[0];
  if (!intro) throw new Error('Chen has an intro call tool');
  const rows = changeRows(draft([before], [after], [intro]), null);
  expect(rows[0]).toMatchObject({ before: { appliesTo: 'Quote' }, after: { appliesTo: 'Book a free intro call' } });
  expect(rows.find((row) => row.change === 'turned_on')).toMatchObject({ title: 'Book a free intro call' });
  expect(rows.find((row) => row.change === 'turned_on')?.connector).toBeUndefined();
});
