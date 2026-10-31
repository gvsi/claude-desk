/**
 * Today in a real browser against the mock API: what needs the owner (held requests answered in
 * place, callbacks to join), who is live now, what happened since last night with its full list,
 * and the last 7 days, every figure as the API reads it.
 */
import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';
import { cleanup, type RenderResult } from 'vitest-browser-react';

import type { Decision, DemoInboxEntry } from '../../api/contracts.ts';
import { newIdempotencyKey, observeRequests } from '../../api/http.ts';
import { ROUTES } from '../../api/routes.ts';
import type { BriefingItem, BriefingList, BusinessOut, ConversationSummary, NeedsYouItem, SetupState, ThisWeek, Today } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { formatWhen } from '../../lib/format.ts';
import { writeLocal } from '../../lib/storage.ts';
import { worker } from '../../mocks/browser.ts';
import { CALLBACK_REASON } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { SETUP_QUESTIONS } from '../../mocks/setup.ts';
import { mockStore } from '../../mocks/store.ts';
import { START_EXAMPLES } from '../../setup/copy.ts';
import { expectLandedInPlace, watchAnswerLanding } from '../../test/answerLanding.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import {
  aPollPasses,
  closedInboxReads,
  expectNoHorizontalScroll,
  expectNoWindowScroll,
  expectScreenBasics,
  focusIsOn,
  nextFrames,
} from '../../test/screen.ts';
import { watchFor, watchPages, watchTop } from '../../test/watch.ts';
import { needsYouKey } from '../useDesks.ts';
import { COPIED_FOR_MS } from './TodayPage.tsx';

const TODAY = `/app/${RIVERA.deskId}/today`;
const DESK = `/app/${RIVERA.deskId}`;
const CONVERSATIONS = `/app/${RIVERA.deskId}/conversations`;
const LA = 'America/Los_Angeles';

const SEEDED_REASON = rivera.decisions.held.reason_plain;
const SEEDED_RULE = 'Quotes from your price list, at list price.';
const REFUND_REASON = rivera.heldRefund.reason_plain;

const DRAFTED = 'Your answer also drafted a rule. Review it before it applies.';
const UNCERTAIN = "I couldn't confirm your answer went through. Try again; it can't run twice.";
const LIMIT_LINE = "That's above your limit for taking money without asking. Allow it this time, or change the limit on Rules.";
const NOT_OFFERED = "That answer isn't available for this request.";
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';
/** The owner line for the kernel's `conflict` (the design system's error copy). */
const CHANGED = 'This changed while you were looking. Reload to see where it stands.';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The Desk's public link, as the greeting's pill shows it and its button copies it. */
const PUBLIC_LINK = `${window.location.origin}/d/${RIVERA.slug}`;

/** Waits `ms` of real time, or none when `ms` isn't positive. */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * What the greeting's link pill says now, the link or "Copied": its words drawn at full opacity.
 * The other words lie under them, faded out.
 */
function linkPillShows(screen: RenderResult): string[] {
  const pill = screen.getByRole('button', { name: 'Copy your Desk link' }).element().closest('.cd-greeting__link');
  if (!pill) throw new Error("Today's greeting draws its link pill");
  return [...pill.querySelectorAll('span')]
    .filter((el) => el.childElementCount === 0 && getComputedStyle(el).opacity === '1')
    .map((el) => el.textContent ?? '');
}

/** Today as the mock reads it now, changed by `patch`, answering every read of it from here on. */
async function injectToday(patch: (today: Today) => Today): Promise<void> {
  const answer = await mockStore.dispatch('today', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Today');
  mockStore.inject({ route: 'today', status: 200, times: 10_000, body: patch(answer.body as Today) });
}

/** The held requests the mock has for the main Desk now. */
async function heldItems(): Promise<NeedsYouItem[]> {
  const answer = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Needs you');
  return (answer.body as NeedsYouItem[]).filter((item) => item.decision != null);
}

/** The seeded hold as the kernel has it now. */
function seededHold(): Decision {
  const held = [...mockStore.world.decisions.values()].find((d) => d.decision.reason_plain === SEEDED_REASON);
  if (!held) throw new Error('the seed holds the 15% quote');
  return held.decision;
}

/** A visitor's chat on the public page, as a new tab would send it. */
async function visitorSays(text: string): Promise<void> {
  await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
  await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text } });
}

function region(screen: RenderResult, name: string) {
  return screen.getByRole('region', { name, exact: true });
}

/** A held request's card, by what was asked. */
function heldCard(screen: RenderResult, reason: string) {
  return screen.getByRole('article', { name: `Held for you: ${reason}`, exact: true });
}

/**
 * Answers the seeded held request on Today with "Allow this time" and waits until its card has
 * landed and settled, with Dismiss under it.
 */
async function allowTheSeededRequest(screen: RenderResult): Promise<void> {
  const card = heldCard(screen, SEEDED_REASON);
  const allow = card.getByRole('button', { name: 'Allow this time' });
  await expect.element(allow).toBeVisible();
  const item = card.element().closest('li');
  if (!item) throw new Error('the card sits in an item of Needs you');
  const landing = watchAnswerLanding(card.element(), item);
  await allow.click();
  await landing;
  await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
}

/** Puts focus on Needs you's one Dismiss without moving the page, and presses Enter on it. */
async function dismissFromTheKeyboard(screen: RenderResult): Promise<void> {
  const button = region(screen, 'Needs you').getByRole('button', { name: 'Dismiss' }).element() as HTMLElement;
  button.focus({ preventScroll: true });
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard('{Enter}');
}

/**
 * Scrolls the page's column until Needs you's one Dismiss sits just inside its foot, as an owner who
 * has just answered there sees it, then puts keyboard focus on it without moving the page. `next`,
 * the section after Needs you, is then out of sight below, so a focus that brought it into view
 * would scroll the page. Returns the column.
 */
async function focusDismissAtTheFoot(screen: RenderResult, next: Element): Promise<HTMLElement> {
  const column = document.querySelector('main');
  if (!column) throw new Error('the owner frame draws the page column');
  const button = region(screen, 'Needs you').getByRole('button', { name: 'Dismiss' }).element() as HTMLElement;
  column.scrollTop += button.getBoundingClientRect().bottom - column.getBoundingClientRect().bottom + 8;
  await nextFrames();
  expect(column.scrollTop, 'the page is scrolled down to Dismiss').toBeGreaterThan(0);
  expect(button.getBoundingClientRect().bottom, 'Dismiss is in sight').toBeLessThanOrEqual(column.getBoundingClientRect().bottom);
  expect(next.getBoundingClientRect().top, 'the next section is out of sight below').toBeGreaterThan(column.getBoundingClientRect().bottom);
  button.focus({ preventScroll: true });
  expect(document.activeElement).toBe(button);
  return column;
}

/**
 * A button beside a busy one, waiting for its request: its words shown with no spinner, announced
 * as unavailable but not disabled, so it keeps its place in the tab order.
 */
async function expectWaiting(button: Locator, words: string): Promise<void> {
  await expect.element(button).toHaveAttribute('aria-disabled', 'true');
  const el = button.element() as HTMLButtonElement;
  expect(el.disabled).toBe(false);
  expect(el.tabIndex).toBe(0);
  expect(el.textContent).toBe(words);
  expect(el.getAttribute('aria-busy')).toBeNull();
  expect(el.querySelector('.cd-button__spinner')).toBeNull();
}

/**
 * Holds every read of `path` until the test lets them through to the mock: `held()` counts the
 * reads waiting, and `release()` sends them on.
 */
function holdReads(path: string): { held: () => number; release: () => void } {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  worker.use(
    http.get(path, async () => {
      waiting += 1;
      await released;
      return undefined;
    }),
  );
  return { held: () => waiting, release };
}

/** The main Desk's Needs you, as the app reads it. */
const needsYouPath = ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId);

