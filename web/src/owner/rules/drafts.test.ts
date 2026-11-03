/**
 * A rule draft as the owner reviews it: what changes (before and after, by card), the payment
 * limit in its signed words, the rules' check in plain words, and the rows `ChangeReview` shows.
 */
import { describe, expect, it } from 'vitest';

import type { ProofReport, RuleCard } from '../../api/contracts.ts';
import { RULES_UNAVAILABLE_COPY } from '../../api/http.ts';
import type { PeopleOut, PolicyVersionOut, RulesDraft, ToolRow } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { formatHours } from '../../lib/format.ts';
import { PRESETS, RIVERA_HOURS, presetCards } from '../../mocks/seed.ts';
import { connectorByKey } from '../connectors/catalog.ts';
import { rowWords } from '../../test/changeRowWords.ts';
import { DEFAULT_SIDE, cancelsLinksFor, changeRows as changeRowViews } from './changeRows.ts';
import { checkStatus } from './checkStatus.ts';
import { capOf, draftFromAnswer, draftFromDiff, draftFromVersion, moneyCapChange } from './drafts.ts';
import { hubSections } from './hub.ts';
import { PAYMENT_MAX_CENTS, moneyCapWords, moneyLimitHint, moneyLimitLine, ruleWords, type AgentNames } from './ruleWords.ts';

/** The review's rows as they read: titles and targets in words (`rowWords`). */
const changeRows = (...args: Parameters<typeof changeRowViews>) => changeRowViews(...args).map(rowWords);

const { ruleCards } = rivera;
const DANA = rivera.people.dana;

/** Turner's own cards, in the seed's order. */
const RIVERA_CARDS: RuleCard[] = Object.values(ruleCards);

const CHECKED: ProofReport = {
  ok: true,
  method: 'symcc',
  cases: null,
  timed_out: false,
  checks: [{ name: 'never_errors', ok: true, counterexample_plain: null, counterexample_raw: null }],
};

/** A rules version of Turner's main Desk with `cards` and its money cap `cap` (null: the API sends none). */
function version(v: number, cards: readonly RuleCard[], cap: number | null = 50_000): PolicyVersionOut {
  return {
    desk_id: 'desk-rivera-main',
    version: v,
    parent_version: v - 1,
    cards: cards.map((card) => ({ ...card })),
    cedar_sha256: 'c'.repeat(64),
    schema_sha256: 's'.repeat(64),
    baseline_sha256: 'b'.repeat(64),
    profiles_sha256: 'p'.repeat(64),
    invariants_sha256: 'i'.repeat(64),
    review_thresholds_version: 1,
    status: v === 7 ? 'active' : 'proved',
    proof: CHECKED,
    ...(cap === null ? {} : { auto_money_cap_cents: cap }),
  };
}

/** The active version 7: Turner's own cards at a $500 limit. */
const ACTIVE = version(7, RIVERA_CARDS);

/** A rules draft as the API answers one, version 8 unless `fields` says otherwise. */
function rulesDraft(fields: Partial<RulesDraft> & Pick<RulesDraft, 'cards' | 'diff'>): RulesDraft {
  return {
    version: 8,
    auto_money_cap_cents: 50_000,
    proof: CHECKED,
    summary: { on_its_own: [], asks_you: [], never: [] },
    ...fields,
  };
}

/** A card of Turner's with `fields` changed. */
function changed(card: RuleCard, fields: Partial<RuleCard>): RuleCard {
  return { ...card, ...fields };
}

const ids = (cards: readonly RuleCard[]) => cards.map((card) => card.card_id);

/** Each tool's effects, as the master plan's tool table lists them. */
const EFFECTS: Record<string, ToolRow['effects']> = {
  'native.quote': ['change'],
  'native.find_slots': ['read'],
  'native.book': ['change'],
  'native.release_document': ['private_data', 'send_message'],
  'native.payment_link': ['charge'],
  'native.charge_mandate': ['charge'],
  'native.capture_lead': ['change'],
  'native.request_callback': ['change'],
  'native.start_verification': ['send_message'],
  'payments.list_charges': ['private_data'],
  'payments.create_refund': ['pay_out', 'private_data'],
};

/** A tool row as `rules` lists it: on, at its listed hash. */
function toolRow(tool: ToolRow['tool'], fields: Partial<ToolRow> = {}): ToolRow {
  return {
    tool,
    source: tool.startsWith('payments.') ? 'mcp' : 'native',
    effects: EFFECTS[tool] ?? [],
    reversible: true,
    status: 'enabled',
    description_confirmed: `The ${tool} tool.`,
    definition_sha256: 'd'.repeat(64),
    pending_definition_text: null,
    pending_sha256: null,
    ...fields,
  };
}

/** Turner's tool rows, every one on. */
const TOOLS: ToolRow[] = Object.keys(EFFECTS).map((tool) => toolRow(tool as ToolRow['tool']));

const view = (key: string) => {
  const connector = connectorByKey(key);
  if (connector === null) throw new Error(`the catalog has ${key}`);
  return connector.view;
};

/** Turner's people on record and one lead, as `people` answers. */
const PEOPLE: PeopleOut = {
  people: [
    { person_id: DANA.personId, display_name: DANA.name, masked_contact: DANA.maskedContact },
    { person_id: rivera.people.bob.personId, display_name: rivera.people.bob.name, masked_contact: rivera.people.bob.maskedContact },
  ],
  leads: [{ lead_id: 'lead-1', display_name: 'Sam', note: 'Leaking tap', created_at: '2026-10-30T16:00:00Z' }],
};

