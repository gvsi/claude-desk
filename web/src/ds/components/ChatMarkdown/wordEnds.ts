/**
 * A word that opens a line's block and shows nothing on its own: a bullet, a list number, heading
 * hashes, a quote mark, a table row's first pipe or a code fence. Cut right after one, a paragraph's
 * next line can read as a heading's underline, or the marker shows as text, so it waits for the
 * word after it.
 */
const OPENING_MARKER = /^(?:[-*+]|\d{1,9}[.)]|#{1,6}|>+|\||`{3,}\S*|~{3,}\S*)$/;

/** The row of dashes under a table's header (GFM's delimiter row), as Streamdown recognises it. */
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;

/** What a delimiter row can look like before it is whole, empty included. */
const UNFINISHED_DELIMITER_ROW = /^[ \t|:-]*$/;

interface Line {
  start: number;
  text: string;
  /** A newline follows it, so it can't grow. */
  closed: boolean;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    lines.push({ start, text: line, closed: start + line.length < text.length });
    start += line.length + 1;
  }
  return lines;
}

/**
 * The stretches no cut may fall inside, as [from, to): a table's header row with its delimiter
 * row, which show together. Without its delimiter row a header row is a paragraph of pipes. While
 * the text grows, a row that opens a table is held from its start until its delimiter row is whole.
 */
function tableHeads(lines: readonly Line[], growing: boolean): [number, number][] {
  const heads: [number, number][] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.text.includes('|')) continue;
    const next = lines[index + 1];
    if (next !== undefined && (next.closed || !growing) && DELIMITER_ROW.test(next.text.trim())) {
      heads.push([line.start, next.start + next.text.trimEnd().length]);
      continue;
    }
    const opensTable = line.text.trimStart().startsWith('|') && !(lines[index - 1]?.text.includes('|') ?? false);
    const waiting = next === undefined || (!next.closed && UNFINISHED_DELIMITER_ROW.test(next.text));
    if (growing && opensTable && waiting) heads.push([line.start, Infinity]);
  }
  return heads;
}

/**
 * Where Claude's Markdown may be cut while it is revealed or streamed, so that the cut renders
 * cleanly:
 *
 * - after a whole word. While the text is still `growing`, its last word may be unfinished, so it
 *   is held back until a space or the end of the stream says it is whole;
 * - never right after a block's opening marker, so a block appears with its first word;
 * - never inside a table's head, so a table appears with its header row.
 *
 * Each value is a length: `text.slice(0, end)` is a prefix a reader may see.
 */
export function wordEnds(text: string, growing: boolean): number[] {
  const heads = tableHeads(linesOf(text), growing);
  const ends: number[] = [];
  let previousEnd = 0;
  let opening = true;
  for (const word of text.matchAll(/\S+/g)) {
    const end = word.index + word[0].length;
    if (text.slice(previousEnd, word.index).includes('\n')) opening = true;
    previousEnd = end;
    if (opening && OPENING_MARKER.test(word[0])) continue;
    opening = false;
    if (growing && end === text.length) continue;
    if (heads.some(([from, to]) => from < end && end < to)) continue;
    ends.push(end);
  }
  if (!growing && text.length > 0 && ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}
