import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import { ruleDetails, shortHash } from './details.tsx';

const VERSION = { version: 7, cedar_sha256: `c41d${'0'.repeat(56)}09af`, auto_money_cap_cents: 50_000, proof: { ok: true, method: 'symcc' as const, checks: [] } };

/** Rivera's payment link card, its fields in the order a store might send them. */
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
