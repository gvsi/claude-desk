/**
 * The design system's web fonts, as the Storybook preview's head links them
 * (`.storybook/preview-head.html`). Until they load, text is drawn in a fallback (Georgia on a Mac,
 * a generic serif on a Linux runner) that wraps differently, so a story measured then is measured
 * in the wrong font.
 */

/** The stylesheet the preview's head links; its `href` matches the link's exactly. */
export const FONT_SHEET_URL =
  'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300..700&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..700;1,8..60,300..700&family=JetBrains+Mono:wght@400&display=swap';

/** One face of each family and style the stylesheet serves; each is one variable font file. */
export const FONT_FACES = [
  '400 16px "Source Serif 4"',
  'italic 400 16px "Source Serif 4"',
  '400 16px "Hanken Grotesk"',
  '400 16px "JetBrains Mono"',
] as const;

/** How long the stylesheet and its faces get before the story fails, in ms. */
const FONT_TIMEOUT = 10_000;

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} didn't load within ${FONT_TIMEOUT} ms.`)), FONT_TIMEOUT);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sheetLoaded(link: HTMLLinkElement): Promise<void> {
  if (link.sheet) return Promise.resolve();
  return new Promise((resolve, reject) => {
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => reject(new Error(`The font stylesheet failed to load: ${link.href}`)), { once: true });
  });
}

/**
 * Resolves once the font stylesheet and every face in `FONT_FACES` have loaded. A page without the
 * stylesheet (a test that composes stories outside Storybook's iframe) draws in the fallbacks on
 * purpose, so there is nothing to wait for. Fails, rather than letting the story measure a
 * fallback, if they don't load in time.
 */
export async function webFontsLoaded(): Promise<void> {
  const want = new URL(FONT_SHEET_URL).href;
  const link = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find((el) => el.href === want);
  if (!link) return;
  await within(sheetLoaded(link), 'The font stylesheet');
  await within(Promise.all(FONT_FACES.map((face) => document.fonts.load(face))), 'The web fonts');
  await document.fonts.ready;
  const missing = FONT_FACES.filter((face) => !document.fonts.check(face));
  if (missing.length > 0) throw new Error(`These web fonts didn't load, so the story would be drawn in a fallback: ${missing.join(', ')}.`);
}
