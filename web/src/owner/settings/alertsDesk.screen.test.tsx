import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../../test/screen.ts';

it.each(['desktop', 'phone'] as const)('alerts name a plumber only for the sample business on %s', async (viewport) => {
  const starting = await renderRoute(`/app/${RIVERA.deskId}/settings/alerts`, { viewport, pollScale: 100 });
  await expect.element(starting.screen.getByRole('heading', { name: 'Set for a plumber', exact: true })).toBeVisible();
  await expect.element(starting.screen.getByText('From your business type', { exact: true })).toBeVisible();
  // Right away names emergencies for a plumber only: a salon has none.
  const rightAway = (list: Element) => list.querySelector('.cd-alert-list__what')?.textContent;
  expect(rightAway(starting.screen.getByRole('list', { name: 'Set for a plumber', exact: true }).element())).toBe('Held requests, paused chats and emergencies');
  expectNoHorizontalScroll();

  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const { screen } = await renderRoute(`/app/${salon.deskId}/settings/alerts`, { viewport, pollScale: 100 });
  await expect.element(screen.getByText('From your business type', { exact: true })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Set for a plumber', exact: true }).query()).toBeNull();
  await expect.element(screen.getByRole('region', { name: 'From your business type', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('list', { name: 'From your business type', exact: true })).toBeVisible();
  expect(rightAway(screen.getByRole('list', { name: 'From your business type', exact: true }).element())).toBe('Held requests and paused chats');
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('every sample-business Desk keeps the plumber heading after deleting the starting Desk and reloading on %s', async (viewport) => {
  const first = mockStore.world.desk(RIVERA.deskId)!;
  const second = mockStore.world.addDesk({
    desk_id: 'second-plumbing-desk', slug: 'second-plumbing-desk', name: 'Second line',
    hours: first.summary.hours, openStatus: first.openStatus,
  });
  const secondPath = `/app/${second.summary.desk_id}/settings/alerts`;
  const another = await renderRoute(secondPath, { viewport, pollScale: 100 });
  await expect.element(another.screen.getByRole('heading', { name: 'Set for a plumber', exact: true })).toBeVisible();

  const starting = await renderRoute(`/app/${RIVERA.deskId}/settings/general`, { viewport, pollScale: 100 });
  await starting.screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  await starting.screen.getByRole('dialog').getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => starting.router.state.location.pathname).toBe(`/app/${second.summary.desk_id}/today`);
  expect(mockStore.world.desk(RIVERA.deskId)).toBeUndefined();

  const { screen } = await renderRoute(secondPath, { viewport, pollScale: 100 });
  await expect.element(screen.getByRole('region', { name: 'Set for a plumber', exact: true })).toBeVisible();
  expect(screen.getByRole('list', { name: 'Set for a plumber', exact: true }).getByRole('listitem').elements()).toHaveLength(3);
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('deleting the starting Desk and reloading keeps plumber words off the salon on %s', async (viewport) => {
  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const starting = await renderRoute(`/app/${RIVERA.deskId}/settings/general`, { viewport, pollScale: 100 });
  await starting.screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  await starting.screen.getByRole('dialog').getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => starting.router.state.location.pathname).toBe(`/app/${salon.deskId}/today`);
  expect(mockStore.world.desk(RIVERA.deskId)).toBeUndefined();

  const { screen } = await renderRoute(`/app/${salon.deskId}/settings/alerts`, { viewport, pollScale: 100 });
  await expect.element(screen.getByRole('region', { name: 'From your business type', exact: true })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Set for a plumber', exact: true }).query()).toBeNull();
  expect(screen.getByRole('list', { name: 'From your business type', exact: true }).getByRole('listitem').elements()).toHaveLength(3);
  expectNoHorizontalScroll();
});

it('an old link to Settings › Notifications opens Alerts', async () => {
  const { screen, router } = await renderRoute(`/app/${RIVERA.deskId}/settings/notifications`, { pollScale: 100 });
  await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/settings/alerts`);
  await expect.element(screen.getByRole('heading', { name: 'Set for a plumber', exact: true })).toBeVisible();
});
