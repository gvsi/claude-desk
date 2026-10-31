/**
 * The web's static connector table: which tools each connector groups, in the boards' words, and
 * what a tool row's status means on every screen.
 */
import { describe, expect, it } from 'vitest';

import type { ToolName } from '../../api/contracts.ts';
import type { ToolRow } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import type { ConnectorIconName } from '../../ds/index.ts';
import { CONNECTORS, TOOL_NAMES, connectorByKey, connectorOf, connectorOn, toolState } from './catalog.ts';

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
const SETUP_ONLY: readonly ToolName[] = ['native.fetch_website', 'native.read_memory'];

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
    for (const tool of Object.keys(EVERY_TOOL) as ToolName[]) expect(TOOL_NAMES[tool].line, tool).toMatch(/^[A-Z].*\.$/);
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