describe('rule drafts', () => {
  it('draft_from_answer_pairs_by_card_id', () => {
    // Denying Dana's refund for good changes the refund rule she asked under and adds one just for her.
    const refundNever = changed(ruleCards['rv-refund'], { mode: 'never', reason: 'Refunds never go through without you.' });
    const danaNever: RuleCard = {
      ...ruleCards['rv-refund'],
      card_id: 'card-dana-refund',
      mode: 'never',
      who: 'person',
      person_id: DANA.personId,
      reason: 'Dana Whitfield never gets a refund without you.',
    };
    const kept = RIVERA_CARDS.filter((card) => card.card_id !== 'rv-refund');
    const draft = rulesDraft({
      cards: [...kept, refundNever, danaNever],
      diff: { added: [danaNever], removed: [], changed: [[ruleCards['rv-refund'], refundNever]] },
    });

    const review = draftFromAnswer(ACTIVE, [danaNever, refundNever], draft);
    // Before: the active card each diff card replaces, by card_id; after: the draft's cards for them.
    // The cards the answer leaves alone sit on both sides as the draft has them, so they change nothing.
    expect(ids(review.before)).toEqual(['rv-refund', ...ids(kept)]);
    expect(review.before[0]).toEqual(ruleCards['rv-refund']);
    expect(ids(review.after)).toEqual(['card-dana-refund', 'rv-refund', ...ids(kept)]);
    expect(review.after.slice(0, 2)).toEqual([danaNever, refundNever]);
    expect(review.after.slice(2)).toEqual(review.before.slice(1));
    expect(review).toMatchObject({ version: 8, proof: CHECKED, moneyCap: null, preset: null, turnedOn: [] });
  });

  it('draft_from_diff_orders_before_and_after', () => {
    const saturdayAsks = changed(ruleCards['rv-book-sat'], { mode: 'ask' });
    const linkHigher = changed(ruleCards['rv-link'], { max_amount_cents: 40_000 });
    const added: RuleCard = { ...ruleCards['rv-quote'], card_id: 'card-verified-discount', who: 'verified', max_discount_bp: 1000, reason: 'Verified customers get up to 10% off.' };
    const removed = ruleCards['rv-mandate'];
    const kept = RIVERA_CARDS.filter((card) => !['rv-book-sat', 'rv-link', 'rv-mandate'].includes(card.card_id));
    const draft = rulesDraft({
      cards: [...kept.slice(0, 2), saturdayAsks, ...kept.slice(2), linkHigher, added],
      diff: { added: [added], removed: [removed], changed: [[ruleCards['rv-book-sat'], saturdayAsks], [ruleCards['rv-link'], linkHigher]] },
      summary: { on_its_own: ['a'], asks_you: ['b'], never: [] },
    });

    const review = draftFromDiff(draft, ACTIVE);
    // Before: removed, then each changed pair's first; after: added, then each pair's second. Then
    // the cards the draft keeps, on both sides as the draft has them.
    expect(ids(review.before)).toEqual(['rv-mandate', 'rv-book-sat', 'rv-link', ...ids(kept)]);
    expect(review.before.slice(0, 3)).toEqual([removed, ruleCards['rv-book-sat'], ruleCards['rv-link']]);
    expect(ids(review.after)).toEqual(['card-verified-discount', 'rv-book-sat', 'rv-link', ...ids(kept)]);
    expect(review.after.slice(0, 3)).toEqual([added, saturdayAsks, linkHigher]);
    expect(review.after.slice(3)).toEqual(review.before.slice(3));
    // A diffed draft is reviewed by its rows, not its summary; no preset unless one drafted it.
    expect(review).toMatchObject({ version: 8, proof: CHECKED, summary: null, moneyCap: null, preset: null, turnedOn: [] });
    expect(draftFromDiff(draft, ACTIVE, 'ask_first').preset).toBe('ask_first');

    // With nothing to compare with, every card of the draft is added, and its summary shows.
    const fresh = draftFromDiff(rulesDraft({ cards: [ruleCards['rv-quote'], ruleCards['rv-docs']], diff: null, summary: draft.summary }), ACTIVE);
    expect(fresh.before).toEqual([]);
    expect(ids(fresh.after)).toEqual(['rv-quote', 'rv-docs']);
    expect(fresh.summary).toEqual(draft.summary);
  });

  it('defaults_never_shown', () => {
    // The compiler's default ask for every tool no rule covers: re-derived on every draft, never the owner's.
    const defaultAsk: RuleCard = {
      card_id: 'default-ask-native.find_slots',
      applies_to: 'native.find_slots',
      mode: 'ask',
      who: 'anyone',
      reason: 'Not covered by a rule you set, so I ask you.',
      is_default: true,
    };
    const defaultNow = { ...defaultAsk, card_id: 'default-ask-native.book' };
    const quoteAsks = changed(ruleCards['rv-quote'], { mode: 'ask' });
    const active = version(7, [...RIVERA_CARDS, defaultAsk]);
    const cards = [...RIVERA_CARDS.filter((card) => card.card_id !== 'rv-quote'), quoteAsks, defaultNow];
    const draft = rulesDraft({
      cards,
      diff: { added: [defaultNow], removed: [defaultAsk], changed: [[ruleCards['rv-quote'], quoteAsks]] },
    });

    const reviews = [
      draftFromAnswer(active, [quoteAsks, defaultNow], draft),
      draftFromDiff(draft, active),
      draftFromDiff({ ...draft, diff: null }, active),
      draftFromVersion(active, version(8, cards), []),
    ];
    for (const review of reviews) {
      expect([...review.before, ...review.after].filter((card) => card.is_default === true)).toEqual([]);
      expect(review.after.some((card) => card.card_id === 'rv-quote' && card.mode === 'ask')).toBe(true);
    }
  });

  it('check_status_table', () => {
    const failing = (counterexample: string | null, name = 'auto_within_cards') => ({ name, ok: false, counterexample_plain: counterexample, counterexample_raw: null });
    const passing = { name: 'never_errors', ok: true, counterexample_plain: null, counterexample_raw: null };
    const UNAVAILABLE = { status: 'unavailable', lines: [RULES_UNAVAILABLE_COPY] };

    // Only a full check confirms.
    expect(checkStatus(CHECKED)).toEqual({ status: 'checked', lines: ['Checked against the always-on rules and your other rules.'] });
    // No check, one that ran out of time, or the bounded fallback: unavailable, never failed.
    expect(checkStatus(null)).toEqual(UNAVAILABLE);
    expect(checkStatus(undefined)).toEqual(UNAVAILABLE);
    expect(checkStatus({ ...CHECKED, ok: false, timed_out: true, checks: [failing('Something')] })).toEqual(UNAVAILABLE);
    expect(checkStatus({ ...CHECKED, timed_out: true })).toEqual(UNAVAILABLE);
    expect(checkStatus({ ...CHECKED, method: 'bounded', cases: 5000 })).toEqual(UNAVAILABLE);
    expect(checkStatus({ ...CHECKED, ok: false, method: 'bounded', checks: [failing('Something')] })).toEqual(UNAVAILABLE);
    // A failed check says why in the kernel's plain words, one line per failed check.
    expect(
      checkStatus({ ...CHECKED, ok: false, checks: [passing, failing('Dana could get a $500 refund without asking you'), failing('A stranger could book on Sunday')] }),
    ).toEqual({ status: 'failed', lines: ['Dana could get a $500 refund without asking you', 'A stranger could book on Sunday'] });
    // Without plain words, a plain line, said once.
    expect(checkStatus({ ...CHECKED, ok: false, checks: [failing(null), failing('  ', 'money_needs_card')] })).toEqual({
      status: 'failed',
      lines: ["One of the safety checks didn't pass."],
    });
    expect(checkStatus({ ...CHECKED, ok: false, checks: [passing] })).toEqual({ status: 'failed', lines: ["One of the safety checks didn't pass."] });
    // A report that says ok while a check failed is not checked.
    expect(checkStatus({ ...CHECKED, checks: [failing('A stranger could book on Sunday')] }).status).toBe('failed');

    // A preset's review, either preset, also says what still runs on its own (N-Conn-18), once checked.
    const presetChecked = {
      status: 'checked',
      lines: ['Checked against the always-on rules and your other rules.', 'Open times, leads, callbacks and identity checks still run on their own.'],
    };
    expect(checkStatus(CHECKED, 'ask_first')).toEqual(presetChecked);
    expect(checkStatus(CHECKED, 'auto')).toEqual(presetChecked);
    expect(checkStatus(CHECKED, null)).toEqual({ status: 'checked', lines: ['Checked against the always-on rules and your other rules.'] });
    expect(checkStatus(null, 'ask_first')).toEqual(UNAVAILABLE);
    expect(checkStatus({ ...CHECKED, ok: false, checks: [failing('A stranger could book on Sunday')] }, 'ask_first')).toEqual({
      status: 'failed',
      lines: ['A stranger could book on Sunday'],
    });
  });

  it('rule_words_match_the_boards', () => {
    // Every card of Turner's, the shared rule for Alex Kim's assistant and Dana's own booking rule,
    // in the words the design system's fixture renders from the signed boards.
    const agents: AgentNames = new Map([[rivera.demoAgentIssued.agent_key_id, rivera.conversations.alexAgent.name]]);
    const cards = [...RIVERA_CARDS, rivera.sharedChargeCard, rivera.personalBookingCard];
    expect(ids(cards).sort()).toEqual(Object.keys(rivera.ruleWords).sort());
    for (const card of cards) expect(ruleWords(card, PEOPLE, agents), card.card_id).toEqual(rivera.ruleWords[card.card_id as keyof typeof rivera.ruleWords]);
    // Dana's own documents, as her page lists them: her name, and that she confirms it's her.
    const danaDocs: RuleCard = { ...ruleCards['rv-docs'], card_id: 'rv-dana-docs', who: 'person', person_id: DANA.personId };
    expect(ruleWords(danaDocs, PEOPLE)).toEqual(rivera.danaRules.find((rule) => rule.key === 'rv-dana-docs')?.words);
  });

  it('rule_words_read_limits', () => {
    // Each word tagged with its field, in order: who, limits, hours, the reviewer's check.
    expect(ruleWords(ruleCards['rv-book-wk'], PEOPLE)).toEqual([
      { field: 'who', text: 'Anyone' },
      { field: 'hours', text: 'Weekdays, 8:00 am to 6:00 pm' },
      { field: 'review', text: 'Checked by the reviewer' },
    ]);
    expect(ruleWords(ruleCards['rv-link'], PEOPLE)).toEqual([
      { field: 'who', text: 'Anyone' },
      { field: 'limits', text: 'Up to $300' },
      { field: 'review', text: 'Checked by the reviewer' },
    ]);
    // A quote rule says what it allows off the price list, none included.
    expect(ruleWords(ruleCards['rv-quote'], PEOPLE)).toEqual([
      { field: 'who', text: 'Anyone' },
      { field: 'limits', text: 'No discounts' },
    ]);
    expect(ruleWords(changed(ruleCards['rv-quote'], { max_discount_bp: 1000 }), PEOPLE)).toContainEqual({ field: 'limits', text: 'Discounts up to 10%' });
    expect(ruleWords(changed(ruleCards['rv-quote'], { max_discount_bp: 1250 }), PEOPLE)).toContainEqual({ field: 'limits', text: 'Discounts up to 12.5%' });
    expect(ruleWords(changed(ruleCards['rv-link'], { max_amount_cents: 4050 }), PEOPLE)).toContainEqual({ field: 'limits', text: 'Up to $40.50' });

    // Who it is for, in the boards' words. What the rule applies to says which: a charge within a
    // signed limit is for agents that have one, a refund goes back to whoever paid, and a person's
    // rule on private data says she confirms it's her.
    const who = (fields: Partial<RuleCard>, people: PeopleOut | null = PEOPLE, agents?: AgentNames) =>
      ruleWords(changed(ruleCards['rv-docs'], fields), people, agents)
        .filter((word) => word.field === 'who')
        .map((word) => word.text);
    expect(who({ who: 'anyone' })).toEqual(['Anyone']);
    expect(who({ who: 'anyone', applies_to: 'native.charge_mandate' })).toEqual(['Signed agents']);
    expect(who({ who: 'anyone', applies_to: 'effect:charge' })).toEqual(['Anyone']);
    expect(who({ who: 'verified' })).toEqual(['Verified customers']);
    expect(who({ who: 'record_owner' })).toEqual(["The record's owner, verified"]);
    expect(who({ who: 'record_owner', applies_to: 'payments.list_charges' })).toEqual(["The record's owner, verified"]);
    expect(who({ who: 'record_owner', applies_to: 'payments.create_refund' })).toEqual(['The customer who paid, verified']);
    expect(who({ who: 'record_owner', applies_to: 'effect:pay_out' })).toEqual(['The customer who paid, verified']);
    // A person by name once `people` has them, "One customer" while it loads or fails or when it doesn't list them.
    expect(who({ who: 'person', person_id: DANA.personId })).toEqual(['Dana Whitfield', 'Verified']);
    expect(who({ who: 'person', person_id: DANA.personId, applies_to: 'native.book' })).toEqual(['Dana Whitfield']);
    expect(who({ who: 'person', person_id: DANA.personId, applies_to: 'payments.create_refund' })).toEqual(['Dana Whitfield', 'Verified']);
    expect(who({ who: 'person', person_id: DANA.personId }, null)).toEqual(['One customer', 'Verified']);
    expect(who({ who: 'person', person_id: 'per-unknown', applies_to: 'native.book' })).toEqual(['One customer']);
    // An agent by the name the caller has for its key; the API names no agent yet, so "One agent".
    const agents: AgentNames = new Map([['demo-agent', "Alex Kim's assistant"]]);
    expect(who({ who: 'agent', agent_key_id: 'demo-agent', applies_to: 'effect:charge' }, PEOPLE, agents)).toEqual(["Alex Kim's assistant"]);
    expect(who({ who: 'agent', agent_key_id: 'demo-agent', applies_to: 'effect:charge' })).toEqual(['One agent']);
    expect(who({ who: 'agent', agent_key_id: 'another-agent', applies_to: 'effect:charge' }, PEOPLE, agents)).toEqual(['One agent']);
    expect(who({ who: 'agent', agent_key_id: 'demo-agent', applies_to: 'effect:charge' }, PEOPLE, new Map([['demo-agent', '  ']]))).toEqual(['One agent']);

    // Hours in the business's own local times, the days grouped as the boards say them.
    const hours = (days: string[], start: string, end: string) => formatHours({ days, start, end } as Parameters<typeof formatHours>[0]);
    expect(hours(['mon', 'tue', 'wed', 'thu', 'fri'], '08:00:00', '18:00:00')).toBe('Weekdays, 8:00 am to 6:00 pm');
    expect(hours(['sat'], '09:00:00', '13:00:00')).toBe('Saturdays, 9:00 am to 1:00 pm');
    expect(hours(['sat', 'sun'], '12:00:00', '12:30:00')).toBe('Weekends, 12:00 pm to 12:30 pm');
    expect(hours(['fri', 'mon', 'wed'], '07:05:00', '23:59:00')).toBe('Mondays, Wednesdays and Fridays, 7:05 am to 11:59 pm');
    expect(hours(['mon', 'tue', 'wed', 'thu', 'fri', 'sun'], '08:00:00', '00:00:00')).toBe('Weekdays and Sundays, 8:00 am to midnight');
    expect(hours(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], '00:00:00', '00:00:00')).toBe('Every day, all day');
    const saturday = ruleWords(ruleCards['rv-book-sat'], PEOPLE).find((word) => word.field === 'hours');
    expect(saturday).toEqual({ field: 'hours', text: 'Saturdays, 9:00 am to 1:00 pm' });
  });

  it('money_cap_words', () => {
    // The signed words: the most Claude takes or pays out in one action without asking.
    expect(moneyCapWords(500_000)).toBe('no payment over $5,000 without asking you');
    expect(moneyCapWords(100_000)).toBe('no payment over $1,000 without asking you');
    expect(moneyCapWords(0)).toBe('every payment asks you first');
    expect(moneyLimitLine(50_000)).toBe('No payment over $500 goes through without asking you, whatever the rules below say.');
    expect(moneyLimitLine(0)).toBe('Every payment asks you first.');
    expect(moneyLimitHint(50_000)).toBe('Whole dollars, from 0 to 10,000. Now $500.');
    expect(moneyLimitHint(0)).toBe('Whole dollars, from 0 to 10,000. Now every payment asks you first.');
    // At 0 nothing reads "$0".
    for (const words of [moneyCapWords(0), moneyLimitLine(0), moneyLimitHint(0)]) expect(words).not.toContain('$0');
    // The per-payment limit and the platform ceiling, $10,000.
    expect(PAYMENT_MAX_CENTS).toBe(1_000_000);
    expect(moneyLimitLine(PAYMENT_MAX_CENTS)).toBe('No payment over $10,000 goes through without asking you, whatever the rules below say.');
  });

  it('money_cap_change_compares_with_the_active_version', () => {
    // Lowered or raised, the change is always against the cap in force: the active version's.
    expect(moneyCapChange(50_000, 10_000)).toEqual({ before: 50_000, after: 10_000 });
    expect(moneyCapChange(50_000, 500_000)).toEqual({ before: 50_000, after: 500_000 });
    expect(moneyCapChange(50_000, 50_000)).toBeNull();

    // Each builder compares the active version's cap with the draft's, whatever drafted it.
    const capDraft = (cap: number) => rulesDraft({ cards: RIVERA_CARDS, diff: { added: [], removed: [], changed: [] }, auto_money_cap_cents: cap });
    expect(draftFromDiff(capDraft(10_000), ACTIVE).moneyCap).toEqual({ before: 50_000, after: 10_000 });
    expect(draftFromDiff(capDraft(500_000), ACTIVE).moneyCap).toEqual({ before: 50_000, after: 500_000 });
    expect(draftFromDiff(capDraft(50_000), ACTIVE).moneyCap).toBeNull();
    expect(draftFromAnswer(ACTIVE, [], capDraft(10_000)).moneyCap).toEqual({ before: 50_000, after: 10_000 });
    expect(draftFromVersion(ACTIVE, version(8, RIVERA_CARDS, 500_000), []).moneyCap).toEqual({ before: 50_000, after: 500_000 });
    // After the lowering is confirmed, a draft back up compares with the new active version.
    expect(draftFromDiff(capDraft(50_000), version(8, RIVERA_CARDS, 10_000)).moneyCap).toEqual({ before: 10_000, after: 50_000 });

    // A cap the API doesn't send yet is 0, the kernel's default: every payment asks.
    expect(capOf(version(7, RIVERA_CARDS, null))).toBe(0);
    expect(capOf({ auto_money_cap_cents: -5 })).toBe(0);
    expect(draftFromDiff(capDraft(50_000), version(7, RIVERA_CARDS, null)).moneyCap).toEqual({ before: 0, after: 50_000 });
  });

  it('change_rows_name_the_tool_and_its_connector', () => {
    const quoteDiscount = changed(ruleCards['rv-quote'], { max_discount_bp: 1000 });
    const charges: RuleCard = { ...ruleCards['rv-link'], card_id: 'card-charges', applies_to: 'effect:charge', review: false, reason: 'Payments up to $300 go through.' };
    const linkWider = changed(ruleCards['rv-link'], { applies_to: 'effect:charge' });
    const draft = draftFromDiff(
      rulesDraft({
        cards: [...RIVERA_CARDS.filter((c) => !['rv-quote', 'rv-link'].includes(c.card_id)), quoteDiscount, linkWider, charges],
        diff: { added: [charges], removed: [], changed: [[ruleCards['rv-quote'], quoteDiscount], [ruleCards['rv-link'], linkWider]] },
      }),
      ACTIVE,
    );
    const rows = changeRows(draft, PEOPLE, TOOLS);
    const rowFor = (key: string) => {
      const found = rows.find((r) => r.key === key);
      if (!found) throw new Error(`no row ${key} in ${JSON.stringify(rows.map((r) => r.key))}`);
      return found;
    };

    // A tool card: the tool's name and its connector, the fields that changed. Its target stays,
    // so neither side repeats it: the row's title names it (N-Conn-18).
    const quote = rowFor('rv-quote');
    expect(quote).toMatchObject({ change: 'changed', title: 'Quote', connector: view('quotes'), changed: ['limits'] });
    expect(quote.before).toMatchObject({ mode: 'auto', reason: ruleCards['rv-quote'].reason, words: ruleWords(ruleCards['rv-quote'], PEOPLE) });
    expect(quote.after?.appliesTo).toBeUndefined();
    expect(quote.after?.words).toContainEqual({ field: 'limits', text: 'Discounts up to 10%' });

    // A shared rule (an effect card): titled by the tools it covers in this Desk's catalog, with
    // their connector when they share one (N-Conn-18). An added rule's one side leaves its target
    // to the row's title, which names it.
    const shared = rowFor('card-charges');
    expect(shared).toMatchObject({ change: 'added', title: 'Payment link and Charge within a signed limit', connector: view('payments'), before: null, changed: [] });
    expect(shared.after).toMatchObject({ mode: 'auto', limit: '$300', reason: charges.reason, words: ruleWords(charges, PEOPLE) });

    // A card retargeted from Payment link to every tool that charges money says so on both sides.
    const link = rowFor('rv-link');
    expect(link).toMatchObject({ change: 'changed', title: 'Payment link', connector: view('payments'), changed: ['applies_to'] });
    expect(link.before).toMatchObject({
      appliesTo: 'Payment link',
      mode: 'auto',
      limit: '$300',
      reason: ruleCards['rv-link'].reason,
      words: ruleWords(ruleCards['rv-link'], PEOPLE),
    });
    expect(link.after).toMatchObject({ appliesTo: 'Every tool that charges money', limit: '$300' });
    expect(rows).toHaveLength(3);

    // An external connector's tool keeps its Mock badge's view; a rule that asks shows no limit.
    const refund = changeRows(
      draftFromDiff(rulesDraft({ cards: RIVERA_CARDS, diff: { added: [], removed: [], changed: [[ruleCards['rv-refund'], changed(ruleCards['rv-refund'], { reason: 'Refunds wait for you.' })]] } }), ACTIVE),
      PEOPLE,
      TOOLS,
    );
    expect(refund).toHaveLength(1);
    expect(refund[0]).toMatchObject({ title: 'Refund', connector: view('stripe'), changed: ['reason'] });
    expect(refund[0]?.before?.limit).toBeUndefined();
  });

  it('preset_rows_replace_every_owner_rule', () => {
    // Turner's cards, the shared rule for an agent's charges and Dana's own booking rule, drafted to
    // "Ask me first": the preset replaces every owner card.
    const owner = [rivera.sharedChargeCard, ...RIVERA_CARDS, rivera.personalBookingCard];
    const preset = PRESETS.ask_first.map((card) => ({ ...card }));
    const draft = draftFromDiff(rulesDraft({ cards: preset, diff: { added: preset, removed: owner, changed: [] } }), version(7, owner), 'ask_first');
    const rows = changeRows(draft, PEOPLE, TOOLS);

    // A removed row per dropped card, personal ones included: nothing in the preset covers them.
    // Each shows Before alone. The rows go by connector, as
    // the Connectors page lists them, and by tool within one (N-Conn-18). The shared rule for the
    // agent's charges sits with Payments, right after the first tool it covers, as the board draws it.
    const dropped = rows.filter((row) => row.change === 'removed');
    expect(dropped.map((row) => row.key)).toEqual([
      'rv-quote',
      'rv-book-wk',
      'rv-book-sat',
      'rv-dana-book',
      'rv-docs',
      'rv-link',
      'rv-agent-charges',
      'rv-mandate',
      'rv-charges',
      'rv-refund',
    ]);
    expect(dropped.map((row) => row.connector?.name)).toEqual([
      'Quotes',
      'Bookings',
      'Bookings',
      'Bookings',
      'Documents',
      'Payments',
      'Payments',
      'Payments',
      'Stripe',
      'Stripe',
    ]);
    expect(dropped.map((row) => row.title)).toEqual([
      'Quote',
      'Book a visit',
      'Book a visit',
      'Book a visit',
      'Share a document',
      'Payment link',
      'Payment link and Charge within a signed limit',
      'Charge within a signed limit',
      'See charges',
      'Refund',
    ]);
    // The removed rule has no After side; its Before still names its own tool.
    for (const row of dropped) {
      expect(row.after, row.key).toBeNull();
      expect(row.before?.appliesTo, row.key).toBeUndefined();
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('rv-quote')?.changed).toEqual(['mode']);
    expect(byKey.get('rv-refund')?.changed).toEqual([]);
    expect(byKey.get('rv-dana-book')).toMatchObject({ title: 'Book a visit', before: { words: [{ field: 'who', text: 'Dana Whitfield' }] } });

    // The preset's own cards, which Turner's rules didn't have here, are added rows.
    const added = rows.filter((row) => row.change === 'added');
    expect(added.map((row) => row.key)).toEqual(ids(preset));
    expect(added.map((row) => row.title)).toEqual(['Find open times', 'Save a lead', 'Request a callback', 'Confirm it’s them', 'Website reading', 'Memory reading', 'Web search']);
    expect(rows).toHaveLength(owner.length + preset.length);
  });

  it('shared_rule_rows_name_the_tools_they_cover', () => {
    // Turner's rules with three shared rules added: never private data, every message sent
    // automatically, and the agent's charges. Turner's own quote rule changes too.
    const neverPrivate: RuleCard = { card_id: 'card-never-private', applies_to: 'effect:private_data', mode: 'never', who: 'anyone', reason: 'Private records never go out.' };
    const autoMessages: RuleCard = { card_id: 'card-auto-messages', applies_to: 'effect:send_message', mode: 'auto', who: 'anyone', reason: 'Messages go out on their own.' };
    const quoteDiscount = changed(ruleCards['rv-quote'], { max_discount_bp: 1000 });
    const added = [neverPrivate, autoMessages, rivera.sharedChargeCard];
    const draft = draftFromDiff(
      rulesDraft({
        cards: [...RIVERA_CARDS.filter((card) => card.card_id !== 'rv-quote'), quoteDiscount, ...added],
        diff: { added, removed: [], changed: [[ruleCards['rv-quote'], quoteDiscount]] },
      }),
      ACTIVE,
    );
    const rows = changeRows(draft, PEOPLE, TOOLS);
    const rowFor = (key: string) => rows.find((row) => row.key === key);

    // A shared rule whose tools span connectors names them all, has no connector and goes last.
    expect(rowFor('card-never-private')).toMatchObject({ title: 'Share a document, See charges and Refund', change: 'added' });
    expect(rowFor('card-never-private')?.connector).toBeUndefined();
    // An automatic one covers a tool with other effects only jointly, so messages alone don't
    // cover Share a document, which also touches private data: only "Confirm it's them".
    expect(rowFor('card-auto-messages')).toMatchObject({ title: 'Confirm it’s them', connector: view('verification') });
    // The added rows by the tools' places: Verification, then Payments, then the one that spans.
    // Each shared rule's row says so ("Payments · Shared rule", or "Shared rule" leading with no
    // connector); a tool's own rule doesn't.
    expect(rows.map((row) => [row.key, row.shared])).toEqual([
      ['rv-quote', undefined],
      ['card-auto-messages', true],
      ['rv-agent-charges', true],
      ['card-never-private', true],
    ]);

    // With no tool in the Desk's catalog to name, a shared rule keeps its group's words, with no
    // connector, and goes last, still marked shared.
    const bare = changeRows(draft, PEOPLE);
    expect(bare.map((row) => [row.key, row.title, row.connector, row.shared])).toEqual([
      ['rv-quote', 'Quote', view('quotes'), undefined],
      ['card-never-private', 'Every tool that touches private data', undefined, true],
      ['card-auto-messages', 'Every tool that sends a message out', undefined, true],
      ['rv-agent-charges', 'Every tool that charges money', undefined, true],
    ]);

    // A shared rule dropped with nothing to go to, or changed in place, is still the shared rule.
    const withShared = version(7, [...RIVERA_CARDS, rivera.sharedChargeCard]);
    const dropped = changeRows(draftFromDiff(rulesDraft({ cards: RIVERA_CARDS, diff: { added: [], removed: [rivera.sharedChargeCard], changed: [] } }), withShared), PEOPLE, TOOLS);
    expect(dropped).toEqual([expect.objectContaining({ key: 'rv-agent-charges', change: 'removed', connector: view('payments'), shared: true, after: null })]);
    const lower = changed(rivera.sharedChargeCard, { max_amount_cents: 1500 });
    const inPlace = changeRows(
      draftFromDiff(rulesDraft({ cards: [...RIVERA_CARDS, lower], diff: { added: [], removed: [], changed: [[rivera.sharedChargeCard, lower]] } }), withShared),
      PEOPLE,
      TOOLS,
    );
    expect(inPlace).toEqual([expect.objectContaining({ key: 'rv-agent-charges', changed: ['limits'], shared: true })]);

    // Replaced by "Recommended rules": the shared rule goes to the preset's rule for every tool that
    // charges money, still a shared rule, so its row says so; Payment link's own rule moves to that
    // group, which its sides show, so its row doesn't.
    const owner = [...PRESETS.ask_first, ...RIVERA_CARDS, rivera.sharedChargeCard];
    const preset = PRESETS.auto.map((card) => ({ ...card }));
    const presetIds = new Set(ids(preset));
    const recommended = changeRows(
      draftFromDiff(
        rulesDraft({ cards: preset, diff: { added: preset.filter((card) => !ids(owner).includes(card.card_id)), removed: owner.filter((card) => !presetIds.has(card.card_id)), changed: [] } }),
        version(7, owner),
        'auto',
      ),
      PEOPLE,
      TOOLS,
    );
    const replaced = recommended.find((row) => row.key === 'rv-agent-charges');
    expect(replaced).toMatchObject({ change: 'changed', title: 'Payment link and Charge within a signed limit', connector: view('payments'), shared: true });
    expect(replaced?.after).toMatchObject({ mode: 'ask', reason: 'Taking a payment asks you first.' });
    expect(replaced?.after?.appliesTo).toBeUndefined();
    expect(recommended.find((row) => row.key === 'rv-link')?.shared).toBeUndefined();

    // A shared rule retargeted to one of its tools keeps the title, connector and place of the
    // tools it covered, and each side names its target: the group's words, then the tool.
    const toLink = changed(rivera.sharedChargeCard, { applies_to: 'native.payment_link' });
    const pairs: [RuleCard, RuleCard][] = [
      [rivera.sharedChargeCard, toLink],
      [ruleCards['rv-link'], changed(ruleCards['rv-link'], { reason: 'Links up to $300.' })],
      [ruleCards['rv-mandate'], changed(ruleCards['rv-mandate'], { reason: 'Deposits from a signed limit.' })],
    ];
    const narrowed = changeRows(
      draftFromDiff(
        rulesDraft({
          cards: [...RIVERA_CARDS.filter((card) => !['rv-link', 'rv-mandate'].includes(card.card_id)), ...pairs.map(([, now]) => now)],
          diff: { added: [], removed: [], changed: pairs },
        }),
        version(7, [...RIVERA_CARDS, rivera.sharedChargeCard]),
      ),
      PEOPLE,
      TOOLS,
    );
    expect(narrowed.map((row) => row.key)).toEqual(['rv-link', 'rv-agent-charges', 'rv-mandate']);
    expect(narrowed[1]).toMatchObject({ change: 'changed', title: 'Payment link and Charge within a signed limit', connector: view('payments'), changed: ['applies_to'] });
    expect(narrowed[1]?.before?.appliesTo).toBe('Every tool that charges money');
    expect(narrowed[1]?.after?.appliesTo).toBe('Payment link');
    // It moves from a group of tools to one tool, which its sides show: no "Shared rule".
    expect(narrowed.map((row) => row.shared)).toEqual([undefined, undefined, undefined]);

    // A shared rule moved from one group to another, "never charge money" to "never send money
    // out": titled by every tool either side covers, which span connectors, so it has none and goes
    // last; each side names the tools it covers rather than its group's words, and it stays shared.
    const neverCharge: RuleCard = { card_id: 'card-never-money', applies_to: 'effect:charge', mode: 'never', who: 'anyone', reason: 'Money never moves without you.' };
    const neverPayOut = changed(neverCharge, { applies_to: 'effect:pay_out' });
    const regrouped: [RuleCard, RuleCard][] = [
      [neverCharge, neverPayOut],
      [ruleCards['rv-refund'], changed(ruleCards['rv-refund'], { reason: 'Refunds wait for you.' })],
    ];
    const moved = changeRows(
      draftFromDiff(
        rulesDraft({ cards: [...RIVERA_CARDS.filter((card) => card.card_id !== 'rv-refund'), ...regrouped.map(([, now]) => now)], diff: { added: [], removed: [], changed: regrouped } }),
        version(7, [...RIVERA_CARDS, neverCharge]),
      ),
      PEOPLE,
      TOOLS,
    );
    expect(moved.map((row) => row.key)).toEqual(['rv-refund', 'card-never-money']);
    expect(moved[1]).toMatchObject({ change: 'changed', title: 'Payment link, Charge within a signed limit and Refund', shared: true, changed: ['applies_to'] });
    expect(moved[1]?.connector).toBeUndefined();
    expect(moved[1]?.before?.appliesTo).toBe('Payment link and Charge within a signed limit');
    expect(moved[1]?.after?.appliesTo).toBe('Refund');
  });

  /** Turner's rules with a shared rule on private data changed in place from `was` to `now`, beside a quote and a refund change. */
  function privateDataChange(was: RuleCard, now: RuleCard) {
    const quoteDiscount = changed(ruleCards['rv-quote'], { max_discount_bp: 1000 });
    const refundReworded = changed(ruleCards['rv-refund'], { reason: 'Refunds wait for you.' });
    const pairs: [RuleCard, RuleCard][] = [
      [ruleCards['rv-quote'], quoteDiscount],
      [ruleCards['rv-refund'], refundReworded],
      [was, now],
    ];
    const untouched = RIVERA_CARDS.filter((card) => !['rv-quote', 'rv-refund'].includes(card.card_id));
    const draft = draftFromDiff(
      rulesDraft({ cards: [...untouched, ...pairs.map(([, after]) => after)], diff: { added: [], removed: [], changed: pairs } }),
      version(7, [...RIVERA_CARDS, was]),
    );
    return changeRows(draft, PEOPLE, TOOLS);
  }

  /** An automatic rule on private data for record owners, which alone covers only See charges, the one tool whose only effect it is. */
  const autoPrivate: RuleCard = {
    card_id: 'card-private',
    applies_to: 'effect:private_data',
    mode: 'auto',
    who: 'record_owner',
    reason: "Customers see their own records after confirming it's them.",
  };
  /** The same rule made "Never" for anyone, which covers every tool that touches private data. */
  const neverPrivate = changed(autoPrivate, { mode: 'never', who: 'anyone', reason: 'Private records never go out.' });

  it('shared_rule_covering_more_after_a_change_names_every_tool', () => {
    // Made "Never", the rule also blocks Share a document and Refund: the row names every tool on
    // either side, spans connectors so it has none and goes last, and each side names what it
    // covers, the after side's target tagged as changed. It is a shared rule on both sides, so
    // its row says "Shared rule".
    const rows = privateDataChange(autoPrivate, neverPrivate);
    expect(rows.map((row) => row.key)).toEqual(['rv-quote', 'rv-refund', 'card-private']);
    const row = rows[2];
    expect(row).toMatchObject({ change: 'changed', title: 'Share a document, See charges and Refund', shared: true, changed: ['applies_to', 'mode', 'who', 'reason'] });
    expect(row?.connector).toBeUndefined();
    expect(row?.before).toMatchObject({ appliesTo: 'See charges', mode: 'auto', reason: autoPrivate.reason, words: ruleWords(autoPrivate, PEOPLE) });
    expect(row?.after).toMatchObject({ appliesTo: 'Share a document, See charges and Refund', mode: 'never', reason: neverPrivate.reason, words: ruleWords(neverPrivate, PEOPLE) });
  });

  it('shared_rule_covering_less_after_a_change_names_every_tool', () => {
    // Made automatic, the rule covers only See charges: the row still names every tool it covered,
    // and each side names its own.
    const rows = privateDataChange(neverPrivate, autoPrivate);
    expect(rows.map((row) => row.key)).toEqual(['rv-quote', 'rv-refund', 'card-private']);
    const row = rows[2];
    expect(row).toMatchObject({ change: 'changed', title: 'Share a document, See charges and Refund', shared: true, changed: ['applies_to', 'mode', 'who', 'reason'] });
    expect(row?.connector).toBeUndefined();
    expect(row?.before?.appliesTo).toBe('Share a document, See charges and Refund');
    expect(row?.after?.appliesTo).toBe('See charges');
  });

  it('recommended_preset_keeps_what_it_automates', () => {
    // Turner's rules as the seed has them, the starter's cards included, drafted to "Recommended rules"
    // in his Desk's own hours, as the API drafts it: weekdays 8:00 am to 6:00 pm.
    const owner = [...PRESETS.ask_first, ...RIVERA_CARDS];
    const preset = presetCards('auto', RIVERA_HOURS);
    const presetIds = new Set(ids(preset));
    const draft = draftFromDiff(
      rulesDraft({
        cards: preset,
        diff: { added: preset.filter((card) => !ids(owner).includes(card.card_id)), removed: owner.filter((card) => !presetIds.has(card.card_id)), changed: [] },
      }),
      version(7, owner),
      'auto',
    );
    const rows = changeRows(draft, PEOPLE, TOOLS);
    const byKey = new Map(rows.map((row) => [row.key, row]));

    // Quotes and documents keep what they automate under the preset's identical rules: no row says they will ask.
    expect(byKey.has('rv-quote')).toBe(false);
    expect(byKey.has('rv-docs')).toBe(false);
    expect(byKey.has('preset-quote')).toBe(false);
    expect(byKey.has('preset-documents')).toBe(false);
    for (const row of rows) expect(['Quote', 'Share a document'], row.key).not.toContain(row.title);
    // The starter's cards it keeps make no row.
    for (const card of PRESETS.ask_first) expect(byKey.has(card.card_id), card.card_id).toBe(false);

    // The payment link goes to the preset's rule for every tool that charges money, which asks.
    expect(byKey.get('rv-link')).toMatchObject({
      change: 'changed',
      title: 'Payment link',
      after: { appliesTo: 'Every tool that charges money', mode: 'ask', reason: 'Taking a payment asks you first.' },
    });
    expect(byKey.get('rv-link')?.changed).toEqual(expect.arrayContaining(['applies_to', 'mode']));
    // The target moves, so both sides name theirs.
    expect(byKey.get('rv-link')?.before?.appliesTo).toBe('Payment link');
    expect(byKey.get('rv-mandate')?.after).toMatchObject({ appliesTo: 'Every tool that charges money', mode: 'ask' });
    expect(byKey.get('rv-refund')?.after).toMatchObject({ appliesTo: 'Every tool that sends money out', mode: 'ask' });
    expect(byKey.get('rv-refund')?.changed).not.toContain('mode');

    // Weekday bookings from 8:00 am to 6:00 pm go to the preset's rule in the same hours and words, Turner's
    // own rule in all but its id, so they have no row, and no 9-to-5 rule is added. Saturdays lie outside
    // the preset's weekday bookings, so they fall to the default ask rather than claiming "Automatic".
    expect(byKey.has('rv-book-wk')).toBe(false);
    expect(rows.filter((row) => row.title === 'Book a visit').map((row) => row.key)).toEqual(['rv-book-sat']);
    expect(byKey.get('rv-book-sat')?.after).toBeNull();
    expect(byKey.get('rv-book-sat')?.before?.appliesTo).toBeUndefined();
    expect(rows.filter((row) => row.change === 'added')).toEqual([]);
  });

  it('recommended_preset_books_nine_to_five_without_hours', () => {
    // A Desk with no hours drafts "Recommended rules" as the presets have them: weekdays 9 to 5.
    const owner = [...PRESETS.ask_first, ...RIVERA_CARDS];
    const preset = presetCards('auto', []);
    expect(preset).toEqual(PRESETS.auto);
    const presetIds = new Set(ids(preset));
    const draft = draftFromDiff(
      rulesDraft({
        cards: preset,
        diff: { added: preset.filter((card) => !ids(owner).includes(card.card_id)), removed: owner.filter((card) => !presetIds.has(card.card_id)), changed: [] },
      }),
      version(7, owner),
      'auto',
    );
    const byKey = new Map(changeRows(draft, PEOPLE, TOOLS).map((row) => [row.key, row]));

    // Weekday bookings from 8:00 am to 6:00 pm reach outside the 9-to-5 rule and Saturdays lie outside
    // it, so both fall to the default ask rather than claiming "Automatic"; the 9-to-5 rule, which no
    // dropped rule goes to, is added at "Automatic".
    expect(byKey.get('rv-book-wk')?.after).toBeNull();
    expect(byKey.get('rv-book-sat')?.after).toBeNull();
    expect(byKey.get('preset-book-weekday')).toMatchObject({ change: 'added', title: 'Book a visit', after: { mode: 'auto' } });
    expect(byKey.get('preset-book-weekday')?.after?.appliesTo).toBeUndefined();
    expect([...byKey.values()].filter((row) => row.change === 'added').map((row) => row.key)).toEqual(['preset-book-weekday']);
  });

  it('cancels_links_follows_the_draft', () => {
    /** A draft of Turner's rules with `pairs` changed, `removed` dropped and `added` added, at `cap`. */
    const draftOf = ({ pairs = [], removed = [], added = [], cap = 50_000 }: { pairs?: [RuleCard, RuleCard][]; removed?: RuleCard[]; added?: RuleCard[]; cap?: number }) => {
      const touched = new Set(ids([...removed, ...pairs.map(([was]) => was)]));
      const cards = [...RIVERA_CARDS.filter((card) => !touched.has(card.card_id)), ...pairs.map(([, now]) => now), ...added];
      return draftFromDiff(rulesDraft({ cards, diff: { added, removed, changed: pairs }, auto_money_cap_cents: cap }), ACTIVE);
    };
    const link = ruleCards['rv-link'];

    // True: a lower limit; the link rule asking, lower, dropped by a preset; any card added on its targets.
    expect(cancelsLinksFor(draftOf({ cap: 10_000 }))).toBe(true);
    expect(cancelsLinksFor(draftOf({ pairs: [[link, changed(link, { mode: 'ask', max_amount_cents: null, review: false })]] }))).toBe(true);
    expect(cancelsLinksFor(draftOf({ pairs: [[link, changed(link, { max_amount_cents: 10_000 })]] }))).toBe(true);
    expect(cancelsLinksFor(draftOf({ pairs: [[link, changed(link, { hours: { days: ['mon'], start: '09:00:00', end: '17:00:00' } })]] }))).toBe(true);
    expect(cancelsLinksFor(draftFromDiff(rulesDraft({ cards: [...PRESETS.ask_first], diff: { added: [...PRESETS.ask_first], removed: RIVERA_CARDS, changed: [] } }), ACTIVE, 'ask_first'))).toBe(true);
    const danaLink: RuleCard = { ...link, card_id: 'card-dana-link', mode: 'ask', who: 'person', person_id: DANA.personId, max_amount_cents: null, review: false, reason: 'Dana asks you first.' };
    expect(cancelsLinksFor(draftOf({ added: [danaLink] }))).toBe(true);
    expect(cancelsLinksFor(draftOf({ added: [{ ...danaLink, card_id: 'card-charges', applies_to: 'effect:charge' }] }))).toBe(true);

    // False: a raise alone, the link rule's limit raised or its reason reworded, a change elsewhere.
    expect(cancelsLinksFor(draftOf({ cap: 500_000 }))).toBe(false);
    expect(cancelsLinksFor(draftOf({ pairs: [[link, changed(link, { max_amount_cents: 45_000 })]] }))).toBe(false);
    expect(cancelsLinksFor(draftOf({ pairs: [[link, changed(link, { max_amount_cents: null })]] }))).toBe(false);
    expect(cancelsLinksFor(draftOf({ pairs: [[link, changed(link, { reason: 'Links up to $300.' })]] }))).toBe(false);
    expect(cancelsLinksFor(draftOf({ pairs: [[ruleCards['rv-quote'], changed(ruleCards['rv-quote'], { mode: 'ask' })]] }))).toBe(false);
    expect(cancelsLinksFor(draftOf({}))).toBe(false);
    // An ask card on the link that changes can't cancel a link Claude made on its own.
    const askLink = changed(link, { mode: 'ask', max_amount_cents: null });
    expect(cancelsLinksFor(draftFromDiff(rulesDraft({ cards: [changed(askLink, { reason: 'x' })], diff: { added: [], removed: [], changed: [[askLink, changed(askLink, { who: 'verified' })]] } }), ACTIVE))).toBe(false);
  });

  it('tool_draft_rows_are_turned_on', () => {
    // Payments turned on for a Desk with no rule for it: both tools start at "Ask me first".
    const noPayments = RIVERA_CARDS.filter((card) => !['rv-link', 'rv-mandate'].includes(card.card_id));
    const turnedOn = [toolRow('native.payment_link', { status: 'needs_review' }), toolRow('native.charge_mandate', { status: 'needs_review' })];
    const draft = draftFromVersion(version(7, noPayments), version(8, noPayments), turnedOn);
    expect(draft.turnedOn).toEqual(turnedOn);
    const rows = changeRows(draft, PEOPLE, TOOLS);
    expect(rows).toMatchObject([
      { key: 'turned-on:native.payment_link', change: 'turned_on', title: 'Payment link', connector: view('payments'), before: null, after: DEFAULT_SIDE, changed: [] },
      {
        key: 'turned-on:native.charge_mandate',
        change: 'turned_on',
        title: 'Charge within a signed limit',
        connector: view('payments'),
        before: null,
        after: DEFAULT_SIDE,
        changed: [],
      },
    ]);

    // With an automatic rule for anyone on payment links, that tool turns on at "Automatic", up to its limit.
    const withLink = [...noPayments, ruleCards['rv-link']];
    const covered = changeRows(draftFromVersion(version(7, withLink), version(8, withLink), turnedOn), PEOPLE, TOOLS);
    expect(covered.map((row) => [row.key, row.after?.mode, row.after?.limit])).toEqual([
      ['turned-on:native.payment_link', 'auto', '$300'],
      ['turned-on:native.charge_mandate', 'ask', undefined],
    ]);
    // A rule for one person runs for her, so the tool turns on at "Automatic" in her rule's words.
    const forDana: RuleCard = { ...ruleCards['rv-link'], card_id: 'card-dana-links', who: 'person', person_id: DANA.personId, reason: 'Dana pays by link up to $300.' };
    const linkOn = (cards: RuleCard[]) => changeRows(draftFromVersion(version(7, cards), version(8, cards), turnedOn.slice(0, 1)), PEOPLE, TOOLS)[0]?.after;
    expect(linkOn([...noPayments, forDana])).toMatchObject({ mode: 'auto', limit: '$300', reason: forDana.reason, words: ruleWords(forDana, PEOPLE) });
    // At the same limit as the rule for anyone, the row reads by that rule; above it, by hers.
    expect(linkOn([...noPayments, ruleCards['rv-link'], forDana])).toMatchObject({ mode: 'auto', limit: '$300', reason: ruleCards['rv-link'].reason });
    const danaMore: RuleCard = { ...forDana, card_id: 'card-dana-links-450', max_amount_cents: 45_000, reason: 'Dana pays by link up to $450.' };
    expect(linkOn([...noPayments, ruleCards['rv-link'], danaMore])).toMatchObject({ mode: 'auto', limit: '$450', reason: danaMore.reason });

    // The outcome follows precedence, not the first rule listed. A never rule always wins: an
    // automatic Refund rule beside "never send money out" turns Refund on at Never.
    const refundOn = [toolRow('payments.create_refund', { status: 'needs_review' })];
    const turnOn = (cards: RuleCard[]) => changeRows(draftFromVersion(version(7, cards), version(8, cards), refundOn), PEOPLE, TOOLS)[0]?.after;
    const refundAuto: RuleCard = { ...ruleCards['rv-refund'], card_id: 'card-refund-auto', mode: 'auto', who: 'anyone', max_amount_cents: 5_000, reason: 'Refunds up to $50 go through.' };
    const neverPayOut: RuleCard = { card_id: 'card-never-pay-out', applies_to: 'effect:pay_out', mode: 'never', who: 'anyone', reason: 'Money never goes out.' };
    const noRefund = RIVERA_CARDS.filter((card) => card.card_id !== 'rv-refund');
    expect(turnOn([...noRefund, refundAuto, neverPayOut])).toMatchObject({ mode: 'never', reason: neverPayOut.reason, words: ruleWords(neverPayOut, PEOPLE) });
    // An automatic and an ask rule at the same specificity ask, whichever comes first.
    const refundAsk: RuleCard = { ...refundAuto, card_id: 'card-refund-ask', mode: 'ask', max_amount_cents: null, reason: 'Refunds wait for you.' };
    expect(turnOn([...noRefund, refundAuto, refundAsk])).toMatchObject({ mode: 'ask', reason: refundAsk.reason });
    expect(turnOn([...noRefund, refundAsk, refundAuto])).toMatchObject({ mode: 'ask', reason: refundAsk.reason });
    // A more specific automatic rule still decides over a shared one that asks.
    const askPayOut: RuleCard = { ...neverPayOut, card_id: 'card-ask-pay-out', mode: 'ask', reason: 'Sending money out asks you first.' };
    expect(turnOn([...noRefund, askPayOut, refundAuto])).toMatchObject({ mode: 'auto', reason: refundAuto.reason, limit: '$50' });
    // Shared automatic rules cover a tool with several effects only together: with sending money
    // out alone, Refund asks; with private data for verified customers too, a verified customer's
    // refund runs on its own, so Refund turns on at Automatic, as Rules would read it.
    const autoPayOut: RuleCard = { ...neverPayOut, card_id: 'card-auto-pay-out', mode: 'auto', reason: 'Money goes out on its own.' };
    expect(turnOn([...noRefund, autoPayOut])).toMatchObject(DEFAULT_SIDE);
    const verifiedData: RuleCard = { ...autoPayOut, card_id: 'card-verified-data', applies_to: 'effect:private_data', who: 'verified', reason: 'Verified customers see their own records.' };
    expect(turnOn([...noRefund, autoPayOut, verifiedData])).toMatchObject({ mode: 'auto', reason: autoPayOut.reason });
    const anyoneData: RuleCard = { ...verifiedData, card_id: 'card-anyone-data', who: 'anyone' };
    expect(turnOn([...noRefund, autoPayOut, anyoneData])).toMatchObject({ mode: 'auto', reason: autoPayOut.reason });
  });

  it('turned_on_rows_read_as_rules_does', () => {
    // A tool a change turns on starts at the outcome Rules shows for the same rules: the most that
    // runs on its own for some visitor, at its largest limit.
    const rule = (fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode'> & Partial<RuleCard>): RuleCard => ({ who: 'anyone', reason: `${fields.card_id}.`, ...fields });
    const without = (...cardIds: string[]) => RIVERA_CARDS.filter((card) => !cardIds.includes(card.card_id));
    const weekdays: RuleCard['hours'] = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '17:00:00' };
    const cases: { name: string; tool: ToolRow['tool']; cards: RuleCard[]; mode: RuleCard['mode']; limit?: string }[] = [
      {
        name: 'a never rule on charges for verified customers leaves strangers automatic',
        tool: 'native.payment_link',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-charges-verified-never', applies_to: 'effect:charge', mode: 'never', who: 'verified' })],
        mode: 'auto',
        limit: '$300',
      },
      {
        name: 'an ask rule for verified customers leaves strangers automatic',
        tool: 'native.quote',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-quote-verified-ask', applies_to: 'native.quote', mode: 'ask', who: 'verified' })],
        mode: 'auto',
      },
      {
        name: "a quote is no one's record, so a never rule for record owners refuses no one",
        tool: 'native.quote',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-change-owner-never', applies_to: 'effect:change', mode: 'never', who: 'record_owner' })],
        mode: 'auto',
      },
      {
        name: 'a larger limit for verified customers is the largest that runs',
        tool: 'native.payment_link',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-link-verified', applies_to: 'native.payment_link', mode: 'auto', who: 'verified', max_amount_cents: 50_000 })],
        mode: 'auto',
        limit: '$500',
      },
      {
        name: 'a shared never rule for anyone refuses everyone',
        tool: 'native.payment_link',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-charges-never', applies_to: 'effect:charge', mode: 'never' })],
        mode: 'never',
      },
      {
        name: 'shared rules on two effects hold together, at the tighter limit',
        tool: 'payments.create_refund',
        cards: [
          ...without('rv-refund'),
          rule({ card_id: 'card-pay-out-100', applies_to: 'effect:pay_out', mode: 'auto', max_amount_cents: 10_000 }),
          rule({ card_id: 'card-private-50', applies_to: 'effect:private_data', mode: 'auto', max_amount_cents: 5_000 }),
        ],
        mode: 'auto',
        limit: '$50',
      },
      {
        name: 'limits over the week: the largest at any time',
        tool: 'native.payment_link',
        cards: [
          ...without('rv-link'),
          rule({ card_id: 'card-link-weekdays', applies_to: 'native.payment_link', mode: 'auto', max_amount_cents: 10_000, hours: weekdays }),
          rule({ card_id: 'card-link-saturdays', applies_to: 'native.payment_link', mode: 'auto', max_amount_cents: 30_000, hours: { days: ['sat'], start: '09:00:00', end: '13:00:00' } }),
        ],
        mode: 'auto',
        limit: '$300',
      },
      {
        name: "Dana's own rule above the rule for anyone runs up to hers",
        tool: 'native.payment_link',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-dana-links', applies_to: 'native.payment_link', mode: 'auto', who: 'person', person_id: DANA.personId, max_amount_cents: 45_000 })],
        mode: 'auto',
        limit: '$450',
      },
      {
        name: "Dana's own automatic refunds outrank the ask for record owners",
        tool: 'payments.create_refund',
        cards: [...RIVERA_CARDS, rule({ card_id: 'card-dana-refunds', applies_to: 'payments.create_refund', mode: 'auto', who: 'person', person_id: DANA.personId, max_amount_cents: 18_000 })],
        mode: 'auto',
        limit: '$180',
      },
      {
        name: "an agent's rule runs for the agent",
        tool: 'native.payment_link',
        cards: [...without('rv-link'), rivera.sharedChargeCard],
        mode: 'auto',
        limit: '$20',
      },
      {
        name: 'shared rules whose hours never meet never run together',
        tool: 'native.release_document',
        cards: [
          ...without('rv-docs'),
          rule({ card_id: 'card-private-mon', applies_to: 'effect:private_data', mode: 'auto', hours: { days: ['mon'], start: '09:00:00', end: '17:00:00' } }),
          rule({ card_id: 'card-messages-tue', applies_to: 'effect:send_message', mode: 'auto', hours: { days: ['tue'], start: '09:00:00', end: '17:00:00' } }),
        ],
        mode: 'ask',
      },
    ];
    for (const { name, tool, cards, mode, limit } of cases) {
      const onRules = hubSections({ active: version(8, cards), tools: TOOLS }, PEOPLE)
        .flatMap((section) => section.tools)
        .find((row) => row.key === tool);
      const turnedOn = changeRows(draftFromVersion(version(7, cards), version(8, cards), [toolRow(tool, { status: 'needs_review' })]), PEOPLE, TOOLS)[0]?.after;
      expect({ mode: onRules?.mode, limit: onRules?.limit }, `${name}, on Rules`).toEqual({ mode, limit });
      expect({ mode: turnedOn?.mode, limit: turnedOn?.limit }, `${name}, turned on`).toEqual({ mode, limit });
    }
  });
});
