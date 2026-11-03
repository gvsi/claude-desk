/**
 * The About this prototype reading pages end to end, on the dev server's shared mock (`npm run e2e:mock`): opened
 * from the owner sidebar of a fresh copy and left by the link back to Today; opened cold in a browser that has
 * stored nothing; reached by Back and Forward at the reader's place; and both pages at the desktop and phone
 * sizes, for a stranger with no cookie and for an owner signed in to a copy, fitting the window and passing axe
 * once their figures rest.
 * Expected words are written out here, never read from the app's code.
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
 * Brings the page to rest: each figure that plays once and hasn't yet (`data-play="ready"`) is brought into view,
 * as a reader scrolling to it would, and plays; then nothing on the page is still animating. The browser runs
 * with motion, so a check reads the page as it rests, not part way through a figure's first play.
 */
async function untilAtRest(page: Page, where: string): Promise<void> {
  const unplayed = page.locator('[data-play="ready"]');
  for (let left = await unplayed.count(); left > 0; left = await unplayed.count()) {
    await unplayed.first().evaluate((figure) => figure.scrollIntoView({ block: 'center' }));
    await expect(unplayed, `${where}: a figure played in view`).toHaveCount(left - 1);
  }
  await expect.poll(() => page.evaluate(() => document.getAnimations().length), { message: `${where}: nothing animates` }).toBe(0);
}

/**
 * Opens both reading pages at both sizes, first for a stranger with no cookie, then for an owner signed in to a
 * fresh copy, and runs `check` on each once it has drawn and come to rest, with a name for where it is.
 */
