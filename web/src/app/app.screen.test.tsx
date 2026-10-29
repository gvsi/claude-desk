/** The app shell in a browser: an unknown path gets a kind page with a way back. */
import { describe, expect, it } from 'vitest';

import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

describe('App', () => {
  it('unknown_route_is_kind', async () => {
    const { screen } = await renderRoute('/no/such/page');
    const main = screen.getByRole('main', { name: "This page doesn't exist" });
    await expect.element(main).toBeVisible();
    await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Check the link, or start again from the home page.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'start again from the home page' })).toHaveAttribute('href', '/');
    await expectScreenBasics(screen.container, { owner: false });

    const phone = await renderRoute('/no/such/page', { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('main')).toBeVisible();
    expectNoHorizontalScroll();
  });
});
