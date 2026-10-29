import { describe, expect, test } from 'vitest';

import { OUTCOME_TONE, OUTCOME_WORDS, PRESET_WORDS, outcomePhrase } from './outcomeWords.ts';

describe('outcome words', () => {
  test('outcome_phrase_with_limit', () => {
    // An auto card with an amount limit holds anything over it for the owner, through its hold twin.
    expect(outcomePhrase('auto', '$100')).toBe('Automatic up to $100; over $100, ask me first');
    // No mode but auto has a limit to show.
    expect(outcomePhrase('ask', '$100')).toBe('Ask me first');
    expect(outcomePhrase('never', '$100')).toBe('Never');
    expect(outcomePhrase('auto')).toBe('Automatic');
    // A blank limit is no limit.
    expect(outcomePhrase('auto', ' ')).toBe('Automatic');

    expect(OUTCOME_WORDS).toEqual({ auto: 'Automatic', ask: 'Ask me first', never: 'Never' });
    expect(OUTCOME_TONE).toEqual({ auto: 'handled', ask: 'held', never: 'refused' });
    expect(PRESET_WORDS.map(({ value, label }) => [value, label])).toEqual([
      ['ask_first', 'Ask me first'],
      ['auto', 'Automatic'],
      ['custom', 'Custom'],
    ]);
  });
});
