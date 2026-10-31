import { expect } from 'storybook/test';

import { expectComputed } from './expectComputed.ts';
import { lineWords } from './lineWords.ts';

/**
 * Checks that a title balances its lines (`text-wrap: balance`): it reads `text` over as many lines
 * as the browser's greedy rule gives the same title (read with wrapping set back to normal for a
 * moment), so balancing moves nothing under it, and its last line holds more than one word, so the
 * last word never sits alone. `lines` pins the count where it doesn't depend on the platform's
 * text rendering; where it can (a narrow phone column), leave it out and the title need only wrap.
 * Returns the lines read, word by word.
 */
export async function expectBalancedLines(title: HTMLElement, text: string, lines?: number): Promise<string[][]> {
  expectComputed(title, { textWrapStyle: 'balance' });
  const balanced = lineWords(title);
  const before = title.style.textWrap;
  title.style.textWrap = 'wrap';
  const greedy = lineWords(title);
  title.style.textWrap = before;
  const read = `balanced ${JSON.stringify(balanced)}, greedy ${JSON.stringify(greedy)}`;
  await expect(balanced.flat().join(' '), read).toBe(text);
  if (lines !== undefined) await expect(balanced, `the title's lines: ${read}`).toHaveLength(lines);
  else await expect(balanced.length, `the title wraps: ${read}`).toBeGreaterThan(1);
  await expect(greedy, `the lines it takes anyway: ${read}`).toHaveLength(balanced.length);
  await expect(balanced.at(-1)?.length ?? 0, `the last line holds more than one word: ${read}`).toBeGreaterThan(1);
  return balanced;
}
