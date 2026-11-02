import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

it.each(['desktop', 'phone'] as const)('profile_is_a_main_page_%s', async (viewport) => {
  const path = `/app/${RIVERA.deskId}/profile`;
  const { screen } = await renderRoute(path, { viewport });
  const main = screen.getByRole('main');
  await expect.element(main.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  await expect.element(main.getByText('How customers see your business.', { exact: true })).toBeVisible();
  await expect.element(main.getByRole('region', { name: 'Your business' })).toBeVisible();
  await expect.element(main.getByRole('region', { name: 'Header colour', exact: true })).toBeVisible();
  expect(document.title).toBe('Profile · Claude Desk');
  if (viewport === 'phone') await screen.getByRole('button', { name: 'Menu', exact: true }).click();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  expect([...nav.element().querySelectorAll('.cd-sidebar__label')].map((row) => row.textContent)).toEqual([
    'Today',
    'Conversations',
    'Customers',
    'Knowledge',
    'Rules',
    'Safety',
    'Profile',
    'Share',
    'Settings',
  ]);
  const link = nav.getByRole('link', { name: 'Profile', exact: true });
  await expect.element(link).toHaveAttribute('href', path);
  await expect.element(link).toHaveAttribute('aria-current', 'page');
  expect(link.element().querySelector('svg path')?.getAttribute('d')).toBe('m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7');
});

it('general_keeps_only_acting_and_delete', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/settings/general`);
  const main = screen.getByRole('main');
  await expect.element(main.getByRole('region', { name: 'Claude acts for you' })).toBeVisible();
  await expect.element(main.getByRole('region', { name: 'Delete this Desk' })).toBeVisible();
  expect(main.getByRole('region', { name: 'Your business' }).query()).toBeNull();
  expect(main.getByRole('region', { name: 'Header colour', exact: true }).query()).toBeNull();
});
