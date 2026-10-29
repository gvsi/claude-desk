/**
 * The mock API's handlers in a real browser, through the service worker every screen test uses:
 * they answer from the store (the event stream included), and an `/api/` path no handler serves is
 * answered 501 and recorded.
 */
import { describe, expect, it, vi } from 'vitest';

import type { PublicDesk, SseEvent } from '../api/contracts.ts';
import { apiPath } from '../api/routes.ts';
import { openStream } from '../api/stream.ts';
import type { CopyOut } from '../api/views.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

const json = { 'content-type': 'application/json' };
const EVENT_TYPES: readonly SseEvent['type'][] = [
  'writing',
  'message',
  'turn_end',
  'receipt',
  'held',
  'resolved',
  'owner_joined',
  'owner_left',
  'demo_inbox',
  'error',
];

describe('mock API handlers', () => {
  it('handlers_serve_the_store', async () => {
    const copy = await fetch('/api/owner/copies', { method: 'POST', headers: json, body: JSON.stringify({ passcode: 'demo' }) });
    // Plan 02a answers a new copy with 201.
    expect(copy.status).toBe(201);
    const copyOut = (await copy.json()) as CopyOut;
    expect(copyOut.copy_id).toBe(RIVERA.copyId);
    expect(copyOut.desks.map((d) => [d.desk_id, d.slug, d.name])).toEqual([[RIVERA.deskId, RIVERA.slug, 'Main line']]);
    expect(mockStore.requests.at(-1)).toEqual({ key: 'copies', body: { passcode: 'demo' }, path: '/api/owner/copies' });

    const desk = await fetch(`/api/public/${RIVERA.slug}`);
    expect(desk.status).toBe(200);
    const publicDesk = (await desk.json()) as PublicDesk;
    expect(publicDesk.owner_display_name).toBe('Maria Rivera');
    expect(Object.keys(publicDesk.brand).sort()).toEqual(['accent', 'primary']);
    expect((await fetch('/api/public/rivera-plumbing-nope00')).status).toBe(404);

    // The visitor's routes need the visitor cookie the session sets.
    const sessionPath = apiPath('visitorSession', { slug: RIVERA.slug });
    expect((await fetch(sessionPath)).status).toBe(401);
    expect((await fetch(apiPath('openSession', { slug: RIVERA.slug }), { method: 'POST' })).status).toBe(200);
    expect((await fetch(sessionPath)).status).toBe(200);

    // A message's turn streams to an EventSource, each event named by its type with its seq as the id.
    const events: [number, SseEvent][] = [];
    const stop = openStream<SseEvent>(apiPath('events', { slug: RIVERA.slug }, { after: '0' }), EVENT_TYPES, {
      event: (seq, ev) => events.push([seq, ev]),
      state: () => {},
    });
    try {
      const sent = await fetch(apiPath('sendMessage', { slug: RIVERA.slug }), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ text: 'How much is drain clearing?' }),
      });
      expect(sent.status).toBe(202);
      await vi.waitFor(() => expect(events.map(([, ev]) => ev.type)).toContain('turn_end'), { timeout: 3000 });
      expect(events.map(([seq, ev]) => [seq, ev.type])).toEqual([
        [1, 'receipt'],
        [2, 'writing'],
        [3, 'message'],
        [4, 'turn_end'],
      ]);
    } finally {
      stop();
    }

    // A fault planted on a route answers in its place.
    mockStore.inject({ route: 'health', status: 503 });
    expect((await fetch('/api/health')).status).toBe(503);
    expect((await fetch('/api/health')).status).toBe(200);
    mockStore.inject({ route: 'health', status: 'network' });
    await expect(fetch('/api/health')).rejects.toThrow(TypeError);
  });

  it('unknown_api_path_is_recorded', async () => {
    const res = await fetch('/api/nope');
    expect(res.status).toBe(501);
    expect(mockStore.unhandled).toEqual(['/api/nope']);
    mockStore.takeUnhandled('/api/nope');
    expect(mockStore.unhandled).toEqual([]);
    expect(() => mockStore.takeUnhandled('/api/nope')).toThrow(/expected an unhandled request/);
  });
});
