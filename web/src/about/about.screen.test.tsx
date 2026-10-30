/**
 * The About this prototype reading pages at their own addresses, in the whole app against the mock API: each
 * page loads when its address opens, draws its document, and asks the API for nothing, for a stranger and for
 * an owner whose browser has opened a Desk. Expected words are written out here, never read from the page's
 * code.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { writeLocal } from '../lib/storage.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const PAGES = [
  { path: '/about/proposal', title: 'Product proposal' },
  { path: '/about/prediction', title: 'Capability prediction' },
] as const;

afterEach(() => {
  writeLocal('lastDesk', null);
});

describe('About pages', () => {
  it('about_pages_render_at_their_routes', async () => {
    writeLocal('lastDesk', null);
    // Nothing is logged on the way, such as React Router's warning, given once, for a page whose code is
    // still loading on a first visit and has nothing to show meanwhile.
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });
    for (const [i, { path, title }] of PAGES.entries()) {
      const { screen, router } = await renderRoute(path);
      // The page is drawn once its code has loaded: its title, its article and the way back.
      await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await expect.element(screen.getByRole('article')).toBeVisible();
      await expect.element(screen.getByRole('link', { name: 'Back to the prototype', exact: true })).toHaveAttribute('href', '/');
      const documents = screen.getByRole('navigation', { name: 'Documents' });
      await expect.element(documents.getByRole('link', { name: title, exact: true })).toHaveAttribute('aria-current', 'page');

      // The switch opens the other page at its own address.
      const other = PAGES[1 - i];
      if (!other) throw new Error('two pages');
      await userEvent.click(documents.getByRole('link', { name: other.title, exact: true }));
      await expect.poll(() => router.state.location.pathname).toBe(other.path);
      await expect.element(screen.getByRole('heading', { level: 1, name: other.title, exact: true })).toBeVisible();
    }
    const logged = (spy: typeof warn) => spy.mock.calls.map((call) => String(call[0]));
    expect(logged(warn)).toEqual([]);
    expect(logged(error)).toEqual([]);

    // Any other address under /about is a page that doesn't exist.
    for (const path of ['/about', '/about/', '/about/proposal/more', '/about/readme']) {
      const { screen } = await renderRoute(path);
      await expect.element(screen.getByText("This page doesn't exist", { exact: true }), { message: path }).toBeVisible();
    }
  });

  it('about_pages_make_no_requests', async () => {
    for (const [lastDesk, back] of [
      [RIVERA.deskId, 'Back to your Desk'],
      [null, 'Back to the prototype'],
    ] as const) {
      for (const { path, title } of PAGES) {
        for (const viewport of ['desktop', 'phone'] as const) {
          const where = `${path} at ${viewport}, last Desk ${lastDesk}`;
          writeLocal('lastDesk', lastDesk);
          const before = [...mockStore.requests];
          const { screen } = await renderRoute(path, { viewport });
          await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true }), { message: where }).toBeVisible();
          await expect.element(screen.getByRole('link', { name: back, exact: true }), { message: where }).toBeVisible();
          // Long enough for anything the page asked for as it opened to reach the mock API.
          await settle();
          expect(mockStore.requests, where).toEqual(before);
        }
      }
    }
  });

  it('about_pages_pass_screen_basics', async () => {
    for (const lastDesk of [RIVERA.deskId, null]) {
      for (const { path, title } of PAGES) {
        for (const viewport of ['desktop', 'phone'] as const) {
          const where = `${path} at ${viewport}, last Desk ${lastDesk}`;
          writeLocal('lastDesk', lastDesk);
          const { screen } = await renderRoute(path, { viewport });
          await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true }), { message: where }).toBeVisible();
          // One concept footer, the copy check over the whole page, the documents' words included, and axe. Not
          // the owner's jargon check: the documents name the kernel and its proofs, which is what they are
          // about (the reader's own words are checked in reader.browser.test.tsx).
          await expectScreenBasics(screen.container, { owner: false });
          expectNoHorizontalScroll();
        }
      }
    }
  });

  it('about_pages_are_noindex', async () => {
    const robots = () => [...document.head.querySelectorAll('meta[name="robots"]')].map((meta) => meta.getAttribute('content'));
    // The rest of the app asks nothing of search engines.
    const app = await renderRoute(`/d/${RIVERA.slug}`);
    await expect.element(app.screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeVisible();
    expect(robots()).toEqual([]);

    for (const { path, title } of PAGES) {
      const { screen, router } = await renderRoute(path);
      await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      // Search engines are asked not to list the page while it is open, a best effort since the app serves one
      // index.html for every address; the tab names the document.
      expect(robots(), path).toEqual(['noindex']);
      expect(document.title, path).toBe(`${title} · Claude Desk`);

      // Leaving for the rest of the app takes the request away.
      await router.navigate('/no/such/page');
      await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
      expect(robots(), `after ${path}`).toEqual([]);
      expect(document.title, `after ${path}`).not.toContain(title);
    }
  });

  it('the_tab_title_follows_each_page', async () => {
    // Every page that names the tab hands it back in the same commit, so from a business's own page through
    // both documents and on, the tab always names the page it is on.
    const before = 'Before · Claude Desk';
    document.title = before;
    const { screen, router } = await renderRoute(`/d/${RIVERA.slug}`);
    await expect.element(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeVisible();
    await expect.poll(() => document.title).toBe('Rivera Plumbing');

    for (const { path, title } of PAGES) {
      await router.navigate(path);
      await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await expect.poll(() => document.title, { message: path }).toBe(`${title} · Claude Desk`);
    }

    await router.navigate('/no/such/page');
    await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    await expect.poll(() => document.title, { message: 'after leaving' }).toBe(before);
  });
});

/** Waits a quarter of a second: a request sent while the page drew has reached the mock API by then. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}
