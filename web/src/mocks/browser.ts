/**
 * The mock API's service worker, for `npm run dev:mock` and the screen tests. Its script is served
 * from `mock-public/` in those modes only, so no build carries it.
 */
import { setupWorker } from 'msw/browser';

import { handlers } from './handlers.ts';
import { mockStore } from './store.ts';

export const worker = setupWorker(...handlers);

/**
 * The dev server's mock: a fresh Rivera copy that this browser hasn't opened yet, so the first
 * screen is the passcode, as a first visit sees it. A reload starts it over.
 */
export async function startMockApi(): Promise<void> {
  mockStore.reset('rivera', { signedIn: false });
  await worker.start({ onUnhandledFrame: 'bypass' });
}
