import { describe, expect, it } from 'vitest';

import { chainLine, entriesLabel } from './chainLine.ts';

const PASSED = 'No entry has been changed since it was written';
const FAILED = 'The record check failed';

describe('chainLine', () => {
  it('reads_each_chain_state', () => {
    expect(chainLine(null, null)).toEqual({ tone: 'info', line: 'Not checked yet' });
    expect(chainLine(true, null)).toEqual({ tone: 'handled', line: PASSED });
    expect(chainLine(false, 4)).toEqual({ tone: 'refused', line: 'The record check failed at entry 4' });
  });

  // The kernel's verifier (`verify_chain`, kernel/core/tests/engine.rs `verify_chain_finds_first_bad_seq`)
  // names the first entry whose check failed, which is not always an entry that changed, so a failed
  // check says where the check failed and never that the record changed.
  it('a_key_change_fails_at_entry_1_with_every_entry_intact', () => {
    // Checked against another verification key, an untouched record fails at its first entry.
    expect(chainLine(false, 1)).toEqual({ tone: 'refused', line: 'The record check failed at entry 1' });
  });

  it('a_removed_entry_fails_at_the_unchanged_entry_after_it', () => {
    // With entry 2 removed, entry 3 no longer links to the one before it, though it is unchanged.
    expect(chainLine(false, 3)).toEqual({ tone: 'refused', line: 'The record check failed at entry 3' });
  });

  it('a_failed_check_never_says_the_record_changed', () => {
    for (const seq of [1, 3, null]) expect(chainLine(false, seq).line, String(seq)).not.toMatch(/chang/i);
  });

  it('broken_without_an_entry_still_reads_broken', () => {
    expect(chainLine(false, null)).toEqual({ tone: 'refused', line: FAILED });
    // A malformed entry number names no entry, rather than "Entry undefined".
    for (const seq of [undefined, 'four', Number.NaN]) {
      expect(chainLine(false, seq as unknown as number), String(seq)).toEqual({ tone: 'refused', line: FAILED });
    }
  });

  it('only_a_passed_check_reads_as_unchanged', () => {
    for (const ok of ['true', 1, undefined]) {
      const read = chainLine(ok as unknown as boolean, null);
      expect(read, JSON.stringify(ok)).toEqual({ tone: 'refused', line: FAILED });
    }
  });

  it('never_reads_as_engineering_terms', () => {
    // The owner's line names the record and its check; the full trace keeps the chain's terms.
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
