import { http, HttpResponse, passthrough, sse } from 'msw';
import { expect, it, vi } from 'vitest';

import { startTest, worker } from '../mocks/browser.ts';
import { holdReads } from './holdReads.ts';
import { mockDrain } from './mockDrain.ts';

it.each(['CLIENT_CLOSED', 'KEEPALIVE_RESPONSE', 'INTEGRITY_CHECK_RESPONSE', 'MOCKING_ENABLED'])(
  'acknowledges the worker message %s', async (type) => {
    const channel = new MessageChannel();
    try {
      const reply = new Promise<unknown>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`no acknowledgement for ${type}`)), 200);
        channel.port1.onmessage = (event) => {
          clearTimeout(deadline);
          resolve(event.data);
        };
      });
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
        data: { type },
        ports: [channel.port2],
        source: navigator.serviceWorker.controller,
      }));
      await expect(reply).resolves.toEqual({});
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  },
);

it('drains an idle page after a short quiet period', async () => {
  const started = performance.now();
  await mockDrain.waitForIdle();
  expect(performance.now() - started).toBeGreaterThanOrEqual(90);
});

it('rejects at its deadline with the pending method and path', async () => {
  const held = holdReads('/api/health');
  const response = fetch('/api/health?diagnostic=private').catch((error: unknown) => error);
  await vi.waitFor(() => expect(held.held()).toBe(1));
  const draining = mockDrain.waitForIdle({ timeoutMs: 40 }).catch((error: unknown) => error);
  try {
    const error = await Promise.race([draining, new Promise((resolve) => setTimeout(resolve, 150))]);
    expect(error).toEqual(expect.objectContaining({
      message: 'requests still with the mock API when the file ended: GET /api/health',
    }));
    const outcome = await Promise.race([response, new Promise((resolve) => setTimeout(resolve, 200))]);
    expect(outcome).toBeInstanceOf(TypeError);
  } finally {
    held.release();
    await response;
    await draining;
  }
});

it('waits for a held request and a quiet period after its release', async () => {
  const held = holdReads('/api/health');
  const response = fetch('/api/health');
  await vi.waitFor(() => expect(held.held()).toBe(1));
  let drained = false;
  const draining = mockDrain.waitForIdle().then(() => { drained = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(drained).toBe(false);
  } finally {
    held.release();
    await response;
    await draining;
  }
});

it('keeps an aborted fetch pending until its held handler replies', async () => {
  const held = holdReads('/api/health');
  const controller = new AbortController();
  const response = fetch('/api/health', { signal: controller.signal }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(held.held()).toBe(1));
  controller.abort();
  await response;
  try {
    await expect(mockDrain.waitForIdle({ timeoutMs: 40 })).rejects.toThrow('GET /api/health');
  } finally {
    held.release();
    await mockDrain.waitForIdle();
  }
});

it('answers a released read after resetHandlers and the next epoch', async () => {
  const held = holdReads('/api/health');
  const response = fetch('/api/health').then((reply) => reply.status, () => 'dropped');
  await vi.waitFor(() => expect(held.held()).toBe(1));
  worker.resetHandlers();
  startTest();
  held.release();
  expect(await response).toBe('dropped');
  await mockDrain.waitForIdle();
});
it.each(['mocked', 'passthrough', 'unhandled', 'network error', 'handler exception'] as const)(
  'drains a %s response', async (outcome) => {
    // A real static path keeps passthrough/unhandled requests on Vite, away from the API proxy.
    const path = '/mockServiceWorker.js';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      if (outcome !== 'unhandled') worker.use(http.get(path, () => {
        if (outcome === 'passthrough') return passthrough();
        if (outcome === 'network error') return HttpResponse.error();
        if (outcome === 'handler exception') throw new Error('drain test handler exception');
        return HttpResponse.json({ ok: true });
      }));
      const response = fetch(path).then((reply) => reply.status, () => 'network error');
      // Start draining before the worker has even delivered REQUEST to this page.
      await mockDrain.waitForIdle();
      expect(await response).toBe(outcome === 'network error' ? 'network error' : outcome === 'handler exception' ? 500 : 200);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  },
);

it('drains an SSE response while its stream is still open', async () => {
  worker.use(sse('/api/drain-events', ({ client }) => {
    client.send({ data: 'connected' });
  }));
  const source = new EventSource('/api/drain-events');
  try {
    await new Promise<void>((resolve, reject) => {
      source.onopen = () => resolve();
      source.onerror = () => reject(new Error('mock SSE connection failed'));
    });
    await mockDrain.waitForIdle();
    expect(source.readyState).toBe(EventSource.OPEN);
  } finally {
    source.close();
  }
});
