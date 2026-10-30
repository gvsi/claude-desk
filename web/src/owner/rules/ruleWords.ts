/**
 * Rules in the owner's words: what a card enforces (`RuleWord`s for `ChangeReview`, `RuleRow` and
 * `ConnectorReview`), what a card applies to, and the payment limit in its signed words.
 */
import type { RuleCard, ToolName } from '../../api/contracts.ts';
import type { PeopleOut } from '../../api/views.ts';
import type { RuleWord } from '../../ds/index.ts';
import { formatCents, formatHours } from '../../lib/format.ts';
import { toolWords } from '../connectors/catalog.ts';

/** Who a card is for. A person is named once `people` has them; an agent is never named here. */
function whoWords(card: RuleCard, people: PeopleOut | null | undefined): string {
  switch (card.who) {
    case 'anyone':
      return 'Anyone';
    case 'verified':
      return 'Verified customers';
    case 'record_owner':
      return 'Only the customer it belongs to';
    case 'person': {
      const person = people?.people.find((p) => p.person_id === card.person_id);
      const name = person?.display_name.trim() ?? '';
      return name === '' ? 'Only this customer' : `Only ${name}`;
    }
    case 'agent':
      return 'Only this agent';
    default:
      // A group this build doesn't know is never read as a narrower one.
      return 'Anyone';
  }
}

/** A discount in basis points as a percentage: 1000 → "10%", 1250 → "12.5%". */
function percent(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/**
 * What a card enforces, each word tagged with its field: who it is for; its limits (an amount
 * "Up to $300"; a discount "Discounts up to 10%", and "No discounts" on a quote rule that allows
 * none); its hours; and Claude's second look. `people` names a person ("Only Dana Whitfield");
 * while it loads or fails the words say "Only this customer".
 */
export function ruleWords(card: RuleCard, people: PeopleOut | null | undefined): RuleWord[] {
  const words: RuleWord[] = [{ field: 'who', text: whoWords(card, people) }];
  if (card.max_amount_cents != null) words.push({ field: 'limits', text: `Up to ${formatCents(card.max_amount_cents)}` });
  const discount = card.max_discount_bp ?? 0;
  if (discount > 0) words.push({ field: 'limits', text: `Discounts up to ${percent(discount)}` });
  else if (card.applies_to === 'native.quote') words.push({ field: 'limits', text: 'No discounts' });
  if (card.hours != null) words.push({ field: 'hours', text: formatHours(card.hours) });
  if (card.review === true) words.push({ field: 'review', text: 'Claude takes a second look first' });
  return words;
}

/** Each effect group's words, for a rule on every tool with that effect (`effect:charge`). */
const EFFECT_WORDS: Readonly<Record<string, string>> = {
  charge: 'Every tool that charges money',
  pay_out: 'Every tool that moves money out',
  private_data: 'Every tool that touches private data',
  send_message: 'Every tool that sends a message out',
  change: 'Every tool that changes something',
  read: 'Every tool that only reads',
};

/**
 * What a card applies to, in the owner's words: a tool's name ("Payment link"), or an effect
 * group's ("Every tool that charges money"). A target this build doesn't know is named plainly,
 * never by its raw name.
 */
export function targetWords(appliesTo: string): string {
  if (appliesTo.startsWith('effect:')) {
    const effect = appliesTo.slice('effect:'.length);
    return Object.hasOwn(EFFECT_WORDS, effect) ? (EFFECT_WORDS[effect] ?? 'A group of tools') : 'A group of tools';
  }
  return toolWords(appliesTo as ToolName)?.name ?? 'A connected tool';
}

/**
 * The per-payment limit (the baseline's `money_has_amount`), which is also the platform ceiling on
 * the payment limit (`AUTO_MONEY_HARD_CAP_CENTS`, master "Money cap"): $10,000. No limit is set above it.
 */
export const PAYMENT_MAX_CENTS = 1_000_000;

/**
 * The payment limit in the signed words (N-Conn-19, N-Conn-19b, N-Conn-20): the most Claude takes
 * or pays out in one action without asking, whatever the rules say. "no payment over $1,000
 * without asking you"; at 0, "every payment asks you first".
 */
export function moneyCapWords(cents: number): string {
  return cents <= 0 ? 'every payment asks you first' : `no payment over ${formatCents(cents)} without asking you`;
}

/** The limit's line atop Payments and Stripe on Rules, and in setup's rules step. */
export function moneyLimitLine(cents: number): string {
  return cents <= 0 ? 'Every payment asks you first.' : `No payment over ${formatCents(cents)} goes through without asking you, whatever the rules below say.`;
}

/** The hint under the limit's field: whole dollars, and what it is now. */
export function moneyLimitHint(cents: number): string {
  return `Whole dollars, from 0 to 10,000. Now ${cents <= 0 ? 'every payment asks you first' : formatCents(cents)}.`;
}
