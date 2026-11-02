import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

it.each(['desktop', 'phone'] as const)('empty knowledge keeps the page header gap at 24 px on %s', async (viewport) => {
  const starting = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport, pollScale: 100 });
  await expect.element(starting.screen.getByText('Maintenance plan.pdf', { exact: true })).toBeVisible();
  const subtitleBottom = () => document.querySelector('.cd-page-header__subtitle')!.getBoundingClientRect().bottom;
  const firstTop = () => document.querySelector('.cd-knowledge__known')!.getBoundingClientRect().top;
  expect(firstTop() - subtitleBottom()).toBe(24);

  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const { screen } = await renderRoute(`/app/${salon.deskId}/knowledge`, { viewport, pollScale: 100 });
  await expect.element(screen.getByRole('textbox', { name: 'A website', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('status', { name: 'Loading what I know', exact: true })).not.toBeInTheDocument();
  const gap = () => document.querySelector(viewport === 'desktop' ? '.cd-knowledge__previews' : '.cd-knowledge__add')!.getBoundingClientRect().top - subtitleBottom();
  expect(gap()).toBe(24);
  await screen.getByRole('button', { name: 'Add a note', exact: true }).click();
  await expect.element(screen.getByText('Write the note first, then add it.', { exact: true })).toBeVisible();
  expect(gap()).toBe(24);
});
