/**
 * MSW handlers: the mock API's transport, over one store. Each served route parses the request and
 * hands it, with its cookies, to the store's `dispatch`, and sends the answer back with the
 * `Set-Cookie` lines the store gives it; the visitor's event stream goes through MSW's `sse()`,
 * named by type with the seq as its id, as Plan 02's API sends it; a document card's link
 * (`/api/d/{token}`) answers with the document or the API's refusal (documents.ts). Any other
 * `/api/` request is answered 501 and recorded, so a screen test fails on a route nobody mocked.
 * The screen tests' service worker runs them over `mockStore` (browser.ts), the dev server over
 * its own (devServer.ts).
 * A request stamped with the epoch it was sent in (the screen tests' page stamps each one) reaches
 * the store with that epoch and its URL as the app sent it; the store drops it if that epoch is over.
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
import type { RuleChatOut } from '../api/views.ts';
import { playReply } from './ownerStreams.ts';
import { SERVED_KEYS } from './served.ts';
import { streamAfter, type MockAnswer, type MockStore } from './store.ts';

/**
 * Where a page stamps the epoch it sent a request in: a fetch in this header, and an `EventSource`,
 * which sends no headers of its own, in this query parameter, last in its URL.
 */
export const EPOCH_HEADER = 'x-mock-epoch';
export const EPOCH_PARAM = 'mock_epoch';

const EPOCH_IN_QUERY = new RegExp(`[?&]${EPOCH_PARAM}=(\\d+)$`);

/** The request's URL as the app sent it, with any epoch parameter taken off, and the epoch it was stamped with. */
export function unstamped(request: Request): { url: URL; epoch: number | undefined } {
  const url = new URL(request.url);
  const inQuery = EPOCH_IN_QUERY.exec(url.search);
  if (inQuery) url.search = url.search.slice(0, inQuery.index);
  const stamp = inQuery?.[1] ?? request.headers.get(EPOCH_HEADER);
  return { url, epoch: stamp !== null && /^\d+$/.test(stamp) ? Number(stamp) : undefined };
}

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
  const headers = new Headers();
  for (const line of answer.setCookie ?? []) headers.append('set-cookie', line);
  if (answer.body === undefined) return new HttpResponse(null, { status: answer.status, headers });
  return HttpResponse.json(answer.body as JsonBodyType, { status: answer.status, headers });
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
  // MSW types the name and data per event map key; every key here maps to an `SseEvent`.
  return { id: String(seq), event: ev.type, data: ev } as ServerSentEventMessage<EventMap>;
}

/** One event as an event stream frames it: its name and one line of JSON. */
function sseFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A 200 event stream answering a post, which `sse()` doesn't (it answers an `EventSource`'s GET):
 * `start` writes its events with `send`, then `end`s it, or `breakOff` drops the connection. Its
 * returned function stops it when the browser closes the stream.
 */
function postedStream(start: (send: (name: string, data: unknown) => void, end: () => void, breakOff: () => void) => () => void): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const once = (close: () => void) => () => {
        if (!open) return;
        open = false;
        close();
      };
      stop = start(
        (name, data) => {
          if (open) controller.enqueue(encoder.encode(sseFrame(name, data)));
        },
        once(() => controller.close()),
        once(() => controller.error(new Error('the connection broke off'))),
      );
    },
    cancel() {
      open = false;
      stop();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
}

type SetupEventMap = Record<'delta' | 'reset' | 'reading' | 'label' | 'done' | 'error', Record<string, unknown>>;

