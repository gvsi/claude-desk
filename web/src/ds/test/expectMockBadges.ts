/**
 * The mock connector check: every external connector's name in `root` ("Stripe", "Google
 * Calendar") has the "Mock" badge right beside it, so a mock is never named without saying so.
 *
 * - A name that is the whole text of an element needs "Mock" as that element's next sibling, as
 *   `ConnectorName` draws it.
 * - A name inside running text ("Stripe changed “Refund”") needs "Mock" in its nearest block: the
 *   closest list item, section, article, dialog, header, footer, aside, cell or group around it,
 *   or else `root`. So a card that names the connector in a sentence also names it with its badge.
 *
 * It returns how many whole names it found, and fails when there are none, so it can't pass by
 * finding nothing.
 */

/** The external connectors in the demo, all of them mocks. */
export const MOCK_CONNECTOR_NAMES: readonly string[] = ['Stripe', 'Google Calendar'];

/** The containers a name in running text looks in for its "Mock". */
const BLOCKS = 'li, section, article, dialog, header, footer, aside, td, [role="group"], [role="dialog"], [role="listitem"], [role="region"]';

/** The text of each name mentioned inside running text in `root` whose nearest block has no "Mock". */
function mentionsWithoutMock(root: HTMLElement, names: readonly string[]): string[] {
  const bare: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const name = names.find((candidate) => text.includes(candidate));
    const parent = node.parentElement;
    if (name === undefined || parent === null) continue;
    // A whole name in its own element is checked beside its badge.
    if (parent.children.length === 0 && (parent.textContent ?? '').trim() === name) continue;
    const block = parent.closest<HTMLElement>(BLOCKS);
    const scope = block !== null && root.contains(block) ? block : root;
    if (!(scope.textContent ?? '').includes('Mock')) bare.push(text.trim());
  }
  return bare;
}

export function expectMockBesideExternalNames(root: HTMLElement, names: readonly string[] = MOCK_CONNECTOR_NAMES): number {
  const named = [...root.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.children.length === 0 && names.includes((el.textContent ?? '').trim()),
  );
  if (named.length === 0) throw new Error(`No external connector is named here (${names.join(', ')})`);
  const bare = named.filter((el) => (el.nextElementSibling?.textContent ?? '').trim() !== 'Mock');
  if (bare.length > 0) {
    throw new Error(`"Mock" is missing beside: ${bare.map((el) => `"${el.textContent ?? ''}"`).join(', ')}`);
  }
  const mentions = mentionsWithoutMock(root, names);
  if (mentions.length > 0) {
    throw new Error(`"Mock" is missing near: ${mentions.map((text) => `"${text}"`).join(', ')}`);
  }
  return named.length;
}
