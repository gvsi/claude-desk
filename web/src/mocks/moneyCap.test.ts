/**
 * A lowered card's reason in the mock, as the API writes it (`backend/desk/money_cap.py`): the
 * sentences, the amount in them and the language the money-limit route picks, copied from there
 * and from its tests (`backend/tests/kernel/test_money_cap.py`), so the mock can't drift from them.
 */
import { describe, expect, it } from 'vitest';

import { LOWERED_REASONS, OWNER_LANGUAGE, ZERO_REASONS, amount, loweredReason, type Language } from './moneyCap.ts';

describe('the reason of a card lowered to the payment limit', () => {
  it('is_one_of_the_apis_sentences', () => {
    // money_cap.py's LOWERED_REASONS (above $0) and ZERO_REASONS (at $0), word for word.
    expect(LOWERED_REASONS).toEqual({ en: 'Up to {amount}, your payment limit.', es: 'Hasta {amount}, tu límite de pago.' });
    expect(ZERO_REASONS).toEqual({ en: 'Your payment limit is {amount}.', es: 'Tu límite de pago es {amount}.' });
    // The API's money-limit route writes it in English, the language the owner app renders rules
    // copy in (`OWNER_LANGUAGE` in backend/desk/api/rules.py).
    expect(OWNER_LANGUAGE).toBe('en');
  });

  it('states_the_new_limit_in_either_language', () => {
    // test_a_lowered_card_states_its_new_limit's table.
    const sentences: [Language, number, string][] = [
      ['en', 150_000, 'Up to $1,500, your payment limit.'],
      ['es', 150_000, 'Hasta $1,500, tu límite de pago.'],
      ['en', 10_050, 'Up to $100.50, your payment limit.'],
      ['es', 10_050, 'Hasta $100.50, tu límite de pago.'],
      ['en', 10_000, 'Up to $100, your payment limit.'],
      ['es', 10_000, 'Hasta $100, tu límite de pago.'],
      ['en', 5, 'Up to $0.05, your payment limit.'],
      ['es', 5, 'Hasta $0.05, tu límite de pago.'],
      ['en', 0, 'Your payment limit is $0.'],
      ['es', 0, 'Tu límite de pago es $0.'],
    ];
    for (const [language, cap, sentence] of sentences) expect(loweredReason(cap, language), `${language} ${cap}`).toBe(sentence);
  });

  it('writes_the_amount_in_whole_dollars_and_cents_only_when_there_are_some', () => {
    // money_cap.amount: "$1,500" for whole dollars, with thousands separators, and cents only when
    // there are some ("$100.50"), the same in both languages. The values are its own, from
    // `f"${dollars:,}" + (f".{rest:02d}" if rest else "")`.
    const amounts: [number, string][] = [
      [150_000, '$1,500'],
      [10_050, '$100.50'],
      [10_000, '$100'],
      [100, '$1'],
      [5, '$0.05'],
      [1, '$0.01'],
      [0, '$0'],
      [1_000_000, '$10,000'],
      [123_456_789, '$1,234,567.89'],
    ];
    for (const [cents, written] of amounts) expect(amount(cents), String(cents)).toBe(written);
  });
});
