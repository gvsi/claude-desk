import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end runs of the demo path (e2e/), in Chromium at the desktop size:
 * - `mock` (`npm run e2e:mock`): the dev server in mode `mock` on port 5373, which serves the mock
 *   API once for every tab of the browser, so the public page in a new tab and Today share one copy.
 * - `live` (`npm run e2e:live`): the web app at `DESK_WEB_BASE_URL` on a running kernel and API,
 *   with `DESK_PASSCODE`; skipped with a message while either is unset. It keeps no trace, screenshot
 *   or video, any of which would hold the passcode it types. What keeps the passcode out of a failed
 *   run's errors is how `startCopy` (e2e/helpers.ts) types it; this file only keeps the page snapshot
 *   out of the error context.
 * The reporter is `list`, which prints none of Playwright's own steps. Those steps name what was
 *   typed (`Insert "…"`), and the HTML and blob reporters keep them, so a live run with either would
 *   write the passcode.
 * Nothing is retried: a failure is reported once.
 */
const MOCK_PORT = 5373;

/** The projects this run asks for with `--project`; none means every project. */
function askedProjects(argv: readonly string[]): string[] {
  return argv.flatMap((arg, i) => {
    if (arg === '--project') return argv[i + 1] === undefined ? [] : [argv[i + 1] as string];
    return arg.startsWith('--project=') ? [arg.slice('--project='.length)] : [];
  });
}

const asked = askedProjects(process.argv);
const runsMock = asked.length === 0 || asked.includes('mock');

// A failed test's error context (error-context.md) holds an accessibility snapshot of the page,
// input values included, which while the intro dialog is open would be the passcode. With a real
// passcode in the environment, Playwright (pinned at 1.64.0) leaves that snapshot out. It doesn't
// cover a failing locator expect that finds nothing, whose error carries its own snapshot of the
// page into that file whatever this says: `startCopy` runs no expect while the field holds the passcode.
// Set here, in every process that loads this config, the workers included.
if (process.env.DESK_PASSCODE) process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // Dark, the base theme the signed boards draw: the browser would otherwise prefer light and turn
  // on the light theme.
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  projects: [
    {
      name: 'mock',
      use: { baseURL: `http://localhost:${MOCK_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    },
    {
      name: 'live',
      use: { baseURL: process.env.DESK_WEB_BASE_URL, trace: 'off', screenshot: 'off', video: 'off' },
    },
  ],
  // The mock's dev server, started for the mock project only; a server already on the port is an
  // error rather than reused, since it may be another checkout's.
  webServer: runsMock
    ? {
        command: `npm run dev:mock -- --port ${MOCK_PORT} --strictPort`,
        url: `http://localhost:${MOCK_PORT}/`,
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
});
