/**
 * A verified visitor's document link (`/api/d/{token}`), as the API serves the kernel's document
 * (`backend/desk/api/routes/proxy.py` over `kernel_service/adapters/release_document.py`): each
 * document card hands out a link of its own (world.ts `reply`), which opens once, as plain text
 * shown in the tab under a file name made from the card's title. Opened, or never handed out, it
 * answers 404 in the API's short static copy (its error, when JSON is asked for), for good, and a
 * HEAD answers 200 without opening it, whatever it names. The API's expiry, prefetch refusal and
 * rate limit aren't mocked.
 */

/** A document link a card handed out in a copy: the card's title, and whether it was opened. */
export interface DocumentLink {
  title: string;
  opened: boolean;
}

/** A document link's answer: its status, its headers by lowercase name, and its body (none for a HEAD). */
export interface DocumentAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/** A document card's link, with its token. */
export const DOCUMENT_HREF = /^\/api\/d\/([A-Za-z0-9_-]+)$/;

/** The fixtures' document link token (`rivera.blocks.document_link`): the first one the screen tests' copy hands out. */
export const DOCUMENT_TOKEN = '9fK2mQ';

/** The headers the API sends with a document and with a refusal on its link: never cached, sniffed, sent on as a referrer or indexed. */
const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

/** What a document says, by its card's title, as the kernel's seed has it (`kernel_service/seed.py`); any other says its title. */
const DOCUMENT_TEXT: Readonly<Record<string, string>> = {
  'Invoice, drain clearing': 'Turner Plumbing\nInvoice for Dana Whitfield\nDrain clearing, kitchen sink: $180.00\nPaid in full. Thank you.',
};

/** The API's copy for a link that was opened, has expired or names nothing (`DOCUMENT_COPY`'s 404). */
const USED_OR_EXPIRED = {
  en: 'This link was already opened or has expired. Ask in the chat for a new one.',
  es: 'Este enlace ya se abrió o caducó. Pide uno nuevo en el chat.',
} as const;

/**
 * The file name the kernel gives a document (`download_name`): the title's letters and digits in
 * ASCII (accents dropped), every other run of characters as one hyphen, at most 60 of them, then
 * `.txt`; `document.txt` when no letter or digit is left.
 */
export function downloadName(title: string): string {
  const ascii = title.normalize('NFKD').replace(/[\u0080-￿]/g, '');
  const stem = ascii.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${stem === '' ? 'document' : stem}.txt`;
}

/** A header's `q`: 1 when it names none, and 0 (not wanted) when it can't be read. */
function quality(params: readonly string[]): number {
  const q = params.map((param) => param.split('=')).find(([name]) => name?.trim().toLowerCase() === 'q');
  if (q === undefined) return 1;
  const value = Number(q[1]);
  return value >= 0 && value <= 1 ? value : 0;
}

/** A header's comma-separated values, lowercased, each with its `q`, in the order sent. */
function ranked(header: string | null): [value: string, quality: number][] {
  return (header ?? '').split(',').map((item) => {
    const [value = '', ...params] = item.split(';');
    return [value.trim().toLowerCase(), quality(params)];
  });
}

/** Whether the browser prefers Spanish to English (`Accept-Language`); the first listed wins a tie. */
function prefersSpanish(acceptLanguage: string | null): boolean {
  let best = { quality: 0, language: 'en' };
  for (const [tag, q] of ranked(acceptLanguage)) {
    const language = tag.split('-')[0] ?? '';
    if ((language === 'en' || language === 'es') && q > best.quality) best = { quality: q, language };
  }
  return best.language === 'es';
}

/** The 404 a link that can't open answers: the API's error when JSON is asked for, else its static copy in the browser's language. */
function usedOrExpired(request: Headers): DocumentAnswer {
  const headers = { ...PRIVATE_HEADERS, vary: 'accept, accept-language' };
  if (ranked(request.get('accept')).some(([media, q]) => media === 'application/json' && q > 0)) {
    return { status: 404, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ error: 'link_used_or_expired' }) };
  }
  const language = prefersSpanish(request.get('accept-language')) ? 'es' : 'en';
  return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers, 'content-language': language }, body: USED_OR_EXPIRED[language] };
}

/** A HEAD on a document link: 200 with the document's privacy headers and no body, whatever it names, and the link stays unopened. */
export function lookAtDocument(): DocumentAnswer {
  return { status: 200, headers: { ...PRIVATE_HEADERS }, body: null };
}

/** A GET on a document link: `link`'s document, which uses it up, or the 404 for one opened or handed out by no card. */
export function openDocument(link: DocumentLink | undefined, request: Headers): DocumentAnswer {
  if (link === undefined || link.opened) return usedOrExpired(request);
  link.opened = true;
  return {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `inline; filename="${downloadName(link.title)}"`, ...PRIVATE_HEADERS },
    body: DOCUMENT_TEXT[link.title] ?? link.title,
  };
}
