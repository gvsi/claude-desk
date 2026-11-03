import { afterEach, beforeEach, expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { focusIsOn } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const SOURCES = ['things', 'outcomes', 'notifications', 'safety'] as const;

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

it.each(SOURCES)('a_request_without_an_openable_conversation_keeps_its_today_card_from_%s', async (source) => {
  const held = [...mockStore.world.decisions.values()].find((record) => record.decision.state === 'held')!.decision;
  // Owner-only sessions cannot open in Conversations, even when they have an id.
  mockStore.world.sessions.get(held.session_id)!.state.kind = 'owner';
  const start = source === 'notifications' || source === 'safety' ? `${DESK}/${source}` : `${DESK}/today`;
  const { screen, router } = await renderRoute(start);
  const link = source === 'things'
    ? screen.getByRole('region', { name: 'Things to try' }).getByRole('link', { name: 'Open the request', exact: true })
    : source === 'outcomes'
      ? screen.getByRole('main').getByRole('link', { name: 'held 1 for you', exact: true })
      : source === 'safety'
        ? screen.getByRole('link', { name: '1 held for you', exact: true })
        : screen.getByRole('link', { name: /Open the request/ });
  const path = `${DESK}/today#request-${encodeURIComponent(held.decision_id)}`;
  await expect.element(link).toHaveAttribute('href', path);
  await link.click();
  expect(router.state.location.pathname + router.state.location.hash).toBe(path);
  const card = screen.getByRole('article', { name: `Held for you: ${held.reason_plain}`, exact: true });
  await expect.element(card).toBeVisible();
  await expect.poll(() => focusIsOn(card.element())).toBe(true);
});
