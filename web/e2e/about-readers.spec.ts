/**
 * The About this prototype reading pages end to end, on the dev server's shared mock (`npm run e2e:mock`): opened
 * from the owner sidebar of a fresh copy and left by the way back to Today; opened cold in a browser that has
 * stored nothing; and both pages at the desktop and phone sizes, for a stranger with no cookie and for an owner
 * signed in to a copy, fitting the window and passing axe. Expected words are written out here, never read from
 * the app's code.
 */
import { expect, test, type Page } from '@playwright/test';

import { expectNoAxeViolations, startCopy } from './helpers.ts';

/** The mock takes any passcode but "wrong". */
const MOCK_PASSCODE = 'mock-demo';

const PAGES = [
  { path: '/about/proposal', title: 'Product proposal' },
  { path: '/about/prediction', title: 'Capability prediction' },
] as const;

/** A first visit to a reading page loads its code on demand, which the dev server builds the first time it is asked. */
const FIRST_DRAW = { timeout: 30_000 };

/** The sizes every reading page is checked at. */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'live', 'The reading pages are checked on the mock; the live project runs the demo path.');
});

/** The page's level-one heading, the document's title. */
function title(page: Page, name: string) {
  return page.getByRole('heading', { level: 1, name, exact: true });
}

/**
 * Opens both reading pages at both sizes, first for a stranger with no cookie, then for an owner signed in to a
 * fresh copy, and runs `check` on each once it has drawn, with a name for where it is.
 */
async function eachPage(page: Page, check: (where: string) => Promise<void>): Promise<void> {
  for (const signedIn of [false, true]) {
    if (signedIn) {
      // A copy starts from Today at the desktop size, whose right column holds the public page's link.
      await page.setViewportSize(VIEWPORTS.desktop);
      await startCopy(page, MOCK_PASSCODE);
    }
    expect((await page.context().cookies()).length > 0, signedIn ? 'signed in' : 'no cookie').toBe(signedIn);
    const back = signedIn ? 'Back to your Desk' : 'Back to the prototype';
    for (const [size, viewport] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(viewport);
      for (const { path, title: name } of PAGES) {
        const where = `${path} at ${size}, ${signedIn ? 'signed in' : 'no cookie'}`;
        await page.goto(path);
        await expect(title(page, name), where).toBeVisible(FIRST_DRAW);
        await expect(page.getByRole('link', { name: back, exact: true }), where).toBeVisible();
        // The reading type is a web font: the page is measured as it settles, not in the fallback.
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await check(where);
      }
    }
  }
}

/**
 * The page fits the window: it doesn't scroll sideways, nothing visible reaches past either edge, nothing cuts
 * off or scrolls its own content sideways, and nothing hides content below its own bottom edge. Visually hidden
 * text, which is clipped on purpose, is left out.
 */
async function expectFits(page: Page, where: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const width = window.innerWidth;
    const found: string[] = [];
    const name = (el: Element) => [el.localName, ...(el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)].join('.');
    const pageWidth = document.documentElement.scrollWidth;
    if (pageWidth > width) found.push(`the page is ${pageWidth} px wide in a ${width} px window`);
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('.cd-sr-only') || !el.checkVisibility()) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.left < -0.5 || box.right > width + 0.5) found.push(`${name(el)} runs from ${Math.round(box.left)} to ${Math.round(box.right)} px`);
      if (!(el instanceof HTMLElement)) continue;
      const { overflowX, overflowY } = getComputedStyle(el);
      if (overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
        found.push(`${name(el)} cuts off its content: ${el.scrollWidth} px in ${el.clientWidth} px`);
      }
      // Content taller than its box, where the box hides the rest rather than scrolling to it.
      if ((overflowY === 'hidden' || overflowY === 'clip') && el.scrollHeight > el.clientHeight + 1) {
        found.push(`${name(el)} cuts off its content vertically: ${el.scrollHeight} px in ${el.clientHeight} px`);
      }
    }
    return found;
  });
  expect(problems, where).toEqual([]);
}

test('open_a_document_from_the_sidebar', async ({ page }) => {
  const { deskId } = await startCopy(page, MOCK_PASSCODE);
  const today = `/app/${encodeURIComponent(deskId)}/today`;
  // Set once on Today: a full page load would clear it, so it is still there at the end only if every move below
  // stayed in the app.
  await page.evaluate(() => {
    (window as Window & { aboutStayedInTheApp?: boolean }).aboutStayedInTheApp = true;
  });

  // The sidebar's group opens the proposal, whose way back is to this Desk.
  const about = page.getByRole('navigation', { name: 'About this prototype' });
  await expect(about).toBeVisible();
  await about.getByRole('link', { name: 'Product proposal', exact: true }).click();
  await page.waitForURL('**/about/proposal');
  await expect(title(page, 'Product proposal')).toBeVisible(FIRST_DRAW);
  const back = page.getByRole('link', { name: 'Back to your Desk', exact: true });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', today);

  // The top bar's link switches to the prediction.
  const documents = page.getByRole('navigation', { name: 'Documents' });
  await expect(documents.getByRole('link', { name: 'Product proposal', exact: true })).toHaveAttribute('aria-current', 'page');
  await documents.getByRole('link', { name: 'Capability prediction', exact: true }).click();
  await page.waitForURL('**/about/prediction');
  await expect(title(page, 'Capability prediction')).toBeVisible();
  await expect(documents.getByRole('link', { name: 'Capability prediction', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(back).toHaveAttribute('href', today);

  // The way back returns to Today.
  await back.click();
  await page.waitForURL(`**${today}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Maria$/ })).toBeVisible();
  await expect(about).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { aboutStayedInTheApp?: boolean }).aboutStayedInTheApp), 'no move reloaded the page').toBe(true);
});

test('about_pages_on_a_cold_load', async ({ page, context }) => {
  // A browser that has never opened the prototype: no cookie, and nothing in its storage.
  expect(await context.cookies(), 'no cookie').toEqual([]);
  const api: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
  });

  for (const { path, title: name } of PAGES) {
    await page.goto(path);
    await expect(title(page, name), path).toBeVisible(FIRST_DRAW);
    expect(await page.evaluate(() => localStorage.length), `${path}: nothing stored`).toBe(0);
    // With no Desk opened in this browser, the way back is to the start of the prototype.
    const back = page.getByRole('link', { name: 'Back to the prototype', exact: true });
    await expect(back, path).toBeVisible();
    await expect(back, path).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'Back to your Desk', exact: true }), path).toHaveCount(0);
    await expect(page, path).toHaveTitle(`${name} · Claude Desk`);
    await expect(page.locator('meta[name="robots"]'), path).toHaveAttribute('content', 'noindex');
  }
  // The pages are static: nothing asked the API, on the way in or while they were open.
  expect(api, 'requests to the API').toEqual([]);

  // The way back opens the first visit's intro dialog.
  await page.getByRole('link', { name: 'Back to the prototype', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('dialog', { name: 'A Claude front desk for your business' })).toBeVisible();
});

test('about_pages_fit_phone_width', async ({ page }) => {
  await eachPage(page, (where) => expectFits(page, where));
});

test('about_pages_pass_axe', async ({ page }) => {
  // Axe reads every node of a long document, eight times.
  test.setTimeout(120_000);
  await eachPage(page, (where) => expectNoAxeViolations(page, where));
});
