import { describe, expect, it } from 'vitest';

import { chainLine } from './chainLine.ts';

describe('chainLine', () => {
  it('reads_each_chain_state', () => {
    expect(chainLine(null, null)).toEqual({ tone: 'info', line: 'Not checked yet' });
    expect(chainLine(true, null)).toEqual({ tone: 'handled', line: 'Every entry matches the chain' });
    expect(chainLine(false, 4)).toEqual({ tone: 'refused', line: "Entry 4 doesn't match the chain" });
  });

  it('broken_without_an_entry_still_reads_broken', () => {
    expect(chainLine(false, null)).toEqual({ tone: 'refused', line: "An entry doesn't match the chain" });
    // A malformed entry number names no entry, rather than "Entry undefined".
    for (const seq of [undefined, 'four', Number.NaN]) {
      expect(chainLine(false, seq as unknown as number), String(seq)).toEqual({ tone: 'refused', line: "An entry doesn't match the chain" });
    }
  });

  it('only_a_passed_check_reads_as_matching', () => {
    for (const ok of ['true', 1, undefined]) {
      const read = chainLine(ok as unknown as boolean, null);
      expect(read, JSON.stringify(ok)).toEqual({ tone: 'refused', line: "An entry doesn't match the chain" });
    }
  });
});
