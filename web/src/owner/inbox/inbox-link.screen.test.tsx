/**
 * The Demo inbox's "Open the request" in a real browser against the mock API: a hold's alert links
 * to its request only while the request still waits for the owner, in its Desk's Needs you. Once
 * it is answered, here or anywhere, the alert stays and the link goes: Today would have no card to
 * open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { Decision, DemoInboxEntry } from '../../api/contracts.ts';
import { observeRequests } from '../../api/http.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { focusIsOn, nextFrames } from '../../test/screen.ts';

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

/** Settles once the app has the answers to `n` more reads of a decision and has drawn them. */
function decisionReads(n: number): Promise<void> {
  let left = n;
  return new Promise<void>((resolve) => {
    const stop = observeRequests((outcome) => {
      if (outcome.key !== 'decision') return;
      left -= 1;
      if (left > 0) return;
      stop();
      resolve();
    });
  }).then(nextFrames);
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

    const read = decisionReads(1);
    const sheet = await openInbox(screen, held.decision_id);
    await read;
    await new Promise((resolve) => setTimeout(resolve, 300));
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

    const sheet = await openInbox(screen, refund.decision_id);
    await expect.element(sheet.getByText(alertFor(answered.decision_id).body)).toBeVisible();
    const links = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(links.first()).toBeVisible();
    // Under the held request's alert only, once every request is read.
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    const reply = await mockStore.dispatch('answer', { params: { decision_id: answered.decision_id }, body: { answer: 'deny_once' } });
    if ('network' in reply || reply.status !== 200) throw new Error('the mock takes the answer');

    const sheet = await openInbox(screen, refund.decision_id);
    await expect.element(sheet.getByText(alertFor(answered.decision_id).body)).toBeVisible();
    const links = sheet.getByRole('link', { name: 'Open the request' });
    await expect.element(links.first()).toHaveAttribute('href', requestLink(refund.decision_id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(links.elements()).toHaveLength(1);
    expect(links.first().element().closest('li')?.textContent).toContain(alertFor(refund.decision_id).body);
  });
});
