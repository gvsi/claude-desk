/**
 * Checks that `words`, text someone else wrote (a tool's title), shows in `root` only as user text:
 * each text node that holds them holds nothing else, inside an element marked `data-copy="user"`
 * that holds nothing else either, so no sentence of the app's runs into them. Attributes such as an
 * `aria-label` aren't read. Returns how many places show them, and throws when there are none or
 * when any of them isn't its own user-text element.
 */
export function expectUserText(root: Element, words: string): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const problems: string[] = [];
  let found = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!text.includes(words)) continue;
    found += 1;
    const marked = node.parentElement?.closest('[data-copy="user"]');
    if (text !== words || marked == null || marked.textContent !== words) {
      const line = (node.parentElement?.closest('p, li, h1, h2, h3, a, span') ?? node.parentElement)?.textContent ?? text;
      problems.push(`"${words}" is not its own user-text element in "${line.replace(/\s+/g, ' ').trim()}"`);
    }
  }
  if (found === 0) throw new Error(`"${words}" never shows in "${(root.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}"`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return found;
}
