/**
 * Payment link cards in the owner's transcript, in a real browser against the mock API: a link that
 * was paid or cancelled no longer offers "Open payment page", as in the visitor's own chat, and an
 * open one still does.
 */
import { describe, expect, it } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { matchRule } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE, type SessionRecord } from '../../mocks/world.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const ASK = "I'd like to pay the service call deposit.";
const conversation = (sessionId: string) => `/app/${RIVERA.deskId}/conversations/${sessionId}`;

/** A visitor's chat on Turner's main Desk in which Claude made `count` deposit links, oldest first; returns it and their tokens. */
function chatWithLinks(count: number): { chat: SessionRecord; tokens: string[] } {
  const world = mockStore.world;
  const desk = world.desk(RIVERA.deskId);
  if (!desk) throw new Error("the copy has Turner's main Desk");
  const chat = world.addSession(desk);
  const deposit = matchRule(ASK);
  expect(deposit.name).toBe('deposit');
  world.replay(chat, world.now() - 10 * MINUTE, Array.from({ length: count }, () => ({ text: ASK, steps: deposit.steps })));
  const tokens = [...world.links].filter(([, link]) => link.sessionId === chat.state.session_id).map(([token]) => token);
  expect(tokens).toHaveLength(count);
  return { chat, tokens };
}

function link(token: string) {
  const found = mockStore.world.links.get(token);
  if (!found) throw new Error(`the mock has no link ${token}`);
  return found;
}

/** Each payment link card in the transcript, in order: its "Open payment page" link's href, or null without one. */
function actions(screen: RenderResult): (string | null)[] {
  return screen
    .getByRole('log')
    .getByRole('article', { name: 'Payment link', exact: true })
    .elements()
    .map((card) => {
      const open = [...card.querySelectorAll('a')].find((a) => a.textContent === 'Open payment page');
      return open?.getAttribute('href') ?? null;
    });
}

describe.each(['desktop', 'phone'] as const)("payment link cards in the owner's transcript at %s size", (viewport) => {
  it('offers "Open payment page" only on a link still open, not on one paid or cancelled', async () => {
    const { chat, tokens } = chatWithLinks(3);
    const [paid, cancelled, open] = tokens as [string, string, string];
    mockStore.world.payLink(paid, link(paid));
    mockStore.world.cancelLink(cancelled, link(cancelled), 'visitor');

    const { screen } = await renderRoute(conversation(chat.state.session_id), { viewport });
    await expect.element(screen.getByRole('log').getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await expect.poll(() => actions(screen)).toEqual([null, null, `/pay/${open}`]);
  });

  it('drops "Open payment page" once the visitor pays while the owner has the chat open', async () => {
    const { chat, tokens } = chatWithLinks(1);
    const [token] = tokens as [string];
    const { screen } = await renderRoute(conversation(chat.state.session_id), { viewport, pollScale: 0.05 });
    await expect.poll(() => actions(screen)).toEqual([`/pay/${token}`]);

    mockStore.world.payLink(token, link(token));
    await expect.element(screen.getByRole('log').getByRole('article', { name: 'Paid', exact: true })).toBeVisible();
    await expect.poll(() => actions(screen)).toEqual([null]);
  });
});


it('returns focus to the owner transcript when its focused payment link closes', async () => {
  const { chat, tokens } = chatWithLinks(1);
  const [token] = tokens as [string];
  const { screen } = await renderRoute(conversation(chat.state.session_id), { pollScale: 0.05 });
  const log = screen.getByRole('log');
  const open = log.getByRole('link', { name: 'Open payment page', exact: true });
  await expect.element(open).toBeVisible();
  open.element().focus();
  await expect.element(open).toHaveFocus();
  mockStore.world.payLink(token, link(token));
  await expect.element(open).not.toBeInTheDocument();
  await expect.element(log).toHaveFocus();
});