async function eachPage(page: Page, check: (where: string) => Promise<void>): Promise<void> {
  for (const signedIn of [false, true]) {
    if (signedIn) {
      // A copy starts from Today at the desktop size, whose right column holds the public page's link.
      await page.setViewportSize(VIEWPORTS.desktop);
      await startCopy(page, MOCK_PASSCODE);
    }
    expect((await page.context().cookies()).length > 0, signedIn ? 'signed in' : 'no cookie').toBe(signedIn);
    for (const [size, viewport] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(viewport);
      for (const { path, title: name } of PAGES) {
        const where = `${path} at ${size}, ${signedIn ? 'signed in' : 'no cookie'}`;
        await page.goto(path);
        await expect(title(page, name), where).toBeVisible(FIRST_DRAW);
        await expect(page.getByRole('link', { name: 'Try Desk prototype', exact: true }), where).toBeVisible();
        // The reading type is a web font: the page is measured as it settles, not in the fallback.
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await untilAtRest(page, where);
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

  // The sidebar's group lists the prediction first, then the proposal and the Vision article, and opens the
  // proposal, whose link into the prototype goes back to this Desk.
  const about = page.getByRole('navigation', { name: 'About this prototype' });
  await expect(about).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main', exact: true }).locator('.cd-sidebar__label')).toHaveText([
    'Today', 'Conversations', 'Rules', 'Safety', 'Notifications', 'Customers', 'Profile', 'Share', 'Knowledge', 'Settings',
  ]);
  const github = about.getByRole('link', { name: 'GitHub (opens in a new tab)', exact: true });
  await expect(github).toHaveAttribute('target', '_blank');
  await expect(github).toHaveAttribute('rel', 'noreferrer');
  await expect(github).toHaveAttribute('href', 'https://github.com/gvsi/claude-desk');
  await expect(about.getByRole('link')).toHaveText(['Capability prediction', 'Product proposal', 'Vision', 'GitHub']);
  await about.getByRole('link', { name: 'Product proposal', exact: true }).click();
  await page.waitForURL('**/about/proposal');
  await expect(title(page, 'Product proposal')).toBeVisible(FIRST_DRAW);
  const back = page.getByRole('link', { name: 'Try Desk prototype', exact: true });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', today);

  // The top bar's link switches to the prediction.
  const documents = page.getByRole('navigation', { name: 'About this prototype' });
  await expect(documents.getByRole('link', { name: 'Product proposal', exact: true })).toHaveAttribute('aria-current', 'page');
  await documents.getByRole('link', { name: 'Capability prediction', exact: true }).click();
  await page.waitForURL('**/about/prediction');
  await expect(title(page, 'Capability prediction')).toBeVisible();
  await expect(documents.getByRole('link', { name: 'Capability prediction', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(back).toHaveAttribute('href', today);

  // The link into the prototype returns to Today.
  await back.click();
  await page.waitForURL(`**${today}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Mike$/ })).toBeVisible();
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
    // With no Desk opened in this browser, the link into the prototype goes to its start.
    const back = page.getByRole('link', { name: 'Try Desk prototype', exact: true });
    await expect(back, path).toBeVisible();
    await expect(back, path).toHaveAttribute('href', '/');
    await expect(page, path).toHaveTitle(`${name} · Claude Desk`);
    await expect(page.locator('meta[name="robots"]'), path).toHaveAttribute('content', 'noindex');
  }
  // The pages are static: nothing asked the API, on the way in or while they were open.
  expect(api, 'requests to the API').toEqual([]);

  // It opens the first visit's intro dialog.
  await page.getByRole('link', { name: 'Try Desk prototype', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('dialog', { name: 'A Claude front desk for your business' })).toBeVisible();
});

/** Scrolls the window to `y`, as a reader would, and waits for the scroll to land. */
async function scrollWindow(page: Page, y: number): Promise<void> {
  await page.evaluate(async (to) => {
    const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
    window.scrollTo(0, to);
    await scrolled;
  }, y);
}

function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

/** The window's offset once a scroll has landed: two frames on, its scroll event has fired. */
function settledScrollY(page: Page): Promise<number> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return window.scrollY;
  });
}

/**
 * Waits for the window to be back at `place`, give or take two lines of text: the browser's own restoring and
 * its scroll anchoring may nudge it as the page draws.
 */
async function expectBackAt(page: Page, place: number, where: string): Promise<void> {
  await expect.poll(async () => Math.abs((await scrollY(page)) - place), where).toBeLessThanOrEqual(56);
}

test('going_back_returns_to_the_readers_place', async ({ page }) => {
  // Loaded at a section's address, a page opens at that section, though the router counts a load as a move back. The
  // reading type's font files are held back until it has, so the type swaps in after the page opened there, as on a
  // slow cold load; once the type has loaded, the section is still at its place.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://fonts.gstatic.com/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/about/prediction#how-its-measured');
  await expect(title(page, 'Capability prediction')).toBeVisible(FIRST_DRAW);
  const atSection = () =>
    page.evaluate(() => {
      const section = document.getElementById('how-its-measured');
      if (!section) return false;
      return Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)) <= 1;
    });
  await expect.poll(() => page.evaluate(() => document.fonts.status), 'the type is still loading').toBe('loading');
  await expect.poll(atSection, 'opened at its section').toBe(true);
  release();
  await expect.poll(() => page.evaluate(() => document.fonts.status), 'the type has loaded').toBe('loaded');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(atSection, 'still at its section once the type has loaded').toBe(true);

  // The proposal opens at its top, and so does the prediction from the proposal's link part way down. Back and
  // Forward return to where the reader was in each.
  await page.getByRole('navigation', { name: 'About this prototype' }).getByRole('link', { name: 'Product proposal', exact: true }).click();
  await expect(title(page, 'Product proposal')).toBeVisible();
  expect(await scrollY(page), 'opened').toBe(0);
  const inText = page.locator('article').getByRole('link', { name: 'capability prediction', exact: true });
  await inText.scrollIntoViewIfNeeded();
  const atLink = await settledScrollY(page);
  expect(atLink, 'the link is part way down').toBeGreaterThan(0);
  // Clicked where it is: Playwright's own click may scroll the link again first, which moves the reader's place.
  await inText.evaluate((link: HTMLElement) => link.click());
  await expect(title(page, 'Capability prediction')).toBeVisible();
  expect(await scrollY(page), 'opened from the link').toBe(0);
  await scrollWindow(page, 3000);
  await page.goBack();
  await expect(title(page, 'Product proposal')).toBeVisible();
  await expectBackAt(page, atLink, 'back');
  await page.goForward();
  await expect(title(page, 'Capability prediction')).toBeVisible();
  await expectBackAt(page, 3000, 'forward');

  // An owner who opens a page from the Desk, goes back to the Desk and forward again is where they were.
  await startCopy(page, MOCK_PASSCODE);
  await page.getByRole('navigation', { name: 'About this prototype' }).getByRole('link', { name: 'Product proposal', exact: true }).click();
  await expect(title(page, 'Product proposal')).toBeVisible(FIRST_DRAW);
  expect(await scrollY(page), 'opened from the sidebar').toBe(0);
  await scrollWindow(page, 4000);
  await page.goBack();
  await page.waitForURL(/\/today$/);
  await page.goForward();
  await expect(title(page, 'Product proposal')).toBeVisible();
  await expectBackAt(page, 4000, 'forward from the Desk');
});

test('back_from_a_contents_link_returns_to_the_readers_place', async ({ page }) => {
  // Part way down the prediction, the reader follows "Why the limits stay in code" in the contents list: the page moves there,
  // gliding unless the reader asked for reduced motion, and the address names it. Back returns to where they were,
  // and Forward to the section.
  const atLimits = () =>
    page.evaluate(() => {
      const section = document.getElementById('why-the-limits-stay-in-code');
      if (!section) return false;
      return Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)) <= 1;
    });
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/about/prediction');
    await expect(title(page, 'Capability prediction'), reducedMotion).toBeVisible(FIRST_DRAW);
    // The reading type and the figures settle first, so the place taken below is the page as it rests: a type swap
    // after it would move the text above it, and the browser's scroll anchoring would move the window with it.
    await expect.poll(() => page.evaluate(() => document.fonts.status), `${reducedMotion}: the type has loaded`).toBe('loaded');
    await untilAtRest(page, reducedMotion);
    await scrollWindow(page, 1800);
    const before = await settledScrollY(page);

    const contents = page.getByRole('navigation', { name: 'On this page' });
    // Clicked where it is: Playwright's own click may scroll the pinned list's link into view first, which moves the
    // reader's place.
    await contents.getByRole('link', { name: 'Why the limits stay in code', exact: true }).evaluate((link: HTMLElement) => link.click());
    await page.waitForURL('**/about/prediction#why-the-limits-stay-in-code');
    await expect.poll(atLimits, `${reducedMotion}: followed`).toBe(true);
    await expect(page.locator('#why-the-limits-stay-in-code'), `${reducedMotion}: focus on the section`).toBeFocused();
    await expect(contents.getByRole('link', { name: 'Why the limits stay in code', exact: true })).toHaveAttribute('aria-current', 'location');

    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/about/prediction' && url.hash === '');
    await expectBackAt(page, before, `${reducedMotion}: back`);
    await page.goForward();
    await page.waitForURL('**/about/prediction#why-the-limits-stay-in-code');
    await expect.poll(atLimits, `${reducedMotion}: forward`).toBe(true);
  }
});

test('vision_contents_links_move_to_their_section_and_back_returns', async ({ page }) => {
  // The Vision article lists its sections under "On this page" as the reading pages do: beside the article at a
  // laptop's width, folded at the top on a phone. Part way down, the reader follows "What stays the same": the page
  // moves there and the address names it. Back returns to where they were, and Forward to the section.
  const atSection = () =>
    page.evaluate(() => {
      const section = document.getElementById('what-stays-the-same');
      if (!section) return false;
      return Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)) <= 1;
    });
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(viewport);
    await page.goto('/about/vision');
    await expect(title(page, 'A front desk that never closes'), size).toBeVisible(FIRST_DRAW);
    await expect.poll(() => page.evaluate(() => document.fonts.status), `${size}: the type has loaded`).toBe('loaded');
    await scrollWindow(page, 1800);
    const before = await settledScrollY(page);

    const contents = page.getByRole('navigation', { name: 'On this page' });
    if (size === 'phone') {
      // Folded into one row, which opens. Opening it at the top of the article brings it into view.
      await contents.getByText('On this page', { exact: false }).click();
    }
    const link = contents.getByRole('link', { name: 'What stays the same', exact: true });
    await expect(link, size).toBeVisible();
    const from = size === 'phone' ? await settledScrollY(page) : before;
    // Clicked where it is: Playwright's own click may scroll the pinned list's link into view first.
    await link.evaluate((el: HTMLElement) => el.click());
    await page.waitForURL('**/about/vision#what-stays-the-same');
    await expect.poll(atSection, `${size}: followed`).toBe(true);
    await expect(page.locator('#what-stays-the-same'), `${size}: focus on the section`).toBeFocused();
    if (size === 'desktop') await expect(link).toHaveAttribute('aria-current', 'location');

    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/about/vision' && url.hash === '');
    await expectBackAt(page, from, `${size}: back`);
    await page.goForward();
    await page.waitForURL('**/about/vision#what-stays-the-same');
    await expect.poll(atSection, `${size}: forward`).toBe(true);
  }
});

test('back_before_the_type_loads_keeps_the_readers_place', async ({ page }) => {
  // The reading type's font files are held back, so the type is still loading when the reader follows "Why the limits stay in code"
  // and presses Back. Once it loads, the window stays where Back put it rather than going back to the section.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://fonts.gstatic.com/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/about/prediction');
  await expect(title(page, 'Capability prediction')).toBeVisible(FIRST_DRAW);
  await expect.poll(() => page.evaluate(() => document.fonts.status), 'the type is still loading').toBe('loading');
  await scrollWindow(page, 1800);
  const before = await settledScrollY(page);

  const contents = page.getByRole('navigation', { name: 'On this page' });
  // Clicked where it is: Playwright's own click may scroll the pinned list's link into view first, which moves the
  // reader's place.
  await contents.getByRole('link', { name: 'Why the limits stay in code', exact: true }).evaluate((link: HTMLElement) => link.click());
  await page.waitForURL('**/about/prediction#why-the-limits-stay-in-code');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const section = document.getElementById('why-the-limits-stay-in-code');
        return section ? Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)) : 1e9;
      }),
    )
    .toBeLessThanOrEqual(1);

  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/about/prediction' && url.hash === '');
  await expectBackAt(page, before, 'back');
  // When the type swaps in, the text reflows and the browser's scroll anchoring moves the window with the text above
  // the reader's place, by at most how much the page's height changes. Anything more would be the page moving the
  // reader, such as back to the section the address named.
  const atBack = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }));
  release();
  await expect.poll(() => page.evaluate(() => document.fonts.status), 'the type has loaded').toBe('loaded');
  await page.waitForTimeout(500);
  const afterType = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }));
  expect(Math.abs(afterType.y - atBack.y), "after the type loaded, the window moved only with the text's reflow").toBeLessThanOrEqual(
    Math.abs(afterType.height - atBack.height) + 56,
  );
  expect(
    await page.evaluate(() => {
      const section = document.getElementById('why-the-limits-stay-in-code');
      return section ? Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)) : 0;
    }),
    'not back at the section',
  ).toBeGreaterThan(56);
});

test('about_pages_print_without_the_pinned_bar', async ({ page }) => {
  // On screen the top bar stays while the page scrolls; on paper it is the page's first line.
  await page.goto('/about/proposal');
  await expect(title(page, 'Product proposal')).toBeVisible(FIRST_DRAW);
  const bar = page.locator('header.cd-about-top');
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
  await page.emulateMedia({ media: 'print' });
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('static');
});

test('an_unplayed_chart_prints_complete', async ({ page }) => {
  // Opened at a section past the chart, which hasn't been in view, so it waits to play.
  await page.goto('/about/prediction#why-the-limits-stay-in-code');
  await expect(title(page, 'Capability prediction')).toBeVisible(FIRST_DRAW);
  const chart = page.locator('figure.cd-about-chart');
  await expect(chart).toHaveAttribute('data-play', 'ready');
  expect(await chart.evaluate((figure) => figure.getBoundingClientRect().bottom), 'above the window').toBeLessThanOrEqual(0);

  // On paper it is drawn complete: every part shows, none scaled or cut off.
  await page.emulateMedia({ media: 'print' });
  const unfinished = await chart.evaluate((figure) =>
    [...figure.querySelectorAll('svg *:not(title)')].flatMap((part) => {
      const style = getComputedStyle(part);
      const where = `${part.localName} (${part.getAttribute('data-tau3-part') ?? ''})`;
      return [
        part.checkVisibility() ? null : 'not visible',
        style.opacity === '1' ? null : `opacity ${style.opacity}`,
        style.transform === 'none' ? null : `transform ${style.transform}`,
        style.clipPath === 'none' ? null : `clip-path ${style.clipPath}`,
      ].flatMap((what) => (what === null ? [] : [`${where}: ${what}`]));
    }),
  );
  expect(unfinished, 'printed').toEqual([]);
});

test('about_pages_fit_phone_width', async ({ page }) => {
  await eachPage(page, (where) => expectFits(page, where));
});

test('about_pages_pass_axe', async ({ page }) => {
  // Axe reads every node of a long document, eight times.
  test.setTimeout(120_000);
  await eachPage(page, (where) => expectNoAxeViolations(page, where));
});
