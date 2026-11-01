// Keep real timers even in files that replace the app's clock.
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
const pending = new Map<object, string>();
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
  if (event.data?.type !== 'REQUEST') return;
  const port = event.ports[0];
  if (!port) return;
  const { method, url } = event.data.payload as { method: string; url: string };
  const finish = track(port, method, url);
  const postMessage = port.postMessage;
  port.postMessage = (...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) => {
    // Forward the exact arguments/transfer list; only mark a reply that was successfully sent.
    Reflect.apply(postMessage, port, args);
    const message = args[0] as { type?: string } | null;
    if (message?.type === 'MOCK_RESPONSE' || message?.type === 'PASSTHROUGH') {
      port.postMessage = postMessage;
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
  async waitForIdle({ timeoutMs = 5_000, quietMs = 100 } = {}): Promise<void> {
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
        reject(new Error(`requests still with the mock API when the file ended: ${requests}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  },
};
