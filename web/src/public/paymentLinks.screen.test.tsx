import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { observeRequests, request, type RequestOutcome } from '../api/http.ts';
import { payChatFor, payChatKey } from '../lib/payChats.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

const CHAT = `/d/${RIVERA.slug}`;
const reads = () => mockStore.requests.filter((r) => r.key === 'paymentLink');
const card = (screen: RenderResult) => screen.getByRole('article', { name: 'Payment link', exact: true });
const action = (screen: RenderResult) => screen.getByRole('link', { name: 'Open payment page' });

let outcomes: RequestOutcome[];
beforeEach(() => {
  outcomes = [];
  onTestFinished(observeRequests((outcome) => {
    if (outcome.key === 'paymentLink') outcomes.push(outcome);
  }));
});
afterEach(() => {
  expect(mockStore.pendingInjections, 'every planted payment read was consumed').toEqual([]);
  vi.restoreAllMocks();
});

async function settledReads(count: number) {
  await vi.waitFor(() => {
    expect(reads()).toHaveLength(count);
    expect(outcomes).toHaveLength(count);
  });
}

async function remountChat(router: Awaited<ReturnType<typeof renderRoute>>['router']) {
  await router.navigate('/missing');
  await router.navigate(CHAT);
}

async function payInOtherTab(token: string) {
  // This tab only observes the other checkout's change. Set it up through the mock route so a
  // service-worker/proxy bypass in the runner cannot turn the external event into a failed POST.
  // The checkout interaction above/below still exercises the app's actual HTTP payment flow.
  expect(await mockStore.dispatch('completePayment', { params: { token } })).toMatchObject({ status: 200, body: { state: 'paid' } });
}

function visibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  onTestFinished(() => { Reflect.deleteProperty(document, 'visibilityState'); });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function issue(viewport: Viewport, path: string = CHAT) {
  const view = await renderRoute(path, { viewport, strict: true, pollScale: 100 });
  await expect.element(view.screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeEnabled();
  await view.screen.getByRole('textbox').fill('How do I pay the deposit?');
  await view.screen.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.element(action(view.screen)).toBeVisible();
  const href = action(view.screen).element().getAttribute('href') ?? '';
  const token = href.slice('/pay/'.length);
  await vi.waitFor(() => expect(mockStore.visitorSession(RIVERA.slug)?.events.at(-1)?.ev.type).toBe('turn_end'));
  await settledReads(1);
  return { ...view, token, href, words: card(view.screen).element().querySelector('.cd-reply-card__data')?.textContent };
}

async function unchanged(screen: RenderResult, words: string | null | undefined) {
  await expect.element(action(screen)).not.toBeInTheDocument();
  expect(card(screen).element().querySelector('.cd-reply-card__data')?.textContent).toBe(words);
  expectNoHorizontalScroll();
}

describe.each(['desktop', 'phone'] as const)('payment link actions at %s size', (viewport) => {
  it('leaves focus on body when the visitor blurs the payment action before it closes', async () => {
    const { screen, token } = await issue(viewport);
    action(screen).element().focus();
    await expect.element(action(screen)).toHaveFocus();
    action(screen).element().blur();
    expect(document.activeElement).toBe(document.body);
    await payInOtherTab(token);
    await expect.element(action(screen)).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });
  it('returns keyboard focus to the composer when the focused payment action closes', async () => {
    const { screen, token } = await issue(viewport);
    action(screen).element().focus();
    await expect.element(action(screen)).toHaveFocus();
    await payInOtherTab(token);
    await expect.element(action(screen)).not.toBeInTheDocument();
    await expect.element(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toHaveFocus();
  });
  it('removes a rule-cancelled action live and from history without reading the cancelled token', async () => {
    const { screen, token, words } = await issue(viewport);
    const desk = mockStore.world.desk(RIVERA.deskId);
    if (!desk) throw new Error('Rivera exists');
    const params = { desk_id: RIVERA.deskId };
    const draft = await request('draftRules', { params, body: { add: [{ ...desk.policy.cards[0]!, card_id: 'stop-links', applies_to: 'native.payment_link', mode: 'never', who: 'anyone' }] } });
    await request('confirmRules', { params, body: { version: draft.version } });
    expect(mockStore.world.links.get(token)?.view.state).toBe('cancelled');
    await expect.element(screen.getByRole('article', { name: 'Payment link cancelled', exact: true })).toBeVisible();
    await unchanged(screen, words);
    expect(reads()).toHaveLength(1);
    const cards: Element[] = [...screen.container.querySelectorAll('article')];
    expect(cards.indexOf(card(screen).element())).toBeLessThan(cards.indexOf(screen.getByRole('article', { name: 'Payment link cancelled' }).element()));
    const reload = await renderRoute(CHAT, { viewport, strict: true });
    await expect.element(reload.screen.getByRole('article', { name: 'Payment link cancelled' })).toBeVisible();
    await unchanged(reload.screen, words);
    expect(reads()).toHaveLength(1);
  });
  it('removes the paid action after checkout and after reloading', async () => {
    const { screen, router, href, words } = await issue(viewport);
    await router.navigate(href);
    await expect.element(screen.getByRole('button', { name: 'Pay $20.00' })).toBeVisible();
    await screen.getByRole('button', { name: 'Pay $20.00' }).click();
    await expect.element(screen.getByText('Paid. Go back to the chat to see it there.')).toBeVisible();
    await settledReads(reads().length); // Checkout's StrictMode reads have both settled.
    const beforeReturn = reads().length;
    const link = mockStore.world.links.get(href.slice('/pay/'.length));
    if (!link) throw new Error('the chat issued its link');
    let release = () => {};
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(release);
    mockStore.inject({ route: 'paymentLink', status: 200, body: { ...link.view }, until });
    await router.navigate(CHAT);
    await expect.element(screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await vi.waitFor(() => expect(reads()).toHaveLength(beforeReturn + 1));
    release(); // The pending answer is terminal, so the queued confirmation needs no follow-up.
    await unchanged(screen, words);
    await settledReads(beforeReturn + 1);
    const afterReturn = reads().length;
    await remountChat(router);
    await unchanged(screen, words);
    expect(reads()).toHaveLength(afterReturn); // The provider retains known closure.
    const reload = await renderRoute(CHAT, { viewport, strict: true });
    await expect.element(reload.screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await unchanged(reload.screen, words);
    expect(reads()).toHaveLength(afterReturn + 1);
  });
  it('refreshes a visitor-cancelled checkout on visibility and keeps it closed after reload', async () => {
    const { screen, router, token, words } = await issue(viewport);
    visibility('hidden');
    const before = mockStore.visitorSession(RIVERA.slug)?.events.length;
    await request('cancelPayment', { params: { token } }); // Checkout's own mutation in another tab.
    expect(mockStore.visitorSession(RIVERA.slug)?.events).toHaveLength(before ?? 0);
    await expect.element(action(screen)).toBeVisible();
    visibility('visible');
    await unchanged(screen, words);
    expect(reads()).toHaveLength(2);
    visibility('visible'); // A duplicate event while already visible isn't a return.
    expect(reads()).toHaveLength(2);
    await remountChat(router);
    await unchanged(screen, words);
    expect(reads()).toHaveLength(2);
    const reload = await renderRoute(CHAT, { viewport, strict: true });
    await expect.element(card(reload.screen)).toBeVisible();
    await unchanged(reload.screen, words);
    expect(reads()).toHaveLength(3);
  });
  it('keeps issued links and reads once per trigger, sharing concurrent refreshes', async () => {
    const { screen, token } = await issue(viewport);
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
    await screen.getByRole('textbox').fill('Hello');
    await expect.element(action(screen)).toBeVisible();
    expect(reads()).toHaveLength(1);
    let release = () => {};
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(release);
    const link = mockStore.world.links.get(token);
    if (!link) throw new Error('the chat issued its link');
    mockStore.inject({ route: 'paymentLink', status: 200, body: { ...link.view, state: 'paid' }, until, times: 1 });
    await payInOtherTab(token); // Confirmation arrives live, without a link id.
    await expect.element(screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await vi.waitFor(() => expect(reads()).toHaveLength(2));
    visibility('hidden');
    visibility('visible'); // The live confirmation's read is still in flight.
    await expect.element(action(screen)).toBeVisible();
    expect(reads()).toHaveLength(2);
    release();
    await expect.element(action(screen)).not.toBeInTheDocument();
    expectNoHorizontalScroll();
    expect(reads()).toHaveLength(2);
  });
  it('follows a stale issued read after a live payment confirmation without a visibility change', async () => {
    const { screen, token, words } = await issue(viewport);
    const link = mockStore.world.links.get(token)!;
    let release = () => {};
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(release);
    mockStore.inject({ route: 'paymentLink', status: 200, body: { ...link.view }, until });
    visibility('hidden');
    visibility('visible');
    await vi.waitFor(() => expect(reads()).toHaveLength(2));
    await payInOtherTab(token);
    await expect.element(screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await expect.element(action(screen)).toBeVisible();
    expect(reads()).toHaveLength(2);
    release();
    await unchanged(screen, words);
    await settledReads(3); // One follow-up sees the payment; no second visibility event.
  });
  it('keeps the issued button after a successful JSON null read', async () => {
    const { screen } = await issue(viewport);
    mockStore.inject({ route: 'paymentLink', status: 200, body: null });
    visibility('hidden');
    visibility('visible');
    await settledReads(2);
    expect(outcomes.at(-1)).toMatchObject({ ok: true });
    await expect.element(action(screen)).toBeVisible();
  });
  it('removes an expired action after a read and preserves the title and lines on reload', async () => {
    const { screen, router, token, words } = await issue(viewport);
    const content = (view: RenderResult) => ({
      title: card(view).element().querySelector('.cd-reply-card__headline')?.textContent,
      lines: [...card(view).element().querySelectorAll('.cd-reply-card__detail')].map((line) => line.textContent),
      note: card(view).element().querySelector('.cd-reply-card__note')?.textContent,
    });
    const before = content(screen);
    const link = mockStore.world.links.get(token);
    if (!link) throw new Error('the chat issued its link');
    // The mock has no expiry clock; settle its link to the contract's terminal state.
    link.view = { ...link.view, state: 'expired' };
    visibility('hidden');
    visibility('visible');
    await unchanged(screen, words);
    expect(content(screen)).toEqual(before);
    expect(reads()).toHaveLength(2);
    await remountChat(router);
    await unchanged(screen, words);
    expect(reads()).toHaveLength(2);
    const reload = await renderRoute(CHAT, { viewport, strict: true });
    await expect.element(card(reload.screen)).toBeVisible();
    await unchanged(reload.screen, words);
    expect(content(reload.screen)).toEqual(before);
    expect(reads()).toHaveLength(3);
  });
  it('keeps the button after unavailable or non-closed reads and performs no background polling', async () => {
    const { screen, token } = await issue(viewport);
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
    const link = mockStore.world.links.get(token);
    if (!link) throw new Error('the chat issued its link');
    let count = 1;
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    for (const state of ['issued', 'unknown']) {
      mockStore.inject({ route: 'paymentLink', status: 200, body: { ...link.view, state }, times: 1 });
      now += 30_000;
      clock.mockReturnValue(now);
      visibility('hidden');
      visibility('visible');
      count += 1;
      await settledReads(count);
      await expect.element(action(screen)).toBeVisible();
    }
    for (const status of ['network', 404, 429, 503] as const) {
      mockStore.inject({ route: 'paymentLink', status, times: 1 });
      now += 30_000;
      clock.mockReturnValue(now);
      visibility('hidden');
      visibility('visible');
      count += 1;
      await settledReads(count);
      expect(outcomes.at(-1)).toMatchObject({ ok: false, error: { status: status === 'network' ? null : status } });
      await expect.element(action(screen)).toBeVisible();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads()).toHaveLength(count);
    expectNoHorizontalScroll();
  });
  it('does not read a known paid link on later visibility returns', async () => {
    const { screen, token, words } = await issue(viewport);
    await payInOtherTab(token);
    await expect.element(screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await unchanged(screen, words);
    const before = reads().length;
    visibility('hidden');
    visibility('visible');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads()).toHaveLength(before);
    await unchanged(screen, words);
  });
});

describe('the chat a payment link came from', () => {
  /** This browser's record of each payment link's chat, as `storage.ts` keeps it. */
  const PAY_CHATS = 'claude-desk.pay-chats';
  const record = () => JSON.parse(localStorage.getItem(PAY_CHATS) ?? 'null') as unknown;

  it('records the chat’s own path against the link it shows, and nothing else', async () => {
    expect(record()).toBeNull();
    const { token } = await issue('desktop');
    // The card's token, as a digest, and the chat's path: no session, no words of the chat, no amount.
    expect(record()).toEqual([[payChatKey(token), CHAT]]);
    expect(payChatFor(token)).toBe(CHAT);
    expect(localStorage.getItem(PAY_CHATS)).not.toContain(token);

    // The same chat drawn again (a reload) records nothing new. Its one read of the open link
    // settles here, so no answer reaches the next test.
    const reload = await renderRoute(CHAT, { strict: true });
    await expect.element(action(reload.screen)).toBeVisible();
    await settledReads(2);
    expect(record()).toEqual([[payChatKey(token), CHAT]]);
  });

  it('an owner’s preview records the chat’s path without its query', async () => {
    const { token } = await issue('desktop', `${CHAT}?preview=${RIVERA.deskId}`);
    expect(mockStore.visitorSession(RIVERA.slug)?.ownerPreview).toBe(true);
    // The chat the preview's cookie names is the one `/d/<slug>` opens, so its path alone leads back.
    expect(record()).toEqual([[payChatKey(token), CHAT]]);
  });
});
