import { beforeAll, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { ROUTES } from '../api/routes.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { Skeleton, SkeletonScreen } from '../ds/index.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { mockStore } from '../mocks/store.ts';
import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectSkeletonLoad, expectSkeletonStill, type SkeletonAnchor } from '../test/skeleton.ts';
import { expectScreenBasics, expectNoHorizontalScroll, expectNoWindowScroll } from '../test/screen.ts';
import { watchTop } from '../test/watch.ts';
import { holdReads } from '../test/holdReads.ts';

beforeAll(loadWebFonts);

const TODAY = `/app/${RIVERA.deskId}/today`;

it('today_reload_after_the_held_request_is_answered', async () => {
  const held = [...mockStore.world.decisions.values()].find((item) => item.decision.reason_plain === rivera.decisions.held.reason_plain)!;
  await mockStore.dispatch('answer', { params: { decision_id: held.decision.decision_id }, body: { answer: 'deny_once' } });
  const desks = holdReads(ROUTES.desks.path);
  const { screen } = await renderRoute(TODAY, { pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  expect(document.querySelector('[data-skeleton-anchor="needs-title"]')).not.toBeNull();
  const tops = watchTop(
    () =>
      document.querySelector('[data-skeleton-anchor="since-title"]') ??
      document.querySelector('.cd-today__main > .cd-today__section:last-child .cd-section-header__heading'),
  );
  desks.release();
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Needs you', exact: true }).elements()).toHaveLength(0);
  expect(tops()).toHaveLength(2);
  expect(tops()[1]).toBeLessThan(tops()[0]!);
});

it('reload_with_two_desks_moves_once', async () => {
  const desks = holdReads(ROUTES.desks.path);
  const { screen } = await renderRoute(TODAY, { seed: 'rivera_two_desks', pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  const main = document.querySelector('main');
  expect(main, 'the loading page keeps its main landmark').not.toBeNull();
  expect(main!.querySelector('h1')?.textContent).toBe('Claude Desk');
  expect(main!.querySelector('h1')?.closest('.cd-skeleton-screen__layer')).toBeNull();
  const tops = watchTop(
    () => document.querySelector('[data-skeleton-anchor="page-row-0"]') ?? document.querySelector('.cd-sidebar__nav > a'),
  );
  desks.release();
  await expect.element(screen.getByRole('button', { name: 'Switch Desk, current: Main line' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(tops()).toHaveLength(2);
  expect(tops()[1]! - tops()[0]!).toBe(40);
});

it('reload_waits_for_the_demo_inbox', async () => {
  const inbox = holdReads(ROUTES.ownerInbox.path);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: [...WIDE_ANCHORS, ...TODAY_ANCHORS],
    open: async () => {
      await renderRoute(TODAY, { pollScale: 100 });
      await vi.waitFor(() => expect(inbox.held()).toBe(1));
    },
    release: inbox.release,
  });
  expect(document.body.textContent).not.toContain('Opening your Demo inbox');
  expect(mockStore.requests.filter(({ key }) => key === 'ownerInbox')).toHaveLength(1);
});

const TODAY_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'owner-footer', page: '.cd-owner-layout__footer', size: true },
  { name: 'greeting', page: '.cd-greeting__title' },
  { name: 'link-pill', page: '.cd-greeting__link', dimensions: ['height'] },
  { name: 'things-title', page: '.cd-things__title' },
  { name: 'things-card', page: '.cd-things > .cd-card', size: true },
  { name: 'thing-tile-0', page: '.cd-things__item:first-child .cd-things__icon' },
  { name: 'thing-tile-3', page: '.cd-things__item:last-child .cd-things__icon' },
  { name: 'needs-title', page: '.cd-today__section[tabindex] .cd-section-header__heading' },
  { name: 'held-card', page: '.cd-needs-you .cd-card', dimensions: ['width'] },
  { name: 'live-row', page: '.cd-live .cd-conversation-item', size: true },
  { name: 'since-title', page: '.cd-today__main > .cd-today__section:last-child .cd-section-header__heading' },
  { name: 'public-card', page: '.cd-today-aside > .cd-card:first-child', size: true },
  { name: 'week-title', page: '.cd-week__heading' },
  { name: 'week-bar-0', page: '.cd-week__bar' },
];
const WIDE_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'reviewer-bar', page: '.cd-reviewer-bar', size: true },
  { name: 'sidebar-mark', page: '.cd-sidebar__brand .cd-mark' },
  { name: 'business-row', page: '.cd-sidebar__business' },
  { name: 'page-row-0', page: '.cd-sidebar__nav > a:first-child' },
  { name: 'page-row-6', page: '.cd-sidebar__nav > a:last-child' },
  { name: 'owner-avatar', page: '.cd-sidebar__avatar' },
];
const PHONE_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'reviewer-bar', page: '.cd-reviewer-bar', size: true },
  { name: 'top-bar', page: '.cd-app-shell__topbar', size: true },
  { name: 'top-mark', page: '.cd-app-shell__topbar .cd-mark' },
  { name: 'menu', page: '.cd-app-shell__menu' },
];

