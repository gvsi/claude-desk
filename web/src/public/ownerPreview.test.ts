import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished, vi } from 'vitest';

import { observeRequests, type RequestOutcome } from '../api/http.ts';
import { useOwnerPreviewBack, type OwnerPreviewBack } from './ownerPreview.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('reopening_preview_does_not_reuse_an_owner_read_from_before_leaving', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.createElement('div'));
  const outcomes: RequestOutcome[] = [];
  const stop = observeRequests((outcome) => outcomes.push(outcome));
  onTestFinished(async () => {
    await act(async () => root.unmount());
    client.clear();
    stop();
    vi.unstubAllGlobals();
  });

  let release!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>()
    .mockImplementationOnce((_url, init) => new Promise<Response>((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }))
    .mockImplementation(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  let view: OwnerPreviewBack | undefined;
  function Preview() {
    view = useOwnerPreviewBack('turner-plumbing', 'desk-turner');
    return null;
  }
  const draw = async (open: boolean) => act(async () => {
    root.render(createElement(QueryClientProvider, { client }, open ? createElement(Preview) : null));
  });

  await draw(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(view).toEqual({ settled: false, href: null });
  await draw(false);
  // Closing the read is silent: it cannot raise a network error notice.
  expect(outcomes).toEqual([]);
  await draw(true);
  await act(async () => {
    release(Response.json({ desks: [{ desk_id: 'desk-turner', slug: 'turner-plumbing' }] }));
  });
  // TanStack tells the hook on a tick of its own after the read ends, so wait for the view itself,
  // letting React draw each time, not only for the read to end.
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(view).toEqual({ settled: true, href: null });
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(outcomes.filter((outcome) => !outcome.ok && outcome.error.kind === 'network')).toEqual([]);
});
