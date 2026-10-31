/**
 * The Rules page's model: the Desk's tools grouped by connector with the outcome each one's rules
 * give it, the rules that govern a tool (for the connector and tool pages), the card an outcome
 * menu drafts, and the payment limit's field.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { RuleCard, ToolName } from '../../api/contracts.ts';
import type { PeopleOut, RulesView, ToolRow } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { peopleOut, rulesView } from '../../mocks/readModels.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { validateContract } from '../../mocks/validate.ts';
import type { DeskRecord } from '../../mocks/world.ts';
import { governingRules, hubSections, parseLimit, toolFallback, toolRuleRows, withOutcome } from './hub.ts';

/** The mock's main Desk, a fresh Rivera copy for every test. */
function desk(): DeskRecord {
  const found = mockStore.world.desk(RIVERA.deskId);
  if (!found) throw new Error('the mock has the main Desk');
  return found;
}

/** Rivera's rules as the owner reads them, with `extra` cards active beside the seed's. */
function view(extra: readonly RuleCard[] = []): RulesView {
  desk().policy.cards = [...desk().policy.cards, ...extra.map((card) => ({ ...card }))];
  return rulesView(desk());
}

function people(): PeopleOut {
  return peopleOut(mockStore.world, desk());
}

/** The tool row for `tool`, which every Rivera copy has. */
function rowOf(rules: RulesView, tool: ToolName): ToolRow {
  const row = rules.tools.find((r) => r.tool === tool);
  if (!row) throw new Error(`Rivera has ${tool}`);
  return row;
}

/** A rule for anyone, at every optional field's default unless `fields` sets it. */
function card(fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode' | 'reason'> & Partial<RuleCard>): RuleCard {
  return { who: 'anyone', person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false, ...fields };
}

beforeEach(() => {
  mockStore.reset('rivera');
});

