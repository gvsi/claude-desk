/**
 * Every story renders in the design system's web fonts, never a fallback: the preview's beforeEach
 * waits for the font stylesheet and its faces before a story renders, so a play never measures a
 * line wrapped in Georgia or a runner's generic serif.
 */
import { afterEach, expect, it } from 'vitest';

import previewHead from '../../../.storybook/preview-head.html?raw';
import preview from '../../../.storybook/preview.tsx';
import { FONT_FACES, FONT_SHEET_URL, requireFaces, withinDeadline } from './fonts.ts';

afterEach(() => {
  for (const link of document.querySelectorAll('link[data-test-font-sheet]')) link.remove();
});

/** The font stylesheet as the preview's head links it, added the way Storybook's iframe has it. */
function linkFontSheet(): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_SHEET_URL;
  link.dataset.testFontSheet = '';
  document.head.append(link);
  return link;
}

it('stories_render_in_the_web_fonts', async () => {
  linkFontSheet();
  const beforeEach = preview.beforeEach;
  expect(typeof beforeEach, 'the preview waits for something before each story').toBe('function');
  await (beforeEach as () => Promise<void>)();
  // A face of each family and style is registered and loaded, not merely "nothing left to load",
  // which document.fonts.check() also reports when no face matches at all.
  for (const { family, style } of FONT_FACES) {
    const loaded = [...document.fonts].filter((face) => face.family.replaceAll('"', '') === family && face.style === style && face.status === 'loaded');
    expect(loaded.length, `${style} ${family}`).toBeGreaterThan(0);
  }
});

it('a_font_with_no_face_fails', async () => {
  await expect(requireFaces(['400 16px "No Such Family"'])).rejects.toThrow('No Such Family');
});

it('one_deadline_covers_every_wait', async () => {
  await expect(withinDeadline(new Promise<never>(() => undefined), 20, 'The web fonts')).rejects.toThrow("The web fonts didn't load within 20 ms.");
});

it('font_sheet_url_matches_the_preview_head', () => {
  expect(previewHead).toContain(`href="${FONT_SHEET_URL}"`);
});
