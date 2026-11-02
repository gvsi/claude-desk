/**
 * The rule a held or turned-down request names, as B5 draws it: the held card's "Your rule" and
 * Safety's "The rule that turned it down", each one rule sentence with its outcome. A request names
 * a rule only when the active rules hold one that decided it; it never invents one.
 */
import { describe, expect, it } from 'vitest';

import type { Decision, RuleCard } from '../../api/contracts.ts';
import type { Attempt, PeopleOut } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { NO_BUSINESS_TOOLS } from '../connectors/catalog.ts';
import { heldRule, turnedDownRule, type NamedRule } from './requestRule.ts';
import type { RuleMeta, SentencePart } from './ruleSentence.ts';

const cards = rivera.ruleCards;
const active: RuleCard[] = Object.values(cards);
const words = { business: NO_BUSINESS_TOOLS, cards: active };

/** The sentence as the board reads it, each key part between `**`. */
function read(parts: readonly SentencePart[]): string {
  return parts.map((part) => (part.key === true ? `**${part.text}**` : part.text)).join('');
}

/** The meta line as the board reads it: the tools, then " · " and who. */
function line(meta: RuleMeta): string {
  const tools = typeof meta.tools === 'string' ? meta.tools : meta.tools.titles.join(' and ');
  return `${tools} · ${meta.who}`;
}

/** A named rule as one line: its sentence, its meta and its outcome. */
function shown(rule: NamedRule | null): string | null {
  return rule === null ? null : `${read(rule.parts)} / ${line(rule.meta)} / ${rule.outcome}`;
}

function card(fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode' | 'who'> & Partial<RuleCard>): RuleCard {
  return { person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false, reason: 'A rule.', ...fields };
}

/** The seeded held quote with its action changed. */
function heldWith(action: Partial<NonNullable<Decision['action']>>, cardIds: string[]): Decision {
  const decision = rivera.decisions.held;
  if (decision.action === null) throw new Error('the held quote has an action');
  return { ...decision, card_ids: cardIds, action: { ...decision.action, ...action } };
}

/** A payment link of `cents`, held. */
const heldLink = (cents: number, cardIds = ['rv-link']) =>
  heldWith({ tool: 'native.payment_link', effects: ['charge'], list_cents: null, discount_bp: null, amount_cents: cents }, cardIds);

describe('heldRule', () => {
  it('a_discount_past_a_list_price_quote_is_b5s_any_discount', () => {
    // B5: the seeded hold, 15% off a drain clearing, went past the list-price quote rule.
    expect(shown(heldRule({ decision: rivera.decisions.held, held_by: null }, active, words))).toBe(
      'Claude asks you before **any discount** / Quote · Anyone / ask',
    );
  });

  it('an_ask_card_is_found_by_its_reason', () => {
    const refund = { decision: rivera.heldRefund, held_by: cards['rv-refund'].reason };
    expect(shown(heldRule(refund, active, words))).toBe('Claude asks you before **any refund** / Refund · The customer who paid, verified / ask');
  });

  it('past_an_amount_limit_is_the_rules_hold_line', () => {
    expect(shown(heldRule({ decision: heldLink(45_000), held_by: null }, active, words))).toBe(
      'Claude asks you before payment links over **$300** / Payment link · Anyone / ask',
    );
  });

  it('a_persons_limit_keeps_the_person', () => {
    // Dana's own limit held it: the line names her, never widens it to anyone.
    const danas = card({ card_id: 'rv-dana-link', applies_to: 'native.payment_link', mode: 'auto', who: 'person', person_id: rivera.people.dana.personId, max_amount_cents: 50_000 });
    const people: PeopleOut = { people: [{ person_id: rivera.people.dana.personId, display_name: rivera.people.dana.name, masked_contact: rivera.people.dana.maskedContact }], leads: [] };
    const withDana = [...active, danas];
    const held = { decision: heldLink(60_000, ['rv-dana-link', 'rv-link']), held_by: null };
    expect(shown(heldRule(held, withDana, { ...words, cards: withDana, people }))).toBe(
      `Claude asks you before payment links over **$500** / Payment link · ${rivera.people.dana.name} / ask`,
    );
  });

  it('a_rule_on_the_tools_effect_counts', () => {
    const charges = card({ card_id: 'rv-charges-all', applies_to: 'effect:charge', mode: 'auto', who: 'anyone', max_amount_cents: 10_000 });
    const held = { decision: heldLink(15_000, ['rv-charges-all']), held_by: null };
    expect(read(heldRule(held, [...active, charges], { ...words, cards: [...active, charges] })?.parts ?? [])).toBe('Claude asks you before payments over **$100**');
  });

  it('never_invents_a_rule', () => {
    // A rule the active version no longer has, by its reason.
    expect(heldRule({ decision: rivera.heldRefund, held_by: 'Refunds wait for you.' }, active, words)).toBeNull();
    // An automatic card of that reason isn't the one that asked.
    expect(heldRule({ decision: rivera.decisions.held, held_by: cards['rv-quote'].reason }, active, words)).toBeNull();
    // Within the rule's limit, or past one the owner has since raised.
    expect(heldRule({ decision: heldLink(20_000), held_by: null }, active, words)).toBeNull();
    // Past a limit, but the hold doesn't name that rule.
    expect(heldRule({ decision: heldLink(45_000, []), held_by: null }, active, words)).toBeNull();
    // A quote at list price held by something else.
    expect(heldRule({ decision: heldWith({ discount_bp: 0, amount_cents: 18_000 }, ['rv-quote']), held_by: null }, active, words)).toBeNull();
    // No action to read a limit from.
    expect(heldRule({ decision: { ...rivera.decisions.held, action: null }, held_by: null }, active, words)).toBeNull();
  });
});

