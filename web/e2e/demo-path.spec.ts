/**
 * The demo path a first visitor walks, end to end in one browser: on the dev server's shared mock
 * (`npm run e2e:mock`), and on a running kernel and API (`npm run e2e:live`, with
 * `DESK_WEB_BASE_URL` and `DESK_PASSCODE` set, as the deploy's smoke checks read them).
 */
import { inspect } from 'node:util';

import { expect, test } from '@playwright/test';

import { demoPath, startCopy } from './helpers.ts';

/** The mock takes any passcode but "wrong". */
const MOCK_PASSCODE = 'mock-demo';

const LIVE_UNSET = 'Skipped: the live demo path needs DESK_WEB_BASE_URL (the web app on a running API) and DESK_PASSCODE in the environment.';

test('demo_path', async ({ page }, testInfo) => {
  const live = testInfo.project.name === 'live';
  if (live) {
    const unset = !process.env.DESK_WEB_BASE_URL || !process.env.DESK_PASSCODE;
    // Said in the run's output too, which doesn't show a skip's reason.
    if (unset) console.warn(LIVE_UNSET);
    test.skip(unset, LIVE_UNSET);
    test.setTimeout(5 * 60_000);
  }
  await demoPath(page, { passcode: live ? (process.env.DESK_PASSCODE ?? '') : MOCK_PASSCODE, live });
});

/** Stands in for a real passcode: it must show in no error of a failed start. */
const STAND_IN_PASSCODE = 'stand-in-passcode-4Kq9';

test.describe('the passcode', () => {
  // A stuck action fails in seconds rather than at the test's timeout, so its error can be read.
  test.use({ actionTimeout: 5_000 });

  test('passcode_is_never_printed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'live', 'Checked on the mock: the live project types the real passcode.');
    // The intro dialog's passcode field can't be typed in, so the start fails at the field.
    await page.addInitScript(() => {
      const lock = () => {
        for (const input of document.querySelectorAll('input[type="password"]')) (input as HTMLInputElement).disabled = true;
      };
      new MutationObserver(lock).observe(document, { childList: true, subtree: true });
    });
    const failure: unknown = await startCopy(page, STAND_IN_PASSCODE).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure, 'a locked passcode field fails the start').not.toBeNull();
    // Everything the failure carries, its call log and any page snapshot included.
    expect(inspect(failure, { depth: 8 })).not.toContain(STAND_IN_PASSCODE);
  });
});
