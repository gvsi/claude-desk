import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { request } from '../api/http.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

const CHAT = `/d/${RIVERA.slug}`;
const reads = () => mockStore.requests.filter((r) => r.key === 'paymentLink');
const card = (screen: RenderResult) => screen.getByRole('article', { name: 'Payment link', exact: true });
const action = (screen: RenderResult) => screen.getByRole('link', { name: 'Open payment page' });

function visibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  onTestFinished(() => { Reflect.deleteProperty(document, 'visibilityState'); });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function issue(viewport: Viewport) {
  const view = await renderRoute(CHAT, { viewport, strict: true, pollScale: 100 });
  await expect.element(view.screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeEnabled();
  await view.screen.getByRole('textbox').fill('How do I pay the deposit?');
  await view.screen.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.element(action(view.screen)).toBeVisible();
  const href = action(view.screen).element().getAttribute('href') ?? '';
  const token = href.slice('/pay/'.length);
  await vi.waitFor(() => expect(mockStore.visitorSession(RIVERA.slug)?.events.at(-1)?.ev.type).toBe('turn_end'));
  return { ...view, token, href, words: card(view.screen).element().querySelector('.cd-reply-card__data')?.textContent };
}

async function unchanged(screen: RenderResult, words: string | null | undefined) {
  await expect.element(action(screen)).not.toBeInTheDocument();
  expect(card(screen).element().querySelector('.cd-reply-card__data')?.textContent).toBe(words);
  expectNoHorizontalScroll();
}

describe.each(['desktop', 'phone'] as const)('payment link actions at %s size', (viewport) => {
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
    const beforeReturn = reads().length; // Checkout has its own StrictMode reads.
    await router.navigate(CHAT);
    await expect.element(screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await unchanged(screen, words);
    // The retained chat first draws its old card, then receives the missed confirmation.
    const afterReturn = reads().length;
    expect(afterReturn - beforeReturn).toBeGreaterThanOrEqual(1);
    expect(afterReturn - beforeReturn).toBeLessThanOrEqual(2); // Concurrent triggers share a read.
    const reload = await renderRoute(CHAT, { viewport, strict: true });
    await expect.element(reload.screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await unchanged(reload.screen, words);
    expect(reads()).toHaveLength(afterReturn + 1);
  });
  it('refreshes a visitor-cancelled checkout on visibility and keeps it closed after reload', async () => {
    const { screen, token, words } = await issue(viewport);
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
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
    await request('completePayment', { params: { token } }); // Confirmation arrives live, without a link id.
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
  it('keeps the button after unavailable or non-closed reads and performs no background polling', async () => {
    const { screen, token } = await issue(viewport);
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
    const link = mockStore.world.links.get(token);
    if (!link) throw new Error('the chat issued its link');
    let count = 1;
    for (const state of ['issued', 'unknown', 'expired']) {
      mockStore.inject({ route: 'paymentLink', status: 200, body: { ...link.view, state }, times: 1 });
      visibility('hidden');
      visibility('visible');
      count += 1;
      await vi.waitFor(() => expect(reads()).toHaveLength(count));
      await expect.element(action(screen)).toBeVisible();
    }
    for (const status of ['network', 404, 429, 503] as const) {
      mockStore.inject({ route: 'paymentLink', status, times: 1 });
      visibility('hidden');
      visibility('visible');
      count += 1;
      await vi.waitFor(() => expect(reads()).toHaveLength(count));
      await expect.element(action(screen)).toBeVisible();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads()).toHaveLength(count);
    expectNoHorizontalScroll();
  });
  it('does not reopen a known paid link when a later refresh fails', async () => {
    const { screen, token, words } = await issue(viewport);
    await request('completePayment', { params: { token } });
    await expect.element(screen.getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await unchanged(screen, words);
    const before = reads().length;
    mockStore.inject({ route: 'paymentLink', status: 503, times: 1 });
    visibility('hidden');
    visibility('visible');
    await vi.waitFor(() => expect(reads()).toHaveLength(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await unchanged(screen, words);
  });
});
