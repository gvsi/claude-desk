/**
 * Payment link cards in the "Send an agent" panel's run, in a real browser against the mock API: a
 * link that was paid or cancelled no longer offers "Open payment page", as in the visitor's own chat
 * and the owner's transcript, and an open one still does. So does a link whose quote the agent then
 * paid another way, within its signed limit: the kernel cancels it when it is next read.
 */
import { describe, expect, it } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { CardBlock } from '../../api/contracts.ts';
import type { DemoAgentRun } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { AGENT_NAME } from '../../mocks/agents.ts';
import { matchRule } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE } from '../../mocks/world.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const PAGE = `/d/${RIVERA.slug}/agents`;
const ASK = "I'd like to pay the service call deposit.";

/**
 * `count` deposit link cards Claude made on Turner's main Desk, oldest first, with their tokens: in a
 * visitor's chat, or in a chat of the built-in agent's when `agent`.
 */
function depositLinks(count: number, { agent = false } = {}): { cards: CardBlock[]; tokens: string[] } {
  const world = mockStore.world;
  const desk = world.desk(RIVERA.deskId);
  if (!desk) throw new Error("the copy has Turner's main Desk");
  const chat = world.addSession(desk, agent ? { agent: AGENT_NAME } : {});
  const deposit = matchRule(ASK);
  expect(deposit.name).toBe('deposit');
  world.replay(chat, world.now() - 10 * MINUTE, Array.from({ length: count }, () => ({ text: ASK, steps: deposit.steps })));
  const cards = chat.events.flatMap(({ ev }) => ev.type === 'message'
    ? ev.blocks.filter((block): block is CardBlock => block.kind === 'card' && block.template === 'payment_link') : []);
  const tokens = cards.map((card) => /^\/pay\/([A-Za-z0-9_-]+)$/.exec(card.href ?? '')?.[1] ?? '');
  expect(cards).toHaveLength(count);
  return { cards, tokens };
}

function link(token: string) {
  const found = mockStore.world.links.get(token);
  if (!found) throw new Error(`the mock has no link ${token}`);
  return found;
}

/** A finished run in which each of the Desk's replies holds one of `cards`. */
function runWith(cards: CardBlock[]): DemoAgentRun {
  return {
    run_id: 'run-links', launcher_session_id: 'ses-any', slug: RIVERA.slug, task: 'book_visit', state: 'done',
    turns: cards.flatMap((card, at) => [
      { author: 'agent' as const, n: 2 * at + 1, blocks: [], receipts: [], text: 'Alex Kim would like to pay the deposit.' },
      { author: 'desk' as const, n: 2 * at + 2, blocks: [card], receipts: [], text: null },
    ]),
  };
}

/** Each payment link card in the panel's run, in order: its "Open payment page" link's href, or null without one. */
function actions(screen: RenderResult): (string | null)[] {
  return screen
    .getByRole('region', { name: 'Send an agent' })
    .getByRole('log')
    .getByRole('article', { name: 'Payment link', exact: true })
    .elements()
    .map((card) => {
      const open = [...card.querySelectorAll('a')].find((a) => a.textContent === 'Open payment page');
      return open?.getAttribute('href') ?? null;
    });
}

describe.each(['desktop', 'phone'] as const)('payment link cards in the agent panel at %s size', (viewport) => {
  it('offers "Open payment page" only on a link still open, not on one paid or cancelled', async () => {
    const { cards, tokens } = depositLinks(3);
    const [paid, cancelled, open] = tokens as [string, string, string];
    mockStore.world.payLink(paid, link(paid));
    mockStore.world.cancelLink(cancelled, link(cancelled), 'visitor');
    mockStore.inject({ route: 'agentRun', status: 200, body: runWith(cards), times: 100 });

    const { screen } = await renderRoute(PAGE, { viewport });
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    await expect.poll(() => actions(screen)).toEqual([null, null, `/pay/${open}`]);
  });

  it('drops "Open payment page" once the agent pays the link\'s quote within its signed limit', async () => {
    // Claude gave the agent the deposit's payment link; the mock's deposit link names no quote, so
    // the test gives it one (the quote the kernel's link pays)
    const { cards: [card], tokens: [token] } = depositLinks(1, { agent: true });
    if (!card || !token) throw new Error('the agent has a deposit link');
    const quoteId = 'Q-1050';
    link(token).quoteId = quoteId;
    const run: DemoAgentRun = { ...runWith([card]), task: 'quote_and_deposit', state: 'running' };
    mockStore.inject({ route: 'agentRun', status: 200, body: run, times: 1000 });

    const { screen } = await renderRoute(PAGE, { viewport });
    await screen.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).click();
    await expect.poll(() => actions(screen)).toEqual([`/pay/${token}`]);

    // then it pays the same quote within its signed limit, and the Desk confirms the charge
    mockStore.world.quotePaid(quoteId);
    run.turns.push(
      { author: 'agent', n: 3, blocks: [], receipts: [], text: 'Charge the deposit to the signed limit.' },
      { author: 'desk', n: 4, blocks: [{ ...rivera.blocks.charge_confirmed.en }], receipts: [], text: null },
    );
    run.state = 'done';
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    await expect.poll(() => actions(screen)).toEqual([null]);
    expect(link(token).view).toMatchObject({ state: 'cancelled', cancel_reason: null });
  });
});
