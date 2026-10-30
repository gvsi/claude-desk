import { describe, expect, test } from 'vitest';

import type { Effect, RuleCard, ToolName } from '../../../api/contracts.ts';
import { reviewChanges } from './reviewChanges.ts';

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
    reason: 'Quotes from your price list, at list price.',
    ...fields,
  };
}

/** Each tool's effects, as the master plan's tool table lists them. */
const EFFECTS: Partial<Record<ToolName, Effect[]>> = {
  'native.quote': ['change'],
  'native.book': ['change'],
  'native.payment_link': ['charge'],
  'payments.list_charges': ['private_data'],
  'payments.create_refund': ['pay_out', 'private_data'],
};
const effectsOf = (tool: ToolName): readonly Effect[] => EFFECTS[tool] ?? [];

type Hours = NonNullable<RuleCard['hours']>;

/** A booking window, on weekdays unless `days` says otherwise. */
function window(start: string, end: string, days: Hours['days'] = ['mon', 'tue', 'wed', 'thu', 'fri']): Hours {
  return { days, start, end };
}

const presetWeekdays = card({ card_id: 'preset-book-weekday', applies_to: 'native.book', hours: window('09:00:00', '17:00:00'), review: true, reason: 'Weekday bookings in working hours, checked by the reviewer.' });
const presetCharge = card({ card_id: 'preset-charge-ask', applies_to: 'effect:charge', mode: 'ask', max_discount_bp: 0, reason: 'Taking a payment asks you first.' });

describe('reviewChanges', () => {
  test('a_dropped_card_goes_to_the_draft_card_that_covers_its_whole_scope', () => {
    // A payment link for anyone falls under the draft's rule for every tool that charges money.
    const link = card({ card_id: 'rv-link', applies_to: 'native.payment_link', max_amount_cents: 30000, reason: 'Payment links up to $300.' });
    // Weekday bookings from 10 to 12 for verified people sit inside the draft's weekday 9-to-5 rule for anyone.
    const narrow = card({ card_id: 'rv-book-late-morning', applies_to: 'native.book', who: 'verified', hours: window('10:00:00', '12:00:00'), reason: 'Late-morning bookings for verified customers.' });
    expect(reviewChanges([link, narrow], [presetCharge, presetWeekdays], effectsOf)).toEqual([
      { change: 'changed', before: link, after: presetCharge, fields: ['applies_to', 'mode', 'limits', 'reason'] },
      { change: 'changed', before: narrow, after: presetWeekdays, fields: ['who', 'hours', 'review', 'reason'] },
    ]);
  });

  test('a_scope_the_draft_does_not_cover_falls_to_the_default_ask', () => {
    // Saturdays, a person at any time, and weekday hours wider than the draft's all ask under it.
    const saturday = card({ card_id: 'rv-book-sat', applies_to: 'native.book', hours: window('09:00:00', '13:00:00', ['sat']), reason: 'Saturday morning bookings.' });
    const dana = card({ card_id: 'rv-dana-book', applies_to: 'native.book', who: 'person', person_id: 'per-dana', reason: 'Dana can book without asking you.' });
    const wide = card({ card_id: 'rv-book-wk', applies_to: 'native.book', hours: window('08:00:00', '18:00:00'), reason: 'Weekday bookings in opening hours.' });
    // A tool nothing in the draft governs at all.
    const charges = card({ card_id: 'rv-charges', applies_to: 'payments.list_charges', who: 'record_owner', reason: 'Customers see their own charges.' });
    // A rule that already asks keeps its outcome, so nothing is tagged.
    const refund = card({ card_id: 'rv-refund', applies_to: 'payments.create_refund', mode: 'ask', who: 'record_owner', reason: 'Refunds wait for your answer.' });
    expect(reviewChanges([saturday, dana, wide, charges, refund], [presetWeekdays], effectsOf).slice(0, 5)).toEqual([
      { change: 'changed', before: saturday, after: null, fields: ['mode'] },
      { change: 'changed', before: dana, after: null, fields: ['mode'] },
      { change: 'changed', before: wide, after: null, fields: ['mode'] },
      { change: 'changed', before: charges, after: null, fields: ['mode'] },
      { change: 'changed', before: refund, after: null, fields: [] },
    ]);
  });

  test('a_draft_card_nothing_maps_to_is_added_and_one_something_maps_to_is_not', () => {
    const link = card({ card_id: 'rv-link', applies_to: 'native.payment_link', reason: 'Payment links.' });
    const saturday = card({ card_id: 'rv-book-sat', applies_to: 'native.book', hours: window('09:00:00', '13:00:00', ['sat']), reason: 'Saturday morning bookings.' });
    // The charge rule governs the dropped payment link, so it shows as that row's After, not as an
    // added row; the weekday rule covers nothing dropped, so it is added.
    expect(reviewChanges([link, saturday], [presetCharge, presetWeekdays], effectsOf)).toEqual([
      { change: 'changed', before: link, after: presetCharge, fields: ['applies_to', 'mode', 'reason'] },
      { change: 'changed', before: saturday, after: null, fields: ['mode'] },
      { change: 'added', before: null, after: presetWeekdays, fields: [] },
    ]);
  });

  test('a_pair_identical_but_for_its_id_has_no_row_and_is_not_added', () => {
    const quote = card({ card_id: 'rv-quote' });
    const presetQuote = card({ card_id: 'preset-quote' });
    expect(reviewChanges([quote], [presetQuote], effectsOf)).toEqual([]);
  });

  test('cards_kept_by_id_are_diffed_and_defaults_are_left_out', () => {
    // A card the draft keeps by its id is a change only where it differs; the compiler's defaults never show.
    const quote = card({ card_id: 'rv-quote' });
    const wider = { ...quote, max_discount_bp: 1000, reason: 'Quotes with up to 10% off.' };
    const kept = card({ card_id: 'preset-find-slots', applies_to: 'native.find_slots', reason: 'Anyone can see the times you have open.' });
    const fallback = card({ card_id: 'default:native.book', applies_to: 'native.book', mode: 'ask', is_default: true, reason: 'Not covered.' });
    expect(reviewChanges([quote, kept, fallback], [wider, { ...kept }, { ...fallback, reason: 'Re-derived.' }], effectsOf)).toEqual([
      { change: 'changed', before: quote, after: wider, fields: ['limits', 'reason'] },
    ]);
  });

  test('the_most_specific_covering_card_wins', () => {
    // Dana's own booking rule in the draft governs her dropped rule ahead of the rule for anyone.
    const dana = card({ card_id: 'rv-dana-book', applies_to: 'native.book', who: 'person', person_id: 'per-dana', reason: 'Dana can book without asking you.' });
    const danaAsks = card({ card_id: 'dana-asks', applies_to: 'native.book', mode: 'ask', who: 'person', person_id: 'per-dana', max_discount_bp: 0, reason: 'Dana asks first.' });
    const anyoneAsks = card({ card_id: 'anyone-asks', applies_to: 'native.book', mode: 'ask', reason: 'Bookings ask you first.' });
    const rows = reviewChanges([dana], [anyoneAsks, danaAsks], effectsOf);
    expect(rows[0]).toEqual({ change: 'changed', before: dana, after: danaAsks, fields: ['mode', 'reason'] });
    expect(rows[1]).toEqual({ change: 'added', before: null, after: anyoneAsks, fields: [] });
  });
});
