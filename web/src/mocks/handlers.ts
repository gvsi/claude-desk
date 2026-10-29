/**
 * MSW handlers: the mock API's transport. Each served route parses the request and hands it to
 * `mockStore.dispatch`; the visitor's event stream goes through MSW's `sse()`, named by type with
 * the seq as its id, as Plan 02's API sends it. Any other `/api/` request is answered 501 and
 * recorded, so a screen test fails on a route nobody mocked.
 */
import {
  http,
  HttpResponse,
  sse,
  type HttpHandler,
  type JsonBodyType,
  type PathParams,
  type ServerSentEventMessage,
} from 'msw';

import type { SseEvent } from '../api/contracts.ts';
import { ROUTES, type RouteKey } from '../api/routes.ts';
import { SERVED_KEYS } from './served.ts';
import { mockStore, streamAfter, type MockAnswer } from './store.ts';

/** `/api/owner/desks/{desk_id}/today` as MSW writes it: `/api/owner/desks/:desk_id/today`. */
function mswPath(key: RouteKey): string {
  return ROUTES[key].path.replace(/\{(\w+)\}/g, ':$1');
}

/** The path parameters MSW decoded, strings only. */
function stringParams(params: PathParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) if (typeof value === 'string') out[name] = value;
  return out;
}

async function readBody(request: Request): Promise<{ body: unknown; malformed: boolean }> {
  const text = await request.text();
  if (text === '') return { body: undefined, malformed: false };
  try {
    return { body: JSON.parse(text) as unknown, malformed: false };
  } catch {
    return { body: undefined, malformed: true };
  }
}

function toResponse(answer: MockAnswer): Response {
  if ('network' in answer) return HttpResponse.error();
  if (answer.body === undefined) return new HttpResponse(null, { status: answer.status });
  return HttpResponse.json(answer.body as JsonBodyType, { status: answer.status });
}

function served(key: RouteKey): HttpHandler {
  const method = ROUTES[key].method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
  return http[method](mswPath(key), async ({ request, params }) => {
    const url = new URL(request.url);
    const { body, malformed } = await readBody(request);
    const answer = await mockStore.dispatch(key, {
      params: stringParams(params),
      query: url.searchParams,
      body,
      malformed,
      path: `${url.pathname}${url.search}`,
    });
    return toResponse(answer);
  });
}

/** MSW 3 announces a closed stream on the connection's emitter, keyed by this registered symbol. */
const CONNECTION_EMITTER = Symbol.for('kClientEmitter');

interface ConnectionEmitter {
  on(type: 'close' | 'error', listener: () => void): unknown;
}

function isEmitter(value: unknown): value is ConnectionEmitter {
  return typeof value === 'object' && value !== null && typeof (value as { on?: unknown }).on === 'function';
}

/**
 * Calls `onClose` once the browser has closed the stream, so the store stops sending to it. A
 * runtime that aborts the request reports it through the signal; without either, sends to a closed
 * stream are only dropped.
 */
function whenClosed(client: object, request: Request, onClose: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    onClose();
  };
  request.signal.addEventListener('abort', once);
  const emitter = (client as Record<symbol, unknown>)[CONNECTION_EMITTER];
  if (isEmitter(emitter)) {
    emitter.on('close', once);
    emitter.on('error', once);
  }
}

type EventMap = Record<SseEvent['type'], SseEvent>;

/** One event as the API frames it: named by its type (an `EvError` as `error`), its seq as the id. */
function frame(seq: number, ev: SseEvent): ServerSentEventMessage<EventMap> {
  // MSW types the name and data per event map key; every key here maps to `SseEvent`.
  return { id: String(seq), event: ev.type, data: ev } as ServerSentEventMessage<EventMap>;
}

/**
 * The visitor's event stream. The first handler answers it like any route (no session, unknown
 * Desk, a planted fault) and lets an open stream through to the second, which replays what came
 * after `?after=` or `Last-Event-ID` and then follows the session.
 */
const eventStream: HttpHandler[] = [
  http.get(mswPath('events'), async ({ request, params }) => {
    const url = new URL(request.url);
    const answer = await mockStore.dispatch('events', {
      params: stringParams(params),
      query: url.searchParams,
      path: `${url.pathname}${url.search}`,
    });
    if (!('network' in answer) && answer.status === 200) return undefined;
    return toResponse(answer);
  }),
  sse<EventMap>(mswPath('events'), ({ request, params, client }) => {
    const url = new URL(request.url);
    const slug = stringParams(params).slug ?? '';
    const after = streamAfter(url.searchParams, request.headers.get('last-event-id'));
    let open = true;
    const stop = mockStore.listen(slug, after, (seq, ev) => {
      if (open) client.send(frame(seq, ev));
    });
    whenClosed(client, request, () => {
      open = false;
      stop();
    });
  }),
];

export const handlers: HttpHandler[] = [
  ...eventStream,
  ...SERVED_KEYS.filter((key) => key !== 'events').map(served),
  http.all('/api/*', ({ request }) => {
    mockStore.recordUnhandled(new URL(request.url).pathname);
    return HttpResponse.json({ error: 'not_mocked' }, { status: 501 });
  }),
];
