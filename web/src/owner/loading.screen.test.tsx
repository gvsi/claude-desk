import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cleanup } from 'vitest-browser-react';

import { observeRequests, OWNER_ERROR_COPY, TIMEOUT_MS } from '../api/http.ts';
import { ROUTES } from '../api/routes.ts';
import { retryDelayMs } from '../app/poll.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { Skeleton, SkeletonScreen } from '../ds/index.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { mockStore } from '../mocks/store.ts';
import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectSkeletonLoad, expectSkeletonStill, watchSkeletonGaps, type SkeletonAnchor } from '../test/skeleton.ts';
import { expectScreenBasics, expectNoHorizontalScroll, expectNoWindowScroll, nextFrames } from '../test/screen.ts';
import { watchFor, watchPages, watchTop } from '../test/watch.ts';
import { holdReads } from '../test/holdReads.ts';
import { needsYouKey, OWNER_INBOX_KEY, todayKey } from './useDesks.ts';

beforeAll(loadWebFonts);

const TODAY = `/app/${RIVERA.deskId}/today`;

/** Count even waiting layers mounted during a navigation, including one removed before the next frame. */
function watchTodayLayers(): () => number {
  const layers = new Set<Element>();
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches('.cd-today-opening .cd-skeleton-screen__layer')) layers.add(node);
      node.querySelectorAll('.cd-today-opening .cd-skeleton-screen__layer').forEach((layer) => layers.add(layer));
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  return () => layers.size;
}

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
const TODAY_CONTENT_ANCHORS = TODAY_ANCHORS.filter(({ name }) => name !== 'owner-footer');
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

it('switching_desks_opens_on_todays_shape at 1440', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks', pollScale: 100 });
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const reads = [ROUTES.today.path, ROUTES.needsYou.path].map((path) => holdReads(path.replace('{desk_id}', RIVERA.deskId)));
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: TODAY_CONTENT_ANCHORS,
    stays: ['.cd-owner-layout__footer', '.cd-reviewer-bar', '.cd-sidebar'],
    open: async () => {
      await screen.getByRole('button', { name: 'Switch Desk, current: Emergencies' }).click();
      await screen.getByRole('button', { name: 'Main line', exact: true }).click();
    },
    release: () => reads.forEach((read) => read.release()),
  });
  expectNoHorizontalScroll();
  expectNoWindowScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it('switching_desks_opens_on_todays_shape at 390', async () => {
  const { screen, router } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, {
    seed: 'rivera_two_desks', viewport: 'phone', pollScale: 100,
  });
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const reads = [ROUTES.today.path, ROUTES.needsYou.path].map((path) => holdReads(path.replace('{desk_id}', RIVERA.deskId)));
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: TODAY_CONTENT_ANCHORS,
    stays: ['.cd-owner-layout__footer', '.cd-reviewer-bar', '.cd-app-shell__topbar'],
    open: async () => { await router.navigate(TODAY); },
    release: () => reads.forEach((read) => read.release()),
  });
  expectNoHorizontalScroll();
  expectNoWindowScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it('reload_is_one_skeleton_then_today', async () => {
  await cleanup();
  const pages = watchPages();
  const ownLayers = watchTodayLayers();
  const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId));
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: [...WIDE_ANCHORS, ...TODAY_ANCHORS],
    open: async () => { await renderRoute(TODAY, { pollScale: 100 }); },
    release: needsYou.release,
  });
  expect(pages()).toEqual(['loading', 'today']);
  expect(ownLayers()).toBe(0);
});

