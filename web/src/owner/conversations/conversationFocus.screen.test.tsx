import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { coarsePointer } from '../../ds/test/touch.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { nextFrames } from '../../test/screen.ts';

const LIST = `/app/${RIVERA.deskId}/conversations`;

it('a_phone_chat_focuses_its_heading_after_retrying_its_first_failed_read', async () => {
  await coarsePointer();
  mockStore.world.sessions.get('ses-dana-web')!.displayName = 'Dana Whitfield';
  mockStore.inject({ route: 'conversation', status: 500, times: 2 });
  const { screen } = await renderRoute(LIST, { viewport: 'phone', pollScale: 100, retryScale: 0 });
  const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Dana Whitfield/ });
  await row.click();
  const retry = screen.getByRole('button', { name: 'Try again', exact: true });
  await expect.element(retry).toBeVisible();
  await retry.click();
  await expect.element(screen.getByRole('heading', { level: 2, name: 'Dana Whitfield' })).toHaveFocus();
  expect(document.activeElement?.matches(':focus-visible')).toBe(false);
});

it('desktop_chat_keeps_focus_on_the_list_row', async () => {
  mockStore.world.sessions.get('ses-dana-web')!.displayName = 'Dana Whitfield';
  const { screen, router } = await renderRoute(LIST);
  const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Dana Whitfield/ });
  await expect.element(row).toBeVisible();
  row.element().focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('heading', { level: 2, name: 'Dana Whitfield' })).toBeVisible();
  await nextFrames();
  await expect.element(row).toHaveFocus();
  await router.navigate(-1);
  await expect.element(row).toHaveFocus();
});

it('touch_opens_the_phone_chat_at_its_heading_without_focusing_a_text_box', async () => {
  await coarsePointer();
  mockStore.world.sessions.get('ses-dana-web')!.displayName = 'Dana Whitfield';
  const { screen } = await renderRoute(LIST, { viewport: 'phone' });
  const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Dana Whitfield/ });
  await row.click();
  await expect.element(screen.getByRole('heading', { level: 2, name: 'Dana Whitfield' })).toHaveFocus();
  await screen.getByRole('link', { name: 'All conversations', exact: true }).click();
  await expect.element(row).toHaveFocus();
});

it.each(['All conversations', 'browser Back'] as const)('phone_chat_hands_focus_to_its_heading_and_back_to_its_row_through_%s', async (back) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  for (let i = 0; i < 12; i += 1) mockStore.world.addSession(desk);
  const chat = mockStore.world.sessions.get('ses-dana-web')!;
  chat.displayName = 'Dana Whitfield';
  const { screen, router } = await renderRoute(LIST, { viewport: 'phone', pollScale: 100 });
  const list = screen.getByRole('navigation', { name: 'Conversations' });
  const row = list.getByRole('link', { name: /^Dana Whitfield/ });
  await expect.element(row).toBeVisible();
  row.element().focus();
  await nextFrames();
  const top = list.element().scrollTop;
  expect(top).toBeGreaterThan(0);
  await userEvent.keyboard('{Enter}');
  const heading = screen.getByRole('heading', { level: 2, name: 'Dana Whitfield' });
  await expect.element(heading).toBeVisible();
  await expect.element(heading).toHaveFocus();
  await expect.element(heading).toBeInViewport({ ratio: 1 });
  if (back === 'browser Back') await router.navigate(-1);
  else {
    const all = screen.getByRole('link', { name: 'All conversations', exact: true });
    all.element().focus();
    await userEvent.keyboard('{Enter}');
  }
  await expect.element(row).toHaveFocus();
  expect(list.element().scrollTop).toBe(top);
  await userEvent.tab();
  expect(list.element().contains(document.activeElement)).toBe(true);
});
