import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { settled } from '../../ds/test/settled.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

it.each(['desktop', 'phone'] as const)('github_row_opens_the_repository_%s', async (viewport) => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/profile`, { viewport });
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  if (viewport === 'phone') await screen.getByRole('button', { name: 'Menu', exact: true }).click();
  const group = screen.getByRole('navigation', { name: 'About this prototype' });
  const link = group.getByRole('link', { name: 'GitHub (opens in a new tab)', exact: true });
  await expect.element(link).toBeVisible();
  await expect.element(link).toHaveTextContent('GitHub');
  await expect.element(link).toHaveAttribute('href', 'https://github.com/gvsi/claude-desk');
  await expect.element(link).toHaveAttribute('target', '_blank');
  await expect.element(link).toHaveAttribute('rel', 'noreferrer');
  expect(
    group
      .getByRole('link')
      .elements()
      .map((row) => row.textContent),
  ).toEqual(['Capability prediction', 'Product proposal', 'Vision', 'GitHub']);
  expect(link.element().querySelectorAll('svg path')).toHaveLength(2);
});

it('business_switcher_border_and_hover_keep_words_in_place', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/profile`);
  const row = screen.getByRole('button', { name: 'Switch business, current: Turner Plumbing' });
  await expect.element(row).toBeVisible();
  const el = row.element();
  const style = getComputedStyle(el);
  expect(style.borderTopWidth).toBe('1px');
  expect(style.borderTopColor).toBe('rgba(250, 249, 245, 0.22)');
  expect(style.borderRadius).toBe('8px');
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(style.height).toBe('36px');
  const words = el.querySelector('span')!;
  const before = words.getBoundingClientRect();
  expect(before.left - el.getBoundingClientRect().left).toBe(8);
  await userEvent.hover(row);
  await settled(el);
  expect(getComputedStyle(el).backgroundColor).toBe('rgba(250, 249, 245, 0.06)');
  expect(getComputedStyle(el).borderTopColor).toBe(style.borderTopColor);
  const after = words.getBoundingClientRect();
  expect([after.left, after.top]).toEqual([before.left, before.top]);
});
