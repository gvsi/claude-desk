/**
 * The app shell in a browser: an unknown path gets a kind page with a way back, a page that breaks
 * while it draws gets the design system's error line and nothing of the error, and an ended owner
 * session goes back to the intro dialog's passcode.
 */
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { request } from '../api/http.ts';
import { UNREACHABLE_COPY } from '../ds/index.ts';
import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { routes } from './routes.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App', () => {
  it('unknown_route_is_kind', async () => {
    const { screen } = await renderRoute('/no/such/page');
    const main = screen.getByRole('main', { name: "This page doesn't exist" });
    await expect.element(main).toBeVisible();
    await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Check the link, or start again from the home page.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'start again from the home page' })).toHaveAttribute('href', '/');
    // Owners land here too, for an ID outside their copy, so the owner jargon check applies.
    await expectScreenBasics(screen.container, { owner: true });

    const phone = await renderRoute('/no/such/page', { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('main')).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('page_error_is_kind', async () => {
    // React reports the error on the console, as it should; only the page must not show it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pages = [
      { name: 'the intro', path: '/', routes: throwingAt('/'), owner: true },
      { name: 'an owner page', path: `/app/${RIVERA.deskId}/today`, routes: throwingAt('/app/:deskId', 'today'), owner: true },
      { name: 'the public page', path: `/d/${RIVERA.slug}`, routes: throwingAt('/d/:slug'), owner: false },
    ];
    for (const { name, path, routes: broken, owner } of pages) {
      thrown = 0;
      const { screen } = await renderRoute(path, { routes: broken });
      await expect.element(screen.getByText(UNREACHABLE_COPY.en, { exact: true }), { message: name }).toBeVisible();
      // The page did throw: this is the error's page, not a failed read's line inside a working page.
      expect(thrown, name).toBeGreaterThan(0);
      await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
      expectNoErrorDetail(name);
      await expectScreenBasics(screen.container, { owner });
    }

    // A visitor reads it in their own language, at a phone's width too, and the whole document is
    // in that language while it shows (index.html sets English; the test browser's page has its own).
    document.documentElement.lang = 'en';
    thrown = 0;
    const es = await renderRoute(`/d/${RIVERA.slug}`, { routes: throwingAt('/d/:slug'), language: 'es-MX', viewport: 'phone' });
    await expect.element(es.screen.getByText(UNREACHABLE_COPY.es, { exact: true })).toBeVisible();
    expect(thrown).toBeGreaterThan(0);
    await expect.element(es.screen.getByRole('button', { name: 'Intentar de nuevo' })).toBeVisible();
    expectNoErrorDetail('the public page in Spanish');
    await expectScreenBasics(es.screen.container, { owner: false });
    expectNoHorizontalScroll();
    expect(document.documentElement.lang).toBe('es');
    // Leaving the page hands the document its language back.
    await es.router.navigate('/no/such/page');
    await expect.element(es.screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    expect(document.documentElement.lang).toBe('en');
  });

  it('owner_401_replaces_the_page_with_the_passcode', async () => {
    // Signed out, so whatever the owner page asks for on its way in is a 401 too, never a success.
    const { router } = await renderRoute('/app/d1/today', { seed: { name: 'rivera', signedIn: false } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await expect(request('today', { params: { desk_id: 'd1' } })).rejects.toMatchObject({ kind: 'unauthorized' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(router.state.location.state).toEqual({ ended: false });
    // Back must not return to the ended page, which would only answer 401 again.
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

/** What the broken page's error says. None of it may reach the screen. */
const THROWN = 'Cannot read properties of undefined (reading this_week)';

/** How many times `ThrowingPage` has thrown. */
let thrown = 0;

/** A page that throws while it draws, as one does when a read no longer matches its type. */
function ThrowingPage(): never {
  thrown += 1;
  throw new TypeError(THROWN);
}

/**
 * The app's routes with the page at `path` swapped for `ThrowingPage`, or with its child page at
 * `child` swapped, so that the error rises from inside the owner layout.
 */
function throwingAt(path: string, child?: string): RouteObject[] {
  return routes.map((route) => {
    if (route.path !== path || route.index === true) return route;
    if (child === undefined) return { ...route, element: <ThrowingPage /> };
    return { ...route, children: route.children?.map((page) => (page.path === child ? { ...page, element: <ThrowingPage /> } : page)) };
  });
}

/** Nothing of the error is on the screen: not its message, its type, its stack or the router's own error page. */
function expectNoErrorDetail(where: string): void {
  const text = document.body.textContent ?? '';
  expect(text, where).not.toContain(THROWN);
  expect(text, where).not.toContain('TypeError');
  expect(text, where).not.toContain('ThrowingPage');
  // A stack frame: "at ThrowingPage (http://…/app.screen.test.tsx:80:9)".
  expect(text, where).not.toMatch(/\bat \S+ \(|\.tsx?:\d+:\d+/);
  expect(text, where).not.toContain('Unexpected Application Error');
}
