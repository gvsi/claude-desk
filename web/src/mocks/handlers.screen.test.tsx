/**
 * The mock API's handlers in a real browser, through the service worker every screen test uses:
 * they answer from the store (the event stream included), and an `/api/` path no handler serves is
 * answered 501 and recorded. A request the page sent late, once the next test or a render from a
 * seed has started over, reaches nothing, not even a handler the test added; and the page's
 * stamped fetch fails as native fetch does.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import type { PublicDesk, SseEvent } from '../api/contracts.ts';
import { apiPath } from '../api/routes.ts';
import { openStream, type StreamState } from '../api/stream.ts';
import type { CopyOut } from '../api/views.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { startTest, worker } from './browser.ts';
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
    // A screen can start on a copy this browser hasn't opened: the owner's routes answer 401 until
    // a passcode opens it, and a wrong one opens nothing.
    await renderRoute('/no/such/page', { seed: { name: 'rivera', signedIn: false } });
    const me = () => fetch('/api/owner/me');
    expect((await me()).status).toBe(401);
    expect(await (await me()).json()).toEqual({ error: 'no_owner_session' });
    expect((await fetch(apiPath('today', { desk_id: RIVERA.deskId }))).status).toBe(401);
    const wrong = await fetch('/api/owner/copies', { method: 'POST', headers: json, body: JSON.stringify({ passcode: 'wrong' }) });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'wrong_passcode' });
    expect((await me()).status).toBe(401);

    const copy = await fetch('/api/owner/copies', { method: 'POST', headers: json, body: JSON.stringify({ passcode: 'demo' }) });
    // Plan 02a answers a new copy with 201.
    expect(copy.status).toBe(201);
    const copyOut = (await copy.json()) as CopyOut;
    expect(copyOut.copy_id).toBe(RIVERA.copyId);
    expect(copyOut.desks.map((d) => [d.desk_id, d.slug, d.name])).toEqual([[RIVERA.deskId, RIVERA.slug, 'Main line']]);
    expect(mockStore.requests.at(-1)).toEqual({ key: 'copies', body: { passcode: 'demo' }, path: '/api/owner/copies' });
    expect((await me()).status).toBe(200);

    const desk = await fetch(`/api/public/${RIVERA.slug}`);
    expect(desk.status).toBe(200);
    const publicDesk = (await desk.json()) as PublicDesk;
    expect(publicDesk.owner_display_name).toBe('Mike Turner');
    expect(Object.keys(publicDesk.brand).sort()).toEqual(['accent', 'primary']);
    // The kernel's open status, 90 seconds before the 6:00 pm close, which is when its text next changes.
    const status = publicDesk.open_status;
    expect(status).toMatchObject({ open: true, text: 'Open now, until 6:00 pm', opens_at: null });
    expect(Date.parse(status?.refresh_at ?? '') - Date.parse(status?.as_of ?? '')).toBe(90_000);
    expect(status?.until).toBe(status?.refresh_at);
    const spanish = (await (await fetch(`/api/public/${RIVERA.slug}?lang=es`)).json()) as PublicDesk;
    expect(spanish.open_status?.text).toBe('Abierto ahora, hasta las 18:00');
    expect((await fetch('/api/public/turner-plumbing-nope00')).status).toBe(404);

    // The visitor's routes need the visitor cookie the session sets.
    const sessionPath = apiPath('visitorSession', { slug: RIVERA.slug });
    expect((await fetch(sessionPath)).status).toBe(401);
    expect((await fetch(apiPath('openSession', { slug: RIVERA.slug }), { method: 'POST' })).status).toBe(200);
    expect((await fetch(sessionPath)).status).toBe(200);

    // A message's turn streams to an EventSource, each event named by its type with its seq as the id.
    const events: [number, SseEvent][] = [];
    const states: StreamState[] = [];
    const stop = openStream<SseEvent>(apiPath('events', { slug: RIVERA.slug }, { after: '0' }), EVENT_TYPES, {
      event: (seq, ev) => events.push([seq, ev]),
      state: (state) => states.push(state),
    });
    // The same stream on a bare EventSource, to see what reaches its `onerror`.
    const raw = new EventSource(apiPath('events', { slug: RIVERA.slug }));
    const reachedOnerror: [type: string, id: string, data: unknown][] = [];
    raw.onerror = (e) => {
      if (e instanceof MessageEvent) reachedOnerror.push([e.type, e.lastEventId, JSON.parse(String(e.data))]);
    };
    const say = async (text: string) => {
      const body = JSON.stringify({ text });
      const sent = await fetch(apiPath('sendMessage', { slug: RIVERA.slug }), { method: 'POST', headers: json, body });
      expect(sent.status).toBe(202);
    };
    try {
      await say('How much is drain clearing?');
      await vi.waitFor(() => expect(events.map(([, ev]) => ev.type)).toContain('turn_end'), { timeout: 3000 });
      expect(events.map(([seq, ev]) => [seq, ev.type])).toEqual([
        [1, 'writing'],
        [2, 'receipt'],
        [3, 'message'],
        [4, 'turn_end'],
      ]);

      // An error goes out as an `error` event, as the API sends it. The browser also hands that
      // event to `onerror`, and openStream delivers it as an event, not as a dropped connection.
      await say('outage');
      await vi.waitFor(() => expect(events).toHaveLength(7), { timeout: 3000 });
      expect(events.slice(4)).toEqual([
        [5, { type: 'writing' }],
        [6, { type: 'error', code: 'kernel_unavailable' }],
        [7, { type: 'turn_end' }],
      ]);
      expect(states).toEqual(['open']);
      await vi.waitFor(() => expect(reachedOnerror).toEqual([['error', '6', { type: 'error', code: 'kernel_unavailable' }]]));
    } finally {
      stop();
      raw.close();
    }

    // A fault planted on a route answers in its place.
    mockStore.inject({ route: 'health', status: 503 });
    expect((await fetch('/api/health')).status).toBe(503);
    expect((await fetch('/api/health')).status).toBe(200);
    mockStore.inject({ route: 'health', status: 'network' });
    await expect(fetch('/api/health')).rejects.toThrow(TypeError);

    // A seed starts the mock over, signed in unless the test says otherwise.
    await renderRoute('/no/such/page', { seed: 'rivera_quiet' });
    expect((await me()).status).toBe(200);
    expect(await (await fetch(apiPath('needsYou', { desk_id: RIVERA.deskId }))).json()).toEqual([]);
  });

  it('late_requests_from_the_last_test_are_dropped', async () => {
    // The last test's page sent these just before it ended. The service worker hands each one to
    // the mock only after the next test has started over, as on a slow runner.
    const session = fetch(apiPath('openSession', { slug: RIVERA.slug }), { method: 'POST' });
    const unmocked = fetch('/api/nope');
    const stream = new EventSource(apiPath('events', { slug: RIVERA.slug }, { after: '0' }));
    const streamAnswered = new Promise((resolve) => {
      stream.onopen = resolve;
      stream.onerror = resolve;
    });
    startTest();
    await Promise.allSettled([session, unmocked]);
    await streamAnswered;
    stream.close();
    // None of them is recorded in this test or changes its copy.
    expect(mockStore.requests).toEqual([]);
    expect(mockStore.unhandled).toEqual([]);
    expect(mockStore.visitorSession(RIVERA.slug)).toBeNull();

    // What this test sends is answered and recorded as ever.
    expect((await fetch(apiPath('openSession', { slug: RIVERA.slug }), { method: 'POST' })).status).toBe(200);
    expect(mockStore.requests.map((r) => r.key)).toEqual(['openSession']);
  });

  it('late_requests_from_before_a_seeded_render_are_dropped', async () => {
    // The first page's request is still on its way, held here by a planted delay, when the test
    // renders again from a fresh seed. It changes nothing in the copy that render starts from.
    mockStore.inject({ route: 'openSession', status: 200, delayMs: 300, afterCommit: true });
    const late = fetch(apiPath('openSession', { slug: RIVERA.slug }), { method: 'POST' }).then(
      (res) => res.status,
      () => 'dropped',
    );
    await renderRoute('/no/such/page', { seed: 'rivera' });
    expect(await late).toBe('dropped');
    expect(mockStore.visitorSession(RIVERA.slug)).toBeNull();
    expect(mockStore.requests.filter((r) => r.key === 'openSession')).toEqual([]);
  });

  it('late_requests_skip_handlers_the_next_test_adds', async () => {
    // The last test's page sent this just before it ended; the next test adds its own handler for
    // the same route as it starts. The late request doesn't reach it.
    const path = apiPath('visitorSession', { slug: RIVERA.slug });
    const late = fetch(path).then(
      (res) => res.status,
      () => 'dropped',
    );
    startTest();
    let hits = 0;
    worker.use(
      http.get(path, () => {
        hits += 1;
        return HttpResponse.json({ error: 'no_session' }, { status: 401 });
      }),
    );
    expect(await late).toBe('dropped');
    expect(hits).toBe(0);

    // What this test sends reaches it as ever.
    expect((await fetch(path)).status).toBe(401);
    expect(hits).toBe(1);
  });

  it('stamped_fetch_rejects_a_bad_request_as_native_fetch_does', async () => {
    // A GET with a body is a TypeError. Native fetch hands it back as a rejected promise, and the
    // stamped fetch the page sends `/api/` requests through does the same.
    const outcome = (path: string): Promise<string> | string => {
      try {
        return fetch(path, { method: 'GET', body: 'x' }).then(
          () => 'answered',
          () => 'rejected',
        );
      } catch {
        return 'threw';
      }
    };
    expect({ api: await outcome('/api/health'), other: await outcome('/not-api') }).toEqual({
      api: 'rejected',
      other: 'rejected',
    });
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
