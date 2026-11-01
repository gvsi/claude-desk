/**
 * Proves `lineWords` reads the browser's own line breaks: words on one line stay together, each line
 * the browser starts is a group of its own, top to bottom, a word split across elements counts once,
 * a word broken across lines is read on every line it takes, and words of different sizes on one
 * line stay on it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { lineWords } from './lineWords.ts';

const boxes: HTMLElement[] = [];

/** A paragraph in the page, from `html`, styled by `style`. */
function paragraph(html: string, style: Partial<CSSStyleDeclaration>): HTMLElement {
  const box = document.createElement('p');
  box.innerHTML = html;
  Object.assign(box.style, { margin: '0', font: '16px/20px monospace', ...style });
  document.body.append(box);
  boxes.push(box);
  return box;
}

afterEach(() => {
  for (const box of boxes.splice(0)) box.remove();
});

describe('lineWords', () => {
  it('keeps_one_line_together', () => {
    expect(lineWords(paragraph('Turner Plumbing is live', { whiteSpace: 'nowrap' }))).toEqual([['Turner', 'Plumbing', 'is', 'live']]);
  });

  it('groups_each_line_top_to_bottom', () => {
    // A line as narrow as the longest word, and no two words fit on one: each starts a line of its own.
    expect(lineWords(paragraph('Turner Plumbing goes online', { width: 'min-content' }))).toEqual([['Turner'], ['Plumbing'], ['goes'], ['online']]);
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

  it('reads_a_word_broken_across_lines_on_each_line_it_takes', () => {
    // Ten characters a line, and a word too long for one breaks anywhere: its part on each line is
    // read on that line, so the lines read back are the lines drawn.
    const broken = paragraph(`${'a'.repeat(25)} bb`, { width: '10ch', overflowWrap: 'anywhere' });
    expect(lineWords(broken)).toEqual([['aaaaaaaaaa'], ['aaaaaaaaaa'], ['aaaaa', 'bb']]);
    expect(broken.getBoundingClientRect().height).toBe(3 * 20);
    // Broken across elements too: "Bay" and "view" in their own elements, the break inside "view".
    expect(lineWords(paragraph('<span>Bayvi</span>ewheat bb', { width: '7ch', overflowWrap: 'anywhere' }))).toEqual([['Bayview'], ['heat', 'bb']]);
  });

  it('keeps_words_of_different_sizes_on_their_line', () => {
    // A smaller and a larger word sit on the line with the rest, though their boxes start higher or lower.
    const mixed = 'Turner <span style="font-size: 10px">Plumbing</span> is <span style="font-size: 30px">live</span>';
    expect(lineWords(paragraph(mixed, { whiteSpace: 'nowrap', font: '16px/40px monospace' }))).toEqual([['Turner', 'Plumbing', 'is', 'live']]);
    // Whichever comes first: a small word, then a much larger one whose middle sits above the small
    // word's box, then the line's own size.
    const smallFirst = '<span style="font-size: 10px">Turner</span> <span style="font-size: 30px">Plumbing</span> is live';
    expect(lineWords(paragraph(smallFirst, { whiteSpace: 'nowrap', font: '16px/40px monospace' }))).toEqual([['Turner', 'Plumbing', 'is', 'live']]);
    // And on two lines, each line keeps its own.
    const twoLines = '<span style="font-size: 10px">Turner</span> Plumbing<br>is <span style="font-size: 30px">live</span>';
    expect(lineWords(paragraph(twoLines, { whiteSpace: 'nowrap', font: '16px/40px monospace' }))).toEqual([
      ['Turner', 'Plumbing'],
      ['is', 'live'],
    ]);
  });

  it('skips_text_that_is_not_drawn', () => {
    expect(lineWords(paragraph('shown <span style="display: none">hidden</span> too', { whiteSpace: 'nowrap' }))).toEqual([['shown', 'too']]);
  });
});
