import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';

import { ROUTES } from '../../api/routes.ts';
import { worker } from '../../mocks/browser.ts';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

it.each([0, 1, 2])('deleting_a_business_only_desk_chooses_a_destination_with_%i_other_businesses', async (remaining) => {
  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  if (remaining === 0) {
    expect(await mockStore.dispatch('deleteDesk', { params: { desk_id: RIVERA.deskId } })).toMatchObject({ status: 204 });
  } else if (remaining === 2) {
    await liveSetupDeskIds('A hair salon in Oakland');
  }
  const { screen, router } = await renderRoute(`/app/${salon.deskId}/settings/general`, { pollScale: 100 });
  await screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  await screen.getByRole('dialog').getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe(remaining === 0 ? '/app/setup' : `/app/${RIVERA.deskId}/today`);
  expect(router.state.historyAction).toBe('REPLACE');
  expect(mockStore.world.desk(salon.deskId)).toBeUndefined();
  expect(mockStore.requests.filter(({ key, path }) => key === 'deleteDesk' && path.includes(salon.deskId))).toHaveLength(1);
  if (remaining === 0) {
    await expect.element(screen.getByRole('heading', { name: 'Tell me about your business', exact: true })).toBeVisible();
  } else {
    await expect.element(screen.getByRole('link', { name: 'Today', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Tell me about your business', exact: true }).query()).toBeNull();
  }
});

it.each([false, true])('deleting_the_only_desk_removes_its_business_when_desks_reads_fail_%s', async (failReads) => {
  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const { screen, router } = await renderRoute(`/app/${salon.deskId}/settings/general`, { pollScale: 100, retryScale: 0 });
  await screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  let failedReads = 0;
  if (failReads) worker.use(http.get(ROUTES.desks.path, () => {
    failedReads += 1;
    return new HttpResponse(null, { status: 503 });
  }));
  await screen.getByRole('dialog').getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/today`);
  await screen.getByRole('button', { name: 'Switch business, current: Turner Plumbing', exact: true }).click();
  const menu = screen.getByRole('menu', { name: 'Switch business', exact: true });
  await expect.element(menu).toBeVisible();
  if (failReads) await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect.poll(() => menu.getByRole('menuitemradio').elements()).toHaveLength(1);
  await expect.element(menu.getByRole('menuitemradio', { name: 'Turner Plumbing 1 Desk', exact: true })).toBeVisible();
  expect(menu.getByText('A hair salon in Oakland', { exact: true }).query()).toBeNull();
});
