/**
 * Each rule as one sentence led by Claude, with its key values set off, and the line under it that
 * names the tools it covers and who: the REV-RULES-C1 board's rows for Turner Plumbing, word for word.
 */
import { describe, expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import type { PeopleOut, ToolRow } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { NO_BUSINESS_TOOLS, businessTools, type BusinessTools } from '../connectors/catalog.ts';
import {
  ALWAYS_ON_SENTENCES,
  canJoin,
  discountHoldSentence,
  holdLine,
  holdMeta,
  holdRows,
  holdSentence,
  moneyCapMeta,
  moneyCapSentence,
  moneyCapToolSentence,
  moneyCapBandSentence,
  ACROSS_DESK_SENTENCES,
  ruleMeta,
  ruleQualifiers,
  ruleSentence,
  type RuleMeta,
  type SentencePart,
} from './ruleSentence.ts';

const cards = rivera.ruleCards;
const words = { business: NO_BUSINESS_TOOLS };

it('the money band leads its rules with the payment limit, over the rules below it', () => {
  expect(read(moneyCapBandSentence(50_000))).toBe('Claude asks you before any payment over **$500**, whatever the rules below say');
  expect(read(moneyCapBandSentence(0))).toBe('Claude asks you before any payment');
});

it('the C4 money cap has its compact sentence, including the unset cap', () => {
  expect(read(moneyCapToolSentence(50_000))).toBe('Any payment over **$500** asks you first');
  expect(read(moneyCapToolSentence(0))).toBe('Any payment asks you first');
});

/** The sentence as the board reads it, each key part between `**`. */
function read(parts: readonly SentencePart[]): string {
  return parts.map((part) => (part.key === true ? `**${part.text}**` : part.text)).join('');
}

/** The meta line as the board reads it: the tools, then " · " and who. */
function line(meta: RuleMeta): string {
  const tools = typeof meta.tools === 'string' ? meta.tools : listed(meta.tools.titles);
  return `${tools} · ${meta.who}`;
}

function listed(titles: readonly string[]): string {
  if (titles.length <= 1) return titles[0] ?? '';
  return `${titles.slice(0, -1).join(', ')} and ${titles.at(-1) ?? ''}`;
}

describe('the C1 rows', () => {
  it('quote_at_list_price', () => {
    expect(read(ruleSentence(cards['rv-quote'], words))).toBe('Claude can send quotes from your price list, at **list price**');
    expect(line(ruleMeta(cards['rv-quote'], words))).toBe('Quote · Anyone');
  });

  it('payment_links_up_to_their_limit', () => {
    expect(read(ruleSentence(cards['rv-link'], words))).toBe('Claude can send payment links up to **$300**');
    expect(line(ruleMeta(cards['rv-link'], words))).toBe('Payment link · Anyone');
  });

  it('agent_payments_from_a_signed_limit', () => {
    expect(read(ruleSentence(cards['rv-mandate'], words))).toBe('Claude can take a visiting agent’s payment, up to **$20**, from its signed limit');
    expect(line(ruleMeta(cards['rv-mandate'], words))).toBe('Charge within a signed limit · Anyone');
  });

  it('bookings_in_their_hours', () => {
    expect(read(ruleSentence(cards['rv-book-wk'], words))).toBe('Claude can book visits on **weekdays, 8:00 am to 6:00 pm**');
    expect(read(ruleSentence(cards['rv-book-sat'], words))).toBe('Claude can book visits on **Saturdays, 9:00 am to 1:00 pm**');
    expect(line(ruleMeta(cards['rv-book-sat'], words))).toBe('Book a visit · Anyone');
  });

  it('a_refund_asks_first', () => {
    expect(read(ruleSentence(cards['rv-refund'], words))).toBe('Claude asks you before **any refund**');
    expect(line(ruleMeta(cards['rv-refund'], words))).toBe('Refund · The customer, once verified');
  });
});

/** A card with every field the API sends at its default. */
function card(fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode' | 'who'> & Partial<RuleCard>): RuleCard {
  return { person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false, reason: 'A rule.', ...fields };
}

describe('conditions', () => {
  it('a_discount_reads_up_to_its_percent_off', () => {
    const discounted = card({ card_id: 'q', applies_to: 'native.quote', mode: 'auto', who: 'anyone', max_discount_bp: 1000 });
    expect(read(ruleSentence(discounted, words))).toBe('Claude can send quotes from your price list with up to **10%** off');
  });
});

/** The starter cards C1 joins with Turner's own, as the seed has them (`mocks/seed.ts`). */
const findSlots = card({ card_id: 'preset-find-slots', applies_to: 'native.find_slots', mode: 'auto', who: 'anyone' });
const captureLead = card({ card_id: 'preset-capture-lead', applies_to: 'native.capture_lead', mode: 'auto', who: 'anyone' });
const requestCallback = card({ card_id: 'preset-request-callback', applies_to: 'native.request_callback', mode: 'auto', who: 'anyone' });
const urgent = card({ card_id: 'rv-urgent', applies_to: 'desk.emergency-callback', mode: 'auto', who: 'anyone' });

/** Turner's urgent business tool, as setup lists it. */
const turnerBusiness = new Map([
  ['desk.emergency-callback', { title: 'Emergency callback', description: 'Asks Mike to call back urgently.', config: { block: 'urgent', urgent_when: 'A burst pipe' } }],
] as const);
const turnerWords = { business: turnerBusiness };

/** Turner's money tools, in the connectors' order. */
const MONEY_TOOLS: readonly Pick<ToolRow, 'tool' | 'effects'>[] = [
  { tool: 'native.payment_link', effects: ['charge'] },
  { tool: 'native.charge_mandate', effects: ['charge'] },
  { tool: 'payments.list_charges', effects: ['private_data'] },
  { tool: 'payments.create_refund', effects: ['pay_out', 'private_data'] },
];

describe('the C1 rows that join several tools', () => {
  it('open_times_join_the_weekday_bookings_in_the_same_hours', () => {
    const weekdayOpenTimes = { ...findSlots, hours: cards['rv-book-wk'].hours };
    const row = [weekdayOpenTimes, cards['rv-book-wk']];
    expect(canJoin(row)).toBe(true);
    expect(read(ruleSentence(row, words))).toBe('Claude can book visits on **weekdays, 8:00 am to 6:00 pm**');
    expect(line(ruleMeta(row, words))).toBe('Find open times and Book a visit · Anyone');
  });

  it('leads_and_callbacks_urgent_ones_too', () => {
    const row = [captureLead, requestCallback, urgent];
    expect(read(ruleSentence(row, turnerWords))).toBe('Claude can take leads and callbacks, urgent ones too');
    expect(line(ruleMeta(row, turnerWords))).toBe('Save a lead, Request a callback and Emergency callback · Anyone');
  });

  it('documents_and_charges_for_the_verified_customer', () => {
    // Who it is for is on the line under it, not in the sentence.
    const row = [cards['rv-docs'], cards['rv-charges']];
    expect(read(ruleSentence(row, words))).toBe('Claude can share customers’ own documents and charges');
    expect(line(ruleMeta(row, words))).toBe('Share a document and See charges · The customer, once verified');
  });
});

describe('the C1 rows that ask first', () => {
  it('any_discount_past_a_list_price_quote', () => {
    expect(read(discountHoldSentence(cards['rv-quote']) ?? [])).toBe('Claude asks you before **any discount**');
    const discounted = card({ card_id: 'q', applies_to: 'native.quote', mode: 'auto', who: 'anyone', max_discount_bp: 1000 });
    expect(read(discountHoldSentence(discounted) ?? [])).toBe('Claude asks you before discounts over **10%**');
    expect(discountHoldSentence(cards['rv-link'])).toBeNull();
  });

  it('one_sentence_for_every_limit', () => {
    const limited = [cards['rv-link'], cards['rv-mandate']];
    expect(read(holdSentence([cards['rv-quote'], ...limited]) ?? [])).toBe('Claude asks you before payment links over **$300** or agent payments over **$20**');
    // Each limit keeps its own amount, and past a limit the owner is asked whoever it is for.
    expect(line(holdMeta([cards['rv-quote'], ...limited], words) ?? { tools: '', who: '' })).toBe('Payment link and Charge within a signed limit · Anyone');
    expect(holdSentence([cards['rv-quote'], cards['rv-refund']])).toBeNull();
    expect(holdMeta([cards['rv-quote'], cards['rv-refund']], words)).toBeNull();
    // Under each limited rule on its own, as C4 draws it.
    expect(read(holdLine(cards['rv-link']) ?? [])).toBe('Over **$300**, Claude asks you first');
    expect(holdLine(cards['rv-quote'])).toBeNull();
  });

  it('the_payment_limit', () => {
    expect(read(moneyCapSentence(50_000))).toBe('Claude asks you before any payment over **$500**, whatever the other rules say');
    expect(read(moneyCapSentence(0))).toBe('Claude asks you before any payment');
    expect(line(moneyCapMeta({ business: NO_BUSINESS_TOOLS, tools: MONEY_TOOLS }))).toBe('Payment link, Charge within a signed limit and Refund · Anyone');
  });
});

describe('the always-on rules', () => {
  it('are_c1s_never_rows', () => {
    expect(ALWAYS_ON_SENTENCES.map((rule) => `${read(rule.parts)} / ${line(rule.meta)}`)).toEqual([
      "Claude never says it's anything but an AI / Every tool · Everyone",
      'Claude never shows private data to anyone but its verified owner / Share a document and See charges · Everyone',
      'Claude never sends a code anywhere but the contact on record / Confirm it’s them · Everyone',
      'Claude never moves money without your rule or a signed limit / Payment link, Charge within a signed limit and Refund · Everyone',
    ]);
  });
});

describe('any tool', () => {
  it('a_business_tool_reads_claude_can_use_its_title', () => {
    // A job that isn't the Desk's urgent one reads by its own title.
    const intake: BusinessTools = new Map([['desk.new-client-intake', { title: 'New client intake', description: 'Asks new clients three questions.', config: { block: 'intake', questions: ['Which tax years?'] } }]]);
    const job = { ...urgent, card_id: 'intake', applies_to: 'desk.new-client-intake' };
    const parts = ruleSentence(job, { business: intake });
    expect(read(parts)).toBe('Claude can use new client intake');
    // Its title is its own words, set off as user text inside the sentence.
    expect(parts.filter((part) => part.user === true).map((part) => part.text)).toEqual(['new client intake']);
    expect(line(ruleMeta(job, { business: intake }))).toBe('New client intake · Anyone');
    expect(read(ruleSentence({ ...job, mode: 'ask' }, { business: intake }))).toBe('Claude asks you before using new client intake');
    expect(read(ruleSentence({ ...job, mode: 'never' }, { business: intake }))).toBe('Claude never uses new client intake');
    // An acronym keeps its capitals.
    const sms: BusinessTools = new Map([['desk.sms-reminder', { title: 'SMS reminder', description: 'Texts a reminder.', config: { block: 'intake', questions: ['x'] } }]]);
    expect(read(ruleSentence({ ...urgent, applies_to: 'desk.sms-reminder' }, { business: sms }))).toBe('Claude can use SMS reminder');
  });

  it('a_job_whose_title_starts_with_a_verb_reads_as_what_claude_does', () => {
    // REV-SETUP-1 and -3: "Claude asks you before sending **a retainer link**", not "using send a retainer link".
    const jobs: BusinessTools = new Map([
      ['desk.intro-call', { title: 'Book a free intro call', description: '', config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 } }],
      ['desk.retainer', { title: 'Send a retainer link', description: '', config: { block: 'purpose_payment', purpose: 'Retainer', amount_cents: 50_000 } }],
      ['desk.intake', { title: 'Ask new clients three questions', description: '', config: { block: 'intake', questions: ['x'] } }],
    ]);
    const job = (applies_to: string, mode: RuleCard['mode']) => ruleSentence({ ...urgent, card_id: applies_to, applies_to, mode }, { business: jobs });
    expect(read(job('desk.intro-call', 'auto'))).toBe('Claude can book a free intro call');
    expect(read(job('desk.intro-call', 'ask'))).toBe('Claude asks you before booking **a free intro call**');
    expect(read(job('desk.intro-call', 'never'))).toBe('Claude never books a free intro call');
    expect(read(job('desk.retainer', 'ask'))).toBe('Claude asks you before sending **a retainer link**');
    expect(read(job('desk.intake', 'ask'))).toBe('Claude asks you before asking **new clients three questions**');
    // The rest of the title is still the owner's own words, set off as user text.
    expect(job('desk.retainer', 'ask').filter((part) => part.user === true).map((part) => part.text)).toEqual(['a retainer link']);
    // The actual hours follow, as for any booking.
    const hours = cards['rv-book-wk'].hours;
    expect(read(ruleSentence({ ...urgent, applies_to: 'desk.intro-call', hours }, { business: jobs }))).toBe('Claude can book a free intro call on **weekdays, 8:00 am to 6:00 pm**');
  });

  it('an_unknown_tool_never_shows_its_raw_name', () => {
    for (const applies_to of ['native.teleport', 'desk.not-listed', 'mcp.secret_tool']) {
      const unknown = card({ card_id: 'u', applies_to, mode: 'auto', who: 'anyone' });
      const sentence = read(ruleSentence(unknown, words));
      expect(sentence).toBe("A rule for a tool this version can't name");
      expect(sentence).not.toContain('Claude can');
      expect(sentence).not.toContain(applies_to);
      expect(line(ruleMeta(unknown, words))).toBe('A connected tool · Anyone');
    }
  });

  it('any_tool_listed_on_the_desk_keeps_its_outcome_but_an_unlisted_target_does_not', () => {
    // The Desk lists these tools, so a rule on one still reads as what Claude does, in the app's words for it,
    // whatever its namespace: a business tool without a title, a tool from a newer catalog, a connector's own.
    const rows = [
      { tool: 'desk.untitled', source: 'business', business: null, effects: [] },
      { tool: 'native.teleport', source: 'native', business: null, effects: [] },
      { tool: 'mcp.secret_tool', source: 'mcp', business: null, effects: [] },
    ] as unknown as Pick<ToolRow, 'tool' | 'source' | 'business' | 'effects'>[];
    const onDesk = { business: businessTools(rows), tools: rows };
    for (const applies_to of ['desk.untitled', 'native.teleport', 'mcp.secret_tool']) {
      const listed = card({ card_id: 'l', applies_to, mode: 'auto', who: 'anyone' });
      expect(read(ruleSentence(listed, onDesk)), applies_to).toBe('Claude can use a connected tool');
      expect(read(ruleSentence({ ...listed, mode: 'ask' }, onDesk)), applies_to).toBe('Claude asks you before using a connected tool');
      expect(read(ruleSentence({ ...listed, mode: 'never' }, onDesk)), applies_to).toBe('Claude never uses a connected tool');
      expect(line(ruleMeta(listed, onDesk)), applies_to).toBe('A connected tool · Anyone');
    }
    // A target the Desk doesn't list describes a stored rule, never a present capability, in every mode.
    for (const applies_to of ['desk.not-listed', 'native.not-listed', 'effect:teleport']) {
      for (const mode of ['auto', 'ask', 'never'] as const) {
        const unknown = card({ card_id: 'x', applies_to, mode, who: 'anyone' });
        expect(read(ruleSentence(unknown, onDesk)), `${applies_to} ${mode}`).toBe("A rule for a tool this version can't name");
      }
    }
  });

  it('a_never_rule_reads_claude_never', () => {
    const neverQuote = card({ card_id: 'n', applies_to: 'native.quote', mode: 'never', who: 'anyone' });
    expect(read(ruleSentence(neverQuote, words))).toBe('Claude never sends quotes from your price list');
    const neverSearch = card({ card_id: 'n', applies_to: 'native.web_search', mode: 'never', who: 'anyone' });
    expect(read(ruleSentence(neverSearch, words))).toBe('Claude never searches the web');
  });

  it('a_rule_on_an_effect_group_names_the_tools_it_covers', () => {
    const charges = card({ card_id: 'c', applies_to: 'effect:charge', mode: 'ask', who: 'anyone' });
    expect(read(ruleSentence(charges, words))).toBe('Claude asks you before **any payment**');
    expect(line(ruleMeta(charges, { business: NO_BUSINESS_TOOLS, tools: MONEY_TOOLS }))).toBe('Payment link and Charge within a signed limit · Anyone');
    // Without the Desk's tools, its group in the app's words.
    expect(ruleMeta(charges, words).tools).toBe('Every tool that charges money');
  });

  it('every_day_hours_drop_on', () => {
    const always = card({ card_id: 'b', applies_to: 'native.book', mode: 'auto', who: 'anyone', hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00:00', end: '00:00:00' } });
    expect(read(ruleSentence(always, words))).toBe('Claude can book visits **every day, all day**');
  });

  it('a_person_rule_names_them', () => {
    const verified = card({ card_id: 'v', applies_to: 'native.book', mode: 'auto', who: 'verified' });
    expect(read(ruleSentence(verified, words))).toBe('Claude can book visits');
    expect(line(ruleMeta(verified, words))).toBe('Book a visit · The customer, once verified');
  });
});

describe('cards that read as one rule', () => {
  const quote = card({ card_id: 'q', applies_to: 'native.quote', mode: 'auto', who: 'anyone' });
  const book = card({ card_id: 'b', applies_to: 'native.book', mode: 'auto', who: 'anyone' });

  /** Each way a row of cards can't read as one rule, with the cards that differ. */
  const apart: [string, RuleCard[]][] = [
    ['differing modes', [quote, { ...book, mode: 'ask' }]],
    ['differing audiences', [book, { ...cards['rv-docs'] }]],
    ['one person and another', [{ ...book, who: 'person', person_id: 'p-1' }, { ...quote, who: 'person', person_id: 'p-2' }]],
    ['anyone and signed agents', [{ ...cards['rv-link'], max_amount_cents: null }, { ...cards['rv-mandate'], max_amount_cents: null }]],
    ['differing limits', [cards['rv-link'], cards['rv-mandate']]],
    ['a limit and none', [cards['rv-link'], { ...cards['rv-link'], card_id: 'x', applies_to: 'effect:charge', max_amount_cents: null }]],
    ['differing discounts', [quote, { ...quote, card_id: 'q2', applies_to: 'desk.intro-call', max_discount_bp: 1000 }]],
    ['differing hours', [findSlots, cards['rv-book-wk']]],
  ];

  it.each(apart)('%s_never_join_silently', (_, row) => {
    expect(canJoin(row)).toBe(false);
    expect(() => ruleSentence(row, words)).toThrow(/can't read as one rule/);
    expect(() => ruleMeta(row, words)).toThrow(/can't read as one rule/);
  });

  it('the_c1_rows_that_join_still_do', () => {
    expect(canJoin([captureLead, requestCallback, urgent])).toBe(true);
    expect(canJoin([cards['rv-docs'], cards['rv-charges']])).toBe(true);
    expect(canJoin([cards['rv-link']])).toBe(true);
  });
});

describe('holds keep their audience', () => {
  const people: PeopleOut = { people: [{ person_id: 'per-dana', display_name: 'Dana Whitfield', masked_contact: 'd•••@example.com' }], leads: [] };
  const withPeople = { business: NO_BUSINESS_TOOLS, people };
  const danaLink = card({ card_id: 'dana-link', applies_to: 'native.payment_link', mode: 'auto', who: 'person', person_id: 'per-dana', max_amount_cents: 5000 });

  it('a_public_limit_and_a_persons_limit_are_two_holds', () => {
    // The kernel's hold twin keeps its card's audience: another customer's $100 link runs under the
    // public $300 rule, so Dana's $50 hold is hers alone, never "anyone over $50".
    const rows = holdRows([cards['rv-link'], danaLink], withPeople);
    expect(rows.map((row) => `${read(row.parts)} / ${line(row.meta)}`)).toEqual([
      'Claude asks you before payment links over **$300** / Payment link · Anyone',
      'Claude asks you before payment links over **$50** / Payment link · Dana Whitfield',
    ]);
    // The one-sentence forms never join them: they refuse holds for different people.
    expect(() => holdSentence([cards['rv-link'], danaLink])).toThrow(/different people/);
    expect(() => holdMeta([cards['rv-link'], danaLink], withPeople)).toThrow(/different people/);
  });

  it('limits_for_the_same_people_still_join', () => {
    const rows = holdRows([cards['rv-quote'], cards['rv-link'], cards['rv-mandate']], words);
    expect(rows.map((row) => `${read(row.parts)} / ${line(row.meta)}`)).toEqual([
      'Claude asks you before payment links over **$300** or agent payments over **$20** / Payment link and Charge within a signed limit · Anyone',
    ]);
    expect(holdRows([cards['rv-quote']], words)).toEqual([]);
  });
});

describe('an effect rule names only the tools it governs', () => {
  const STRIPE_TOOLS: readonly Pick<ToolRow, 'tool' | 'effects'>[] = [
    { tool: 'native.payment_link', effects: ['charge'] },
    { tool: 'payments.list_charges', effects: ['private_data'] },
    { tool: 'payments.create_refund', effects: ['pay_out', 'private_data'] },
  ];
  const payOut = card({ card_id: 'pay-out', applies_to: 'effect:pay_out', mode: 'auto', who: 'anyone' });
  const privateData = card({ card_id: 'private', applies_to: 'effect:private_data', mode: 'auto', who: 'anyone' });

  it('an_automatic_rule_alone_doesnt_cover_a_tool_with_another_effect', () => {
    // Refund also touches private data, so an automatic pay-out rule alone governs nothing.
    expect(ruleMeta(payOut, { business: NO_BUSINESS_TOOLS, tools: STRIPE_TOOLS, cards: [payOut] }).tools).toBe('Every tool that sends money out');
    // Without the Desk's other cards, it is read alone, the same way.
    expect(ruleMeta(payOut, { business: NO_BUSINESS_TOOLS, tools: STRIPE_TOOLS }).tools).toBe('Every tool that sends money out');
  });

  it('with_an_automatic_rule_for_every_effect_it_covers_the_tool', () => {
    const both = { business: NO_BUSINESS_TOOLS, tools: STRIPE_TOOLS, cards: [payOut, privateData] };
    expect(line(ruleMeta(payOut, both))).toBe('Refund · Anyone');
    expect(line(ruleMeta(privateData, both))).toBe('See charges and Refund · Anyone');
  });

  it('an_ask_rule_covers_every_tool_with_its_effect', () => {
    const ask = { ...payOut, mode: 'ask' as const };
    expect(line(ruleMeta(ask, { business: NO_BUSINESS_TOOLS, tools: STRIPE_TOOLS, cards: [ask] }))).toBe('Refund · Anyone');
  });
});

describe('never rows over several tools', () => {
  it('each_action_reads_claude_never', () => {
    const neverQuote = card({ card_id: 'nq', applies_to: 'native.quote', mode: 'never', who: 'anyone' });
    const neverBook = card({ card_id: 'nb', applies_to: 'native.book', mode: 'never', who: 'anyone' });
    expect(read(ruleSentence([neverQuote, neverBook], words))).toBe('Claude never sends quotes from your price list and books visits');
  });
});

describe("the rule cell's second line (REV-RULES-D, v354)", () => {
  it('the_audience_reads_anyone_or_the_customer_once_verified', () => {
    // One set of words on every screen: anyone, signed agents included, is "Anyone"; a verified
    // customer and the record's owner, a refund's payer included, are "The customer, once verified".
    expect(ruleQualifiers(cards['rv-quote'], words)).toBe('Anyone');
    expect(ruleQualifiers({ ...cards['rv-mandate'], max_amount_cents: null }, words)).toBe('Anyone');
    expect(ruleQualifiers(cards['rv-docs'], words)).toBe('The customer, once verified');
    expect(ruleQualifiers(cards['rv-refund'], words)).toBe('The customer, once verified');
    expect(ruleQualifiers(card({ card_id: 'v', applies_to: 'native.book', mode: 'auto', who: 'verified' }), words)).toBe('The customer, once verified');
    // A person keeps their name, verified on private data; an agent its own.
    const people: PeopleOut = { people: [{ person_id: 'per-dana', display_name: 'Dana Whitfield', masked_contact: 'd•••@example.com' }], leads: [] };
    const dana = card({ card_id: 'd', applies_to: 'native.release_document', mode: 'auto', who: 'person', person_id: 'per-dana' });
    expect(ruleQualifiers(dana, { ...words, people })).toBe('Dana Whitfield, verified');
    expect(ruleQualifiers(card({ card_id: 'a', applies_to: 'native.book', mode: 'auto', who: 'agent', agent_key_id: 'k' }), words)).toBe('One agent');
  });

  it('names_no_tool_and_reads_the_reviewer_and_a_hold_as_qualifiers', () => {
    // The tool heads the cell, so the line under its sentence names none.
    expect(ruleQualifiers(cards['rv-link'], words)).toBe('Anyone · Checked by the reviewer · Over $300, it asks you first');
    expect(ruleQualifiers(cards['rv-book-wk'], words)).toBe('Anyone · Checked by the reviewer');
    // An automatic rule's limit asks past it; one that asks or never runs has no hold.
    expect(ruleQualifiers({ ...cards['rv-link'], mode: 'ask', max_amount_cents: null, review: false }, words)).toBe('Anyone');
    expect(ruleQualifiers({ ...cards['rv-mandate'], review: false }, words)).toBe('Anyone · Over $20, it asks you first');
  });

  it('the_desk_wide_rules_are_the_ai_disclosure_and_the_log', () => {
    expect(ACROSS_DESK_SENTENCES.map((rule) => [rule.key, read(rule.parts), rule.line ?? null])).toEqual([
      ['ai', 'Claude always says it’s an AI', 'In every reply'],
      ['log', 'Claude logs every request, allowed or not, and shows it to you in Safety', null],
    ]);
  });
});

describe("option A's sentences (REV-RULES-D and REV-SETUP-3, signed)", () => {
  const anyone = (applies_to: string, mode: RuleCard['mode'], fields: Partial<RuleCard> = {}) => card({ card_id: `a:${applies_to}`, applies_to, mode, who: 'anyone', ...fields });

  it('reads_each_built_in_tool_in_the_boards_words', () => {
    expect(read(ruleSentence(anyone('native.find_slots', 'auto'), words))).toBe('Claude can show the times you have open');
    expect(read(ruleSentence(anyone('native.capture_lead', 'auto'), words))).toBe('Claude can take a name and a way to reach them');
    expect(read(ruleSentence(anyone('native.request_callback', 'auto'), words))).toBe('Claude can take callback requests');
    expect(read(ruleSentence(anyone('native.start_verification', 'auto'), words))).toBe('Claude can send a code when someone asks to confirm it’s them');
    expect(read(ruleSentence(cards['rv-docs'], words))).toBe('Claude can share customers’ **own documents**');
    expect(read(ruleSentence(cards['rv-charges'], words))).toBe('Claude can show customers **their own charges**');
    expect(read(ruleSentence(cards['rv-link'], words))).toBe('Claude can send payment links up to **$300**');
    expect(read(ruleSentence(cards['rv-refund'], words))).toBe('Claude asks you before **any refund**');
    expect(read(ruleSentence(cards['rv-quote'], words))).toBe('Claude can send quotes from your price list, at **list price**');
  });

  it('a_signed_limit_payment_reads_its_limit_or_the_signed_limit', () => {
    // The agent's own signed limit bounds it; a card's amount, when it has one, is set off.
    expect(read(ruleSentence(cards['rv-mandate'], words))).toBe('Claude can take a visiting agent’s payment, up to **$20**, from its signed limit');
    expect(read(ruleSentence(anyone('native.charge_mandate', 'auto'), words))).toBe('Claude can take a visiting agent’s payment within **its signed limit**');
  });

  it('asks_in_the_setup_boards_words', () => {
    expect(read(ruleSentence(anyone('native.quote', 'ask'), words))).toBe('Claude asks you before **any quote**');
    expect(read(ruleSentence(anyone('native.payment_link', 'ask'), words))).toBe('Claude asks you before sending **payment links**');
    expect(read(ruleSentence(anyone('native.release_document', 'ask'), words))).toBe('Claude asks you before sharing **documents**');
    expect(read(ruleSentence(anyone('payments.list_charges', 'ask'), words))).toBe('Claude asks you before showing customers **their own charges**');
    expect(read(ruleSentence(anyone('native.book', 'ask', { hours: { days: ['sat'], start: '09:00:00', end: '13:00:00' } }), words))).toBe('Claude asks you before booking on **Saturdays, 9:00 am to 1:00 pm**');
  });

  it('an_urgent_job_reads_as_urgent_callbacks_whatever_its_title', () => {
    expect(read(ruleSentence(urgent, turnerWords))).toBe('Claude can take **urgent callbacks**, which alert you at once');
    expect(read(ruleSentence({ ...urgent, mode: 'ask' }, turnerWords))).toBe('Claude asks you before taking **urgent callbacks**');
    expect(read(ruleSentence({ ...urgent, mode: 'never' }, turnerWords))).toBe('Claude never takes **urgent callbacks**');
    // Its own title still names it, above and on the meta line.
    expect(line(ruleMeta(urgent, turnerWords))).toBe('Emergency callback · Anyone');
  });

  it('says_who_only_on_the_line_under_the_sentence', () => {
    // The verified customer is on the cell's second line ("The customer, once verified"), so the
    // sentence no longer says it.
    const verified = card({ card_id: 'v', applies_to: 'native.book', mode: 'auto', who: 'verified' });
    expect(read(ruleSentence(verified, words))).toBe('Claude can book visits');
    expect(ruleQualifiers(verified, words)).toBe('The customer, once verified');
    for (const sentence of [cards['rv-docs'], cards['rv-charges']].map((each) => read(ruleSentence(each, words)))) {
      expect(sentence).not.toContain('confirmed');
    }
  });
});
