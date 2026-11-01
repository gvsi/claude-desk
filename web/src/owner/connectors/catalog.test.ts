/**
 * The web's static connector table: which tools each connector groups, in the boards' words, and
 * what a tool row's status means on every screen.
 */
import { describe, expect, it } from 'vitest';

import type { ToolName } from '../../api/contracts.ts';
import type { ToolRow } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import type { ConnectorIconName } from '../../ds/index.ts';
import { TOOL_LABELS } from '../../mocks/script.ts';
import { riveraTools } from '../../mocks/seed.ts';
import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { CONNECTORS, NO_BUSINESS_TOOLS, TOOL_NAMES, TOOL_RESOURCES, businessTools, connectorByKey, connectorOf, connectorOn, hasRecordOwner, isBusinessToolName, isCatalogTool, toolDisplayName, toolNoun, toolState } from './catalog.ts';

/** Every tool the contracts name: a tool added to or dropped from them fails to compile here. */
const EVERY_TOOL = {
  'native.quote': true,
  'native.find_slots': true,
  'native.book': true,
  'native.release_document': true,
  'native.payment_link': true,
  'native.charge_mandate': true,
  'native.capture_lead': true,
  'native.request_callback': true,
  'native.start_verification': true,
  'native.fetch_website': true,
  'native.read_memory': true,
  'native.web_search': true,
  'payments.list_charges': true,
  'payments.create_refund': true,
} as const satisfies Record<ToolName, true>;

/** The design system's connector ids, in the order the boards list them. */
const DS_CONNECTOR_IDS = {
  quotes: true,
  bookings: true,
  leads: true,
  verification: true,
  documents: true,
  payments: true,
  stripe: true,
  google_calendar: true,
} as const satisfies Record<ConnectorIconName, true>;

/** The setup interview's own tools, which belong to no connector. */
const SETUP_ONLY: readonly ToolName[] = ['native.fetch_website', 'native.read_memory', 'native.web_search'];

/** A tool row as the API lists it, with `fields` over a plain enabled native tool. */
function row(fields: Partial<ToolRow> = {}): ToolRow {
  return {
    tool: 'native.quote',
    source: 'native',
    effects: ['change'],
    reversible: true,
    status: 'enabled',
    description_confirmed: 'Price a job from the price list.',
    definition_sha256: 'a'.repeat(64),
    pending_definition_text: null,
    pending_sha256: null,
    review_reason: null,
    ...fields,
  };
}

