/**
 * The screen tests' mock API: a service worker in the test's one page, over `mockStore`, which
 * keeps that page's one copy and its cookies. Its script is served from `mock-public/` in mode
 * `test` only, so no build carries it. `npm run dev:mock` doesn't use it: there the dev server
 * answers `/api/` for every tab of the browser (devServer.ts).
 */
import { setupWorker } from 'msw/browser';

import { EPOCH_HEADER, EPOCH_PARAM, createHandlers } from './handlers.ts';
import { mockStore } from './store.ts';

export const worker = setupWorker(...createHandlers(mockStore));

/**
 * Starts the mock over for the next screen test: a new epoch, so that whatever the last test's page
 * sent and the mock hasn't received yet is dropped when it arrives, then a fresh Rivera copy, signed in.
 */
export function startTest(): void {
  mockStore.nextEpoch();
  mockStore.reset('rivera');
}

function isApi(url: string | URL): boolean {
  const parsed = new URL(url, window.location.href);
  return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/');
}

let stamping = false;

/**
 * Stamps every `/api/` request this page sends with the epoch it is sent in, so the store can tell
 * a late one from the last test: a fetch in a header, an `EventSource` in a last query parameter
 * (the handlers take both off). Call before the first test; once is enough for the page.
 */
export function stampRequests(): void {
  if (stamping) return;
  stamping = true;
  const pageFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isApi(input instanceof Request ? input.url : input)) return pageFetch(input, init);
    const request = new Request(input, init);
    request.headers.set(EPOCH_HEADER, String(mockStore.epoch));
    return pageFetch(request);
  };
  const PageEventSource = window.EventSource;
  window.EventSource = class extends PageEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      const sent = String(url);
      super(isApi(sent) ? `${sent}${sent.includes('?') ? '&' : '?'}${EPOCH_PARAM}=${mockStore.epoch}` : url, init);
    }
  };
}
