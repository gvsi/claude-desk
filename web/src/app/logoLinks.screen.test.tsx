import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { OwnerLayout } from '../owner/OwnerLayout.tsx';
import { renderRoute } from '../test/renderRoute.tsx';
import { RouteError } from './RouteError.tsx';
import { OutsideTheCopy } from './NotFound.tsx';
import { routes } from './routes.tsx';

const TODAY = `/app/${RIVERA.deskId}/today`;
const PROFILE = `/app/${RIVERA.deskId}/profile`;
const TODAY_LABEL = 'Claude Desk, go to Today';
const PREVIEW_TODAY_LABEL = 'Claude Desk Preview, go to Today';

/** Start before the app and reach the link using the real browser's Tab order. */
async function tabTo(link: Element) {
  const start = document.createElement('button');
  start.textContent = 'Start keyboard navigation';
  document.body.prepend(start);
  start.focus();
  try {
    for (let step = 0; step < 30 && document.activeElement !== link; step += 1) await userEvent.tab();
    expect(document.activeElement).toBe(link);
    expect(link.matches(':focus-visible')).toBe(true);
    expect(getComputedStyle(link).outlineStyle).toBe('none');
    expect(getComputedStyle(link).boxShadow).toContain('inset');
  } finally {
    start.remove();
  }
}

it('sidebar_lockup_links_to_today_by_keyboard_and_click', async () => {
  const { screen, router } = await renderRoute(PROFILE);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  const logo = screen.getByRole('link', { name: PREVIEW_TODAY_LABEL, exact: true });
  await expect.element(logo).toHaveAttribute('href', TODAY);
  expect(logo.element().textContent).toBe('Claude Desk Preview');
  await expect.element(logo).not.toHaveAttribute('aria-current');
  expect(getComputedStyle(logo.element()).textDecorationLine).toBe('none');
  await tabTo(logo.element());
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => router.state.location.pathname).toBe(TODAY);
  await router.navigate(PROFILE);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  await logo.click();
  await expect.poll(() => router.state.location.pathname).toBe(TODAY);
});

it('phone_mark_links_to_today_by_keyboard_and_click', async () => {
  const { screen, router } = await renderRoute(PROFILE, { viewport: 'phone' });
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  const logo = screen.getByRole('link', { name: TODAY_LABEL, exact: true });
  await expect.element(logo).toHaveAttribute('href', TODAY);
  await tabTo(logo.element());
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => router.state.location.pathname).toBe(TODAY);
  await router.navigate(PROFILE);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  await logo.click();
  await expect.poll(() => router.state.location.pathname).toBe(TODAY);
  await router.navigate(PROFILE);
  await screen.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = screen.getByRole('dialog', { name: 'Menu', exact: true });
  await menu.getByRole('link', { name: PREVIEW_TODAY_LABEL, exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe(TODAY);
  await expect.element(menu).not.toBeInTheDocument();
});

it('about_lockup_links_home_by_keyboard_and_click_at_both_widths', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    const { screen, router } = await renderRoute('/about/proposal', { viewport, seed: { name: 'rivera', signedIn: false } });
    const logo = screen.getByRole('link', { name: viewport === 'desktop' ? 'Claude Desk Preview, home' : 'Claude Desk, home', exact: true });
    await expect.element(logo).toHaveAttribute('href', '/');
    expect(getComputedStyle(logo.element()).textDecorationLine).toBe('none');
    await tabTo(logo.element());
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => router.state.location.pathname).toBe('/');
    await router.navigate('/about/proposal');
    await logo.click();
    await expect.poll(() => router.state.location.pathname).toBe('/');
  }
});

const BROKEN_OWNER = {
  path: '/broken-owner',
  element: <div />,
  hydrateFallbackElement: <div />,
  loader: () => { throw new Error('A page failed'); },
  errorElement: <RouteError />,
};

it('standalone_owner_lockups_link_home_by_keyboard_and_click', async () => {
  for (const path of ['/no/such/page', BROKEN_OWNER.path]) {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen, router } = await renderRoute(path, {
        viewport,
        seed: { name: 'rivera', signedIn: false },
        routes: [...routes, BROKEN_OWNER],
      });
      const logo = screen.getByRole('link', { name: 'Claude Desk, home', exact: true });
      await expect.element(logo).toHaveAttribute('href', '/');
      expect(getComputedStyle(logo.element()).textDecorationLine).toBe('none');
      await tabTo(logo.element());
      await userEvent.keyboard('{Enter}');
      await expect.poll(() => router.state.location.pathname).toBe('/');
      await router.navigate(path);
      await logo.click();
      await expect.poll(() => router.state.location.pathname).toBe('/');
    }
  }
});

it('owner_read_error_lockup_links_to_its_desk_or_home_without_an_id', async () => {
  for (const withDesk of [true, false]) {
    mockStore.inject({ route: 'desks', status: 500, times: 2 });
    const path = withDesk ? PROFILE : '/owner-without-desk';
    const { screen, router } = await renderRoute(path, {
      retryScale: 0,
      routes: withDesk ? routes : [
        { path, element: <OwnerLayout /> },
        { path: '/', element: <h1>Home</h1> },
      ],
    });
    await expect.element(screen.getByRole('alert')).toBeVisible();
    const logo = screen.getByRole('link', { name: withDesk ? TODAY_LABEL : 'Claude Desk, home', exact: true });
    const destination = withDesk ? TODAY : '/';
    await expect.element(logo).toHaveAttribute('href', destination);
    await tabTo(logo.element());
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => router.state.location.pathname).toBe(destination);
  }
});

it('public_footer_and_visitor_error_marks_are_not_links', async () => {
  const publicPage = await renderRoute(`/d/${RIVERA.slug}`);
  await expect.element(publicPage.screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeVisible();
  const poweredBy = publicPage.screen.getByText('Powered by', { exact: false }).element();
  expect(poweredBy.closest('a')).toBeNull();
  expect(poweredBy.closest('.cd-concept-footer__powered')?.querySelector('a')).toBeNull();
  expect(poweredBy.closest('.cd-concept-footer__powered')?.querySelector('.cd-mark')).not.toBeNull();

  for (const [path, error] of [
    [`/d/${RIVERA.slug}`, new Error('A public page failed')],
    ['/pay/example', new Error('A checkout failed')],
    [`/d/${RIVERA.slug}`, new OutsideTheCopy()],
  ] as const) {
    const { screen } = await renderRoute(path, {
      routes: [{ path, element: <div />, hydrateFallbackElement: <div />, loader: () => { throw error; }, errorElement: <RouteError visitor /> }],
    });
    await expect.element(screen.getByRole('main')).toBeVisible();
    const brand = screen.container.querySelector('.cd-standalone-page__brand')!;
    expect(brand.querySelector('.cd-mark')).not.toBeNull();
    expect(brand.closest('a')).toBeNull();
    expect(brand.querySelector('a')).toBeNull();
    await expect.element(screen.getByRole('link', { name: 'Claude Desk, home' })).not.toBeInTheDocument();
  }
});
