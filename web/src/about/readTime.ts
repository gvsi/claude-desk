/**
 * How long an About this prototype page takes to read, one rule for every page: the reading pages count their
 * document's words, the Vision article its own text and the words on its screens.
 */

/** The reading speed every About page assumes: 230 words a minute. */
export const WORDS_PER_MINUTE = 230;

/** The words in `texts`: runs of anything but whitespace, so "plumber’s" is one word and "B-2026-0412" another. */
export function wordCount(texts: readonly string[]): number {
  return texts.join(' ').split(/\s+/).filter(Boolean).length;
}

/** Minutes to read `words` words at `WORDS_PER_MINUTE`, rounded, and at least one. */
export function minutesToRead(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
