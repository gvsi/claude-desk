/**
 * The screen tests' mock API: a service worker in the test's one page, over `mockStore`, which
 * keeps that page's one copy and its cookies. Its script is served from `mock-public/` in mode
 * `test` only, so no build carries it. `npm run dev:mock` doesn't use it: there the dev server
 * answers `/api/` for every tab of the browser (devServer.ts).
 */
import { setupWorker } from 'msw/browser';

import { createHandlers } from './handlers.ts';
import { mockStore } from './store.ts';

export const worker = setupWorker(...createHandlers(mockStore));