it.each(['desktop', 'phone'] as const)('deadline_hands_off_to_todays_skeleton at %s', { timeout: 10_000 }, async (viewport) => {
  const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId));
  const gaps = watchSkeletonGaps('.cd-greeting__title');
  const { screen } = await renderRoute(TODAY, { viewport, pollScale: 100 });
  const fullLayer = '.cd-owner-opening > .cd-skeleton-screen__body > .cd-skeleton-screen__layer';
  await vi.waitFor(() => expect(document.querySelector(`${fullLayer}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  const anchors = TODAY_CONTENT_ANCHORS;
  const before = anchors.map(({ name }) => document.querySelector(`${fullLayer} [data-skeleton-anchor="${name}"]`)!.getBoundingClientRect());
  await expectSkeletonLoad({
    status: 'Opening your Desk', continues: true, anchors,
    open: async () => {
      await vi.waitFor(() => expect(document.querySelector('.cd-today-opening .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull(), { timeout: 5_000 });
      await expect.element(viewport === 'desktop' ? screen.getByRole('navigation', { name: 'Main' }) : screen.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
      for (const [i, { name }] of anchors.entries()) {
        const after = document.querySelector(`.cd-today-opening [data-skeleton-anchor="${name}"]`)!.getBoundingClientRect();
        for (const edge of ['top', 'left', 'width', 'height'] as const) {
          expect(Math.abs(before[i]![edge] - after[edge]), `${name} ${edge} across the handoff`).toBeLessThanOrEqual(2);
        }
      }
    },
    release: needsYou.release,
  });
  expect(gaps()).toBe(0);
  await expectScreenBasics(document.body, { owner: true });
});

it('deadline_waits_for_the_demo_inbox', { timeout: 10_000 }, async () => {
  const inbox = holdReads(ROUTES.ownerInbox.path);
  const sawInboxLoader = watchFor('Opening your Demo inbox');
  const gaps = watchSkeletonGaps('.cd-greeting__title');
  const { screen } = await renderRoute(TODAY, { pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector('.cd-owner-opening .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  await nextFrames();
  await expectSkeletonLoad({
    status: 'Opening your Desk', continues: true, anchors: TODAY_CONTENT_ANCHORS,
    open: async () => {
      await vi.waitFor(() => expect(document.querySelector('.cd-today-opening .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull(), { timeout: 5_000 });
      expect(inbox.held()).toBe(1);
      expect(document.querySelector('.cd-greeting__title')).toBeNull();
    },
    release: inbox.release,
  });
  await expect.element(screen.getByRole('button', { name: /^Demo inbox/ })).toBeVisible();
  expect(sawInboxLoader()).toBe(false);
  expect(gaps()).toBe(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  await expectScreenBasics(document.body, { owner: true });
});

it.each(['today', 'needsYou', 'ownerInbox'] as const)('paused_today_reads_land_their_own_errors before %s starts', async (route) => {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await renderRoute(TODAY, { pollScale: 100 });
  await expect.element(screen.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const queryClient = mounted.mock.contexts.at(-1) as QueryClient;
  await router.navigate(`/app/${RIVERA.deskId}/conversations`);
  await expect.element(screen.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  const key = route === 'today' ? todayKey(RIVERA.deskId) : route === 'needsYou' ? needsYouKey(RIVERA.deskId) : OWNER_INBOX_KEY;
  queryClient.removeQueries({ queryKey: key });
  const read = holdReads(ROUTES[route].path.replace('{desk_id}', RIVERA.deskId));
  onTestFinished(read.release);
  const sent = mockStore.requests.filter(({ key }) => key === route).length;
  onlineManager.setOnline(false);
  onTestFinished(() => onlineManager.setOnline(true));
  await router.navigate(TODAY);
  await vi.waitFor(() => expect(queryClient.getQueryState(key)?.fetchStatus).toBe('paused'));
  const section = screen.getByRole('region', { name: route === 'today' ? 'Since last night' : route === 'needsYou' ? 'Needs you' : 'Demo inbox', exact: true });
  const line = route === 'ownerInbox' ? `Couldn't open your Demo inbox. ${OWNER_ERROR_COPY.network}` : OWNER_ERROR_COPY.network;
  await expect.element(section.getByRole('alert').getByText(line, { exact: true }), { timeout: 2_000 }).toBeVisible();
  const retry = section.getByRole('button', { name: 'Try again', exact: true });
  await expect.element(retry).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(mockStore.requests.filter(({ key }) => key === route)).toHaveLength(sent);
  expect(read.held()).toBe(0);
  await retry.click();
  await nextFrames();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(read.held()).toBe(1));
  await expect.element(section.getByRole('alert').getByText(line, { exact: true })).toBeVisible();
  read.release();
  await expect.element(screen.getByText(line, { exact: true })).not.toBeInTheDocument();
  expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
  await expectScreenBasics(document.body, { owner: true });
});

