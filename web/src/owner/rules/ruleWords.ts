/**
 * Rules in the owner's words: what a card enforces (`RuleWord`s for `ChangeReview`, `RuleRow` and
 * `ConnectorReview`), what a card applies to, and the payment limit in its signed words.
 */
import type { RuleCard } from '../../api/contracts.ts';
import type { PeopleOut } from '../../api/views.ts';
import type { RuleWord } from '../../ds/index.ts';
import { formatCents, formatHours } from '../../lib/format.ts';
import { NO_BUSINESS_TOOLS, toolDisplayName, type BusinessTools } from '../connectors/catalog.ts';

/**
 * Visiting agents by name, keyed by `agent_key_id`, where the caller has one: "Alex Kim's
 * assistant". An agent chose its own name, so it is untrusted text, shown as text. The API lists
 * no agents yet, so the rules screens pass none and an agent's rule reads "One agent".
 */
export type AgentNames = ReadonlyMap<string, string>;

/** The tool only a visiting agent with a signed limit can use, so a rule on it for anyone is for those agents. */
const SIGNED_LIMIT_TOOL = 'native.charge_mandate';

/** Targets that send money back out, so their record's owner is the customer who paid (a refund). */
const PAID_BACK_TARGETS: ReadonlySet<string> = new Set(['payments.create_refund', 'effect:pay_out']);

/**
 * Targets that touch a customer's private data (the master plan's tool table), which the
 * always-on rules release only to that customer once verified, so a person's rule on one says so.
 */
const PRIVATE_TARGETS: ReadonlySet<string> = new Set(['native.release_document', 'payments.list_charges', 'payments.create_refund', 'effect:private_data']);

/**
 * Who a card is for, in the boards' words, one word or two:
 * - anyone: "Anyone", or "Signed agents" on a charge within a signed limit;
 * - verified: "Verified customers";
 * - the record's owner: "The record's owner, verified", or "The customer who paid, verified" on a refund;
 * - a person: their name once `people` has them ("Dana Whitfield"), else "One customer", then
 *   "Verified" on private data;
 * - an agent: its name in `agents` ("Alex Kim's assistant"), else "One agent".
 */
export function whoWords(card: RuleCard, people: PeopleOut | null | undefined, agents: AgentNames | undefined): RuleWord[] {
  const who = (text: string): RuleWord => ({ field: 'who', text });
  switch (card.who) {
    case 'anyone':
      return [who(card.applies_to === SIGNED_LIMIT_TOOL ? 'Signed agents' : 'Anyone')];
    case 'verified':
      return [who('Verified customers')];
    case 'record_owner':
      return [who(PAID_BACK_TARGETS.has(card.applies_to) ? 'The customer who paid, verified' : "The record's owner, verified")];
    case 'person': {
      const person = people?.people.find((p) => p.person_id === card.person_id);
      const name = person?.display_name.trim() ?? '';
      const named = who(name === '' ? 'One customer' : name);
      return PRIVATE_TARGETS.has(card.applies_to) ? [named, who('Verified')] : [named];
    }
    case 'agent': {
      const name = card.agent_key_id == null ? '' : (agents?.get(card.agent_key_id)?.trim() ?? '');
      return [who(name === '' ? 'One agent' : name)];
    }
    default:
      // A group this build doesn't know is never read as a narrower one.
      return [who('Anyone')];
  }
}

/** A discount in basis points as a percentage: 1000 → "10%", 1250 → "12.5%". */
export function percent(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/**
 * What a card enforces, in the boards' words, each word tagged with its field: who it is for
 * (`whoWords`); its limits (an amount "Up to $300"; a discount "Discounts up to 10%", and "No
 * discounts" on a quote rule that allows none); its hours ("Weekdays, 8:00 am to 6:00 pm"); and
 * "Checked by the reviewer". `people` names a person and `agents` an agent; without them the
 * words say "One customer" or "One agent".
 */
export function ruleWords(card: RuleCard, people: PeopleOut | null | undefined, agents?: AgentNames): RuleWord[] {
  const words: RuleWord[] = whoWords(card, people, agents);
  if (card.max_amount_cents != null) words.push({ field: 'limits', text: `Up to ${formatCents(card.max_amount_cents)}` });
  const discount = card.max_discount_bp ?? 0;
  if (discount > 0) words.push({ field: 'limits', text: `Discounts up to ${percent(discount)}` });
  else if (card.applies_to === 'native.quote') words.push({ field: 'limits', text: 'No discounts' });
  if (card.hours != null) words.push({ field: 'hours', text: formatHours(card.hours) });
  if (card.review === true) words.push({ field: 'review', text: 'Checked by the reviewer' });
  return words;
}

/** Each effect group's words, for a rule on every tool with that effect (`effect:charge`). */
const EFFECT_WORDS: Readonly<Record<string, string>> = {
  charge: 'Every tool that charges money',
  pay_out: 'Every tool that sends money out',
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
export function targetWords(appliesTo: string, business: BusinessTools = NO_BUSINESS_TOOLS): string {
  if (appliesTo.startsWith('effect:')) {
    const effect = appliesTo.slice('effect:'.length);
    return Object.hasOwn(EFFECT_WORDS, effect) ? (EFFECT_WORDS[effect] ?? 'A group of tools') : 'A group of tools';
  }
  return toolDisplayName(appliesTo, business) ?? 'A connected tool';
}

/**
 * The per-payment limit (the baseline's `money_has_amount`), which is also the platform ceiling on
 * the payment limit (`AUTO_MONEY_HARD_CAP_CENTS`, master "Money cap"): $10,000. No limit is set above it.
 */
export const PAYMENT_MAX_CENTS = 1_000_000;

/**
 * The payment limit's field, when it holds more than a single payment may be: `parseLimit`'s answer,
 * and the page's when the API refuses an amount above the platform ceiling.
 */
export const ABOVE_CEILING = `No single payment can be above ${formatCents(PAYMENT_MAX_CENTS)}.`;

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
