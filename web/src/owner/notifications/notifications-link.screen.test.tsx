/**
 * Notifications' request rows in a real browser against the mock API: a hold's alert is a link to
 * its request only while the request still waits for the owner, in its Desk's Needs you. Once it is
 * answered, here or anywhere, the alert stays and the link goes: Today would have no card to open.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { Decision, DemoInboxEntry } from '../../api/contracts.ts';
import { observeRequests } from '../../api/http.ts';
import { ROUTES, type RouteKey } from '../../api/routes.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { focusIsOn, nextFrames } from '../../test/screen.ts';
import { FRESH_MS } from '../useDesks.ts';

const TODAY = `/app/${RIVERA.deskId}/today`;
const SEEDED_REASON = rivera.decisions.held.reason_plain;

/** The seeded hold as the kernel has it now. */
function seededHold(): Decision {
  const held = [...mockStore.world.decisions.values()].find((d) => d.decision.reason_plain === SEEDED_REASON);
  if (!held) throw new Error('the seed holds the 15% quote');
  return held.decision;
}

/** The owner's Demo inbox alert that names `decisionId`. */
function alertFor(decisionId: string): DemoInboxEntry {
  const alert = mockStore.world.inbox.find((record) => record.entry.decision_id === decisionId)?.entry;
  if (!alert) throw new Error(`the hold ${decisionId} alerted the owner, naming it`);
  return alert;
}

/** A held request's card, by what was asked. */
function heldCard(screen: RenderResult, reason: string) {
  return screen.getByRole('article', { name: `Held for you: ${reason}`, exact: true });
}

/** Where a held request's alert links to: its card on Today. */
const requestLink = (decisionId: string) => `${TODAY}#request-${encodeURIComponent(decisionId)}`;

/**
 * Settles once the app has the answers to as many more reads of each route as `counts` says, read
 * or failed, from now on, and has drawn them.
 */
function readsAnswered(counts: Partial<Record<RouteKey, number>>): Promise<void> {
  const left = new Map(Object.entries(counts) as [RouteKey, number][]);
  return new Promise<void>((resolve) => {
    const stop = observeRequests((outcome) => {
      const n = left.get(outcome.key);
      if (n === undefined) return;
      left.set(outcome.key, n - 1);
      if ([...left.values()].some((more) => more > 0)) return;
      stop();
      resolve();
    });
    onTestFinished(stop);
  }).then(nextFrames);
}

/** Main line's Needs you, as the app reads it from another Desk's Today. */
const MAIN_LINE_NEEDS_YOU = ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId);

/** How many times the mock has been asked for Main line's Needs you. */
const mainLineReads = () => mockStore.requests.filter((r) => r.key === 'needsYou' && r.path === MAIN_LINE_NEEDS_YOU).length;

/** The owner answers `decisionId` somewhere else, such as another tab: Deny this time. */
async function answerElsewhere(decisionId: string): Promise<void> {
  const reply = await mockStore.dispatch('answer', { params: { decision_id: decisionId }, body: { answer: 'deny_once' } });
  if ('network' in reply || reply.status !== 200) throw new Error('the mock takes the answer');
}

/** Goes to Notifications from the sidebar, once its alert for `decisionId` shows. */
async function openNotifications(screen: RenderResult, decisionId: string) {
  await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Notifications/ }).click();
  const page = screen.getByRole('main');
  await expect.element(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect.element(page.getByText(alertFor(decisionId).body)).toBeVisible();
  return page;
}

/** Leaves Notifications for Today, from the sidebar. */
async function leaveNotifications(screen: RenderResult) {
  await screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Today/ }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Notifications' })).not.toBeInTheDocument();
}

