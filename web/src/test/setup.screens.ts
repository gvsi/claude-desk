/**
 * Setup for the `screens` project: the app's styles, as `main.tsx` loads them; the mock API's
 * service worker, started once, with every fetch and EventSource request to `/api/` stamped with
 * the test it was sent in; a fresh Turner copy before every test, which none of those the last
 * test's page sent late can reach, in a browser that has had no owner's copy and has noted no
 * payment link's chat; and after it, a
 * clean slate (the app unmounted, handlers a test added dropped, poll intervals and the retry delay
 * at real time, the browser's own languages, the Connectors pages as the app has them, no rule
 * change waiting to land on Rules) and no
 * request to an `/api/` path the mock doesn't serve, unless the test took it as expected with
 * `mockStore.takeUnhandled`.
 */
// The app's styles in the app's order (main.tsx): the design system's tokens and base styles
// first, then each component's own.
import '../ds/tokens.css';
import '../ds/base.css';

import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { cleanup } from 'vitest-browser-react';

import { setPollScale, setRetryScale } from '../app/poll.ts';
import { writeLocal } from '../lib/storage.ts';
import { stampRequests, startTest, worker } from '../mocks/browser.ts';
import { mockStore } from '../mocks/store.ts';
import { CONNECTOR_PAGES_BUILT, setConnectorPagesBuilt } from '../owner/connectors/pages.ts';
import { forgetSeen } from '../owner/notifications/seen.ts';
import { resetLandings } from '../owner/rules/landing.ts';
import { resetBrowserLanguage } from './renderRoute.tsx';
import { mockDrain } from './mockDrain.ts';

let started: Promise<unknown> | null = null;

beforeAll(async () => {
  stampRequests();
  started ??= worker.start({ quiet: true, onUnhandledFrame: 'bypass' });
  await started;
});

beforeEach(() => {
  startTest();
  // Whether the intro says an owner's session ended depends on it, so no test inherits it from the last.
  writeLocal('hadOwnerCopy', null);
  // Whether a paid checkout links back to a chat depends on what chats this browser showed.
  writeLocal('payChats', null);
  // Which cookie-named chat can resume as an owner's preview depends on what this browser opened.
  writeLocal('previewSessions', null);
  // Which notifications count as unread depends on what this browser has seen.
  forgetSeen();
  // Whether a reload's loading page draws a "Not live yet" card depends on the Desks this browser saw.
  writeLocal('todaySetup', null);
});

afterEach(async () => {
  await cleanup();
  worker.resetHandlers();
  setPollScale(1);
  setRetryScale(1);
  setConnectorPagesBuilt(CONNECTOR_PAGES_BUILT);
  resetLandings();
  resetBrowserLanguage();
  expect(mockStore.unhandled, 'requests to /api/ paths the mock API does not serve').toEqual([]);
});

// Keep this page's reply channels alive until MSW has answered even requests aborted at unmount.
// A hanging handler fails its own file in ten seconds, before it can kill the shared worker.
afterAll(() => mockDrain.waitForIdle(), 15_000);
