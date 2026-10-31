/**
 * `FACT_IN_PROSE`, the matcher behind `expectNoFactsInProse`: every kind of fact that only a card may
 * state is caught, and every signed line of Claude's words on the vision pages passes.
 */
import { describe, expect, it } from 'vitest';

import { FACT_IN_PROSE } from './factInProse.ts';

const FACTS: Record<string, readonly string[]> = {
  money: ['That’s $180.', 'It costs 50 dollars.', 'It’s 180 USD.', 'Son 50 euros.', 'Son 50 €.'],
  discount: ['You get 10% off.', 'You get 10 percent off.', 'I can give you a discount.', 'Tiene un descuento.', 'Un 10 por ciento menos.'],
  date: ['Your visit is on 2026-10-30.', 'See you on 10/30.', 'On 30/10/2026.', 'Due by the 3rd.', 'On November 3.', 'Next Tuesday works.', 'El martes.'],
  time: ['Maria arrives at 2 p.m.', 'At 2pm.', 'At 2:00.', 'Around 10 a.m.'],
  relative: ['It’s ready today.', 'Last week she came.', 'Next time, ask for Maria.', 'Mañana a las dos.'],
  status: ['Your permit was approved.', 'Plan check passed.', 'It was issued.'],
  booking: ['You’re booked.', 'Your booking is set.', 'Your appointment is confirmed.', 'It’s scheduled.', 'Your slot is reserved.', 'Su cita está confirmada.'],
  promise: ['Maria will text you.', 'She’ll be there.', 'I guarantee Maria texts you before arrival.', 'I promise it’s fixed.', 'Maria is going to call you.'],
};

/** Every line of Claude's words on the vision pages, as the owner signed them (2026-10-30). */
const SIGNED = [
  'Here’s Ana’s history. The gate code is on her job card.',
  'Here it is.',
  'I can’t share pay. Payroll is open to Maria and Grace only. Here are your own logged hours.',
  'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  'Welcome back, Dana. How did the drain clearing go?',
  'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  'You’re all set. Here’s your visit.',
  'Thanks, Marcus. Here’s where your kitchen remodel stands.',
  'Here’s what comes next.',
  'I can look that up after you confirm it’s you.',
  'These times are open on the inspection calendar. Which one works for you?',
  'Whether your garage conversion needs a permit is a plan checker’s decision, so I’ve asked one to get back to you.',
];

describe('fact_in_prose', () => {
  for (const [kind, lines] of Object.entries(FACTS)) {
    it(`catches_${kind}`, () => {
      expect(lines.filter((line) => !FACT_IN_PROSE.test(line))).toEqual([]);
    });
  }

  it('passes_every_signed_line', () => {
    expect(SIGNED.filter((line) => FACT_IN_PROSE.test(line))).toEqual([]);
  });
});