describe('the connector catalog', () => {
  it('resolves business titles and catalog names without exposing unknown identifiers', () => {
    const map = businessTools(chenBusinessTools);
    expect(toolDisplayName('desk.intro-call', map)).toBe('Book a free intro call');
    expect(toolDisplayName('native.quote', map)).toBe('Quote');
    expect(toolDisplayName('desk.unknown', map)).toBeNull();
    expect(toolDisplayName('toString', map)).toBeNull();
    expect(toolDisplayName('desk.intro-call', NO_BUSINESS_TOOLS)).toBeNull();
    expect(Object.isFrozen(NO_BUSINESS_TOOLS)).toBe(true);
    expect(NO_BUSINESS_TOOLS.size).toBe(0);
    expect(toolNoun('desk.intro-call')).toBeNull();
    for (const tool of Object.keys(EVERY_TOOL)) expect(isCatalogTool(tool), tool).toBe(true);
    for (const tool of ['desk.intro-call', 'toString', 'native.unknown']) expect(isCatalogTool(tool), tool).toBe(false);
  });

  it('keeps only listed business tools with nonblank titles', () => {
    const [intro, intake] = chenBusinessTools;
    if (!intro?.business || !intake) throw new Error('Chen has both business tools');
    const map = businessTools([
      intro, intake,
      { ...intro, tool: 'desk.native', source: 'native' },
      { ...intro, tool: 'native.quote' },
      { ...intro, tool: 'desk.Intro' },
      { ...intro, tool: 'desk.missing', business: null },
      { ...intro, tool: 'desk.absent', business: undefined },
      { ...intro, tool: 'desk.blank', business: { ...intro.business, title: ' \t ' } },
    ]);
    expect([...map]).toEqual(chenBusinessTools.map((tool) => [tool.tool, tool.business]));
  });

  it('recognizes only kernel business tool names', () => {
    expect(isBusinessToolName('desk.intro-call')).toBe(true);
    expect(isBusinessToolName(`desk.a${'a'.repeat(39)}`)).toBe(true);
    for (const tool of ['desk.', 'desk.Intro', 'desk.1abc', `desk.a${'a'.repeat(40)}`, 'native.quote', 'desk.intro_call']) {
      expect(isBusinessToolName(tool), tool).toBe(false);
    }
  });

  it('catalog_covers_every_tool', () => {
    // The keys are the design system's connector ids, in the boards' order, each with its own view.
    expect(CONNECTORS.map((c) => c.key)).toEqual(Object.keys(DS_CONNECTOR_IDS));
    for (const connector of CONNECTORS) {
      expect(connector.view.id, connector.key).toBe(connector.key);
      expect(connector.view.icon, connector.key).toBe(connector.key);
    }

    // Every tool but the setup interview's own is in exactly one connector, which `connectorOf` names.
    for (const tool of Object.keys(EVERY_TOOL) as ToolName[]) {
      const holders = CONNECTORS.filter((c) => c.tools.includes(tool));
      if (SETUP_ONLY.includes(tool)) {
        expect(holders, tool).toEqual([]);
        expect(connectorOf(tool), tool).toBeNull();
      } else {
        expect(holders.map((c) => c.key), tool).toHaveLength(1);
        expect(connectorOf(tool)?.key, tool).toBe(holders[0]?.key);
      }
    }
    expect(connectorOf('calendar.free_busy' as ToolName)).toBeNull();
    expect(CONNECTORS.map((c) => [c.key, [...c.tools]])).toEqual([
      ['quotes', ['native.quote']],
      ['bookings', ['native.find_slots', 'native.book']],
      ['leads', ['native.capture_lead', 'native.request_callback']],
      ['verification', ['native.start_verification']],
      ['documents', ['native.release_document']],
      ['payments', ['native.payment_link', 'native.charge_mandate']],
      ['stripe', ['payments.list_charges', 'payments.create_refund']],
      ['google_calendar', []],
    ]);

    // Each connector in the words of the presets and Connectors boards; every app is a mock.
    for (const connector of CONNECTORS) {
      const board = connector.key === 'google_calendar' ? rivera.googleCalendar.view : rivera.connectors.views[connector.key as keyof typeof rivera.connectors.views];
      expect(connector.view, connector.key).toEqual(board);
    }
    expect(connectorByKey('stripe')?.view.source).toEqual({ kind: 'external', mock: true });
    expect(connectorByKey('quotes')?.view.source).toEqual({ kind: 'built_in' });
    expect(connectorByKey('nope')).toBeNull();
    expect(connectorByKey('toString')).toBeNull();

    // Each tool's name and line in the boards' words: the line opens the tool's description there.
    for (const section of rivera.connectors.sections) {
      for (const tool of section.tools) {
        const words = TOOL_NAMES[tool.key as ToolName];
        expect(words.name, tool.key).toBe(tool.name);
        expect(tool.description.startsWith(words.line), `${tool.key}: "${tool.description}" opens with "${words.line}"`).toBe(true);
      }
    }
    expect(TOOL_NAMES['native.quote'].line).toBe('Prices a job from your price list.');
    expect(TOOL_NAMES['native.fetch_website'].name).toBe('Website reading');
    expect(TOOL_NAMES['native.read_memory'].name).toBe('Memory reading');
    expect(TOOL_NAMES['native.web_search']).toEqual({ name: 'Web search', line: 'Searches the web to learn how businesses like yours work.' });
    for (const tool of Object.keys(EVERY_TOOL) as ToolName[]) expect(TOOL_NAMES[tool].line, tool).toMatch(/^[A-Z].*\.$/);
  });

  it('held_requests_have_plain_nouns', () => {
    // Each tool's request as the owner names it after "this" ("Why was this refund held?"): the
    // API's words for its requests where they name one thing, plain and lowercase.
    const nouns = Object.fromEntries((Object.keys(EVERY_TOOL) as ToolName[]).map((tool) => [tool, toolNoun(tool)]));
    expect(nouns).toEqual({
      'native.quote': 'quote',
      // "Open times" is plural: no noun.
      'native.find_slots': null,
      'native.book': 'booking',
      'native.release_document': 'document',
      'native.payment_link': 'payment link',
      'native.charge_mandate': 'agent payment',
      // "Contact details" is plural: no noun.
      'native.capture_lead': null,
      'native.request_callback': 'callback',
      // The owner app's word for these ("identity checks"), plainer than the API's "verification".
      'native.start_verification': 'identity check',
      // The setup interview's own tools hold nothing on a Desk.
      'native.fetch_website': null,
      'native.read_memory': null,
      'native.web_search': null,
      'payments.list_charges': 'payment history',
      'payments.create_refund': 'refund',
    });
    for (const noun of Object.values(nouns)) if (noun !== null) expect(noun).toMatch(/^[a-z]+(?: [a-z]+)?$/);
    // A tool the catalog doesn't know has none.
    expect(toolNoun('calendar.free_busy')).toBeNull();
    expect(toolNoun('toString')).toBeNull();
  });

  it('ask_claude_knows_each_held_noun', () => {
    // Each noun Rules asks about a hold by is the word the mock's Ask Claude knows that tool by, so
    // it can tell which hold "Why was this {noun} held?" means.
    const named = (Object.keys(EVERY_TOOL) as ToolName[]).filter((tool) => toolNoun(tool) !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(TOOL_LABELS[tool], tool).toBe(toolNoun(tool));
  });

  it('record_owners_only_where_the_kernel_resolves_one', () => {
    // What each tool acts on is its profile's, as the mock serves the kernel's profiles.
    for (const profile of riveraTools()) {
      if (!isCatalogTool(profile.tool)) throw new Error('Turner seeds catalog tools');
      expect(TOOL_RESOURCES[profile.tool], profile.tool).toBe(profile.resource_kind);
    }
    // Only a document or a charge has an owner, so only these tools' records do.
    const owned = (Object.keys(EVERY_TOOL) as ToolName[]).filter((tool) => hasRecordOwner(tool));
    expect(owned).toEqual(['native.release_document', 'payments.list_charges', 'payments.create_refund']);
    expect(hasRecordOwner('payments.unknown')).toBe(false);
  });

  it('tool_states_follow_the_rows', () => {
    const pending = { pending_definition_text: '{"name": "create_refund"}', pending_sha256: 'b'.repeat(64) };
    /** A row waiting for review, for `reason`, as the kernel says it. */
    const waiting = (reason: ToolRow['review_reason'], fields: Partial<ToolRow> = {}) => row({ status: 'needs_review', review_reason: reason, ...fields });
    expect(toolState(row({ status: 'enabled' }))).toBe('on');
    // Why a tool waits for review is the kernel's reason, never read off its pending hash.
    // A changed definition waits for the owner's review.
    expect(toolState(waiting('changed', pending))).toBe('changed');
    expect(toolState(waiting('changed'))).toBe('changed');
    // Connected and never turned on: off, with nothing to review.
    expect(toolState(waiting('new'))).toBe('not_on');
    expect(toolState(waiting('new', pending))).toBe('not_on');
    // No longer listed by its connector: off, with nothing to review and nothing to add again.
    expect(toolState(waiting('delisted'))).toBe('delisted');
    expect(toolState(waiting('delisted', pending))).toBe('delisted');
    // A row that gives no reason, or one this build doesn't know, is never read as changed or on.
    expect(toolState(waiting(null, pending))).toBe('not_on');
    expect(toolState({ status: 'needs_review' })).toBe('not_on');
    expect(toolState(waiting('renamed' as ToolRow['review_reason'], pending))).toBe('not_on');
    expect(toolState(row({ status: 'disabled' }))).toBe('off');
    // A reason only counts while the tool waits for review.
    expect(toolState(row({ status: 'enabled', review_reason: 'changed' }))).toBe('on');
    expect(toolState(row({ status: 'disabled', review_reason: 'changed', ...pending }))).toBe('off');
    // A status this build doesn't know is never read as on.
    expect(toolState(row({ status: 'paused' as ToolRow['status'] }))).toBe('off');

    const stripe = connectorByKey('stripe');
    if (stripe === null) throw new Error('the catalog has Stripe');
    const charges = row({ tool: 'payments.list_charges', source: 'mcp', effects: ['private_data'] });
    const refund = row({ tool: 'payments.create_refund', source: 'mcp', effects: ['pay_out', 'private_data'], reversible: false });
    // On while any of its tools is on or changed.
    expect(connectorOn(stripe, [charges, refund])).toBe(true);
    expect(connectorOn(stripe, [{ ...charges, status: 'disabled' }, { ...refund, status: 'needs_review', review_reason: 'changed' }])).toBe(true);
    // Off when every tool is off, not on or delisted, whatever hash it carries, or none is listed;
    // another connector's rows don't count.
    expect(connectorOn(stripe, [{ ...charges, status: 'disabled' }, { ...refund, status: 'needs_review', review_reason: 'new', ...pending }])).toBe(false);
    expect(connectorOn(stripe, [{ ...charges, status: 'needs_review', review_reason: 'delisted', ...pending }, { ...refund, status: 'needs_review', review_reason: 'new' }])).toBe(false);
    expect(connectorOn(stripe, [{ ...charges, status: 'disabled' }, { ...refund, status: 'needs_review', review_reason: null, ...pending }])).toBe(false);
    expect(connectorOn(stripe, [])).toBe(false);
    expect(connectorOn(stripe, [row({ tool: 'native.quote' })])).toBe(false);
  });
});
