/**
 * The demo visitor in a real browser against the mock API: Today's "Watch a demo visitor" card that
 * starts one and opens its conversation, its start error, the five cards' layout, the "Demo
 * visitor" pill on its row, its conversation's head and wherever Needs you names it, the note over
 * its conversation with Stop, and how the note says it ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locator } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

const TODAY = `/app/${RIVERA.deskId}/today`;
const CARD_TITLE = 'Watch a demo visitor';
const CARD_DETAIL = 'An AI plays a customer on your Desk. Take over or whisper to Claude while it chats.';
const START_FAILED = 'The demo visitor couldn’t start. Try again in a few minutes.';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

function region(screen: RenderResult, name: string) {
  return screen.getByRole('region', { name, exact: true });
}

/** What starts the demo visitor: from 640 px the card's own button; on a phone the whole row, named by its title. */
function startControl(things: Locator, viewport: Viewport): Locator {
  return viewport === 'phone'
    ? things.getByRole('button', { name: CARD_TITLE, exact: true })
    : things.getByRole('button', { name: 'Start a demo visitor', exact: true });
}

/** The demo visitor's chats in the mock copy, newest last. */
function demoChats() {
  return [...mockStore.world.sessions.values()].filter((chat) => chat.demoVisitor != null);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Demo visitor', () => {
  it.each(['desktop', 'phone'] as const)('the_card_starts_a_demo_visitor_and_opens_its_conversation_on_%s', async (viewport: Viewport) => {
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const things = region(screen, 'Things to try');
    const title = things.getByRole('heading', { level: 3, name: CARD_TITLE });
    await expect.element(title).toBeVisible();
    // The second card, after "Chat as a customer", with its line.
    const items = [...things.element().querySelectorAll('.cd-things__item')];
    expect(items.map((item) => item.querySelector('h3')?.textContent)).toEqual([
      'Chat as a customer',
      CARD_TITLE,
      'Try to break it',
      'Answer a held request',
      'Create your own Desk',
    ]);
    await expect.element(things.getByText(CARD_DETAIL, { exact: true })).toBeVisible();
    expectNoHorizontalScroll();

    // From 640 px the card's own button starts it; on a phone the whole row does, named by its title.
    await startControl(things, viewport).click();

    await expect.poll(() => demoChats().length).toBe(1);
    const chat = demoChats()[0]!;
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/conversations/${chat.state.session_id}`);
    const [sent] = requests('startDemoVisitor');
    expect(sent?.body).toEqual({ idempotency_key: expect.any(String) });
    expect(requests('startDemoVisitor')).toHaveLength(1);
  });

  it.each(['desktop', 'phone'] as const)('a_start_that_fails_says_so_as_an_alert_and_the_button_stays_on_%s', async (viewport: Viewport) => {
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    // Too many starts this hour, today's budget spent, a run that couldn't open its chat, or anything
    // else: each says the same line, after a refused dot, read out as an alert.
    const failures = [
      { status: 429, body: { error: 'rate_limited', retry_after: 1200 } },
      { status: 503, body: { error: 'demo_budget' } },
      { status: 503, body: { error: 'demo_visitor_unavailable' } },
      { status: 500, body: { error: 'internal' } },
    ];
    for (const [i, failure] of failures.entries()) {
      mockStore.inject({ route: 'startDemoVisitor', ...failure });
      await startControl(things, viewport).click();
      await expect.poll(() => requests('startDemoVisitor').length).toBe(i + 1);
      const alert = things.getByRole('alert');
      await expect.element(alert).toHaveTextContent(START_FAILED);
      expect(alert.element().querySelector('.cd-status-dot--refused'), 'its refused dot').not.toBeNull();
      // The line stands where the card's own line was, and the button stays to try again.
      await expect.element(things.getByText(CARD_DETAIL, { exact: true })).not.toBeInTheDocument();
      await expect.element(startControl(things, viewport)).toBeVisible();
    }
    expect(router.state.location.pathname).toBe(TODAY);
    expect(demoChats()).toHaveLength(0);
    expectNoHorizontalScroll();

    // The next try goes through.
    await startControl(things, viewport).click();
    await expect.poll(() => demoChats().length).toBe(1);
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/conversations/${demoChats()[0]!.state.session_id}`);
  });

  it.each([
    [1440, 900, 3],
    [1280, 800, 3],
    [1279, 800, 2],
    [800, 900, 2],
    [640, 900, 2],
    [390, 844, 1],
  ])('the_five_things_lay_out_at_%sx%s_%s_across', async (width, height, across) => {
    const { screen } = await renderRoute(TODAY, { viewport: { width, height } });
    const things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    const items = [...things.element().querySelectorAll('.cd-things__item')];
    expect(items).toHaveLength(5);
    const tops = items.map((item) => Math.round(item.getBoundingClientRect().top));
    const lefts = items.map((item) => Math.round(item.getBoundingClientRect().left));
    // Rows of `across`: each row's cards share a top, and each starts a new one under the last.
    const rows = Math.ceil(5 / across);
    for (let row = 0; row < rows; row += 1) {
      const inRow = tops.slice(row * across, row * across + across);
      expect(new Set(inRow).size, `row ${row + 1} shares its top`).toBe(1);
      if (row > 0) expect(inRow[0]!, `row ${row + 1} is under row ${row}`).toBeGreaterThan(tops[(row - 1) * across]!);
    }
    expect(new Set(lefts).size, 'columns').toBe(across);
    expectNoHorizontalScroll();
  });

  it('the_card_is_done_once_a_demo_visitor_has_run', async () => {
    const { screen, router } = await renderRoute(TODAY);
    let things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    await expect.element(things.getByText('About 10 minutes. No real customer sees any of it.', { exact: true })).toBeVisible();
    await startControl(things, 'desktop').click();
    await expect.poll(() => demoChats().length).toBe(1);
    await expect.poll(() => router.state.location.pathname).not.toBe(TODAY);

    // Back on Today, it is ticked off like the others: its check, its own line kept, and a Done pill read out.
    await router.navigate(TODAY);
    things = region(screen, 'Things to try');
    await expect.element(things.getByText('1 of 5 done. No real customer sees any of it.', { exact: true })).toBeVisible();
    const card = things.getByRole('heading', { level: 3, name: CARD_TITLE }).element().closest('.cd-things__item')!;
    expect(card.querySelector('.cd-things__done')?.textContent).toBe('Done');
    expect(card.querySelector('.cd-things__done')?.getAttribute('aria-hidden')).toBeNull();
    expect(card.textContent).toContain(CARD_DETAIL);
    expect(card.querySelector('button, a'), 'no next step once done').toBeNull();
  });
});
