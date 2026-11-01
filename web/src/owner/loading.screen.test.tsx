import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cleanup } from 'vitest-browser-react';

import { newIdempotencyKey, observeRequests, OWNER_ERROR_COPY, TIMEOUT_MS } from '../api/http.ts';
import { ROUTES } from '../api/routes.ts';
import type { ConversationSummary, SetupState } from '../api/views.ts';
import { retryDelayMs } from '../app/poll.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { Button, Greeting, Skeleton, SkeletonScreen } from '../ds/index.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { mockStore } from '../mocks/store.ts';
import { RIVERA } from '../mocks/seed.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectSkeletonLoad, expectSkeletonStill, SKELETON_TOLERANCE_PX, watchSkeletonGaps, type SkeletonAnchor } from '../test/skeleton.ts';
import { expectScreenBasics, expectNoHorizontalScroll, expectNoWindowScroll, nextFrames } from '../test/screen.ts';
import { watchFor, watchPages, watchTop } from '../test/watch.ts';
import { holdReads } from '../test/holdReads.ts';
import { needsYouKey, OWNER_INBOX_KEY, todayKey } from './useDesks.ts';
import { publicLink } from './customerLink.ts';
import { TodaySkeleton } from './today/TodaySkeleton.tsx';

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

/** Count every skeleton layer that mounts from now on, in any state, even one removed before the next frame. */
function watchLayers(): () => number {
  const layers = new Set<Element>();
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches('.cd-skeleton-screen__layer')) layers.add(node);
      node.querySelectorAll('.cd-skeleton-screen__layer').forEach((layer) => layers.add(layer));
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

/** A Desk the mock's setup made for Okafor Plumbing, its questions answered and its rules drafted, then left there. */
async function deskLeftAtRules(): Promise<SetupState> {
  // Keep this fixture independent of setup's editable starter businesses.
  const description =
    "Okafor Plumbing. I'm Daniel, and I fix leaks, clear drains and replace water heaters for homes around Oakland. People often send me a photo of the problem before I come out.";
  const started = await mockStore.dispatch('startSetup', {
    body: { description, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() },
  });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  const id = state.interview_id;
  await mockStore.dispatch('setupConsent', { params: { id }, body: { allow: false } });
  for (const question of SETUP_QUESTIONS) await mockStore.dispatch('setupAnswer', { params: { id }, body: { question: question.key, text: 'Yes, that works.' } });
  await mockStore.dispatch('setupRules', { params: { id } });
  return state;
}

/** The element for `selector` outside any skeleton layer, once the page has drawn it. */
function landedElement(selector: string): Element | null {
  return [...document.querySelectorAll(selector)].find((el) => el.closest('.cd-skeleton-screen__layer') === null) ?? null;
}

it('unfinished_setup_card_lands_once_after_the_skeleton', async () => {
  // Decision 15: the skeleton draws a fresh copy's Today, which has no "Not live yet" card. For a
  // Desk whose setup isn't finished, nothing of the card shows while Today's reads are out; once
  // they settle, the card lands once with Today, first in its column, in the place the skeleton's
  // Things to try had, and Things to try lands under it and stays there.
  const state = await deskLeftAtRules();
  const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', state.desk_id));
  const cardsAdded = new Set<Element>();
  const cards = new MutationObserver(() => {
    document.querySelectorAll('.cd-continue-setup').forEach((card) => cardsAdded.add(card));
  });
  cards.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => cards.disconnect());
  const sawNotLive = watchFor('Not live yet');
  const { screen } = await renderRoute(`/app/${state.desk_id}/today`, { pollScale: 100 });
  await vi.waitFor(() => expect(needsYou.held()).toBeGreaterThan(0));
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  const layer = document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')!;
  expect(layer.querySelector('.cd-things'), "the skeleton draws Today's Things to try").not.toBeNull();
  expect(document.querySelector('.cd-continue-setup'), 'no setup card while the reads are out').toBeNull();
  expect(sawNotLive()).toBe(false);
  const shapeThings = layer.querySelector('.cd-things')!.getBoundingClientRect();
  const thingsTops = watchTop(() => landedElement('.cd-things'));

  needsYou.release();
  const card = screen.getByRole('region', { name: 'Finish setting up Okafor Plumbing', exact: true });
  await expect.element(card).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  await nextFrames();
  const things = screen.getByRole('heading', { level: 2, name: 'Things to try' }).element();
  expect(card.element().compareDocumentPosition(things) & Node.DOCUMENT_POSITION_FOLLOWING, 'the card comes before Things to try').toBeTruthy();
  expect(card.element().parentElement?.firstElementChild?.classList.contains('cd-today__greeting')).toBe(true);
  expect(card.element().previousElementSibling?.classList.contains('cd-today__greeting')).toBe(true);
  expect(Math.abs(card.element().getBoundingClientRect().top - shapeThings.top), "the card takes Things to try's place").toBeLessThanOrEqual(
    SKELETON_TOLERANCE_PX,
  );
  expect(thingsTops(), 'Things to try lands once, under the card').toHaveLength(1);
  expect(thingsTops()[0]!).toBeGreaterThan(card.element().getBoundingClientRect().bottom);
  expect(cardsAdded.size, 'the card mounts once').toBe(1);
  expect(card.element().isConnected).toBe(true);
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
  { name: 'things-hide', page: '.cd-things__hide > .cd-button', size: true },
  ...[0, 1, 2, 3].map((i) => ({ name: `thing-action-${i}`, page: `.cd-things__item:nth-child(${i + 1}) .cd-things__action > .cd-button`, size: true })),
  { name: 'needs-title', page: '.cd-today__section[tabindex] .cd-section-header__heading' },
  { name: 'held-card', page: '.cd-needs-you .cd-card', dimensions: ['width'] },
  { name: 'live-row', page: '.cd-live .cd-conversation-item', size: true },
  { name: 'since-title', page: '.cd-today__main > .cd-today__section:last-child .cd-section-header__heading' },
  { name: 'since-card', page: '.cd-today__main > .cd-today__section:last-child > .cd-card', size: true },
  { name: 'public-card', page: '.cd-today-aside > .cd-card:first-child', size: true },
  { name: 'public-page-action', page: '.cd-today-aside__action > .cd-button', size: true },
  { name: 'inbox', page: '.cd-owner-inbox > .cd-button', size: true },
  { name: 'week-title', page: '.cd-week__heading' },
  { name: 'week-bar-0', page: '.cd-week__bar' },
];
const TODAY_CONTENT_ANCHORS = TODAY_ANCHORS.filter(({ name }) => name !== 'owner-footer');

