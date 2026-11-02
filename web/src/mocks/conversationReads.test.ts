import { beforeEach, expect, it } from 'vitest';

import type { BusinessOut, ConversationSummary } from '../api/views.ts';
import { RIVERA } from './seed.ts';
import { MockStore } from './store.ts';

const store = new MockStore();
const HELD = 'ses-visitor-web';
beforeEach(() => store.reset('rivera'));
const chat = () => store.world.sessions.get(HELD)!;
const newest = () => Math.max(...chat().items.map((item) => item.n));
const read = (through: number) => store.dispatch('markConversationRead', { params: { session_id: HELD }, body: { through } });

it('caps markers, moves only forward, and leaves later visitor messages unread', async () => {
  const first = newest();
  expect(await read(Number.MAX_SAFE_INTEGER)).toEqual({ status: 204 });
  expect(chat().readThrough).toBe(first);
  store.world.visitorText(chat(), 'One more question.');
  expect(store.world.isUnread(chat())).toBe(true);
  expect(await read(0)).toEqual({ status: 204 });
  expect(chat().readThrough).toBe(first);
  const list = await store.dispatch('conversations', { params: { desk_id: RIVERA.deskId } });
  expect('body' in list && (list.body as ConversationSummary[]).find((row) => row.session_id === HELD)?.unread).toBe(true);
  await read(newest());
  expect(store.world.isUnread(chat())).toBe(false);
  const desks = await store.dispatch('desks');
  expect('body' in desks && (desks.body as BusinessOut[])[0]?.desks[0]?.unread_conversations).toBe(1);
});

it('only visitor and visiting agent words make chats unread, excluding the owner preview', async () => {
  const desk = store.world.desk(RIVERA.deskId)!;
  const visitor = store.world.addSession(desk);
  expect(store.world.isUnread(visitor)).toBe(false);
  store.world.whisper(visitor, 'Ask about the address.');
  expect(store.world.isUnread(visitor)).toBe(false);
  store.world.visitorText(visitor, 'Hello.');
  expect(store.world.isUnread(visitor)).toBe(true);
  const agent = store.world.addSession(desk, { agent: 'Assistant' });
  store.world.agentText(agent, 'A signed request.');
  expect(store.world.isUnread(agent)).toBe(true);
  const preview = store.world.addSession(desk, { ownerPreview: true });
  store.world.visitorText(preview, 'My own preview.');
  expect(store.world.isUnread(preview)).toBe(false);
});

it('rejects invalid markers without changing the stored cursor', async () => {
  for (const through of [-1, 1.5, '9', null]) {
    const answer = await store.dispatch('markConversationRead', { params: { session_id: HELD }, body: { through } });
    expect(answer).toMatchObject({ status: 422 });
  }
  expect(chat().readThrough).toBe(0);
});

it('requires the owner and an existing conversation', async () => {
  expect(await store.dispatch('markConversationRead', { params: { session_id: 'missing' }, body: { through: 0 } })).toMatchObject({ status: 404 });
  store.reset('rivera', { signedIn: false });
  expect(await read(0)).toMatchObject({ status: 401 });
});
