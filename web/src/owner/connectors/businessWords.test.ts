import { expect, it } from 'vitest';

import type { BusinessToolDef } from '../../api/views.ts';
import { businessGlyph, businessLine, businessRows, businessRulesDescription, isBusinessDef } from './businessWords.ts';

const booking: BusinessToolDef = {
  title: 'Book a free intro call', description: 'Books an intro call.',
  config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 },
};

it('describes Rules intake by its questions and other jobs by their configuration', () => {
  const intake: BusinessToolDef = {
    title: 'Intake', description: 'Asks questions.',
    config: { block: 'intake', questions: ['Which year?', 'For a business?'] },
  };
  expect(businessRulesDescription(intake)).toBe('Asks: Which year? For a business?');
  expect(businessRulesDescription(booking)).toBe(businessLine(booking));
  expect(businessRulesDescription({ ...intake, config: { block: 'unknown' } } as never)).toBeNull();
});

it('describes valid Rules configuration independently of missing or blank business titles', () => {
  for (const title of [undefined, ' ']) {
    expect(businessRulesDescription({ ...booking, title } as BusinessToolDef)).toBe('Free intro call, 20 minutes, in your opening hours');
    expect(businessRulesDescription({
      title, config: { block: 'intake', questions: ['Which year?'] },
    } as BusinessToolDef)).toBe('Asks: Which year?');
  }
  expect(businessRulesDescription(null)).toBeNull();
});

it('describes a booking and follows its starting outcome without a Who row', () => {
  expect(businessLine(booking)).toBe('Free intro call, 20 minutes, in your opening hours');
  expect(businessGlyph(booking.config)).toBe('calendar');
  expect(businessRows(booking, 'auto')).toEqual([
    { label: 'Appointment', value: 'Free intro call' },
    { label: 'Length', value: '20 minutes' },
    { label: 'Uses', value: 'Your opening hours' },
    { label: 'Next for you', value: 'The booking shows in Today, with their answers' },
  ]);
  expect(businessRows(booking, 'ask').at(-1)).toEqual({ label: 'Next for you', value: 'You approve each request in Needs you' });
});

it('omits Next for you for every block when the starting outcome is never', () => {
  const definitions: BusinessToolDef[] = [
    booking,
    { title: 'Intake', description: 'Asks questions.', config: { block: 'intake', questions: ['Which year?'] } },
    { title: 'Deposit', description: 'Takes a deposit.', config: { block: 'purpose_payment', purpose: 'First appointment', amount_cents: 12550 } },
    { title: 'Urgent request', description: 'Alerts Linda.', config: { block: 'urgent', urgent_when: 'A filing deadline is today' } },
  ];
  for (const def of definitions) {
    expect(businessRows(def, 'never')).toEqual(businessRows(def, 'ask').filter((row) => row.label !== 'Next for you'));
  }
});

it('leaves unknown blocks and malformed definitions out rather than drawing partial jobs', () => {
  for (const value of [null, {}, { ...booking, title: ' ' }, { ...booking, description: 12 },
    { ...booking, config: null }, { ...booking, config: { block: 'unknown' } },
    { ...booking, config: { block: 'typed_booking', appointment_type: '', minutes: 20 } },
    { ...booking, config: { block: 'typed_booking', appointment_type: 'Call', minutes: NaN } },
    { ...booking, config: { block: 'intake', questions: ['Question', null] } },
    { ...booking, config: { block: 'purpose_payment', purpose: 'Deposit', amount_cents: -1 } },
    { ...booking, config: { block: 'urgent', urgent_when: ' ' } },
  ]) {
    expect(isBusinessDef(value)).toBe(false);
    expect(businessLine(value as BusinessToolDef)).toBeNull();
    expect(businessRows(value as BusinessToolDef, 'ask')).toEqual([]);
  }
  expect(businessGlyph({ block: 'unknown' } as never)).toBeNull();
});

it('describes an urgent request and how it alerts the owner', () => {
  const def: BusinessToolDef = { title: 'Urgent request', description: 'Alerts Linda.', config: { block: 'urgent', urgent_when: 'A filing deadline is today' } };
  expect(businessLine(def)).toBe('Urgent: A filing deadline is today');
  expect(businessGlyph(def.config)).toBe('clock');
  expect(businessRows(def, 'ask')).toEqual([
    { label: 'Urgent', value: 'A filing deadline is today' }, { label: 'Uses', value: 'Alerts you right away' },
  ]);
});

it('formats a purpose payment in cents with its Stripe setup', () => {
  const def: BusinessToolDef = { title: 'Deposit', description: 'Takes a deposit.', config: { block: 'purpose_payment', purpose: 'First appointment', amount_cents: 12550 } };
  expect(businessLine(def)).toBe('First appointment, $125.50');
  expect(businessGlyph(def.config)).toBe('card');
  expect(businessRows(def, 'ask')).toEqual([
    { label: 'Amount', value: '$125.50' }, { label: 'Uses', value: 'Stripe' },
    { label: 'Next for you', value: 'Each payment shows in Today' },
  ]);
});

it('describes intake with one question or several', () => {
  for (const questions of [['Which year?'], ['Which year?', 'For a business?', 'Who is your bookkeeper?']]) {
    const def: BusinessToolDef = { title: 'Intake', description: 'Asks questions.', config: { block: 'intake', questions } };
    expect(businessLine(def)).toBe(`${questions.length} ${questions.length === 1 ? 'question' : 'questions'} before a booking`);
    expect(businessGlyph(def.config)).toBe('person');
    expect(businessRows(def, 'ask')).toEqual([
      { label: 'Asks', value: questions.join(' ') },
      { label: 'Next for you', value: 'Their answers show on the booking' },
    ]);
  }
});