/** The mock API's handlers over `store`: every served route, the event stream, then the catch-all. */
export function createHandlers(store: MockStore): HttpHandler[] {
  function served(key: RouteKey): HttpHandler {
    const method = ROUTES[key].method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    return http[method](mswPath(key), async ({ request, params, cookies }) => {
      const { url, epoch } = unstamped(request);
      const { body, malformed } = await readBody(request);
      const answer = await store.dispatch(key, {
        params: stringParams(params),
        query: url.searchParams,
        body,
        malformed,
        path: `${url.pathname}${url.search}`,
        cookies,
        epoch,
      });
      return toResponse(answer);
    });
  }

  /**
   * The visitor's event stream. The first handler answers it like any route (no session, unknown
   * Desk, a planted fault) and lets an open stream through to the second, which replays what came
   * after `?after=` or `Last-Event-ID` and then follows the session.
   */
  const eventStream: HttpHandler[] = [
    http.get(mswPath('events'), async ({ request, params, cookies }) => {
      const { url, epoch } = unstamped(request);
      const answer = await store.dispatch('events', {
        params: stringParams(params),
        query: url.searchParams,
        path: `${url.pathname}${url.search}`,
        cookies,
        epoch,
      });
      if (!('network' in answer) && answer.status === 200) return undefined;
      return toResponse(answer);
    }),
    sse<EventMap>(mswPath('events'), ({ request, params, client, cookies }) => {
      const { url } = unstamped(request);
      const slug = stringParams(params).slug ?? '';
      const after = streamAfter(url.searchParams, request.headers.get('last-event-id'));
      let open = true;
      const send = (seq: number, ev: SseEvent) => {
        if (open) client.send(frame(seq, ev));
      };
      const stop = store.listen(slug, after, send, cookies);
      whenClosed(client, request, () => {
        open = false;
        stop();
      });
    }),
  ];

  /**
   * Ask Claude's answer as a stream, when the post asks for one (`Accept: text/event-stream`): the
   * route answers first, as the API admits a request, so a refusal goes back as JSON; then its
   * answer's words stream at the copy's pace, and the answer itself comes last, as `final`. A post
   * that asks for JSON goes on to the route's own handler.
   */
  const ruleChatStream = http.post(mswPath('ruleChat'), async ({ request, params, cookies }) => {
    if (!/\btext\/event-stream\b/.test(request.headers.get('accept') ?? '')) return undefined;
    const { url, epoch } = unstamped(request);
    const { body, malformed } = await readBody(request);
    const answer = await store.dispatch('ruleChat', {
      params: stringParams(params),
      query: url.searchParams,
      body,
      malformed,
      path: `${url.pathname}${url.search}`,
      cookies,
      epoch,
    });
    if ('network' in answer) return toResponse(answer);
    const { wordMs, plan, refusedAnswer } = store.ruleChatStream(cookies);
    // A change over the payment limit is refused once it is drafted, after the answer has streamed,
    // with the JSON route's error body; any other refusal comes before any stream, as JSON.
    const overLimit = answer.status === 422 && refusedAnswer !== null;
    if (answer.status !== 200 && !overLimit) return toResponse(answer);
    const out = overLimit ? null : (answer.body as RuleChatOut);
    const refusal = overLimit ? { status: 422, ...(answer.body as { error: string }) } : undefined;
    return postedStream((send, end, breakOff) =>
      playReply(
        { text: out?.answer ?? refusedAnswer ?? '', wordMs, plan: refusal ? { ...plan, fail: refusal, failAfter: undefined } : plan },
        {
          event(ev) {
            if (ev.name === 'delta') send('delta', { text: ev.text });
            else if (ev.name === 'reset') send('reset', {});
            else if (ev.name === 'error') {
              // The JSON route's error body, with its status.
              const { name: _event, ...body } = ev;
              send('error', body);
            }
          },
          end(how) {
            if (how === 'done' && out !== null) send('final', out);
            if (how === 'drop') breakOff();
            else end();
          },
        },
      ),
    );
  });

  /**
   * A setup turn's event stream: answered like any route first (no owner, an interview not in this
   * copy, a planted fault), then the running turn followed until it lands.
   */
  const setupStream: HttpHandler[] = [
    http.get(mswPath('setupEvents'), async ({ request, params, cookies }) => {
      const { url, epoch } = unstamped(request);
      const answer = await store.dispatch('setupEvents', {
        params: stringParams(params),
        query: url.searchParams,
        path: `${url.pathname}${url.search}`,
        cookies,
        epoch,
      });
      if (!('network' in answer) && answer.status === 200) return undefined;
      return toResponse(answer);
    }),
    sse<SetupEventMap>(mswPath('setupEvents'), ({ request, params, client, cookies }) => {
      let open = true;
      const stop = store.followSetup(
        stringParams(params).id ?? '',
        {
          send(name, data) {
            if (open) client.send({ event: name, data } as ServerSentEventMessage<SetupEventMap>);
          },
          close() {
            if (!open) return;
            open = false;
            client.close();
          },
        },
        cookies,
      );
      whenClosed(client, request, () => {
        open = false;
        stop();
      });
    }),
  ];

  /**
   * A document card's link, which the visitor's browser opens in a tab: none of the app's routes, and
   * answered as the document or the API's refusal, not as JSON.
   */
  const documentLink = (['GET', 'HEAD'] as const).map((method) =>
    http[method === 'GET' ? 'get' : 'head']('/api/d/:token', ({ request, params }) => {
      const { epoch } = unstamped(request);
      const answer = store.document(method, stringParams(params).token ?? '', { headers: request.headers, epoch });
      if ('network' in answer) return HttpResponse.error();
      return new HttpResponse(answer.body, { status: answer.status, headers: answer.headers });
    }),
  );

  return [
    ...eventStream,
    ...setupStream,
    ruleChatStream,
    ...SERVED_KEYS.filter((key) => key !== 'events' && key !== 'setupEvents').map(served),
    ...documentLink,
    http.all('/api/*', ({ request }) => {
      const { url, epoch } = unstamped(request);
      if (!store.admits(epoch)) return HttpResponse.error();
      store.recordUnhandled(url.pathname);
      return HttpResponse.json({ error: 'not_mocked' }, { status: 501 });
    }),
  ];
}
