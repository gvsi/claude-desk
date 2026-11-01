import { expect, it } from 'vitest';

import { wordEnds } from './wordEnds.ts';

/** The prefixes `wordEnds` allows, as the text a reader would see cut there. */
function prefixes(text: string, growing: boolean): string[] {
  return wordEnds(text, growing).map((end) => text.slice(0, end));
}

it('whole_text_ends_after_each_word_and_at_its_end', () => {
  expect(prefixes('Lukewarm showers from a tank', false)).toEqual([
    'Lukewarm',
    'Lukewarm showers',
    'Lukewarm showers from',
    'Lukewarm showers from a',
    'Lukewarm showers from a tank',
  ]);
});

it('growing_text_holds_back_a_last_word_that_may_be_unfinished', () => {
  expect(prefixes('Got it: leaks and blo', true)).toEqual(['Got', 'Got it:', 'Got it: leaks', 'Got it: leaks and']);
  // A space after the last word says it is whole.
  expect(prefixes('Got it ', true)).toEqual(['Got', 'Got it']);
  expect(prefixes('Yes', true)).toEqual([]);
});

it('a_block_appears_with_its_first_word_never_its_marker_alone', () => {
  // Cut after "-" or "1.", a paragraph's next line reads as a heading's underline or as text.
  const reply = 'When:\n- the tank\n  - nested\n1. rust\n### Repair\n> - quoted item\n```text\ncode\n```\nDone.';
  const cuts = prefixes(reply, false);
  for (const marker of ['-', '- the tank\n  -', '1.', '###', '>', '> -', '```']) {
    expect(cuts.some((cut) => cut.endsWith(`\n${marker}`))).toBe(false);
  }
  expect(cuts).toContain('When:\n- the');
  expect(cuts).toContain('When:\n- the tank\n  - nested\n1. rust');
  expect(cuts).toContain('When:\n- the tank\n  - nested\n1. rust\n### Repair\n> - quoted');
  // A word that only looks like a marker, inside a line, is an ordinary word.
  expect(prefixes('Rated 4 - good', false)).toEqual(['Rated', 'Rated 4', 'Rated 4 -', 'Rated 4 - good']);
});

const HEAD = '| | Repair | Replace |\n| --- | --- | --- |';
const TABLE = `Compare:\n\n${HEAD}\n| What changes | One worn part | The whole tank |`;

it('a_table_head_appears_whole_with_its_delimiter_row', () => {
  // Without its delimiter row, a header row is a paragraph of pipes.
  const cuts = prefixes(TABLE, false);
  expect(cuts.filter((cut) => cut.length > 'Compare:'.length && cut.length < `Compare:\n\n${HEAD}`.length)).toEqual([]);
  expect(cuts).toContain(`Compare:\n\n${HEAD}`);
  expect(cuts).toContain(`Compare:\n\n${HEAD}\n| What`);
  expect(cuts.at(-1)).toBe(TABLE);
  // Pipes in a line of prose make no table.
  expect(prefixes('Pick one | or both', false)).toEqual(['Pick', 'Pick one', 'Pick one |', 'Pick one | or', 'Pick one | or both']);
});

it('growing_text_holds_a_table_head_until_its_delimiter_row_is_whole', () => {
  for (const stopped of ['| | Rep', '| | Repair | Replace |', '| | Repair | Replace |\n', '| | Repair | Replace |\n| --- | -', HEAD]) {
    expect(prefixes(`Compare:\n\n${stopped}`, true), stopped).toEqual(['Compare:']);
  }
  expect(prefixes(`Compare:\n\n${HEAD}\n`, true).at(-1)).toBe(`Compare:\n\n${HEAD}`);
  // A body row may stop anywhere: its missing cells render empty.
  expect(prefixes(`Compare:\n\n${HEAD}\n| What changes | One wo`, true).at(-1)).toBe(`Compare:\n\n${HEAD}\n| What changes | One`);
});
