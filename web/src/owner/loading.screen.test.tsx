import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cleanup } from 'vitest-browser-react';
import { useRef } from 'react';
import { useTextLines } from '../lib/useTextLines.ts';
import { page } from 'vitest/browser';

import { newIdempotencyKey, observeRequests, OWNER_ERROR_COPY, TIMEOUT_MS } from '../api/http.ts';
import { ROUTES } from '../api/routes.ts';
import type { SetupState } from '../api/views.ts';
import { retryDelayMs } from '../app/poll.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { bandCentres } from '../ds/test/skeletonSweep.tsx';
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

it('text_measurement_keeps_fractional_content_width_and_requests_its_font', async () => {
  const words = 'Wrap these words exactly';
  const host = document.createElement('div');
  document.body.append(host);
  const probe = document.createElement('span');
  probe.className = 'cd-type-body';
  probe.style.display = 'block';
  probe.style.width = 'max-content';
  probe.textContent = words;
  host.append(probe);
  const natural = probe.getBoundingClientRect().width;
  const spacing = (Math.ceil(natural) + 0.25 - natural) / words.length;
  host.style.letterSpacing = `${spacing}px`;
  const width = probe.getBoundingClientRect().width + 0.05;
  probe.remove();
  const load = vi.spyOn(document.fonts, 'load');
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); load.mockRestore(); });
  function Measured() {
    const box = useRef<HTMLDivElement>(null);
    const summary = useRef<HTMLDivElement>(null);
    const lines = useTextLines(box, { parts: [words], className: 'cd-type-body' }, 1);
    useTextLines(summary, { parts: ['A measured serif summary'], className: 'cd-type-summary' }, 1);
    return <><div ref={box} style={{ width: width + 8, boxSizing: 'border-box', padding: 3, border: '1px solid transparent' }}>
      <p className="cd-type-body" style={{ margin: 0 }}>{words}</p>
    </div><div ref={summary} style={{ width }} /><output>{lines}</output></>;
  }
  flushSync(() => root.render(<Measured />));
  await nextFrames();
  expect(host.querySelector('p')!.getBoundingClientRect().height).toBe(20);
  expect(host.querySelector('output')!.textContent).toBe('1');
  expect(load.mock.calls.some(([, text]) => text === words)).toBe(true);
  expect(load.mock.calls.some(([, text]) => text === 'A measured serif summary'), 'request the serif face even when variation settings prevent font shorthand serialization').toBe(true);
  const box = host.querySelector('div')!;
  const append = vi.spyOn(box, 'append');
  onTestFinished(() => append.mockRestore());
  host.dataset.state = 'leaving';
  box.style.width = `${width + 108}px`;
  document.fonts.dispatchEvent(new Event('loadingdone'));
  await nextFrames();
  expect(append, 'font and resize events do not remeasure an outgoing layer').not.toHaveBeenCalled();
});

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

// These widths also compare every anchor's height during the fade and at replacement;
// the cases below check top and bottom independently after landing.
const TODAY_WIDTH_ANCHORS: readonly SkeletonAnchor[] = [
  ...TODAY_ANCHORS,
  { name: 'live-title', page: '.cd-today__section:has(.cd-live) .cd-section-header__heading' },
  { name: 'week-bar-6', page: '.cd-week__day:last-child .cd-week__bar' },
  { name: 'week-card', page: '.cd-today-aside > .cd-card:last-child', size: true },
].map((anchor) => ({ ...anchor, dimensions: ['height', ...(anchor.dimensions ?? [])] as const }));

