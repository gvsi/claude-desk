import { http } from 'msw';
import { onTestFinished } from 'vitest';

import { worker } from '../mocks/browser.ts';

/**
 * Holds every read of `path` until the test lets them through to the mock: `held()` counts the
 * reads waiting, and `release()`, or the test's end, sends them on.
 */
export function holdReads(path: string): { held: () => number; release: () => void } {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  worker.use(
    http.get(path, async () => {
      waiting += 1;
      await released;
      return undefined;
    }),
  );
  return { held: () => waiting, release };
}
