/**
 * A reply still being written shows every word but a last one that nothing follows yet, as the
 * Markdown renderer that takes the placeholder's place does.
 */
import { describe, expect, it } from 'vitest';

import { settledWords } from './GrowingReply.tsx';

describe('settledWords', () => {
  it('holds_back_a_last_word_nothing_follows_yet', () => {
    expect(settledWords('Yes')).toBe('');
    expect(settledWords('Yes. Right')).toBe('Yes.');
    expect(settledWords('Got it: leaks and blocked')).toBe('Got it: leaks and');
    expect(settledWords('Thanks.\n\nHere')).toBe('Thanks.');
  });

  it('shows_a_last_word_once_something_follows_it', () => {
    expect(settledWords('Yes. ')).toBe('Yes.');
    expect(settledWords('Yes.\n')).toBe('Yes.');
  });

  it('shows_nothing_for_nothing', () => {
    expect(settledWords('')).toBe('');
    expect(settledWords('   ')).toBe('');
    expect(settledWords('  Yes')).toBe('');
  });
});
