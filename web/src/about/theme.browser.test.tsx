/**
 * The About this prototype pages keep their own paper in either theme: every color on each page,
 * its ground, top bar, figures, app icon and footer included, is the same in the dark theme, the
 * light theme chosen in this browser, and System chosen on a system that prefers light.
 */
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, onTestFinished } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { chooseTheme, systemPrefersLight } from '../ds/test/theme.ts';
import { AboutWait } from './AboutWait.tsx';
import { ReaderError } from './ReaderError.tsx';
import { ReaderPage } from './ReaderPage.tsx';
import { VisionArticle } from './vision/VisionArticle.tsx';

const PAGES: readonly (readonly [name: string, path: string, page: ReactElement])[] = [
  ['the product proposal', '/about/proposal', <ReaderPage id="proposal" />],
  ['the capability prediction', '/about/prediction', <ReaderPage id="prediction" />],
  ['the Vision article', '/about/vision', <VisionArticle />],
  ['the error page', '/about/proposal', <ReaderError kind="document" />],
  ['the wait', '/about/proposal', <AboutWait />],
];

const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

/**
 * Every color the page draws with, element by element. The page's root is its paper, at least the
 * window's height, so the document's own ground under it never shows and isn't read.
 */
function colors(container: Element): string[] {
  const elements = [...container.querySelectorAll('*')];
  return elements.map((element, index) => {
    const style = getComputedStyle(element);
    const drawn = [
      style.color,
      style.backgroundColor,
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
      style.boxShadow,
      style.fill,
      style.stroke,
      style.textDecorationColor,
      style.colorScheme,
    ];
    return `${index} ${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''}: ${drawn.join(' | ')}`;
  });
}

describe('the About pages in either theme', () => {
  for (const [name, path, element] of PAGES) {
    it(`${name} keeps its paper in both themes`, async () => {
      onTestFinished(() => page.viewport(SIZES[0]!.width, SIZES[0]!.height));
      for (const size of SIZES) {
        await page.viewport(size.width, size.height);
        const screen = await render(
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="*" element={element} />
            </Routes>
          </MemoryRouter>,
        );
        const container = screen.container;
        // Dark, the default, then the light theme chosen in this browser.
        const dark = colors(container);
        expect(dark.length, name).toBeGreaterThan(0);
        chooseTheme('light');
        expect(colors(container), `${name} at ${size.width}, light chosen`).toEqual(dark);
        chooseTheme('dark');
        expect(colors(container), `${name} at ${size.width}, dark chosen`).toEqual(dark);
        await screen.unmount();
      }
    });
  }

  it('the vision article keeps its paper when System is chosen and the system prefers light', async () => {
    const screen = await render(
      <MemoryRouter initialEntries={['/about/vision']}>
        <VisionArticle />
      </MemoryRouter>,
    );
    const dark = colors(screen.container);
    await systemPrefersLight();
    chooseTheme('system');
    expect(colors(screen.container)).toEqual(dark);
  });
});
