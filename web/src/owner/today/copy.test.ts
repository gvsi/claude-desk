import { describe, expect, it } from 'vitest';

import { outcomeWords, todayOutcomes, type TodayCounts } from './copy.ts';

/** The line's parts as words, in order, or the quiet line. */
function said(counts: TodayCounts): string[] | string {
  const line = todayOutcomes(counts);
  return line.quiet ? line.line : line.parts.map(outcomeWords);
}

describe('todayOutcomes', () => {
  it('leads with Today, Claude, then handled, held and turned down in that order', () => {
    const line = todayOutcomes({ handled: 2, held: 3, turnedDown: 4 });
    expect(line.quiet ? null : line.lead).toBe('Today, Claude');
    expect(line.quiet ? [] : line.parts.map(({ kind, count }) => [kind, count])).toEqual([
      ['handled', 2],
      ['held', 3],
      ['turnedDown', 4],
    ]);
    expect(said({ handled: 2, held: 3, turnedDown: 4 })).toEqual(['handled 2 on its own', 'held 3 for you', 'turned down 4 requests']);
  });

  it('says 1 of each, a request in the singular', () => {
    expect(said({ handled: 1, held: 1, turnedDown: 1 })).toEqual(['handled 1 on its own', 'held 1 for you', 'turned down 1 request']);
  });

  it('leaves out an outcome at 0', () => {
    expect(said({ handled: 0, held: 2, turnedDown: 5 })).toEqual(['held 2 for you', 'turned down 5 requests']);
    expect(said({ handled: 7, held: 0, turnedDown: 0 })).toEqual(['handled 7 on its own']);
    expect(said({ handled: 1, held: 1, turnedDown: 0 })).toEqual(['handled 1 on its own', 'held 1 for you']);
  });

  it('says a quiet day in one line when all three are 0', () => {
    expect(todayOutcomes({ handled: 0, held: 0, turnedDown: 0 })).toEqual({ quiet: true, line: "Today, Claude hasn't been asked anything yet." });
  });
});
