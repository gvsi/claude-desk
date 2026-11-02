/** Business tool titles throughout a rules change, including shared coverage and turned-on rows. */
import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { rowWords } from '../../test/changeRowWords.ts';
import { changeRows as changeRowViews } from './changeRows.ts';
import type { RuleDraft } from './drafts.ts';

/** The review's rows as they read: titles and targets in words (`rowWords`). */
const changeRows = (...args: Parameters<typeof changeRowViews>) => changeRowViews(...args).map(rowWords);

/** A plain automatic rule, with no scope or limits beyond its target. */
function card(card_id: string, applies_to: string, mode: RuleCard['mode'] = 'auto'): RuleCard {
  return { card_id, applies_to, mode, who: 'anyone', reason: 'The owner allows this.', max_discount_bp: 0, review: false };
}

/** A draft whose card changes and turned-on tools are given by the test. */
function draft(before: RuleCard[], after: RuleCard[], turnedOn: RuleDraft['turnedOn'] = []): RuleDraft {
  return { version: 2, before, after, proof: null, summary: null, moneyCap: null, preset: null, turnedOn };
}

it('reads changed, new and removed rules as Claude-led sentences', () => {
  const link = { ...card('link', 'native.payment_link'), max_amount_cents: 30_000 };
  const refund = card('refund', 'payments.create_refund', 'ask');
  const quote = card('quote', 'native.quote');
  const rows = changeRowViews(draft([link, quote], [{ ...link, max_amount_cents: 10_000 }, refund]), null);
  const changed = rows.find((row) => row.key === 'link');
  expect(changed?.before?.sentence?.parts.map((part) => part.text).join('')).toBe('Claude can send payment links up to $300');
  expect(changed?.after?.sentence).toMatchObject({ meta: { tools: { titles: ['Payment link'] }, who: 'Anyone' } });
  expect(changed?.after?.sentence?.parts.map((part) => part.text).join('')).toBe('Claude can send payment links up to $100');
  expect(rows.find((row) => row.key === 'refund')).toMatchObject({ change: 'added', before: null, after: { sentence: { parts: [{ text: 'Claude asks you before ' }, { text: 'any refund', key: true }] } } });
  expect(rows.find((row) => row.key === 'quote')).toMatchObject({ change: 'removed', after: null });
});

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

it('an added rule follows the changed rows of its own tool', () => {
  // Weekday and Saturday bookings go to the default ask, and a 9-to-5 weekday booking rule comes in
  // beside them; Payment link's rule is reworded. The added booking rule reads with the booking rows
  // it replaces, before Payment link's, not after every changed row.
  const weekdays: NonNullable<RuleCard['hours']> = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00:00', end: '18:00:00' };
  const bookWeekdays: RuleCard = { ...card('book-weekdays', 'native.book'), hours: weekdays };
  const bookSaturday: RuleCard = { ...card('book-saturday', 'native.book'), hours: { days: ['sat'], start: '09:00:00', end: '12:00:00' } };
  const nineToFive: RuleCard = { ...card('book-nine-to-five', 'native.book'), hours: { ...weekdays, start: '09:00:00', end: '17:00:00' } };
  const link = card('link', 'native.payment_link');
  const rows = changeRows(draft([bookWeekdays, bookSaturday, link], [nineToFive, { ...link, reason: 'Payment links go through.' }]), null);
  expect(rows.map((row) => [row.key, row.change, row.title])).toEqual([
    ['book-weekdays', 'removed', 'Book a visit'],
    ['book-saturday', 'removed', 'Book a visit'],
    ['book-nine-to-five', 'added', 'Book a visit'],
    ['link', 'changed', 'Payment link'],
  ]);
});

it('names tools by their titles, each apart, and a group of tools in the app’s own words', () => {
  // A tool's title is its own words (a business's from setup), so the review shows each one as user
  // text: the rows keep the titles apart rather than joined into one string.
  const before = card('shared', 'effect:change');
  const [row] = changeRowViews(draft([before], [{ ...before, mode: 'ask' }]), null, chenBusinessTools);
  expect(row).toMatchObject({
    title: { titles: ['Book a free intro call', 'New client intake'] },
    before: { appliesTo: { titles: ['Book a free intro call'] } },
    after: { appliesTo: { titles: ['Book a free intro call', 'New client intake'] } },
  });
  expect(row?.before?.sentence?.meta?.tools).toEqual({ titles: ['Book a free intro call'] });
  expect(row?.after?.sentence?.meta?.tools).toEqual({ titles: ['Book a free intro call', 'New client intake'] });
  // A rule moved to a group of tools names the group in the app's words.
  const link = card('link', 'native.payment_link');
  const [moved] = changeRowViews(draft([link], [{ ...link, applies_to: 'effect:charge' }]), null);
  expect(moved).toMatchObject({ title: { titles: ['Payment link'] }, before: { appliesTo: { titles: ['Payment link'] } }, after: { appliesTo: 'Every tool that charges money' } });
  // A tool turned on is named by its title too.
  const intro = chenBusinessTools[0];
  if (!intro) throw new Error('Chen has an intro call tool');
  expect(changeRowViews(draft([], [], [intro]), null).at(-1)).toMatchObject({ change: 'turned_on', title: { titles: ['Book a free intro call'] } });
});
