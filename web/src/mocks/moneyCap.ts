/**
 * A lowered card's reason, as the API writes it (`backend/desk/money_cap.py`, `lowered_reason`):
 * when the payment limit comes down, each rule it brings down gets a sentence built from the new
 * limit in place of its reason, so no rule keeps words that quote its old amount. The sentences
 * and the amount's format are the API's, word for word; moneyCap.test.ts pins them.
 */

/** The languages the API writes a lowered card's reason in (`desk.money_cap.Language`). */
export type Language = 'en' | 'es';

/**
 * The language the API's money-limit route writes it in (`OWNER_LANGUAGE` in desk/api/rules.py):
 * English, since the owner app renders rules copy in English.
 */
export const OWNER_LANGUAGE: Language = 'en';

/** A lowered card's reason above $0, where it still takes or pays out up to the new limit on its own. */
export const LOWERED_REASONS: Readonly<Record<Language, string>> = {
  en: 'Up to {amount}, your payment limit.',
  es: 'Hasta {amount}, tu límite de pago.',
};

/** A lowered card's reason at $0, where it asks instead. */
export const ZERO_REASONS: Readonly<Record<Language, string>> = {
  en: 'Your payment limit is {amount}.',
  es: 'Tu límite de pago es {amount}.',
};

/**
 * A limit as the owner reads it, in either language: "$1,500" for whole dollars, with thousands
 * separators, and cents only when there are some ("$100.50").
 */
export function amount(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${dollars.toLocaleString('en-US')}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** The reason of a card lowered to the payment limit `cap`, in `language`. */
export function loweredReason(cap: number, language: Language): string {
  return (cap ? LOWERED_REASONS : ZERO_REASONS)[language].replace('{amount}', amount(cap));
}
