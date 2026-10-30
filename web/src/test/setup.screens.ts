/**
 * Setup for the `screens` project: the app's styles, as `main.tsx` loads them; the mock API's
 * service worker, started once; a fresh Rivera copy before every test; and after it, a clean
 * slate (the app unmounted, handlers a test added dropped, poll intervals at real time, the
 * browser's own languages) and no request to an `/api/` path the mock doesn't serve, unless the
 * test took it as expected with `mockStore.takeUnhandled`.
 */
import { afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { cleanup } from 'vitest-browser-react';

import { setPollScale } from '../app/poll.ts';
import { worker } from '../mocks/browser.ts';
import { mockStore } from '../mocks/store.ts';
import { resetBrowserLanguage } from './renderRoute.tsx';

import '../ds/tokens.css';
import '../ds/base.css';

let started: Promise<unknown> | null = null;

beforeAll(async () => {
  started ??= worker.start({ quiet: true, onUnhandledFrame: 'bypass' });
  await started;
});

beforeEach(() => {
  mockStore.reset('rivera');
});

afterEach(async () => {
  await cleanup();
  worker.resetHandlers();
  setPollScale(1);
  resetBrowserLanguage();
  expect(mockStore.unhandled, 'requests to /api/ paths the mock API does not serve').toEqual([]);
});
