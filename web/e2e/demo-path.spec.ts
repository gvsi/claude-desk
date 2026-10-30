/**
 * The demo path a first visitor walks, end to end in one browser: on the dev server's shared mock
 * (`npm run e2e:mock`), and on a running kernel and API (`npm run e2e:live`, with
 * `DESK_WEB_BASE_URL` and `DESK_PASSCODE` set, as the deploy's smoke checks read them).
 */
import { test } from '@playwright/test';

import { demoPath } from './helpers.ts';

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