/** Holds the next read of `path` for `ms` before it reaches the mock; later reads go straight on. */
function delayNextRead(path: string, ms: number): void {
  let next = true;
  worker.use(
    http.get(path, async () => {
      if (next) {
        next = false;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return undefined;
    }),
  );
}

/** The owner's loading page, "Opening your Desk", with nothing of the Desk's frame or of Today yet. */
function expectLoadingPage(): void {
  const state = document.querySelector('.cd-owner-state');
  expect(state, "the owner's loading page").not.toBeNull();
  expect(state!.textContent).toContain('Opening your Desk');
  expect(document.querySelector('.cd-today')).toBeNull();
  expect(document.querySelector('nav[aria-label="Main"]')).toBeNull();
}

/** The Emergencies Desk's Needs you, as the app reads it. */
const emergenciesNeedsYouPath = ROUTES.needsYou.path.replace('{desk_id}', RIVERA.emergenciesDeskId);

/** The sidebar's pages. */
function mainNav(screen: RenderResult) {
  return screen.getByRole('navigation', { name: 'Main' });
}

/** From the Desk named `from` to the one named `to`, with the sidebar's Desk picker. */
async function switchDesk(screen: RenderResult, from: string, to: string): Promise<void> {
  await screen.getByRole('button', { name: `Switch Desk, current: ${from}` }).click();
  await screen.getByRole('button', { name: to }).click();
  await expect.element(screen.getByRole('button', { name: `Switch Desk, current: ${to}` })).toBeVisible();
}

/** Today's "Since last night" heading, when Today shows it. */
const sinceLastNightHeading = () => [...document.querySelectorAll('.cd-today h2')].find((h) => h.textContent === 'Since last night') ?? null;

/**
 * Today is open but still reading what it first shows: its column holds the loading line alone,
 * under a heading only assistive technology reads, named as the sidebar names the page, with no
 * greeting and no section yet in either column, so nothing shown before Today is drawn can be
 * pushed down by it, the right column included where it stacks under the page.
 */
function expectTodayOpening(): void {
  const page = document.querySelector('.cd-today');
  expect(page).not.toBeNull();
  const heading = page!.querySelector('h1');
  expect(heading?.textContent).toBe('Today');
  expect(heading?.classList.contains('cd-sr-only')).toBe(true);
  expect(page!.textContent).toBe('TodayOpening your Desk');
  expect(page!.querySelector('.cd-today__main > .cd-loading-line[role="status"]')).not.toBeNull();
}

/** Waits for `key` to be read `n` more times than now. */
async function readsMore(key: string, n: number): Promise<void> {
  const from = requests(key).length;
  await expect.poll(() => requests(key).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(from + n);
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const REFUSAL: BriefingItem = {
  kind: 'blocked',
  at: minutesAgo(30),
  session_id: 'ses-agent-1',
  display_name: null,
  ref_id: 'dec-refused-1',
  line: 'An agent tried to book without a signed limit. Nothing was booked.',
};
const BOOKING: BriefingItem = {
  kind: 'booking',
  at: minutesAgo(60),
  session_id: 'ses-dana-web',
  display_name: 'Dana Whitfield',
  ref_id: 'dec-dana-book',
  line: 'A visitor booked Tuesday, November 3 at 2:00 pm, inside your weekday hours.',
};
const ANSWER: BriefingItem = {
  kind: 'answer',
  at: minutesAgo(90),
  session_id: 'ses-dana-verified',
  display_name: 'Dana Whitfield',
  ref_id: 'ses-dana-verified',
  line: null,
};

const ZERO_DAYS = ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((date) => ({
  date,
  conversations: 0,
  bookings: 0,
  stopped: 0,
}));

function week(fields: Partial<ThisWeek>): ThisWeek {
  return {
    timezone: LA,
    start: '2026-10-23',
    end: '2026-10-29',
    bookings: 0,
    booked_cents: 0,
    conversations: 0,
    handled: 0,
    stepped_in: 0,
    stopped: 0,
    days: ZERO_DAYS,
    ...fields,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Today', () => {
  it('sections_show_in_order', async () => {
    const { screen } = await renderRoute(TODAY);
    const needs = region(screen, 'Needs you');
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Live now')).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();

    const order = screen
      .getByRole('heading', { level: 2 })
      .elements()
      .map((h) => h.textContent)
      .filter((text) => ['Needs you', 'Live now', 'Since last night'].includes(text ?? ''));
    expect(order).toEqual(['Needs you', 'Live now', 'Since last night']);

    // One held request, with the rule that held it and what was asked.
    await expect.element(needs.getByRole('img', { name: '1 needs you' })).toBeVisible();
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card.getByText(`Held by your rule: ${SEEDED_RULE}`, { exact: true })).toBeVisible();
    // A limit hold offers the two one-time answers, each its own plain button.
    const answers = card.getByRole('group', { name: 'Your answer' }).getByRole('button');
    expect(answers.elements().map((b) => b.textContent)).toEqual(['Allow this time', 'Deny this time']);
    expect(answers.elements().some((b) => b.hasAttribute('aria-haspopup'))).toBe(false);
    await expectScreenBasics(screen.container, { owner: true });

    // "Open the request" brings that card into focus.
    const things = region(screen, 'Things to try');
    await things.getByRole('button', { name: 'Open the request' }).click();
    expect(focusIsOn(card.element())).toBe(true);

    // A newer hold the API lists first still comes after the oldest one, here and in Things to try.
    const [seeded] = await heldItems();
    if (!seeded?.decision) throw new Error('the seed holds a request');
    const newer: NeedsYouItem = {
      ...seeded,
      decision: { ...seeded.decision, decision_id: 'dec-newer', reason_plain: 'A visitor asked to book Sunday at 10:00 pm.' },
      held_by: 'Bookings in your weekday hours.',
      held_at: new Date().toISOString(),
    };
    mockStore.inject({ route: 'needsYou', status: 200, times: 10_000, body: [newer, seeded] });
    await expect.element(heldCard(screen, 'A visitor asked to book Sunday at 10:00 pm.')).toBeVisible();
    await expect.element(needs.getByRole('img', { name: '2 need you' })).toBeVisible();
    const cards = needs.getByRole('article').elements().map((a) => a.getAttribute('aria-label'));
    expect(cards).toEqual([`Held for you: ${SEEDED_REASON}`, 'Held for you: A visitor asked to book Sunday at 10:00 pm.']);
    await expect
      .element(things.getByText(`A request is waiting for your answer. Held by your rule: ${SEEDED_RULE}`, { exact: true }))
      .toBeVisible();
    (document.activeElement as HTMLElement | null)?.blur();
    await things.getByRole('button', { name: 'Open the request' }).click();
    expect(focusIsOn(heldCard(screen, SEEDED_REASON).element())).toBe(true);
  });

  it('reload_opens_today_drawn', async () => {
    // Opened at Today's address, as a reload does, the owner's loading page stays until what Today
    // first shows is read too, and Today then opens drawn: one loading step, never the frame with
    // Today's own loading line after it. The Desks and Today answer at once; Needs you is held
    // back. The page this file drew last goes first, so the watch sees only this one.
    await cleanup();
    const pages = watchPages();
    const needsYou = holdReads(needsYouPath);
    const { screen } = await renderRoute(TODAY);
    await vi.waitFor(() => expect(needsYou.held()).toBe(1));
    await expect.poll(() => requests('today').length).toBeGreaterThan(0);
    await expect.poll(() => requests('desks').length).toBeGreaterThan(0);
    // Time for Today to be drawn, had it opened without Needs you.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectLoadingPage();

    // Once Needs you is in, Today opens with every section drawn.
    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Live now').getByRole('link')).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Last 7 days' })).toBeVisible();
    expect(pages()).toEqual(['loading', 'today']);
  });

  it('reload_with_slow_reads_shows_one_loading_step', async () => {
    // As a hosted reload over a slow network reads: the copy's Desks in after 0.7 s, Needs you
    // after 1.4 s. The owner's loading page alone until both are in, then Today, drawn whole.
    await cleanup();
    const pages = watchPages();
    delayNextRead(ROUTES.desks.path, 700);
    delayNextRead(needsYouPath, 1_400);
    const started = performance.now();
    const { screen } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON), { timeout: 4_000 }).toBeVisible();
    expect(performance.now() - started).toBeGreaterThan(1_400);
    expect(pages()).toEqual(['loading', 'today']);
  });

  it('reload_reads_today_beside_the_desks', async () => {
    // A reload of Today sends Today's own reads with the copy's Desks, not once they are in, so on
    // a slow network Today opens a round trip sooner.
    const desks = holdReads(ROUTES.desks.path);
    const needsYou = holdReads(needsYouPath);
    const { screen } = await renderRoute(TODAY);
    await vi.waitFor(() => expect(desks.held()).toBe(1));
    await vi.waitFor(() => expect(needsYou.held()).toBe(1));
    await expect.poll(() => requests('today').length).toBeGreaterThan(0);
    await expect.element(screen.getByText('Opening your Desk', { exact: true })).toBeVisible();
    expect(document.querySelector('.cd-owner-state')).not.toBeNull();

    desks.release();
    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
  });

  it('reload_waits_one_read_ahead_however_slow_the_desks', { timeout: 15_000 }, async () => {
    // The 3 s a reload of Today waits for what it first shows run from the reload, as a first
    // visit's do, not from when the copy's Desks come in: here they come in after 1.5 s and Needs
    // you not at all, so Today draws what it has at 3 s, not at 4.5 s.
    const desks = holdReads(ROUTES.desks.path);
    const needsYou = holdReads(needsYouPath);
    const started = performance.now();
    const { screen } = await renderRoute(TODAY);
    setTimeout(desks.release, 1_500);
    await expect.poll(() => sinceLastNightHeading() !== null, { timeout: 6_000, interval: 50 }).toBe(true);
    const drawnAt = performance.now() - started;
    expect(drawnAt).toBeGreaterThan(2_900);
    expect(drawnAt).toBeLessThan(4_000);

    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
  });

  it('today_waits_no_longer_than_a_first_visit', async () => {
    // A read that runs past the read ahead's 3 s cap doesn't keep the owner on the loading page:
    // Today draws what it has, at once rather than after a wait of its own, still reading what
    // needs the owner, and the request shows when its read is in.
    await cleanup();
    const pages = watchPages();
    const needsYou = holdReads(needsYouPath);
    const { screen } = await renderRoute(TODAY);
    await vi.waitFor(() => expect(needsYou.held()).toBe(1));
    expectLoadingPage();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first(), { timeout: 5_000 }).toBeVisible();
    expect(heldCard(screen, SEEDED_REASON).elements()).toHaveLength(0);

    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    expect(pages()).toEqual(['loading', 'today without its held request', 'today']);
  });

  it('switching_desks_opens_today_drawn', async () => {
    // Another Desk the copy's Desks already list opens at once, never on the owner's loading page,
    // onto a Today whose column stays on the loading line until that Desk's Today and Needs you are
    // in. Here Needs you is slow, with a request waiting, so "Since last night" would show first and
    // then be pushed down by it.
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_two_desks' });
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    const [seeded] = await heldItems();
    mockStore.inject({ route: 'needsYou', status: 200, times: 10_000, body: [seeded] });
    const needsYou = holdReads(emergenciesNeedsYouPath);
    const pages = watchPages();
    await switchDesk(screen, 'Main line', 'Emergencies');
    await vi.waitFor(() => expect(needsYou.held()).toBe(1));
    // Time for Today to be drawn, had it opened without Needs you.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectTodayOpening();
    const since = watchTop(sinceLastNightHeading);

    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByText('A quiet night', { exact: true })).toBeVisible();
    expect(since()).toHaveLength(1);
    expect(pages()).toEqual(['today', 'today opening', 'today']);
  });

  it('a_failed_today_read_keeps_its_error_once_today_opens', async () => {
    // Another Desk's Today can't be read, nor on its one retry, so Today opens on that failure. The
    // briefing then says so with "Try again", rather than read Today again as it mounts and look
    // as if it were still loading. Any read after those two is held.
    const emergenciesToday = ROUTES.today.path.replace('{desk_id}', RIVERA.emergenciesDeskId);
    let reads = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.get(emergenciesToday, async () => {
        reads += 1;
        if (reads <= 2) return HttpResponse.json({ error: 'kernel', code: 'kernel_unavailable' }, { status: 503 });
        await released;
        return undefined;
      }),
    );
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_two_desks', pollScale: 100, retryScale: 0 });
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await switchDesk(screen, 'Main line', 'Emergencies');
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    await expect.element(since.getByRole('button', { name: 'Try again' })).toBeVisible();
    // Still there a moment later: nothing read Today again as it mounted.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(since.getByText(UNAVAILABLE, { exact: true }).elements()).toHaveLength(1);
    expect(reads).toBe(2);
    release();
  });

  it('switching_to_a_desk_already_read_opens_today_at_once', async () => {
    // A Desk whose Today and Needs you are already read opens straight onto its Today drawn, with
    // neither the loading page nor the loading line, even while those reads go out again: here they
    // are held, so only what was read can draw it.
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_two_desks' });
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await switchDesk(screen, 'Main line', 'Emergencies');
    await expect.element(region(screen, 'Since last night').getByText('A quiet night', { exact: true })).toBeVisible();

    const today = holdReads(ROUTES.today.path.replace('{desk_id}', RIVERA.deskId));
    const needsYou = holdReads(needsYouPath);
    const pages = watchPages();
    await switchDesk(screen, 'Emergencies', 'Main line');
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    expect(pages()).toEqual(['today without its held request', 'today']);
    today.release();
    needsYou.release();
  });

  it('today_after_a_reload_elsewhere_opens_drawn', async () => {
    // Reloaded on Conversations, the frame keeps Today read, but Needs you is read only as Today
    // opens, here slowly. Today keeps its column on the loading line until Needs you is in too, so
    // "Since last night" never shows and is then pushed down by the requests above it.
    const first = await renderRoute(TODAY);
    await expect.element(heldCard(first.screen, SEEDED_REASON)).toBeVisible();
    await mainNav(first.screen).getByRole('link', { name: /^Conversations/ }).click();
    await expect.poll(() => first.router.state.location.pathname).toBe(CONVERSATIONS);
    const { screen } = await renderRoute(CONVERSATIONS);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
    await expect.poll(() => requests('today').length).toBeGreaterThan(0);

    const needsYou = holdReads(needsYouPath);
    const since = watchTop(sinceLastNightHeading);
    const pages = watchPages();
    await mainNav(screen).getByRole('link', { name: 'Today' }).click();
    await vi.waitFor(() => expect(needsYou.held()).toBe(1));
    // Time for Today to be drawn, had it opened without Needs you.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectTodayOpening();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
    await expectScreenBasics(screen.container, { owner: true });

    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    expect(since()).toHaveLength(1);
    // Within the frame, never the owner's loading page: moving between pages keeps Today's own hold.
    expect(pages().slice(1)).toEqual(['today opening', 'today']);
  });

  it('today_from_another_page_opens_with_its_inbox_read', async () => {
    // Opened from another page, Today keeps its column on the loading line until the copy's Demo
    // inbox is in too, here slowly, so its button never opens as a line saying it is opening, one
    // line shorter, with Last 7 days under it then pushed down.
    const { screen } = await renderRoute(CONVERSATIONS);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
    const inbox = holdReads(ROUTES.ownerInbox.path);
    const lastSevenDays = watchTop(() => [...document.querySelectorAll('.cd-today h2')].find((h) => h.textContent === 'Last 7 days') ?? null);
    const sawItOpening = watchFor('Opening your Demo inbox');
    await mainNav(screen).getByRole('link', { name: 'Today' }).click();
    await vi.waitFor(() => expect(inbox.held()).toBe(1));
    // Time for Today to be drawn, had it opened without its inbox.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectTodayOpening();

    inbox.release();
    await expect.element(screen.getByRole('button', { name: /^Demo inbox \d+ entr(?:y|ies)$/ })).toBeVisible();
    expect(lastSevenDays()).toHaveLength(1);
    expect(sawItOpening()).toBe(false);
  });

  it('today_later_in_a_reloaded_visit_holds_on_its_own', { timeout: 15_000 }, async () => {
    // The reload's read ahead is spent once Today first opens: opened again later in the visit, from
    // another page, with Needs you no longer in the app's memory, Today waits for it on its own
    // loading line, rather than open at once on the reload's long-gone deadline.
    const mounted = vi.spyOn(QueryClient.prototype, 'mount');
    const { screen } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    const queryClient = mounted.mock.contexts.at(-1) as QueryClient;
    // Past the reload's 3 s.
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    await mainNav(screen).getByRole('link', { name: /^Conversations/ }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();

    queryClient.removeQueries({ queryKey: needsYouKey(RIVERA.deskId) });
    const needsYou = holdReads(needsYouPath);
    await mainNav(screen).getByRole('link', { name: 'Today' }).click();
    await vi.waitFor(() => expect(needsYou.held()).toBe(1));
    // Time for Today to be drawn, had it opened without Needs you.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectTodayOpening();
    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
  });

  it('leaving_the_loading_page_leaves_no_deadline_behind', { timeout: 15_000 }, async () => {
    // A reload of Today left before Today opened (here for another Desk, while the copy's Desks are
    // still being read) takes its read ahead with it: the Desk's Today, opened later, waits for its
    // reads on its own loading line, rather than open at once on that long-gone deadline.
    const desks = holdReads(ROUTES.desks.path);
    const needsYou = holdReads(needsYouPath);
    const { screen, router } = await renderRoute(TODAY, { seed: 'rivera_two_desks' });
    await vi.waitFor(() => expect(desks.held()).toBe(1));
    expectLoadingPage();
    await router.navigate(`/app/${RIVERA.emergenciesDeskId}/conversations`);
    desks.release();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
    // Past the reload's 3 s.
    await new Promise((resolve) => setTimeout(resolve, 3_200));

    await router.navigate(TODAY);
    // Time for Today to be drawn, had it opened without Needs you.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectTodayOpening();
    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
  });

  it('back_to_today_returns_to_its_place_once_drawn', async () => {
    // Back to Today once Needs you has left the app's memory: Today opens on its loading line, one
    // line high, where the owner's place on the page can't be reached yet, and goes to it once
    // Today is drawn.
    const mounted = vi.spyOn(QueryClient.prototype, 'mount');
    const { screen, router } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    const queryClient = mounted.mock.contexts.at(-1) as QueryClient;
    const column = document.querySelector('main')!;
    column.scrollTop = 300;
    await vi.waitFor(() => expect(column.scrollTop).toBe(300));
    // Time for the place to be kept, as the owner's own scrolling is.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await mainNav(screen).getByRole('link', { name: /^Conversations/ }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();

    queryClient.removeQueries({ queryKey: needsYouKey(RIVERA.deskId) });
    const needsYou = holdReads(needsYouPath);
    await router.navigate(-1);
    await vi.waitFor(expectTodayOpening);
    needsYou.release();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await vi.waitFor(() => expect(document.querySelector('main')!.scrollTop).toBe(300));
  });

  it('needs_you_failing_opens_today_at_once', async () => {
    // Today doesn't wait out its 3 s for a read that has already failed: it opens on the failure,
    // with the line that says so where the requests would be.
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    const { screen } = await renderRoute(TODAY, { retryScale: 0 });
    const line = region(screen, 'Needs you').getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 1_500 }).toBeVisible();
  });

  it('today_failing_opens_today_at_once', async () => {
    // Nor for Today's own read: the briefing says it couldn't be read, with "Try again".
    mockStore.inject({ route: 'today', status: 503, times: 10_000 });
    const { screen } = await renderRoute(TODAY, { retryScale: 0 });
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText(UNAVAILABLE, { exact: true }), { timeout: 1_500 }).toBeVisible();
    await expect.element(since.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('reload_with_a_failed_read_shows_one_loading_step', { timeout: 15_000 }, async () => {
    // A reload where Today's own read fails, and its one retry a second later: the owner's loading
    // page until then, and Today opens on the failure, drawn, without a second loading step or
    // sending the failed read again as it opens. Polls far apart, so none lands meanwhile.
    await cleanup();
    const pages = watchPages();
    mockStore.inject({ route: 'today', status: 503, times: 10_000 });
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText(UNAVAILABLE, { exact: true }), { timeout: 5_000 }).toBeVisible();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    // Time for a read on mount to go out, had Today sent one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pages()).toEqual(['loading', 'today']);
    expect(requests('today')).toHaveLength(2);
  });

  it('reload_with_needs_you_failing_shows_one_loading_step', { timeout: 15_000 }, async () => {
    // The same when what needs the owner can't be read: one loading step, then Today, saying so.
    await cleanup();
    const pages = watchPages();
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const line = region(screen, 'Needs you').getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pages()).toEqual(['loading', 'today without its held request']);
    expect(requests('needsYou')).toHaveLength(2);
  });

  it('a_failed_read_is_read_again_on_try_again', { timeout: 15_000 }, async () => {
    // Opened on a failed read of Today, the briefing's "Try again" still reads it again. Only the
    // first read and its retry fail; polls far apart, so none lands meanwhile.
    mockStore.inject({ route: 'today', status: 503, times: 2 });
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText(UNAVAILABLE, { exact: true }), { timeout: 5_000 }).toBeVisible();
    expect(requests('today')).toHaveLength(2);

    await since.getByRole('button', { name: 'Try again' }).click();
    await expect.element(since.getByRole('listitem').first()).toBeVisible();
    expect(requests('today')).toHaveLength(3);
  });

  it('a_failed_read_is_read_again_by_the_polls', { timeout: 15_000 }, async () => {
    // And the polls read both again on their own: the failures show, then what was read.
    mockStore.inject({ route: 'today', status: 503, times: 2 });
    mockStore.inject({ route: 'needsYou', status: 503, times: 2 });
    const sawFailure = watchFor(UNAVAILABLE);
    const { screen } = await renderRoute(TODAY);
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first(), { timeout: 5_000 }).toBeVisible();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    expect(sawFailure()).toBe(true);
    expect(requests('today').length).toBeGreaterThan(2);
    expect(requests('needsYou').length).toBeGreaterThan(2);
  });

  it('needs_you_read_failure_says_so', async () => {
    // What needs the owner can't be read: Needs you says so where the requests would be, rather
    // than looking as if nothing needs them.
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    const { screen } = await renderRoute(TODAY);
    const needs = region(screen, 'Needs you');
    const line = needs.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    const retry = needs.getByRole('button', { name: 'Try again' });
    await expect.element(retry).toBeVisible();
    expect(needs.getByRole('article').elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    // It stays while the polls read again, rather than going each time a read starts.
    await readsMore('needsYou', 2);
    expect(line.elements()).toHaveLength(1);

    // "Try again" reads again: busy until that read settles, and the line stays while it fails too.
    await retry.click();
    await expect.element(retry).toHaveAttribute('aria-busy', 'true');
    await expect.element(retry, { timeout: 5_000 }).not.toHaveAttribute('aria-busy');
    expect(line.elements()).toHaveLength(1);

    // Once a read works, the request is there and the line is gone.
    mockStore.reset('rivera');
    await expect.element(heldCard(screen, SEEDED_REASON), { timeout: 5_000 }).toBeVisible();
    expect(needs.getByText(UNAVAILABLE).elements()).toHaveLength(0);
  });

  it('needs_you_poll_failure_keeps_what_was_read', async () => {
    // Each failed read waits a second before its one retry, so this half of the read failure story
    // runs on its own, after a read that worked, rather than at the end of the one above.
    const { screen } = await renderRoute(TODAY);
    const needs = region(screen, 'Needs you');
    const line = needs.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    expect(line.elements()).toHaveLength(0);

    // A later poll fails: what was read stays, with the line, until a read works again.
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(needs.getByRole('img', { name: '1 needs you' })).toBeVisible();
    await expect.element(needs.getByRole('button', { name: 'Try again' })).toBeVisible();
    mockStore.reset('rivera');
    await expect.element(line, { timeout: 5_000 }).not.toBeInTheDocument();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();

    // And it comes back when a poll fails again, after the last failure cleared.
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    mockStore.reset('rivera');
  });

  it('quiet_today_leaves_out_empty_sections', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText('A quiet night', { exact: true })).toBeVisible();
    await expect.element(since.getByText('Nothing new since 6:00 pm yesterday.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Quiet right now.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Last 7 days' })).toBeVisible();
    // Polls come and go, and the empty sections stay away.
    await readsMore('today', 2);
    await readsMore('needsYou', 2);
    expect(screen.getByRole('heading', { name: 'Needs you' }).elements()).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Live now' }).elements()).toHaveLength(0);
    expect(since.getByRole('link', { name: /^See all/ }).elements()).toHaveLength(0);
  });

  it('no_ask_claude_composer_on_today', async () => {
    const { screen } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    expect(document.querySelectorAll('textarea, input[type="text"], [role="textbox"], .cd-composer')).toHaveLength(0);
    expect(screen.getByRole('textbox').elements()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Ask Claude/i);
    expect(document.querySelectorAll('[aria-label*="Ask Claude" i], [placeholder*="Ask Claude" i]')).toHaveLength(0);
  });

  it('copied_shows_in_the_link_then_the_link_again', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { screen } = await renderRoute(TODAY);
    const copy = screen.getByRole('button', { name: 'Copy your Desk link' });
    await expect.element(copy).toBeVisible();
    expect(linkPillShows(screen)).toEqual([PUBLIC_LINK]);

    // A copy that worked: the pill says "Copied" where the link was, and the status line says it
    // to screen readers in its own words.
    await copy.click();
    await expect.poll(() => linkPillShows(screen)).toEqual(['Copied']);
    const firstShown = performance.now();
    expect(writeText).toHaveBeenCalledWith(PUBLIC_LINK);
    await expect.element(screen.getByRole('status').filter({ hasText: 'Your Desk link is copied.' })).toBeInTheDocument();
    expect(copy.element().getAttribute('aria-label')).toBe('Copy your Desk link');

    // Another copy before it clears starts the wait again: past the first copy's time, it still
    // says "Copied".
    await pause(COPIED_FOR_MS / 2);
    await copy.click();
    await expect.poll(() => writeText.mock.calls.length).toBe(2);
    const secondCopied = performance.now();
    await pause(firstShown + COPIED_FOR_MS + 300 - performance.now());
    expect(linkPillShows(screen)).toEqual(['Copied']);

    // Then the link again, COPIED_FOR_MS after the last copy, while the status line keeps its words.
    await expect.poll(() => linkPillShows(screen), { timeout: COPIED_FOR_MS + 2_000 }).toEqual([PUBLIC_LINK]);
    expect(performance.now() - secondCopied).toBeGreaterThanOrEqual(COPIED_FOR_MS);
    await expect.element(screen.getByRole('status').filter({ hasText: 'Your Desk link is copied.' })).toBeInTheDocument();
  });

  it('failed_copy_never_says_copied', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const { screen } = await renderRoute(TODAY);
    const copy = screen.getByRole('button', { name: 'Copy your Desk link' });
    const failedLine = screen.getByRole('status').filter({ hasText: "Copy didn't work. Select the link and copy it yourself." });

    // The clipboard refused: the status line says so in its words, and the pill keeps the link.
    await copy.click();
    await expect.element(failedLine).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(linkPillShows(screen)).toEqual([PUBLIC_LINK]);

    // A copy that worked, then one the clipboard refused: the pill takes back "Copied" at once.
    writeText.mockResolvedValueOnce(undefined);
    await copy.click();
    await expect.poll(() => linkPillShows(screen)).toEqual(['Copied']);
    await copy.click();
    await expect.element(failedLine).toBeInTheDocument();
    await expect.poll(() => linkPillShows(screen), { timeout: COPIED_FOR_MS / 2 }).toEqual([PUBLIC_LINK]);
  });

  it('briefing_shows_one_row_per_kind', async () => {
    await injectToday((t) => ({ ...t, briefing: { ...t.briefing, total: 3, newest: { blocked: REFUSAL, booking: BOOKING, lead_or_answer: ANSWER } } }));
    const { screen } = await renderRoute(TODAY);
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText(REFUSAL.line ?? '', { exact: true })).toBeVisible();
    const rows = since.getByRole('listitem');
    expect(rows.elements()).toHaveLength(3);
    const now = new Date();
    const [blocked, booked, answered] = rows.elements();

    expect(blocked?.textContent).toContain('Blocked');
    expect(blocked?.textContent).toContain(formatWhen(REFUSAL.at, LA, now));
    const refusal = since.getByRole('link', { name: new RegExp(REFUSAL.line ?? '') });
    await expect.element(refusal).toHaveAttribute('href', `${DESK}/safety/dec-refused-1`);

    expect(booked?.textContent).toContain('Booked');
    expect(booked?.textContent).toContain('Dana Whitfield');
    expect(booked?.textContent).toContain(BOOKING.line);
    expect(booked?.textContent).toContain(formatWhen(BOOKING.at, LA, now));
    expect(booked?.querySelector('a')?.getAttribute('href')).toBe(`${DESK}/conversations/ses-dana-web`);

    expect(answered?.textContent).toContain('Answered');
    expect(answered?.textContent).toContain('Claude answered Dana Whitfield.');
    expect(answered?.textContent).toContain(formatWhen(ANSWER.at, LA, now));
    expect(answered?.querySelector('a')?.getAttribute('href')).toBe(`${DESK}/conversations/ses-dana-verified`);

    // Names may come from a visitor: each is their own text.
    for (const row of [booked, answered]) {
      const name = [...(row?.querySelectorAll('[data-copy="user"]') ?? [])].map((el) => el.textContent);
      expect(name).toContain('Dana Whitfield');
    }
    // All three are on the card already, so there is no "See all" to open.
    expect(since.getByRole('link', { name: /^See all/ }).elements()).toHaveLength(0);

    // A blocked reply has no line of its own, and a night with no booking leaves its row out.
    mockStore.reset('rivera');
    await injectToday((t) => ({
      ...t,
      briefing: { ...t.briefing, total: 2, newest: { blocked: { ...REFUSAL, ref_id: '41', line: null }, booking: null, lead_or_answer: ANSWER } },
    }));
    const again = await renderRoute(TODAY);
    const night = region(again.screen, 'Since last night');
    await expect.element(night.getByText('A reply was stopped before it was shown.', { exact: true })).toBeVisible();
    const kinds = night.getByRole('listitem').elements().map((row) => (row.textContent?.includes('Blocked') ? 'Blocked' : 'Answered'));
    expect(kinds).toEqual(['Blocked', 'Answered']);
    expect(night.getByText('Booked').elements()).toHaveLength(0);
    await expect.element(night.getByRole('link', { name: /A reply was stopped/ })).toHaveAttribute('href', `${DESK}/safety/41`);
    expect(night.getByRole('link', { name: /^See all/ }).elements()).toHaveLength(0);

    // Three things, but no booking among the newest, so two rows: "See all 3" opens the third.
    mockStore.reset('rivera');
    await injectToday((t) => ({ ...t, briefing: { ...t.briefing, total: 3, newest: { blocked: REFUSAL, booking: null, lead_or_answer: ANSWER } } }));
    const third = await renderRoute(TODAY);
    const two = region(third.screen, 'Since last night');
    await expect.element(two.getByText(REFUSAL.line ?? '', { exact: true })).toBeVisible();
    expect(two.getByRole('listitem').elements()).toHaveLength(2);
    await expect.element(two.getByRole('link', { name: 'See all 3' })).toHaveAttribute('href', `${DESK}/today/briefing`);
  });

  it('see_all_opens_the_full_briefing', async () => {
    const items: BriefingItem[] = [
      { ...REFUSAL, at: minutesAgo(10) },
      { ...ANSWER, at: minutesAgo(20), ref_id: 'ses-a', session_id: 'ses-a', display_name: null },
      { ...BOOKING, at: minutesAgo(30) },
      { kind: 'lead', at: minutesAgo(40), session_id: 'ses-b', display_name: 'Dana Whitfield', ref_id: 'lead-1', line: '(510) 555-0118 · Leaking water heater' },
      { ...REFUSAL, at: minutesAgo(50), ref_id: 'dec-refused-2' },
      { ...ANSWER, at: minutesAgo(60), ref_id: 'ses-c', session_id: 'ses-c', display_name: null },
    ];
    await injectToday((t) => ({
      ...t,
      briefing: { ...t.briefing, total: 6, newest: { blocked: items[0] ?? null, booking: items[2] ?? null, lead_or_answer: items[1] ?? null } },
    }));
    const list: BriefingList = { since: '2026-10-28T18:00:00-07:00', items };
    mockStore.inject({ route: 'briefing', status: 200, times: 10_000, body: list });
    const { screen, router } = await renderRoute(TODAY);

    await region(screen, 'Since last night').getByRole('link', { name: 'See all 6' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${DESK}/today/briefing`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Since last night' })).toBeVisible();
    const rows = screen.getByRole('list', { name: 'Since last night, newest first' }).getByRole('listitem');
    await expect.poll(() => rows.elements().length).toBe(6);
    const now = new Date();
    expect(rows.elements().map((row) => items.findIndex((item) => row.textContent?.includes(formatWhen(item.at, LA, now))))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    await expect.element(screen.getByText('Claude answered a visitor.').first()).toBeVisible();
    await expect.element(screen.getByText('New lead')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', TODAY);
    // The full list is read once, not polled.
    await readsMore('today', 2);
    expect(requests('briefing')).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });

    await screen.getByRole('link', { name: 'Back to Today' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(TODAY);
  });

  it('this_week_shows_the_api_figures', async () => {
    const days = ZERO_DAYS.map((d, i) => ({ ...d, conversations: i, bookings: i === 4 || i === 6 ? 1 : 0, stopped: i === 5 ? 2 : 0 }));
    await injectToday((t) => ({
      ...t,
      this_week: week({ bookings: 2, booked_cents: 37_800, conversations: 4, handled: 3, stepped_in: 1, stopped: 2, days }),
    }));
    const { screen } = await renderRoute(TODAY);
    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('$378 booked', { exact: true })).toBeVisible();
    await expect.element(block.getByText('2 bookings, 1 so far today', { exact: true })).toBeVisible();

    const bars = block.getByRole('list', { name: 'Bookings per day' }).getByRole('listitem');
    expect(bars.elements()).toHaveLength(7);
    expect(bars.elements().map((bar) => bar.querySelector('.cd-sr-only')?.textContent)).toEqual([
      'Fri: no bookings',
      'Sat: no bookings',
      'Sun: no bookings',
      'Mon: no bookings',
      'Tue: 1 booking',
      'Wed: no bookings',
      'Thu: 1 booking',
    ]);
    expect(bars.elements().map((bar) => bar.querySelector('[aria-hidden="true"].cd-week__initial')?.textContent)).toEqual([
      'F',
      'S',
      'S',
      'M',
      'T',
      'W',
      'T',
    ]);
    // Today is the last bar, and the busiest days stand taller than the flat ones.
    expect(bars.elements().map((bar) => bar.getAttribute('aria-current'))).toEqual([null, null, null, null, null, null, 'date']);
    const height = (i: number) => bars.elements()[i]?.querySelector('.cd-week__bar')?.getBoundingClientRect().height ?? 0;
    expect(height(4)).toBeGreaterThan(height(0) * 4);
    expect(height(6)).toBe(height(4));

    await expect.element(block.getByText('Claude handled 3', { exact: true })).toBeVisible();
    await expect.element(block.getByText('You stepped in 1 time', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('heading', { level: 3, name: 'Turned down', exact: true })).toBeVisible();
    await expect.element(block.getByText('2 requests', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('link', { name: 'Open Safety' })).toHaveAttribute('href', `${DESK}/safety`);
    expect(block.element().textContent).not.toMatch(/attempt|talk it around|stopped/i);

    // The design system's figure styles: the booked total at the figure size, the count of
    // requests turned down at the smaller one, both in the interface's face with tabular figures.
    const [booked, stopped] = [...block.element().querySelectorAll('.cd-week__number')];
    expect([booked?.textContent, stopped?.textContent]).toEqual(['$378', '2']);
    if (!booked || !stopped) throw new Error('Last 7 days shows both figures');
    expect([...booked.classList]).toContain('cd-type-figure');
    expect([...stopped.classList]).toContain('cd-type-figure-small');
    const sans = /^"Hanken Grotesk"/;
    expectComputed(booked, { fontFamily: sans, fontSize: '32px', lineHeight: '40px', fontWeight: '500', fontVariantNumeric: 'tabular-nums' });
    expectComputed(stopped, { fontFamily: sans, fontSize: '24px', lineHeight: '32px', fontWeight: '420', fontVariantNumeric: 'tabular-nums' });

    // The block shows the API's figures and adds none of its own.
    const heading = block.getByRole('heading', { level: 2 }).element();
    const text = [...block.element().childNodes].map((node) => (node.contains(heading) ? '' : node.textContent)).join(' ');
    const numbers = new Set(text.match(/\d+/g));
    expect([...numbers].sort()).toEqual(['1', '2', '3', '378']);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('this_week_without_the_booked_amount', async () => {
    // Until the API's second pass sends it, the booked amount is absent (never 0): the block says
    // how many bookings there were, and no amount.
    const days = ZERO_DAYS.map((d, i) => ({ ...d, conversations: i === 6 ? 2 : 0, bookings: i === 2 || i === 6 ? 1 : 0 }));
    const figures = week({ bookings: 2, conversations: 2, handled: 2, days });
    delete figures.booked_cents;
    await injectToday((t) => ({ ...t, this_week: figures }));
    const { screen } = await renderRoute(TODAY);
    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('2 bookings, 1 so far today', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
    expect(block.getByText(/booked/).elements()).toHaveLength(0);
    expect(block.element().textContent).not.toMatch(/\$|NaN|undefined/);
    expect(block.getByRole('list', { name: 'Bookings per day' }).getByRole('listitem').elements()).toHaveLength(7);
    await expect.element(block.getByText('Claude handled 2', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('this_week_empty_states', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('No bookings in the last 7 days.', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
    const bars = block.getByRole('list', { name: 'Bookings per day' }).getByRole('listitem');
    expect(bars.elements()).toHaveLength(7);
    const heights = bars.elements().map((bar) => bar.querySelector('.cd-week__bar')?.getBoundingClientRect().height ?? -1);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[0]).toBeLessThanOrEqual(4);
    const bookings = block.getByRole('heading', { name: 'Bookings', exact: true }).element().closest('.cd-week__part');
    expect(bookings?.querySelector('a')).toBeNull();
    await expect.element(block.getByText('No conversations in the last 7 days.', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('heading', { level: 3, name: 'Turned down', exact: true })).toBeVisible();
    await expect.element(block.getByText('Nothing turned down in the last 7 days.', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('link', { name: 'Open Safety' })).toHaveAttribute('href', `${DESK}/safety`);
    expect(block.getByText(/Claude handled/).elements()).toHaveLength(0);
    expect(block.element().textContent).not.toMatch(/attempt|talk it around/i);

    // Claude handled every conversation and the owner didn't step in. That says only what the
    // owner did, never that no one needed them: a request can still be waiting in Needs you.
    mockStore.reset('rivera_quiet');
    await injectToday((t) => ({ ...t, this_week: week({ conversations: 3, handled: 3, stepped_in: 0 }) }));
    const handled = await renderRoute(TODAY);
    const again = region(handled.screen, 'Last 7 days');
    await expect.element(again.getByText('Claude handled 3', { exact: true })).toBeVisible();
    await expect.element(again.getByText("You haven't stepped in.", { exact: true })).toBeVisible();
    expect(again.getByText(/You stepped in/).elements()).toHaveLength(0);
    expect(again.getByText(/No one has needed you/).elements()).toHaveLength(0);
  });

  it('turned_down_counts_refused_requests_only', async () => {
    // Rivera's copy keeps one of Claude's drafts the reply check stopped, which nobody asked for:
    // "Since last night" shows it as blocked, and the last 7 days turned no request down.
    const { screen } = await renderRoute(TODAY);
    const block = region(screen, 'Last 7 days');
    const night = region(screen, 'Since last night');
    await expect.element(night.getByText('A reply was stopped before it was shown.', { exact: true })).toBeVisible();
    await expect.element(block.getByText('Nothing turned down in the last 7 days.', { exact: true })).toBeVisible();

    // The built-in agent tries to charge over its signed limit, which the kernel refuses: that one
    // counts, in the singular.
    const refused = () => [...mockStore.world.decisions.values()].filter((d) => d.decision.state === 'refused').length;
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendAgent', { params: { slug: RIVERA.slug }, body: { task: 'push_the_limit', idempotency_key: 'refuse-1' } });
    await expect.poll(refused, { timeout: 5_000 }).toBe(1);
    await expect.element(block.getByText('1 request', { exact: true })).toBeVisible();
    expect(block.getByText('Nothing turned down in the last 7 days.').elements()).toHaveLength(0);
  });

  it.each(['desktop', 'phone'] as const)('this_week_bars_are_24_px_wide_%s', async (viewport) => {
    // The signed Today boards draw each day's bar 24 px wide, centered over its initial in one of
    // seven equal columns 6 px apart, at every width: a busy day is a taller bar, never a wider one.
    const { screen } = await renderRoute(TODAY, { viewport });
    const list = region(screen, 'Last 7 days').getByRole('list', { name: 'Bookings per day' });
    await expect.element(list).toBeVisible();
    const box = list.element().getBoundingClientRect();
    const days = list
      .getByRole('listitem')
      .elements()
      .map((day) => {
        const room = day.querySelector('.cd-week__bar-room')?.getBoundingClientRect();
        const bar = day.querySelector('.cd-week__bar')?.getBoundingClientRect();
        const initial = day.querySelector('.cd-week__initial');
        if (!room || !bar || !initial) throw new Error('each day has its bar and its initial');
        // The letter itself: the initial's own box stretches across the whole column.
        const letter = document.createRange();
        letter.selectNodeContents(initial);
        return { column: day.getBoundingClientRect(), room, bar, letter: letter.getBoundingClientRect() };
      });
    expect(days).toHaveLength(7);
    const center = (r: DOMRect) => r.left + r.width / 2;
    for (const { column, bar, letter } of days) {
      expect(bar.width).toBe(24);
      expect(center(bar)).toBeCloseTo(center(column), 1);
      expect(letter.width, 'a letter, narrower than its column').toBeLessThan(column.width / 2);
      expect(center(letter)).toBeCloseTo(center(bar), 0);
    }
    expect(days[0]?.column.left).toBeCloseTo(box.left, 1);
    expect(days[6]?.column.right).toBeCloseTo(box.right, 1);
    const gaps = days.slice(1).map((day, i) => day.column.left - (days[i]?.column.right ?? Number.NaN));
    for (const gap of gaps) expect(gap).toBeCloseTo(6, 1);

    // The heights keep their meaning: the seed's one booking, today, fills the room; the rest are flat.
    const heights = days.map(({ bar }) => bar.height);
    expect(heights.at(-1)).toBe(days[6]?.room.height);
    expect(new Set(heights.slice(0, 6))).toEqual(new Set([2]));
  });

  it('window_stays_put_below_the_wide_layout', async () => {
    // Below 1280 px "Last 7 days" sits under the page, deep in the shell's scrolling column. The
    // window itself never scrolls: only the column does, so the shell's bars stay in place.
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('$180 booked', { exact: true })).toBeVisible();
    expect(block.getByRole('list', { name: 'Bookings per day' }).getByRole('listitem').elements()).toHaveLength(7);
    expectNoWindowScroll();
    await page.viewport(1024, 768);
    await expect.poll(() => window.innerWidth).toBe(1024);
    expectNoWindowScroll();
  });

  it('recorded_history_label', async () => {
    const label = 'Includes recorded history';
    await injectToday((t) => ({ ...t, recorded_history: { needs_you: true, briefing: true, this_week: false } }));
    const { screen } = await renderRoute(TODAY);
    const since = region(screen, 'Since last night');
    await expect.element(since.getByRole('link', { name: label })).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(screen.getByRole('link', { name: label }).elements()).toHaveLength(1);
    // Beside the heading, before the night's rows.
    const link = since.getByRole('link', { name: label }).element();
    const firstRow = since.getByRole('listitem').first().element();
    expect(link.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    mockStore.reset('rivera');
    await injectToday((t) => ({ ...t, recorded_history: { briefing: true, this_week: true } }));
    const both = await renderRoute(TODAY);
    await expect.element(region(both.screen, 'Last 7 days').getByRole('link', { name: label })).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(both.screen.getByRole('link', { name: label }).elements()).toHaveLength(2);

    const none = await renderRoute(TODAY, { seed: 'rivera' });
    await expect.element(region(none.screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    await expect.element(none.screen.getByRole('heading', { level: 2, name: 'Last 7 days' })).toBeVisible();
    expect(none.screen.getByRole('link', { name: label }).elements()).toHaveLength(0);
  });

  it('own_chat_shows_under_live_now', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await expect.element(screen.getByText('A quiet night', { exact: true })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Live now' }).elements()).toHaveLength(0);

    // The owner's new tab opens a preview of this Desk and writes in it.
    await mockStore.dispatch('openPreview', { params: { desk_id: RIVERA.deskId } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Do you work weekends?' } });
    const live = region(screen, 'Live now');
    await expect.element(live, { timeout: 2_000 }).toBeVisible();
    const row = live.getByRole('link', { name: /Your preview/ });
    await expect.element(row).toBeVisible();
    await expect.element(row.getByText('Your own preview', { exact: true })).toBeVisible();
    const preview = mockStore.visitorSession(RIVERA.slug);
    await expect.element(row).toHaveAttribute('href', `${DESK}/conversations/${preview?.state.session_id ?? ''}`);
    // It's the owner, so the greeting still says no one else is here.
    await expect.element(screen.getByText('Quiet right now.', { exact: true })).toBeVisible();
  });

  it('unnamed_visitor_reads_visitor_once', async () => {
    // Dana's chat is live, and she hasn't given her name: the row's name line says "Visitor", and
    // its status line doesn't say it again, nor shows its dot alone.
    const { screen } = await renderRoute(TODAY);
    const row = region(screen, 'Live now').getByRole('link');
    await expect.element(row).toBeVisible();
    expect(row.elements()).toHaveLength(1);
    await expect.element(row).toHaveAccessibleName(/^Visitor \d{1,2}:\d{2} [ap]m$/);
    expect(row.getByText('Visitor', { exact: true }).elements()).toHaveLength(1);
    expect(row.element().querySelector('.cd-status-dot')).toBeNull();
  });

  it('live_now_says_when_it_shows', async () => {
    // The signed board's caption in Live now's header: the section is there only while someone chats.
    const { screen } = await renderRoute(TODAY);
    const live = region(screen, 'Live now');
    const caption = live.getByText('Shows while someone is chatting', { exact: true });
    await expect.element(caption).toBeVisible();
    // After the title, before the rows, in the quiet caption style the other Today sections use.
    const heading = live.getByRole('heading', { level: 2, name: 'Live now' }).element();
    const firstRow = live.getByRole('listitem').first().element();
    expect(heading.compareDocumentPosition(caption.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(caption.element().compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect.element(caption).toHaveClass('cd-type-meta');
  });

  it('live_now_fits_a_phone', async () => {
    // Three chats live at once on a phone: the caption stays in the header, beside the title or
    // under it, never over it or past the column, and nothing on the page scrolls sideways.
    await injectToday((t) => {
      const [dana] = t.live;
      if (!dana) throw new Error("the seed has Dana's live chat");
      const alex: ConversationSummary = { ...dana, session_id: 'ses-live-alex', display_name: 'Alex Kim', verified: true };
      const sam: ConversationSummary = { ...dana, session_id: 'ses-live-sam', display_name: 'Sam Ortiz-Delacroix' };
      return { ...t, live: [dana, alex, sam] };
    });
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    const live = region(screen, 'Live now');
    const caption = live.getByText('Shows while someone is chatting', { exact: true });
    await expect.element(caption).toBeVisible();
    expect(live.getByRole('listitem').elements()).toHaveLength(3);
    const column = live.element().getBoundingClientRect();
    const title = live.getByRole('heading', { level: 2, name: 'Live now' }).element().getBoundingClientRect();
    const line = caption.element().getBoundingClientRect();
    const firstRow = live.getByRole('listitem').first().element().getBoundingClientRect();
    expect(line.left).toBeGreaterThanOrEqual(column.left);
    expect(line.right).toBeLessThanOrEqual(column.right);
    expect(line.left >= title.right || line.top >= title.bottom, 'beside the title or under it').toBe(true);
    expect(line.bottom).toBeLessThanOrEqual(firstRow.top);
    const main = screen.getByRole('main').element();
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    expectNoHorizontalScroll();
  });

  it('allow_once_executes_and_updates', async () => {
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }]);
    // The visitor's chat hears the outcome.
    const decisionId = seededHold().decision_id;
    const visitor = mockStore.world.sessions.get(seededHold().session_id);
    await expect
      .poll(() => visitor?.events.some(({ ev }) => ev.type === 'resolved' && ev.decision_id === decisionId), { timeout: 2_000 })
      .toBe(true);
    // Nothing is held now, so Things to try no longer offers to open it: its row stays, ticked off.
    await expect.element(screen.getByRole('button', { name: 'Open the request' })).not.toBeInTheDocument();
    const things = region(screen, 'Things to try');
    await expect.element(things.getByText("Done. Your answer went to the visitor's chat.", { exact: true })).toBeVisible();
    await expect.element(things.getByRole('heading', { level: 3, name: 'Answer a held request' })).toBeVisible();
  });

  it('answer_conflict_shows_final_state', async () => {
    const { screen } = await renderRoute(TODAY);
    const held = seededHold();
    mockStore.inject({ route: 'answer', status: 409, body: { error: 'already_resolved', decision: { ...held, state: 'expired', answers: [] } } });
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText('This request expired before you answered. Nothing was done.', { exact: true })).toBeVisible();
    expect(region(screen, 'Needs you').getByRole('alert').elements()).toHaveLength(0);
    expect(card.getByRole('button', { name: /Allow|Deny/ }).elements()).toHaveLength(0);
  });

  it('held_conflict_shows_the_owner_line', async () => {
    // The kernel's own conflict, with no decision: the request is still held, but it changed while
    // the owner was looking, so Today never sends the answer again. It reads Needs you once and
    // shows the request as it stands now, with the owner line above it and only the answers that
    // read offers. Polls stay out of the way, so the one read counted is the conflict's.
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const needsYou = region(screen, 'Needs you');
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    const deny = card.getByRole('button', { name: 'Deny this time' });
    await expect.element(allow).toBeVisible();

    // Where it stands now: still held, and Allow is no longer offered. A decision in the conflict's
    // body isn't the final state (only `already_resolved` carries one), so it's never shown.
    const held = seededHold();
    const changed = (await heldItems()).map((item) =>
      item.decision?.decision_id === held.decision_id ? { ...item, decision: { ...item.decision, answers: ['deny_once'] } } : item,
    );
    mockStore.inject({ route: 'answer', status: 409, body: { error: 'kernel', code: 'conflict', decision: { ...held, state: 'executed', answers: [] } } });
    mockStore.inject({ route: 'needsYou', status: 200, delayMs: 1_000, body: changed });
    const reads = requests('needsYou').length;

    // While the request is read again, the answer the owner chose still spins and the other waits.
    await allow.click();
    await expect.element(allow).toHaveAttribute('aria-busy', 'true');
    await expect.element(deny).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(() => requests('needsYou').length).toBe(reads + 1);
    await expect.element(allow).toHaveAttribute('aria-busy', 'true');

    // Then the card shows the read: still waiting, with Deny only, and the line above the request.
    await expect.element(allow, { timeout: 3_000 }).not.toBeInTheDocument();
    await expect.element(deny).not.toHaveAttribute('aria-disabled');
    await expect.element(card.getByText('Waiting for your answer', { exact: true })).toBeVisible();
    const line = needsYou.getByRole('alert');
    await expect.element(line.getByText(CHANGED, { exact: true })).toBeVisible();
    expect(line.elements()).toHaveLength(1);
    expect(card.getByRole('alert').elements()).toHaveLength(0);
    expect(line.element().closest('li')).toBe(card.element().closest('li'));
    expect(line.element().compareDocumentPosition(card.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.getByText("You allowed this. It's done.", { exact: true }).elements()).toHaveLength(0);
    // Nothing offers to send the answer again, nothing sent it, and the read was the only one.
    expect(needsYou.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(0);
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }]);
    expect(requests('needsYou')).toHaveLength(reads + 1);
    // Allow had focus, and it went with Allow: it lands on the request.
    expect(focusIsOn(card.element())).toBe(true);

    // The owner answers what they can see, and it goes through.
    await deny.click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }, { answer: 'deny_once' }]);
    expect(needsYou.getByRole('alert').elements()).toHaveLength(0);
  });

  it('held_conflict_waits_for_a_fresh_read', async () => {
    // After the kernel's conflict, the read of the request fails (and its one retry): what it would
    // offer isn't known, so the card offers no answers until a read works.
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const needsYou = region(screen, 'Needs you');
    const card = heldCard(screen, SEEDED_REASON);
    const deny = card.getByRole('button', { name: 'Deny this time' });
    await expect.element(deny).toBeVisible();
    mockStore.inject({ route: 'answer', status: 409, body: { error: 'kernel', code: 'conflict' } });
    mockStore.inject({ route: 'needsYou', status: 503, times: 2 });

    await deny.click();
    await expect.element(needsYou.getByText(UNAVAILABLE, { exact: true }), { timeout: 4_000 }).toBeVisible();
    await expect.element(needsYou.getByText(CHANGED, { exact: true })).toBeVisible();
    await expect.element(card.getByText('Waiting for your answer', { exact: true })).toBeVisible();
    expect(card.getByRole('button').elements()).toHaveLength(0);
    expect(focusIsOn(card.element())).toBe(true);
    expect(requests('answer')).toHaveLength(1);

    // Reading again works, and the answers come back as that read offers them, still unsent.
    await needsYou.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.element(card.getByRole('button', { name: 'Allow this time' })).toBeVisible();
    await expect.element(deny).not.toHaveAttribute('aria-disabled');
    await expect.element(needsYou.getByText(UNAVAILABLE, { exact: true })).not.toBeInTheDocument();
    expect(requests('answer')).toHaveLength(1);
  });

  it('lost_answer_is_not_called_held', async () => {
    const { screen } = await renderRoute(TODAY);
    // The answer goes through, but its answer is lost on the way back.
    mockStore.inject({ route: 'answer', status: 'network', afterCommit: true });
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    await allow.click();
    await expect.element(card.getByText(UNCERTAIN, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('still held');
    await expect.element(allow).not.toHaveAttribute('aria-disabled');
    // Needs you reads again and the request has gone from it; its card stays to be asked again.
    await readsMore('needsYou', 2);
    await expect.element(card.getByText(UNCERTAIN, { exact: true })).toBeVisible();

    // Asking again can't run it twice: the API answers with where it stands.
    await allow.click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(requests('answer')).toHaveLength(2);
    expect(card.getByRole('alert').elements()).toHaveLength(0);
  });

  it('answer_lands_in_its_slot', async () => {
    // Things to try hidden, as the board draws it, so only the card is in play.
    writeLocal('thingsToTryHidden', 'true');
    const { screen } = await renderRoute(TODAY);
    const needs = region(screen, 'Needs you');
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    await expect.element(allow).toBeVisible();
    const live = region(screen, 'Live now');
    await expect.element(live).toBeVisible();
    const element = card.element();
    const item = element.closest('li');
    if (!item) throw new Error('the card sits in an item of Needs you');

    const watching = watchAnswerLanding(element, item, live.element());
    await allow.click();
    const frames = await watching;

    // The same card, in the same place, with its final line and Dismiss under it: no heading of its own.
    expect(heldCard(screen, SEEDED_REASON).element()).toBe(element);
    expect(element.closest('li')).toBe(item);
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    const dismiss = needs.getByRole('button', { name: 'Dismiss' }).element();
    expect(item.contains(dismiss)).toBe(true);
    expect(element.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Answered just now' }).elements()).toHaveLength(0);
    // Live now glides up by what the item lost (the answers, against Dismiss), and never down.
    expect(expectLandedInPlace(frames)).toBeGreaterThan(0);
    // The count counts only what's still open.
    expect(needs.getByRole('img', { name: /needs? you$/ }).elements()).toHaveLength(0);
  });

  it('always_answer_lands_with_its_rule', async () => {
    writeLocal('thingsToTryHidden', 'true');
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(TODAY);
    const needs = region(screen, 'Needs you');
    const card = heldCard(screen, REFUND_REASON);
    const deny = card.getByRole('button', { name: 'Deny', exact: true });
    await expect.element(deny).toBeVisible();
    const element = card.element();
    const item = element.closest('li');
    if (!item) throw new Error('the card sits in an item of Needs you');

    await deny.click();
    const watching = watchAnswerLanding(element, item, region(screen, 'Live now').element());
    await screen.getByRole('menuitem', { name: 'Always' }).click();
    const frames = await watching;

    // The same card, settled in its place, with the rule the answer drafted under it, then Dismiss.
    expect(heldCard(screen, REFUND_REASON).element()).toBe(element);
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    const notice = needs.getByText(DRAFTED, { exact: true }).element();
    const dismiss = needs.getByRole('button', { name: 'Dismiss' }).element();
    expect(item.contains(notice)).toBe(true);
    expect(item.contains(dismiss)).toBe(true);
    expect(element.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // What follows moves one way only, to where the settled card, rule and Dismiss put it.
    expectLandedInPlace(frames);
    // The seeded request still waits, before it, and the count says so.
    await expect.element(needs.getByRole('img', { name: '1 needs you' })).toBeVisible();
    const order = needs.getByRole('article').elements().map((a) => a.getAttribute('aria-label'));
    expect(order).toEqual([`Held for you: ${SEEDED_REASON}`, `Held for you: ${REFUND_REASON}`]);
  });

  it('answered_card_survives_refetch', async () => {
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    await readsMore('needsYou', 2);
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Answered just now' }).elements()).toHaveLength(0);

    // Dismissed, it goes.
    await region(screen, 'Needs you').getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(card).not.toBeInTheDocument();
  });

  it('dismissing_the_last_answer_focuses_live_now', async () => {
    // The only request, answered here, then dismissed from the keyboard with the page scrolled down
    // to it: Needs you goes, and focus goes on to Live now, the section after it, where the page stands.
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    await allowTheSeededRequest(screen);
    expect(region(screen, 'Needs you').getByRole('article').elements()).toHaveLength(1);
    const live = region(screen, 'Live now');
    const column = await focusDismissAtTheFoot(screen, live.element());

    const before = { column: column.scrollTop, window: window.scrollY };
    await userEvent.keyboard('{Enter}');
    await expect.element(region(screen, 'Needs you')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(live.element());
    expect(column.scrollTop).toBe(before.column);
    expect(window.scrollY).toBe(before.window);
    // Live now has moved up into the place Needs you left, in sight.
    const box = live.element().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(column.getBoundingClientRect().top);
    expect(box.bottom).toBeLessThanOrEqual(column.getBoundingClientRect().bottom);
  });

  it('dismissing_the_last_answer_with_no_live_chat_focuses_since_last_night', async () => {
    // No chat is live, so Today draws no Live now: focus goes on to Since last night instead, where
    // the page stands.
    await injectToday((t) => ({ ...t, live: [] }));
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    await allowTheSeededRequest(screen);
    expect(region(screen, 'Needs you').getByRole('article').elements()).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Live now' }).elements()).toHaveLength(0);
    const since = region(screen, 'Since last night');
    const column = await focusDismissAtTheFoot(screen, since.element());

    const before = { column: column.scrollTop, window: window.scrollY };
    await userEvent.keyboard('{Enter}');
    await expect.element(region(screen, 'Needs you')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(since.element());
    expect(column.scrollTop).toBe(before.column);
    expect(window.scrollY).toBe(before.window);
    expect(since.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(column.getBoundingClientRect().top);
  });

  it('dismissing_before_the_refresh_finishes_keeps_focus_in_needs_you', async () => {
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    const read = holdReads(needsYouPath);
    onTestFinished(read.release);
    await allowTheSeededRequest(screen);
    await vi.waitFor(() => expect(read.held()).toBeGreaterThan(0));
    const needs = region(screen, 'Needs you');

    // Dismiss before the answer's refresh lands: the cached hold reappears, so the section stays.
    await dismissFromTheKeyboard(screen);
    await expect.element(needs.getByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    await expect.element(heldCard(screen, SEEDED_REASON).getByRole('button', { name: 'Allow this time' })).toBeVisible();
    expect(document.activeElement).toBe(needs.element());

    read.release();
    await expect.element(needs).not.toBeInTheDocument();
  });

  it('dismissing_an_answer_with_a_request_still_held_focuses_needs_you', async () => {
    // Another request still waits, so Needs you stays, and focus goes to it, as it always has.
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    await expect.element(heldCard(screen, REFUND_REASON)).toBeVisible();
    await allowTheSeededRequest(screen);
    const needs = region(screen, 'Needs you');

    await dismissFromTheKeyboard(screen);
    await expect.element(heldCard(screen, SEEDED_REASON)).not.toBeInTheDocument();
    await expect.element(heldCard(screen, REFUND_REASON)).toBeVisible();
    expect(document.activeElement).toBe(needs.element());
  });

  it('dismissing_the_last_answer_while_reads_fail_focuses_needs_you', async () => {
    // Needs you can't be read, and says so: it stays to say it once its last request goes, so focus
    // stays on it.
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    await allowTheSeededRequest(screen);
    const needs = region(screen, 'Needs you');
    const line = needs.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();

    await dismissFromTheKeyboard(screen);
    await expect.element(heldCard(screen, SEEDED_REASON)).not.toBeInTheDocument();
    await expect.element(line).toBeVisible();
    expect(document.activeElement).toBe(needs.element());
  });

  it('rule_draft_from_answer_links_to_review', async () => {
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, REFUND_REASON);
    await card.getByRole('button', { name: 'Deny' }).click();
    await screen.getByRole('menuitem', { name: 'Always' }).click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'deny_always' }]);

    const notice = screen.getByText(DRAFTED, { exact: true });
    await expect.element(notice).toBeVisible();
    await screen.getByRole('button', { name: 'Review the rule' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${DESK}/rules/drafts/8`);
    expect(requests('draftRules')).toHaveLength(1);
    const body = requests('draftRules')[0]?.body as { add: { mode: string; who: string; person_id: string; applies_to: string }[] };
    expect(body.add).toHaveLength(1);
    expect(body.add[0]).toMatchObject({ mode: 'never', who: 'person', person_id: rivera.people.dana.personId, applies_to: 'payments.create_refund' });
    expect(router.state.location.state).toMatchObject({ cardDiff: body.add, draft: { version: 8 } });
  });

  it('held_request_appears_without_reload', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await expect.element(screen.getByText('A quiet night', { exact: true })).toBeVisible();
    await visitorSays('50% off if I pay cash');
    await expect.element(screen.getByRole('article', { name: /^Held for you: / }), { timeout: 2_000 }).toBeVisible();
    await expect.element(region(screen, 'Needs you').getByRole('button', { name: 'Allow this time' })).toBeVisible();
  });

  it('held_request_without_a_step_in_is_not_called_unneeded', async () => {
    // A request waiting for the owner's answer isn't a step-in until they answer it, so the week can
    // count none while Needs you lists one. Today then says the owner hasn't stepped in, and never
    // that no one needed them.
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await expect.element(screen.getByText('A quiet night', { exact: true })).toBeVisible();
    await visitorSays('50% off if I pay cash');
    const held = region(screen, 'Needs you').getByRole('article', { name: /^Held for you: / });
    await expect.element(held, { timeout: 2_000 }).toBeVisible();

    // The mock's own week, with nothing injected: one conversation, Claude's, and no step-in.
    const answer = await mockStore.dispatch('today', { params: { desk_id: RIVERA.deskId } });
    if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Today');
    expect((answer.body as Today).this_week).toMatchObject({ conversations: 1, handled: 1, stepped_in: 0 });

    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('Claude handled 1', { exact: true }), { timeout: 5_000 }).toBeVisible();
    await expect.element(block.getByText("You haven't stepped in.", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/No one has needed you/);

    // Polls come and go, the request still waits, and the words hold.
    await readsMore('today', 2);
    await expect.element(held).toBeVisible();
    await expect.element(block.getByText("You haven't stepped in.", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/No one has needed you/);
  });

  it('needs_you_reads_the_api_shape', async () => {
    // The API sends every NeedsYouItem field, the other alternative's as null (openapi.json): a
    // held request has `handoff: null`, a callback `decision: null, held_by: null, held_at: null`.
    await visitorSays('Can you call me back?');
    const read = async () => {
      const answer = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
      if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Needs you');
      return answer.body as Record<string, unknown>[];
    };
    // The scripted turn files the callback a moment after the message.
    await expect.poll(async () => (await read()).some((item) => item.handoff != null), { timeout: 2_000 }).toBe(true);
    const asTheApiSendsIt: Record<string, unknown>[] = (await read()).map((item) =>
      'decision' in item && item.decision ? { ...item, handoff: null } : { ...item, decision: null, held_by: null, held_at: null },
    );
    expect(asTheApiSendsIt.some((item) => item.handoff === null)).toBe(true);
    expect(asTheApiSendsIt.some((item) => item.decision === null)).toBe(true);
    mockStore.inject({ route: 'needsYou', status: 200, times: 10_000, body: asTheApiSendsIt });

    const { screen } = await renderRoute(TODAY);
    const needsYou = region(screen, 'Needs you');
    await expect.element(needsYou.getByText(SEEDED_REASON, { exact: false }).first()).toBeVisible();
    await expect.element(screen.getByRole('article', { name: 'Wants you' }).first()).toBeVisible();
    await expect.element(screen.getByRole('article', { name: 'Wants you' }).first().getByText(CALLBACK_REASON, { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain('handoff_id');
    await expectScreenBasics(screen.container, { owner: true });

    // A conversation reads it the same way: its held request, answerable in place.
    const { screen: chat } = await renderRoute(`${DESK}/conversations/ses-visitor-web`);
    await expect.element(heldCard(chat, SEEDED_REASON)).toBeVisible();
    await expect.element(heldCard(chat, SEEDED_REASON).getByRole('button', { name: 'Allow this time' })).toBeVisible();
  });

  it('handoff_offers_to_join', async () => {
    const { screen, router } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await visitorSays('Can you call me back?');
    const wants = screen.getByRole('article', { name: 'Wants you' });
    await expect.element(wants.first(), { timeout: 2_000 }).toBeVisible();
    await expect.element(wants.first().getByText(CALLBACK_REASON, { exact: true })).toBeVisible();
    expect(wants.first().getByText(CALLBACK_REASON).element().closest('[data-copy="user"]')).not.toBeNull();
    await expect.element(wants.first().getByText("You'll call back on Monday, between 8:00 am and 9:00 am.", { exact: true })).toBeVisible();
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Please call me tonight' } });
    await expect.poll(() => wants.elements().length, { timeout: 2_000 }).toBe(2);
    await expect.element(wants.nth(1).getByText("You'll call back. No time was promised.", { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // Joining reads the chat, takes it over at the generation read, and opens it.
    const session = mockStore.visitorSession(RIVERA.slug);
    const sessionId = session?.state.session_id ?? '';
    const generation = session?.state.generation;
    await wants.first().getByRole('button', { name: 'Join the chat' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${DESK}/conversations/${sessionId}`);
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation }]);
    expect(requests('conversation').length).toBeGreaterThan(0);
    expect(router.state.location.state).toBeNull();

    // A take-over that fails still opens the chat, with the reason there.
    const again = await renderRoute(TODAY);
    mockStore.inject({ route: 'takeover', status: 503 });
    await again.screen.getByRole('article', { name: 'Wants you' }).first().getByRole('button', { name: 'Join the chat' }).click();
    await expect.poll(() => again.router.state.location.pathname).toBe(`${DESK}/conversations/${sessionId}`);
    expect(again.router.state.location.state).toEqual({ notice: 'Something went wrong on our side. Try again in a moment.' });
  });

  it('callback_card_busies_only_the_pressed_button', async () => {
    const { screen, router } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await visitorSays('Can you call me back?');
    const wants = screen.getByRole('article', { name: 'Wants you' });
    await expect.element(wants, { timeout: 2_000 }).toBeVisible();
    const join = wants.getByRole('button', { name: 'Join the chat' });
    const done = wants.getByRole('button', { name: 'Mark done' });

    // While "Mark done" is out, it spins with its words kept, and "Join the chat" waits: its words
    // shown with no spinner, still in the tab order, and a click on it does nothing.
    mockStore.inject({ route: 'handoffDone', status: 503, delayMs: 1_000 });
    await done.click();
    await expect.element(done).toHaveAttribute('aria-busy', 'true');
    await expectWaiting(join, 'Join the chat');
    expect(wants.element().querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    const reads = requests('conversation').length;
    (join.element() as HTMLButtonElement).click();
    await expect.element(done, { timeout: 3_000 }).not.toHaveAttribute('aria-busy');
    expect(requests('conversation')).toHaveLength(reads);
    expect(router.state.location.pathname).toBe(TODAY);
    await expect.element(join).not.toHaveAttribute('aria-disabled');
    await expect.element(join).toBeEnabled();

    // And the other way round, while joining reads the chat.
    mockStore.inject({ route: 'conversation', status: 503, delayMs: 1_000 });
    await join.click();
    await expect.element(join).toHaveAttribute('aria-busy', 'true');
    await expectWaiting(done, 'Mark done');
    expect(wants.element().querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    (done.element() as HTMLButtonElement).click();
    await expect.poll(() => router.state.location.pathname, { timeout: 3_000 }).not.toBe(TODAY);
    expect(requests('handoffDone')).toHaveLength(1);
  });

  it('handoff_done_clears_the_card', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await visitorSays('Can you call me back?');
    const wants = screen.getByRole('article', { name: 'Wants you' });
    await expect.element(wants.first(), { timeout: 2_000 }).toBeVisible();
    const [handoffId] = [...mockStore.world.handoffs.keys()];
    await wants.first().getByRole('button', { name: 'Mark done' }).click();
    await expect.element(wants.first()).not.toBeInTheDocument();
    expect(requests('handoffDone').map((r) => r.path)).toEqual([`/api/owner/handoffs/${handoffId ?? ''}/done`]);
    expect(screen.getByRole('heading', { name: 'Needs you' }).elements()).toHaveLength(0);

    // Someone else closed it first: Today reads again and says nothing went wrong.
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can you call me back?' } });
    await expect.element(wants.first(), { timeout: 2_000 }).toBeVisible();
    mockStore.inject({ route: 'handoffDone', status: 409, body: { error: 'kernel', code: 'conflict' } });
    const reads = requests('needsYou').length;
    await wants.first().getByRole('button', { name: 'Mark done' }).click();
    await expect.poll(() => requests('handoffDone').length).toBe(2);
    await expect.poll(() => requests('needsYou').length).toBeGreaterThan(reads);
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
  });

  it('allow_person_above_the_limit_says_so', async () => {
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, REFUND_REASON);

    // The limit was lowered after Today was read: the kernel no longer offers this answer.
    mockStore.inject({ route: 'answer', status: 422, body: { error: 'kernel', code: 'invalid' } });
    await card.getByRole('button', { name: 'Allow' }).click();
    await screen.getByRole('menuitem', { name: 'Only for Dana Whitfield, always' }).click();
    await expect.element(card.getByText(LIMIT_LINE, { exact: true })).toBeVisible();
    await expect.element(card.getByRole('button', { name: 'Allow' })).not.toHaveAttribute('aria-disabled');

    mockStore.inject({ route: 'answer', status: 422, body: { error: 'kernel', code: 'invalid' } });
    await card.getByRole('button', { name: 'Deny' }).click();
    await screen.getByRole('menuitem', { name: 'Always' }).click();
    await expect.element(card.getByText(NOT_OFFERED, { exact: true })).toBeVisible();
    expect(card.getByText(LIMIT_LINE).elements()).toHaveLength(0);
    await expect.element(card.getByRole('button', { name: 'Deny' })).not.toHaveAttribute('aria-disabled');
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_person' }, { answer: 'deny_always' }]);
  });

  it('card_diff_above_the_limit_says_so', async () => {
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, REFUND_REASON);
    await card.getByRole('button', { name: 'Allow' }).click();
    await screen.getByRole('menuitem', { name: 'Only for Dana Whitfield, always' }).click();
    await expect.element(screen.getByText(DRAFTED, { exact: true })).toBeVisible();

    mockStore.inject({ route: 'draftRules', status: 422, body: { error: 'above_money_cap', cap_cents: 0 } });
    await screen.getByRole('button', { name: 'Review the rule' }).click();
    await expect
      .element(screen.getByText("You haven't set a limit for taking money without asking. Set one first.", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("That didn't go through. Check it and try again.");
    expect(router.state.location.pathname).toBe(TODAY);
  });

  it.each(['desktop', 'phone'] as const)('things_to_try_opens_the_vision_article_on_%s', async (viewport) => {
    // One quiet link under the list, after its card, opens the Vision article under About this prototype.
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const things = region(screen, 'Things to try');
    const link = things.getByRole('link', { name: 'Vision: where a Desk could go next', exact: true });
    await expect.element(link).toHaveAttribute('href', '/about/vision');
    const list = things.getByRole('list').first().element();
    expect(link.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(list.getBoundingClientRect().bottom);
    // It replaces the link to the city office: no other link leads to a vision page.
    const vision = things.getByRole('link').elements().filter((a) => (a.getAttribute('href') ?? '').startsWith('/vision/'));
    expect(vision).toEqual([]);
    expect(things.element().textContent).not.toContain('Where this is going');
    // The same tab, through the router: the app stays loaded.
    expect(link.element().getAttribute('target')).toBeNull();
    await link.click();
    await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'A front desk that never closes', exact: true })).toBeVisible();
    await expect.poll(() => window.scrollY).toBe(0);
    const heading = screen.container.querySelector('h1')?.getBoundingClientRect();
    expect(heading?.top).toBeGreaterThanOrEqual(0);
    expect(heading?.bottom).toBeLessThanOrEqual(window.innerHeight);
  });
});

describe("Today's unfinished setup", () => {
  /** The start step's first example: Okafor Plumbing, whose owner is Daniel. */
  const OKAFOR = START_EXAMPLES.en.examples[0]?.description ?? '';

  /** A Desk the mock's setup made, its questions answered, then left at its tools. */
  async function deskAtTools(): Promise<SetupState> {
    const started = await mockStore.dispatch('startSetup', { body: { description: OKAFOR, timezone: LA, idempotency_key: newIdempotencyKey() } });
    if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
    const state = started.body as SetupState;
    const id = state.interview_id;
    await mockStore.dispatch('setupConsent', { params: { id }, body: { allow: false } });
    for (const question of SETUP_QUESTIONS) await mockStore.dispatch('setupAnswer', { params: { id }, body: { question: question.key, text: 'Yes, that works.' } });
    return state;
  }

  /** A Desk the mock's setup made, its questions answered and its rules drafted, then left there. */
  async function deskAtRules(): Promise<SetupState> {
    const state = await deskAtTools();
    await mockStore.dispatch('setupRules', { params: { id: state.interview_id } });
    return state;
  }

  it('unfinished_setup_leads_back_into_it', async () => {
    // Daniel left his new Desk's setup at its rules. Its Today says it isn't live yet, at the top of
    // the page, and leads back into the interview at that step.
    const state = await deskAtRules();
    const { screen, router } = await renderRoute(`/app/${state.desk_id}/today`);
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect.element(card).toBeVisible();
    await expect.element(card.getByText('Not live yet', { exact: true })).toBeVisible();
    expect(card.element().querySelector('.cd-status-dot--held')).not.toBeNull();
    const title = card.getByRole('heading', { level: 2, name: 'Finish setting up Okafor Plumbing' });
    await expect.element(title).toBeVisible();
    // The business's name is the owner's own words.
    expect(title.element().querySelector('[data-copy="user"]')?.textContent).toBe('Okafor Plumbing');
    await expect
      .element(
        card.getByText(
          "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.",
          { exact: true },
        ),
      )
      .toBeVisible();
    // The setup steps, at Rules.
    const steps = card.getByRole('list', { name: 'Setup steps' });
    expect(steps.getByRole('listitem').elements().map((step) => step.textContent)).toEqual(['Questions, done', 'Tools, done', '3Rules', '4Safety check', '5Live']);
    expect(steps.element().querySelector('[aria-current="step"]')?.textContent).toBe('3Rules');
    const resume = card.getByRole('link', { name: 'Continue setup' });
    await expect.element(resume).toHaveAttribute('href', `/app/setup/${state.interview_id}`);

    // It comes first in Today's column, above Things to try, which stays.
    const things = screen.getByRole('heading', { level: 2, name: 'Things to try' }).element();
    expect(card.element().compareDocumentPosition(things) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expectScreenBasics(screen.container, { owner: true });

    // "Continue setup" reopens the interview at its rules.
    await resume.click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Your rules' })).toBeVisible();
  });

  it('save_and_exit_lands_on_the_card', async () => {
    // Leaving setup with "Save and exit" opens the new Desk's Today, which leads back in: no loop
    // between the two, and the card names the step the owner left.
    const state = await deskAtRules();
    const { screen, router } = await renderRoute(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Your rules' })).toBeVisible();
    await screen.getByRole('link', { name: 'Save and exit' }).first().click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${state.desk_id}/today`);
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect
      .element(
        card.getByText(
          "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(router.state.location.pathname).toBe(`/app/${state.desk_id}/today`);
  });

  /** The card's line at the rules, with Answering off. */
  const AT_RULES = "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.";

  /**
   * Opens setup at its tools, with the copy's Desks read there, at the tools; then `meanwhile` sets
   * how the Desks answer from here on, the owner goes on to the rules and, once the draft is in and
   * the API has moved setup on, leaves with "Save and exit" at once, within the few seconds Today
   * counts the Desks read as fresh. Resolves on Today.
   */
  async function leaveRightAfterAStep(meanwhile: () => void = () => undefined): Promise<RenderResult> {
    const state = await deskAtTools();
    const { screen, router } = await renderRoute(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    // The bar names the business once the copy's Desks are read, at the tools.
    await expect.element(screen.getByText('Okafor Plumbing', { exact: true }).first()).toBeVisible();
    meanwhile();
    const startedAt = performance.now();
    await screen.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Your rules' })).toBeVisible();
    await expect.poll(() => requests('setupRules').length).toBeGreaterThan(0);
    await expect.element(screen.getByRole('button', { name: 'Check real situations' })).toBeVisible();
    // Today never draws the step before, not even for a moment as it opens.
    const sawTools = watchFor('Pick up at your tools');
    onTestFinished(() => expect(sawTools(), 'Today drew the tools step').toBe(false));
    await screen.getByRole('link', { name: 'Save and exit' }).first().click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${state.desk_id}/today`);
    expect(performance.now() - startedAt, "left within the Desks' fresh window").toBeLessThan(5_000);
    return screen;
  }

  /** The card names the rules, with the steps at Rules. */
  async function expectCardAtRules(screen: RenderResult): Promise<void> {
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect.element(card.getByText(AT_RULES, { exact: true })).toBeVisible();
    expect(card.getByRole('list', { name: 'Setup steps' }).element().querySelector('[aria-current="step"]')?.textContent).toBe('3Rules');
  }

  it('leaving_setup_right_after_a_step_names_the_new_step', async () => {
    // The owner reads setup at its tools, goes on to the rules and leaves at once: the card names the rules, not the tools.
    await expectCardAtRules(await leaveRightAfterAStep());
  });

  it('leaving_setup_names_the_new_step_while_the_desks_are_still_read', async () => {
    // The copy's Desks, read again from the tools on, answer slowly: each read is answered as setup
    // stands when it arrives, and the answer comes only when the test lets it. Today already names
    // the step setup holds, rather than the one the Desks named at the tools.
    let held = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const screen = await leaveRightAfterAStep(() => {
      worker.use(
        http.get(ROUTES.desks.path, async () => {
          held += 1;
          const answer = await mockStore.dispatch('desks');
          await released;
          if ('network' in answer) return HttpResponse.error();
          return HttpResponse.json(answer.body as object, { status: answer.status });
        }),
      );
    });
    await expect.poll(() => held).toBeGreaterThan(0);
    await expectCardAtRules(screen);
    // The answers come: the read sent as setup moved on, answered with the tools before the draft
    // moved the API on, is let go; the one sent since names the rules. The card still names them.
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expectCardAtRules(screen);
  });

  it('leaving_setup_names_the_new_step_when_the_desks_cannot_be_read', async () => {
    // The copy's Desks can't be read again after the tools: Today still names the step setup holds,
    // and keeps naming it while the reads keep failing.
    let before = 0;
    const screen = await leaveRightAfterAStep(() => {
      before = requests('desks').length;
      mockStore.inject({ route: 'desks', status: 503, times: 10_000 });
    });
    await expectCardAtRules(screen);
    // Every read of the Desks from the tools on fails: the step change's, and Today's own with its retry.
    await expect.poll(() => requests('desks').length - before, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    await expectCardAtRules(screen);
  });

  it('with_answering_on_the_line_says_nothing_of_answering', async () => {
    // The Answering switch is separate from setup: Daniel turned Answering on before finishing his
    // setup, so the card names where he picks up, and says nothing of Answering staying off.
    const state = await deskAtRules();
    await mockStore.dispatch('setAnswering', { params: { desk_id: state.desk_id }, body: { on: true } });
    const { screen } = await renderRoute(`/app/${state.desk_id}/today`);
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect
      .element(card.getByText("Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live.", { exact: true }))
      .toBeVisible();
    expect(card.element().textContent).not.toMatch(/Answering/);
    await expect.element(screen.getByRole('switch', { name: /Answering/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('a_draft_that_lands_after_leaving_moves_the_card_on', async () => {
    // The owner goes on from the tools and leaves while the rules draft is still being made: the API
    // still has setup at its tools, so Today names them. Once the draft lands and the API moves setup
    // on, Today names the rules, with no reload.
    const state = await deskAtTools();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.post(ROUTES.setupRules.path.replace('{id}', state.interview_id), async () => {
        await released;
        return undefined;
      }),
    );
    const { screen, router } = await renderRoute(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    await screen.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.element(screen.getByText('Drafting your rules', { exact: true })).toBeVisible();
    await screen.getByRole('link', { name: 'Save and exit' }).first().click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${state.desk_id}/today`);
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect
      .element(card.getByText('Your answers are saved. Pick up at your tools. Answering stays off until your Desk is live.', { exact: true }))
      .toBeVisible();

    release();
    await expectCardAtRules(screen);
  });

  /** The card's line at the tools, with Answering off. */
  const AT_TOOLS = 'Your answers are saved. Pick up at your tools. Answering stays off until your Desk is live.';

  /**
   * From Today, setup reopened at its tools; the rules it goes on to can't be checked (the API keeps
   * it at the tools), and the owner leaves from there with "Save and exit", back to a Today already
   * read. `meanwhile` runs once setup shows its tools. Resolves on Today, watching for the rules ever
   * being named on the way.
   */
  async function leaveAfterACheckThatCannotRun(meanwhile: () => void = () => undefined) {
    const state = await deskAtTools();
    mockStore.inject({ route: 'setupRules', status: 409, body: { error: 'rules_cannot_be_checked' } });
    const { screen, router } = await renderRoute(`/app/${state.desk_id}/today`);
    const first = region(screen, 'Finish setting up Okafor Plumbing');
    await expect.element(first.getByText(AT_TOOLS, { exact: true })).toBeVisible();
    await first.getByRole('link', { name: 'Continue setup' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    meanwhile();
    await screen.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.element(screen.getByText(/^I can't check these rules right now/)).toBeVisible();
    const sawRules = watchFor('Pick up at your rules');
    await screen.getByRole('link', { name: 'Save and exit' }).first().click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${state.desk_id}/today`);
    return { screen, router, state, sawRules };
  }

  it('rules_that_cannot_be_checked_leave_today_at_the_tools', async () => {
    // The API keeps setup at its tools when its rules can't be checked: Today names the tools, and
    // never the rules the page went on to, not even for a moment.
    const { screen, sawRules } = await leaveAfterACheckThatCannotRun();
    await expect.element(region(screen, 'Finish setting up Okafor Plumbing').getByText(AT_TOOLS, { exact: true })).toBeVisible();
    expect(sawRules()).toBe(false);
  });

  it('rules_that_cannot_be_checked_reopen_at_the_tools_when_the_desks_cannot_be_read', async () => {
    // The same, with the copy's Desks failing from the tools on: the card still names the tools, and
    // "Continue setup" opens the tools, whose Continue checks the rules again.
    const { screen, router, state, sawRules } = await leaveAfterACheckThatCannotRun(() => {
      mockStore.inject({ route: 'desks', status: 503, times: 10_000 });
    });
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect.element(card.getByText(AT_TOOLS, { exact: true })).toBeVisible();
    expect(sawRules()).toBe(false);
    await card.getByRole('link', { name: 'Continue setup' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
  });

  it('the_card_waits_for_today_to_open', async () => {
    // Leaving setup for Today while what Today first shows is still being read: Today holds its
    // loading line alone, with no card, then opens with the card first.
    const state = await deskAtRules();
    const needsYou = holdReads(ROUTES.needsYou.path.replace('{desk_id}', state.desk_id));
    const { screen, router } = await renderRoute(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('button', { name: 'Check real situations' })).toBeVisible();
    await screen.getByRole('link', { name: 'Save and exit' }).first().click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${state.desk_id}/today`);
    await vi.waitFor(() => expect(needsYou.held()).toBeGreaterThan(0));
    await expect.element(screen.getByText('Opening your Desk', { exact: true })).toBeVisible();
    expect(screen.getByText('Not live yet').elements()).toHaveLength(0);

    needsYou.release();
    const card = region(screen, 'Finish setting up Okafor Plumbing');
    await expect.element(card).toBeVisible();
    const things = screen.getByRole('heading', { level: 2, name: 'Things to try' }).element();
    expect(card.element().compareDocumentPosition(things) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('unfinished_setup_fits_a_laptop_and_a_phone', async () => {
    // On a laptop "Continue setup" sits at the words' right, level with their top. On a phone the
    // card still comes first, and the button drops under the words, from their left edge, as Today's
    // other rows do. Nothing scrolls sideways at either width.
    const state = await deskAtRules();
    const parts = (screen: RenderResult) => {
      const card = region(screen, 'Finish setting up Okafor Plumbing');
      return {
        card: card.element().getBoundingClientRect(),
        // The "Not live yet" line, the words' first.
        status: (card.getByText('Not live yet', { exact: true }).element().closest('p') ?? document.body).getBoundingClientRect(),
        line: card.getByText(/^Your answers are saved\./).element().getBoundingClientRect(),
        button: card.getByRole('link', { name: 'Continue setup' }).element().getBoundingClientRect(),
        // The steps as drawn: the row, or under 480 px of its own width the one line that says where it is.
        steps: (card.getByRole('list', { name: 'Setup steps' }).element().parentElement ?? document.body).getBoundingClientRect(),
        things: screen.getByRole('heading', { level: 2, name: 'Things to try' }).element().getBoundingClientRect(),
      };
    };

    const laptop = await renderRoute(`/app/${state.desk_id}/today`);
    await expect.element(region(laptop.screen, 'Finish setting up Okafor Plumbing')).toBeVisible();
    const wide = parts(laptop.screen);
    expect(wide.button.left).toBeGreaterThanOrEqual(wide.line.right);
    expect(Math.abs(wide.button.top - wide.status.top)).toBeLessThanOrEqual(1);
    expect(wide.steps.top).toBeGreaterThanOrEqual(Math.max(wide.line.bottom, wide.button.bottom));
    expect(wide.card.bottom).toBeLessThanOrEqual(wide.things.top);
    expectNoHorizontalScroll();

    const phone = await renderRoute(`/app/${state.desk_id}/today`, { viewport: 'phone' });
    await expect.element(region(phone.screen, 'Finish setting up Okafor Plumbing')).toBeVisible();
    const narrow = parts(phone.screen);
    expect(narrow.card.bottom).toBeLessThanOrEqual(narrow.things.top);
    expect(narrow.button.top).toBeGreaterThanOrEqual(narrow.line.bottom);
    expect(Math.abs(narrow.button.left - narrow.line.left)).toBeLessThanOrEqual(1);
    expect(narrow.steps.top).toBeGreaterThanOrEqual(narrow.button.bottom);
    expect(narrow.button.right).toBeLessThanOrEqual(narrow.card.right);
    const main = phone.screen.getByRole('main').element();
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    expectNoHorizontalScroll();
    await expectScreenBasics(phone.screen.container, { owner: true });
  });

  it('a_live_desk_has_no_setup_card', async () => {
    // The seeded copy's Desk is live and was made without setup: Today has no card, and Things to try stays.
    const { screen } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Things to try')).toBeVisible();
    expect(screen.getByText('Not live yet').elements()).toHaveLength(0);
    expect(screen.getByRole('heading', { name: /^Finish setting up/ }).elements()).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Continue setup' }).elements()).toHaveLength(0);
  });

  it('a_desk_listed_without_its_setup_has_no_card', async () => {
    // An API from before `setup` lists the Desk without it: Today opens as for a live Desk.
    const read = await mockStore.dispatch('desks');
    if ('network' in read || read.status !== 200) throw new Error('the mock reads the Desks');
    const without = (read.body as BusinessOut[]).map((business) => ({
      ...business,
      desks: business.desks.map(({ setup: _setup, ...desk }) => desk),
    }));
    mockStore.inject({ route: 'desks', status: 200, times: 10_000, body: without });
    const { screen } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Things to try')).toBeVisible();
    expect(screen.getByText('Not live yet').elements()).toHaveLength(0);
  });

  it('the_line_names_the_step_setup_stopped_at', async () => {
    // At each step setup can stop at, the card says where the owner picks up and the steps mark it;
    // once the Desk goes live, the card leaves.
    const state = await deskAtRules();
    const id = state.interview_id;
    const lineAt = async (step: string, line: string) => {
      const { screen } = await renderRoute(`/app/${state.desk_id}/today`);
      const card = region(screen, 'Finish setting up Okafor Plumbing');
      await expect.element(card.getByText(line, { exact: true }), { timeout: 5_000 }).toBeVisible();
      const current = card.getByRole('list', { name: 'Setup steps' }).element().querySelector('[aria-current="step"]');
      expect(current?.textContent, step).toBe(step);
    };
    await lineAt(
      '3Rules',
      "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.",
    );
    await mockStore.dispatch('setupSituations', { params: { id } });
    await lineAt(
      '3Rules',
      "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.",
    );
    await mockStore.dispatch('setupSafetyCheck', { params: { id } });
    await lineAt(
      '4Safety check',
      "Your answers are saved. Pick up at the safety check, and I'll check your rules again before anything goes live. Answering stays off until then.",
    );
    await mockStore.dispatch('setupConfirm', { params: { id } });
    await lineAt('5Live', 'Your answers are saved. Pick up at going live. Answering stays off until then.');

    await mockStore.dispatch('goLive', { params: { id } });
    const live = await renderRoute(`/app/${state.desk_id}/today`);
    await expect.element(region(live.screen, 'Things to try')).toBeVisible();
    expect(live.screen.getByText('Not live yet').elements()).toHaveLength(0);
    expect(live.screen.getByRole('link', { name: 'Continue setup' }).elements()).toHaveLength(0);

    // A Desk left at its questions, and one left at its tools.
    const started = await mockStore.dispatch('startSetup', { body: { description: OKAFOR, timezone: LA, idempotency_key: newIdempotencyKey() } });
    if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
    const next = started.body as SetupState;
    const atQuestions = await renderRoute(`/app/${next.desk_id}/today`);
    const first = region(atQuestions.screen, 'Finish setting up Okafor Plumbing');
    await expect
      .element(first.getByText('Your answers are saved. Pick up at the questions. Answering stays off until your Desk is live.', { exact: true }))
      .toBeVisible();
    expect(first.getByRole('list', { name: 'Setup steps' }).element().querySelector('[aria-current="step"]')?.textContent).toBe('1Questions');
    const tools = await deskAtTools();
    const atTools = await renderRoute(`/app/${tools.desk_id}/today`);
    const second = region(atTools.screen, 'Finish setting up Okafor Plumbing');
    await expect
      .element(second.getByText('Your answers are saved. Pick up at your tools. Answering stays off until your Desk is live.', { exact: true }))
      .toBeVisible();
    expect(second.getByRole('list', { name: 'Setup steps' }).element().querySelector('[aria-current="step"]')?.textContent).toBe('2Tools');
  });
});

describe("Today's Demo inbox", () => {
  /** The sheet's button, with its count. */
  const inboxButton = (screen: RenderResult) => screen.getByRole('button', { name: /^Demo inbox \d+ entr(?:y|ies)$/ });

  /** Where a held request's alert links to: its card on Today. */
  const requestLink = (decisionId: string) => `${TODAY}#request-${encodeURIComponent(decisionId)}`;

  /** The owner's read of one decision, as the app sends it. */
  const decisionPath = (decisionId: string) => ROUTES.decision.path.replace('{decision_id}', encodeURIComponent(decisionId));

  /** Answers every read of `path` 503 until `stop()`: `count()` is how many it answered. */
  function failReads(path: string): { count: () => number; stop: () => void } {
    let failing = true;
    let count = 0;
    worker.use(
      http.get(path, () => {
        if (!failing) return undefined;
        count += 1;
        return HttpResponse.json({ error: 'kernel', code: 'kernel_unavailable' }, { status: 503 });
      }),
    );
    return {
      count: () => count,
      stop: () => {
        failing = false;
      },
    };
  }

  /** The top of `el` is inside the window, where the owner can see it. */
  function expectInView(el: Element): void {
    const box = el.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeLessThan(window.innerHeight);
  }

  /** Settles once the app has an answer to its next Demo inbox read and has taken it in. */
  function nextInboxAnswer(): Promise<void> {
    const answered = new Promise<void>((resolve) => {
      const stop = observeRequests((outcome) => {
        if (outcome.key !== 'ownerInbox') return;
        stop();
        resolve();
      });
      onTestFinished(stop);
    });
    return answered.then(nextFrames);
  }

  /**
   * Every timer the page starts from now on at the Demo inbox's poll interval, for as long as the
   * page keeps it: `started()` lists them, oldest first, `kept()` the ones it keeps now, and
   * `due()` runs each one still kept (or each of `only` still kept) at once, as if all came due at
   * that moment, and returns the ones it ran.
   */
  function inboxPacedPolls(): { started: () => number[]; kept: () => number[]; due: (only?: number[]) => number[] } {
    // The page's timers as the browser has them (the Node typings say otherwise).
    const timers = window as unknown as { setInterval: (run: () => void, ms?: number) => number; clearInterval: (id?: number) => void };
    const started: number[] = [];
    const running = new Map<number, () => void>();
    const start = timers.setInterval.bind(window);
    const stop = timers.clearInterval.bind(window);
    const starting = vi.spyOn(timers, 'setInterval').mockImplementation((run, ms) => {
      const id = start(run, ms);
      if (typeof run === 'function' && ms === pollMs('inbox')) {
        started.push(id);
        running.set(id, run);
      }
      return id;
    });
    const stopping = vi.spyOn(timers, 'clearInterval').mockImplementation((id) => {
      if (id !== undefined) running.delete(id);
      stop(id);
    });
    onTestFinished(() => {
      starting.mockRestore();
      stopping.mockRestore();
    });
    return {
      started: () => [...started],
      kept: () => [...running.keys()],
      due: (only) => {
        const due = [...running].filter(([id]) => only === undefined || only.includes(id));
        for (const [, run] of due) run();
        return due.map(([id]) => id);
      },
    };
  }

  /** Runs `then` once `el` has left the page, before the page's next task. */
  function onceGone(el: Element, then: () => void): void {
    const watch = new MutationObserver(() => {
      if (el.isConnected) return;
      watch.disconnect();
      then();
    });
    watch.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => watch.disconnect());
  }

  it.each(['desktop', 'phone'] as const)('inbox_alert_opens_the_held_request_%s', async (viewport) => {
    // The seeded hold's alert, as the kernel wrote it, beside entries that name no request: a code,
    // an alert about something else, and a ledger checkpoint.
    const held = seededHold();
    const alert = mockStore.world.inbox.find((record) => record.entry.decision_id === held.decision_id)?.entry;
    if (!alert) throw new Error("the seeded hold alerted the owner, naming it");
    const others: DemoInboxEntry[] = [
      {
        entry_id: 'inbox-code',
        to: rivera.people.dana.maskedContact,
        kind: 'verification_code',
        body: 'Your Rivera Plumbing code is 482913. It expires in ten minutes.',
        created_at: minutesAgo(5),
        decision_id: null,
      },
      {
        entry_id: 'inbox-paused',
        to: 'owner',
        kind: 'alert',
        body: 'Bookings paused after three refused tries in a minute.',
        created_at: minutesAgo(4),
        decision_id: null,
      },
      { entry_id: 'inbox-head', to: 'owner', kind: 'head_checkpoint', body: 'Ledger head 412, signed.', created_at: minutesAgo(3), decision_id: null },
    ];
    mockStore.inject({ route: 'ownerInbox', status: 200, times: 10_000, body: [alert, ...others] });
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeInTheDocument();

    const open = inboxButton(screen);
    await open.click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet.getByText(alert.body)).toBeVisible();
    await expect.element(sheet.getByText(others[0]?.body ?? '')).toBeVisible();
    // "Open the request" under the hold's alert only, once its request is read.
    const links = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(links.first()).toBeVisible();
    expect(links.elements()).toHaveLength(1);
    const link = links.first();
    expect(link.element().closest('li')?.textContent).toContain(alert.body);
    expect(link.element().getAttribute('href')).toBe(requestLink(held.decision_id));
    await expectScreenBasics(screen.container, { owner: true });

    // Following it closes the sheet and lands on the held request's card, in view.
    const closedReads = closedInboxReads(sheet);
    await link.click();
    await expect.element(sheet).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(TODAY);
    expect(router.state.location.hash).toBe(`#request-${encodeURIComponent(held.decision_id)}`);
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
    expectInView(card.element());
    // Focus stays there, and the closed sheet reads no more, a whole poll on.
    await aPollPasses();
    expect(focusIsOn(card.element())).toBe(true);
    expect(closedReads()).toBe(0);
  });

  it('inbox_alert_links_to_its_own_desk', async () => {
    // The Demo inbox is the whole copy's. On Emergencies, Main line's hold alert links to Main
    // line's Today, as the held decision itself says, and following it lands on that card.
    const { screen, router } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks' });
    const held = seededHold();
    const open = inboxButton(screen);
    await expect.element(open).toBeVisible();
    // Nothing is read about the alert's request while the sheet is closed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests('decision')).toEqual([]);

    await open.click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    const link = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(link).toHaveAttribute('href', requestLink(held.decision_id));
    expect(requests('decision').map((r) => r.path)).toEqual([decisionPath(held.decision_id)]);

    await link.click();
    await expect.element(sheet).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
    expectInView(card.element());
  });

  it('inbox_alert_links_only_once_its_request_is_read', async () => {
    const held = seededHold();
    const alert = mockStore.world.inbox.find((record) => record.entry.decision_id === held.decision_id)?.entry;
    if (!alert) throw new Error('the seeded hold alerted the owner, naming it');
    const openSheet = async (screen: RenderResult) => {
      await inboxButton(screen).click();
      const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
      await expect.element(sheet.getByText(alert.body)).toBeVisible();
      return sheet;
    };

    // While the request is read, the alert shows no link; once it answers, it does.
    const read = holdReads(decisionPath(held.decision_id));
    const first = await renderRoute(TODAY);
    let sheet = await openSheet(first.screen);
    await vi.waitFor(() => expect(read.held()).toBe(1));
    expect(sheet.getByRole('link').elements()).toHaveLength(0);
    read.release();
    await expect.element(sheet.getByRole('link', { name: 'Open the request' })).toBeVisible();

    // A read that fails shows none.
    const second = await renderRoute(TODAY, { seed: 'rivera' });
    mockStore.inject({ route: 'decision', status: 503 });
    sheet = await openSheet(second.screen);
    await vi.waitFor(() => expect(requests('decision')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sheet.getByRole('link').elements()).toHaveLength(0);

    // Nor does a decision that names no action, so no Desk.
    const third = await renderRoute(TODAY, { seed: 'rivera' });
    mockStore.inject({ route: 'decision', status: 200, body: { ...seededHold(), action: null } });
    sheet = await openSheet(third.screen);
    await vi.waitFor(() => expect(requests('decision')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sheet.getByRole('link').elements()).toHaveLength(0);
  });

  it('request_link_waits_for_a_read_that_works', async () => {
    // Needs you was read before the request was held, and its reads now fail. The address waits for
    // a read that works rather than spending itself on the list read before, then lands.
    const { screen, router } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    const failing = failReads(needsYouPath);
    const refund = mockStore.world.addHeldRefund();
    await expect.element(region(screen, 'Needs you').getByRole('button', { name: 'Try again' }), { timeout: 4_000 }).toBeVisible();

    await router.navigate(requestLink(refund.decision_id));
    const failed = failing.count();
    await vi.waitFor(() => expect(failing.count()).toBeGreaterThanOrEqual(failed + 2), { timeout: 4_000 });
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole('article', { name: `Held for you: ${REFUND_REASON}`, exact: true }).elements()).toHaveLength(0);

    failing.stop();
    const card = heldCard(screen, REFUND_REASON);
    await expect.element(card, { timeout: 4_000 }).toBeInTheDocument();
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
  });

  it('request_link_lands_again_after_back_and_forward', async () => {
    // Each arrival at a request's address lands once, Back and Forward included.
    const held = seededHold();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();
    await router.navigate(requestLink(held.decision_id));
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));

    // Today from the sidebar, then Back.
    const todayLink = screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' });
    await todayLink.click();
    await vi.waitFor(() => expect(router.state.location.hash).toBe(''));
    expect(focusIsOn(card.element())).toBe(false);
    await router.navigate(-1);
    await vi.waitFor(() => expect(router.state.location.hash).toBe(`#request-${held.decision_id}`));
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));

    // Back to plain Today, shown before Forward: the router's state changes at once, but the page
    // draws it in a transition, a frame or two later.
    await router.navigate(-1);
    await vi.waitFor(() => expect(router.state.location.hash).toBe(''));
    await nextFrames();
    (todayLink.element() as HTMLElement).focus();
    await router.navigate(1);
    await vi.waitFor(() => expect(router.state.location.hash).toBe(`#request-${held.decision_id}`));
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
  });

  it('request_link_waits_for_the_sheet_to_close', async () => {
    // An address that changes under the open sheet lands once the sheet has closed and handed focus
    // back to its button, not while the page behind it is out of reach.
    const held = seededHold();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();
    await inboxButton(screen).click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet).toBeVisible();

    await router.navigate(requestLink(held.decision_id), { flushSync: true });
    await nextFrames();
    expect(focusIsOn(card.element())).toBe(false);
    await userEvent.keyboard('{Escape}');
    await expect.element(sheet).not.toBeInTheDocument();
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
  });

  it('request_link_spent_by_the_owner_while_reads_fail', async () => {
    // Needs you can't be read as the owner arrives at a request's address. Their first pointer or
    // key press spends it, so a read that works later doesn't pull focus from what they're doing.
    const { screen, router } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    const failing = failReads(needsYouPath);
    const refund = mockStore.world.addHeldRefund();
    await expect.element(region(screen, 'Needs you').getByRole('button', { name: 'Try again' }), { timeout: 4_000 }).toBeVisible();

    // A pointer press.
    await router.navigate(requestLink(refund.decision_id));
    const ideas = region(screen, 'Things to try').getByRole('button', { name: 'Show me ideas' });
    await ideas.click();
    const hide = region(screen, 'Things to try').getByRole('button', { name: 'Hide ideas' });
    await expect.element(hide).toHaveFocus();
    failing.stop();
    const card = heldCard(screen, REFUND_REASON);
    await expect.element(card, { timeout: 4_000 }).toBeInTheDocument();
    await readsMore('needsYou', 2);
    await expect.element(hide).toHaveFocus();

    // A key press, on another arrival while reads fail.
    const again = failReads(needsYouPath);
    await expect.element(region(screen, 'Needs you').getByRole('button', { name: 'Try again' }), { timeout: 4_000 }).toBeVisible();
    await router.navigate(TODAY);
    await nextFrames();
    await router.navigate(requestLink(refund.decision_id));
    await nextFrames();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    const focused = document.activeElement;
    again.stop();
    await readsMore('needsYou', 2);
    expect(document.activeElement).toBe(focused);
    expect(focusIsOn(card.element())).toBe(false);
  });

  it('request_link_falls_back_to_the_answered_card', async () => {
    // Answered here a moment ago, the request's card stays where it was answered in Needs you: that
    // is where its address lands.
    const held = seededHold();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    (document.activeElement as HTMLElement | null)?.blur();

    await router.navigate(requestLink(held.decision_id));
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
    expect(region(screen, 'Needs you').element().contains(card.element())).toBe(true);
    expect(screen.getByRole('heading', { name: 'Answered just now' }).elements()).toHaveLength(0);
  });

  it('request_link_reads_needs_you_once_more_before_giving_up', async () => {
    // Held since Needs you was last read, the request isn't in the list Today has. Its address reads
    // Needs you once more before giving up, and lands on the card that read brings.
    const { screen, router } = await renderRoute(TODAY, { pollScale: 100 });
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    const reads = requests('needsYou').length;
    const refund = mockStore.world.addHeldRefund();

    await router.navigate(requestLink(refund.decision_id));
    const card = heldCard(screen, REFUND_REASON);
    await expect.element(card).toBeInTheDocument();
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
    expect(requests('needsYou')).toHaveLength(reads + 1);
  });

  it('request_link_without_its_card_leaves_focus_alone', async () => {
    // A request with no card here (answered, or another Desk's): Today opens as it would without
    // the address, with no error, and focus stays where it was.
    const { screen, router } = await renderRoute(requestLink('dec-not-here'));
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await readsMore('needsYou', 2);
    expect(document.activeElement).toBe(document.body);

    // A request held later under that id isn't jumped to: the address was spent when Needs you read.
    const [seeded] = await heldItems();
    if (!seeded?.decision) throw new Error('the seed holds a request');
    const later: NeedsYouItem = {
      ...seeded,
      decision: { ...seeded.decision, decision_id: 'dec-not-here', reason_plain: 'A visitor asked to book Sunday at 10:00 pm.' },
      held_at: new Date().toISOString(),
    };
    mockStore.inject({ route: 'needsYou', status: 200, times: 10_000, body: [seeded, later] });
    await expect.element(heldCard(screen, 'A visitor asked to book Sunday at 10:00 pm.')).toBeVisible();
    expect(document.activeElement).toBe(document.body);

    // An address whose request can't be read does nothing either.
    await router.navigate(`${TODAY}#request-%E0%A4%A`);
    await readsMore('needsYou', 2);
    expect(document.activeElement).toBe(document.body);
    await expect.element(region(screen, 'Needs you')).toBeVisible();
  });

  it('inbox_read_that_fails_while_open_says_so_in_the_sheet', async () => {
    // The page behind an open sheet is out of reach, so a read that fails while it is open says so
    // inside it, under its subtitle and above the entries, with its own Try again.
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const open = inboxButton(screen);
    await expect.element(open).toBeVisible();
    // The read as it opens fails, and so does its one retry.
    mockStore.inject({ route: 'ownerInbox', status: 500, times: 2 });
    await open.click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    const line = sheet.getByText(`Couldn't open your Demo inbox. ${UNAVAILABLE}`, { exact: true });
    await expect.element(line, { timeout: 4_000 }).toBeVisible();
    const subtitle = sheet.getByText('What Claude would have sent you by text or email. Nothing is really sent.').element();
    const entries = sheet.getByRole('list').element();
    expect(subtitle.compareDocumentPosition(line.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.element().compareDocumentPosition(entries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expectScreenBasics(screen.container, { owner: true });

    // Its Try again is busy while it reads; once a read works the line goes and the sheet stays open.
    const retry = holdReads(ROUTES.ownerInbox.path);
    const again = sheet.getByRole('button', { name: 'Try again', exact: true });
    await again.click();
    await vi.waitFor(() => expect(retry.held()).toBe(1));
    await expect.element(again).toHaveAttribute('aria-busy', 'true');
    await expect.element(line).toBeVisible();
    retry.release();
    await expect.element(line).not.toBeInTheDocument();
    await expect.element(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect.element(sheet).not.toBeInTheDocument();
    expect(screen.getByText(`Couldn't open your Demo inbox. ${UNAVAILABLE}`, { exact: true }).elements()).toHaveLength(0);
  });

  it('request_link_lands_on_the_card_once_needs_you_reads', async () => {
    // Opened fresh (a reload, or the link from elsewhere), the page lands on the held request once
    // Needs you has read, here slowly, at the phone's size where the card starts below the fold.
    const held = seededHold();
    const needsYouRead = holdReads(needsYouPath);
    const { screen, router } = await renderRoute(requestLink(held.decision_id), { viewport: 'phone' });
    await expect.element(region(screen, 'Things to try')).toBeVisible();
    await vi.waitFor(() => expect(needsYouRead.held()).toBeGreaterThanOrEqual(1));
    // Nothing to land on yet: focus stays where it was.
    const card = heldCard(screen, SEEDED_REASON);
    expect(card.elements()).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);

    needsYouRead.release();
    await expect.element(card).toBeInTheDocument();
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
    expectInView(card.element());
    expect(router.state.location.hash).toBe(`#request-${encodeURIComponent(held.decision_id)}`);
  });

  it('request_link_lands_once_today_has_drawn', async () => {
    // Followed from another page (here Conversations, just reloaded), the link opens Today with
    // Needs you in at once but Today's own read slow, so the page keeps its column on the loading
    // line while Needs you is read again and again. The landing waits for the card to be drawn,
    // rather than spend itself on a page that doesn't show the request yet.
    const held = seededHold();
    const todayRead = holdReads(ROUTES.today.path.replace('{desk_id}', RIVERA.deskId));
    const { screen, router } = await renderRoute(CONVERSATIONS);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
    await vi.waitFor(() => expect(todayRead.held()).toBeGreaterThanOrEqual(1));
    await router.navigate(requestLink(held.decision_id));
    await vi.waitFor(expectTodayOpening);
    await readsMore('needsYou', 3);
    expectTodayOpening();

    todayRead.release();
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeInTheDocument();
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
  });

  it('inbox_polls_only_while_the_sheet_is_open', async () => {
    const { screen } = await renderRoute(TODAY);
    const open = inboxButton(screen);
    await expect.element(open).toBeVisible();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    const closedReads = closedInboxReads(sheet);
    // Read once as Today opens, and not again while the sheet is closed.
    expect(requests('ownerInbox')).toHaveLength(1);
    await aPollPasses();
    expect(closedReads()).toBe(0);

    // Read as it opens, and every few seconds while it is open.
    await open.click();
    await expect.element(sheet).toBeVisible();
    await readsMore('ownerInbox', 3);

    // Close stops it.
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect.element(sheet).not.toBeInTheDocument();
    await expect.element(open).toHaveFocus();
    await aPollPasses();
    expect(closedReads()).toBe(0);

    // Opened again, it reads again at once, and stops again once Escape closes it.
    await open.click();
    await expect.element(sheet).toBeVisible();
    await readsMore('ownerInbox', 2);
    await userEvent.keyboard('{Escape}');
    await expect.element(sheet).not.toBeInTheDocument();
    await aPollPasses();
    expect(closedReads()).toBe(0);
  });

  it.each(['read', 'failed'] as const)('inbox_polls_a_whole_poll_after_each_answer_%s', async (answer) => {
    // As React Query's own polls do, the open sheet's poll counts again from each read's answer, read
    // or failed, so a read that answers late isn't followed by another at once. A failed read is
    // tried once more at once, and the answer that counts is that try's.
    const tries = answer === 'read' ? 1 : 2;
    const { screen } = await renderRoute(TODAY, { retryScale: 0 });
    const open = inboxButton(screen);
    await expect.element(open).toBeVisible();
    if (answer === 'failed') mockStore.inject({ route: 'ownerInbox', status: 503, times: 2 });
    // When each try of the read as it opens answers, from here on.
    const answeredAt: number[] = [];
    const stop = observeRequests((outcome) => {
      if (outcome.key === 'ownerInbox') answeredAt.push(performance.now());
    });
    onTestFinished(stop);

    // The read as it opens answers a poll and a half late.
    const opening = holdReads(ROUTES.ownerInbox.path);
    await open.click();
    await vi.waitFor(() => expect(opening.held()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, pollMs('inbox') * 1.5));
    const sent: number[] = [];
    const send = window.fetch;
    const sending = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === ROUTES.ownerInbox.path) sent.push(performance.now());
      return send(input, init);
    });
    onTestFinished(() => sending.mockRestore());
    opening.release();

    // The next read, the poll's, goes a whole poll after the last try's answer. A failed read's own
    // try once more is sent before it.
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(tries));
    expect(answeredAt.length).toBeGreaterThanOrEqual(tries);
    expect((sent[tries - 1] ?? 0) - (answeredAt[tries - 1] ?? 0)).toBeGreaterThanOrEqual(pollMs('inbox') - 2);
  });

  it('inbox_poll_counts_from_an_answer_as_it_comes', async () => {
    // A read that answers just as the poll comes due, here one on the owner's return to the tab,
    // starts the count again as it answers, before Today has drawn it: the poll that was running
    // then sends nothing. No poll lands by itself here, so the test brings it due.
    const polls = inboxPacedPolls();
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const open = inboxButton(screen);
    await expect.element(open).toBeVisible();
    const answered = nextInboxAnswer();
    await open.click();
    await expect.element(screen.getByRole('dialog', { name: 'Demo inbox' })).toBeVisible();
    await answered;

    // The reads sent from the moment the poll comes due.
    let counting = false;
    let sentSince = 0;
    const send = window.fetch;
    const sending = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (counting && url.pathname === ROUTES.ownerInbox.path) sentSince += 1;
      return send(input, init);
    });
    onTestFinished(() => sending.mockRestore());
    // As the read on her return answers, the polls running before it come due: after the answer
    // reaches the inbox's read, before Today hears of it.
    let cameDue = false;
    const stop = observeRequests((outcome) => {
      if (outcome.key !== 'ownerInbox' || cameDue) return;
      cameDue = true;
      const running = polls.kept();
      setTimeout(() => {
        counting = true;
        polls.due(running);
      }, 0);
    });
    onTestFinished(stop);
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await vi.waitFor(() => expect(counting).toBe(true));
    await nextFrames();
    expect(sentSince, 'Demo inbox reads sent as the poll came due, just after an answer').toBe(0);
  });

  it('inbox_reads_nothing_from_the_moment_it_closes', async () => {
    // The sheet is closed from the moment it closes, before Today has drawn it closed: a poll that
    // comes due then, or the owner coming back to the tab or to the network then, reads nothing. No
    // poll lands by itself here, so the test brings them due.
    const polls = inboxPacedPolls();
    const { screen } = await renderRoute(TODAY, { pollScale: 100 });
    const open = inboxButton(screen);
    await expect.element(open).toBeVisible();
    // The read as it opens is answered, so none is still out as it closes. The polls started from
    // the click until then are the sheet's own, started as it opened and again at that answer.
    const answered = nextInboxAnswer();
    const before = polls.started().length;
    await open.click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet).toBeVisible();
    await answered;
    const sheetsOwn = polls.started().slice(before);

    const closedReads = closedInboxReads(sheet);
    let ran: number[] = [];
    onceGone(sheet.element(), () => {
      ran = polls.due();
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect.element(sheet).not.toBeInTheDocument();
    await expect.element(open).toHaveFocus();
    await nextFrames();
    expect(ran.filter((id) => sheetsOwn.includes(id)), "the sheet's own poll came due as it closed").not.toEqual([]);
    expect(closedReads(), 'Demo inbox reads sent once its sheet had closed').toBe(0);
  });
});
