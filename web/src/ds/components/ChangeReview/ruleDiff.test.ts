import { describe, expect, test } from 'vitest';

import type { RuleCard } from '../../../api/contracts.ts';
import { ruleDiff } from './ruleDiff.ts';

function card(fields: Partial<RuleCard> & Pick<RuleCard, 'card_id'>): RuleCard {
  return {
    applies_to: 'native.quote',
    mode: 'auto',
    who: 'anyone',
    person_id: null,
    agent_key_id: null,
    max_amount_cents: null,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    reason: 'Quotes from your price list.',
    ...fields,
  };
}

describe('ruleDiff', () => {
  test('same_reason_new_limit_is_changed', () => {
    const before = [card({ card_id: 'rv-quote', max_discount_bp: 1000, reason: 'Quotes with a small discount.' })];
    const after = [card({ card_id: 'rv-quote', max_discount_bp: 5000, reason: 'Quotes with a small discount.' })];
    expect(ruleDiff(before, after)).toEqual([
      { cardId: 'rv-quote', change: 'changed', before: before[0], after: after[0], fields: ['limits'] },
    ]);
  });

  test('defaults_and_unchanged_are_omitted', () => {
    const quote = card({ card_id: 'rv-quote' });
    const defaultBefore = card({ card_id: 'default:native.book', applies_to: 'native.book', mode: 'ask', is_default: true });
    // A default the compiler re-derived differently, and one that appeared, are not the owner's changes.
    const defaultAfter = { ...defaultBefore, reason: 'Not covered by a rule yet, so it asks you.' };
    const newDefault = card({ card_id: 'default:native.capture_lead', applies_to: 'native.capture_lead', mode: 'ask', is_default: true });
    expect(ruleDiff([quote, defaultBefore], [{ ...quote }, defaultAfter, newDefault])).toEqual([]);
    expect(ruleDiff([], [])).toEqual([]);
  });

  test('added_and_removed_rows', () => {
    const kept = card({ card_id: 'rv-quote' });
    const removed = card({ card_id: 'rv-book-sat', applies_to: 'native.book', reason: 'Saturday morning bookings.' });
    const added = card({ card_id: 'rv-book-sun', applies_to: 'native.book', mode: 'never', reason: 'No bookings on Sundays.' });
    expect(ruleDiff([kept, removed], [kept, added])).toEqual([
      { cardId: 'rv-book-sat', change: 'removed', before: removed, after: null, fields: [] },
      { cardId: 'rv-book-sun', change: 'added', before: null, after: added, fields: [] },
    ]);
  });

  test('subject_change_is_who', () => {
    const before = card({ card_id: 'rv-dana', who: 'person', person_id: 'per-dana' });
    const after = card({ card_id: 'rv-dana', who: 'person', person_id: 'per-bob' });
    expect(ruleDiff([before], [after]).map((row) => row.fields)).toEqual([['who']]);

    // Each field by its own name, in a fixed order, and an absent optional field equals its default.
    const wide = card({
      card_id: 'rv-wide',
      applies_to: 'effect:change',
      mode: 'ask',
      who: 'verified',
      max_amount_cents: 2000,
      hours: { days: ['sat'], start: '09:00:00', end: '13:00:00' },
      review: true,
      reason: 'Something else.',
    });
    expect(ruleDiff([card({ card_id: 'rv-wide' })], [wide])[0]?.fields).toEqual([
      'applies_to',
      'mode',
      'who',
      'limits',
      'hours',
      'review',
      'reason',
    ]);
    const sparse = { card_id: 'rv-sparse', applies_to: 'native.quote', mode: 'auto', who: 'anyone', reason: 'Quotes.' } satisfies RuleCard;
    expect(ruleDiff([sparse], [card({ card_id: 'rv-sparse', reason: 'Quotes.' })])).toEqual([]);
  });
});
