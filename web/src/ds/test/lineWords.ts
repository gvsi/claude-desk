/**
 * The words of an element's text, grouped by the line the browser set each on, top to bottom, so a
 * test can read a title's wrapping word by word: whether "live" sits alone on the last line. It
 * comes from the layout (each word's own box), never from counting characters. A word is a run of
 * non-space characters; one split across elements ("Bay<b>view</b>") counts once, on the line where
 * it starts. Text the browser draws nowhere (`display: none`) is left out.
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

  const lines = new Map<number, string[]>();
  for (const match of text.matchAll(/\S+/g)) {
    const range = doc.createRange();
    range.setStart(...point(match.index, false));
    range.setEnd(...point(match.index + match[0].length, true));
    const first = [...range.getClientRects()].find((box) => box.width > 0);
    if (first === undefined) continue;
    const top = Math.round(first.top);
    const line = lines.get(top);
    if (line) line.push(match[0]);
    else lines.set(top, [match[0]]);
  }
  return [...lines.entries()].sort(([a], [b]) => a - b).map(([, words]) => words);
}
