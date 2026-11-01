/**
 * The Rules page's model: the Desk's tools grouped by connector with the outcome each one's rules
 * give it, the rules that govern a tool (for the connector and tool pages), the card an outcome
 * menu drafts, the payment limit's field, and the held request Ask Claude's suggestions ask about.
 */
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { RuleCard, ToolName } from '../../api/contracts.ts';
import type { NeedsYouItem, PeopleOut, RulesView, ToolRow } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { describeEffects, type ToolSummaryView } from '../../ds/index.ts';
import { needsYou, peopleOut, rulesView } from '../../mocks/readModels.ts';
import { PRESETS, RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { validateContract } from '../../mocks/validate.ts';
import type { DeskRecord } from '../../mocks/world.ts';
import { changeRows } from './changeRows.ts';
import { draftFromDiff, type RuleDraft } from './drafts.ts';
import { governingRules, holdQuestion, hubSections, parseLimit, rowsChangedBy, toolFallback, toolLine, toolRuleRows, withOutcome } from './hub.ts';
import { targetWords } from './ruleWords.ts';

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

/** `tool`'s row on the hub, which every Rivera copy lists. */
function hubTool(rules: RulesView, tool: ToolName): ToolSummaryView {
  const found = hubSections(rules, people())
    .flatMap((s) => s.tools)
    .find((t) => t.key === tool);
  if (!found) throw new Error(`no ${tool} on the hub`);
  return found;
}

beforeEach(() => {
  mockStore.reset('rivera');
});

describe('the Rules hub', () => {
  it('says_the_payment_tools_cant_be_undone_as_the_kernels_profiles_do', () => {
    // A charge can't be taken back: the kernel's payment link and signed-limit profiles say so.
    const rules = view();
    expect(hubTool(rules, 'native.payment_link').description).toBe("Makes a one-time link for a quote. Charges money. Can't be undone.");
    expect(hubTool(rules, 'native.charge_mandate').description).toBe("Lets a visiting agent pay from its owner's signed limit. Charges money. Can't be undone.");
  });

  it('uses a business description followed by its effects', () => {
    for (const tool of chenBusinessTools) {
      expect(toolLine(tool)).toBe(`${tool.business?.description} ${describeEffects(tool.effects, tool.reversible)}`);
    }
    const intro = chenBusinessTools[0];
    if (!intro?.business) throw new Error('Chen has an intro call tool');
    const effects = describeEffects(intro.effects, intro.reversible);
    expect(toolLine({ ...intro, business: null })).toBe(`A connected tool ${effects}`);
    expect(toolLine({ ...intro, business: { ...intro.business, title: '  ' } })).toBe(`A connected tool ${effects}`);
    expect(toolLine({ ...intro, tool: 'desk.unknown', business: null })).toBe(`A connected tool ${effects}`);
  });

  it('names listed business tools in shared rules without adding connector rows', () => {
    const shared = card({ card_id: 'changes', applies_to: 'effect:change', mode: 'never', reason: 'Changes never run.' });
    const rules = view([shared]);
    const tools = [...rules.tools, ...chenBusinessTools];
    expect(() => hubSections({ ...rules, tools }, people())).not.toThrow();
    expect(hubSections({ ...rules, tools }, people()).flatMap((section) => section.tools).some((tool) => tool.key.startsWith('desk.'))).toBe(false);
    const rows = toolRuleRows(rowOf(rules, 'native.book'), rules.active, people(), tools);
    expect(rows.find((row) => row.rule.card_id === 'changes')?.shared?.appliesTo).toContain('New client intake');
  });

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
    expect(keys).not.toContain('native.web_search');
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
    desk().tools = desk().tools.map((tool) =>
      tool.tool === 'payments.create_refund' ? { ...tool, status: 'needs_review', pending_sha256: 'b'.repeat(64), review_reason: 'changed' } : tool,
    );
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
    // The Desk's tools are required, so no caller drops the names of the tools a shared rule covers;
    // given none, a shared rule names its group alone.
    type Args = Parameters<typeof toolRuleRows>;
    expectTypeOf<[Args[0], Args[1], Args[2]]>().not.toExtend<Args>();
    expect(toolRuleRows(rowOf(rules, 'native.find_slots'), rules.active, people(), []).find((r) => r.rule.card_id === 'card-reads-never')?.shared?.appliesTo).toBe(
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
    // The only rule there, for the record's owner, decides it.
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
    // Only a rule for one person: it runs for her, so Book a visit reads automatic.
    const dana = view([rivera.personalBookingCard]);
    desk().policy.cards = desk().policy.cards.filter((c) => !c.card_id.startsWith('rv-book'));
    const book = hubSections(rulesView(desk()), people()).flatMap((s) => s.tools).find((t) => t.key === 'native.book');
    expect(dana.active.cards.some((c) => c.card_id === 'rv-dana-book')).toBe(true);
    expect(book).toMatchObject({ summary: 'Dana Whitfield', mode: 'auto' });
  });

  it('summary_is_the_most_that_runs_for_some_visitor', () => {
    // A tool's outcome is the most that runs on its own for some visitor: the kernel's precedence
    // for a stranger, for a verified customer and, where records have owners, for a record's owner,
    // each with the rules for them; then the most permissive of the three, at its largest limit.
    // Quote stays automatic for strangers beside an ask rule for verified customers.
    const verifiedAsk = card({ card_id: 'card-quote-verified-ask', applies_to: 'native.quote', mode: 'ask', who: 'verified', reason: 'Quotes for verified customers ask you first.' });
    expect(hubTool(view([verifiedAsk]), 'native.quote')).toMatchObject({ summary: '2 rules', mode: 'auto' });
    // An ask rule for anyone at the same rank asks for every visitor.
    const anyoneAsk = card({ ...verifiedAsk, card_id: 'card-quote-anyone-ask', who: 'anyone' });
    expect(hubTool(view([anyoneAsk]), 'native.quote')).toMatchObject({ summary: '3 rules', mode: 'ask' });

    // Payment link, up to $300 for anyone and up to $500 for verified customers: up to $500.
    const verifiedLink = card({
      card_id: 'card-link-verified',
      applies_to: 'native.payment_link',
      mode: 'auto',
      who: 'verified',
      max_amount_cents: 50_000,
      reason: 'Verified customers pay by link up to $500.',
    });
    expect(hubTool(view([verifiedLink]), 'native.payment_link')).toMatchObject({ summary: '2 rules', mode: 'auto', limit: '$500' });

    // For one visitor the most specific rule decides: a shared ask rule for anyone ranks below Share
    // a document's own automatic rule for the record's owner, so the owner's request runs.
    // (Not one on sending messages: that would hold Confirm it's them, which the kernel refuses.)
    const privateAsk = card({ card_id: 'card-private-ask', applies_to: 'effect:private_data', mode: 'ask', reason: 'Private data asks you first.' });
    expect(hubTool(view([privateAsk]), 'native.release_document')).toMatchObject({ summary: '2 rules · 1 shared', mode: 'auto' });
  });

  it('summary_is_never_only_when_every_visitor_is_refused', () => {
    // A shared never rule for anyone refuses everyone: Payment link reads "Never" beside its own
    // automatic rule up to $300, with no limit to show.
    const noCharges = card({ card_id: 'card-charges-never', applies_to: 'effect:charge', mode: 'never', reason: 'No payments for now.' });
    const link = hubTool(view([noCharges]), 'native.payment_link');
    expect(link).toMatchObject({ summary: '2 rules · 1 shared', mode: 'never' });
    expect(link.limit).toBeUndefined();

    // One for verified customers leaves a stranger's link automatic, up to $300.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== noCharges.card_id);
    const verifiedNever = card({ ...noCharges, card_id: 'card-charges-verified-never', who: 'verified' });
    expect(hubTool(view([verifiedNever]), 'native.payment_link')).toMatchObject({ summary: '2 rules · 1 shared', mode: 'auto', limit: '$300' });

    // One for one person says nothing about everyone else.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== verifiedNever.card_id);
    const danaNever = card({ ...noCharges, card_id: 'card-charges-dana-never', who: 'person', person_id: rivera.people.dana.personId });
    expect(hubTool(view([danaNever]), 'native.payment_link')).toMatchObject({ summary: '2 rules · 1 shared', mode: 'auto', limit: '$300' });
  });

  it('record_owner_rules_count_only_where_records_have_owners', () => {
    // A quote is no one's record, so a never rule for record owners, on Quote or on every tool that
    // changes something, refuses no one: Quote stays automatic.
    const quoteNever = card({ card_id: 'card-quote-owner-never', applies_to: 'native.quote', mode: 'never', who: 'record_owner', reason: 'Record owners get no quotes.' });
    expect(hubTool(view([quoteNever]), 'native.quote')).toMatchObject({ mode: 'auto' });
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== quoteNever.card_id);
    const changeNever = card({ ...quoteNever, card_id: 'card-change-owner-never', applies_to: 'effect:change' });
    expect(hubTool(view([changeNever]), 'native.quote')).toMatchObject({ mode: 'auto' });

    // A document is its owner's: a never rule for record owners beside their automatic rule refuses
    // its owner, the one visitor the always-on baseline lets have it.
    const docsNever = card({ card_id: 'card-docs-owner-never', applies_to: 'native.release_document', mode: 'never', who: 'record_owner', reason: 'No documents for now.' });
    expect(hubTool(view([docsNever]), 'native.release_document')).toMatchObject({ summary: '2 rules', mode: 'never' });
  });

  it('private_data_goes_only_to_the_record_owner', () => {
    // The always-on baseline gives private data only to the verified person the record belongs to,
    // so a tool that touches it runs for no stranger and no other verified customer, whatever the
    // rules say. Share a document, automatic for anyone, runs for its record's owner.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-docs');
    const docsForAnyone = card({ card_id: 'card-docs-anyone', applies_to: 'native.release_document', mode: 'auto', reason: 'Documents go out on their own.' });
    expect(hubTool(view([docsForAnyone]), 'native.release_document')).toMatchObject({ mode: 'auto' });
    // With a never rule for record owners beside it, the one visitor it could run for is refused.
    const docsOwnerNever = card({ card_id: 'card-docs-owner-never', applies_to: 'native.release_document', mode: 'never', who: 'record_owner', reason: 'No documents for now.' });
    expect(hubTool(view([docsOwnerNever]), 'native.release_document')).toMatchObject({ summary: '2 rules', mode: 'never' });

    // See charges, automatic for verified customers and asking for record owners: a verified
    // customer who isn't the owner gets nothing, and the owner is asked about.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-charges');
    const chargesVerified = card({ card_id: 'card-charges-verified', applies_to: 'payments.list_charges', mode: 'auto', who: 'verified', reason: 'Verified customers see charges.' });
    const chargesOwnerAsk = card({ card_id: 'card-charges-owner-ask', applies_to: 'payments.list_charges', mode: 'ask', who: 'record_owner', reason: 'Customers ask to see their charges.' });
    expect(hubTool(view([chargesVerified, chargesOwnerAsk]), 'payments.list_charges')).toMatchObject({ summary: '2 rules', mode: 'ask' });
  });

  it('named_people_and_agents_are_visitors_too', () => {
    // A rule for one person or one agent names a visitor of their own, who gets it on top of the
    // rules their standing gives them, so what runs for them counts too. "Allow only for this
    // person, always" drafts such a rule, at the held amount. Dana's own rule up to $450 beside
    // Payment link's $300 for anyone: her links up to $450 run.
    const dana = rivera.people.dana.personId;
    const danaLinks = card({ card_id: 'card-dana-links', applies_to: 'native.payment_link', mode: 'auto', who: 'person', person_id: dana, max_amount_cents: 45_000, reason: 'Dana pays by link up to $450.' });
    expect(hubTool(view([danaLinks]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$450' });
    // Refund asks the record's owner first, but Dana's own automatic rule up to $180 outranks that
    // for her: her refunds up to $180 run.
    const danaRefunds = card({
      card_id: 'card-dana-refunds',
      applies_to: 'payments.create_refund',
      mode: 'auto',
      who: 'person',
      person_id: dana,
      max_amount_cents: 18_000,
      reason: 'Refunds to Dana up to $180 go through.',
    });
    expect(hubTool(view([danaRefunds]), 'payments.create_refund')).toMatchObject({ mode: 'auto', limit: '$180' });
  });

  it('agent_rules_run_for_their_agents', () => {
    // An agent's rule names a visitor too, at the standing its session has. Without Payment link's
    // own rule, the demo agent's rule on every tool that charges money runs up to $20.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-link');
    expect(hubTool(view([rivera.sharedChargeCard]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$20' });
    // An agent never pays money out, whatever its rules say: the agent's automatic Refund rule runs
    // for no one, and Refund still asks the record's owner first.
    const agentRefunds = card({
      card_id: 'card-agent-refunds',
      applies_to: 'payments.create_refund',
      mode: 'auto',
      who: 'agent',
      agent_key_id: rivera.sharedChargeCard.agent_key_id,
      max_amount_cents: 5_000,
      reason: 'The assistant refunds up to $50.',
    });
    expect(hubTool(view([agentRefunds]), 'payments.create_refund')).toMatchObject({ mode: 'ask' });
  });

  it('a_named_rule_never_reads_stricter_than_the_group', () => {
    // A rule for one person or agent says what happens for them alone: one that refuses, or runs
    // less, leaves the outcome where everyone else's rules put it.
    const dana = rivera.people.dana.personId;
    const danaNever = card({ card_id: 'card-dana-links-never', applies_to: 'native.payment_link', mode: 'never', who: 'person', person_id: dana, reason: 'No links for Dana.' });
    expect(hubTool(view([danaNever]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$300' });
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== danaNever.card_id);
    const danaNarrow = card({ ...danaNever, card_id: 'card-dana-links-100', mode: 'auto', max_amount_cents: 10_000, reason: 'Dana pays by link up to $100.' });
    expect(hubTool(view([danaNarrow]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$300' });
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== danaNarrow.card_id);
    const agentNever = card({ ...rivera.sharedChargeCard, card_id: 'card-agent-charges-never', mode: 'never', max_amount_cents: null, reason: 'The assistant takes no payments.' });
    expect(hubTool(view([agentNever]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$300' });
  });

  it('money_moves_only_in_an_amount_above_zero', () => {
    // The always-on baseline refuses money with no amount above zero, so an automatic rule up to $0
    // runs for no one: Payment link asks, with no limit to show.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-link');
    const linksUpToZero = card({ card_id: 'card-link-zero', applies_to: 'native.payment_link', mode: 'auto', max_amount_cents: 0, reason: 'Payment links up to $0.' });
    const link = hubTool(view([linksUpToZero]), 'native.payment_link');
    expect(link).toMatchObject({ mode: 'ask' });
    expect(link.limit).toBeUndefined();
  });

  it('summary_limit_is_the_kernels', () => {
    // Without the payment tools' own rules, two automatic rules for anyone on every tool that charges
    // money add up, as permits do: Payment link runs up to the larger, $200.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-link' && c.card_id !== 'rv-mandate');
    const charges100 = card({ card_id: 'card-charges-100', applies_to: 'effect:charge', mode: 'auto', max_amount_cents: 10_000, reason: 'Payments up to $100.' });
    const charges200 = card({ ...charges100, card_id: 'card-charges-200', max_amount_cents: 20_000, reason: 'Payments up to $200.' });
    expect(hubTool(view([charges100, charges200]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$200' });

    // Refund sends money out and touches private data, so automatic rules on the two cover it only
    // jointly, and both limits hold: up to the tighter, $50.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-refund');
    const payOut = card({ card_id: 'card-pay-out-100', applies_to: 'effect:pay_out', mode: 'auto', max_amount_cents: 10_000, reason: 'Money goes out up to $100.' });
    const privateData = card({ card_id: 'card-private-50', applies_to: 'effect:private_data', mode: 'auto', max_amount_cents: 5_000, reason: 'Private data up to $50.' });
    expect(hubTool(view([payOut, privateData]), 'payments.create_refund')).toMatchObject({ summary: '2 rules · 2 shared', mode: 'auto', limit: '$50' });
  });

  it('summary_holds_over_the_week', () => {
    // Hours are read exactly, over each stretch of the week between their edges. Payment link up to
    // $100 on weekdays and up to $300 on Saturday mornings runs up to $300 at some time.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-link');
    const weekdays: RuleCard['hours'] = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '17:00:00' };
    const weekdayLinks = card({ card_id: 'card-link-weekdays', applies_to: 'native.payment_link', mode: 'auto', max_amount_cents: 10_000, hours: weekdays, reason: 'Weekday links up to $100.' });
    const saturdayLinks = card({
      ...weekdayLinks,
      card_id: 'card-link-saturdays',
      max_amount_cents: 30_000,
      hours: { days: ['sat'], start: '09:00:00', end: '13:00:00' },
      reason: 'Saturday morning links up to $300.',
    });
    expect(hubTool(view([weekdayLinks, saturdayLinks]), 'native.payment_link')).toMatchObject({ mode: 'auto', limit: '$300' });

    // Rules that cover Share a document only jointly run only while all their hours hold. Monday's
    // rule on private data and Tuesday's on messages never meet, so a request always asks; once
    // they overlap on Monday afternoons, it runs then.
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== 'rv-docs');
    const mondayData = card({ card_id: 'card-private-mon', applies_to: 'effect:private_data', mode: 'auto', hours: { days: ['mon'], start: '09:00:00', end: '17:00:00' }, reason: 'Private data on Mondays.' });
    const tuesdayMessages = card({ card_id: 'card-messages-tue', applies_to: 'effect:send_message', mode: 'auto', hours: { days: ['tue'], start: '09:00:00', end: '17:00:00' }, reason: 'Messages on Tuesdays.' });
    expect(hubTool(view([mondayData, tuesdayMessages]), 'native.release_document')).toMatchObject({ mode: 'ask' });
    desk().policy.cards = desk().policy.cards.filter((c) => c.card_id !== tuesdayMessages.card_id);
    const mondayMessages = card({ ...tuesdayMessages, card_id: 'card-messages-mon', hours: { days: ['mon'], start: '12:00:00', end: '20:00:00' }, reason: 'Messages on Monday afternoons.' });
    expect(hubTool(view([mondayMessages]), 'native.release_document')).toMatchObject({ mode: 'auto' });
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

  it('hold_question_names_the_newest_held_request', () => {
    /** What Needs you lists for the main Desk now. */
    const listed = () => needsYou(mockStore.world, desk());
    // The seed's hold, a visitor's quote at 15% off.
    expect(holdQuestion(listed())).toBe('Why was this quote held?');

    // Dana's refund, held after it: the newest hold is the one asked about, whatever order the list has.
    mockStore.world.addHeldRefund();
    const both = listed();
    expect(holdQuestion(both)).toBe('Why was this refund held?');
    expect(holdQuestion([...both].reverse())).toBe('Why was this refund held?');

    // A newer hold of a tool with no plain noun (open times) is left out, and the one before it is
    // asked about; so is one with no action to name.
    const refund = both.find((item): item is Extract<NeedsYouItem, { decision: object }> => item.decision?.action?.tool === 'payments.create_refund');
    if (!refund?.decision.action) throw new Error('Dana has a refund held');
    const later = (minutes: number) => new Date(Date.parse(refund.held_at) + minutes * 60_000).toISOString();
    const slots: NeedsYouItem = {
      ...refund,
      held_at: later(1),
      decision: { ...refund.decision, decision_id: 'dec-slots', action: { ...refund.decision.action, tool: 'native.find_slots' } },
    };
    const unnamed: NeedsYouItem = { ...refund, held_at: later(2), decision: { ...refund.decision, decision_id: 'dec-unnamed', action: null } };
    expect(holdQuestion([...both, slots, unnamed])).toBe('Why was this refund held?');
    expect(holdQuestion([slots, unnamed])).toBeNull();

    // No hold, no question.
    expect(holdQuestion([])).toBeNull();
  });
});

describe('the rows a confirmed change lands on', () => {
  /** A draft of Rivera's rules with `add` in place of the cards of the same id, as the review builds it. */
  function drafted(add: readonly RuleCard[], opts: { cap?: number } = {}) {
    const stored = opts.cap === undefined ? mockStore.world.draft(desk(), add) : mockStore.world.draftCards(desk(), desk().policy.cards, opts);
    return draftFromDiff(stored, desk().policy);
  }

  it('a_tool_rule_lands_on_its_tool_alone', () => {
    // "Stop quoting on weekends": the quote rule moves to weekdays.
    const weekdays = { ...rivera.ruleCards['rv-quote'], hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '00:00:00', end: '00:00:00' } } satisfies RuleCard;
    expect(rowsChangedBy(drafted([weekdays]), view().tools)).toEqual({ tools: ['native.quote'], moneyLimit: false });
  });

  it('a_preset_lands_on_every_tool_whose_rules_it_changes', () => {
    // "Ask me first" drops each of Rivera's own rules: every tool one of them governed changes, the
    // urgent callback among them, and the tools only the starter's cards govern (open times, leads,
    // callbacks, identity checks) don't.
    const stored = mockStore.world.draftCards(desk(), PRESETS.ask_first);
    const changed = rowsChangedBy(draftFromDiff(stored, desk().policy, 'ask_first'), view().tools);
    expect([...changed.tools].sort()).toEqual(
      ['desk.emergency-callback', 'native.book', 'native.charge_mandate', 'native.payment_link', 'native.quote', 'native.release_document', 'payments.create_refund', 'payments.list_charges'].sort(),
    );
    expect(changed.moneyLimit).toBe(false);
  });

  /** The names of the tools a change lands on, which the review's row titles name. */
  const namesOf = (tools: readonly string[]) => new Set(tools.map((tool) => targetWords(tool)));
  /** The titles of the review's rows, each once. */
  const titlesOf = (draft: RuleDraft) => new Set(changeRows(draft, people(), view().tools).map((row) => row.title));

  it('a_rule_replaced_by_one_that_differs_only_in_its_id_lands_nowhere', () => {
    // Quote and documents go to new cards that differ from Rivera's only in their ids, and refunds
    // never go through: the review lists only Refund, and only Refund lands.
    const cards = desk().policy.cards.map((c) => {
      if (c.card_id === 'rv-quote' || c.card_id === 'rv-docs') return { ...c, card_id: `${c.card_id}-again` };
      return c.card_id === 'rv-refund' ? { ...c, mode: 'never' as const, reason: 'Refunds never go through.' } : c;
    });
    const draft = draftFromDiff(mockStore.world.draftCards(desk(), cards), desk().policy);
    expect(titlesOf(draft)).toEqual(new Set(['Refund']));
    expect(rowsChangedBy(draft, view().tools)).toEqual({ tools: ['payments.create_refund'], moneyLimit: false });
  });

  it('a_preset_lands_on_exactly_the_tools_its_review_lists', () => {
    // "Recommended rules" in place of Rivera's own: its quote and document rules replace Rivera's
    // with ones that differ only in their ids, so its review lists neither, and neither lands.
    const draft = draftFromDiff(mockStore.world.draftCards(desk(), PRESETS.auto), desk().policy, 'auto');
    const changed = rowsChangedBy(draft, view().tools);
    expect(namesOf(changed.tools)).toEqual(titlesOf(draft));
    expect(changed.tools).not.toContain('native.quote');
    expect(changed.tools).not.toContain('native.release_document');
    expect(changed.moneyLimit).toBe(false);
  });

  it('a_new_limit_lands_on_its_line_and_the_rules_it_lowers', () => {
    // Raised to $5,000, no rule changes: the limit's line alone.
    expect(rowsChangedBy(drafted([], { cap: 500_000 }), view().tools)).toEqual({ tools: [], moneyLimit: true });
    // Lowered to $100 with Payment link's $300 brought down with it: the line, and Payment link.
    const lowered = mockStore.world.draftCards(
      desk(),
      desk().policy.cards.map((c) => (c.card_id === 'rv-link' ? { ...c, max_amount_cents: 10_000 } : c)),
      { cap: 10_000 },
    );
    expect(rowsChangedBy(draftFromDiff(lowered, desk().policy), view().tools)).toEqual({ tools: ['native.payment_link'], moneyLimit: true });
  });
});
