/**
 * What an About page shows when its document can't be read: `documents.ts` throws here, as it does when a
 * document fails to parse, so the reader can't load, while its error page, which never imports the documents,
 * still draws and points into the prototype.
 */
import axe from 'axe-core';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { CONCEPT_FOOTER_TEXT, assertCleanCopy } from '../ds/test/copy.ts';
import { writeLocal } from '../lib/storage.ts';
import { AXE_TAGS, assertNoJargon } from '../test/screen.ts';
import { AboutWait } from './AboutWait.tsx';
import { ReaderError } from './ReaderError.tsx';

// The registry as it is when a document can't be parsed: reading it throws. (A factory that throws itself
// fails the browser's module mocker, outside the test.)
vi.mock('./documents.ts', () => {
  const unreadable = (): never => {
    throw new Error('docs/product-proposal.md line 12: raw HTML');
  };
  return {
    get ABOUT_DOCUMENTS() {
      return unreadable();
    },
    get readingMinutes() {
      return unreadable();
    },
    get documentText() {
      return unreadable();
    },
    get inlineText() {
      return unreadable();
    },
  };
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Where the memory router is, after the link into the prototype. */
const at = { path: '' };

function LocationProbe() {
  const location = useLocation();
  at.path = location.pathname;
  return null;
}

afterEach(async () => {
  writeLocal('lastDesk', null);
  await page.viewport(DESKTOP.width, DESKTOP.height);
});

describe('ReaderError', () => {
  it('reader_error_names_a_next_step', async () => {
    // The reader can't load without its documents.
    await expect(import('./ReaderPage.tsx')).rejects.toThrow(/raw HTML/);

    for (const [lastDesk, to] of [
      ['desk-rivera', '/app/desk-rivera/today'],
      [null, '/'],
    ] as const) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${size.width}, last Desk ${lastDesk}`;
        await page.viewport(size.width, size.height);
        writeLocal('lastDesk', lastDesk);
        const screen = await render(
          <MemoryRouter initialEntries={['/about/proposal']}>
            <Routes>
              <Route path="/about/proposal" element={<ReaderError />} />
              <Route path="*" element={null} />
            </Routes>
            <LocationProbe />
          </MemoryRouter>,
        );

        // What happened and what to do, in plain words, never the error itself.
        const text = (screen.container.textContent ?? '').replace(/\s+/g, ' ');
        expect(text, where).toContain('This document can’t be shown right now. You can go back and try again later.');
        expect(text, where).not.toContain('raw HTML');
        // The next step: the link into the prototype, to the Desk or its start.
        const back = screen.getByRole('link', { name: 'Try Desk prototype', exact: true });
        await expect.element(back, { timeout: 1000 }).toHaveAttribute('href', to);
        // The footer, the copy check, axe, and no technical words.
        const footers = screen.container.querySelectorAll('[data-ds="concept-footer"]');
        expect(footers, where).toHaveLength(1);
        expect(footers[0]?.textContent, where).toBe(CONCEPT_FOOTER_TEXT);
        assertCleanCopy(screen.container);
        assertNoJargon(screen.container);
        const results = await axe.run(screen.container, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
        expect(results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)), where).toEqual([]);
        expect(document.documentElement.scrollWidth, where).toBeLessThanOrEqual(size.width);

        await userEvent.click(back.element());
        await expect.poll(() => at.path).toBe(to);
        await screen.unmount();
      }
    }
  });

  it('the_error_and_the_wait_are_on_paper', async () => {
    // The About set's pages are drawn on the Vision article's paper, so what one shows while its code loads, and
    // when it can't be drawn, is on the same paper: no dark ground before or instead of the page. The error page's
    // bell keeps the drawing's dark ink, as on any light ground.
    const PAPER = 'rgb(244, 242, 236)';
    const INK = 'rgb(28, 27, 25)';
    for (const size of [DESKTOP, PHONE]) {
      await page.viewport(size.width, size.height);
      for (const kind of ['document', 'page'] as const) {
        const where = `${kind} at ${size.width}`;
        const screen = await render(
          <MemoryRouter>
            <ReaderError kind={kind} />
          </MemoryRouter>,
        );
        const root = screen.container.firstElementChild as HTMLElement;
        expect([getComputedStyle(root).backgroundColor, getComputedStyle(root).color, getComputedStyle(root).colorScheme], where).toEqual([
          PAPER,
          INK,
          'light',
        ]);
        // The page fills the window, so no other ground shows under it.
        expect(root.getBoundingClientRect().height, where).toBeGreaterThanOrEqual(size.height);
        const ink = screen.container.querySelector('header svg.cd-mark > g > g:last-child') as Element;
        expect(getComputedStyle(ink).fill, where).toBe('rgb(20, 20, 19)');
        const results = await axe.run(screen.container, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
        expect(results.passes.map((rule) => rule.id), where).toContain('color-contrast');
        expect(results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)), where).toEqual([]);
        await screen.unmount();
      }

      const wait = await render(<AboutWait />);
      const ground = wait.container.firstElementChild as HTMLElement;
      expect(getComputedStyle(ground).backgroundColor, `the wait at ${size.width}`).toBe(PAPER);
      expect(ground.getBoundingClientRect().height, `the wait at ${size.width}`).toBeGreaterThanOrEqual(size.height);
      // It is only the ground: nothing to read yet.
      expect(ground.textContent, `the wait at ${size.width}`).toBe('');
      await wait.unmount();
    }
  });
});
