// Keep real timers even in files that replace the app's clock.
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
const pending = new Map<object, string>();
const heldPorts = new Map<MessagePort, MessagePort['postMessage']>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function track(key: object, method: string, url: string): () => void {
  // Paths identify the culprit without including cookies, bodies or query parameters.
  pending.set(key, `${method} ${new URL(url, location.href).pathname}`);
  changed();
  return () => {
    pending.delete(key);
    changed();
  };
}

/**
 * MSW 3.0.3 omits request:end when a handler throws. Even when emitted, it can precede
 * response serialization. Observe the actual reply to REQUEST instead: browser/index.js's
 * WorkerEvent.postMessage uses this same port for both MOCK_RESPONSE and PASSTHROUGH.
 * This counts aborted requests until MSW replies, and SSE only until its response is handed
 * back (never until the stream closes). Install before worker.start(), once per file's page.
 */
navigator.serviceWorker.addEventListener('message', (event) => {
  if (!(event.source instanceof ServiceWorker) || new URL(event.source.scriptURL).pathname !== '/mockServiceWorker.js') return;
  // MSW 3.0.3 awaits replies to these messages inside event.waitUntil(), but its page code
  // never acknowledges them. Chromium kills the worker after five minutes of a pending event.
  if (['CLIENT_CLOSED', 'KEEPALIVE_RESPONSE', 'INTEGRITY_CHECK_RESPONSE', 'MOCKING_ENABLED'].includes(event.data?.type)) {
    event.ports[0]?.postMessage({});
    return;
  }
  if (event.data?.type !== 'REQUEST') return;
  const port = event.ports[0];
  if (!port) return;
  const { method, url } = event.data.payload as { method: string; url: string };
  const finish = track(port, method, url);
  const postMessage = port.postMessage;
  heldPorts.set(port, postMessage);
  port.postMessage = (...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) => {
    // Forward the exact arguments/transfer list; only mark a reply that was successfully sent.
    Reflect.apply(postMessage, port, args);
    const message = args[0] as { type?: string } | null;
    if (message?.type === 'MOCK_RESPONSE' || message?.type === 'PASSTHROUGH') {
      port.postMessage = postMessage;
      heldPorts.delete(port);
      finish();
    }
  };
}, { capture: true });

/** A file must leave its page quiet before Vitest closes it and MSW loses its reply channel. */
export const mockDrain = {
  /** Also count fetches still on their way to the worker, before its REQUEST message arrives. */
  trackFetch(request: Request): () => void {
    return track(request, request.method, request.url);
  },
  async waitForIdle({ timeoutMs = 10_000, quietMs = 100 } = {}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let quiet: number | undefined;
      const finish = () => {
        realClearTimeout(quiet);
        realClearTimeout(deadline);
        listeners.delete(check);
      };
      const check = () => {
        realClearTimeout(quiet);
        if (pending.size === 0) quiet = realSetTimeout(() => {
          finish();
          resolve();
        }, quietMs);
      };
      const deadline = realSetTimeout(() => {
        finish();
        const requests = [...new Set(pending.values())].join(', ') || '(waiting for a quiet period)';
        // Settle the worker's fetch events even when this file fails. Status zero is the
        // MOCK_RESPONSE encoding of Response.error() in MSW 3.0.3 (browser/index.js).
        for (const [port, postMessage] of heldPorts) {
          Reflect.apply(postMessage, port, [{
            type: 'MOCK_RESPONSE',
            data: { status: 0, statusText: '', headers: {}, body: null },
          }]);
          port.postMessage = postMessage;
          heldPorts.delete(port);
          pending.delete(port);
        }
        changed();
        reject(new Error(`requests still with the mock API when the file ended: ${requests}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  },
};
