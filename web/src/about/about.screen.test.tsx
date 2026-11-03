/**
 * The About this prototype reading pages at their own addresses, in the whole app against the mock API: each
 * page loads when its address opens, draws its document, and asks the API for nothing, for a stranger and for
 * an owner whose browser has opened a Desk. Expected words are written out here, never read from the page's
 * code.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { writeLocal } from '../lib/storage.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics, nextFrames } from '../test/screen.ts';

const PAGES = [
  { path: '/about/proposal', title: 'Product proposal' },
  { path: '/about/prediction', title: 'Capability prediction' },
] as const;

afterEach(() => {
  writeLocal('lastDesk', null);
});

describe('About pages', () => {
  it.each(['desktop', 'phone'] as const)('read_next_opens_vision_at_the_top_on_%s', async (viewport) => {
    const { screen, router } = await renderRoute('/about/proposal', { viewport, strict: true });
    await expect.element(screen.getByRole('heading', { name: 'Product proposal', exact: true })).toBeVisible();
    const next = screen.container.querySelector('[data-next-label]')?.parentElement?.querySelector('a');
    if (!next) throw new Error('no Read next');
    await userEvent.click(next);
    await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
    await expect.element(screen.getByRole('heading', { name: 'A front desk that never closes', exact: true })).toBeVisible();
    await expect.poll(() => window.scrollY).toBe(0);
    const heading = screen.container.querySelector('h1')?.getBoundingClientRect();
    expect(heading?.top).toBeGreaterThanOrEqual(0);
    expect(heading?.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it.each(['desktop', 'phone'] as const)('vision_cards_open_at_the_top_and_history_restores_the_place_on_%s', async (viewport) => {
    // Isolate the page's restoration from Chromium's anchoring when the shorter picture replaces the article.
    document.documentElement.style.overflowAnchor = 'none';
    document.body.style.overflowAnchor = 'none';
    onTestFinished(() => {
      document.documentElement.style.overflowAnchor = '';
      document.body.style.overflowAnchor = '';
    });
    const { screen, router } = await renderRoute('/about/vision', { viewport, strict: true });
    await expect.element(screen.getByRole('heading', { name: 'A front desk that never closes', exact: true })).toBeVisible();
    await document.fonts.ready;
    const scrollTo = async (top: number) => {
      const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
      window.scrollTo({ top, behavior: 'instant' });
      await scrolled;
      return window.scrollY;
    };
    const card = screen.container.querySelector<HTMLAnchorElement>('a[href="/vision/phone"]');
    if (!card) throw new Error('no phone card');
    const articlePlace = await scrollTo(card.getBoundingClientRect().top + window.scrollY - 150);
    expect(articlePlace).toBeGreaterThan(0);
    card.click();
    await expect.poll(() => router.state.location.pathname).toBe('/vision/phone');
    const bar = screen.getByRole('note', { name: 'Vision', exact: true });
    await expect.element(bar).toBeVisible();
    // The bar can be visible before StrictMode replays the opening effect, which starts this page
    // at zero again. Let that opening paint before placing the reader for the history checks.
    await nextFrames();
    await expect.poll(() => window.scrollY).toBe(0);
    const box = bar.element().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);

    const phonePlace = await scrollTo(100);
    expect(phonePlace).toBe(100);
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { name: 'A front desk that never closes', exact: true })).toBeVisible();
    await expect.poll(() => window.scrollY).toBe(articlePlace);
    await router.navigate(1);
    await expect.element(bar).toBeVisible();
    await expect.poll(() => window.scrollY).toBe(phonePlace);

    // A DOM click leaves the scroll where the reader put it, even when the bar is above the viewport.
    const back = screen.getByRole('link', { name: 'Back to Vision', exact: true }).element() as HTMLAnchorElement;
    back.click();
    await expect.poll(() => router.state.location.pathname).toBe('/about/vision');
    await expect.poll(() => window.scrollY).toBe(articlePlace);
  });

  it('about_pages_render_at_their_routes', async () => {
    writeLocal('lastDesk', null);
    // Nothing is logged on the way, such as React Router's warning, given once, for a page whose code is
    // still loading on a first visit and has nothing to show meanwhile.
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });
    for (const [i, { path, title }] of PAGES.entries()) {
      const { screen, router } = await renderRoute(path);
      // The page is drawn once its code has loaded: its title, its article and the link into the prototype.
      await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await expect.element(screen.getByRole('article')).toBeVisible();
      await expect.element(screen.getByRole('link', { name: 'Try Desk prototype', exact: true })).toHaveAttribute('href', '/');
      const documents = screen.getByRole('navigation', { name: 'About this prototype' });
      await expect.element(documents.getByRole('link', { name: title, exact: true })).toHaveAttribute('aria-current', 'page');

      // The switch opens the other page at its own address.
      const other = PAGES[1 - i];
      if (!other) throw new Error('two pages');
      await userEvent.click(documents.getByRole('link', { name: other.title, exact: true }));
      await expect.poll(() => router.state.location.pathname).toBe(other.path);
      await expect.element(screen.getByRole('heading', { level: 1, name: other.title, exact: true })).toBeVisible();
    }
    const logged = (spy: typeof warn) => spy.mock.calls.map((call) => String(call[0]));
    expect(logged(warn)).toEqual([]);
    expect(logged(error)).toEqual([]);

    // Any other address under /about is a page that doesn't exist.
    for (const path of ['/about', '/about/', '/about/proposal/more', '/about/readme']) {
      const { screen } = await renderRoute(path);
      await expect.element(screen.getByText("This page doesn't exist", { exact: true }), { message: path }).toBeVisible();
    }
  });

  it('the_about_set_reads_as_one', async () => {
    // The three About pages as one set: the same switch on each, the page on show marked; "Read next" running
    // prediction, proposal, Vision and back to the prediction; and the one link into the prototype.
    const SET = [
      {
        path: '/about/prediction',
        title: 'Capability prediction',
        heading: 'Capability prediction',
        next: { title: 'Product proposal', path: '/about/proposal' },
      },
      {
        path: '/about/proposal',
        title: 'Product proposal',
        heading: 'Product proposal',
        next: { title: 'Vision', path: '/about/vision' },
      },
      {
        path: '/about/vision',
        title: 'Vision',
        heading: 'A front desk that never closes',
        next: { title: 'Capability prediction', path: '/about/prediction' },
      },
    ] as const;
    const SUMMARIES: Record<string, string> = {
      'Capability prediction':
        'What a generally available Claude model will do for a small business by Q4 2027, and what will still hold it back.',
      'Product proposal': 'What Claude Desk is, who it’s for, what the first release enforces in code, and how we’ll know it works.',
      Vision: 'A front desk that never closes: where a Desk could go next, and the rules that wouldn’t change.',
    };
    for (const [lastDesk, to] of [
      [RIVERA.deskId, `/app/${RIVERA.deskId}/today`],
      [null, '/'],
    ] as const) {
      for (const viewport of ['desktop', 'phone'] as const) {
        for (const { path, title, heading, next } of SET) {
          const where = `${path} at ${viewport}, last Desk ${lastDesk}`;
          writeLocal('lastDesk', lastDesk);
          const { screen } = await renderRoute(path, { viewport });
          await expect.element(screen.getByRole('heading', { level: 1, name: heading, exact: true }), { message: where }).toBeVisible();

          // The switch: the three pages in order, the one on show marked as the current page and no other.
          const documents = screen.getByRole('navigation', { name: 'About this prototype', exact: true });
          const links = documents.getByRole('link').elements();
          expect(links.map((link) => link.textContent), where).toEqual(['Capability prediction', 'Product proposal', 'Vision']);
          expect(links.map((link) => link.getAttribute('href')), where).toEqual(['/about/prediction', '/about/proposal', '/about/vision']);
          expect(links.map((link) => link.getAttribute('aria-current')), where).toEqual(SET.map((page) => (page.title === title ? 'page' : null)));

          // "Read next": the next page in the set, its title and summary, the title the card's one link.
          const label = screen.container.querySelector('[data-next-label]');
          expect(label?.textContent, where).toBe('Read next');
          const card = label?.parentElement;
          const cardLinks = [...(card?.querySelectorAll('a') ?? [])];
          expect(cardLinks.map((link) => [link.textContent, link.getAttribute('href')]), where).toEqual([[next.title, next.path]]);
          expect(card?.textContent, where).toContain(SUMMARIES[next.title]);

          // One way into the prototype, the same words and target on every page.
          const tryIt = screen.getByRole('link', { name: 'Try Desk prototype', exact: true });
          expect(tryIt.elements(), where).toHaveLength(1);
          await expect.element(tryIt, { message: where }).toHaveAttribute('href', to);
          expect(screen.container.textContent, where).not.toContain('Back to your Desk');
        }
      }
    }

    // Followed, "Read next" goes round the set and back to where it started.
    writeLocal('lastDesk', null);
    const { screen, router } = await renderRoute(SET[0].path);
    for (const { heading, next } of SET) {
      await expect.element(screen.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
      const link = screen.container.querySelector('[data-next-label]')?.parentElement?.querySelector('a');
      if (!link) throw new Error(`${heading}: no Read next`);
      await userEvent.click(link);
      await expect.poll(() => router.state.location.pathname).toBe(next.path);
    }
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Capability prediction', exact: true })).toBeVisible();
  });

  it('the_reading_pages_share_the_vision_articles_paper', async () => {
    // The two reading pages are drawn in the Vision article's light reading style, so the set looks like one: the
    // same paper, ink and secondary ink, hairlines, link color, sticky bar, switch, way into the prototype, "Read
    // next" card and footer, read off the article itself at each size.
    const PAPER = 'rgb(244, 242, 236)';
    const INK = 'rgb(28, 27, 25)';
    const LINK = 'rgb(45, 91, 138)';
    /** What each page's set of parts computes to, by the part's role on the page. */
    const look = (container: HTMLElement, secondary: Element | null, compact: boolean) => {
      const bar = container.querySelector('header') as HTMLElement;
      const root = bar.parentElement as HTMLElement;
      const documents = container.querySelector('nav[aria-label="About this prototype"]') as HTMLElement;
      const current = documents.querySelector('[aria-current="page"]') as HTMLElement;
      const other = documents.querySelector('a:not([aria-current])') as HTMLElement;
      const tryIt = bar.querySelector('a.cd-about-try') as HTMLElement;
      const card = container.querySelector('[data-next-label]')?.parentElement as HTMLElement;
      const footer = container.querySelector('p[data-ds="concept-footer"]') as HTMLElement;
      const style = (el: Element | null) => getComputedStyle(el as Element);
      return {
        page: [style(root).backgroundColor, style(root).color, style(root).colorScheme],
        bar: [style(bar).position, style(bar).backgroundColor, style(bar).borderBottomColor],
        current: [style(current).backgroundColor, style(current).color],
        other: style(other).color,
        tryIt: style(tryIt).color,
        // The phone's top bar draws the link without its outline (PrototypeLink), so its edge is read on a desktop.
        tryEdge: compact ? null : style(tryIt).boxShadow,
        card: [style(card).backgroundColor, style(card).borderTopColor],
        footer: style(footer).color,
        secondary: style(secondary).color,
      };
    };
    for (const viewport of ['desktop', 'phone'] as const) {
      const vision = await renderRoute('/about/vision', { viewport });
      await expect.element(vision.screen.getByRole('heading', { level: 1, name: 'A front desk that never closes', exact: true })).toBeVisible();
      const paper = look(vision.screen.container, vision.screen.container.querySelector('[data-meta]'), viewport === 'phone');
      expect(paper.page, viewport).toEqual([PAPER, INK, 'light']);

      for (const { path, title } of PAGES) {
        const where = `${path} at ${viewport}`;
        const { screen } = await renderRoute(path, { viewport });
        await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true }), { message: where }).toBeVisible();
        expect(look(screen.container, screen.container.querySelector('[data-summary]'), viewport === 'phone'), where).toEqual(paper);
        // The figures sit on the article's paper cards, as the proposal's launch film does until its poster is drawn,
        // and a link in the text is in the article's link color.
        const frames = [...screen.container.querySelectorAll<HTMLElement>('main :is(.cd-about-frame, .cd-about-film__player)')];
        expect(frames.length, where).toBeGreaterThan(0);
        for (const frame of frames) expect(getComputedStyle(frame).backgroundColor, where).toBe(paper.card[0]);
        const link = screen.container.querySelector('a.cd-text-link') as HTMLElement;
        expect(getComputedStyle(link).color, where).toBe(LINK);
      }
    }
  });

  it.each(['desktop', 'phone'] as const)('the_three_pages_share_one_top_bar_on_%s', async (viewport) => {
    // Going from one page of the set to another, the bar across the top doesn't move (owner, 2026-11-01): the same
    // height, the app's lockup in the same place, each page of the switch and the way into the prototype in the
    // same place, drawn in the same colors. Only which page the switch marks differs. Measured at the top of each
    // page, against the capability prediction's.
    const SET = [
      { path: '/about/prediction', heading: 'Capability prediction' },
      { path: '/about/proposal', heading: 'Product proposal' },
      { path: '/about/vision', heading: 'A front desk that never closes' },
    ] as const;
    const bars: { path: string; bar: TopBar }[] = [];
    for (const { path, heading } of SET) {
      const { screen } = await renderRoute(path, { viewport });
      await expect.element(screen.getByRole('heading', { level: 1, name: heading, exact: true }), { message: path }).toBeVisible();
      await document.fonts.ready;
      bars.push({ path, bar: topBarOf(screen.container) });
    }
    const [first, ...rest] = bars;
    if (!first) throw new Error('no pages');
    for (const { path, bar } of rest) {
      const where = `${path} against ${first.path} at ${viewport}`;
      for (const [part, box] of Object.entries(bar.boxes)) {
        const want = first.bar.boxes[part];
        if (!want) throw new Error(`${where}: no ${part} on ${first.path}`);
        const off = (['x', 'y', 'width', 'height'] as const).filter((side) => Math.abs(box[side] - want[side]) > 0.5);
        expect(
          off.map((side) => `${part}.${side}: ${box[side]} against ${want[side]}`),
          where,
        ).toEqual([]);
      }
      expect(bar.look, where).toEqual(first.bar.look);
    }
    // Focus and a section opened by its address stop clear of the bar on each page, whatever its height.
    for (const { path, bar } of bars) expect(bar.clearance, `${path} at ${viewport}`).toBe((bar.boxes.bar as Box).height + 24);
  });

  it('about_pages_make_no_requests', async () => {
    for (const [lastDesk, to] of [
      [RIVERA.deskId, `/app/${RIVERA.deskId}/today`],
      [null, '/'],
    ] as const) {
      for (const { path, title } of PAGES) {
        for (const viewport of ['desktop', 'phone'] as const) {
          const where = `${path} at ${viewport}, last Desk ${lastDesk}`;
          writeLocal('lastDesk', lastDesk);
          const before = [...mockStore.requests];
          const { screen } = await renderRoute(path, { viewport });
          await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true }), { message: where }).toBeVisible();
          await expect
            .element(screen.getByRole('link', { name: 'Try Desk prototype', exact: true }), { message: where })
            .toHaveAttribute('href', to);
          // Long enough for anything the page asked for as it opened to reach the mock API.
          await settle();
          expect(mockStore.requests, where).toEqual(before);
        }
      }
    }
  });

  it('about_pages_pass_screen_basics', async () => {
    for (const lastDesk of [RIVERA.deskId, null]) {
      for (const { path, title } of PAGES) {
        for (const viewport of ['desktop', 'phone'] as const) {
          const where = `${path} at ${viewport}, last Desk ${lastDesk}`;
          writeLocal('lastDesk', lastDesk);
          const { screen } = await renderRoute(path, { viewport });
          await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true }), { message: where }).toBeVisible();
          // This project runs with motion, so the page is read once its figures rest, not part way through one.
          await untilAtRest(where);
          // One concept footer, the copy check over the whole page, the documents' words included, and axe. Not
          // the owner's jargon check: the documents name the kernel and its proofs, which is what they are
          // about (the reader's own words are checked in reader.browser.test.tsx).
          await expectScreenBasics(screen.container, { owner: false });
          expectNoHorizontalScroll();
        }
      }
    }
  });

  it('about_pages_are_noindex', async () => {
    const robots = () => [...document.head.querySelectorAll('meta[name="robots"]')].map((meta) => meta.getAttribute('content'));
    // The rest of the app asks nothing of search engines.
    const app = await renderRoute(`/d/${RIVERA.slug}`);
    await expect.element(app.screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeVisible();
    expect(robots()).toEqual([]);

    for (const { path, title } of PAGES) {
      const { screen, router } = await renderRoute(path);
      await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      // Search engines are asked not to list the page while it is open, a best effort since the app serves one
      // index.html for every address; the tab names the document.
      expect(robots(), path).toEqual(['noindex']);
      expect(document.title, path).toBe(`${title} · Claude Desk`);

      // Leaving for the rest of the app takes the request away.
      await router.navigate('/no/such/page');
      await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
      expect(robots(), `after ${path}`).toEqual([]);
      expect(document.title, `after ${path}`).not.toContain(title);
    }
  });

  it('the_tab_title_follows_each_page', async () => {
    // Every page that names the tab hands it back in the same commit, so from a business's own page through
    // both documents and on, the tab always names the page it is on.
    const before = 'Before · Claude Desk';
    document.title = before;
    const { screen, router } = await renderRoute(`/d/${RIVERA.slug}`);
    await expect.element(screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeVisible();
    await expect.poll(() => document.title).toBe('Turner Plumbing');

    for (const { path, title } of PAGES) {
      await router.navigate(path);
      await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await expect.poll(() => document.title, { message: path }).toBe(`${title} · Claude Desk`);
    }

    await router.navigate('/no/such/page');
    await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    await expect.poll(() => document.title, { message: 'after leaving' }).toBe(before);
  });
});

