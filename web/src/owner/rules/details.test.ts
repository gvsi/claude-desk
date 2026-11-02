import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import type { ToolRow } from '../../api/views.ts';
import { ruleDetails, shortHash, toolDetails } from './details.tsx';

const VERSION = { version: 7, cedar_sha256: `c41d${'0'.repeat(56)}09af`, auto_money_cap_cents: 50_000, proof: { ok: true, method: 'symcc' as const, checks: [] } };

/** Turner Plumbing's payment link card, its fields in the order a store might send them. */
const LINK = {
  max_discount_bp: 0, review: true, is_default: false, reason: 'Payment links up to $300, checked by the reviewer.',
  person_id: null, agent_key_id: null, hours: null, max_amount_cents: 30_000,
  who: 'anyone', mode: 'auto', applies_to: 'native.payment_link', card_id: 'rv-link',
} satisfies RuleCard;

it('a_cards_block_reads_in_the_contracts_order_with_empty_fields_left_out', () => {
  const { code } = ruleDetails(VERSION, [LINK]);
  expect(code?.label).toBe('The rule as you set it');
  expect(Object.keys(code?.value as object)).toEqual([
    'card_id', 'applies_to', 'mode', 'who', 'max_amount_cents', 'max_discount_bp', 'review', 'is_default', 'reason',
  ]);
  expect(code?.value).toEqual(Object.fromEntries(Object.entries(LINK).filter(([, value]) => value !== null)));
});

it('a_field_this_build_doesnt_know_still_shows_after_the_known_ones', () => {
  const { code } = ruleDetails(VERSION, [{ ...LINK, scope_note: 'new' } as RuleCard]);
  expect(Object.keys(code?.value as object).at(-1)).toBe('scope_note');
});

it('version_hash_and_the_rows_cards', () => {
  expect(ruleDetails(VERSION, [LINK]).fields.map(({ label, value }) => [label, value])).toEqual([
    ['Rule', 'rv-link'],
    ['Version', '7, proved against the always-on rules'],
    ['Policy hash', 'sha256 c41d…09af'],
  ]);
  // A version without a passing proof doesn't say it was proved.
  expect(ruleDetails({ ...VERSION, proof: null }, [LINK]).fields[1]?.value).toBe('7');
  // A row of joined cards names each, and its block lists them.
  const joined = ruleDetails(VERSION, [LINK, { ...LINK, card_id: 'rv-mandate' }]);
  expect(joined.fields[0]?.value).toBe('rv-link, rv-mandate');
  expect((joined.code?.value as { card_id: string }[]).map((card) => card.card_id)).toEqual(['rv-link', 'rv-mandate']);
  // The payment limit's block is the version's limit; a row from no card has no block.
  expect(ruleDetails(VERSION, [], { moneyCap: true }).code?.value).toEqual({ auto_money_cap_cents: 50_000 });
  expect(ruleDetails(VERSION, []).code).toBeUndefined();
  expect(shortHash('abc')).toBe('sha256 abc');
});


/** Stripe's refund, pinned and on, as GET /rules lists it. */
const REFUND: ToolRow = {
  tool: 'payments.create_refund', source: 'mcp', effects: ['pay_out', 'private_data'], reversible: false,
  status: 'enabled', description_confirmed: "Refund one of the verified customer's own charges.",
  definition_sha256: 'a'.repeat(64), pending_definition_text: null, pending_sha256: null, review_reason: null,
};

/** A tool's Pinned row as the owner reads it, and its dot's tone; null when there is no row. */
function pinned(row: ToolRow): { words: string; tone: string | null } | null {
  const field = toolDetails(row, null).fields.find(({ label }) => label === 'Pinned');
  if (field === undefined) return null;
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(Fragment, null, field.value as ReactNode));
  return { words: host.textContent ?? '', tone: host.querySelector('.cd-status-dot')?.className.replace(/.*cd-status-dot--/, '') ?? null };
}

it('matches_its_pin_only_when_the_listing_is_known_to_match', () => {
  expect(pinned(REFUND)).toEqual({ words: 'Matches its pin', tone: 'handled' });
  // Waiting for its first review, a new tool is still pinned at the hash it was listed at.
  expect(pinned({ ...REFUND, status: 'needs_review', review_reason: 'new' })).toEqual({ words: 'Matches its pin', tone: 'handled' });
  // Its definition changed while it was on: the kernel puts it back to review.
  const drift = { pending_definition_text: '{"name":"create_refund"}', pending_sha256: 'b'.repeat(64) };
  expect(pinned({ ...REFUND, ...drift, status: 'needs_review', review_reason: 'changed' })).toEqual({ words: 'Needs your review', tone: 'held' });
  // Its definition changed while it was off: the kernel keeps it disabled and records the drift.
  expect(pinned({ ...REFUND, ...drift, status: 'disabled', review_reason: null })).toEqual({ words: 'Needs your review', tone: 'held' });
});

it('a_delisted_tool_is_no_longer_offered_never_pinned_safe', () => {
  // The connector stopped listing it: nothing to match, so the owner's alert's own words.
  expect(pinned({ ...REFUND, status: 'needs_review', review_reason: 'delisted' })).toEqual({ words: 'No longer offered', tone: 'info' });
});

it('a_tool_with_no_recorded_pin_makes_no_claim_about_it', () => {
  expect(pinned({ ...REFUND, definition_sha256: null })).toBeNull();
  expect(pinned({ ...REFUND, definition_sha256: '' })).toBeNull();
});