it.each([320, 620, 820, 1024, 1279, 1512])('today_content_lands_in_place at %s', async (width) => {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await renderRoute(`/app/${RIVERA.deskId}/conversations`, {
    viewport: { width, height: 900 }, pollScale: 100,
  });
  await expect.element(screen.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const queryClient = mounted.mock.contexts.at(-1) as QueryClient;
  queryClient.removeQueries({ queryKey: todayKey(RIVERA.deskId) });
  queryClient.removeQueries({ queryKey: needsYouKey(RIVERA.deskId) });
  const reads = [ROUTES.today.path, ROUTES.needsYou.path].map((path) => holdReads(path.replace('{desk_id}', RIVERA.deskId)));
  onTestFinished(() => reads.forEach((read) => read.release()));
  const gaps = watchSkeletonGaps('.cd-greeting__title');
  let before: DOMRect[] = [];
  let footer: DOMRect;
  const anchors = TODAY_WIDTH_ANCHORS.filter(({ name }) => name !== 'owner-footer');
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors,
    stays: ['.cd-owner-layout__footer'],
    open: async () => { await router.navigate(TODAY); },
    release: () => {
      before = anchors.map(({ name }) => document.querySelector(`[data-skeleton-anchor="${name}"]`)!.getBoundingClientRect());
      footer = landedRect('.cd-owner-layout__footer');
      reads.forEach((read) => read.release());
    },
  });
  for (const [i, { name, page }] of anchors.entries()) {
    const after = landedRect(page);
    for (const edge of ['top', 'bottom'] as const) {
      expect(Math.abs(before[i]![edge] - after[edge]), `${name} ${edge}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    }
  }
  for (const edge of ['top', 'bottom'] as const) {
    expect(Math.abs(footer![edge] - landedRect('.cd-owner-layout__footer')[edge]), `footer ${edge}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
  }
  expect(gaps()).toBe(0);
  expectNoHorizontalScroll();
  expectNoWindowScroll();
});

it.each([320, 620, 820, 1024, 1279, 1512])('today_content_reload_lands_in_place at %s', async (width) => {
  const reads = [ROUTES.desks.path, ROUTES.today.path.replace('{desk_id}', RIVERA.deskId), ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId)].map(holdReads);
  onTestFinished(() => reads.forEach((read) => read.release()));
  const gaps = watchSkeletonGaps('.cd-greeting__title');
  let before: DOMRect[] = [];
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: TODAY_WIDTH_ANCHORS,
    open: async () => { await renderRoute(TODAY, { viewport: { width, height: 900 }, pollScale: 100 }); },
    release: () => {
      before = TODAY_WIDTH_ANCHORS.map(({ name }) => document.querySelector(`[data-skeleton-anchor="${name}"]`)!.getBoundingClientRect());
      reads.forEach((read) => read.release());
    },
  });
  for (const [i, { name, page }] of TODAY_WIDTH_ANCHORS.entries()) {
    const after = landedRect(page);
    for (const edge of ['top', 'bottom'] as const) {
      expect(Math.abs(before[i]![edge] - after[edge]), `${name} ${edge}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    }
  }
  expect(gaps()).toBe(0);
  expectNoHorizontalScroll();
  expectNoWindowScroll();
});

it.each(['desktop', 'phone'] as const)('today_paints_the_signed_pill_widths at %s', async (viewport) => {
  // Width recipes are frozen from bd2dd10d3, before wrapping measurement changed the painting.
  const desks = holdReads(ROUTES.desks.path);
  onTestFinished(desks.release);
  await renderRoute(TODAY, { viewport, pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  await nextFrames();
  const today = document.querySelector('.cd-today--skeleton')!;
  const lines = (selector: string, container: string, widths: readonly (string | number)[], height?: number) => {
    const room = today.querySelector(container)!.getBoundingClientRect();
    const boxes = [...today.querySelectorAll<HTMLElement>(selector)];
    expect(boxes, selector).toHaveLength(widths.length);
    boxes.forEach((box, i) => {
      const width = typeof widths[i] === 'number' ? widths[i] as number : room.width * Number.parseFloat(widths[i] as string) / 100;
      const rect = box.getBoundingClientRect();
      const pill = box.querySelector('.cd-skeleton-line__pill')!.getBoundingClientRect();
      expect(Math.abs(rect.width - width), `${selector} line ${i} box width`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
      expect(Math.abs(pill.width - width), `${selector} line ${i} painted width`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
      expect(Math.abs(pill.left - rect.left), `${selector} line ${i} pill alignment`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
      if (height !== undefined) expect(rect.height).toBe(height);
    });
  };
  lines('.cd-greeting .cd-skeleton-line--greeting', '.cd-today__main', ['100%'], 44);
  lines('.cd-greeting .cd-skeleton-line--body', '.cd-today__main', ['80%'], 22);
  expect(today.querySelector('.cd-greeting .cd-skeleton--block:not(.cd-today-skeleton__link)')).toBeNull();
  lines('.cd-things__head .cd-skeleton-line--section', '.cd-things__head', [85]);
  lines('.cd-things__caption .cd-skeleton-line', '.cd-things__caption', ['75%']);
  [2, 3, 3, 2].forEach((count, i) => {
    const item = `.cd-things__item:nth-child(${i + 1})`;
    lines(`${item} .cd-skeleton-line--control`, `${item} .cd-things__text`, ['90%']);
    lines(`${item} .cd-things__detail .cd-skeleton-line`, `${item} .cd-things__text`, Array.from({ length: count }, (_, j) => j === count - 1 ? '75%' : '100%'));
  });
  lines('.cd-things__vision .cd-skeleton-line', '.cd-things__vision', ['75%']);
  for (const child of [3, 4, 5]) lines(`.cd-today__section:nth-child(${child}) .cd-section-header .cd-skeleton-line--section`, `.cd-today__section:nth-child(${child}) .cd-section-header__title`, [135]);
  lines('[data-skeleton-anchor="held-card"] .cd-skeleton-line--caption', '.cd-today-skeleton__approval-top', ['80%']);
  lines('.cd-approval-card__reason .cd-skeleton-line', '.cd-approval-card__reason', viewport === 'phone' ? ['100%', '100%', '75%'] : ['100%', '100%']);
  lines('.cd-approval-card__context .cd-skeleton-line', '.cd-approval-card__context', ['100%', '75%']);
  lines('.cd-today-skeleton__rule .cd-skeleton-line', '.cd-today-skeleton__rule', viewport === 'phone' ? ['100%', '75%'] : ['100%']);
  lines('.cd-briefing__item:first-child .cd-briefing-row__words .cd-skeleton-line', '.cd-briefing__item:first-child .cd-briefing-row__words', ['100%', '100%', '75%']);
  lines('.cd-briefing__item:last-child .cd-briefing-row__words .cd-skeleton-line', '.cd-briefing__item:last-child .cd-briefing-row__words', ['75%']);
  for (const child of [1, 2]) {
    lines(`.cd-briefing__item:nth-child(${child}) .cd-skeleton-line--caption`, `.cd-briefing__item:nth-child(${child}) .cd-briefing-row`, [86]);
    lines(`.cd-briefing__item:nth-child(${child}) .cd-status-label .cd-skeleton-line`, `.cd-briefing__item:nth-child(${child}) .cd-status-label`, [58]);
  }
  lines('.cd-live .cd-skeleton-line--control', '.cd-conversation-item__top', ['55%']);
  lines('.cd-live .cd-skeleton-line--caption', '.cd-conversation-item__top', ['20%']);
  lines('.cd-today-aside__public .cd-skeleton-line--section', '.cd-today-aside__public', [130]);
  lines('.cd-today-aside__public .cd-skeleton-line--meta', '.cd-today-aside__public', ['65%', '100%', '75%']);
  lines('.cd-week__head .cd-skeleton-line', '.cd-week__head', [110]);
  lines('.cd-week__part:nth-child(2) .cd-skeleton-line--figure', '.cd-week__part:nth-child(2)', ['45%']);
  lines('.cd-week__part:nth-child(2) .cd-skeleton-line--meta', '.cd-week__part:nth-child(2)', ['70%']);
  for (let child = 1; child <= 7; child += 1) lines(`.cd-week__day:nth-child(${child}) .cd-skeleton-line`, `.cd-week__day:nth-child(${child})`, ['50%']);
  lines('.cd-week__part:nth-child(3) .cd-skeleton-line--control', '.cd-week__part:nth-child(3)', ['70%']);
  lines('.cd-week__part:nth-child(3) .cd-skeleton-line--meta', '.cd-week__part:nth-child(3)', ['100%']);
  lines('.cd-week__part:last-child .cd-skeleton-line--meta', '.cd-week__part:last-child', ['65%', '30%']);
  lines('.cd-week__part:last-child .cd-skeleton-line--control', '.cd-week__part:last-child', ['70%']);
});

it('today_reload_resizes_from_1440_to_620_before_landing', async () => {
  const reads = [ROUTES.desks.path, ROUTES.today.path.replace('{desk_id}', RIVERA.deskId), ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId)].map(holdReads);
  onTestFinished(() => reads.forEach((read) => read.release()));
  const gaps = watchSkeletonGaps('.cd-greeting__title');
  let before: DOMRect[] = [];
  await expectSkeletonLoad({
    status: 'Opening your Desk', anchors: TODAY_WIDTH_ANCHORS,
    open: async () => {
      await renderRoute(TODAY, { pollScale: 100 });
      await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      await page.viewport(620, 900);
      await nextFrames();
      // Text rewrapping can move shapes after the resize's first band placement.
      await vi.waitFor(() => {
        expect(window.innerWidth).toBe(620);
        const layer = document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]');
        expect(layer).not.toBeNull();
        const painted = [...layer!.querySelectorAll<HTMLElement>('.cd-skeleton')].filter((el) => el.getClientRects().length > 0);
        expect(painted.length).toBeGreaterThan(0);
        const { centres } = bandCentres(painted);
        expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
      }, { timeout: 2000 });
    },
    release: () => {
      before = TODAY_WIDTH_ANCHORS.map(({ name }) => document.querySelector(`[data-skeleton-anchor="${name}"]`)!.getBoundingClientRect());
      reads.forEach((read) => read.release());
    },
  });
  TODAY_WIDTH_ANCHORS.forEach(({ name, page: selector }, i) => {
    const after = landedRect(selector);
    for (const edge of ['top', 'bottom'] as const) expect(Math.abs(before[i]![edge] - after[edge]), `${name} ${edge} after resize`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
  });
  expect(gaps()).toBe(0);
});

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

it.each([390, 620])('reload_opens_on_the_frames_shape at %i', async (width) => {
  const reads = [
    ROUTES.desks.path,
    ROUTES.today.path.replace('{desk_id}', RIVERA.deskId),
    ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId),
  ].map(holdReads);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    // The intermediate width guards the frame; Today has its own content geometry.
    anchors: width === 620 ? PHONE_ANCHORS : [...PHONE_ANCHORS, ...TODAY_ANCHORS],
    open: async () => {
      await renderRoute(TODAY, { viewport: { width, height: width === 390 ? 844 : 900 }, pollScale: 100 });
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
