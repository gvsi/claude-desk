/**
 * Proves `lineWords` reads the browser's own line breaks: words on one line stay together, each line
 * the browser starts is a group of its own, top to bottom, and a word split across elements counts
 * once, on the line where it starts.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { lineWords } from './lineWords.ts';

let box: HTMLElement | null = null;

/** A paragraph in the page, from `html`, styled by `style`. */
function paragraph(html: string, style: Partial<CSSStyleDeclaration>): HTMLElement {
  box = document.createElement('p');
  box.innerHTML = html;
  Object.assign(box.style, { margin: '0', font: '16px/20px monospace', ...style });
  document.body.append(box);
  return box;
}

afterEach(() => {
  box?.remove();
  box = null;
});

describe('lineWords', () => {
  it('keeps_one_line_together', () => {
    expect(lineWords(paragraph('Rivera Plumbing is live', { whiteSpace: 'nowrap' }))).toEqual([['Rivera', 'Plumbing', 'is', 'live']]);
  });

  it('groups_each_line_top_to_bottom', () => {
    // A line as narrow as the longest word, and no two words fit on one: each starts a line of its own.
    expect(lineWords(paragraph('Rivera Plumbing goes online', { width: 'min-content' }))).toEqual([['Rivera'], ['Plumbing'], ['goes'], ['online']]);
    // Twelve characters a line: the browser's own breaks, read back.
    expect(lineWords(paragraph('aaaa bbbb cccc dddd eeee', { width: '12ch' }))).toEqual([
      ['aaaa', 'bbbb'],
      ['cccc', 'dddd'],
      ['eeee'],
    ]);
  });

  it('counts_a_word_split_across_elements_once', () => {
    expect(lineWords(paragraph('<span>Bay</span>view <b>is</b> live', { whiteSpace: 'nowrap' }))).toEqual([['Bayview', 'is', 'live']]);
  });

  it('skips_text_that_is_not_drawn', () => {
    expect(lineWords(paragraph('shown <span style="display: none">hidden</span> too', { whiteSpace: 'nowrap' }))).toEqual([['shown', 'too']]);
  });
});