describe('heldRule picks the card that decided the hold first', () => {
  // As the kernel's `hold_decider` and the API's `holding_card` pick it: the most specific card
  // behind the hold (a person's or an agent's, then a tool's own, then a shared one), an ask card
  // winning a tie. Only then is its sentence built, so a less specific card never stands in for it.
  const dana = rivera.people.dana;
  const people: PeopleOut = { people: [{ person_id: dana.personId, display_name: dana.name, masked_contact: dana.maskedContact }], leads: [] };
  const weekdays = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00:00', end: '18:00:00' } satisfies RuleCard['hours'];

  it('a_persons_hours_rule_decides_over_a_general_limit', () => {
    // A $450 weekend request from Dana: her own weekday rule up to $500 held it for its hours, which
    // the box doesn't word; the general $300 limit stands behind the hold too, but didn't decide it.
    const danas = card({ card_id: 'rv-dana-link', applies_to: 'native.payment_link', mode: 'auto', who: 'person', person_id: dana.personId, max_amount_cents: 50_000, hours: weekdays });
    const withDana = [...active, danas];
    expect(heldRule({ decision: heldLink(45_000, ['rv-dana-link', 'rv-link']), held_by: null }, withDana, { ...words, cards: withDana, people })).toBeNull();
  });

  it('the_most_specific_ask_card_of_that_reason', () => {
    // Two ask cards with the same words: one on every payment for anyone, one on payment links for
    // Dana. Dana's is more specific, so it decided, whichever comes first.
    const shared = card({ card_id: 'a-charges', applies_to: 'effect:charge', mode: 'ask', who: 'anyone', reason: 'Payments wait for you.' });
    const danas = card({ card_id: 'b-dana-link', applies_to: 'native.payment_link', mode: 'ask', who: 'person', person_id: dana.personId, reason: 'Payments wait for you.' });
    const both = [...active, shared, danas];
    const held = { decision: heldLink(45_000, ['a-charges', 'b-dana-link']), held_by: 'Payments wait for you.' };
    expect(shown(heldRule(held, both, { ...words, cards: both, people }))).toBe(`Claude asks you before **any payment link** / Payment link · ${dana.name} / ask`);
  });

  it('a_persons_automatic_limit_decides_over_a_shared_ask_card', () => {
    // Dana's own $500 limit outranks the shared ask card on every payment, so past it, her limit's
    // hold line names the rule (and Needs you names no ask card's reason).
    const shared = card({ card_id: 'a-charges', applies_to: 'effect:charge', mode: 'ask', who: 'anyone', reason: 'Payments wait for you.' });
    const danas = card({ card_id: 'rv-dana-link', applies_to: 'native.payment_link', mode: 'auto', who: 'person', person_id: dana.personId, max_amount_cents: 50_000 });
    const both = [...active, shared, danas];
    expect(shown(heldRule({ decision: heldLink(60_000, ['a-charges', 'rv-dana-link']), held_by: null }, both, { ...words, cards: both, people }))).toBe(
      `Claude asks you before payment links over **$500** / Payment link · ${dana.name} / ask`,
    );
  });

  it('an_ask_card_wins_a_tie_with_an_automatic_rules_hold', () => {
    const asks = card({ card_id: 'z-link-ask', applies_to: 'native.payment_link', mode: 'ask', who: 'anyone', reason: 'Big links wait for you.' });
    const withAsk = [...active, asks];
    const held = { decision: heldLink(45_000, ['rv-link', 'z-link-ask']), held_by: 'Big links wait for you.' };
    expect(shown(heldRule(held, withAsk, { ...words, cards: withAsk }))).toBe('Claude asks you before **any payment link** / Payment link · Anyone / ask');
  });

  it('an_ask_card_of_that_reason_only_on_the_requests_tool', () => {
    // The hold's own cards are gone from the active rules: an ask card with the same words on
    // another tool is not the rule that held it.
    const elsewhere = card({ card_id: 'q-ask', applies_to: 'native.quote', mode: 'ask', who: 'anyone', reason: 'Payments wait for you.' });
    const withIt = [...active, elsewhere];
    expect(heldRule({ decision: heldLink(45_000, ['gone']), held_by: 'Payments wait for you.' }, withIt, { ...words, cards: withIt })).toBeNull();
    // On the request's tool, it is.
    const onIt = card({ card_id: 'l-ask', applies_to: 'native.payment_link', mode: 'ask', who: 'anyone', reason: 'Payments wait for you.' });
    const withBoth = [...withIt, onIt];
    expect(read(heldRule({ decision: heldLink(45_000, ['gone']), held_by: 'Payments wait for you.' }, withBoth, { ...words, cards: withBoth })?.parts ?? [])).toBe(
      'Claude asks you before **any payment link**',
    );
  });
});

