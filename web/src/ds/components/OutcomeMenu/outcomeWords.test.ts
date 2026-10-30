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
    // A preset is where the owner starts from; there is no "Custom" preset to pick. Each says what
    // it sets, in the signed presets board's words.
    expect(PRESET_WORDS).toEqual([
      { value: 'ask_first', label: 'Ask me first', description: 'Quotes, bookings, documents and payments wait for your answer.' },
      {
        value: 'auto',
        label: 'Recommended rules',
        description: 'Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first.',
      },
    ]);
  });
});
