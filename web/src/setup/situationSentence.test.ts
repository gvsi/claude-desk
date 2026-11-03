import { expect, it } from 'vitest';
import type { Probe, RuleCard } from '../api/contracts.ts';
import type { RulesDraft, SituationResult } from '../api/views.ts';
import { NO_BUSINESS_TOOLS } from '../owner/connectors/catalog.ts';
import { situationSentence } from './situationSentence.ts';

const words = { business: NO_BUSINESS_TOOLS };
const cards: RuleCard[] = [
  { card_id: 'booking', applies_to: 'native.book', mode: 'auto', who: 'anyone', hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00:00', end: '18:00:00' }, reason: 'Books weekday consults in your hours.' },
  { card_id: 'quote', applies_to: 'native.quote', mode: 'auto', who: 'anyone', reason: 'Quotes at list price.' },
  { card_id: 'docs', applies_to: 'native.release_document', mode: 'ask', who: 'record_owner', reason: 'Documents ask you first.' },
];
const draft: RulesDraft = { version: 1, cards, auto_money_cap_cents: 25_000, diff: null, summary: { on_its_own: [], asks_you: [], never: [] }, proof: { ok: true, method: 'symcc', checks: [] } };
function row(reason_plain: string, card_ids: string[] = []): SituationResult {
  const probe: Probe = { actor: 'agent' as const, who: 'agent' as const, subject_id: null, agent_mandate_remaining_cents: 2000, resource_kind: 'quote', resource_owner: 'none' as const, amount_cents: 2000, starts_at: null, call: { call_id: 'probe', tool: 'native.charge_mandate', args: {} } };
  return { situation: { title: 'An agent pays the retainer', who: 'agent', expected: 'hold', probe }, result: { probe, reason_plain, card_ids, outcome: 'hold', depends_on_review: false }, matches: true };
}
const read = (value: SituationResult) => situationSentence(value, draft, words)?.map((part) => part.key ? `**${part.text}**` : part.text).join('');

it('reads_the_deciding_card_as_rules_does_with_its_actual_hours', () => {
  expect(read(row(cards[0]!.reason, ['booking']))).toBe('Claude can book visits on **weekdays, 8:00 am to 6:00 pm**');
  expect(read(row(cards[2]!.reason, ['docs']))).toBe('Claude asks you before sharing **documents**');
});

it('keeps_the_kernel_words_when_no_single_draft_card_decided', () => {
  // No card: an always-on rule or the payment limit decided it, which the result doesn't name.
  for (const reason of ['Discounts ask you first.', 'Charges ask you first.', 'Private data only to its verified owner.', 'A new kernel reason.']) {
    expect(read(row(reason))).toBeUndefined();
  }
  // A reason that matches a card's own words is still not that card deciding it.
  expect(read(row(cards[0]!.reason))).toBeUndefined();
  expect(read(row(cards[0]!.reason, ['missing-card']))).toBeUndefined();
  expect(read(row(cards[0]!.reason, ['booking', 'quote']))).toBeUndefined();
});
