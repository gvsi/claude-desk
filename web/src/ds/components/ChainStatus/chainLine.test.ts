import { describe, expect, it } from 'vitest';

import { chainLine, entriesLabel } from './chainLine.ts';

const PASSED = 'No entry has been changed since it was written';
const UNKNOWN = 'Something in this record has changed since it was written';

describe('chainLine', () => {
  it('reads_each_chain_state', () => {
    expect(chainLine(null, null)).toEqual({ tone: 'info', line: 'Not checked yet' });
    expect(chainLine(true, null)).toEqual({ tone: 'handled', line: PASSED });
    // A failure at an entry may be a removed entry before it or past the end, so the line names
    // where the record changed, never that the entry itself did.
    expect(chainLine(false, 4)).toEqual({ tone: 'refused', line: 'Something in this record changed at entry 4' });
  });

  it('broken_without_an_entry_still_reads_broken', () => {
    expect(chainLine(false, null)).toEqual({ tone: 'refused', line: UNKNOWN });
    // A malformed entry number names no entry, rather than "Entry undefined".
    for (const seq of [undefined, 'four', Number.NaN]) {
      expect(chainLine(false, seq as unknown as number), String(seq)).toEqual({ tone: 'refused', line: UNKNOWN });
    }
  });

  it('only_a_passed_check_reads_as_unchanged', () => {
    for (const ok of ['true', 1, undefined]) {
      const read = chainLine(ok as unknown as boolean, null);
      expect(read, JSON.stringify(ok)).toEqual({ tone: 'refused', line: UNKNOWN });
    }
  });

  it('never_reads_as_engineering_terms', () => {
    // The owner's line says what changed in the record; the full trace keeps the chain's terms.
    for (const [ok, seq] of [[null, null], [true, null], [false, 4], [false, null]] as const) {
      expect(chainLine(ok, seq).line, `${ok} ${seq}`).not.toMatch(/chain|match/i);
    }
  });
});

describe('entriesLabel', () => {
  it('says_what_was_counted', () => {
    expect(entriesLabel(0)).toBe('0 entries');
    expect(entriesLabel(1)).toBe('1 entry');
    expect(entriesLabel(2)).toBe('2 entries');
    expect(entriesLabel(88)).toBe('88 entries');
  });
});
