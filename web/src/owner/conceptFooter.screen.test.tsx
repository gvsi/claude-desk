import { expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { CONCEPT_FOOTER_TEXT } from '../ds/test/copy.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

it('today_desktop_places_one_concept_footer_under_the_sidebar_about_links', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`);
  await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
  const sidebar = screen.getByRole('complementary', { name: 'Claude Desk', exact: true });
  const footer = sidebar.getByText(CONCEPT_FOOTER_TEXT, { exact: true });
  await expect.element(footer).toBeVisible();
  await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
  expect(screen.container.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);
  const about = sidebar.getByRole('navigation', { name: 'About this prototype' }).element();
  const answering = sidebar.getByRole('switch', { name: 'Claude acts for you' }).element();
  const box = footer.element().getBoundingClientRect();
  expect(box.top).toBeGreaterThanOrEqual(about.getBoundingClientRect().bottom);
  expect(box.bottom).toBeLessThanOrEqual(answering.getBoundingClientRect().top);
  expect(screen.getByRole('main').element().querySelector('[data-ds="concept-footer"]')).toBeNull();
  await expect.element(sidebar.getByRole('link', { name: 'Giovanni Alcantara', exact: true })).toHaveAttribute('target', '_blank');
  expectNoHorizontalScroll();
});

it('conversations_desktop_places_one_concept_footer_in_the_sidebar', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/conversations`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations', exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
  const sidebar = screen.getByRole('complementary', { name: 'Claude Desk', exact: true });
  await expect.element(sidebar.getByText(CONCEPT_FOOTER_TEXT, { exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);
  expect(screen.getByRole('main').element().querySelector('[data-ds="concept-footer"]')).toBeNull();
  expectNoHorizontalScroll();
});

it('phone_today_and_conversations_keep_one_footer_at_the_bottom_and_none_in_the_drawer', async () => {
  for (const route of ['today', 'conversations']) {
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/${route}`, { viewport: 'phone' });
    expect([window.innerWidth, window.innerHeight]).toEqual([390, 844]);
    if (route === 'today') {
      // The reference board has one laptop story; check Things to try's phone footer in the app.
      const things = screen.getByRole('region', { name: 'Things to try', exact: true });
      await expect.element(things.getByRole('heading', { level: 3, name: 'Watch a demo visitor', exact: true })).toBeVisible();
    }
    const main = screen.getByRole('main');
    const footer = main.getByText(CONCEPT_FOOTER_TEXT, { exact: true });
    await expect.element(footer).toBeVisible();
    await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
    expect(screen.container.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);
    expect(footer.element().closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(footer.element().contains(main.getByRole('link', { name: 'Giovanni Alcantara', exact: true }).element())).toBe(true);
    const pageFooter = footer.element().closest('footer');
    if (!pageFooter) throw new Error('the phone concept line sits in the page footer');
    expect(pageFooter.parentElement?.lastElementChild).toBe(pageFooter);
    await screen.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = screen.getByRole('dialog', { name: 'Menu', exact: true });
    await expect.element(drawer).toBeVisible();
    expect(drawer.element().querySelector('[data-ds="concept-footer"]')).toBeNull();
    expect(screen.container.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('link', { name: 'Giovanni Alcantara', exact: true })).toBeVisible();
    footer.element().scrollIntoView({ block: 'end' });
    await expect.element(footer).toBeInViewport({ ratio: 1 });
    expectNoHorizontalScroll();
  }
});

it('the_owner_read_error_keeps_its_footer_without_a_sidebar', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    mockStore.inject({ route: 'desks', status: 500, times: 2 });
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`, { viewport, retryScale: 0 });
    await expect.element(screen.getByRole('alert')).toBeVisible();
    await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
    await expect.element(screen.getByText(CONCEPT_FOOTER_TEXT, { exact: true })).toBeVisible();
    expect(screen.container.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);
    expect(screen.container.querySelector('.cd-owner-state > footer [data-ds="concept-footer"]')).not.toBeNull();
    expect(screen.container.querySelector('.cd-sidebar')).toBeNull();
  }
});

it('the_footer_follows_the_existing_shell_breakpoint_without_a_duplicate', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`);
  await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
  await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
  for (const width of [767, 768, 390, 1440]) {
    await page.viewport(width, 900);
    await expect.poll(() => screen.container.querySelector('.cd-app-shell--compact') !== null).toBe(width < 768);
    expect(screen.container.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);
    expect(screen.getByRole('main').element().querySelector('[data-ds="concept-footer"]') !== null).toBe(width < 768);
    expectNoHorizontalScroll();
  }
});
