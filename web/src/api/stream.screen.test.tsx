/**
 * The event stream in a real browser `EventSource`, served by inline MSW `sse()` handlers on the
 * screens' shared worker (the setup drops them after each test): dispatch by payload type with
 * the event's seq, what is dropped, and the states a screen sees.
 */
import { http, HttpResponse, sse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { worker } from '../mocks/browser.ts';
import type { SseEvent } from './contracts.ts';
import { openStream, type StreamState } from './stream.ts';

const EVENTS_URL = '/api/public/desks/turner-plumbing/events';

/** The event names the handlers below send, so `client.send` accepts them. */
type Named = { message: unknown; writing: unknown; turn_end: unknown; error: unknown; surprise: unknown };
const TYPES: readonly SseEvent['type'][] = [
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

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

function listen() {
  const events: [number, SseEvent][] = [];
  const states: StreamState[] = [];
  stop = openStream<SseEvent>(EVENTS_URL, TYPES, {
    event: (seq, ev) => events.push([seq, ev]),
    state: (state) => states.push(state),
  });
  return { events, states };
}

describe('openStream', () => {
  it('delivers_named_events_with_their_seq', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ id: '7', event: 'writing', data: { type: 'writing' } });
        client.send({ id: '8', data: { type: 'error', code: 'internal' } });
        // The API names every event by its type, so an error arrives as an `error` event, which
        // the browser also hands to `onerror`. It is a payload, not a dropped connection.
        client.send({ id: '9', event: 'error', data: { type: 'error', code: 'kernel_unavailable' } });
        client.send({ id: '10', event: 'turn_end', data: { type: 'turn_end' } });
      }),
    );
    const { events, states } = listen();
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events).toEqual([
      [7, { type: 'writing' }],
      [8, { type: 'error', code: 'internal' }],
      [9, { type: 'error', code: 'kernel_unavailable' }],
      [10, { type: 'turn_end' }],
    ]);
    expect(states).toEqual(['open']);
  });

  it('drops_unknown_types_and_bad_data', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ id: '1', event: 'surprise', data: { type: 'surprise' } });
        client.send({ id: '2', data: 'not json' });
        client.send({ id: '3', data: { type: 'surprise' } });
        client.send({ id: '4', event: 'writing', data: { type: 'turn_end' } });
        client.send({ id: '5', data: ['writing'] });
        // Ids that `Number()` would read as a seq but that aren't plain digits.
        client.send({ id: '0x5', event: 'writing', data: { type: 'writing' } });
        client.send({ id: '1e1', event: 'writing', data: { type: 'writing' } });
        client.send({ id: '7 ', event: 'writing', data: { type: 'writing' } });
        client.send({ id: '6', event: 'writing', data: { type: 'writing' } });
      }),
    );
    const { events } = listen();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // Give anything dropped a moment to show up if it weren't.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([[6, { type: 'writing' }]]);
  });

  it('reports_reconnecting_then_open', async () => {
    let connections = 0;
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        connections += 1;
        if (connections === 1) {
          client.send({ retry: 50 });
          client.send({ id: '1', event: 'writing', data: { type: 'writing' } });
          client.close();
        } else {
          client.send({ id: '2', event: 'turn_end', data: { type: 'turn_end' } });
        }
      }),
    );
    const { events, states } = listen();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(states).toEqual(['open', 'reconnecting', 'open']);
    expect(events.map(([seq]) => seq)).toEqual([1, 2]);
    expect(connections).toBe(2);
  });

  it('reports_closed_on_non_200', async () => {
    let requests = 0;
    worker.use(
      http.get(EVENTS_URL, () => {
        requests += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const { events, states } = listen();
    await vi.waitFor(() => expect(states).toEqual(['closed']));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests).toBe(1);
    expect(events).toEqual([]);
    expect(states).toEqual(['closed']);
  });
});
