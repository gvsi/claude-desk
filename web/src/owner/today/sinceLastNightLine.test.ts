import { describe, expect, it } from 'vitest';

import { sinceLastNightLine, type NightCounts } from './sinceLastNightLine.ts';

const night = (counts: Partial<NightCounts>): NightCounts => ({ conversations: 0, bookings: 0, answers: 0, turned_down: 0, ...counts });

describe('sinceLastNightLine', () => {
  it('says_the_signed_example_exactly', () => {
    expect(sinceLastNightLine(night({ conversations: 3, bookings: 1, answers: 1, turned_down: 1 }))).toBe(
      '3 conversations since last night, all inside your rules. I booked one visit, answered one question and stopped one attempt.',
    );
  });

  it('counts_one_conversation_in_the_singular', () => {
    expect(sinceLastNightLine(night({ conversations: 1, answers: 1 }))).toBe('1 conversation since last night, inside your rules. I answered one question.');
  });

  it('writes_the_plural_past_one', () => {
    expect(sinceLastNightLine(night({ conversations: 7, bookings: 3, answers: 2, turned_down: 2 }))).toBe(
      '7 conversations since last night, all inside your rules. I booked three visits, answered two questions and stopped two attempts.',
    );
  });

  it('leaves_out_the_parts_at_zero', () => {
    // Two parts join with "and"; one stands alone.
    expect(sinceLastNightLine(night({ conversations: 2, bookings: 1, turned_down: 2 }))).toBe(
      '2 conversations since last night, all inside your rules. I booked one visit and stopped two attempts.',
    );
    expect(sinceLastNightLine(night({ conversations: 2, turned_down: 1 }))).toBe('2 conversations since last night, all inside your rules. I stopped one attempt.');
    // Nothing done: the first sentence alone.
    expect(sinceLastNightLine(night({ conversations: 4 }))).toBe('4 conversations since last night, all inside your rules.');
  });

  it('leaves_out_the_conversations_at_zero', () => {
    expect(sinceLastNightLine(night({ bookings: 1, answers: 2 }))).toBe('I booked one visit and answered two questions.');
    // Nothing at all: no line.
    expect(sinceLastNightLine(night({}))).toBeNull();
  });

  it('writes_ten_and_up_in_digits', () => {
    expect(sinceLastNightLine(night({ conversations: 12, bookings: 9, answers: 10, turned_down: 11 }))).toBe(
      '12 conversations since last night, all inside your rules. I booked nine visits, answered 10 questions and stopped 11 attempts.',
    );
  });
});