/**
 * Decision 15's accepted move on a Desk switch. A copy with two Desks has made a Desk of its own, so
 * Things to try's last row lands ticked ("Create your own Desk", one done line) where the skeleton
 * draws a fresh copy's row. The card keeps its top, left and width and lands one row's change
 * shorter; what Today draws under it in its column, the aside stacked under that on a phone and the
 * frame's footer each land once, by exactly that change. Everything else lands where its shape was.
 */
const UNDER_THINGS = ['needs-title', 'held-card', 'live-row', 'since-title', 'since-card'];
const UNDER_THINGS_ON_A_PHONE = [...UNDER_THINGS, 'public-card', 'public-page-action', 'inbox', 'week-title', 'week-bar-0'];

function switchedAnchors(phone: boolean): SkeletonAnchor[] {
  const under = new Set(phone ? UNDER_THINGS_ON_A_PHONE : UNDER_THINGS);
  return TODAY_CONTENT_ANCHORS.filter(({ name }) => !under.has(name) && name !== 'thing-tile-3' && name !== 'thing-action-3').map((anchor) =>
    anchor.name === 'things-card' ? { name: anchor.name, page: anchor.page, dimensions: ['width'] as const } : anchor,
  );
}

/** The landed element for `selector`, outside any skeleton layer. */
function landedRect(selector: string): DOMRect {
  const element = [...document.querySelectorAll(selector)].find((el) => el.closest('.cd-skeleton-screen__layer') === null);
  if (element === undefined) throw new Error(`No landed element for ${selector}`);
  return element.getBoundingClientRect();
}

function boundsFromRect({ top, left, width, height }: DOMRect) {
  return { top, left, width, height };
}

