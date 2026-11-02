/** The card each article history entry opened, kept only for the life of its router. */
const OPENED_CARDS = new WeakMap<object, Map<string, string>>();

export function rememberVisionCard(navigator: object, key: string, href: string): void {
  const opened = OPENED_CARDS.get(navigator) ?? new Map<string, string>();
  opened.set(key, href);
  OPENED_CARDS.set(navigator, opened);
}

export function openedVisionCard(navigator: object, key: string): string | undefined {
  return OPENED_CARDS.get(navigator)?.get(key);
}

export function forgetVisionCard(navigator: object, key: string): void {
  OPENED_CARDS.get(navigator)?.delete(key);
}