it('switching_to_a_desk_already_read_skips_the_skeleton', async () => {
  const { screen, router } = await renderRoute(TODAY, { seed: 'rivera_two_desks', pollScale: 100 });
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await router.navigate(`/app/${RIVERA.emergenciesDeskId}/today`);
  await expect.element(screen.getByRole('region', { name: 'Since last night' }).getByText('A quiet night', { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const reads = [ROUTES.today.path, ROUTES.needsYou.path].map((path) => holdReads(path.replace('{desk_id}', RIVERA.deskId)));
  const ownLayers = watchTodayLayers();
  await router.navigate(TODAY);
  await expect.element(screen.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  await nextFrames();
  expect(ownLayers()).toBe(0);
  expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
  reads.forEach((read) => read.release());
});

it('todays_hold_still_under_reduced_motion', async () => {
  const { screen, router } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks', pollScale: 100 });
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId));
  await expectSkeletonStill({
    status: 'Opening your Desk',
    anchors: TODAY_CONTENT_ANCHORS,
    open: async () => { await router.navigate(TODAY); },
    release: needsYou.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('deadline_failure_ends_todays_skeleton', { timeout: 10_000 }, async () => {
  const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId));
  mockStore.inject({ route: 'needsYou', status: 503, times: 2 });
  const { screen } = await renderRoute(TODAY, { pollScale: 100, retryScale: 0 });
  await vi.waitFor(() => expect(document.querySelector('.cd-today-opening .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull(), { timeout: 5_000 });
  needsYou.release();
  const needs = screen.getByRole('region', { name: 'Needs you', exact: true });
  await expect.element(needs.getByRole('alert')).toBeVisible();
  await expect.element(needs.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(mockStore.requests.filter(({ key }) => key === 'needsYou')).toHaveLength(2);
  await expectScreenBasics(document.body, { owner: true });
});

it('unanswered_needs_you_ends_todays_skeleton_at_the_read_timeout', { timeout: 30_000 }, async () => {
  // Real request timeouts, with the production retry delay: 10 s + 1 s + 10 s. No answer or
  // planted failure releases this read; the request layer itself must give up (plan 08c, Task 7).
  const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId));
  onTestFinished(needsYou.release);
  const failures: { at: number; kind: string; status: number | null }[] = [];
  onTestFinished(observeRequests((outcome) => {
    if (outcome.key === 'needsYou' && !outcome.ok) {
      failures.push({ at: performance.now(), kind: outcome.error.kind, status: outcome.error.status });
    }
  }));
  const started = performance.now();
  const { screen } = await renderRoute(TODAY, { pollScale: 100, retryScale: 1 });
  const giveUpMs = 2 * TIMEOUT_MS.default + retryDelayMs(0);
  const renderSlackMs = 1_000;
  await vi.waitFor(() => expect(document.querySelector('.cd-today-opening .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull(), { timeout: 5_000 });
  expect(failures).toHaveLength(0);
  await expect.poll(() => failures.length, {
    timeout: giveUpMs + renderSlackMs - (performance.now() - started),
    interval: 50,
  }).toBe(2);
  expect(failures.map(({ kind, status }) => ({ kind, status }))).toEqual([
    { kind: 'network', status: null },
    { kind: 'network', status: null },
  ]);
  expect(failures[1]!.at - started).toBeLessThanOrEqual(giveUpMs + renderSlackMs);
  expect(needsYou.held()).toBe(2);
  const needs = screen.getByRole('region', { name: 'Needs you', exact: true });
  await expect.element(needs.getByRole('alert').getByText(OWNER_ERROR_COPY.network, { exact: true })).toBeVisible();
  await expect.element(needs.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(performance.now() - started).toBeLessThanOrEqual(giveUpMs + renderSlackMs);
  await expectScreenBasics(document.body, { owner: true });
});

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
