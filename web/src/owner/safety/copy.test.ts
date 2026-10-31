/**
 * Safety's words for the record: every kind of entry, where it came from and what an attempt was
 * about, each table covering exactly the values the contracts name; and the one entry an attempt
 * is shown with.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LedgerEntry, LedgerEvent, LedgerPage } from '../../api/contracts.ts';
import type { Attempt } from '../../api/views.ts';
import { CATEGORY_COPY, LEDGER_KIND_COPY, ORIGIN_COPY, anythingStoppedIn, entryFor } from './copy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', '..', '..', '..', 'backend', 'desk', 'contracts.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  $defs: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
};

/** The string enum of a model's field in the shared contracts. */
function schemaEnum(model: string, field: string): string[] {
  const values = schema.$defs[model]?.properties?.[field]?.enum;
  if (!values) throw new Error(`contracts.schema.json has no enum at ${model}.${field}`);
  return values;
}

/** The triage categories, as the API owner plan's triage task names them (plan 02b, Task 10). */
const TRIAGE_CATEGORIES = ['impersonation', 'discount_push', 'private_data', 'code_redirect', 'injection', 'over_limit', 'other'];

const sorted = (values: readonly string[]) => [...values].sort();

function entry(seq: number, kind: LedgerEvent['kind'], ref: string): LedgerEntry {
  return {
    copy_id: 'copy-1',
    desk_id: 'desk-1',
    seq,
    prev_hash: '0'.repeat(64),
    created_at: `2026-10-30T16:5${seq}:00.000000Z`,
    event: { kind, origin: 'kernel', session_id: 'ses-1', ref_id: ref, summary: {} },
    hash: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    key_id: 'key-1',
  };
}

function attempt(ledgerSeq: number): Attempt {
  return {
    ref_id: 'dec-refund',
    kind: 'refused',
    reason_plain: 'Refunds go only to the customer who paid.',
    card_ids: [],
    origin: 'kernel',
    created_at: '2026-10-30T16:52:00.000000Z',
    triage: null,
    ledger_seq: ledgerSeq,
  };
}

function page(entries: LedgerEntry[]): LedgerPage {
  return { entries, head: 'a'.repeat(64), chain_ok: true, first_bad_seq: null, public_key_hex: 'c'.repeat(64), key_id: 'key-1' };
}

describe('Safety copy', () => {
  it('copy_tables_are_exhaustive', () => {
    expect(sorted(Object.keys(LEDGER_KIND_COPY))).toEqual(sorted(schemaEnum('LedgerEvent', 'kind')));
    expect(sorted(Object.keys(ORIGIN_COPY))).toEqual(sorted(schemaEnum('LedgerEvent', 'origin')));
    expect(sorted(Object.keys(CATEGORY_COPY))).toEqual(sorted(TRIAGE_CATEGORIES));
    // Every word is written: none is left empty.
    for (const table of [LEDGER_KIND_COPY, ORIGIN_COPY, CATEGORY_COPY]) {
      for (const [key, words] of Object.entries(table)) expect(words.trim(), key).not.toBe('');
    }
  });

  it('entry_for_matches_ledger_seq', () => {
    // One action's decide, approval and execute entries: the attempt is shown with the one its
    // ledger_seq names, never another entry about the same action.
    const decide = entry(1, 'decide', 'dec-refund');
    const approval = entry(2, 'approval', 'dec-refund');
    const execute = entry(3, 'execute', 'dec-refund');
    const record = page([decide, approval, execute]);
    expect(entryFor(attempt(1), record)).toBe(decide);
    expect(entryFor(attempt(2), record)).toBe(approval);
    expect(entryFor(attempt(3), record)).toBe(execute);
    // A page without that entry, or no page yet: nothing to show.
    expect(entryFor(attempt(4), record)).toBeNull();
    expect(entryFor(attempt(1), undefined)).toBeNull();
  });

  it('anything_stopped_in_the_week_takes_either_kind', () => {
    // The last 7 days as Today reads them: Saturday, October 24, to Friday, October 30, in Los Angeles.
    const week = { timezone: 'America/Los_Angeles', start: '2026-10-24', end: '2026-10-30' };
    const one = (kind: Attempt['kind'], createdAt: string) => [{ kind, created_at: createdAt }];
    expect(anythingStoppedIn([], week)).toBe(false);
    // A refused request or a draft of Claude's the reply check stopped, from 00:00 on the first day
    // to the end of the last, on the business's clock.
    expect(anythingStoppedIn(one('refused', '2026-10-24T07:00:00.000000Z'), week)).toBe(true);
    expect(anythingStoppedIn(one('reply_blocked', '2026-10-31T06:59:00.000000Z'), week)).toBe(true);
    // Before the week began there, though already the 24th in UTC: not this week.
    expect(anythingStoppedIn(one('reply_blocked', '2026-10-24T06:59:00.000000Z'), week)).toBe(false);
    // After the week Today last read ended, just past midnight or with the clocks apart: newer than
    // that read, so it counts, and the week isn't said to have stopped nothing.
    expect(anythingStoppedIn(one('refused', '2026-10-31T07:00:00.000000Z'), week)).toBe(true);
    // A hold is the owner's to answer, not stopped.
    expect(anythingStoppedIn(one('held', '2026-10-29T17:00:00.000000Z'), week)).toBe(false);
    // A time that can't be read may be this week's, so the week isn't said to have nothing.
    expect(anythingStoppedIn(one('reply_blocked', 'not a time'), week)).toBe(true);
  });
});
