/**
 * The design system's web fonts, as the Storybook preview's head links them
 * (`.storybook/preview-head.html`). Until they load, text is drawn in a fallback (Georgia on a Mac,
 * a generic serif on a Linux runner) that wraps differently, so a story measured then is measured
 * in the wrong font.
 */

/** The stylesheet the preview's head links; its `href` matches the link's exactly. */
export const FONT_SHEET_URL =
  'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300..700&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..700;1,8..60,300..700&family=JetBrains+Mono:wght@400&display=swap';

/** Each family and style the stylesheet serves; each is one variable font file per subset. */
export const FONT_FACES = [
  { family: 'Source Serif 4', style: 'normal' },
  { family: 'Source Serif 4', style: 'italic' },
  { family: 'Hanken Grotesk', style: 'normal' },
  { family: 'JetBrains Mono', style: 'normal' },
] as const;

/** How long the stylesheet and its faces get, together, before the story fails, in ms. */
export const FONT_TIMEOUT = 10_000;

/** `promise`, or a failure naming `what` once `ms` have passed without it settling. */
export function withinDeadline<T>(promise: Promise<T>, ms: number, what: string, timeoutMessage = `${what} didn't load within ${ms} ms.`): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
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
 * Loads each face (a CSS `font` value) and fails unless at least one face matches it and every
 * match loaded. `document.fonts.check()` alone isn't enough: it also says yes when nothing
 * matches, so a stylesheet that declares no faces would pass it.
 */
export async function requireFaces(faces: readonly string[]): Promise<void> {
  const missing: string[] = [];
  for (const face of faces) {
    const loaded = await document.fonts.load(face);
    if (loaded.length === 0 || loaded.some((font) => font.status !== 'loaded')) missing.push(face);
  }
  if (missing.length > 0) throw new Error(`These web fonts didn't load, so the story would be drawn in a fallback: ${missing.join(', ')}.`);
}

/**
 * Resolves once the font stylesheet, a face of each family and style in `FONT_FACES`, and every
 * font the document is still loading are in, all within one deadline. A page without the
 * stylesheet (a test that composes stories outside Storybook's iframe) draws in the fallbacks on
 * purpose, so there is nothing to wait for. Fails, rather than letting the story measure a
 * fallback, if they don't load in time.
 */
export async function webFontsLoaded(): Promise<void> {
  const want = new URL(FONT_SHEET_URL).href;
  const link = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find((el) => el.href === want);
  if (!link) return;
  const loading = async () => {
    await sheetLoaded(link);
    await requireFaces(FONT_FACES.map(({ family, style }) => `${style} 400 16px "${family}"`));
    await document.fonts.ready;
  };
  await withinDeadline(loading(), FONT_TIMEOUT, 'The web fonts');
}

/** Load the app's font sheet in a browser test whose harness does not include index.html. */
export async function loadWebFonts(): Promise<void> {
  const want = new URL(FONT_SHEET_URL).href;
  if (![...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some((link) => link.href === want)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_SHEET_URL;
    document.head.append(link);
  }
  await webFontsLoaded();
}