describe('the Rules hub', () => {
  it('tools_group_by_connector', () => {
    const sections = hubSections(view([rivera.sharedChargeCard]), people());

    // Each connector that is on, in the catalog's order, with its page and each tool's page.
    expect(sections.map((s) => s.connector.id)).toEqual(['quotes', 'bookings', 'leads', 'verification', 'documents', 'payments', 'stripe']);
    for (const section of sections) {
      expect(section.href).toBe(`connectors/${section.connector.id}`);
      for (const tool of section.tools) expect(tool.href).toBe(`connectors/${section.connector.id}/${encodeURIComponent(tool.key)}`);
    }
    expect(sections.find((s) => s.connector.id === 'stripe')?.tools.map((t) => t.href)).toEqual([
      'connectors/stripe/payments.list_charges',
      'connectors/stripe/payments.create_refund',
    ]);
    // Never Google Calendar, or the setup interview's own tools.
    const keys = sections.flatMap((s) => s.tools.map((t) => t.key));
    expect(keys).not.toContain('native.fetch_website');
    expect(keys).not.toContain('native.read_memory');
    expect(sections.map((s) => s.connector.id)).not.toContain('google_calendar');
    // The payment limit's line sits atop Payments and Stripe only.
    expect(sections.filter((s) => s.moneyLimit).map((s) => s.connector.id)).toEqual(['payments', 'stripe']);

    // As the signed presets board lists them: each connector, and each tool's name and line.
    for (const board of rivera.connectors.sections) {
      const section = sections.find((s) => s.connector.id === board.connector.id);
      expect(section?.connector, board.connector.id).toEqual(board.connector);
      expect(section?.tools.map((t) => [t.key, t.name, t.description])).toEqual(board.tools.map((t) => [t.key, t.name, t.description]));
    }

    // A connector whose tools are all off leaves the list; one with a changed tool stays on.
    desk().tools = desk().tools.map((tool) =>
      tool.tool === 'payments.list_charges' ? { ...tool, status: 'disabled' } : tool.tool === 'payments.create_refund' ? { ...tool, status: 'needs_review' } : tool,
    );
    expect(hubSections(rulesView(desk()), people()).map((s) => s.connector.id)).not.toContain('stripe');
    desk().tools = desk().tools.map((tool) => (tool.tool === 'payments.create_refund' ? { ...tool, status: 'needs_review', pending_sha256: 'b'.repeat(64) } : tool));
    const stripe = hubSections(rulesView(desk()), people()).find((s) => s.connector.id === 'stripe');
    expect(stripe?.tools.map((t) => [t.key, t.status])).toEqual([
      ['payments.list_charges', 'disabled'],
      ['payments.create_refund', 'needs_review'],
    ]);
  });

  it('effect_cards_cover_their_tools', () => {
    // Without the payment tools' own rules, one automatic rule on every tool that charges money
    // governs both of them, and not Refund, which sends money out.
    desk().policy.cards = desk().policy.cards.filter((card) => card.card_id !== 'rv-link' && card.card_id !== 'rv-mandate');
    const charges = card({ card_id: 'card-charges', applies_to: 'effect:charge', mode: 'auto', max_amount_cents: 10_000, reason: 'Payments up to $100.' });
    const rules = view([charges]);
    const governed = (tool: ToolName) => governingRules(rowOf(rules, tool), rules.active).map((c) => c.card_id);
    expect(governed('native.payment_link')).toEqual(['card-charges']);
    expect(governed('native.charge_mandate')).toEqual(['card-charges']);
    expect(governed('payments.create_refund')).toEqual(['rv-refund']);
    expect(governed('native.quote')).toEqual(['rv-quote']);
  });

  it('send_message_auto_alone_does_not_cover_documents', () => {
    // Share a document also touches private data, so an automatic rule on sending messages alone
    // decides nothing there: no row, and the fallback says anything else asks.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-docs');
    const messages = card({ card_id: 'card-messages', applies_to: 'effect:send_message', mode: 'auto', reason: 'Messages go out on their own.' });
    const rules = view([messages]);
    const documents = rowOf(rules, 'native.release_document');
    expect(toolRuleRows(documents, rules.active, people(), rules.tools)).toEqual([]);
    expect(toolFallback(documents, rules.active)).toBe(true);

    // A never rule for anyone on private data leaves nothing to ask about there.
    const never = card({ card_id: 'card-private-never', applies_to: 'effect:private_data', mode: 'never', reason: 'Private data never goes out.' });
    const closed = view([never]);
    expect(toolRuleRows(rowOf(closed, 'native.release_document'), closed.active, people(), closed.tools).map((r) => r.rule.card_id)).toEqual([
      'card-private-never',
    ]);
    expect(toolFallback(rowOf(closed, 'native.release_document'), closed.active)).toBe(false);
    // Never for one person still leaves everyone else to ask about.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== never.card_id);
    const forDana = card({ ...never, card_id: 'card-dana-never', who: 'person', person_id: rivera.people.dana.personId });
    const dana = view([forDana]);
    expect(toolFallback(rowOf(dana, 'payments.list_charges'), dana.active)).toBe(true);
  });

  it('joint_effect_cards_cover_documents', () => {
    // Automatic rules on both of its effects, at one specificity, cover it jointly: both show.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-docs');
    const messages = card({ card_id: 'card-messages', applies_to: 'effect:send_message', mode: 'auto', reason: 'Messages go out on their own.' });
    const privateData = card({ card_id: 'card-private', applies_to: 'effect:private_data', mode: 'auto', who: 'record_owner', reason: 'Customers get their own records.' });
    const rules = view([messages, privateData]);
    const rows = toolRuleRows(rowOf(rules, 'native.release_document'), rules.active, people(), rules.tools);
    expect(rows.map((r) => r.rule.card_id)).toEqual(['card-messages', 'card-private']);
    expect(rows.map((r) => r.words.map((w) => w.text))).toEqual([['Anyone'], ["The record's owner, verified"]]);
    expect(rows.every((r) => r.shared !== undefined)).toBe(true);
    // Refund also sends money out, so the automatic private data rule covers it only with one on that.
    expect(rows[1]?.shared?.appliesTo).toBe('Applies to every tool that touches private data: Share a document and See charges.');
  });

  it('agent_rule_comes_first', () => {
    // The demo agent's rule on every tool that charges money is for one agent, so it outranks each
    // payment tool's own rule for everyone, and comes first under both.
    const rules = view([rivera.sharedChargeCard]);
    for (const [tool, own] of [
      ['native.payment_link', 'rv-link'],
      ['native.charge_mandate', 'rv-mandate'],
    ] as const) {
      const rows = toolRuleRows(rowOf(rules, tool), rules.active, people(), rules.tools);
      expect(rows.map((r) => r.rule.card_id), tool).toEqual(['rv-agent-charges', own]);
      const [agent, mine] = rows;
      expect(agent?.shared).toEqual({ appliesTo: rivera.sharedChargeAppliesTo });
      expect(agent?.shared?.appliesTo).toBe('Applies to every tool that charges money: Payment link and Charge within a signed limit.');
      expect(agent?.limit).toBe('$20');
      // The API names no agent yet.
      expect(agent?.words).toEqual([
        { field: 'who', text: 'One agent' },
        { field: 'limits', text: 'Up to $20' },
      ]);
      expect(mine?.shared).toBeUndefined();
    }
    expect(toolRuleRows(rowOf(rules, 'native.payment_link'), rules.active, people(), rules.tools)[1]?.limit).toBe('$300');
    // Refund sends money out and charges nothing: the agent's rule isn't under it.
    expect(toolRuleRows(rowOf(rules, 'payments.create_refund'), rules.active, people(), rules.tools).map((r) => r.rule.card_id)).toEqual(['rv-refund']);
  });

  it('setup_tools_are_hidden', () => {
    // Website and memory reading are the setup interview's own: no section lists them, and no
    // shared rule names them among the tools it covers, even with a rule that governs them.
    const reads = card({ card_id: 'card-reads-never', applies_to: 'effect:read', mode: 'never', reason: 'Nothing that only reads runs.' });
    const rules = view([reads]);
    const sections = hubSections(rules, people());
    const listed = sections.flatMap((s) => s.tools.map((t) => t.key));
    expect(listed).toEqual(rivera.connectors.sections.flatMap((s) => s.tools.map((t) => t.key)));
    expect(governingRules(rowOf(rules, 'native.fetch_website'), rules.active).map((c) => c.card_id)).toContain('card-reads-never');
    const rows = toolRuleRows(rowOf(rules, 'native.find_slots'), rules.active, people(), rules.tools);
    expect(rows.find((r) => r.rule.card_id === 'card-reads-never')?.shared?.appliesTo).toBe('Applies to every tool that only reads: Find open times.');
    // Without the Desk's tools, a shared rule names its group alone.
    expect(toolRuleRows(rowOf(rules, 'native.find_slots'), rules.active, people()).find((r) => r.rule.card_id === 'card-reads-never')?.shared?.appliesTo).toBe(
      'Applies to every tool that only reads.',
    );
  });

  it('outcome_change_keeps_cards_valid', () => {
    const rules = view();
    const { ruleCards } = rivera;
    const valid = (result: RuleCard | { error: string }): RuleCard => {
      if ('error' in result) throw new Error(result.error);
      expect(validateContract('RuleCard', result)).toEqual([]);
      return result;
    };
    const link = rowOf(rules, 'native.payment_link');

    // To "Ask me first" or "Never", the automatic rule's own fields go.
    const linkAsks = valid(withOutcome(ruleCards['rv-link'], 'ask', link, 50_000));
    expect(linkAsks).toEqual({ ...ruleCards['rv-link'], mode: 'ask', max_amount_cents: null, review: false });
    const bookNever = valid(withOutcome(ruleCards['rv-book-wk'], 'never', rowOf(rules, 'native.book'), 50_000));
    expect(bookNever).toMatchObject({ mode: 'never', hours: null, review: false, card_id: 'rv-book-wk', reason: ruleCards['rv-book-wk'].reason });
    const discounted = { ...ruleCards['rv-quote'], max_discount_bp: 1000 };
    expect(valid(withOutcome(discounted, 'ask', rowOf(rules, 'native.quote'), 50_000)).max_discount_bp).toBe(0);

    // To "Automatic", a money rule with no limit takes the payment limit, which the review shows.
    const refund = rowOf(rules, 'payments.create_refund');
    expect(valid(withOutcome(ruleCards['rv-refund'], 'auto', refund, 50_000))).toEqual({ ...ruleCards['rv-refund'], mode: 'auto', max_amount_cents: 50_000 });
    const charges = card({ card_id: 'card-charges', applies_to: 'effect:charge', mode: 'ask', reason: 'Payments ask you first.' });
    expect(valid(withOutcome(charges, 'auto', link, 20_000)).max_amount_cents).toBe(20_000);
    expect(valid(withOutcome(linkAsks, 'auto', link, 50_000)).max_amount_cents).toBe(50_000);
    // A rule that keeps its own limit, or moves no money, stays as it is.
    expect(valid(withOutcome(ruleCards['rv-link'], 'auto', link, 50_000))).toEqual(ruleCards['rv-link']);
    expect(valid(withOutcome({ ...ruleCards['rv-quote'], mode: 'ask' }, 'auto', rowOf(rules, 'native.quote'), 0))).toEqual(ruleCards['rv-quote']);

    // With no limit set, a money rule can't be made automatic: nothing is drafted. Other rules can.
    expect(valid(withOutcome({ ...ruleCards['rv-book-wk'], mode: 'ask' }, 'auto', rowOf(rules, 'native.book'), 0)).mode).toBe('auto');
    expect(withOutcome(ruleCards['rv-refund'], 'auto', refund, 0)).toEqual({ error: "You haven't set a limit for taking money without asking. Set one first." });
  });

  it('summary_names_rules_and_shared_ones', () => {
    const sections = hubSections(view([rivera.sharedChargeCard]), people());
    const tool = (key: ToolName) => {
      const found = sections.flatMap((s) => s.tools).find((t) => t.key === key);
      if (!found) throw new Error(`no ${key} on the hub`);
      return found;
    };
    expect(tool('native.quote')).toMatchObject({ summary: 'Anyone · No discounts', mode: 'auto' });
    expect(tool('native.quote').limit).toBeUndefined();
    // The agent's shared rule and the tool's own: the outcome is the rule for everyone's, with its limit.
    expect(tool('native.payment_link')).toMatchObject({ summary: '2 rules · 1 shared', mode: 'auto', limit: '$300' });
    expect(tool('native.start_verification')).toMatchObject({ summary: 'Always on', mode: 'auto' });
    expect(tool('payments.create_refund')).toMatchObject({ summary: 'The customer who paid, verified', mode: 'ask' });
    // A rule for the record's owner is the most general one there.
    expect(tool('native.release_document')).toMatchObject({ summary: "The record's owner, verified", mode: 'auto' });
    // Every row as the signed presets board draws it.
    for (const board of rivera.connectors.sections) {
      const section = sections.find((s) => s.connector.id === board.connector.id);
      expect(
        section?.tools.map(({ key, summary, mode, limit, status }) => ({ key, summary, mode, limit, status })),
        board.connector.id,
      ).toEqual(board.tools.map(({ key, summary, mode, status, ...rest }) => ({ key, summary, mode, limit: 'limit' in rest ? rest.limit : undefined, status })));
    }

    // A tool with no rule of the owner's: none yet, and it asks.
    desk().policy.cards = desk().policy.cards.filter((c) => c.applies_to !== 'native.quote');
    const bare = hubSections(rulesView(desk()), people()).flatMap((s) => s.tools).find((t) => t.key === 'native.quote');
    expect(bare).toMatchObject({ summary: 'No rule yet', mode: 'ask' });
    // Only a rule for one person: everyone else is asked about.
    const dana = view([rivera.personalBookingCard]);
    desk().policy.cards = desk().policy.cards.filter((c) => !c.card_id.startsWith('rv-book'));
    const book = hubSections(rulesView(desk()), people()).flatMap((s) => s.tools).find((t) => t.key === 'native.book');
    expect(dana.active.cards.some((c) => c.card_id === 'rv-dana-book')).toBe(true);
    expect(book).toMatchObject({ summary: 'Dana Whitfield', mode: 'ask' });
  });

  it('limit_field_takes_whole_dollars', () => {
    expect(parseLimit('1000')).toEqual({ cents: 100_000 });
    expect(parseLimit('0')).toEqual({ cents: 0 });
    expect(parseLimit(' 500 ')).toEqual({ cents: 50_000 });
    expect(parseLimit('10000')).toEqual({ cents: 1_000_000 });
    for (const above of ['10001', '99999999999999999999']) expect(parseLimit(above), above).toEqual({ error: 'No single payment can be above $10,000.' });
    for (const wrong of ['12.5', '-1', '1e3', '', '1,000', '$500', 'five']) {
      expect(parseLimit(wrong), wrong).toEqual({ error: 'Enter whole dollars, from 0 to 10,000.' });
    }
  });
});
