import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cleanup } from 'vitest-browser-react';
import { useRef } from 'react';
import { useTextLines } from '../lib/useTextLines.ts';
import { page } from 'vitest/browser';

import type { LedgerPage } from '../api/contracts.ts';
import { newIdempotencyKey, observeRequests, OWNER_ERROR_COPY, TIMEOUT_MS } from '../api/http.ts';
import { ROUTES } from '../api/routes.ts';
import type { ConversationSummary, SetupState, Suggestion } from '../api/views.ts';
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
import { needsYouKey, todayKey } from './useDesks.ts';
import { publicLink } from './customerLink.ts';
import { RulesSkeleton } from './rules/RulesSkeleton.tsx';
import { SUGGESTION_EXAMPLE } from './rules/copy.ts';
import { settled } from '../ds/test/settled.ts';
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
  // first section under the greeting (How your Desk works) had, and Things to try lands under it and
  // stays there.
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
  const shapeFirst = layer.querySelector('.cd-how')!.getBoundingClientRect();
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
  expect(Math.abs(card.element().getBoundingClientRect().top - shapeFirst.top), "the card takes How your Desk works' place").toBeLessThanOrEqual(
    SKELETON_TOLERANCE_PX,
  );
  expect(thingsTops(), 'Things to try lands once, under the card').toHaveLength(1);
  expect(thingsTops()[0]!).toBeGreaterThan(card.element().getBoundingClientRect().bottom);
  expect(cardsAdded.size, 'the card mounts once').toBe(1);
  expect(card.element().isConnected).toBe(true);
});

