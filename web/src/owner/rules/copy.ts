import type { RuleCard } from '../../api/contracts.ts';

/** The Rules header and its loading shapes use the same signed subtitle. */
export const RULES_SUBTITLE = 'What Claude can do, in your words. Each rule names the tools it covers.';

export const RULES_FALLBACK = 'Anything not listed here, Claude asks you first.';

/** All rules' line under its subtitle: who "Checked by the reviewer" means, and that it can only hold. */
export const REVIEWER_LINE = 'The reviewer is a separate model that reads each request before it runs. It can only hold a request for your answer, never let one through.';

/** The owner sees the proposed change before it applies. */
export const COMPOSER_HELPER = 'Claude shows you the change before anything applies.';

/** A quote rule of the owner's that lets anyone get a quote without asking: what Turner's fixed examples change. */
function quotesOnItsOwn(card: RuleCard): boolean {
  return card.applies_to === 'native.quote' && card.mode === 'auto' && card.who === 'anyone' && card.is_default !== true;
}

/** Whether `card` applies on a Saturday or a Sunday: with no hours, it applies every day. */
function coversAWeekend(card: RuleCard): boolean {
  const hours = card.hours ?? null;
  return hours === null || hours.days.some((day) => day === 'sat' || day === 'sun');
}

/**
 * Turner's fixed examples, in order, each with whether the active rules' `cards` already have its
 * change, so it isn't offered again: no quote goes out on its own on a weekend, or quotes go out
 * on their own up to $600 (Turner's own all-days, uncapped quote rule has neither).
 */
const FIXED_CHIPS: readonly { text: string; inEffect: (cards: readonly RuleCard[]) => boolean }[] = [
  { text: 'Stop quoting on weekends', inEffect: (cards) => !cards.some((card) => quotesOnItsOwn(card) && coversAWeekend(card)) },
  { text: 'Quote water heater installs up to $600', inEffect: (cards) => cards.some((card) => quotesOnItsOwn(card) && card.max_amount_cents === 60_000) },
];

/** Turner's fixed examples' words, in order; a current held request may add its own question. */
export const RULES_CHIPS: readonly string[] = FIXED_CHIPS.map((chip) => chip.text);

/**
 * Turner's fixed examples whose change isn't in effect under the active rules' `cards`, in order;
 * all of them while the rules are still being read (`undefined`), so the first load is unchanged.
 */
export function rulesChipsToOffer(cards: readonly RuleCard[] | undefined): readonly string[] {
  return cards === undefined ? RULES_CHIPS : FIXED_CHIPS.filter((chip) => !chip.inEffect(cards)).map((chip) => chip.text);
}

/** The connector list's summary, for the version the API names. */
export function rulesVersionLine(version: number): string {
  return `Version ${version} of your rules, checked against the always-on rules`;
}
