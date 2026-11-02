/**
 * The mock API for `npm run dev:mock`, run once in the Vite dev server's process so it has one
 * owner of state: every tab of a browser, Today and the public page opened in a new tab alike,
 * shares one demo copy with its owner and visitor sessions, holds and streams, as on the API.
 * Copies are keyed by the owner cookie (store.ts, `real` cookies): the dev server starts with none,
 * so the first screen is the intro dialog, a passcode makes a browser its own copy, a reload keeps
 * it, and a restart starts over. Another browser shares nothing until its own passcode, though it
 * can follow a copy's public link as a stranger would.
 *
 * Node-only, and never in a build: `vite.config.ts` imports `mockApiPlugin` in mode `mock` only,
 * and the plugin applies only to `vite dev`.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { getResponse } from 'msw';
import type { Plugin } from 'vite';

import { createHandlers } from './handlers.ts';
import type { StreamSettings } from './ownerStreams.ts';
import { MockStore } from './store.ts';

export interface MockApi {
  /** Answers one `/api/` request, an event stream included (its body streams until the client closes it). */
  handle(request: Request): Promise<Response>;
}

/**
 * MSW's `sse()` refuses to build a handler where the runtime has no `EventSource`, though it only
 * constructs one to pass a stream through to a real server, which the mock never does. Node keeps
 * `EventSource` behind a flag, so this process gets a stand-in that refuses to connect anywhere.
 */
function allowSseHandlers(): void {
  if (typeof globalThis.EventSource === 'function') return;
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: class UnavailableEventSource {
      constructor() {
        throw new Error('The mock API answers event streams itself and never connects to a server');
      }
    },
  });
}

/**
 * A new mock API with no copies, answering through MSW over the mock's handlers. Its streams go at
 * a model's pace, every setup turn streamed; a test can write them faster (`streams`).
 */
export function createMockApi({ streams }: { streams?: StreamSettings } = {}): MockApi {
  allowSseHandlers();
  const handlers = createHandlers(new MockStore({ cookies: 'real', streams }));
  return {
    async handle(request) {
      // `quiet`: no console line per request; `baseUrl`: the handlers' paths are relative.
      const response = await getResponse(handlers, request, { quiet: true, baseUrl: new URL(request.url).origin });
      return response ?? Response.json({ error: 'not_found' }, { status: 404 });
    },
  };
}

const isApiPath = (url: string | undefined): url is string => url !== undefined && /^\/api(?:[/?]|$)/.test(url);

function toHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    // HTTP/2 pseudo-headers (`:path`) aren't headers a Request can carry.
    if (name.startsWith(':') || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Answers `req` from `api`, streaming the body as it comes and stopping when the browser goes. */
async function answer(api: MockApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gone = new AbortController();
  res.on('close', () => gone.abort());
  const method = req.method ?? 'GET';
  const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
    method,
    headers: toHeaders(req.headers),
    body: method === 'GET' || method === 'HEAD' ? null : await readBody(req),
    signal: gone.signal,
  });
  const response = await api.handle(request);
  // A connection dropped with no answer (a planted network fault) drops this one too.
  if (response.type === 'error') {
    res.destroy();
    return;
  }
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  if (response.body === null) {
    res.end();
    return;
  }
  // An event stream's headers go out at once, before its first event.
  res.flushHeaders();
  const reader = response.body.getReader();
  gone.signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined));
  for (;;) {
    const { value, done } = await reader.read();
    if (done || res.destroyed) break;
    res.write(value);
  }
  res.end();
}

/**
 * The dev-only plugin: every `/api/` request on the dev server goes to one mock API, and nothing
 * is forwarded to the API's port. A failure answers 500 with no detail, never a page.
 */
export function mockApiPlugin(): Plugin {
  return {
    name: 'claude-desk-mock-api',
    apply: 'serve',
    configureServer(server) {
      const api = createMockApi();
      server.middlewares.use((req, res, next) => {
        if (!isApiPath(req.url)) {
          next();
          return;
        }
        answer(api, req, res).catch((error: unknown) => {
          server.config.logger.error(`mock API: ${req.method ?? ''} ${req.url ?? ''} failed: ${String(error)}`);
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'internal' }));
        });
      });
    },
  };
}
