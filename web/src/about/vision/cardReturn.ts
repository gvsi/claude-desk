type CardOpening = { href: string; refocus: boolean };

/** The card each article history entry opened, kept only for the life of its router. */
const OPENED_CARDS = new WeakMap<object, Map<string, CardOpening>>();

export function rememberVisionCard(navigator: object, key: string, href: string): void {
  const opened = OPENED_CARDS.get(navigator) ?? new Map<string, CardOpening>();
  opened.set(key, { href, refocus: true });
  OPENED_CARDS.set(navigator, opened);
}

export function openedVisionCard(navigator: object, key: string): string | undefined {
  const opened = OPENED_CARDS.get(navigator)?.get(key);
  return opened?.refocus ? opened.href : undefined;
}

/** Spending focus leaves the article entry remembered for later Back/Forward returns. */
export function forgetVisionCardFocus(navigator: object, key: string): void {
  const opened = OPENED_CARDS.get(navigator)?.get(key);
  if (opened) opened.refocus = false;
}

export function remembersVisionCard(navigator: object, key: string, href: string): boolean {
  return OPENED_CARDS.get(navigator)?.get(key)?.href === href;
}
