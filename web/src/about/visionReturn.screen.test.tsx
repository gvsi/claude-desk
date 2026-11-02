import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { renderRoute } from '../test/renderRoute.tsx';
import { nextFrames } from '../test/screen.ts';

it.each(['desktop', 'phone'] as const)('returning from Product proposal does not refocus a spent Vision card on %s', async (viewport) => {
  const { screen, router } = await renderRoute('/about/vision', { viewport, strict: true });
  await expect.element(screen.getByRole('heading', { name: 'See each one up close', exact: true })).toBeVisible();
  const opener = () => screen.container.querySelector<HTMLAnchorElement>('a.va-card[href="/vision/city-office"]')!;
  opener().focus();
  await userEvent.keyboard('{Enter}');
  await screen.getByRole('link', { name: 'Back to Vision', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
  await expect.poll(() => document.activeElement?.getAttribute('href')).toBe('/vision/city-office');
  await screen.getByRole('link', { name: 'Product proposal', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe('/about/proposal');
  await router.navigate(-1);
  await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
  await expect.element(screen.getByRole('heading', { name: 'See each one up close', exact: true })).toBeVisible();
  await nextFrames();
  expect(document.activeElement).not.toBe(opener());
});

it.each(['desktop', 'phone'] as const)('Back to Vision after a reload lands at the cards and focuses the opener on %s', async (viewport) => {
  const original = await renderRoute('/about/vision', { viewport, strict: true });
  await expect.element(original.screen.getByRole('heading', { name: 'See each one up close', exact: true })).toBeVisible();
  const articleEntry = original.router.state.location;
  const card = original.screen.container.querySelector<HTMLAnchorElement>('a.va-card[href="/vision/city-office"]')!;
  card.focus();
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => original.router.state.location.pathname).toBe('/vision/city-office');
  const pageEntry = original.router.state.location;

  const { screen, router } = await renderRoute(pageEntry.pathname, { viewport, strict: true, initialEntries: [articleEntry, pageEntry] });
  await screen.getByRole('link', { name: 'Back to Vision', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
  expect(router.state.location.hash).toBe('#vision-pages');
  const cards = () => document.getElementById('vision-pages')!;
  await expect.poll(() => Math.abs(cards().getBoundingClientRect().top - parseFloat(getComputedStyle(cards()).scrollMarginTop))).toBeLessThanOrEqual(1);
  await expect.element(screen.container.querySelector<HTMLAnchorElement>('a.va-card[href="/vision/city-office"]')!).toHaveFocus();
});

it.each(['browser Back', 'Back to Vision'] as const)('%s restores the Vision card and scroll at 1440 by 900', async (back) => {
  const { screen, router } = await renderRoute('/about/vision', { viewport: 'desktop', strict: true });
  await expect.element(screen.getByRole('heading', { name: 'A front desk that never closes', exact: true })).toBeVisible();
  await document.fonts.ready;
  const opener = () => screen.container.querySelector<HTMLAnchorElement>('a.va-card[href="/vision/city-office"]')!;
  opener().focus();
  await nextFrames();
  const top = window.scrollY;
  expect(top).toBeGreaterThan(0);
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => router.state.location.pathname).toBe('/vision/city-office');
  const link = screen.getByRole('link', { name: 'Back to Vision', exact: true });
  await expect.element(link).toBeVisible();
  if (back === 'browser Back') await router.navigate(-1);
  else {
    link.element().focus();
    await userEvent.keyboard('{Enter}');
  }
  await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
  await expect.poll(() => window.scrollY).toBe(top);
  await expect.element(opener()).toHaveFocus();
  await userEvent.tab();
  expect(window.scrollY).toBe(top);
});

it.each(['direct link', 'unrelated previous page'] as const)('Back to Vision opens the cards from a %s at 1440 by 900', async (entry) => {
  const { screen, router } = await renderRoute(entry === 'direct link' ? '/vision/city-office' : '/about/proposal', { viewport: 'desktop', strict: true });
  if (entry === 'unrelated previous page') await router.navigate('/vision/city-office');
  const back = screen.getByRole('link', { name: 'Back to Vision', exact: true });
  await expect.element(back).toBeVisible();
  await expect.element(back).toHaveAttribute('href', '/about/vision#vision-pages');
  await back.click();
  await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
  expect(router.state.location.hash).toBe('#vision-pages');
  const cards = () => document.getElementById('vision-pages')!;
  await expect.element(screen.getByRole('heading', { name: 'See each one up close', exact: true })).toBeVisible();
  await expect.poll(() => Math.abs(cards().getBoundingClientRect().top - parseFloat(getComputedStyle(cards()).scrollMarginTop))).toBeLessThanOrEqual(1);
  expect(window.scrollY).toBeGreaterThan(0);
});
