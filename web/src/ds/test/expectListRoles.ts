/**
 * The list check: a `ul` or `ol` whose CSS removes its markers keeps its list semantics only if it
 * says `role="list"`, since Safari (WebKit) drops them otherwise, and a screen reader then gives no
 * list navigation or count. Every list in `root` drawn without markers must say so. It returns how
 * many it checked, and fails when there are none, so it can't pass by finding nothing.
 */
export function expectListsKeepTheirRole(root: HTMLElement): number {
  const bare = [...root.querySelectorAll<HTMLElement>('ul, ol')].filter((list) => getComputedStyle(list).listStyleType === 'none');
  if (bare.length === 0) throw new Error('No list without markers is drawn here');
  const missing = bare.filter((list) => list.getAttribute('role') !== 'list');
  if (missing.length > 0) {
    throw new Error(`role="list" is missing on: ${missing.map((list) => `<${list.tagName.toLowerCase()} class="${list.className}">`).join(', ')}`);
  }
  return bare.length;
}
