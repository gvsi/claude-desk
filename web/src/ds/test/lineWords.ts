/**
 * The words of an element's text, grouped by the line the browser set each on, top to bottom, so a
 * test can read a title's wrapping word by word: whether "live" sits alone on the last line. It
 * comes from the layout (each word's own boxes), never from counting characters. A word is a run of
 * non-space characters; one split across elements ("Bay<b>view</b>") counts once on its line. A word
 * the browser breaks across lines (`overflow-wrap: anywhere`) is read on every line it takes, as the
 * part drawn there, so the lines read back are the lines drawn. Text the browser draws nowhere
 * (`display: none`) is left out.
 *
 * A box joins a line when its vertical middle falls inside that line's top and bottom, which grow to
 * hold every box on it, so words of different sizes on one line stay on it.
 */
export function lineWords(element: Element): string[][] {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);

  // Where each text node starts in the element's whole text.
  const starts: number[] = [];
  let length = 0;
  for (const node of nodes) {
    starts.push(length);
    length += node.data.length;
  }
  const text = nodes.map((node) => node.data).join('');

  /** The text node and offset in it for a place in the whole text: the node it starts (or ends, for `end`) in. */
  const point = (offset: number, end: boolean): [Text, number] => {
    for (let at = nodes.length - 1; at >= 0; at -= 1) {
      const start = starts[at] as number;
      if (end ? start < offset : start <= offset) return [nodes[at] as Text, offset - start];
    }
    throw new Error(`lineWords: no text at ${offset}`);
  };

  /** The boxes the browser draws the text from `from` to `to` in, leaving out empty ones. */
  const boxesOf = (from: number, to: number): DOMRect[] => {
    const range = doc.createRange();
    range.setStart(...point(from, false));
    range.setEnd(...point(to, true));
    return [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
  };

  type Line = { top: number; bottom: number; words: string[] };
  const lines: Line[] = [];
  /** The line a box sits on: the one its vertical middle falls in, grown to hold it, or a new one. */
  const lineOf = (box: DOMRect): Line => {
    const middle = (box.top + box.bottom) / 2;
    const line = lines.find((at) => at.top <= middle && middle <= at.bottom);
    if (line === undefined) {
      const added = { top: box.top, bottom: box.bottom, words: [] };
      lines.push(added);
      return added;
    }
    line.top = Math.min(line.top, box.top);
    line.bottom = Math.max(line.bottom, box.bottom);
    return line;
  };

  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    const boxes = boxesOf(match.index, match.index + word.length);
    const on = new Set(boxes.map(lineOf));
    if (on.size === 1) {
      [...on][0]?.words.push(word);
      continue;
    }
    if (on.size === 0) continue;
    // Broken across lines: each character goes to the line its box is on, and the run of them on one
    // line is the part read there. A character with no box of its own stays with its neighbours.
    let part = '';
    let partLine: Line | undefined;
    for (const { segment, index } of graphemes.segment(word)) {
      const box = boxesOf(match.index + index, match.index + index + segment.length)[0];
      const line = box === undefined ? partLine : lineOf(box);
      if (partLine !== undefined && line !== partLine) {
        partLine.words.push(part);
        part = '';
      }
      partLine = line;
      part += segment;
    }
    if (part !== '') partLine?.words.push(part);
  }
  return lines.sort((a, b) => a.top - b.top).map((line) => line.words);
}