/**
 * Brings the page to rest: each figure that plays once and hasn't yet (`data-play="ready"`) is brought into view,
 * as a reader scrolling to it would, and plays; then nothing on the page is still animating. A figure that has
 * played, or never plays, has no `ready` mark. (A figure's `played` mark comes off once it has played through, so
 * the wait is for `ready` to go.)
 */
async function untilAtRest(where: string): Promise<void> {
  for (const figure of document.querySelectorAll<HTMLElement>('[data-play="ready"]')) {
    figure.scrollIntoView({ block: 'center' });
    await expect.poll(() => figure.dataset.play, { message: `${where}: the figure played in view` }).not.toBe('ready');
  }
  await expect.poll(() => document.getAnimations().length, { message: `${where}: nothing animates`, timeout: 5000 }).toBe(0);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What one page's top bar is: where each part sits, how it is drawn, and how far below the top focus stops. */
interface TopBar {
  boxes: Record<string, Box>;
  look: Record<string, string[]>;
  /** The scroll margin above a link in the page's main region, in px. */
  clearance: number;
}

/**
 * A page's top bar, found by what it shows rather than by its classes, so each page's own bar is read: the first
 * header, its part that names the product, the About set's switch (in the bar, or under it on a phone) and the way
 * into the prototype.
 */
function topBarOf(container: HTMLElement): TopBar {
  const bar = container.querySelector('header');
  if (!bar) throw new Error('no top bar');
  const lockup = [...bar.children].find((el) => el.textContent?.includes('Claude Desk'));
  const name = [...bar.querySelectorAll('*')].find((el) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent === 'Claude Desk'));
  const documents = container.querySelector('nav[aria-label="About this prototype"]');
  const links = [...(documents?.querySelectorAll('a') ?? [])];
  const current = links.find((link) => link.getAttribute('aria-current') === 'page');
  const other = links.find((link) => link.getAttribute('aria-current') === null);
  const tryIt = [...container.querySelectorAll('a')].find((link) => link.textContent === 'Try Desk prototype');
  const inMain = container.querySelector('main a');
  if (!lockup || !name || !documents || links.length !== 3 || !current || !other || !tryIt || !inMain) {
    throw new Error('the top bar is missing a part');
  }
  const box = (el: Element): Box => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  };
  const style = (el: Element, ...names: string[]) => {
    const computed = getComputedStyle(el);
    return names.map((prop) => computed.getPropertyValue(prop));
  };
  const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing'];
  return {
    boxes: {
      bar: box(bar),
      lockup: box(lockup),
      name: box(name),
      switch: box(documents),
      ...Object.fromEntries(links.map((link) => [`switch "${link.textContent}"`, box(link)])),
      'Try Desk prototype': box(tryIt),
    },
    look: {
      bar: style(bar, 'position', 'top', 'background-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'color'),
      name: style(name, 'color', ...TYPE),
      current: style(current, 'background-color', 'color', ...TYPE),
      other: style(other, 'background-color', 'color', 'text-decoration-line', ...TYPE),
      tryIt: style(tryIt, 'background-color', 'color', 'box-shadow', 'text-decoration-line', ...TYPE),
    },
    clearance: parseFloat(getComputedStyle(inMain).scrollMarginTop),
  };
}

/** Waits a quarter of a second: a request sent while the page drew has reached the mock API by then. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}
