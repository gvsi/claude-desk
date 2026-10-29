/**
 * The app shell in a browser: an unknown path gets a kind page with a way back, and an ended owner
 * session goes back to the passcode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { request } from '../api/http.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

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

  it('owner_401_replaces_the_page_with_the_passcode', async () => {
    const { router } = await renderRoute('/app/d1/today');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await expect(request('today', { params: { desk_id: 'd1' } })).rejects.toMatchObject({ kind: 'unauthorized' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(router.state.location.state).toEqual({ ended: false });
    // Back must not return to the ended page, which would only answer 401 again.
    expect(router.state.historyAction).toBe('REPLACE');
  });
});
