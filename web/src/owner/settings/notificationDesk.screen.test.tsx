import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../../test/screen.ts';

it.each(['desktop', 'phone'] as const)('notifications name a plumber only on the starting sample Desk on %s', async (viewport) => {
  const starting = await renderRoute(`/app/${RIVERA.deskId}/settings/notifications`, { viewport, pollScale: 100 });
  await expect.element(starting.screen.getByRole('heading', { name: 'Set for a plumber', exact: true })).toBeVisible();
  await expect.element(starting.screen.getByText('From your business type', { exact: true })).toBeVisible();
  expectNoHorizontalScroll();

  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const { screen } = await renderRoute(`/app/${salon.deskId}/settings/notifications`, { viewport, pollScale: 100 });
  await expect.element(screen.getByText('From your business type', { exact: true })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Set for a plumber', exact: true }).query()).toBeNull();
  await expect.element(screen.getByRole('region', { name: 'From your business type', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('list', { name: 'From your business type', exact: true })).toBeVisible();
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('deleting the starting Desk and reloading keeps plumber words off the salon on %s', async (viewport) => {
  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const starting = await renderRoute(`/app/${RIVERA.deskId}/settings/general`, { viewport, pollScale: 100 });
  await starting.screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  await starting.screen.getByRole('dialog').getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => starting.router.state.location.pathname).toBe(`/app/${salon.deskId}/today`);
  expect(mockStore.world.desk(RIVERA.deskId)).toBeUndefined();

  const { screen } = await renderRoute(`/app/${salon.deskId}/settings/notifications`, { viewport, pollScale: 100 });
  await expect.element(screen.getByRole('region', { name: 'From your business type', exact: true })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Set for a plumber', exact: true }).query()).toBeNull();
  expect(screen.getByRole('list', { name: 'From your business type', exact: true }).getByRole('listitem').elements()).toHaveLength(3);
  expectNoHorizontalScroll();
});