it('reload_opens_on_the_frames_shape at 1440', async () => {
  const reads = [
    ROUTES.desks.path,
    ROUTES.today.path.replace('{desk_id}', RIVERA.deskId),
    ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId),
  ].map(holdReads);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: [...WIDE_ANCHORS, ...TODAY_ANCHORS],
    open: async () => {
      await renderRoute(TODAY, { pollScale: 100 });
    },
    release: () => reads.forEach((read) => read.release()),
  });
  expectNoHorizontalScroll();
  expectNoWindowScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it('reload_opens_on_the_frames_shape at 390', async () => {
  const reads = [
    ROUTES.desks.path,
    ROUTES.today.path.replace('{desk_id}', RIVERA.deskId),
    ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId),
  ].map(holdReads);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: [...PHONE_ANCHORS, ...TODAY_ANCHORS],
    open: async () => {
      await renderRoute(TODAY, { viewport: 'phone', pollScale: 100 });
    },
    release: () => reads.forEach((read) => read.release()),
  });
  expectNoHorizontalScroll();
  expectNoWindowScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it('reload_changes_only_the_link_pills_width_once', async () => {
  const desks = holdReads(ROUTES.desks.path);
  const { screen } = await renderRoute(TODAY, { pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  const shape = document.querySelector('[data-skeleton-anchor="link-pill"]')!.getBoundingClientRect();
  const widths: number[] = [];
  const read = () => {
    const layer = document.querySelector('.cd-skeleton-screen__layer');
    const pill = layer?.querySelector('[data-skeleton-anchor="link-pill"]') ?? document.querySelector('.cd-greeting__link');
    if (!pill) return;
    const width = pill.getBoundingClientRect().width;
    if (widths.at(-1) !== width) widths.push(width);
  };
  read();
  const observer = new MutationObserver(read);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  try {
    desks.release();
    await expect.element(screen.getByRole('heading', { name: /Good .*Maria/ })).toBeVisible();
    await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
    const real = document.querySelector('.cd-greeting__link')!.getBoundingClientRect();
    for (const edge of ['top', 'left', 'height'] as const) expect(Math.abs(real[edge] - shape[edge])).toBeLessThanOrEqual(2);
    expect(shape.width).toBe(226);
    expect(widths).toEqual([226, real.width]);
  } finally {
    observer.disconnect();
  }
});

it('reload_is_still_under_reduced_motion', async () => {
  const reads = [
    ROUTES.desks.path,
    ROUTES.today.path.replace('{desk_id}', RIVERA.deskId),
    ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId),
  ].map(holdReads);
  await expectSkeletonStill({
    status: 'Opening your Desk',
    anchors: [...WIDE_ANCHORS, ...TODAY_ANCHORS],
    open: async () => {
      await renderRoute(TODAY, { pollScale: 100 });
    },
    release: () => reads.forEach((read) => read.release()),
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('other_page_reload_draws_the_frame_alone', async () => {
  const desks = holdReads(ROUTES.desks.path);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: WIDE_ANCHORS,
    open: async () => {
      await renderRoute(`/app/${RIVERA.deskId}/share`, { pollScale: 100 });
      await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      expect(document.querySelector('.cd-skeleton-screen__layer .cd-owner-layout')?.children).toHaveLength(1);
      expect(document.querySelector('.cd-skeleton-screen__layer .cd-owner-layout > footer')).not.toBeNull();
      expect(document.querySelector('.cd-skeleton-screen__layer .cd-today')).toBeNull();
    },
    release: desks.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('desks_failure_ends_the_skeleton', async () => {
  const desks = holdReads(ROUTES.desks.path);
  mockStore.inject({ route: 'desks', status: 500, times: 2 });
  const { screen } = await renderRoute(TODAY, { pollScale: 100, retryScale: 0 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  desks.release();
  await expect.element(screen.getByRole('alert')).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(mockStore.requests.filter(({ key }) => key === 'desks')).toHaveLength(2);
  await expectScreenBasics(document.body, { owner: true });
});

it('failed_demo_inbox_read_lands_its_own_error_once', async () => {
  const inbox = holdReads(ROUTES.ownerInbox.path);
  mockStore.inject({ route: 'ownerInbox', status: 500, times: 2 });
  const { screen } = await renderRoute(TODAY, { pollScale: 100, retryScale: 0 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  inbox.release();
  await expect.element(screen.getByText(/Couldn't open your Demo inbox/)).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(mockStore.requests.filter(({ key }) => key === 'ownerInbox')).toHaveLength(2);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Opening your Demo inbox');
});

it('screen_helper_selects_the_region_by_its_status', async () => {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  document.body.prepend(host);
  const root = createRoot(host);
  flushSync(() => root.render(<SkeletonScreen loading status="An unrelated read" skeleton={<Skeleton shape="line" width={30} />} />));
  const desks = holdReads(ROUTES.desks.path);
  try {
    await expectSkeletonLoad({
      status: 'Opening your Desk',
      anchors: TODAY_ANCHORS,
      open: async () => {
        await renderRoute(TODAY, { pollScale: 100 });
      },
      release: desks.release,
    });
  } finally {
    desks.release();
    root.unmount();
    host.remove();
  }
});
