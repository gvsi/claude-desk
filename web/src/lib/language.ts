/**
 * The language of page chrome on visitor surfaces: Spanish when the browser's first language is
 * Spanish, else English. A message's cards follow the message's own `language`, not this.
 */
export type BrowserLanguage = 'en' | 'es';

export function browserLanguage(): BrowserLanguage {
  const first = navigator.languages?.[0] ?? navigator.language ?? '';
  return /^es(?:-|$)/i.test(first) ? 'es' : 'en';
}