/** The rows that link to a held request: each says "Open the request" under its alert. */
const requestRows = (page: ReturnType<RenderResult['getByRole']>) => page.getByRole('link', { name: /Open the request/ });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Notifications request link', () => {
  it.each([[1440, 900], [390, 844]])('long_alerts_wrap_inside_the_column_at_%sx%s', async (width, height) => {
    const held = seededHold();
    const entry = alertFor(held.decision_id);
    entry.body = 'A stranger asked to get a quote for $153 with 15% off. It goes past your rule, so it waits for you: “Quotes from your price list, at list price.” ' + 'LongReference'.repeat(30);
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/notifications`, { viewport: { width, height } });
    const page = screen.getByRole('main');
    await expect.element(page.getByText(entry.body)).toBeVisible();
    const column = page.element().querySelector<HTMLElement>('.cd-notifications')!;
    const edge = column.getBoundingClientRect();
    const text = column.querySelectorAll<HTMLElement>('h1, h2, p, span, a');
    expect(text.length).toBeGreaterThan(5);
    for (const element of text) {
      expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth);
      expect(element.getBoundingClientRect().right, element.className).toBeLessThanOrEqual(edge.right + 0.5);
    }
    // The time keeps its line at the right, beside the words.
    const time = page.getByText(/^\d{1,2}:\d{2} [ap]m$/).first().element();
    expect(time.getBoundingClientRect().right).toBeLessThanOrEqual(edge.right);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it('answered_and_dismissed_request_has_no_link', async () => {
    // Denied and dismissed on Today, the request is no longer held: its alert stays in
    // Notifications, and isn't a link to a card Today no longer has.
    const held = seededHold();
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Deny this time' }).click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    await screen.getByRole('region', { name: 'Needs you', exact: true }).getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(card).not.toBeInTheDocument();

    // Its request read, and Today's Needs you read again (Today polls it).
    const read = readsAnswered({ decision: 1, needsYou: 1 });
    const page = await openNotifications(screen, held.decision_id);
    await read;
    expect(requestRows(page).elements()).toHaveLength(0);
  });

  it('held_request_keeps_its_link', async () => {
    // Beside one answered and dismissed, a request still held keeps its link, which lands on its card.
    const answered = seededHold();
    const refund = mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(TODAY);
    const seeded = heldCard(screen, SEEDED_REASON);
    await seeded.getByRole('button', { name: 'Deny this time' }).click();
    await expect.element(seeded.getByText('You denied this.', { exact: true })).toBeVisible();
    await screen.getByRole('region', { name: 'Needs you', exact: true }).getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(seeded).not.toBeInTheDocument();

    // Both requests read, and Today's Needs you read again (Today polls it).
    const read = readsAnswered({ decision: 2, needsYou: 1 });
    const page = await openNotifications(screen, refund.decision_id);
    await expect.element(page.getByText(alertFor(answered.decision_id).body)).toBeVisible();
    await read;
    // The held request's alert only: the whole row, with "Open the request" under its body.
    const links = requestRows(page);
    expect(links.elements()).toHaveLength(1);
    const link = links.first();
    expect(link.element().textContent).toContain(alertFor(refund.decision_id).body);
    expect(link.element().getAttribute('href')).toBe(requestLink(refund.decision_id));
    expect(link.element().querySelectorAll('a')).toHaveLength(0);

    await link.click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Notifications' })).not.toBeInTheDocument();
    expect(router.state.location.hash).toBe(`#request-${encodeURIComponent(refund.decision_id)}`);
    const card = heldCard(screen, rivera.heldRefund.reason_plain);
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
  });

  it('another_desks_answered_request_has_no_link', async () => {
    // The notifications are the whole copy's. On Emergencies, Main line's requests are read in Main
    // line's Needs you: the one answered elsewhere (another tab) has no link, the one still held
    // links to Main line's Today.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks' });
    await expect.element(screen.getByRole('heading', { level: 1 })).toBeVisible();
    const answered = seededHold();
    const refund = mockStore.world.addHeldRefund(RIVERA.deskId);
    await answerElsewhere(answered.decision_id);

    // Both requests read; the held one's link shows once Main line's Needs you, which holds both, is
    // read too, so the answered one's is decided by then.
    const decided = readsAnswered({ decision: 2 });
    const page = await openNotifications(screen, refund.decision_id);
    await expect.element(page.getByText(alertFor(answered.decision_id).body)).toBeVisible();
    const links = requestRows(page);
    await expect.element(links.first()).toHaveAttribute('href', requestLink(refund.decision_id));
    await decided;
    expect(links.elements()).toHaveLength(1);
    expect(links.first().element().textContent).toContain(alertFor(refund.decision_id).body);
  });

  it('another_desks_answer_while_open_drops_its_link', async () => {
    // On Emergencies, with Notifications open on Main line's held request, the request is answered
    // elsewhere. Main line's Needs you is read again on the page's poll once it is no longer fresh,
    // and the link goes while the page stays open.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks' });
    await expect.element(screen.getByRole('heading', { level: 1 })).toBeVisible();
    const held = seededHold();
    const page = await openNotifications(screen, held.decision_id);
    const link = requestRows(page);
    await expect.element(link).toHaveAttribute('href', requestLink(held.decision_id));
    const before = mainLineReads();

    await answerElsewhere(held.decision_id);
    await expect.element(link, { timeout: FRESH_MS + 3_000 }).not.toBeInTheDocument();
    await expect.element(page.getByText(alertFor(held.decision_id).body)).toBeVisible();
    expect(mainLineReads()).toBeGreaterThan(before);
  });

  it('another_desks_list_read_before_and_now_failing_draws_no_link', async () => {
    // Notifications linked Main line's held request, then the owner left it. The request is
    // answered elsewhere, and every read of Needs you fails from then on. Opened again once the
    // list read before is no longer fresh, the page draws no link from it, before or after its own
    // read fails.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks', retryScale: 0 });
    await expect.element(screen.getByRole('heading', { level: 1 })).toBeVisible();
    const held = seededHold();
    let page = await openNotifications(screen, held.decision_id);
    await expect.element(requestRows(page)).toBeVisible();
    await leaveNotifications(screen);

    await answerElsewhere(held.decision_id);
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    // Past the freshness of the last read that worked: a rule about time, waited out.
    await new Promise((resolve) => setTimeout(resolve, FRESH_MS + 500));
    const before = mainLineReads();
    page = await openNotifications(screen, held.decision_id);
    expect(requestRows(page).elements()).toHaveLength(0);
    // Its read as it opens, and that read's one retry, both fail.
    await expect.poll(() => mainLineReads()).toBeGreaterThanOrEqual(before + 2);
    await nextFrames();
    expect(requestRows(page).elements()).toHaveLength(0);
  });

  it('another_desks_list_whose_read_again_fails_drops_its_link', async () => {
    // With Notifications open on Main line's held request, the request is answered elsewhere and
    // every read of Needs you fails from then on. The list read as the page opened is the last that
    // worked, and it still holds the request; once the page's poll reads it again and that read
    // fails, the link goes: a list whose latest read failed may be out of date.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks', retryScale: 0 });
    await expect.element(screen.getByRole('heading', { level: 1 })).toBeVisible();
    const held = seededHold();
    const page = await openNotifications(screen, held.decision_id);
    const link = requestRows(page);
    await expect.element(link).toBeVisible();
    const before = mainLineReads();

    await answerElsewhere(held.decision_id);
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    await expect.element(link, { timeout: FRESH_MS + 3_000 }).not.toBeInTheDocument();
    expect(mainLineReads()).toBeGreaterThanOrEqual(before + 2);
  });
});
