/**
 * The About reading pages' history while the page itself is moving the window, on the dev server's shared mock
 * (`npm run e2e:mock`). Kept apart from about-readers.spec.ts because it records no trace: the runner's trace
 * recording stops a glide at Back by itself, which would hide what this checks.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ trace: 'off', screenshot: 'off' });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'live', 'The reading pages are checked on the mock; the live project runs the demo path.');
});

/** A first visit to a reading page loads its code on demand, which the dev server builds the first time it is asked. */
const FIRST_DRAW = { timeout: 30_000 };

/** Scrolls the window to `y`, as a reader would, and waits for the scroll to land. */
async function scrollWindow(page: Page, y: number): Promise<void> {
  await page.evaluate(async (to) => {
    const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
    window.scrollTo(0, to);
    await scrolled;
  }, y);
}

test('back_during_a_contents_glide_returns_to_the_readers_place', async ({ page }) => {
  // Part way down the prediction, the reader follows "Readiness" and goes Back while the page is still gliding there:
  // the window returns to where they were, and doesn't go on to the section the address no longer names.
  await page.goto('/about/prediction');
  await expect(page.getByRole('heading', { level: 1, name: 'Capability prediction', exact: true })).toBeVisible(FIRST_DRAW);
  await page.evaluate(() => document.fonts.ready);
  await scrollWindow(page, 1800);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await page.evaluate(() => window.scrollY);
  // Clicked where it is: Playwright's own click may scroll the pinned list's link into view first.
  await page.evaluate(() => document.querySelector<HTMLElement>('nav[aria-label="On this page"] a[href="#readiness"]')?.click());
  await page.waitForFunction((from) => window.scrollY > from + 2, before, { polling: 'raf' });
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/about/prediction' && url.hash === '');
  // Past when the glide would have arrived, the window is where the reader was, give or take the line the glide had
  // already moved.
  await page.waitForTimeout(1200);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before), 'back during the glide').toBeLessThanOrEqual(56);
});
