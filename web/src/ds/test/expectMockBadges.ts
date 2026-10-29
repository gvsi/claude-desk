/**
 * The mock connector check: every external connector's name in `root` ("Stripe", "Google
 * Calendar") has the "Mock" badge right beside it, so a mock is never named without saying so. It
 * finds each name where it is the whole text of an element, and fails when there are none, so it
 * can't pass by finding nothing.
 */

/** The external connectors in the demo, all of them mocks. */
export const MOCK_CONNECTOR_NAMES: readonly string[] = ['Stripe', 'Google Calendar'];

export function expectMockBesideExternalNames(root: HTMLElement, names: readonly string[] = MOCK_CONNECTOR_NAMES): number {
  const named = [...root.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.children.length === 0 && names.includes((el.textContent ?? '').trim()),
  );
  if (named.length === 0) throw new Error(`No external connector is named here (${names.join(', ')})`);
  const bare = named.filter((el) => (el.nextElementSibling?.textContent ?? '').trim() !== 'Mock');
  if (bare.length > 0) {
    throw new Error(`"Mock" is missing beside: ${bare.map((el) => `"${el.textContent ?? ''}"`).join(', ')}`);
  }
  return named.length;
}