/** Sample the landed geometry from its first commit, even while the shapes fade over it. */
function watchTheTickedRow(phone: boolean) {
  const under = TODAY_CONTENT_ANCHORS.filter(({ name }) => (phone ? UNDER_THINGS_ON_A_PHONE : UNDER_THINGS).includes(name));
  const shape = (name: string) => document.querySelector(`.cd-today-opening [data-skeleton-anchor="${name}"]`)!.getBoundingClientRect();
  let before: { card: DOMRect; under: DOMRect[]; footer: DOMRect } | undefined;
  const snapshot = () => {
    const card = landedElement('.cd-things > .cd-card');
    return {
      card: boundsFromRect(card?.getBoundingClientRect() ?? shape('things-card')),
      under: under.map(({ name, page }) => boundsFromRect(landedElement(page)?.getBoundingClientRect() ?? shape(name))),
      footer: boundsFromRect(landedRect('.cd-owner-layout__footer')),
    };
  };
  const changes: ReturnType<typeof snapshot>[] = [];
  let firstLanded: ReturnType<typeof snapshot> | undefined;
  let landedState: string | null | undefined;
  const sample = () => {
    if (!landedElement('.cd-things > .cd-card') && !document.querySelector('.cd-today-opening [data-skeleton-anchor="things-card"]')) return;
    const next = snapshot();
    const card = landedElement('.cd-things > .cd-card');
    if (card && !firstLanded) {
      firstLanded = next;
      landedState = document.querySelector('.cd-today-opening .cd-skeleton-screen__layer')?.getAttribute('data-state');
    }
    if (JSON.stringify(changes.at(-1)) !== JSON.stringify(next)) changes.push(next);
  };
  const observer = new MutationObserver(sample);
  let frame = 0;
  const sampleFrame = () => { sample(); frame = requestAnimationFrame(sampleFrame); };
  const stop = () => { observer.disconnect(); cancelAnimationFrame(frame); };
  onTestFinished(stop);
  return {
    record: () => {
      before = { card: shape('things-card'), under: under.map(({ name }) => shape(name)), footer: landedRect('.cd-owner-layout__footer') };
      sample();
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
      frame = requestAnimationFrame(sampleFrame);
    },
    expectOneMove: async () => {
      expect(before, 'the shapes were measured before the reads came in').toBeDefined();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      stop();
      const final = snapshot();
      expect(landedState).toBe(matchMedia('(prefers-reduced-motion: reduce)').matches ? undefined : 'leaving');
      expect(firstLanded).toEqual(final);
      expect(changes).toEqual([
        { card: boundsFromRect(before!.card), under: before!.under.map(boundsFromRect), footer: boundsFromRect(before!.footer) },
        final,
      ]);
      const last = [...document.querySelectorAll('.cd-things__item:last-child')].find((el) => el.closest('.cd-skeleton-screen__layer') === null);
      expect(last?.textContent).toContain('Done. Your new Desk is live.');
      const change = landedRect('.cd-things > .cd-card').height - before!.card.height;
      expect(change, 'the ticked row is shorter than the fresh one').toBeLessThan(-SKELETON_TOLERANCE_PX);
      under.forEach(({ name, page, size, dimensions }, i) => {
        const real = landedRect(page);
        expect(Math.abs(real.top - before!.under[i]!.top - change), `${name} moves by the card's change`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
        expect(Math.abs(real.left - before!.under[i]!.left), `${name} left`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
        for (const dimension of size ? (['width', 'height'] as const) : dimensions ?? []) {
          expect(Math.abs(real[dimension] - before!.under[i]![dimension]), `${name} ${dimension}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
        }
      });
      const footer = landedRect('.cd-owner-layout__footer');
      expect(Math.abs(footer.top - before!.footer.top - change), "the footer moves by the card's change").toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    },
  };
}
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
  const ticked = watchTheTickedRow(false);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: switchedAnchors(false),
    stays: ['.cd-reviewer-bar', '.cd-sidebar'],
    open: async () => {
      await screen.getByRole('button', { name: 'Switch Desk, current: Emergencies' }).click();
      await screen.getByRole('button', { name: 'Main line', exact: true }).click();
    },
    release: () => {
      ticked.record();
      reads.forEach((read) => read.release());
    },
  });
  await ticked.expectOneMove();
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
  const ticked = watchTheTickedRow(true);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: switchedAnchors(true),
    stays: ['.cd-reviewer-bar', '.cd-app-shell__topbar'],
    open: async () => { await router.navigate(TODAY); },
    release: () => {
      ticked.record();
      reads.forEach((read) => read.release());
    },
  });
  await ticked.expectOneMove();
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
  const ticked = watchTheTickedRow(false);
  await expectSkeletonStill({
    status: 'Opening your Desk',
    anchors: switchedAnchors(false),
    open: async () => { await router.navigate(TODAY); },
    release: () => {
      ticked.record();
      needsYou.release();
    },
  });
  await ticked.expectOneMove();
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

it('today_link_actions_measure_inherited_font_metrics', async () => {
  const host = document.createElement('div');
  host.style.letterSpacing = '0.2em';
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); });
  flushSync(() => root.render(<><div data-real-control><Button variant="secondary" href="/d/rivera-plumbing-abc123">Open your public page</Button></div><TodaySkeleton /></>));
  const real = host.querySelector('[data-real-control] .cd-button')!;
  const shape = host.querySelector('[data-skeleton-anchor="thing-action-0"]')!;
  expect(shape.textContent).toBe('');
  await expect.poll(() => Math.abs(shape.getBoundingClientRect().width - real.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
});

it('reload_changes_only_the_link_pills_width_once', async () => {
  // The slug comes from the held read, so its width differs from the fresh-copy placeholder.
  mockStore.world.desk(RIVERA.deskId)!.summary.slug = 'rivera-plumbing-a-new-random-slug';
  const desks = holdReads(ROUTES.desks.path);
  const { screen } = await renderRoute(TODAY, { pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  const shape = document.querySelector('[data-skeleton-anchor="link-pill"]')!.getBoundingClientRect();
  const bounds = (element: Element) => {
    const { top, left, width, height } = element.getBoundingClientRect();
    return { top, left, width, height };
  };
  const changes: ReturnType<typeof bounds>[] = [];
  let firstLanded: ReturnType<typeof bounds> | undefined;
  let landedState: string | null | undefined;
  const read = () => {
    const layer = document.querySelector('.cd-skeleton-screen__layer');
    const real = landedElement('.cd-greeting__link');
    const pill = real ?? layer?.querySelector('[data-skeleton-anchor="link-pill"]');
    if (!pill) return;
    const next = bounds(pill);
    if (real && !firstLanded) {
      firstLanded = next;
      landedState = layer?.getAttribute('data-state');
    }
    if (JSON.stringify(changes.at(-1)) !== JSON.stringify(next)) changes.push(next);
  };
  read();
  const observer = new MutationObserver(read);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  let frame = 0;
  const sampleFrame = () => { read(); frame = requestAnimationFrame(sampleFrame); };
  frame = requestAnimationFrame(sampleFrame);
  try {
    desks.release();
    await expect.element(screen.getByRole('heading', { name: /Good .*Maria/ })).toBeVisible();
    await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
    const real = document.querySelector('.cd-greeting__link')!.getBoundingClientRect();
    for (const edge of ['top', 'left', 'height'] as const) expect(Math.abs(real[edge] - shape[edge])).toBeLessThanOrEqual(2);
    const sizing = document.createElement('div');
    Object.assign(sizing.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' });
    sizing.inert = true;
    document.body.append(sizing);
    const reference = createRoot(sizing);
    try {
      flushSync(() => reference.render(<Greeting text="" link={{ label: publicLink('rivera-plumbing-abc123'), onCopy: () => {} }} />));
      const fresh = sizing.querySelector('.cd-greeting__link')!.getBoundingClientRect();
      expect(Math.abs(shape.width - fresh.width), 'the fresh-copy link uses browser font metrics').toBeLessThanOrEqual(2);
    } finally {
      reference.unmount();
      sizing.remove();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(landedState).toBe('leaving');
    expect(firstLanded).toEqual(bounds(document.querySelector('.cd-greeting__link')!));
    expect(changes).toEqual([boundsFromRect(shape), boundsFromRect(real)]);
  } finally {
    observer.disconnect();
    cancelAnimationFrame(frame);
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

const PEOPLE = `/app/${RIVERA.deskId}/people`;
const PEOPLE_READ = ROUTES.people.path.replace('{desk_id}', RIVERA.deskId);

/** Customers' parts the skeleton draws: the first section's head and the seed's first and last rows. */
const CUSTOMERS_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'people-head', page: '.cd-people__head .cd-section-header__heading' },
  { name: 'person-row-0', page: '.cd-people__rows > li:first-child > .cd-person-row', size: true },
  { name: 'person-row-1', page: '.cd-people__rows > li:last-child > .cd-person-row', size: true },
];

/** Today, drawn and at rest: where an in-app load starts, so its region never meets the full-page skeleton. */
async function openToday(viewport: 'desktop' | 'phone' = 'desktop') {
  const rendered = await renderRoute(TODAY, { viewport, pollScale: 100 });
  await expect.element(rendered.screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  return rendered;
}

it.each(['desktop', 'phone'] as const)('customers_load_in_place at %s', async (viewport) => {
  const { screen, router } = await openToday(viewport);
  const people = holdReads(PEOPLE_READ);
  await expectSkeletonLoad({
    status: 'Loading your customers',
    anchors: CUSTOMERS_ANCHORS,
    stays: ['.cd-owner-layout__footer'],
    open: async () => {
      if (viewport === 'desktop') await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Customers/ }).click();
      else await router.navigate(PEOPLE);
    },
    release: people.release,
  });
  expectNoHorizontalScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it('customers_still_under_reduced_motion', async () => {
  const { screen } = await openToday();
  const people = holdReads(PEOPLE_READ);
  await expectSkeletonStill({
    status: 'Loading your customers',
    anchors: CUSTOMERS_ANCHORS,
    stays: ['.cd-owner-layout__footer'],
    open: async () => {
      await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Customers/ }).click();
    },
    release: people.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('customers_failure_ends_the_skeleton', async () => {
  const { screen } = await renderRoute(TODAY, { pollScale: 100, retryScale: 0 });
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const people = holdReads(PEOPLE_READ);
  mockStore.inject({ route: 'people', status: 503, times: 2 });
  await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Customers/ }).click();
  await vi.waitFor(() => expect(document.querySelector('.cd-people__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  people.release();
  const failed = screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true });
  await expect.element(failed).toBeVisible();
  const retry = screen.getByRole('button', { name: 'Try again', exact: true });
  await expect.element(retry).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(failed.element().closest('.cd-people__region')).not.toBeNull();
  expect(mockStore.requests.filter(({ key }) => key === 'people')).toHaveLength(2);

  // "Try again" reads it again, and the people land where the failure was, with no skeleton.
  const layers = watchLayers();
  await retry.click();
  await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  expect(mockStore.requests.filter(({ key }) => key === 'people')).toHaveLength(3);
  expect(failed.query()).toBeNull();
  expect(layers()).toBe(0);
  await expectScreenBasics(document.body, { owner: true });
});

it('cached_customers_skip_the_skeleton', async () => {
  const { screen, router } = await renderRoute(PEOPLE, { pollScale: 100 });
  const contacts = screen.getByRole('list', { name: 'Contacts on record' });
  await expect.element(contacts).toBeVisible();
  await router.navigate(TODAY);
  await expect.element(screen.getByRole('heading', { name: 'Since last night', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());

  // Back to Customers, read before: no layer mounts, not even a waiting one, so the rows draw with
  // the page in its first commit.
  const layers = watchLayers();
  await router.navigate(PEOPLE);
  await expect.element(contacts).toBeVisible();
  await nextFrames();
  expect(layers()).toBe(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  await expectScreenBasics(document.body, { owner: true });
});

/** The full-page skeleton's layer, which holds the frame and the page as shapes on a reload. */
const FULL_LAYER = '.cd-owner-opening > .cd-skeleton-screen__body > .cd-skeleton-screen__layer';

/** Each named shape's box in the full-page skeleton, read once it is shown. */
function fullPageShapes(names: readonly string[]): DOMRect[] {
  return names.map((name) => {
    const shape = document.querySelector(`${FULL_LAYER} [data-skeleton-anchor="${name}"]`);
    if (shape === null) throw new Error(`The full-page skeleton draws no ${name}`);
    return shape.getBoundingClientRect();
  });
}

/** Each named shape in the page's own region sits within 2 px of the full-page skeleton's, on all four edges. */
function expectSameShapes(region: string, names: readonly string[], before: readonly DOMRect[]): void {
  names.forEach((name, i) => {
    const after = document.querySelector(`${region} [data-skeleton-anchor="${name}"]`);
    expect(after, `${region} draws ${name}`).not.toBeNull();
    for (const edge of ['top', 'left', 'width', 'height'] as const) {
      expect(Math.abs(before[i]![edge] - after!.getBoundingClientRect()[edge]), `${name} ${edge} across the hand-off`).toBeLessThanOrEqual(
        SKELETON_TOLERANCE_PX,
      );
    }
  });
}

it.each(['desktop', 'phone'] as const)('customers_reload_hands_off at %s', async (viewport) => {
  const desks = holdReads(ROUTES.desks.path);
  const people = holdReads(PEOPLE_READ);
  const gaps = watchSkeletonGaps('ul.cd-people__rows');
  const { screen } = await renderRoute(PEOPLE, { viewport, pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  // The full-page skeleton draws Customers' header and rows, as well as the frame.
  expect(document.querySelector(`${FULL_LAYER} .cd-people .cd-page-header`)).not.toBeNull();
  const names = CUSTOMERS_ANCHORS.map(({ name }) => name);
  const before = fullPageShapes(names);
  await expectSkeletonLoad({
    status: 'Loading your customers',
    continues: true,
    anchors: CUSTOMERS_ANCHORS,
    stays: ['.cd-owner-layout__footer'],
    open: async () => {
      desks.release();
      await expect.element(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
      await vi.waitFor(() => expect(document.querySelector('.cd-people__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      expectSameShapes('.cd-people__region', names, before);
    },
    release: people.release,
  });
  expect(gaps()).toBe(0);
  await expectScreenBasics(document.body, { owner: true });
});

const CONVERSATIONS = `/app/${RIVERA.deskId}/conversations`;
const CONVERSATIONS_READ = ROUTES.conversations.path.replace('{desk_id}', RIVERA.deskId);
const LIST_REGION = '.cd-conversations__region';

/** The first conversation row in the list, the skeleton's while its layer is up, else the page's. */
function firstListRow(): Element | null {
  return document.querySelector(`${LIST_REGION} [data-skeleton-anchor="conversation-row-0"]`) ?? landedElement('.cd-conversations__items .cd-conversation-item');
}

it('conversations_without_recorded_history_moves_once', async () => {
  // Decision 15: the skeleton draws a fresh copy's list, which replays recorded history and so says
  // "Includes recorded history" 4 px under the title. A copy with none (the mock's) lands its list
  // once, higher than its shapes by the caption's line and those 4 px: the first day then sits
  // 16 px under the title, where the caption's 16 px gap put it under the caption.
  // Today's Things to try reads the list too, so it is held from the start, as on a slow first read.
  const list = holdReads(CONVERSATIONS_READ);
  const { screen } = await openToday();
  await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Conversations/ }).click();
  await vi.waitFor(() => expect(document.querySelector(`${LIST_REGION} .cd-skeleton-screen__layer[data-state="shown"]`)).not.toBeNull());
  const caption = document.querySelector(`${LIST_REGION} .cd-conversations__caption`)!.getBoundingClientRect();
  const tops = watchTop(firstListRow);
  list.release();
  await expect.element(screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link').first()).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(screen.getByRole('link', { name: 'Includes recorded history' }).elements()).toHaveLength(0);
  expect(tops()).toHaveLength(2);
  expect(tops()[0]! - tops()[1]!).toBe(Math.round(caption.height) + 4);
});

/** The seeded chat whose 15% discount is held: what Today's "Open the request" opens. */
const SEEDED_HOLD = 'ses-visitor-web';
const conversationRead = (sessionId: string) => ROUTES.conversation.path.replace('{session_id}', sessionId);

/**
 * A fresh copy's list, which replays recorded history into the copy: the mock's own list with the
 * seeded hold's chat marked replayed, so the page says "Includes recorded history" under its title.
 */
async function withRecordedHistory(): Promise<void> {
  const answer = await mockStore.dispatch('conversations', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the conversations');
  const list = answer.body as ConversationSummary[];
  mockStore.inject({
    route: 'conversations',
    status: 200,
    times: 10_000,
    body: list.map((s) => (s.session_id === SEEDED_HOLD ? { ...s, replayed: true } : s)),
  });
}

/** The list's parts the skeleton draws: the caption, the first day, and the seed's first and last rows. */
const LIST_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'conversations-caption', page: '.cd-conversations__caption' },
  { name: 'conversations-day-0', page: '.cd-conversations__day' },
  { name: 'conversation-row-0', page: '.cd-conversations__items > li:first-child > .cd-conversation-item', size: true },
  { name: 'conversation-row-2', page: '.cd-conversations__items > li:nth-child(3) > .cd-conversation-item', size: true },
];

/** Each part of the fresh copy's held chat, by the shape that stands for it and the part itself. */
const CHAT_PARTS = {
  name: { name: 'conversation-name', page: '.cd-conversation__name' },
  head: { name: 'transcript-head', page: '.cd-conversation .cd-transcript > .cd-transcript-header', dimensions: ['height'] },
  visitor: { name: 'first-message', page: '.cd-conversation .cd-transcript .cd-visitor-message', dimensions: ['height'] },
  reply: { name: 'reply-card', page: '.cd-conversation .cd-transcript .cd-reply-card', dimensions: ['height'] },
  receipt0: { name: 'receipt-0', page: '.cd-conversation .cd-transcript .cd-transcript-row__margin > :first-child', dimensions: ['height'] },
  receipt1: { name: 'receipt-1', page: '.cd-conversation .cd-transcript .cd-transcript-row__margin > :nth-child(2)', dimensions: ['height'] },
  held: { name: 'held-card', page: '.cd-conversation .cd-transcript > .cd-conversation__held', dimensions: ['height'] },
} as const satisfies Record<string, SkeletonAnchor>;

/**
 * In a wide window a fresh copy's held chat fits its region and opens at its top: every part of it
 * is in view as it lands, so each one's top and bottom (its top and height) and each receipt line
 * is anchored to its shape.
 */
const PANE_ANCHORS: readonly SkeletonAnchor[] = [
  CHAT_PARTS.name,
  CHAT_PARTS.head,
  CHAT_PARTS.visitor,
  CHAT_PARTS.reply,
  CHAT_PARTS.receipt0,
  CHAT_PARTS.receipt1,
  CHAT_PARTS.held,
];

/**
 * On a phone the chat is taller than its region and opens at its latest, over the owner's
 * controls: in view as it lands are the foot of Claude's reply, its two receipt lines and the held
 * request, each anchored to its shape by its top and bottom.
 */
const PHONE_PANE_ANCHORS: readonly SkeletonAnchor[] = [CHAT_PARTS.name, CHAT_PARTS.reply, CHAT_PARTS.receipt0, CHAT_PARTS.receipt1, CHAT_PARTS.held];

/**
 * From the moment the pane's shapes start to leave, each anchored part of the chat, every frame
 * until it has settled, against where its shape was at that moment: Take over and the whisper box
 * arrive with the chat and the transcript settles at its end, and nothing moves from its shape by
 * more than 2 px on its top, left or height. `expectStill` checks every frame it saw.
 */
function watchPaneLanding(anchors: readonly SkeletonAnchor[]) {
  let shapes: DOMRect[] | null = null;
  const worst = anchors.map(() => ({ top: 0, left: 0, height: 0 }));
  let frames = 0;
  const look = () => {
    const layer = document.querySelector<HTMLElement>('.cd-conversation-pane .cd-skeleton-screen__layer');
    if (shapes === null) {
      if (layer?.dataset.state !== 'leaving') return;
      shapes = anchors.map(({ name }) => {
        const shape = layer.querySelector(`[data-skeleton-anchor="${name}"]`);
        if (shape === null) throw new Error(`No shape for ${name}`);
        return shape.getBoundingClientRect();
      });
    }
    anchors.forEach(({ page }, i) => {
      const real = landedElement(page);
      if (real === null) return;
      const box = real.getBoundingClientRect();
      for (const edge of ['top', 'left', 'height'] as const) worst[i]![edge] = Math.max(worst[i]![edge], Math.abs(box[edge] - shapes![i]![edge]));
    });
    frames += 1;
  };
  const observer = new MutationObserver(look);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  let frame = 0;
  const sample = () => {
    look();
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  const stop = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
  onTestFinished(stop);
  return {
    expectStill: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      stop();
      expect(shapes, 'the shapes were read as they started to leave').not.toBeNull();
      expect(frames).toBeGreaterThan(1);
      anchors.forEach(({ name }, i) => {
        for (const edge of ['top', 'left', 'height'] as const) {
          expect(worst[i]![edge], `${name} ${edge}, at its furthest from its shape while the pane landed`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
        }
      });
    },
  };
}

it.each(['desktop', 'phone'] as const)('conversations_load_in_place at %s', async (viewport) => {
  await withRecordedHistory();
  // Today's Things to try reads the list too, so it is held from the start, as on a slow first read.
  const list = holdReads(CONVERSATIONS_READ);
  const { screen, router } = await openToday(viewport);
  await expectSkeletonLoad({
    status: 'Reading your conversations',
    anchors: LIST_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open: async () => {
      if (viewport === 'desktop') await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Conversations/ }).click();
      else await router.navigate(CONVERSATIONS);
    },
    release: list.release,
  });
  expectNoHorizontalScroll();
  expectNoWindowScroll();

  // The fresh copy's held chat opens in place too: at its top in a wide window, where it fits, and
  // at its latest on a phone, over the owner's controls.
  const chat = holdReads(conversationRead(SEEDED_HOLD));
  const anchors = viewport === 'desktop' ? PANE_ANCHORS : PHONE_PANE_ANCHORS;
  const inView = watchPaneLanding(anchors);
  await expectSkeletonLoad({
    status: 'Opening the conversation',
    anchors,
    stays: ['.cd-conversations__footer'],
    open: async () => {
      if (viewport === 'desktop') await screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /Needs you/ }).click();
      else await router.navigate(`${CONVERSATIONS}/${SEEDED_HOLD}`);
    },
    release: chat.release,
  });
  await expect.element(screen.getByRole('log')).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
  await inView.expectStill();
  expectNoHorizontalScroll();
  expectNoWindowScroll();
  await expectScreenBasics(document.body, { owner: true });
});

const NEEDS_YOU_READ = ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId);

/**
 * Opens the seeded hold's chat from Customers, which reads neither the list nor Needs you, with one
 * of the pane's reads held (`key` at `path`): the others are read, and the pane keeps its shapes
 * while the held one is out.
 */
async function openChatWithOneReadHeld(key: 'needsYou' | 'conversations', path: string, retryScale = 1) {
  const rendered = await renderRoute(PEOPLE, { pollScale: 100, retryScale });
  await expect.element(rendered.screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const held = holdReads(path);
  const served = (route: string) => mockStore.requests.filter((request) => request.key === route).length;
  const others = (['conversation', 'conversations', 'needsYou'] as const).filter((route) => route !== key);
  const open = async () => {
    await rendered.router.navigate(`${CONVERSATIONS}/${SEEDED_HOLD}`);
    await vi.waitFor(() => expect(held.held()).toBe(1));
    await vi.waitFor(() => expect(others.every((route) => served(route) > 0)).toBe(true));
    await vi.waitFor(() => expect(document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
    await nextFrames();
    expect(landedElement('.cd-conversation__head'), `the chat waits for ${key}`).toBeNull();
    expect(document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer')?.getAttribute('data-state')).toBe('shown');
  };
  return { ...rendered, held, open };
}

it('conversation_waits_for_needs_you', async () => {
  const { screen, held, open } = await openChatWithOneReadHeld('needsYou', NEEDS_YOU_READ);
  await expectSkeletonLoad({
    status: 'Opening the conversation',
    anchors: PANE_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open,
    release: held.release,
  });
  await expect.element(screen.getByRole('article', { name: `Held for you: ${rivera.decisions.held.reason_plain}`, exact: true })).toBeVisible();
  await expectScreenBasics(document.body, { owner: true });
});

it('conversation_waits_for_the_list_that_names_it', async () => {
  // Decision 7: the list read only names who the chat is with, and still counts. A chat with a
  // named visitor would otherwise land as "Visitor" and change its name under the reader.
  const { screen, held, open } = await openChatWithOneReadHeld('conversations', CONVERSATIONS_READ);
  await expectSkeletonLoad({
    status: 'Opening the conversation',
    anchors: PANE_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open,
    release: held.release,
  });
  await expect.element(screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
  await expectScreenBasics(document.body, { owner: true });
});

it('conversation_lands_on_its_needs_you_error', async () => {
  const { screen, held, open } = await openChatWithOneReadHeld('needsYou', NEEDS_YOU_READ, 0);
  mockStore.inject({ route: 'needsYou', status: 503, times: 2 });
  await open();
  held.release();
  const failed = screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true });
  await expect.element(failed).toBeVisible();
  await expect.element(screen.getByRole('log')).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(failed.element().closest('.cd-conversation')).not.toBeNull();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(mockStore.requests.filter(({ key }) => key === 'needsYou')).toHaveLength(2);
  await expectScreenBasics(document.body, { owner: true });
});

it('conversations_still_under_reduced_motion', async () => {
  await withRecordedHistory();
  const list = holdReads(CONVERSATIONS_READ);
  const { screen } = await openToday();
  await expectSkeletonStill({
    status: 'Reading your conversations',
    anchors: LIST_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open: async () => {
      await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Conversations/ }).click();
    },
    release: list.release,
  });
  const chat = holdReads(conversationRead(SEEDED_HOLD));
  await expectSkeletonStill({
    status: 'Opening the conversation',
    anchors: PANE_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open: async () => {
      await screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /Needs you/ }).click();
    },
    release: chat.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('conversation_reload_hands_off at 390', async () => {
  // The fresh copy's held chat, which on a phone opens at its latest.
  const desks = holdReads(ROUTES.desks.path);
  const chat = holdReads(conversationRead(SEEDED_HOLD));
  const gaps = watchSkeletonGaps('.cd-conversation__head');
  const { screen } = await renderRoute(`${CONVERSATIONS}/${SEEDED_HOLD}`, { viewport: 'phone', pollScale: 100 });
  // From the loading page's first commit, which keeps the frame's hidden heading.
  const headings = watchTopHeadings();
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  // The full-page skeleton draws the way back and the open conversation's pane, as well as the frame.
  expect(document.querySelector(`${FULL_LAYER} .cd-conversations--open .cd-conversations__back`)).not.toBeNull();
  const names = PHONE_PANE_ANCHORS.map(({ name }) => name);
  const before = fullPageShapes(names);
  const inView = watchPaneLanding(PHONE_PANE_ANCHORS);
  await expectSkeletonLoad({
    status: 'Opening the conversation',
    continues: true,
    anchors: PHONE_PANE_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open: async () => {
      desks.release();
      await expect.element(screen.getByRole('link', { name: 'All conversations' })).toBeVisible();
      await vi.waitFor(() => expect(document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      expectSameShapes('.cd-conversation-pane', names, before);
    },
    release: chat.release,
  });
  await inView.expectStill();
  expect(gaps()).toBe(0);
  expect(headings(), 'one top heading through the reload, the hand-off and the landing').toEqual([1]);
  expectNoHorizontalScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it('conversations_reload_hands_off at 1440', async () => {
  await withRecordedHistory();
  const desks = holdReads(ROUTES.desks.path);
  const list = holdReads(CONVERSATIONS_READ);
  const gaps = watchSkeletonGaps('ul.cd-conversations__items');
  const { screen } = await renderRoute(CONVERSATIONS, { pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  // The full-page skeleton draws the list's title, its rows down the column and the page's own footer.
  expect(document.querySelector(`${FULL_LAYER} .cd-conversations__title .cd-skeleton-line--page-title`)).not.toBeNull();
  expect(document.querySelector(`${FULL_LAYER} .cd-conversations__footer .cd-concept-footer`)).not.toBeNull();
  expect(document.querySelector(`${FULL_LAYER} .cd-owner-layout__footer`)).toBeNull();
  const names = LIST_ANCHORS.map(({ name }) => name);
  const before = fullPageShapes(names);
  await expectSkeletonLoad({
    status: 'Reading your conversations',
    continues: true,
    anchors: LIST_ANCHORS,
    stays: ['.cd-conversations__footer'],
    open: async () => {
      desks.release();
      await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
      await vi.waitFor(() => expect(document.querySelector(`${LIST_REGION} .cd-skeleton-screen__layer[data-state="shown"]`)).not.toBeNull());
      expectSameShapes(LIST_REGION, names, before);
    },
    release: list.release,
  });
  expect(gaps()).toBe(0);
  expectNoWindowScroll();
  await expectScreenBasics(document.body, { owner: true });
});

/**
 * Every count of top headings a reader can reach, from now on, read at each change and each frame:
 * `h1`s that are drawn (a visually hidden one included) and not inside anything hidden from them.
 */
function watchTopHeadings(): () => number[] {
  const counts: number[] = [];
  const look = () => {
    const reachable = [...document.querySelectorAll('h1')].filter((h1) => h1.getClientRects().length > 0 && h1.closest('[aria-hidden="true"]') === null);
    if (counts.at(-1) !== reachable.length) counts.push(reachable.length);
  };
  look();
  const observer = new MutationObserver(look);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'class'] });
  let frame = 0;
  const sample = () => {
    look();
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  onTestFinished(() => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  });
  return () => [...counts];
}

it.each(['desktop', 'phone'] as const)('opening_a_conversation_keeps_one_heading at %s', async (viewport) => {
  const { screen, router } = await renderRoute(CONVERSATIONS, { viewport, pollScale: 100 });
  await expect.element(screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link').first()).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const chat = holdReads(conversationRead(SEEDED_HOLD));
  const headings = watchTopHeadings();
  await router.navigate(`${CONVERSATIONS}/${SEEDED_HOLD}`);
  await vi.waitFor(() => expect(document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeInTheDocument();
  chat.release();
  await expect.element(screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  await nextFrames();
  // Waiting, shown, fading and landed: one top heading each time, never none and never two.
  expect(headings()).toEqual([1]);
  await expectScreenBasics(document.body, { owner: true });
});

it.each([620, 700])('customers_reload_draws_the_subtitles_own_lines at %i px', async (width) => {
  // Between the phone and the laptop, the subtitle wraps by its words in this browser's fonts, not
  // by a count read off one machine, so the list under it starts where its shapes did.
  const desks = holdReads(ROUTES.desks.path);
  const people = holdReads(PEOPLE_READ);
  const { screen } = await renderRoute(PEOPLE, { viewport: { width, height: 900 }, pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  const drawn = [...document.querySelectorAll(`${FULL_LAYER} .cd-page-header__subtitle .cd-skeleton-line`)].filter((line) => line.getClientRects().length > 0);
  // Measured from the page's top: at this width the frame's own shapes (the reviewer bar) sit a few
  // pixels off the landed frame, which is the frame's skeleton, not Customers'.
  const shapePage = document.querySelector(`${FULL_LAYER} .cd-people`)!.getBoundingClientRect();
  const [head] = fullPageShapes(['people-head']);
  desks.release();
  people.release();
  await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const subtitle = landedElement('.cd-page-header__subtitle')!;
  const lines = Math.round(subtitle.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(subtitle).lineHeight));
  expect(drawn, 'the skeleton draws the subtitle in as many lines as its words take').toHaveLength(lines);
  const real = landedElement('.cd-people__head .cd-section-header__heading')!.getBoundingClientRect();
  const page = landedElement('.cd-people')!.getBoundingClientRect();
  expect(Math.abs(real.top - page.top - (head!.top - shapePage.top)), 'the list starts where its shapes did').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
});