it('reload_opens_today_without_waiting_for_the_demo_inbox', async () => {
  // The Demo inbox is the demo bar's: Today opens with its read still out, the bar draws no inbox
  // button meanwhile (nor a line that it is opening), then draws it once the read is in.
  const inbox = holdReads(ROUTES.ownerInbox.path);
  onTestFinished(inbox.release);
  const { screen } = await renderRoute(TODAY, { pollScale: 100 });
  await vi.waitFor(() => expect(inbox.held()).toBe(1));
  await expect.element(screen.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  expect(document.querySelector('.cd-reviewer-bar .cd-owner-inbox')).toBeNull();
  expect(document.body.textContent).not.toContain('Opening your Demo inbox');
  inbox.release();
  const button = screen.getByRole('button', { name: 'Demo inbox 1 entry', exact: true });
  await expect.element(button).toBeVisible();
  expect(button.element().closest('.cd-reviewer-bar__actions')).not.toBeNull();
  expect(mockStore.requests.filter(({ key }) => key === 'ownerInbox')).toHaveLength(1);
});

/** The demo bar's Demo inbox, which the frame's shapes draw before Start over. */
const INBOX_ANCHOR: SkeletonAnchor = { name: 'inbox', page: '.cd-reviewer-bar .cd-owner-inbox > .cd-button', size: true };

it.each(['desktop', 'phone'] as const)('reload_lands_the_demo_inbox_in_the_bars_shape at %s', async (viewport) => {
  // The inbox is read with the Desks, so once it is in before them, the bar draws it with the frame,
  // where the frame's shapes drew it.
  const desks = holdReads(ROUTES.desks.path);
  onTestFinished(desks.release);
  await expectSkeletonLoad({
    status: 'Opening your Desk',
    anchors: [...(viewport === 'phone' ? PHONE_ANCHORS : WIDE_ANCHORS), INBOX_ANCHOR],
    open: async () => {
      await renderRoute(TODAY, { viewport, pollScale: 100 });
      await vi.waitFor(() => expect(desks.held()).toBe(1));
      await vi.waitFor(() => expect(mockStore.requests.filter(({ key }) => key === 'ownerInbox')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    release: desks.release,
  });
  expect(mockStore.requests.filter(({ key }) => key === 'ownerInbox')).toHaveLength(1);
});

const TODAY_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'owner-footer', page: '.cd-owner-layout__footer', size: true },
  { name: 'greeting', page: '.cd-greeting__title' },
  { name: 'link-pill', page: '.cd-greeting__link', dimensions: ['height'] },
  { name: 'header-action', page: '.cd-greeting__actions > .cd-button', size: true },
  // How your Desk works: its title, its card (the steps and the Today line), and the first and last step's tiles.
  { name: 'how-title', page: '.cd-how .cd-section-header__heading' },
  { name: 'how-card', page: '.cd-how > .cd-card', size: true },
  { name: 'how-tile-0', page: '.cd-how__step:first-child .cd-how__tile', size: true },
  { name: 'how-tile-2', page: '.cd-how__step:last-child .cd-how__tile', size: true },
  { name: 'things-title', page: '.cd-things__title' },
  { name: 'things-card', page: '.cd-things > .cd-card', size: true },
  { name: 'thing-tile-0', page: '.cd-things__item:first-child .cd-things__icon' },
  { name: 'thing-tile-3', page: '.cd-things__item:last-child .cd-things__icon' },
  { name: 'things-hide', page: '.cd-things__hide > .cd-button', size: true },
  ...[0, 1, 2, 3].map((i) => ({ name: `thing-action-${i}`, page: `.cd-things__item:nth-child(${i + 1}) .cd-things__action > .cd-button`, size: true })),
  // A phone row's chevron (not drawn from 640 px, as the cards' buttons aren't on a phone).
  ...[0, 1, 2, 3].map((i) => ({ name: `thing-go-${i}`, page: `.cd-things__item:nth-child(${i + 1}) .cd-things__go`, size: true })),
  { name: 'needs-title', page: '.cd-today__section[tabindex] .cd-section-header__heading' },
  { name: 'held-card', page: '.cd-needs-you .cd-card', dimensions: ['width'] },
  { name: 'live-row', page: '.cd-live .cd-conversation-item', size: true },
  { name: 'since-title', page: '.cd-today__main > .cd-today__section:last-child .cd-section-header__heading' },
  { name: 'since-card', page: '.cd-today__main > .cd-today__section:last-child > .cd-card', size: true },
  { name: 'week-title', page: '.cd-today-aside .cd-section-header__heading' },
  { name: 'week-bar-0', page: '.cd-week__bar' },
];
const TODAY_CONTENT_ANCHORS = TODAY_ANCHORS.filter(({ name }) => name !== 'owner-footer');

// These widths also compare every anchor's height during the fade and at replacement;
// the cases below check top and bottom independently after landing.
const TODAY_WIDTH_ANCHORS: readonly SkeletonAnchor[] = [
  ...TODAY_ANCHORS,
  { name: 'live-title', page: '.cd-today__section:has(.cd-live) .cd-section-header__heading' },
  { name: 'week-bar-6', page: '.cd-week__day:last-child .cd-week__bar' },
  { name: 'week-card', page: '.cd-today-aside .cd-today__section > .cd-card', size: true },
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

it('today_night_line_lands_in_place_near_its_wrap', async () => {
  // At 829 px the fresh copy's night line fits its card on two lines, and 16 px narrower it would
  // need three: the shape measures the line at the paragraph's own width, so it reserves two lines,
  // and the card lands where it was drawn.
  const width = 829;
  const reads = [ROUTES.desks.path, ROUTES.today.path.replace('{desk_id}', RIVERA.deskId), ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId)].map(holdReads);
  onTestFinished(() => reads.forEach((read) => read.release()));
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
  // This width is near the wrap: the landed line's lines at its width, and at 16 px narrower.
  const line = [...document.querySelectorAll<HTMLElement>('.cd-since__line')].find((el) => el.closest('.cd-skeleton-screen__layer') === null)!;
  const style = getComputedStyle(line);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const content = line.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  const narrower = document.createElement('p');
  narrower.className = 'cd-type-summary';
  Object.assign(narrower.style, { position: 'absolute', visibility: 'hidden', margin: '0', width: `${content - 16}px` });
  narrower.textContent = line.textContent;
  line.after(narrower);
  onTestFinished(() => narrower.remove());
  expect(Math.round(line.getBoundingClientRect().height / lineHeight), 'the line at its own width').toBe(2);
  expect(Math.round(narrower.getBoundingClientRect().height / lineHeight), 'the line 16 px narrower').toBe(3);
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
  lines('.cd-greeting .cd-skeleton-line--greeting', '.cd-greeting__text', ['100%'], 44);
  lines('.cd-greeting .cd-skeleton-line--body', '.cd-greeting__text', ['80%'], 22);
  expect(today.querySelector('.cd-greeting .cd-skeleton--block:not(.cd-today-skeleton__link, .cd-today-skeleton__action)')).toBeNull();
  lines('.cd-things__head .cd-skeleton-line--section', '.cd-things__head', [85]);
  lines('.cd-things__caption .cd-skeleton-line', '.cd-things__caption', ['75%']);
  // Each card's line wraps in its quarter of the band on a laptop; each row's beside its tile and chevron on a phone.
  (viewport === 'phone' ? [2, 3, 3, 3] : [2, 4, 4, 3]).forEach((count, i) => {
    const item = `.cd-things__item:nth-child(${i + 1})`;
    lines(`${item} .cd-skeleton-line--control`, `${item} .cd-things__text`, ['90%']);
    lines(`${item} .cd-things__detail .cd-skeleton-line`, `${item} .cd-things__text`, Array.from({ length: count }, (_, j) => j === count - 1 ? '75%' : '100%'));
  });
  lines('.cd-things__vision .cd-skeleton-line', '.cd-things__vision', ['75%']);
  for (const child of [1, 2, 3]) lines(`.cd-today__main > .cd-today__section:nth-child(${child}) .cd-section-header .cd-skeleton-line--section`, `.cd-today__main > .cd-today__section:nth-child(${child}) .cd-section-header__title`, [135]);
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
  // "Last 7 days" is a section title, as Needs you's is.
  lines('.cd-today-aside .cd-section-header .cd-skeleton-line--section', '.cd-today-aside .cd-section-header__title', [135]);
  lines('.cd-week__part:nth-child(1) .cd-skeleton-line--figure', '.cd-week__part:nth-child(1)', ['45%']);
  lines('.cd-week__part:nth-child(1) .cd-skeleton-line--meta', '.cd-week__part:nth-child(1)', ['70%']);
  for (let child = 1; child <= 7; child += 1) lines(`.cd-week__day:nth-child(${child}) .cd-skeleton-line`, `.cd-week__day:nth-child(${child})`, ['50%']);
  lines('.cd-week__part:nth-child(2) .cd-skeleton-line--control', '.cd-week__part:nth-child(2)', ['70%']);
  lines('.cd-week__part:nth-child(2) .cd-skeleton-line--meta', '.cd-week__part:nth-child(2)', ['100%']);
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
      // The app shell drops its sidebar here; the skeleton re-places its bands on the next frame.
      await nextFrames();
      expect(window.innerWidth).toBe(620);
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
const UNDER_THINGS_ON_A_PHONE = [...UNDER_THINGS, 'week-title', 'week-bar-0'];

function switchedAnchors(phone: boolean): SkeletonAnchor[] {
  const ticked = ['thing-tile-3', 'thing-action-3', 'thing-go-3'];
  // From 640 px the cards of a row share its height, so the ticked card moves nothing.
  if (!phone) return TODAY_CONTENT_ANCHORS.filter(({ name }) => !ticked.includes(name));
  const under = new Set(UNDER_THINGS_ON_A_PHONE);
  return TODAY_CONTENT_ANCHORS.filter(({ name }) => !under.has(name) && !ticked.includes(name)).map((anchor) =>
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
  ...Array.from({ length: 8 }, (_, i) => ({ name: `page-row-${i + 1}`, page: `.cd-sidebar__nav > a:nth-child(${i + 2})` })),
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
    anchors: switchedAnchors(false),
    stays: ['.cd-reviewer-bar', '.cd-sidebar'],
    open: async () => {
      await screen.getByRole('button', { name: 'Switch Desk, current: Emergencies' }).click();
      await screen.getByRole('button', { name: 'Main line', exact: true }).click();
    },
    release: () => reads.forEach((read) => read.release()),
  });
  // The last card lands ticked in the shape's place: its row of cards keeps its height.
  const last = [...document.querySelectorAll('.cd-things__item:last-child')].find((el) => el.closest('.cd-skeleton-screen__layer') === null);
  expect(last?.textContent).toContain('Done. Your new Desk is live.');
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

it.each(['today', 'needsYou'] as const)('paused_today_reads_land_their_own_errors before %s starts', async (route) => {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await renderRoute(TODAY, { pollScale: 100 });
  await expect.element(screen.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const queryClient = mounted.mock.contexts.at(-1) as QueryClient;
  await router.navigate(`/app/${RIVERA.deskId}/conversations`);
  await expect.element(screen.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  const key = route === 'today' ? todayKey(RIVERA.deskId) : needsYouKey(RIVERA.deskId);
  queryClient.removeQueries({ queryKey: key });
  const read = holdReads(ROUTES[route].path.replace('{desk_id}', RIVERA.deskId));
  onTestFinished(read.release);
  const sent = mockStore.requests.filter(({ key }) => key === route).length;
  onlineManager.setOnline(false);
  onTestFinished(() => onlineManager.setOnline(true));
  await router.navigate(TODAY);
  await vi.waitFor(() => expect(queryClient.getQueryState(key)?.fetchStatus).toBe('paused'));
  const section = screen.getByRole('region', { name: route === 'today' ? 'Since last night' : 'Needs you', exact: true });
  const line = OWNER_ERROR_COPY.network;
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
    anchors: switchedAnchors(false),
    open: async () => { await router.navigate(TODAY); },
    release: () => needsYou.release(),
  });
  // From 640 px the ticked card keeps its row's height, so everything lands in its shape's place.
  const last = [...document.querySelectorAll('.cd-things__item:last-child')].find((el) => el.closest('.cd-skeleton-screen__layer') === null);
  expect(last?.textContent).toContain('Done. Your new Desk is live.');
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
  // A laptop's width, where the cards draw their buttons (a phone row draws a chevron instead).
  await page.viewport(1440, 900);
  const host = document.createElement('div');
  host.style.letterSpacing = '0.2em';
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); });
  flushSync(() => root.render(<><div data-real-control><Button variant="secondary" href="/d/turner-plumbing-abc123">Open your public page</Button></div><TodaySkeleton /></>));
  const real = host.querySelector('[data-real-control] .cd-button')!;
  const shape = host.querySelector('[data-skeleton-anchor="thing-action-0"]')!;
  expect(shape.textContent).toBe('');
  await expect.poll(() => Math.abs(shape.getBoundingClientRect().width - real.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
});

it('reload_changes_only_the_link_pills_width_once', async () => {
  // The slug comes from the held read, so its width differs from the fresh-copy placeholder.
  mockStore.world.desk(RIVERA.deskId)!.summary.slug = 'turner-plumbing-a-new-random-slug';
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
    await expect.element(screen.getByRole('heading', { name: /Good .*Mike/ })).toBeVisible();
    await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
    const real = document.querySelector('.cd-greeting__link')!.getBoundingClientRect();
    // The pill ends where its shape ended, "Chat as a customer" after it at the band's right: a wider
    // link grows to the left.
    for (const edge of ['top', 'right', 'height'] as const) expect(Math.abs(real[edge] - shape[edge])).toBeLessThanOrEqual(2);
    const sizing = document.createElement('div');
    Object.assign(sizing.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' });
    sizing.inert = true;
    document.body.append(sizing);
    const reference = createRoot(sizing);
    try {
      flushSync(() => reference.render(<Greeting text="" link={{ label: publicLink('turner-plumbing-abc123'), onCopy: () => {} }} />));
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

it('failed_demo_inbox_read_says_so_in_its_sheet', async () => {
  // The first read fails, and so does its one retry: the bar draws the inbox's button with no count,
  // and its sheet holds the line with Try again, never an inbox that looks empty.
  mockStore.inject({ route: 'ownerInbox', status: 500, times: 2 });
  const { screen } = await renderRoute(TODAY, { pollScale: 100, retryScale: 0 });
  const button = screen.getByRole('button', { name: 'Demo inbox', exact: true });
  await expect.element(button).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(mockStore.requests.filter(({ key }) => key === 'ownerInbox')).toHaveLength(2);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Opening your Demo inbox');
  // The sheet's own read as it opens fails too.
  mockStore.inject({ route: 'ownerInbox', status: 500, times: 2 });
  await button.click();
  const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
  await expect.element(sheet.getByRole('alert').getByText(/^Couldn't open your Demo inbox\./), { timeout: 4_000 }).toBeVisible();
  expect(sheet.element().querySelector('.cd-demo-inbox__empty')).toBeNull();
  await sheet.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.element(sheet.getByRole('alert')).not.toBeInTheDocument();
  await expect.element(sheet.getByRole('list')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect.element(screen.getByRole('button', { name: 'Demo inbox 1 entry', exact: true })).toBeVisible();
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
 * A fresh copy's list, which replays recorded history into the copy: the mock's own list with
 * another chat marked replayed, so the page says "Includes recorded history" under its title while
 * the held chat stays live, with the owner controls the pane's loading tests exercise.
 */
async function withRecordedHistory(now = new Date()): Promise<void> {
  const answer = await mockStore.dispatch('conversations', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the conversations');
  const list = answer.body as ConversationSummary[];
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
  });
  const date = clock.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(date.find(part => part.type === type)!.value);
  const utcNoon = Date.UTC(part('year'), part('month') - 1, part('day'), 12);
  // At UTC noon, Turner's clock is already past either daylight-saving change. Its hour tells
  // how far forward local noon is, using that day's offset rather than the offset at midnight.
  const hour = Number(clock.formatToParts(new Date(utcNoon)).find(part => part.type === 'hour')!.value);
  const noon = utcNoon + (12 - hour) * 3_600_000;
  mockStore.inject({
    route: 'conversations',
    status: 200,
    times: 10_000,
    // Keep all three rows on Today even around midnight, preserving the seed's order.
    body: list.map((s, i) => ({ ...s, last_activity: new Date(noon - i * 1_000).toISOString(), ...(s.session_id === 'ses-dana-web' ? { replayed: true } : {}) })),
  });
}

it('recorded_history_stays_on_riveras_day_at_midnight_and_clock_changes', async () => {
  // Explicit inputs exercise day boundaries without changing the browser's real clock. Normal
  // screen fixtures use the current date, even when the machine's own date differs from Turner's.
  for (const [at, noon] of [
    ['2026-11-01T07:00:00.500Z', '2026-11-01T20:00:00.000Z'],
    ['2026-11-01T07:00:01.500Z', '2026-11-01T20:00:00.000Z'],
    ['2026-03-08T08:00:00.500Z', '2026-03-08T19:00:00.000Z'],
    ['2026-11-02T07:59:59.500Z', '2026-11-01T20:00:00.000Z'],
  ] as const) {
    mockStore.reset('rivera');
    await withRecordedHistory(new Date(at));
    const answer = await mockStore.dispatch('conversations', { params: { desk_id: RIVERA.deskId } });
    if ('network' in answer || answer.status !== 200) throw new Error('the mock reads recorded conversations');
    const rows = answer.body as ConversationSummary[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(row => row.last_activity), at).toEqual(
      rows.map((_, i) => new Date(new Date(noon).getTime() - i * 1_000).toISOString()),
    );
  }
});

/** The list's parts the skeleton draws: the caption, the first day, and the seed's first and last rows. */
const LIST_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'conversations-caption', page: '.cd-conversations__caption' },
  { name: 'conversations-day-0', page: '.cd-conversations__day' },
  { name: 'conversation-row-0', page: '.cd-conversations__items > li:first-child > .cd-conversation-item', size: true },
  { name: 'conversation-row-1', page: '.cd-conversations__items > li:nth-child(2) > .cd-conversation-item', size: true },
  { name: 'conversation-row-2', page: '.cd-conversations__items > li:nth-child(3) > .cd-conversation-item', size: true },
];

/** Each part of the fresh copy's held chat, by the shape that stands for it and the part itself. */
const CHAT_PARTS = {
  name: { name: 'conversation-name', page: '.cd-conversation__name', dimensions: ['height', 'bottom'] },
  head: { name: 'conversation-about', page: '.cd-conversation .cd-conversation__head > .cd-conversation__about', dimensions: ['height', 'bottom'] },
  visitor: { name: 'first-message', page: '.cd-conversation .cd-transcript .cd-visitor-message', dimensions: ['height', 'bottom'] },
  reply: { name: 'reply-card', page: '.cd-conversation .cd-transcript .cd-reply-card', dimensions: ['height', 'bottom'] },
  receipt0: { name: 'receipt-0', page: '.cd-conversation .cd-transcript .cd-transcript-row__margin > :first-child', dimensions: ['height', 'bottom'] },
  receipt1: { name: 'receipt-1', page: '.cd-conversation .cd-transcript .cd-transcript-row__margin > :nth-child(2)', dimensions: ['height', 'bottom'] },
  held: { name: 'held-card', page: '.cd-conversation .cd-transcript > .cd-conversation__held', dimensions: ['height', 'bottom'] },
} as const satisfies Record<string, SkeletonAnchor>;

/**
 * In a wide window a fresh copy's held chat fits its region and opens at its top: every part of it
 * is in view as it lands, so each one's top, bottom and height and each receipt line
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
 * more than 2 px on its top, bottom, left or height. `expectStill` checks every frame it saw.
 */
function watchPaneLanding(anchors: readonly SkeletonAnchor[], layerSelector = '.cd-conversation-pane .cd-skeleton-screen__layer') {
  let shapes: DOMRect[] | null = null;
  const worst = anchors.map(() => ({ top: 0, left: 0, height: 0, bottom: 0 }));
  let frames = 0;
  const look = () => {
    const layer = document.querySelector<HTMLElement>(layerSelector);
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
      for (const edge of ['top', 'left', 'height', 'bottom'] as const) worst[i]![edge] = Math.max(worst[i]![edge], Math.abs(box[edge] - shapes![i]![edge]));
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
      anchors.forEach(({ name, page }, i) => {
        expect(landedElement(page), `${name} landed`).not.toBeNull();
        for (const edge of ['top', 'left', 'height', 'bottom'] as const) {
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

it.each([[1440, 900], [1800, 1009], [390, 844]])('conversation_loading_column_matches_the_drawn_column_at_%sx%s', async (width, height) => {
  const chat = holdReads(conversationRead(SEEDED_HOLD));
  onTestFinished(chat.release);
  const { screen } = await renderRoute(`${CONVERSATIONS}/${SEEDED_HOLD}`, { viewport: { width, height }, pollScale: 100 });
  const shape = '.cd-conversation-pane .cd-conversation-skeleton';
  await vi.waitFor(() => expect(document.querySelector(shape)).not.toBeNull());
  const pane = document.querySelector('.cd-conversations__open')!.getBoundingClientRect();
  const expectedWidth = Math.min(768, pane.width - (width >= 1024 ? 56 : 32));
  const bounds = (selector: string) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  };
  const before = ['.cd-conversation__head', '.cd-transcript-row', '.cd-conversation__controls'].map(part => {
    const rect = bounds(`${shape} ${part}`);
    expect(Math.abs(rect.width - expectedWidth), `${part} shape width`).toBeLessThanOrEqual(1);
    expect(Math.abs((rect.left - pane.left) - (pane.right - rect.right)), `${part} shape centred`).toBeLessThanOrEqual(1);
    return rect;
  });
  chat.release();
  await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector(shape)).toBeNull());
  ['.cd-conversation__head', '.cd-transcript-row', '.cd-conversation__controls'].forEach((part, i) => {
    const rect = bounds(`.cd-conversation-pane ${part}`);
    for (const edge of ['left', 'right', 'width'] as const) expect(Math.abs(rect[edge] - before[i]![edge]), `${part} ${edge}`).toBeLessThanOrEqual(1);
  });
  expectNoHorizontalScroll();
});

it('conversation_shapes_follow_the_answer_buttons_height', async () => {
  // Change the real answer rule only. Shapes must measure it rather than repeat its height.
  const style = document.createElement('style');
  style.textContent = '.cd-approval-card__row .cd-button { min-height: 60px !important; }';
  document.head.append(style);
  onTestFinished(() => style.remove());
  const chat = holdReads(conversationRead(SEEDED_HOLD));
  const landing = watchPaneLanding(PHONE_PANE_ANCHORS);
  await expectSkeletonLoad({
    status: 'Opening the conversation',
    anchors: PHONE_PANE_ANCHORS,
    open: async () => {
      await renderRoute(`${CONVERSATIONS}/${SEEDED_HOLD}`, { viewport: 'phone', pollScale: 100 });
    },
    release: chat.release,
  });
  await landing.expectStill();
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
  const failed = screen.getByRole('region', { name: 'Visitor', exact: true }).getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true });
  await expect.element(failed).toBeVisible();
  expect(screen.getByRole('navigation', { name: 'Conversations' }).getByRole('alert').elements()).toHaveLength(0);
  expect(screen.getByRole('alert').elements()).toHaveLength(1);
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


const RULES = `/app/${RIVERA.deskId}/rules`;
const RULES_READ = ROUTES.rules.path.replace('{desk_id}', RIVERA.deskId);
/** A Desk with enough owner approvals for the API to suggest a refund rule. */
const APPROVED_REFUND_SUGGESTION: Suggestion = {
  tool: 'payments.create_refund', count: 3,
  text: SUGGESTION_EXAMPLE,
  card: { ...rivera.ruleCards['rv-refund'], card_id: 'card-dana-refunds', mode: 'auto', who: 'person', person_id: rivera.people.dana.personId, max_amount_cents: 5_000 },
};

const RULES_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'rules-jobs-title', page: '.cd-business-jobs__title', size: true },
  { name: 'rules-job', page: '.cd-business-jobs > .cd-card', size: true },
  ...[
    ['rules-job-name', '.cd-tool-rules__tool-name'],
    ['rules-job-description', '.cd-tool-rules__tool-description'],
    ['rules-job-reason', '.cd-rule-row__reason'],
    ['rules-job-words', '.cd-rule-row__words'],
    ['rules-job-outcome', '.cd-outcome'],
    ['rules-job-fallback', '.cd-tool-rules__fallback-line'],
  ].map(([name, selector]) => ({ name: name!, page: `.cd-business-jobs ${selector}`, size: true })),
  ...rivera.connectors.sections.flatMap(({ tools }, i) => [
    { name: `rules-connector-${i}`, page: `.cd-connector-list__items > :nth-child(${i + 1}) .cd-connector-section__header`, dimensions: ['bottom', 'height'] as const },
    ...tools.map((_, j) => ({ name: `rules-tool-${i}-${j}`, page: `.cd-connector-list__items > :nth-child(${i + 1}) .cd-connector-section__tool:nth-child(${j + 1})`, size: true, dimensions: ['bottom'] as const })),
  ]),
  { name: 'rules-all', page: '.cd-rules__all', dimensions: ['bottom', 'height'] },
  { name: 'rules-always', page: '.cd-always-on .cd-section-header__heading', dimensions: ['bottom', 'height'] },
];

it('rules_outcome_shapes_remeasure_when_fonts_become_ready', async () => {
  let ready!: (fonts: FontFaceSet) => void;
  const pending = new Promise<FontFaceSet>((resolve) => { ready = resolve; });
  const fonts = vi.spyOn(document.fonts, 'ready', 'get').mockReturnValue(pending);
  onTestFinished(() => fonts.mockRestore());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); ready(document.fonts); });
  flushSync(() => root.render(<RulesSkeleton withHeader={false} />));
  const outcome = host.querySelector<HTMLElement>('.cd-connector-section__tool-outcome')!;
  const shape = outcome.querySelector<HTMLElement>('.cd-skeleton')!;
  const before = Number.parseFloat(shape.style.width);
  expect(before).toBeGreaterThan(0);
  // A changed font metric becomes available with fonts.ready, without a loadingdone event.
  host.className = 'cd-test-rules-fonts';
  const style = document.createElement('style');
  style.textContent = '.cd-test-rules-fonts .cd-connector-section__tool-outcome { font-size: 24px; }';
  document.head.append(style);
  onTestFinished(() => style.remove());
  ready(document.fonts);
  await vi.waitFor(() => expect(Number.parseFloat(shape.style.width)).toBeGreaterThan(before));
});

it.each(['desktop', 'phone'] as const)('rules_load_in_place at %s', async (viewport) => {
  const { screen, router } = await openToday(viewport);
  const read = holdReads(RULES_READ);
  const landing = watchPaneLanding(RULES_ANCHORS, '.cd-rules__region .cd-skeleton-screen__layer');
  const headings = watchTopHeadings();
  await expectSkeletonLoad({
    status: 'Reading your rules', anchors: RULES_ANCHORS,
    stays: ['.cd-rules__header', '.cd-rules__ask', '.cd-owner-layout__footer'],
    open: async () => {
      await router.navigate(RULES);
      await vi.waitFor(() => expect(document.querySelector('.cd-rules__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      expect(document.querySelector('.cd-rules__region .cd-skeleton-screen__layer .cd-rules__suggestions')).toBeNull();
    }, release: read.release,
  });
  await landing.expectStill();
  expect(screen.getByRole('button', { name: 'Draft this rule' }).elements()).toHaveLength(0);
  expect(headings()).toEqual([1]);
  expectNoHorizontalScroll();
  await expectScreenBasics(document.body, { owner: true });
});

const SAFETY = `/app/${RIVERA.deskId}/safety`;
const LEDGER_READ = ROUTES.ledger.path.replace('{desk_id}', RIVERA.deskId);
/** The fresh copy replays the record; the bare mock seed has no replay markers. */
async function withFreshRecord() {
  const answer = await mockStore.dispatch('ledger', { params: { desk_id: RIVERA.deskId }, query: { verify: 'true' } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the record');
  const page = answer.body as LedgerPage;
  mockStore.inject({ route: 'ledger', status: 200, times: 10_000, body: {
    ...page, entries: page.entries.map(entry => ({ ...entry, event: { ...entry.event, summary: { ...entry.event.summary, replayed: { at: entry.created_at } } } })),
  } });
}

const SAFETY_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'safety-headline', page: '.cd-safety__headline', dimensions: ['bottom', 'height'] },
  { name: 'safety-chain', page: '.cd-chain-status', size: true, dimensions: ['bottom'] },
  { name: 'safety-view', page: '.cd-safety__bar .cd-segmented', size: true, dimensions: ['bottom'] },
  { name: 'safety-filters', page: '.cd-attempts__filters', size: true, dimensions: ['bottom'] },
  { name: 'safety-row-0', page: '.cd-attempt-row', size: true, dimensions: ['bottom'] },
  { name: 'safety-detail', page: '.cd-safety__opened > .cd-card', size: true, dimensions: ['bottom'] },
  ...[
    ['safety-detail-status', '.cd-attempt__status'], ['safety-detail-title', '.cd-attempt__reason'],
    ['safety-claim', '.cd-attempt__claim'], ['safety-origin', '.cd-attempt__origin'],
    ['safety-replayed', '.cd-attempt__what .cd-attempt__origin:last-child'],
    ['safety-summary-label', '.cd-attempt__label'], ['safety-summary', '.cd-attempt__summary'],
    ['safety-toggle-0', '.cd-attempt__toggle:first-child'], ['safety-toggle-1', '.cd-attempt__toggle:nth-of-type(2)'],
    ['safety-conversation', '.cd-attempt__conversation'],
  ].map(([name, page]) => ({ name: name!, page: page!, dimensions: ['bottom', 'height'] as const })),
];

it.each(['desktop', 'phone'] as const)('safety_load_in_place at %s', async (viewport) => {
  await withFreshRecord();
  const { screen, router } = await renderRoute(PEOPLE, { viewport, pollScale: 100 });
  await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const ledger = holdReads(LEDGER_READ);
  const landing = watchPaneLanding(SAFETY_ANCHORS, '.cd-safety__region .cd-skeleton-screen__layer');
  const headings = watchTopHeadings();
  await expectSkeletonLoad({
    status: 'Reading what was stopped',
    anchors: SAFETY_ANCHORS,
    stays: ['.cd-safety > .cd-page-header', '.cd-owner-layout__footer'],
    open: async () => { await router.navigate(SAFETY); }, release: ledger.release,
  });
  await landing.expectStill();
  expect(headings()).toEqual([1]);
  expectNoHorizontalScroll();
  await expectScreenBasics(document.body, { owner: true });
});

it.each([
  { label: 'rules', path: RULES, read: RULES_READ, region: '.cd-rules__region', status: 'Reading your rules', anchors: RULES_ANCHORS, until: '.cd-rules__all' },
  { label: 'safety', path: SAFETY, read: LEDGER_READ, region: '.cd-safety__region', status: 'Reading what was stopped', anchors: SAFETY_ANCHORS, until: '.cd-attempt-row' },
].flatMap(item => (['desktop', 'phone'] as const).map(viewport => ({ ...item, viewport }))))('$label reload hands off without a gap at $viewport', async ({ path, read, region, status, anchors, until, viewport }) => {
  if (path === SAFETY) await withFreshRecord();
  const desks = holdReads(ROUTES.desks.path);
  const pageRead = holdReads(read);
  const gaps = watchSkeletonGaps(until);
  const { screen } = await renderRoute(path, { viewport, pollScale: 100 });
  const headings = watchTopHeadings();
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  if (path === RULES) expect(document.querySelector(`${FULL_LAYER} .cd-rules__suggestions`)).toBeNull();
  const names = anchors.map(({ name }) => name);
  const before = fullPageShapes(names);
  const [footer] = fullPageShapes(['owner-footer']);
  await expectSkeletonLoad({
    status, anchors, continues: true,
    open: async () => {
      desks.release();
      await vi.waitFor(() => expect(document.querySelector(`${region} .cd-skeleton-screen__layer[data-state="shown"]`)).not.toBeNull());
      expectSameShapes(region, names, before);
      const realFooter = landedElement('.cd-owner-layout__footer')!.getBoundingClientRect();
      for (const edge of ['top', 'bottom', 'left', 'width', 'height'] as const) {
        expect(Math.abs(footer![edge] - realFooter[edge]), `footer ${edge} across the hand-off`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
      }
    },
    release: pageRead.release,
  });
  expect(gaps()).toBe(0);
  expect(headings()).toEqual([1]);
  await expectScreenBasics(screen.container, { owner: true });
});

it.each([1440, 800, 390])('safety_reload_keeps_the_held_header_in_place_at_%i', async (width) => {
  const desks = holdReads(ROUTES.desks.path);
  onTestFinished(desks.release);
  const { screen } = await renderRoute(SAFETY, { viewport: { width, height: width === 390 ? 844 : 900 }, pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  await nextFrames();
  const before = fullPageShapes(['safety-headline'])[0]!;
  desks.release();
  await expect.element(screen.getByRole('link', { name: '1 held for you', exact: true })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const header = landedElement('.cd-safety > .cd-page-header')!;
  const subtitle = header.querySelector('.cd-page-header__subtitle')!.getBoundingClientRect();
  const action = header.querySelector('.cd-page-header__actions')!.getBoundingClientRect();
  if (width === 800) expect(action.top, 'the held request wraps below the subtitle').toBeGreaterThan(subtitle.bottom);
  const after = landedElement('.cd-safety__headline')!.getBoundingClientRect();
  expect(Math.abs(after.top - before.top), `headline top: skeleton ${before.top}, loaded ${after.top}`).toBeLessThanOrEqual(1);
  expectNoHorizontalScroll();
});

it('safety_view_switch_keeps_focus', async () => {
  const { screen, router } = await renderRoute(SAFETY, { pollScale: 100 });
  const stopped = screen.getByRole('radio', { name: 'Stopped', exact: true });
  const entries = screen.getByRole('radio', { name: 'Every entry', exact: true });
  await expect.element(stopped).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const layers = watchLayers();
  (stopped.element() as HTMLElement).focus();
  const { userEvent } = await import('vitest/browser');
  await userEvent.keyboard('{ArrowRight}');
  await expect.element(entries).toHaveFocus();
  expect(router.state.location.search).toBe('?view=entries');
  await userEvent.keyboard('{ArrowLeft}');
  await expect.element(stopped).toHaveFocus();
  await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
  await nextFrames();
  expect(layers()).toBe(0);
});

it('safety_switching_from_entries_during_first_reads_keeps_the_same_focused_control', async () => {
  const health = holdReads(ROUTES.health.path);
  const { screen } = await renderRoute(`${SAFETY}?view=entries`, { pollScale: 100 });
  await vi.waitFor(() => expect(health.held()).toBe(1));
  const entries = screen.getByRole('radio', { name: 'Every entry', exact: true });
  const stopped = screen.getByRole('radio', { name: 'Stopped', exact: true });
  await expect.element(entries).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const stoppedNode = stopped.element();
  const region = document.querySelector('.cd-safety__region');
  const layers = watchLayers();
  (entries.element() as HTMLElement).focus();
  const { userEvent } = await import('vitest/browser');
  await userEvent.keyboard('{ArrowLeft}');
  await nextFrames();
  expect(stoppedNode.isConnected, 'switching views must keep the real control mounted').toBe(true);
  expect(stopped.element()).toBe(stoppedNode);
  await expect.element(stopped).toHaveFocus();
  await expect.element(stopped).toHaveAttribute('aria-checked', 'true');
  expect(document.querySelector('.cd-safety__region')).toBe(region);
  await nextFrames();
  expect(layers()).toBe(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  health.release();
  await expect.element(screen.getByText('Signed with a development key', { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
  await expect.element(stopped).toHaveFocus();
  expect(stopped.element()).toBe(stoppedNode);
  expect(layers()).toBe(0);
  await expectScreenBasics(document.body, { owner: true });
});

/** Customers reads none of Safety's first view, so no prefetch races the held request. */
async function beforeSafety(viewport: 'desktop' | 'phone' = 'phone', retryScale = 1) {
  const rendered = await renderRoute(PEOPLE, { viewport, pollScale: 100, retryScale });
  await expect.element(rendered.screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  return rendered;
}

/** A single uncached page read pauses in an open app, then reconnects while its answer is held. */
async function expectPausedPageRead({ path, queryKey, readPath, region, landed, prime, primeLanded, error = `${region} [role="alert"]` }: {
  path: string; queryKey: readonly string[]; readPath: string; region: string; landed: string;
  prime?: string; primeLanded?: string; error?: string;
}) {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await renderRoute(SAFETY, { pollScale: 100 });
  await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  if (prime !== undefined) {
    await router.navigate(prime);
    await vi.waitFor(() => expect(landedElement(primeLanded!)).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
    await router.navigate(SAFETY);
    await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
  }
  const client = mounted.mock.contexts.at(-1) as QueryClient;
  client.removeQueries({ queryKey });
  let offline = true;
  const send = window.fetch;
  const sending = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (offline && url.pathname.startsWith('/api/')) return Promise.reject(new TypeError('Network unavailable'));
    return send(input, init);
  });
  onTestFinished(() => sending.mockRestore());
  onlineManager.setOnline(false);
  onTestFinished(() => onlineManager.setOnline(true));
  const read = holdReads(readPath);
  await router.navigate(path);
  await vi.waitFor(() => {
    expect(client.getQueryState(queryKey)?.fetchStatus).toBe('paused');
    expect(client.getQueryState(queryKey)?.data).toBeUndefined();
  });
  await vi.waitFor(() => expect(document.querySelector(error)?.textContent ?? '').toContain(OWNER_ERROR_COPY.network), { timeout: 2_000 });
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const retry = document.querySelector(error)!.querySelector('button')!;
  expect(retry.textContent).toBe('Try again');
  expect(retry.getClientRects().length).toBeGreaterThan(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  const { userEvent } = await import('vitest/browser');
  await userEvent.click(retry);
  await nextFrames();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(read.held()).toBe(0);

  const layers = watchLayers();
  offline = false;
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(read.held()).toBeGreaterThan(0));
  await nextFrames();
  expect(document.querySelector(error)?.textContent ?? '').toContain(OWNER_ERROR_COPY.network);
  expect(document.querySelector(`${region}[aria-busy="true"]`)).toBeNull();
  read.release();
  await vi.waitFor(() => expect(landedElement(landed)).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelector(error)).toBeNull());
  await nextFrames();
  expect(layers(), 'reconnecting never brings the skeleton back').toBe(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  await expectScreenBasics(document.body, { owner: true });
}

it('customers_paused_first_read_lands_its_error_and_stays_open_on_reconnect', async () => {
  await expectPausedPageRead({
    path: PEOPLE, queryKey: ['people', RIVERA.deskId], readPath: PEOPLE_READ,
    region: '.cd-people__region', landed: '.cd-people__rows',
  });
});

it('conversations_paused_first_read_lands_its_error_and_stays_open_on_reconnect', async () => {
  await expectPausedPageRead({
    path: CONVERSATIONS, queryKey: ['conversations', RIVERA.deskId], readPath: CONVERSATIONS_READ,
    region: '.cd-conversations__region', landed: '.cd-conversations__items',
  });
});

it('conversation_paused_first_read_lands_its_error_and_stays_open_on_reconnect', async () => {
  await expectPausedPageRead({
    path: `${CONVERSATIONS}/${SEEDED_HOLD}`, queryKey: ['conversation', SEEDED_HOLD], readPath: conversationRead(SEEDED_HOLD),
    region: '.cd-conversation-pane', landed: '.cd-conversation__head',
    prime: CONVERSATIONS, primeLanded: '.cd-conversations__items',
  });
});

it('conversation_paused_needs_you_lands_its_error_and_stays_open_on_reconnect', async () => {
  await expectPausedPageRead({
    path: `${CONVERSATIONS}/${SEEDED_HOLD}`, queryKey: needsYouKey(RIVERA.deskId), readPath: NEEDS_YOU_READ,
    region: '.cd-conversation-pane', landed: '.cd-conversation__head',
    prime: `${CONVERSATIONS}/${SEEDED_HOLD}`, primeLanded: '.cd-conversation__head',
  });
});

it('rules_paused_primary_read_lands_its_error_and_stays_open_on_reconnect', async () => {
  await expectPausedPageRead({
    path: RULES, queryKey: ['rules', RIVERA.deskId], readPath: RULES_READ,
    region: '.cd-rules__region', landed: '.cd-connector-list',
    prime: RULES, primeLanded: '.cd-connector-list', error: '.cd-rules > [role="alert"]',
  });
});

it('conversations_wait_for_needs_you_before_landing_callback_statuses', async () => {
  const world = mockStore.world;
  const chat = world.addSession(world.desk(RIVERA.deskId)!);
  world.visitorText(chat, 'Please ask the owner to call me.');
  world.context(chat, 'en', '').openHandoff({ reason: 'Please call this visitor', callbackWindow: null, lead: 'A visitor' });
  chat.displayName = null;
  const held = holdReads(NEEDS_YOU_READ);
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await beforeSafety('desktop');
  const client = mounted.mock.contexts.at(-1) as QueryClient;
  await router.navigate(CONVERSATIONS);
  await vi.waitFor(() => expect(held.held()).toBeGreaterThan(0));
  await vi.waitFor(() => expect(client.getQueryState(['conversations', RIVERA.deskId])?.status).toBe('success'));
  await nextFrames();
  expect(landedElement('.cd-conversations__items'), 'Needs you still supplies the callback status').toBeNull();
  await vi.waitFor(() => expect(document.querySelector('.cd-conversations__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  held.release();
  const callback = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /Wants you/ });
  await expect.element(callback).toBeVisible();
  expect(callback.element().textContent).toContain('Visitor');
  expect(callback.element().getAttribute('href')).toBe(`${CONVERSATIONS}/${chat.state.session_id}`);
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  // Reusing settled reads renders immediately, including the callback's status.
  await router.navigate(PEOPLE);
  await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  const layers = watchLayers();
  await router.navigate(CONVERSATIONS);
  await expect.element(callback).toBeVisible();
  await nextFrames();
  expect(layers()).toBe(0);
  await expectScreenBasics(document.body, { owner: true });
});

it('conversations_paused_needs_you_keeps_the_list_still_and_open_on_reconnect', async () => {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await beforeSafety('desktop');
  const client = mounted.mock.contexts.at(-1) as QueryClient;
  await router.navigate(CONVERSATIONS);
  const nav = screen.getByRole('navigation', { name: 'Conversations' });
  await expect.element(nav.getByRole('link').first()).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  await router.navigate(PEOPLE);
  await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
  // Keep the known list fresh to isolate the secondary Needs you read, with no primary failure.
  client.setQueryDefaults(['conversations', RIVERA.deskId], { staleTime: Infinity });
  client.removeQueries({ queryKey: needsYouKey(RIVERA.deskId) });
  let offline = true;
  const send = window.fetch;
  const sending = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (offline && url.pathname.startsWith('/api/')) return Promise.reject(new TypeError('Network unavailable'));
    return send(input, init);
  });
  onTestFinished(() => sending.mockRestore());
  onlineManager.setOnline(false);
  onTestFinished(() => onlineManager.setOnline(true));
  const read = holdReads(NEEDS_YOU_READ);
  await router.navigate(CONVERSATIONS);
  await vi.waitFor(() => expect(client.getQueryState(needsYouKey(RIVERA.deskId))?.fetchStatus).toBe('paused'));
  await expect.element(nav.getByRole('link').first()).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(nav.getByRole('alert').elements()).toHaveLength(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  const tops = watchTop(() => landedElement('.cd-conversations__items'));
  const before = tops();
  expect(before).toHaveLength(1);
  const layers = watchLayers();
  offline = false;
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(read.held()).toBeGreaterThan(0));
  await nextFrames();
  expect(nav.getByRole('alert').elements()).toHaveLength(0);
  expect(tops()).toEqual(before);
  read.release();
  await vi.waitFor(() => expect(client.getQueryData(needsYouKey(RIVERA.deskId))).toBeDefined());
  await nextFrames();
  expect(tops()).toEqual(before);
  expect(layers()).toBe(0);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  await expectScreenBasics(document.body, { owner: true });
});

it('safety_paused_first_reads_show_network_errors_and_stay_open_on_reconnect', async () => {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { screen, router } = await beforeSafety();
  const client = mounted.mock.contexts.at(-1) as QueryClient;
  const keys = [['ledger', RIVERA.deskId], ['health'], ['safety', RIVERA.deskId], todayKey(RIVERA.deskId)];
  for (const queryKey of keys) client.removeQueries({ queryKey });
  // Fail live API fetches, while leaving the browser and its mock worker online.
  let offline = true;
  const send = window.fetch;
  const sending = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (offline && url.pathname.startsWith('/api/')) return Promise.reject(new TypeError('Network unavailable'));
    return send(input, init);
  });
  onTestFinished(() => sending.mockRestore());
  onlineManager.setOnline(false);
  onTestFinished(() => onlineManager.setOnline(true));
  const reads = (['ledger', 'health', 'safety', 'today'] as const).map(key => holdReads(ROUTES[key].path.replace('{desk_id}', RIVERA.deskId)));
  await router.navigate(SAFETY);
  await vi.waitFor(() => {
    for (const key of keys) {
      expect(client.getQueryState(key)?.fetchStatus).toBe('paused');
      expect(client.getQueryState(key)?.data).toBeUndefined();
    }
  });
  const errors = screen.getByRole('alert').getByText(OWNER_ERROR_COPY.network, { exact: true });
  await expect.element(errors.first(), { timeout: 2_000 }).toBeVisible();
  expect(errors.elements()).toHaveLength(3); // Headline (Today + attempts), ledger, health.
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(screen.getByText('Checking the record', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByText('Reading what was stopped', { exact: true }).elements()).toHaveLength(0);
  const stopped = screen.getByRole('radio', { name: 'Stopped', exact: true });
  const entries = screen.getByRole('radio', { name: 'Every entry', exact: true });
  await entries.click();
  await expect.element(entries).toHaveFocus();
  await stopped.click();
  await expect.element(stopped).toHaveFocus();

  const layers = watchLayers();
  offline = false;
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(reads.every(read => read.held() > 0)).toBe(true));
  await nextFrames();
  await expect.element(stopped).toHaveFocus();
  await expect.element(errors.first()).toBeVisible();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  reads.forEach(read => read.release());
  await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
  await vi.waitFor(() => expect(errors.elements()).toHaveLength(0));
  await nextFrames();
  expect(layers(), 'reconnecting never brings the skeleton back').toBe(0);
  await expect.element(stopped).toHaveFocus();
  await expectScreenBasics(document.body, { owner: true });
});

it.each(['ledger', 'health', 'today', 'safety'] as const)('safety_waits_for_the_record_and_health: %s alone', async (key) => {
  await withFreshRecord();
  // The frame reads Today too: hold before mounting it, so no cached read can win the delay.
  const held = holdReads(ROUTES[key].path.replace('{desk_id}', RIVERA.deskId));
  const { screen, router } = await beforeSafety();
  const others = ['ledger', 'health', 'today', 'safety'].filter(route => route !== key);
  await expectSkeletonLoad({
    status: 'Reading what was stopped', anchors: SAFETY_ANCHORS,
    open: async () => {
      await router.navigate(SAFETY);
      await vi.waitFor(() => expect(held.held()).toBe(1));
      await vi.waitFor(() => expect(others.every(route => mockStore.requests.some(r => r.key === route))).toBe(true));
      await vi.waitFor(() => expect(document.querySelector('.cd-safety__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      expect(landedElement('.cd-safety__headline')).toBeNull();
      expect(landedElement('.cd-safety__bar')).toBeNull();
    },
    release: held.release,
  });
  await expect.element(screen.getByText('Signed with a development key', { exact: true })).toBeVisible();
  await expectScreenBasics(document.body, { owner: true });
});

it.each(['ledger', 'health'] as const)('safety_waits_for_the_record_and_health: %s fails', async (key) => {
  const held = holdReads(ROUTES[key].path.replace('{desk_id}', RIVERA.deskId));
  const { screen, router } = await beforeSafety('phone', 0);
  mockStore.inject({ route: key, status: 503, times: 2 });
  await router.navigate(SAFETY);
  await vi.waitFor(() => expect(document.querySelector('.cd-safety__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  held.release();
  const error = screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true });
  await expect.element(error).toBeVisible();
  expect(error.element().closest('.cd-safety__chain')).not.toBeNull();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
  await expectScreenBasics(document.body, { owner: true });
});

it.each([
  { path: RULES, read: RULES_READ, status: 'Reading your rules', anchors: RULES_ANCHORS },
  { path: SAFETY, read: LEDGER_READ, status: 'Reading what was stopped', anchors: SAFETY_ANCHORS },
])('$status stays still under reduced motion', async ({ path, read, status, anchors }) => {
  if (path === SAFETY) await withFreshRecord();
  const { router } = await beforeSafety('desktop');
  const held = holdReads(read);
  await expectSkeletonStill({ status, anchors, open: async () => { await router.navigate(path); }, release: held.release });
  await expectScreenBasics(document.body, { owner: true });
});

it('safety_entries_reload_keeps_its_existing_loader', async () => {
  const desks = holdReads(ROUTES.desks.path);
  const ledger = holdReads(LEDGER_READ);
  const { screen } = await renderRoute(`${SAFETY}?view=entries`, { pollScale: 100 });
  await vi.waitFor(() => expect(document.querySelector(`${FULL_LAYER}[data-state="shown"]`)).not.toBeNull());
  expect(document.querySelector(`${FULL_LAYER} [data-skeleton-anchor^="safety-"]`)).toBeNull();
  const headings = watchTopHeadings();
  desks.release();
  await expect.element(screen.getByRole('radio', { name: 'Every entry', exact: true })).toHaveAttribute('aria-checked', 'true');
  const checking = screen.getByRole('status').filter({ hasText: 'Checking the record' });
  await expect.element(checking).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  ledger.release();
  await expect.element(screen.getByText('Every entry matches the chain', { exact: true })).toBeVisible();
  expect(headings()).toEqual([1]);
  await expectScreenBasics(document.body, { owner: true });
});


it.each([390, 1280, 1440, 1512])('rules_reload_measures_the_current_header at %i', async (width) => {
  const { screen } = await renderRoute(RULES, { viewport: { width, height: width === 390 ? 844 : 900 }, pollScale: 100 });
  await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  if (width >= 1280) {
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Why was this quote held?');
    const { userEvent } = await import('vitest/browser');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('complementary', { name: 'Ask Claude' })).toBeVisible();
    await settled(document.body);
  }
  const page = landedElement('.cd-rules')!.getBoundingClientRect();
  // The reload's page, measured at the real column's width, including beside Ask Claude.
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', top: `${page.top}px`, left: `${page.left}px`, width: `${page.width}px`, visibility: 'hidden' });
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => { root.unmount(); host.remove(); });
  flushSync(() => root.render(<RulesSkeleton withHeader />));
  await nextFrames();
  const parts = [
    ['rules-title', '.cd-rules__header h1'],
    ['rules-header-all', '.cd-rules__header .cd-text-link'],
    ['rules-preset', '.cd-rules__header .cd-preset-menu > .cd-button'],
    ['rules-composer', '.cd-rules__ask .cd-composer__box'],
  ] as const;
  if (width > 390) {
    const drawn = host.querySelector('[data-skeleton-anchor="rules-subtitle"]')!.getBoundingClientRect();
    const words = landedElement('.cd-rules__header .cd-page-header__subtitle')!.getBoundingClientRect();
    expect(Math.abs(drawn.top - words.top)).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    expect(Math.abs(drawn.bottom - words.bottom)).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
  }
  for (const [name, selector] of parts) {
    const shape = host.querySelector(`[data-skeleton-anchor="${name}"]`)!.getBoundingClientRect();
    const real = landedElement(selector)!.getBoundingClientRect();
    for (const edge of name === 'rules-title' ? ['top', 'bottom'] as const : ['top', 'bottom', 'left', 'width', 'height'] as const) {
      expect(Math.abs(shape[edge] - real[edge]), `${name} ${edge}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    }
  }
});

it.each(['desktop', 'phone'] as const)('rules_with_a_suggestion_moves_once at %s', async (viewport) => {
  // Decision 15: a fresh copy has no suggestion. Approval history may supply one, which lands
  // its card once and moves the connector groups down by exactly that card and the page gap.
  mockStore.world.desks[0]!.suggestions = [APPROVED_REFUND_SUGGESTION];
  const { screen, router } = await openToday(viewport);
  const read = holdReads(RULES_READ);
  await router.navigate(RULES);
  await vi.waitFor(() => expect(document.querySelector('.cd-rules__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  expect(document.querySelector('.cd-rules__region .cd-skeleton-screen__layer .cd-rules__suggestions')).toBeNull();
  const tops = watchTop(() => {
    const layer = document.querySelector('.cd-rules__region .cd-skeleton-screen__layer');
    return layer && layer.getAttribute('data-state') !== 'leaving'
      ? layer.querySelector('[data-skeleton-anchor="rules-connector-0"]')
      : landedElement('.cd-connector-section__header');
  });
  read.release();
  await expect.element(screen.getByRole('button', { name: 'Draft this rule' })).toBeVisible();
  await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  const card = landedElement('.cd-rules__suggestions > .cd-card')!.getBoundingClientRect();
  const gap = Number.parseFloat(getComputedStyle(document.querySelector('.cd-rules__region > .cd-skeleton-screen__body')!).rowGap);
  expect(tops()).toHaveLength(2);
  expect(tops()[1]! - tops()[0]!, 'one downward move, explained by the returned card').toBe(Math.round(card.height + gap));
  const landed = landedElement('.cd-connector-section__header')!.getBoundingClientRect();
  for (let frame = 0; frame < 10; frame += 1) await nextFrames();
  expect(landedElement('.cd-connector-section__header')!.getBoundingClientRect().top).toBe(landed.top);
  expect(tops()).toHaveLength(2);
});

it.each(['people', 'suggestions'] as const)('rules_waits_for_every_read: %s alone', async (key) => {
  const held = holdReads(ROUTES[key].path.replace('{desk_id}', RIVERA.deskId));
  const { router } = await openToday();
  await expectSkeletonLoad({
    status: 'Reading your rules', anchors: RULES_ANCHORS,
    stays: ['.cd-rules__header', '.cd-rules__ask', '.cd-owner-layout__footer'],
    open: async () => {
      await router.navigate(RULES);
      await vi.waitFor(() => expect(held.held()).toBeGreaterThan(0));
      expect(landedElement('.cd-connector-list')).toBeNull();
    },
    release: held.release,
  });
});

it.each(['desktop', 'phone'] as const)('rules_without_jobs_moves_once at %s', async (viewport) => {
  // Decision 15: a fresh Turner copy has an Emergency callback. A Desk without jobs, such as
  // Acme, loses that section once when its reads settle; its connectors then stay in place.
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  desk.summary.business_name = 'Acme Accounting';
  desk.tools = desk.tools.filter((row) => row.source !== 'business');
  // Isolate the absent jobs section from Acme's data-dependent question about a held quote.
  const held = [...mockStore.world.decisions.values()].find((item) => item.decision.reason_plain === rivera.decisions.held.reason_plain)!;
  await mockStore.dispatch('answer', { params: { decision_id: held.decision.decision_id }, body: { answer: 'deny_once' } });
  const { screen, router } = await openToday(viewport);
  const read = holdReads(RULES_READ);
  await router.navigate(RULES);
  await vi.waitFor(() => expect(document.querySelector('.cd-rules__region .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  const jobs = document.querySelector('.cd-rules__region .cd-skeleton-screen__layer .cd-business-jobs')!;
  expect(jobs.textContent).toBe('');
  const height = jobs.getBoundingClientRect().height;
  const gap = Number.parseFloat(getComputedStyle(document.querySelector('.cd-rules__region > .cd-skeleton-screen__body')!).rowGap);
  const tops = watchTop(() => {
    const layer = document.querySelector('.cd-rules__region .cd-skeleton-screen__layer');
    return layer && layer.getAttribute('data-state') !== 'leaving'
      ? layer.querySelector('[data-skeleton-anchor="rules-connector-0"]')
      : landedElement('.cd-connector-section__header');
  });
  read.release();
  await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(landedElement('.cd-business-jobs')).toBeNull();
  expect(tops()).toHaveLength(2);
  expect(tops()[1]! - tops()[0]!, 'one upward move, explained by the absent jobs section').toBe(-Math.round(height + gap));
  for (let frame = 0; frame < 10; frame += 1) await nextFrames();
  expect(tops()).toHaveLength(2);
  expectNoHorizontalScroll();
});
