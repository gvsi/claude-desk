/**
 * The words of an element's text, grouped by the line the browser set each on, top to bottom, so a
 * test can read a title's wrapping word by word: whether "live" sits alone on the last line. It
 * comes from the layout (each character's own box), never from counting characters. A word is a run
 * of non-space characters; one split across elements ("Bay<b>view</b>") counts once on its line. A
 * word the browser breaks across lines (`overflow-wrap: anywhere`) is read on every line it takes,
 * as the part drawn there, so the lines read back are the lines drawn. Text the browser draws nowhere
 * (`display: none`) is left out.
 *
 * Every box is collected first, then two boxes are on one line when the middle of either falls
 * inside the other's top and bottom, and so are boxes linked through others. The order the boxes
 * come in doesn't matter, so words of any sizes on one line stay on it, whichever comes first.
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

  /** The first box the browser draws the text from `from` to `to` in, leaving out empty ones. */
  const boxOf = (from: number, to: number): DOMRect | undefined => {
    const range = doc.createRange();
    range.setStart(...point(from, false));
    range.setEnd(...point(to, true));
    return [...range.getClientRects()].find((box) => box.width > 0 && box.height > 0);
  };

  // Each word, as its characters (graphemes) and the box each is drawn in, if any.
  type Piece = { text: string; box: DOMRect | undefined };
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const words: Piece[][] = [...text.matchAll(/\S+/g)].map((match) =>
    [...graphemes.segment(match[0])].map(({ segment, index }) => ({
      text: segment,
      box: boxOf(match.index + index, match.index + index + segment.length),
    })),
  );

  // The lines: the boxes grouped by vertical overlap, whatever order they come in.
  const boxes = words.flat().flatMap((piece) => (piece.box === undefined ? [] : [piece.box]));
  const parent = boxes.map((_, at) => at);
  const root = (at: number): number => {
    let top = at;
    while (parent[top] !== top) top = parent[top] as number;
    parent[at] = top;
    return top;
  };
  /** Whether `inner`'s vertical middle falls inside `outer`'s top and bottom. */
  const holds = (outer: DOMRect, inner: DOMRect): boolean => {
    const middle = (inner.top + inner.bottom) / 2;
    return outer.top <= middle && middle <= outer.bottom;
  };
  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      const [boxA, boxB] = [boxes[a] as DOMRect, boxes[b] as DOMRect];
      if (holds(boxA, boxB) || holds(boxB, boxA)) parent[root(a)] = root(b);
    }
  }
  type Line = { top: number; words: string[] };
  const lines = new Map<number, Line>();
  const lineOf = new Map<DOMRect, Line>();
  boxes.forEach((box, at) => {
    const key = root(at);
    const line = lines.get(key) ?? { top: box.top, words: [] };
    line.top = Math.min(line.top, box.top);
    lines.set(key, line);
    lineOf.set(box, line);
  });

  // Each word goes to its line in the text's order. A word on more than one line goes as its parts,
  // a run of characters on each, and a character with no box of its own stays with its neighbours.
  for (const pieces of words) {
    let part = '';
    let partLine: Line | undefined;
    for (const piece of pieces) {
      const line = piece.box === undefined ? partLine : lineOf.get(piece.box);
      if (partLine !== undefined && line !== partLine) {
        partLine.words.push(part);
        part = '';
      }
      partLine = line;
      part += piece.text;
    }
    if (partLine !== undefined) partLine.words.push(part);
  }
  return [...lines.values()].sort((a, b) => a.top - b.top).map((line) => line.words);
}
