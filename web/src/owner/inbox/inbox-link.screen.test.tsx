/**
 * The Demo inbox's "Open the request" in a real browser against the mock API: a hold's alert links
 * to its request only while the request still waits for the owner, in its Desk's Needs you. Once
 * it is answered, here or anywhere, the alert stays and the link goes: Today would have no card to
 * open.
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

const inboxButton = (screen: RenderResult) => screen.getByRole('button', { name: /^Demo inbox \d+ entr(?:y|ies)$/ });

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

/** Opens the Demo inbox's sheet, once its alert for `decisionId` shows. */
async function openInbox(screen: RenderResult, decisionId: string) {
  await inboxButton(screen).click();
  const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
  await expect.element(sheet.getByText(alertFor(decisionId).body)).toBeVisible();
  return sheet;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Demo inbox request link', () => {
  it.each([[1440, 900], [390, 844]])('sheet_wraps_long_alerts_inside_the_demo_bar_at_%sx%s', async (width, height) => {
    const held = seededHold();
    const entry = alertFor(held.decision_id);
    entry.body = 'A stranger asked to get a quote for $153 with 15% off. It goes past your rule, so it waits for you: “Quotes from your price list, at list price.” ' + 'LongReference'.repeat(30);
    const { screen } = await renderRoute(TODAY, { viewport: { width, height } });
    const button = inboxButton(screen);
    await expect.element(button).toBeVisible();
    expect(getComputedStyle(button.element().closest('.cd-reviewer-bar__actions')!).whiteSpace).toBe('nowrap');
    const label = button.element().querySelector('.cd-demo-inbox-sheet__button > span')!;
    const words = document.createRange();
    words.selectNodeContents(label);
    expect(new Set([...words.getClientRects()].map(rect => Math.round(rect.top))).size).toBe(1);
    const sheet = (await openInbox(screen, held.decision_id)).element();
    expect(getComputedStyle(sheet).whiteSpace).toBe('normal');
    const edge = sheet.getBoundingClientRect();
    const text = sheet.querySelectorAll<HTMLElement>('h2, p, span, a, button');
    expect(text.length).toBeGreaterThan(5);
    for (const element of text) {
      expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth);
      expect(element.getBoundingClientRect().right, element.className).toBeLessThanOrEqual(edge.right);
    }
    // The bar's meta type does not change the sheet's explicit body and heading styles.
    const body = sheet.querySelector('.cd-demo-inbox__body')!;
    const bodyStyle = getComputedStyle(body);
    expect([bodyStyle.fontSize, bodyStyle.lineHeight, bodyStyle.fontWeight]).toEqual(['14px', '20px', '380']);
    const heading = getComputedStyle(sheet.querySelector('h2')!);
    expect([heading.fontSize, heading.lineHeight, heading.fontWeight]).toEqual(['15px', '20px', '520']);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it('ledger_checkpoints_stay_out_of_the_owners_inbox', async () => {
    // The kernel sends the owner a signed head checkpoint of the record now and then. It is the
    // record's own engineering text, and Safety says how the record stands in plain words, so the
    // owner's Demo inbox, its list and its count, leaves it out.
    const held = seededHold();
    const alert = alertFor(held.decision_id);
    const checkpoint: DemoInboxEntry = {
      entry_id: 'inbox-head', to: 'owner', kind: 'head_checkpoint',
      body: '{"desk_id": "desk-turner", "head": "9f2c", "key_id": "k1", "seq": 50, "signature": "c2ln"}',
      created_at: new Date().toISOString(), decision_id: null,
    };
    mockStore.inject({ route: 'ownerInbox', status: 200, times: 10_000, body: [alert, checkpoint] });
    const { screen } = await renderRoute(TODAY);
    await expect.element(screen.getByRole('button', { name: 'Demo inbox 1 entry' })).toBeVisible();
    await inboxButton(screen).click();
    const sheet = screen.getByRole('dialog', { name: 'Demo inbox' });
    await expect.element(sheet.getByText(alert.body)).toBeVisible();
    expect(sheet.getByText(checkpoint.body).elements()).toHaveLength(0);
    expect(sheet.getByText('Ledger checkpoint').elements()).toHaveLength(0);
  });

  it('answered_and_dismissed_request_has_no_link', async () => {
    // Denied and dismissed on Today, the request is no longer held: its alert stays in the inbox,
    // with no "Open the request" that would only close the sheet.
    const held = seededHold();
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Deny this time' }).click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    await screen.getByRole('region', { name: 'Needs you', exact: true }).getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(card).not.toBeInTheDocument();

    // Its request read, and Today's Needs you read again (Today polls it).
    const read = readsAnswered({ decision: 1, needsYou: 1 });
    const sheet = await openInbox(screen, held.decision_id);
    await read;
    expect(sheet.getByRole('link', { name: 'Open the request' }).elements()).toHaveLength(0);
  });

  it('held_request_keeps_its_link', async () => {
    // Beside one answered and dismissed, a request still held keeps its link, which closes the
    // sheet and lands on its card.
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
    const sheet = await openInbox(screen, refund.decision_id);
    await expect.element(sheet.getByText(alertFor(answered.decision_id).body)).toBeVisible();
    await read;
    // Under the held request's alert only.
    const links = sheet.getByRole('link', { name: 'Open the request' });
    expect(links.elements()).toHaveLength(1);
    const link = links.first();
    expect(link.element().closest('li')?.textContent).toContain(alertFor(refund.decision_id).body);
    expect(link.element().getAttribute('href')).toBe(requestLink(refund.decision_id));

    await link.click();
    await expect.element(sheet).not.toBeInTheDocument();
    expect(router.state.location.hash).toBe(`#request-${encodeURIComponent(refund.decision_id)}`);
    const card = heldCard(screen, rivera.heldRefund.reason_plain);
    await vi.waitFor(() => expect(focusIsOn(card.element())).toBe(true));
  });

  it('another_desks_answered_request_has_no_link', async () => {
    // The Demo inbox is the whole copy's. On Emergencies, Main line's requests are read in Main
    // line's Needs you: the one answered elsewhere (another tab) has no link, the one still held
    // links to Main line's Today.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks' });
    await expect.element(inboxButton(screen)).toBeVisible();
    const answered = seededHold();
    const refund = mockStore.world.addHeldRefund(RIVERA.deskId);
    await answerElsewhere(answered.decision_id);

    // Both requests read; the held one's link shows once Main line's Needs you, which holds both, is
    // read too, so the answered one's is decided by then.
    const decided = readsAnswered({ decision: 2 });
    const sheet = await openInbox(screen, refund.decision_id);
    await expect.element(sheet.getByText(alertFor(answered.decision_id).body)).toBeVisible();
    const links = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(links.first()).toHaveAttribute('href', requestLink(refund.decision_id));
    await decided;
    expect(links.elements()).toHaveLength(1);
    expect(links.first().element().closest('li')?.textContent).toContain(alertFor(refund.decision_id).body);
  });

  it('another_desks_answer_while_open_drops_its_link', async () => {
    // On Emergencies, with the sheet open on Main line's held request, the request is answered
    // elsewhere. Main line's Needs you is read again on the sheet's poll once it is no longer fresh,
    // and the link goes while the sheet stays open.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks' });
    await expect.element(inboxButton(screen)).toBeVisible();
    const held = seededHold();
    const sheet = await openInbox(screen, held.decision_id);
    const link = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(link).toHaveAttribute('href', requestLink(held.decision_id));
    const before = mainLineReads();

    await answerElsewhere(held.decision_id);
    await expect.element(link, { timeout: FRESH_MS + 3_000 }).not.toBeInTheDocument();
    await expect.element(sheet).toBeVisible();
    expect(mainLineReads()).toBeGreaterThan(before);
  });

  it('another_desks_list_read_before_and_now_failing_draws_no_link', async () => {
    // The sheet linked Main line's held request, then closed. The request is answered elsewhere,
    // and every read of Needs you fails from then on. Opened again once the list read before is no
    // longer fresh, the sheet draws no link from it, before or after its own read fails.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks', retryScale: 0 });
    await expect.element(inboxButton(screen)).toBeVisible();
    const held = seededHold();
    let sheet = await openInbox(screen, held.decision_id);
    await expect.element(sheet.getByRole('link', { name: 'Open the request' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect.element(sheet).not.toBeInTheDocument();

    await answerElsewhere(held.decision_id);
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    // Past the freshness of the last read that worked: a rule about time, waited out.
    await new Promise((resolve) => setTimeout(resolve, FRESH_MS + 500));
    const before = mainLineReads();
    sheet = await openInbox(screen, held.decision_id);
    expect(sheet.getByRole('link', { name: 'Open the request' }).elements()).toHaveLength(0);
    // Its read as it opens, and that read's one retry, both fail.
    await expect.poll(() => mainLineReads()).toBeGreaterThanOrEqual(before + 2);
    await nextFrames();
    expect(sheet.getByRole('link', { name: 'Open the request' }).elements()).toHaveLength(0);
  });

  it('another_desks_list_whose_read_again_fails_drops_its_link', async () => {
    // With the sheet open on Main line's held request, the request is answered elsewhere and every
    // read of Needs you fails from then on. The list read as the sheet opened is the last that
    // worked, and it still holds the request; once the sheet's poll reads it again and that read
    // fails, the link goes: a list whose latest read failed may be out of date.
    const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks', retryScale: 0 });
    await expect.element(inboxButton(screen)).toBeVisible();
    const held = seededHold();
    const sheet = await openInbox(screen, held.decision_id);
    const link = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(link).toBeVisible();
    const before = mainLineReads();

    await answerElsewhere(held.decision_id);
    mockStore.inject({ route: 'needsYou', status: 503, times: 10_000 });
    await expect.element(link, { timeout: FRESH_MS + 3_000 }).not.toBeInTheDocument();
    expect(mainLineReads()).toBeGreaterThanOrEqual(before + 2);
  });
});