/** A turned-down request with `fields`. */
function refused(fields: Partial<Attempt>): Attempt {
  return {
    ref_id: 'dec-refused',
    kind: 'refused',
    reason_plain: "A visitor asked for Dana Whitfield's invoice without confirming who they are.",
    card_ids: [],
    origin: 'kernel',
    created_at: '2026-10-31T16:41:00Z',
    triage: null,
    ledger_seq: 9,
    cause: null,
    from_the_visitor: null,
    ...fields,
  };
}

describe('turnedDownRule', () => {
  it('private_data_is_b5s_always_on_rule', () => {
    for (const cause of ['not_verified', 'not_their_record'] as const) {
      expect(shown(turnedDownRule(refused({ cause, card_ids: ['baseline'] }), active, words)), cause).toBe(
        'Claude never shows private data to anyone but its verified owner / Share a document and See charges · Everyone / never',
      );
    }
  });

  it('codes_and_signed_limits_are_their_always_on_rules', () => {
    expect(read(turnedDownRule(refused({ cause: 'recipient' }), active, words)?.parts ?? [])).toBe('Claude never sends a code anywhere but the contact on record');
    expect(read(turnedDownRule(refused({ cause: 'agent_limit' }), active, words)?.parts ?? [])).toBe('Claude never moves money without your rule or a signed limit');
  });

  it('an_owner_never_rule_by_its_card', () => {
    const never = card({ card_id: 'rv-no-refunds', applies_to: 'payments.create_refund', mode: 'never', who: 'anyone' });
    const withNever = [...active, never];
    expect(shown(turnedDownRule(refused({ cause: 'owner_rule', card_ids: ['rv-no-refunds'] }), withNever, { ...words, cards: withNever }))).toBe(
      'Claude never sends refunds / Refund · Anyone / never',
    );
  });

  it('never_invents_a_rule', () => {
    // A never rule the active version no longer has.
    expect(turnedDownRule(refused({ cause: 'owner_rule', card_ids: ['rv-no-refunds'] }), active, words)).toBeNull();
    // A card of that ID that doesn't say never.
    expect(turnedDownRule(refused({ cause: 'owner_rule', card_ids: ['rv-refund'] }), active, words)).toBeNull();
    // A check with no rule of its own, or no cause at all.
    for (const cause of ['no_such_slot', 'agent_pay_out', 'no_amount', 'other_copy', 'no_rule', null] as const) {
      expect(turnedDownRule(refused({ cause }), active, words), String(cause)).toBeNull();
    }
    // Anything but a turned-down request.
    expect(turnedDownRule(refused({ kind: 'reply_blocked', cause: 'not_verified' }), active, words)).toBeNull();
    expect(turnedDownRule(refused({ kind: 'held', cause: 'not_verified' }), active, words)).toBeNull();
  });
});
