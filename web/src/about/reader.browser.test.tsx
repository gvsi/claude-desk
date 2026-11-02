/**
 * The About this prototype reading page in a real browser, inside a memory router: what it shows, that it
 * shows each document's words in full and in order, that it makes no request, and that it passes the copy
 * check and axe at the desktop and phone sizes. Expected words are written out here, never read from the
 * page's code.
 */
import axe from 'axe-core';
import { StrictMode, useLayoutEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { Icon } from '../ds/index.ts';
import { CONCEPT_FOOTER_TEXT, assertCleanCopy } from '../ds/test/copy.ts';
import { FONT_SHEET_URL, loadWebFonts } from '../ds/test/fonts.ts';
import { writeLocal } from '../lib/storage.ts';
import { AXE_TAGS, assertNoJargon, tokenColor } from '../test/screen.ts';
import { ABOUT_DOCUMENTS, documentText } from './documents.ts';
import type { AboutId } from './links.ts';
import { ReaderPage } from './ReaderPage.tsx';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const IDS: AboutId[] = ['proposal', 'prediction'];

/** Each page's words as the project owner kept them, and its sections in the document's order. */
const PAGES = {
  proposal: {
    route: '/about/proposal',
    title: 'Product proposal',
    summary: 'What Claude Desk is, who it’s for, what the first release enforces in code, and how we’ll know it works.',
    sections: [
      'The product',
      'Who it’s for and the problem',
      'Why Anthropic',
      'The first release',
      'How we’ll know it works',
      'Business path',
      'The prototype',
    ],
  },
  prediction: {
    route: '/about/prediction',
    title: 'Capability prediction',
    summary:
      'What a generally available Claude model will do for a small business by October 2027, and what will still hold it back.',
    sections: ['Capability', 'Why it’s coming', 'Characteristics', 'Limitations', 'Readiness'],
  },
} as const;

/** Where the memory router is, for the link tests, and a way to move it. */
const at: { path: string; navigate: NavigateFunction | null } = { path: '', navigate: null };

function LocationProbe() {
  const location = useLocation();
  at.path = `${location.pathname}${location.hash}`;
  at.navigate = useNavigate();
  return null;
}

interface RenderOptions {
  size?: { width: number; height: number };
  /** The last Desk the owner opened, as the owner app stores it; null for a browser that has none. */
  lastDesk?: string | null;
  /** The address's fragment, with its `#`. */
  hash?: string;
}

/** The reader at its route, in a memory router that knows both pages. */
async function renderReader(id: AboutId, { size = DESKTOP, lastDesk = null, hash = '' }: RenderOptions = {}) {
  await page.viewport(size.width, size.height);
  writeLocal('lastDesk', lastDesk);
  return render(
    <MemoryRouter initialEntries={[`${PAGES[id].route}${hash}`]}>
      <Routes>
        <Route path="/about/proposal" element={<ReaderPage id="proposal" />} />
        <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(async () => {
  writeLocal('lastDesk', null);
  await page.viewport(DESKTOP.width, DESKTOP.height);
});

/** The design system's chat icon, as its paths draw it, to tell it apart from any other icon. */
const CHAT_ICON = (() => {
  const holder = document.createElement('div');
  holder.innerHTML = renderToStaticMarkup(<Icon name="conversations" />);
  return holder.querySelector('svg')?.innerHTML;
})();

/** Text with its whitespace collapsed, as a person reads it. */
function flat(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Curly apostrophes as straight ones, so the page and the parsed blocks compare equal however each writes them. */
function apostrophes(text: string): string {
  return text.replace(/[‘’]/g, "'");
}

/**
 * What a screen reader reads of `el`: its text nodes outside `aria-hidden` subtrees, one after another with a
 * space between, whitespace collapsed. For short labels and rows of links, not for running text.
 */
function readText(el: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
    return [...node.childNodes].map(walk).join(' ');
  };
  return flat(walk(el));
}

/** How far the section's heading is from its place below the pinned bar. */
function offsetOf(anchor: string): number {
  const heading = document.getElementById(anchor);
  if (!heading) throw new Error(`no section #${anchor}`);
  return heading.getBoundingClientRect().top - parseFloat(getComputedStyle(heading).scrollMarginTop);
}

/** Turns the browser's scroll anchoring off for the test, so nothing but the page puts the window back. */
function withoutScrollAnchoring(): void {
  // Chromium on Linux keeps anchoring unless the body is opted out too.
  for (const element of [document.documentElement, document.body]) element.style.overflowAnchor = 'none';
  onTestFinished(() => {
    for (const element of [document.documentElement, document.body]) element.style.overflowAnchor = '';
  });
}

/** Makes the reading type's web font still loading, as on a cold load, and returns what finishes loading it. */
function typeStillLoading(): () => void {
  let loaded = () => {};
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const fonts = { status: 'loading', ready } as unknown as FontFaceSet;
  Object.defineProperty(document, 'fonts', { configurable: true, get: () => fonts });
  onTestFinished(() => {
    delete (document as { fonts?: FontFaceSet }).fonts;
  });
  return loaded;
}

/** Grows the page above the sections, as the font's swap does. */
function swapType(): void {
  const grown = document.createElement('div');
  grown.style.height = '29px';
  (document.querySelector('[data-hero]') as HTMLElement).append(grown);
  onTestFinished(() => grown.remove());
}


/** The contents list's links marked as the section being read, as "name (aria-current)". */
function marked(): string[] {
  const contents = document.querySelector('nav[aria-label="On this page"]');
  return [...(contents?.querySelectorAll('a[aria-current]') ?? [])].map(
    (link) => `${readText(link)} (${link.getAttribute('aria-current')})`,
  );
}

/** The heading of the section `anchor` names. */
function headingOf(anchor: string): HTMLElement {
  const heading = document.getElementById(anchor);
  if (!heading) throw new Error(`no section #${anchor}`);
  return heading;
}

/** The window's offset at which the section's heading sits at the top, below its scroll margin. */
function placeOf(anchor: string): number {
  const heading = headingOf(anchor);
  return Math.round(heading.getBoundingClientRect().top + window.scrollY - parseFloat(getComputedStyle(heading).scrollMarginTop));
}

/** Moves the window to `y` in one jump, as an address or a reduced-motion link does, and waits for it to rest. */
async function jumpTo(y: number): Promise<void> {
  const top = Math.min(y, document.documentElement.scrollHeight - window.innerHeight);
  if (Math.round(window.scrollY) === top) return;
  const rested = new Promise((resolve) => window.addEventListener('scrollend', resolve, { once: true }));
  window.scrollTo({ top, behavior: 'instant' });
  await rested;
}

/**
 * The section the 40% rule names where the window is now, read from the page: the last section whose heading's top
 * is above 40% of the window. Away from the page's end, where the last section is marked instead.
 */
function byTheRule(): string {
  const line = window.innerHeight * 0.4;
  const above = [...document.querySelectorAll<HTMLElement>('article h2[id]')].filter((heading) => heading.getBoundingClientRect().top <= line);
  return flat(above[above.length - 1]?.textContent);
}

/** Two frames: long enough for what the page heard to have been acted on. */
async function twoFrames(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/**
 * Follows the laptop contents list's link to `anchor`, clicked where it is, as a reader's click on the pinned list is.
 * A driven click first brings its target into view, and for a link in the pinned column that can scroll the page.
 */
function followContentsLink(anchor: string): void {
  const link = document.querySelector<HTMLElement>(`nav.cd-about-contents--side a[href="#${anchor}"]`);
  if (!link) throw new Error(`no contents link to #${anchor}`);
  link.click();
}

describe('ReaderPage', () => {
  it('reader_renders_its_document', async () => {
    for (const id of IDS) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const expected = PAGES[id];

        // The title, from the document's own `#` title, and the summary under it.
        const title = screen.container.querySelector('h1');
        expect(flat(title?.textContent), where).toBe(expected.title);
        const heading = ABOUT_DOCUMENTS[id].blocks[0];
        expect(heading?.kind === 'heading' && heading.text.startsWith(`${expected.title}:`), where).toBe(true);
        const hero = screen.container.querySelector('[data-hero]');
        expect(flat(hero?.querySelector('[data-summary]')?.textContent), where).toBe(expected.summary);
        expect(
          flat((hero as HTMLElement | null)?.innerText).startsWith(`About this prototype ${expected.title} ${expected.summary}`),
          where,
        ).toBe(true);

        // Every section in the contents list, in the document's order, each link named by its section and
        // numbered on the page (the list itself numbers them for a screen reader).
        const contents = screen.container.querySelector('nav[aria-label="On this page"]');
        const entries = [...(contents?.querySelectorAll('ol > li > a') ?? [])];
        expect(entries.map(readText), where).toEqual(expected.sections);
        expect(
          entries.map((entry) => entry.querySelector('[aria-hidden="true"]')?.textContent),
          where,
        ).toEqual(expected.sections.map((_, i) => String(i + 1).padStart(2, '0')));
        const ids = ABOUT_DOCUMENTS[id].blocks.flatMap((block) => (block.kind === 'heading' && block.depth === 2 ? [block.id] : []));
        expect(entries.map((entry) => entry.getAttribute('href')), where).toEqual(ids.map((anchor) => `#${anchor}`));
        for (const anchor of ids) expect(document.getElementById(anchor)?.localName, `${where}: #${anchor}`).toBe('h2');

        // The lead figure, in the hero and only there: the architecture for the proposal, the τ³-Banking chart
        // for the prediction.
        const figures = [...screen.container.querySelectorAll('figure')];
        if (id === 'proposal') {
          const lead = figures.filter((figure) => figure.querySelector('[data-diagram]'));
          expect(lead.length, where).toBe(1);
          expect(lead[0]?.closest('[data-hero]'), where).not.toBeNull();
          await expect
            .element(screen.getByRole('figure', { name: 'Claude proposes; the kernel decides what runs and what is shown', exact: true }))
            .toBeInTheDocument();
        } else {
          const charts = [...screen.container.querySelectorAll('svg[role="img"]')];
          expect(charts.length, where).toBe(1);
          expect(charts[0]?.closest('[data-hero]'), where).not.toBeNull();
        }
        await screen.unmount();
      }
    }
  });

  it('reader_makes_no_requests', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const beaconSpy = vi.spyOn(navigator, 'sendBeacon');
    const streams: string[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        constructor(url: string) {
          streams.push(url);
        }
      },
    );
    try {
      for (const lastDesk of ['desk-rivera', null]) {
        for (const id of IDS) {
          for (const size of [DESKTOP, PHONE]) {
            const screen = await renderReader(id, { size, lastDesk });
            // The page is drawn, its link into the prototype read from what this browser stored.
            const back = screen.getByRole('link', { name: 'Try Desk prototype', exact: true });
            await expect.element(back).toBeInTheDocument();
            await screen.unmount();
          }
        }
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(beaconSpy).not.toHaveBeenCalled();
      expect(streams).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('reader_passes_copy_and_axe', async () => {
    for (const id of IDS) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        // One concept footer, word for word, and the copy check over the whole page, the documents' words
        // included.
        const footers = screen.container.querySelectorAll('[data-ds="concept-footer"]');
        expect(footers, where).toHaveLength(1);
        expect(flat(footers[0]?.textContent), where).toBe(CONCEPT_FOOTER_TEXT);
        assertCleanCopy(screen.container);
        const results = await axe.run(screen.container, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
        expect(results.passes.map((rule) => rule.id), where).toEqual(expect.arrayContaining(['color-contrast', 'link-name']));
        const violations = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${v.help} at ${n.target.join(' ')}`));
        expect(violations, where).toEqual([]);
        // Nothing runs past the window's width.
        expect(document.documentElement.scrollWidth, where).toBeLessThanOrEqual(size.width);
        await screen.unmount();
      }
    }
  });

  it('top_bar_shows_the_apps_lockup', async () => {
    // The top bar shows the app's lockup (owner, 2026-10-30): the bell with no tile, in the drawing's dark
    // ink on the page's paper, then "Claude Desk", 36 px with the Preview badge on the desktop bar, 32 px with
    // the name alone on the phone bar. The white tile is the article's app icon now, never the bar's.
    for (const [size, px, badge] of [
      [DESKTOP, '36', 'Preview'],
      [PHONE, '32', null],
    ] as const) {
      const where = `at ${size.width}`;
      const screen = await renderReader('proposal', { size });
      const bar = screen.container.querySelector('header');
      const marks = [...(bar?.querySelectorAll('svg.cd-mark') ?? [])];
      expect(marks, where).toHaveLength(1);
      const mark = marks[0] as SVGSVGElement;
      expect([mark.getAttribute('width'), mark.getAttribute('height')], where).toEqual([px, px]);
      expect(mark.querySelector(':scope > rect'), where).toBeNull();
      expect(getComputedStyle(mark.querySelector(':scope > g > g:last-child') as Element).fill, where).toBe('rgb(20, 20, 19)');
      expect(bar?.querySelector('.cd-type-wordmark')?.textContent, where).toBe('Claude Desk');
      expect(bar?.querySelector('.cd-pill')?.textContent ?? null, where).toBe(badge);
      // The bell 10 px from the name on the desktop bar, as in the sidebar, 8 px on the phone bar,
      // each centred on the other.
      const [m, n] = [mark, bar?.querySelector('.cd-type-wordmark') as Element].map((el) => el.getBoundingClientRect()) as [DOMRect, DOMRect];
      expect(n.left - m.right, where).toBe(size === DESKTOP ? 10 : 8);
      expect(Math.abs(n.top + n.height / 2 - (m.top + m.height / 2)), where).toBeLessThanOrEqual(0.5);
      await screen.unmount();
    }
  });

  it('article_opens_with_the_app_icon', async () => {
    // The mark on its white tile is the article's app icon (owner, 2026-10-30): a clay field with
    // corners a quarter of its size and the tiled bell at two thirds of it, centred above "About
    // this prototype" and the title. 120 px on the desktop layout, 88 px on the phone's.
    for (const [size, field, radius, bell, gap, top] of [
      [DESKTOP, 120, '30px', '80', 36, '88px'],
      [PHONE, 88, '22px', '58', 28, '36px'],
    ] as const) {
      for (const id of IDS) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const hero = screen.container.querySelector<HTMLElement>('[data-hero]');
        const icon = hero?.querySelector<HTMLElement>('.cd-mark-app-icon');
        if (!hero || !icon) throw new Error(`${where}: no app icon in the hero`);
        expect(hero.firstElementChild?.contains(icon), `${where}: the icon comes first`).toBe(true);
        // Decorative: the bar above names the product and the title names the page.
        expect(icon.getAttribute('aria-hidden'), where).toBe('true');
        const box = icon.getBoundingClientRect();
        expect([box.width, box.height], where).toEqual([field, field]);
        expect(getComputedStyle(icon).borderTopLeftRadius, where).toBe(radius);
        // Its clay field is checked by the Mark's AppIcon story: clay is named only in the mark's and
        // the intro dialog's folders. Here, a filled field that isn't the page's ground.
        expect(getComputedStyle(icon).backgroundColor, where).not.toBe(getComputedStyle(document.body).backgroundColor);
        expect(getComputedStyle(icon).backgroundColor, where).not.toBe('rgba(0, 0, 0, 0)');
        const tiled = icon.querySelector('svg.cd-mark');
        expect([tiled?.getAttribute('width'), tiled?.getAttribute('height')], where).toEqual([bell, bell]);
        expect(getComputedStyle(tiled?.querySelector(':scope > rect') as Element).fill, where).toBe('rgb(255, 255, 255)');
        const inner = (tiled as Element).getBoundingClientRect();
        expect(inner.left - box.left, where).toBe(box.right - inner.right);
        expect(inner.top - box.top, where).toBe(box.bottom - inner.bottom);
        // Centred on the title, above the kicker by the board's gap; the hero's own space above it.
        const kicker = hero.querySelector('.cd-about-hero__kicker') as Element;
        const title = hero.querySelector('h1') as Element;
        expect(kicker.getBoundingClientRect().top - box.bottom, where).toBe(gap);
        expect(box.bottom, where).toBeLessThan(title.getBoundingClientRect().top);
        const middle = (r: DOMRect) => r.left + r.width / 2;
        expect(Math.abs(middle(box) - middle(title.getBoundingClientRect())), where).toBeLessThanOrEqual(0.5);
        expect(getComputedStyle(hero).paddingTop, where).toBe(top);
        await screen.unmount();
      }
    }
  });

  it('phone_top_bar_keeps_the_name_on_one_line', async () => {
    // The phone bar follows the signed phone top bar: the bell beside "Claude Desk" and no Preview
    // badge, the name on one line (the wordmark's 22 px line) and nothing past the window's width,
    // down to a 320 px phone. The desktop bar keeps the badge.
    const phones = [PHONE, { width: 375, height: 812 }, { width: 360, height: 800 }, { width: 320, height: 640 }];
    for (const size of phones) {
      const where = `at ${size.width}`;
      const screen = await renderReader('proposal', { size });
      const bar = screen.container.querySelector('header');
      const name = bar?.querySelector<HTMLElement>('.cd-type-wordmark');
      expect(name?.textContent, where).toBe('Claude Desk');
      expect(bar?.querySelector('svg.cd-mark')?.getAttribute('width'), where).toBe('32');
      expect(name?.getBoundingClientRect().height, where).toBe(22);
      expect(bar?.querySelector('.cd-pill'), where).toBeNull();
      expect(document.documentElement.scrollWidth, where).toBeLessThanOrEqual(size.width);
      // The brand keeps the bar's 16 px side, and the link its words on one line. Below 360 px the
      // link drops its chat icon, so the 32 px bell and the name still fit.
      expect(bar?.querySelector('.cd-about-brand')?.getBoundingClientRect().right, where).toBeLessThanOrEqual(size.width - 16);
      const link = bar?.querySelector<HTMLElement>('.cd-about-try');
      expect(link?.textContent, where).toBe('Try Desk prototype');
      expect(link?.getBoundingClientRect().height, where).toBe(32);
      const icon = link?.querySelector('.cd-about-try__icon');
      expect(icon ? getComputedStyle(icon).display : null, where).toBe(size.width < 360 ? 'none' : 'block');
      await screen.unmount();
    }
    const screen = await renderReader('proposal', { size: DESKTOP });
    const bar = screen.container.querySelector('header');
    expect(bar?.querySelector<HTMLElement>('.cd-type-wordmark')?.getBoundingClientRect().height).toBe(22);
    expect(bar?.querySelector('.cd-pill')?.textContent).toBe('Preview');
    await screen.unmount();
  });

  it('phone_switch_keeps_the_three_pages_on_one_row', async () => {
    // Under the phone bar, the set's three pages sit on one row at 390 and 375 px: "Vision" never drops to a
    // line of its own and pushes the page down, and nothing runs past the window's width. The laptop switch
    // keeps its 12 px either side of each name. Measured in the interface's web font, as the page ships, which the
    // other tests here don't load; the sheet goes again after, so they keep measuring as before.
    onTestFinished(() => {
      const want = new URL(FONT_SHEET_URL).href;
      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) if (link.href === want) link.remove();
    });
    await loadWebFonts();
    for (const size of [PHONE, { width: 375, height: 667 }]) {
      for (const id of IDS) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const nav = screen.container.querySelector<HTMLElement>('nav[aria-label="About this prototype"]');
        const links = [...(nav?.querySelectorAll<HTMLElement>('a') ?? [])];
        expect(links.map((link) => flat(link.textContent)).sort(), where).toEqual(['Capability prediction', 'Product proposal', 'Vision']);
        const tops = links.map((link) => link.getBoundingClientRect().top);
        expect(new Set(tops).size, `${where}: tops ${tops.join(', ')}`).toBe(1);
        // One row: the switch is as tall as its space above and one 32 px link.
        const box = (nav as HTMLElement).getBoundingClientRect();
        expect(box.height - parseFloat(getComputedStyle(nav as HTMLElement).paddingTop), where).toBe(32);
        expect(Math.max(...links.map((link) => link.getBoundingClientRect().right)), where).toBeLessThanOrEqual(size.width - 16);
        expect(document.documentElement.scrollWidth, where).toBeLessThanOrEqual(size.width);
        await screen.unmount();
      }
    }
    const screen = await renderReader('proposal', { size: DESKTOP });
    for (const link of screen.container.querySelectorAll<HTMLElement>('nav[aria-label="About this prototype"] a')) {
      const style = getComputedStyle(link);
      expect([style.paddingLeft, style.paddingRight], flat(link.textContent)).toEqual(['12px', '12px']);
    }
    await screen.unmount();
  });

  it('reader_chrome_has_no_jargon', async () => {
    /** A copy of `el` without the parts the documents' words fill: the jargon check reads only the page's own. */
    const without = (el: Element | null | undefined, selector: string): HTMLElement => {
      const copy = (el?.cloneNode(true) ?? document.createElement('div')) as HTMLElement;
      for (const part of copy.querySelectorAll(selector)) part.remove();
      return copy;
    };

    for (const id of IDS) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size, lastDesk: 'desk-rivera' });
        const root = screen.container;
        const phone = size === PHONE;

        // The reader's own strings, each found where the boards put it.
        const topBar = root.querySelector('header');
        const documents = root.querySelector('nav[aria-label="About this prototype"]');
        expect(readText(documents ?? document.body), where).toBe('Capability prediction Product proposal Vision');
        expect(readText(topBar ?? document.body), where).toBe(
          phone ? 'Try Desk prototype Claude Desk' : 'Claude Desk Preview Capability prediction Product proposal Vision Try Desk prototype',
        );
        // "On this page", without the entries, which are the document's section names.
        const contents = without(root.querySelector('nav[aria-label="On this page"]'), 'ol');
        expect(readText(contents), where).toBe(
          phone ? `On this page ${PAGES[id].sections.length} sections` : 'On this page',
        );
        // The details: the labels beside the author, date and reading time, or the line under the summary.
        const meta = phone
          ? root.querySelector('[data-hero] [data-byline]')
          : root.querySelector('aside[aria-label="About this document"]');
        expect(meta, where).not.toBeNull();
        const labels = phone ? [] : [...(meta?.querySelectorAll('dt') ?? [])].map(readText);
        if (!phone) expect(labels, where).toEqual(['Written by', 'Date', 'Reading time', 'Also read']);
        const next = root.querySelector('[data-next-label]');
        expect(readText(next ?? document.body), where).toBe('Read next');
        // "Figure 1" and the captions, without the architecture figure's name, a label from the checked list.
        const captions = [...root.querySelectorAll('figcaption')];
        expect(captions.length, where).toBeGreaterThan(0);
        expect(captions.map((caption) => readText(caption).startsWith('Figure 1')), where).toContain(true);

        const chrome = [
          topBar,
          documents,
          contents,
          meta,
          next,
          ...captions.map((caption) => without(caption, '[data-figure-label]')),
          ...root.querySelectorAll('.cd-about-chart__head, [data-steps]'),
        ];
        for (const part of chrome) {
          expect(part, where).not.toBeNull();
          if (part) assertNoJargon(part as HTMLElement);
        }
        // The check reads the words it is given: the architecture caption's name says "kernel".
        if (id === 'proposal') {
          const architecture = captions.find((caption) => caption.querySelector('[data-figure-label]'));
          expect(() => assertNoJargon(architecture as HTMLElement), where).toThrow(/kernel/);
        }
        await screen.unmount();
      }
    }
  });

  it('article_shows_every_block_in_order', async () => {
    for (const id of IDS) {
      const { blocks, pullQuote } = ABOUT_DOCUMENTS[id];
      const expected = documentText(blocks).map(apostrophes);
      // Each piece's key is its block's place in the document and its place in the block.
      const keys = blocks.flatMap((block, b) => documentText([block]).map((_, i) => `${b}.${i}`));
      // Header cells the page shows again as labels: the readiness scale's "Watch for", the phone list's
      // "Prototype".
      const headerCells = blocks.flatMap((block) => (block.kind === 'table' ? documentText([{ ...block, rows: [] }]) : []));

      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const marked = [...screen.container.querySelectorAll('[data-doc-text]')].filter((el) => el.checkVisibility());
        expect(marked.map((el) => apostrophes(el.textContent ?? '')), where).toEqual(expected);
        expect(marked.map((el) => el.getAttribute('data-doc-text')), where).toEqual(keys);

        // Everything else the article says is the pull quote, the readiness scale's own words, or a header cell
        // repeated as a label.
        const article = screen.container.querySelector('article');
        expect(article, where).not.toBeNull();
        const unmarked: string[] = [];
        const walker = document.createTreeWalker(article ?? document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').trim() === '' || node.parentElement?.closest('[data-doc-text]')) continue;
          unmarked.push((node.textContent ?? '').trim());
        }
        const steps = ['Lagging', 'Early', 'Gated', 'Near'];
        const allowed = (text: string) =>
          text === pullQuote ||
          (id === 'prediction' && steps.includes(text)) ||
          ((text === 'Watch for' || (size === PHONE && text === 'Prototype')) && headerCells.includes(text));
        expect(unmarked.filter((text) => !allowed(text)), where).toEqual([]);
        expect(unmarked.filter((text) => text === pullQuote), where).toHaveLength(1);
        await screen.unmount();
      }
    }
  });

  it('proposal_says_youre_in_it', async () => {
    for (const size of [DESKTOP, PHONE]) {
      const where = `proposal at ${size.width}`;
      const screen = await renderReader('proposal', { size });
      const article = screen.container.querySelector('article');
      // The sentence that gave the hosted prototype's address reads as the page it is on, the repo link kept.
      const sentence = [...(article?.querySelectorAll('p') ?? [])].find((p) => p.textContent?.startsWith('You’re in it.'));
      expect(flat(sentence?.textContent), where).toMatch(
        /^You’re in it\. The code is at github\.com\/gvsi\/claude-desk\. Each visitor acts as Mike/,
      );
      // The repository is the sentence's one link, a plain text link that opens in a new tab.
      const links = [...(sentence?.querySelectorAll('a') ?? [])];
      expect(links, where).toHaveLength(1);
      const [repo] = links;
      expect(repo?.textContent, where).toBe('github.com/gvsi/claude-desk');
      expect(repo?.getAttribute('href'), where).toBe('https://github.com/gvsi/claude-desk');
      expect(repo?.getAttribute('target'), where).toBe('_blank');
      expect(repo?.getAttribute('rel'), where).toBe('noopener noreferrer');
      expect(repo?.className, where).toBe('cd-text-link');
      expect(repo?.querySelector('svg'), where).toBeNull();
      expect(sentence?.querySelector('.cd-pill'), where).toBeNull();
      expect(article?.textContent, where).not.toContain('enforced core, is at');
      await screen.unmount();
    }
    const prediction = await renderReader('prediction');
    expect(prediction.container.textContent).not.toContain('You’re in it');
    await prediction.unmount();
  });

  it('placeholders_show_as_pending', async () => {
    // The proposal's placeholders as the document has them, until they are filled: five in the measures table.
    // The one link in its last section still to give, the hosted address, is in the sentence the page replaces.
    const PENDING = [
      'measured: tier 2 pass, with its 95% upper bound',
      'measured: held-out rate with its 95% interval',
      'measured: false-hold rate',
      'measured: …',
      'measured: …',
    ];
    for (const size of [DESKTOP, PHONE]) {
      const where = `proposal at ${size.width}`;
      const screen = await renderReader('proposal', { size });
      const article = screen.container.querySelector('article');
      // Each one a pill with its words, never a blank or a made-up value, in the document's order.
      const pills = [...(article?.querySelectorAll('.cd-pill') ?? [])];
      expect(pills.map((pill) => pill.textContent), where).toEqual(PENDING);
      for (const pill of pills) expect(pill.closest('[data-doc-text]'), where).not.toBeNull();
      expect(flat(article?.textContent), where).not.toMatch(/\[(?:measured|owner):/);
      await screen.unmount();
    }
    // The prediction has none.
    const prediction = await renderReader('prediction');
    expect(prediction.container.querySelectorAll('article .cd-pill')).toHaveLength(0);
    await prediction.unmount();
  });

  it('no_raw_markdown_in_the_page', async () => {
    const MARKDOWN = ['**', '](', '`', '<!--', '![', '[measured:', '[owner:'];
    for (const id of IDS) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const text = screen.container.textContent ?? '';
        expect(text.length, where).toBeGreaterThan(3000);
        expect(MARKDOWN.filter((mark) => text.includes(mark)), where).toEqual([]);
        // Bold (the proposal's) and code spans (both documents' `estimate:` labels) are elements, not marks.
        if (id === 'proposal') expect(screen.container.querySelectorAll('article strong').length, where).toBeGreaterThan(0);
        expect(screen.container.querySelectorAll('article code').length, where).toBeGreaterThan(0);
        await screen.unmount();
      }
    }
  });

  it('also_read_links_to_related_about_pages', async () => {
    for (const [id, expected] of [
      ['proposal', [['Capability prediction', '/about/prediction'], ['Vision', '/about/vision']]],
      ['prediction', [['Product proposal', '/about/proposal']]],
    ] as const) {
      const screen = await renderReader(id);
      const label = [...screen.container.querySelectorAll('.cd-about-meta dt')].find((term) => term.textContent === 'Also read');
      expect(label, id).toBeDefined();
      const links = [...(label?.nextElementSibling?.querySelectorAll('a') ?? [])];
      expect(links.map((link) => [flat(link.textContent), link.getAttribute('href')]), id).toEqual(expected);
      for (const link of links) expect(link.classList.contains('cd-text-link'), id).toBe(true);
      await screen.unmount();
    }
  });

  it('documents_link_to_each_other', async () => {
    const screen = await renderReader('proposal');
    const title = () => flat(screen.container.querySelector('h1')?.textContent);

    // The proposal's own link to the prediction stays in the app.
    const inText = screen.container.querySelector('article a[href="/about/prediction"]');
    expect(flat(inText?.textContent)).toBe('capability prediction');
    expect(inText?.getAttribute('target')).toBeNull();
    await userEvent.click(inText as HTMLElement);
    await expect.poll(title).toBe('Capability prediction');
    expect(at.path).toBe('/about/prediction');

    // From the end of each page, "Read next" opens the next one in the About set: the prediction the proposal,
    // at its top, and the proposal the Vision article, which this router doesn't draw.
    const readNext = () => screen.container.querySelector('[data-next-label]')?.closest('.cd-about-next')?.querySelector('a');
    window.scrollTo(0, document.documentElement.scrollHeight);
    await expect.poll(() => window.scrollY).toBeGreaterThan(0);
    expect([flat(readNext()?.textContent), readNext()?.getAttribute('href')]).toEqual(['Product proposal', '/about/proposal']);
    await userEvent.click(readNext() as HTMLElement);
    await expect.poll(title).toBe('Product proposal');
    expect(at.path).toBe('/about/proposal');
    await expect.poll(() => window.scrollY).toBe(0);
    window.scrollTo(0, document.documentElement.scrollHeight);
    await expect.poll(() => window.scrollY).toBeGreaterThan(0);
    expect([flat(readNext()?.textContent), readNext()?.getAttribute('href')]).toEqual(['Vision', '/about/vision']);
    await userEvent.click(readNext() as HTMLElement);
    await expect.poll(() => at.path).toBe('/about/vision');

    // The top bar's switch too: the set's three pages, the page on show marked as current.
    at.navigate?.('/about/prediction');
    await expect.poll(title).toBe('Capability prediction');
    const links = [...screen.container.querySelectorAll('nav[aria-label="About this prototype"] a')];
    expect(links.map((link) => [flat(link.textContent), link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['Capability prediction', '/about/prediction', 'page'],
      ['Product proposal', '/about/proposal', null],
      ['Vision', '/about/vision', null],
    ]);
    await userEvent.click(screen.container.querySelector('nav[aria-label="About this prototype"] a[href="/about/proposal"]') as HTMLElement);
    await expect.poll(title).toBe('Product proposal');
    await screen.unmount();
  });

  it('an_address_opens_at_its_section_or_the_top', async () => {
    const title = () => flat(document.querySelector('h1')?.textContent);
    /** Whether the section sits at the top of the window, below its scroll margin. */
    const atTop = (anchor: string) => {
      const section = document.getElementById(anchor);
      if (!section) return false;
      const margin = parseFloat(getComputedStyle(section).scrollMarginTop);
      return Math.abs(section.getBoundingClientRect().top - margin) <= 1;
    };

    // A fragment that isn't valid percent-encoding names no section: the page opens at its top.
    const screen = await renderReader('proposal', { hash: '#100%' });
    await expect.poll(title).toBe('Product proposal');
    expect(window.scrollY).toBe(0);

    // Coming from the other document, a section the address names, as written or percent-encoded, opens
    // there; from it, the other document, its address naming no section it has or a malformed one, opens at
    // its top.
    for (const { path, anchor, other, others } of [
      {
        path: '/about/prediction#characteristics',
        anchor: 'characteristics',
        other: { route: '/about/proposal', title: 'Product proposal' },
        others: ['/about/proposal#no-such-section', '/about/proposal#%E0%A4%A'],
      },
      {
        path: '/about/proposal#why%2Danthropic',
        anchor: 'why-anthropic',
        other: { route: '/about/prediction', title: 'Capability prediction' },
        others: ['/about/prediction#no-such-section', '/about/prediction#100%'],
      },
    ]) {
      for (const next of others) {
        at.navigate?.(other.route);
        await expect.poll(title, { message: other.route }).toBe(other.title);
        at.navigate?.(path);
        await expect.poll(() => atTop(anchor), { message: path }).toBe(true);
        expect(window.scrollY, path).toBeGreaterThan(0);
        at.navigate?.(next);
        await expect.poll(title, { message: next }).toBe(other.title);
        await expect.poll(() => window.scrollY, { message: next }).toBe(0);
      }
    }
    await screen.unmount();
  });

  it('an_address_keeps_its_section_while_the_type_loads', async () => {
    // On a cold load the reading type's web font swaps in after the page has opened at the address's section, and
    // moves the page under the window. Once the type has loaded the section is back at its place, unless the reader
    // has moved on first or the document has gone. Scroll anchoring is off, so nothing else puts the window back.
    withoutScrollAnchoring();
    const title = () => flat(document.querySelector('h1')?.textContent);

    let loaded = () => {};
    for (const size of [DESKTOP, PHONE]) {
      loaded = typeStillLoading();
      const screen = await renderReader('prediction', { size, hash: '#characteristics' });
      await expect.poll(() => Math.abs(offsetOf('characteristics'))).toBeLessThanOrEqual(1);
      swapType();
      expect(offsetOf('characteristics'), `the swap moved the page at ${size.width}`).toBeGreaterThan(20);
      loaded();
      await expect
        .poll(() => Math.abs(offsetOf('characteristics')), { message: `once the type has loaded at ${size.width}` })
        .toBeLessThanOrEqual(1);
      await screen.unmount();
    }

    /** Scrolls the window as a reader does, through to the scroll event the page hears, and returns where it is. */
    const scrollOn = async () => {
      const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
      window.scrollTo(0, window.scrollY + 300);
      await scrolled;
      return Math.round(window.scrollY);
    };

    // A reader who has moved on before the type loads is left where they are, whatever they moved with.
    for (const kind of ['wheel', 'touchmove', 'pointerdown', 'keydown', 'popstate']) {
      loaded = typeStillLoading();
      const again = await renderReader('prediction', { hash: '#characteristics' });
      await expect.poll(() => Math.abs(offsetOf('characteristics')), { message: kind }).toBeLessThanOrEqual(1);
      window.dispatchEvent(new Event(kind));
      const where = await scrollOn();
      swapType();
      loaded();
      await twoFrames();
      expect(Math.round(window.scrollY), `where the reader is after a ${kind}`).toBe(where);
      await again.unmount();
    }

    // Back returns to the reader's place and keeps no section, though the address names one.
    loaded = typeStillLoading();
    const back = await renderReader('prediction', { hash: '#characteristics' });
    await expect.poll(() => Math.abs(offsetOf('characteristics'))).toBeLessThanOrEqual(1);
    window.dispatchEvent(new Event('wheel'));
    const place = await scrollOn();
    at.navigate?.('/about/proposal');
    await expect.poll(title).toBe('Product proposal');
    at.navigate?.(-1);
    await expect.poll(title).toBe('Capability prediction');
    await expect.poll(() => Math.round(window.scrollY), { message: 'Back returns to the place' }).toBe(place);
    swapType();
    loaded();
    await twoFrames();
    expect(Math.round(window.scrollY), 'the place Back returned to').toBe(place);
    await back.unmount();

    // Once the document has gone, its section isn't kept: the other document opens at its top and stays there. The
    // other document's "The first release" is drawn in the very heading that was "Limitations", at the same place in its document.
    loaded = typeStillLoading();
    const third = await renderReader('prediction', { hash: '#limitations' });
    await expect.poll(() => Math.abs(offsetOf('limitations'))).toBeLessThanOrEqual(1);
    const heading = document.getElementById('limitations');
    at.navigate?.('/about/proposal');
    await expect.poll(title).toBe('Product proposal');
    expect(document.getElementById('the-first-release'), 'the same heading element').toBe(heading);
    await expect.poll(() => window.scrollY).toBe(0);
    swapType();
    loaded();
    await twoFrames();
    expect(window.scrollY, 'the other document stays at its top').toBe(0);
    await third.unmount();
  });

  it('an_address_keeps_its_section_under_strict_mode', async () => {
    // The app renders under React's StrictMode, which in development runs the page's effects twice for one opening:
    // the section is still kept while the type loads.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const screen = await render(
      <StrictMode>
        <MemoryRouter initialEntries={['/about/prediction#characteristics']}>
          <Routes>
            <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </StrictMode>,
    );
    await expect.poll(() => Math.abs(offsetOf('characteristics'))).toBeLessThanOrEqual(1);
    swapType();
    expect(offsetOf('characteristics'), 'the swap moved the page').toBeGreaterThan(20);
    loaded();
    await expect.poll(() => Math.abs(offsetOf('characteristics')), { message: 'once the type has loaded' }).toBeLessThanOrEqual(1);
    await screen.unmount();
  });

  it('a_font_correction_keeps_the_followed_mark', async () => {
    // Following "Business path" stops at the proposal's end, where it stays marked. When the type then loads and the
    // page has grown, the page follows the section to the new end by itself; that isn't the reader scrolling on, so
    // the mark stays.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    const screen = await renderReader('proposal');
    const height = Math.max(1400, document.documentElement.scrollHeight - placeOf('business-path') + 100);
    await page.viewport(DESKTOP.width, height);
    await expect.poll(() => window.innerHeight).toBe(height);
    await jumpTo(placeOf('the-first-release'));
    await expect.poll(marked).toEqual(['The first release (location)']);
    followContentsLink('business-path');
    const end = () => Math.round(document.documentElement.scrollHeight - window.innerHeight);
    await expect.poll(() => Math.round(window.scrollY)).toBe(end());
    await expect.poll(marked).toEqual(['Business path (location)']);
    await twoFrames();
    swapType();
    expect(end() - Math.round(window.scrollY), 'the page grew below the window').toBeGreaterThan(20);
    loaded();
    await expect.poll(() => Math.round(window.scrollY), { message: 'followed to the new end' }).toBe(end());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(marked(), 'after the page followed the section').toEqual(['Business path (location)']);
    await screen.unmount();
  });

  it('a_font_correction_keeps_the_followed_mark_with_scroll_anchoring_on', async () => {
    // As above, with the browser's scroll anchoring left on, as a reader has it: anchoring moves the window to the end
    // of the grown page by itself. That scroll keeps the window where the page means it to be, so the mark stays.
    const loaded = typeStillLoading();
    const screen = await renderReader('proposal');
    const height = Math.max(1400, document.documentElement.scrollHeight - placeOf('business-path') + 100);
    await page.viewport(DESKTOP.width, height);
    await expect.poll(() => window.innerHeight).toBe(height);
    await jumpTo(placeOf('the-first-release'));
    await expect.poll(marked).toEqual(['The first release (location)']);
    followContentsLink('business-path');
    const end = () => Math.round(document.documentElement.scrollHeight - window.innerHeight);
    await expect.poll(() => Math.round(window.scrollY)).toBe(end());
    await expect.poll(marked).toEqual(['Business path (location)']);
    await twoFrames();
    const before = Math.round(window.scrollY);
    swapType();
    await expect.poll(() => Math.round(window.scrollY), { message: 'anchoring kept the window at the end' }).toBe(end());
    expect(Math.round(window.scrollY), 'anchoring moved the window').toBeGreaterThan(before);
    loaded();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(marked(), 'after the type loaded').toEqual(['Business path (location)']);
    await screen.unmount();
  });

  it('a_click_or_a_key_that_doesnt_scroll_keeps_the_followed_mark', async () => {
    // Following "Business path" stops at the proposal's end, where it stays marked. A click elsewhere or a key that
    // doesn't scroll isn't the reader scrolling on: when the page next looks, the mark is still there.
    const screen = await renderReader('proposal');
    const height = Math.max(1400, document.documentElement.scrollHeight - placeOf('business-path') + 100);
    await page.viewport(DESKTOP.width, height);
    await expect.poll(() => window.innerHeight).toBe(height);
    await jumpTo(placeOf('the-first-release'));
    followContentsLink('business-path');
    await expect.poll(() => Math.round(window.scrollY)).toBe(Math.round(document.documentElement.scrollHeight - window.innerHeight));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.poll(marked).toEqual(['Business path (location)']);
    window.dispatchEvent(new PointerEvent('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    // Something that makes the page look again without the reader scrolling: a scroll coming to rest.
    window.dispatchEvent(new Event('scrollend'));
    await twoFrames();
    expect(marked(), 'after a click and a key').toEqual(['Business path (location)']);
    await screen.unmount();
  });

  it('a_contents_link_ends_an_addresss_keep', async () => {
    // Opened at "Characteristics" while the type loads, then "Limitations" followed by a click alone, as assistive
    // technology activates a link (no pointer or key events). Once the type loads, the page keeps Limitations, and
    // never goes back to Characteristics on the way.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    const screen = await renderReader('prediction', { hash: '#characteristics' });
    await expect.poll(() => Math.abs(offsetOf('characteristics'))).toBeLessThanOrEqual(1);
    followContentsLink('limitations');
    await expect.poll(() => Math.abs(offsetOf('limitations'))).toBeLessThanOrEqual(1);
    const visits: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
      visits.push(this.id);
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof Element.prototype.scrollIntoView;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    swapType();
    loaded();
    await expect.poll(() => Math.abs(offsetOf('limitations')), { message: 'kept at Limitations' }).toBeLessThanOrEqual(1);
    await twoFrames();
    expect(visits, 'sections the page moved to once the type loaded').not.toContain('characteristics');
    await screen.unmount();
  });

  it('a_reader_scrolling_during_a_correction_is_followed', async () => {
    // Following "Business path" stops at the proposal's end, where it stays marked. The type loads on a grown page and
    // the page follows the section to the new end; while that move is still settling, the reader scrolls up with the
    // wheel. The mark follows the reader, not the section the page was keeping.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    const screen = await renderReader('proposal');
    const height = Math.max(1400, document.documentElement.scrollHeight - placeOf('business-path') + 100);
    await page.viewport(DESKTOP.width, height);
    await expect.poll(() => window.innerHeight).toBe(height);
    await jumpTo(placeOf('the-first-release'));
    await expect.poll(marked).toEqual(['The first release (location)']);
    followContentsLink('business-path');
    const end = () => Math.round(document.documentElement.scrollHeight - window.innerHeight);
    await expect.poll(() => Math.round(window.scrollY)).toBe(end());
    await expect.poll(marked).toEqual(['Business path (location)']);
    await twoFrames();
    swapType();
    const corrected = new Promise<void>((resolve) => {
      const onScroll = () => {
        if (Math.round(window.scrollY) !== end()) return;
        window.removeEventListener('scroll', onScroll);
        resolve();
      };
      window.addEventListener('scroll', onScroll);
    });
    loaded();
    await corrected;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }));
    await jumpTo(placeOf('who-its-for-and-the-problem') + 100);
    // Where the reader stopped, the rule names another section than the one the page was keeping (which one depends on
    // the page's type and the window's height).
    const there = byTheRule();
    expect(there, 'the rule names another section where the reader stopped').not.toBe('Business path');
    await expect.poll(marked, { message: 'where the reader stopped' }).toEqual([`${there} (location)`]);
    await screen.unmount();
  });

  it('a_followed_section_keeps_its_place_while_the_type_loads', async () => {
    // Followed from the contents list before the type has loaded, a section that the swap moves after the jump has
    // arrived is back at its place once the type has loaded. The jump is instant under reduced motion.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    const screen = await renderReader('prediction');
    followContentsLink('limitations');
    await expect.poll(() => Math.abs(offsetOf('limitations'))).toBeLessThanOrEqual(1);
    await twoFrames();
    swapType();
    expect(offsetOf('limitations'), 'the swap moved the page').toBeGreaterThan(20);
    loaded();
    await expect.poll(() => Math.abs(offsetOf('limitations')), { message: 'once the type has loaded' }).toBeLessThanOrEqual(1);
    expect(document.activeElement, 'focus stays on the section').toBe(headingOf('limitations'));
    await screen.unmount();
  });

  it('going_back_returns_to_the_readers_place', async () => {
    // Opening a page, by a link or in place of the current one, starts it at its top. Back and Forward return to
    // where the reader last was in that document; a memory router has no browser to restore it, so the page alone
    // does. A tall page stands in for the Desk.
    await page.viewport(DESKTOP.width, DESKTOP.height);
    // The browser's scroll anchoring nudges the window when one document replaces the other; with it off, every
    // move is the reader's.
    document.documentElement.style.overflowAnchor = 'none';
    onTestFinished(() => {
      document.documentElement.style.overflowAnchor = '';
    });
    const screen = await render(
      <MemoryRouter initialEntries={['/about/proposal']}>
        <Routes>
          <Route path="/about/proposal" element={<ReaderPage id="proposal" />} />
          <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
          <Route path="/desk" element={<div style={{ height: '20000px' }} />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    const title = () => flat(document.querySelector('h1')?.textContent);
    /** Scrolls the window as a reader does, through to the scroll event the page hears. */
    const scrollTo = async (y: number) => {
      const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
      window.scrollTo(0, y);
      await scrolled;
      expect(window.scrollY).toBe(y);
    };
    await expect.poll(title).toBe('Product proposal');

    // Opening the other document starts it at its top.
    await scrollTo(2000);
    at.navigate?.('/about/prediction');
    await expect.poll(title).toBe('Capability prediction');
    expect(window.scrollY, 'opened').toBe(0);

    // Back and Forward return to where the reader was in each document.
    await scrollTo(1500);
    at.navigate?.(-1);
    await expect.poll(title).toBe('Product proposal');
    expect(window.scrollY, 'back').toBe(2000);
    at.navigate?.(1);
    await expect.poll(title).toBe('Capability prediction');
    expect(window.scrollY, 'forward').toBe(1500);

    // Back from another page draws the reader afresh, at the reader's place.
    at.navigate?.('/desk');
    await expect.poll(title).toBe('');
    await scrollTo(300);
    at.navigate?.(-1);
    await expect.poll(title).toBe('Capability prediction');
    expect(window.scrollY, 'back from the Desk').toBe(1500);

    // A scroll the page hears once the window's address has moved on belongs to the next page: Back restores the
    // Desk's place before the router draws the Desk. It leaves the reader's place where it was.
    const own = window.location.href;
    onTestFinished(() => window.history.replaceState(window.history.state, '', own));
    window.history.replaceState(window.history.state, '', '/app/desk/today');
    await scrollTo(0);
    window.history.replaceState(window.history.state, '', own);
    at.navigate?.('/desk');
    await expect.poll(title).toBe('');
    at.navigate?.(-1);
    await expect.poll(title).toBe('Capability prediction');
    expect(window.scrollY, 'after the address moved on').toBe(1500);

    // A page opened in place of the current one starts at its top.
    at.navigate?.('/about/proposal', { replace: true });
    await expect.poll(title).toBe('Product proposal');
    expect(window.scrollY, 'replaced').toBe(0);
    await screen.unmount();
  });

  it('a_new_address_for_the_same_document_keeps_the_readers_place', async () => {
    // Opened at `/about/proposal/`, the page's own link in the documents list moves the window to
    // `/about/proposal` and the same page stays drawn; the reader's place still counts from there.
    await page.viewport(DESKTOP.width, DESKTOP.height);
    document.documentElement.style.overflowAnchor = 'none';
    const own = window.location.href;
    onTestFinished(() => {
      document.documentElement.style.overflowAnchor = '';
      window.history.replaceState(window.history.state, '', own);
    });
    window.history.replaceState(window.history.state, '', '/about/proposal/');
    const screen = await render(
      <MemoryRouter initialEntries={['/about/proposal/']}>
        <Routes>
          <Route path="/about/proposal" element={<ReaderPage id="proposal" />} />
          <Route path="/desk" element={<div style={{ height: '20000px' }} />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    const title = () => flat(document.querySelector('h1')?.textContent);
    await expect.poll(title).toBe('Product proposal');

    window.history.replaceState(window.history.state, '', '/about/proposal');
    at.navigate?.('/about/proposal');
    await expect.poll(() => at.path).toBe('/about/proposal');
    const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
    window.scrollTo(0, 2500);
    await scrolled;

    at.navigate?.('/desk');
    await expect.poll(title).toBe('');
    at.navigate?.(-1);
    await expect.poll(title).toBe('Product proposal');
    expect(window.scrollY, 'back at the reader’s place').toBe(2500);
    await screen.unmount();
  });

  it('external_links_open_in_a_new_tab', async () => {
    for (const id of IDS) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const links = [...screen.container.querySelectorAll('a')];
        const external = links.filter((link) => /^https?:/.test(link.getAttribute('href') ?? ''));
        // The documents' sources, and the chart's.
        expect(external.length, where).toBeGreaterThan(5);
        for (const link of external) {
          expect(link.getAttribute('href')?.startsWith('https://'), link.href).toBe(true);
          expect(link.getAttribute('target'), link.href).toBe('_blank');
          expect(link.getAttribute('rel'), link.href).toBe('noopener noreferrer');
        }
        // Every other link stays in the app, in the same tab: the documents, the contents list and the link into the prototype.
        for (const link of links.filter((link) => !external.includes(link))) {
          expect(link.getAttribute('href'), where).toMatch(/^(?:\/|#)/);
          expect(link.getAttribute('target'), link.href).toBeNull();
        }
        await screen.unmount();
      }
    }
  });

  it('the_authors_name_links_to_their_profile', async () => {
    // The byline's name, beside the article or in the line under the summary on a phone, and the
    // footer's: each opens the author's LinkedIn profile in a new tab, with the words unchanged.
    const profile = 'https://www.linkedin.com/in/giovannialcantara/';
    for (const id of IDS) {
      for (const size of [DESKTOP, PHONE]) {
        const where = `${id} at ${size.width}`;
        const screen = await renderReader(id, { size });
        const root = screen.container;
        const meta =
          size === PHONE ? root.querySelector('[data-hero] [data-byline]') : root.querySelector('aside[aria-label="About this document"] dd');
        const footer = root.querySelector('[data-ds="concept-footer"]');
        for (const [part, words] of [
          [meta, /^Giovanni Alcantara(?: · |$)/],
          [footer, /^Concept prototype by Giovanni Alcantara, not an Anthropic product$/],
        ] as const) {
          expect(flat(part?.textContent), where).toMatch(words);
          const links = [...(part?.querySelectorAll('a') ?? [])];
          expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.target, link.rel]), where).toEqual([
            ['Giovanni Alcantara', profile, '_blank', 'noopener noreferrer'],
          ]);
        }
        await screen.unmount();
      }
    }
  });

  it('prototype_link_opens_your_desk_or_the_prototype', async () => {
    const cases = [
      { lastDesk: 'desk-rivera', size: DESKTOP, to: '/app/desk-rivera/today' },
      { lastDesk: 'desk-rivera', size: PHONE, to: '/app/desk-rivera/today' },
      { lastDesk: null, size: DESKTOP, to: '/' },
      { lastDesk: null, size: PHONE, to: '/' },
    ];
    for (const id of IDS) {
      for (const { lastDesk, size, to } of cases) {
        const where = `${id} at ${size.width}, last Desk ${lastDesk}`;
        document.title = 'Today · Claude Desk';
        const screen = await renderReader(id, { size, lastDesk });
        expect(document.title, where).toBe(`${PAGES[id].title} · Claude Desk`);
        // One link into the prototype, in the top bar, the same words at every width, never naming the
        // business, with the chat icon: to this browser's Desk when it has opened one.
        const back = [...(screen.container.querySelector('header')?.querySelectorAll('a') ?? [])].filter(
          (link) => !link.closest('nav'),
        );
        expect(back.map(readText), where).toEqual(['Try Desk prototype']);
        expect(back[0]?.querySelector('svg')?.innerHTML, where).toBe(CHAT_ICON);
        expect(back[0]?.getAttribute('href'), where).toBe(to);
        await userEvent.click(back[0] as HTMLElement);
        await expect.poll(() => at.path).toBe(to);
        await screen.unmount();
        // The tab's title is the one before.
        expect(document.title, where).toBe('Today · Claude Desk');
      }
    }
  });

  it('reader_is_noindex', async () => {
    const robots = () => [...document.head.querySelectorAll('meta[name="robots"]')].map((meta) => meta.getAttribute('content'));
    expect(robots()).toEqual([]);
    for (const id of IDS) {
      const screen = await renderReader(id);
      // Asked of search engines while the page is open, a best effort since the app serves one index.html.
      expect(robots(), id).toEqual(['noindex']);
      await screen.unmount();
      expect(robots(), id).toEqual([]);
    }
    // And while one document gives way to the other.
    const screen = await renderReader('proposal');
    await userEvent.click(screen.container.querySelector('nav[aria-label="About this prototype"] a[href="/about/prediction"]') as HTMLElement);
    await expect.poll(() => flat(screen.container.querySelector('h1')?.textContent)).toBe('Capability prediction');
    expect(robots()).toEqual(['noindex']);
    await screen.unmount();
    expect(robots()).toEqual([]);
  });

  it('the_top_bar_stays_while_reading', async () => {
    for (const size of [DESKTOP, PHONE]) {
      const where = `at ${size.width}`;
      const screen = await renderReader('prediction', { size });
      const bar = screen.container.querySelector('header') as HTMLElement;
      window.scrollTo(0, 2000);
      await expect.poll(() => window.scrollY, { message: where }).toBe(2000);
      // Part way down, the bar is still at the top of the window, in the Vision article's bar: its paper, all but
      // opaque.
      const box = bar.getBoundingClientRect();
      expect(box.top, where).toBe(0);
      expect(getComputedStyle(bar).backgroundColor, where).toBe('rgba(244, 242, 236, 0.94)');
      if (size === DESKTOP) {
        // The contents list stays below it.
        const contents = screen.container.querySelector('nav.cd-about-contents:not(.cd-about-contents--compact)');
        expect(contents?.getBoundingClientRect().top, where).toBeGreaterThanOrEqual(box.bottom);
      } else {
        // On a phone, the document switch under the bar scrolls away with the page.
        const documents = screen.container.querySelector('nav[aria-label="About this prototype"]');
        expect(documents?.getBoundingClientRect().bottom, where).toBeLessThan(0);
      }
      // A figure's marks scrolled under it stay under it.
      const stop = screen.container.querySelector('[data-stop][data-on]') as HTMLElement;
      const stopBox = stop.getBoundingClientRect();
      window.scrollBy(0, stopBox.top - box.height / 2);
      await expect.poll(() => Math.round(stop.getBoundingClientRect().top), { message: where }).toBeLessThan(box.bottom);
      const under = stop.getBoundingClientRect();
      expect(bar.contains(document.elementFromPoint(under.left + under.width / 2, under.top + under.height / 2)), where).toBe(true);
      // A section opened by its address sits below it.
      const section = screen.container.querySelector('article h2') as HTMLElement;
      section.scrollIntoView();
      await expect.poll(() => section.getBoundingClientRect().top, { message: where }).toBeGreaterThanOrEqual(box.bottom);
      await screen.unmount();
    }
  });

  it('keyboard_focus_stays_clear_of_the_top_bar', async () => {
    // On a phone the document switch sits under the bar and scrolls with the page: tabbing to it brings it out
    // from behind the bar.
    const screen = await renderReader('prediction', { size: PHONE });
    const bar = screen.container.querySelector('header') as HTMLElement;
    (screen.container.querySelector('.cd-about-try') as HTMLElement).focus();
    window.scrollTo(0, 50);
    await expect.poll(() => window.scrollY).toBe(50);
    await userEvent.tab();
    const focused = document.activeElement as HTMLElement;
    expect(focused.closest('nav[aria-label="About this prototype"]')).not.toBeNull();
    await expect.poll(() => focused.getBoundingClientRect().top).toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom);
    await screen.unmount();
  });

  it('keyboard_focus_on_the_paper_draws_no_ring', async () => {
    // Keyboard focus changes a control's own edge, never a ring outside it (owner, 2026-11-01), in the paper's
    // secondary ink: the bar's pills and the contents list's items show 1 px inside them, "Read next" 1 px over
    // its card's own border, and a link in the text turns its words and a 2 px underline the paper's ink.
    const screen = await renderReader('proposal', { size: DESKTOP });
    const root = screen.container.querySelector('.cd-about-paper--app') as HTMLElement;
    const edge = `${tokenColor('--line-focus', root)} 0px 0px 0px 1px inset`;
    expect(tokenColor('--line-focus', root)).toBe('rgb(92, 88, 80)');
    const keyboardFocus = async (el: HTMLElement) => {
      await userEvent.keyboard('{Shift}');
      el.focus();
      expect(el.matches(':focus-visible')).toBe(true);
    };

    const tryIt = screen.container.querySelector('.cd-about-try') as HTMLElement;
    const pill = screen.container.querySelector('nav[aria-label="About this prototype"] a') as HTMLElement;
    const item = screen.container.querySelector('.cd-about-contents__link') as HTMLElement;
    for (const [name, el] of [['Try Desk prototype', tryIt], ['a page pill', pill], ['a contents item', item]] as const) {
      await keyboardFocus(el);
      expect.soft([getComputedStyle(el).outlineStyle, getComputedStyle(el).boxShadow], name).toEqual(['none', edge]);
    }
    // A contents item reaches 8 px past its words on each side, so its edge clears the number, while the words
    // stay level with the list's own edge.
    const list = (item.closest('ol') as HTMLElement).getBoundingClientRect();
    const number = (item.querySelector('.cd-about-contents__number') as HTMLElement).getBoundingClientRect();
    const reach = item.getBoundingClientRect();
    expect([number.left - list.left, list.left - reach.left, reach.right - list.right]).toEqual([0, 8, 8]);

    const inText = screen.container.querySelector('article a.cd-text-link') as HTMLElement;
    await keyboardFocus(inText);
    const ink = tokenColor('--text-primary', root);
    const text = getComputedStyle(inText);
    expect([text.color, text.textDecorationLine, text.textDecorationThickness, text.textDecorationColor, text.boxShadow]).toEqual([ink, 'underline', '2px', ink, 'none']);

    const next = screen.container.querySelector('.cd-about-next__link') as HTMLElement;
    await keyboardFocus(next);
    const card = next.closest('.cd-card') as HTMLElement;
    const overlay = getComputedStyle(next, '::after');
    expect([getComputedStyle(next).outlineStyle, getComputedStyle(next).boxShadow, overlay.outlineStyle, overlay.boxShadow]).toEqual(['none', 'none', 'none', edge]);
    expect(overlay.borderTopLeftRadius).toBe(getComputedStyle(card).borderTopLeftRadius);
    // The overlay lies over the card's border box, so its edge is the card's border.
    const over = next.closest('.cd-about-next') as HTMLElement;
    expect(over.getBoundingClientRect().toJSON()).toEqual(card.getBoundingClientRect().toJSON());
    await screen.unmount();
  });

  it('read_next_darkens_its_border_on_hover', async () => {
    // The About pages' one exception to "hover is a fill" (owner, 2026-11-01): Read next darkens its border on
    // hover, as it always has, and keeps its fill.
    const screen = await renderReader('proposal', { size: DESKTOP });
    const root = screen.container.querySelector('.cd-about-paper--app') as HTMLElement;
    const over = screen.container.querySelector('.cd-about-next') as HTMLElement;
    const card = over.querySelector('.cd-card') as HTMLElement;
    over.scrollIntoView({ block: 'center' });
    const rest = { fill: getComputedStyle(card).backgroundColor, border: getComputedStyle(card).borderTopColor };
    const hoverLine = tokenColor('--line-control-hover', root);
    expect(rest.border).not.toBe(hoverLine);
    await userEvent.hover(over);
    expect(over.matches(':hover')).toBe(true);
    await expect.poll(() => getComputedStyle(card).borderTopColor).toBe(hoverLine);
    expect(getComputedStyle(card).backgroundColor).toBe(rest.fill);
    await screen.unmount();
  });

  it('tabbing_backwards_stays_clear_of_the_top_bar', async () => {
    const screen = await renderReader('proposal', { size: DESKTOP });
    const bar = screen.container.querySelector('header') as HTMLElement;
    const link = [...screen.container.querySelectorAll('article a')].find(
      (a) => a.getAttribute('href') === '/about/prediction',
    ) as HTMLElement;
    // From the next link down the article, with the page scrolled so that the link sits just under the bar.
    const links = [...screen.container.querySelectorAll('article a')];
    (links[links.indexOf(link) + 1] as HTMLElement).focus();
    window.scrollBy(0, link.getBoundingClientRect().top - 8);
    await expect.poll(() => Math.round(link.getBoundingClientRect().top)).toBeLessThan(bar.getBoundingClientRect().bottom);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(link);
    await expect.poll(() => link.getBoundingClientRect().top).toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom);
    await screen.unmount();
  });

  it('leaving_takes_noindex_and_the_title_away_at_once', async () => {
    // The next page finds neither the request to search engines nor the document's title in the commit that
    // draws it, however long the browser takes to paint.
    const robots = () => [...document.head.querySelectorAll('meta[name="robots"]')].map((meta) => meta.getAttribute('content'));
    const seen: { robots: (string | null)[]; title: string }[] = [];
    function NextPage() {
      useLayoutEffect(() => {
        seen.push({ robots: robots(), title: document.title });
      }, []);
      return <p>The next page</p>;
    }
    const before = 'Before · Claude Desk';
    document.title = before;
    const screen = await render(
      <MemoryRouter initialEntries={['/about/proposal']}>
        <Routes>
          <Route path="/about/proposal" element={<ReaderPage id="proposal" />} />
          <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
          <Route path="/next" element={<NextPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    await expect.poll(robots).toEqual(['noindex']);
    await expect.poll(() => document.title).toBe('Product proposal · Claude Desk');
    // One document gives way to the other: one tag, and the other document's title.
    at.navigate?.('/about/prediction');
    await expect.poll(() => document.title).toBe('Capability prediction · Claude Desk');
    expect(robots()).toEqual(['noindex']);

    at.navigate?.('/next');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toEqual({ robots: [], title: before });
    await screen.unmount();
  });

  it('contents_marks_the_section_being_read', async () => {
    // Beside the article, the list marks the section being read, and only that one.
    const screen = await renderReader('prediction');
    const contents = screen.container.querySelector('nav[aria-label="On this page"]') as HTMLElement;
    const bars = () => [...contents.querySelectorAll<HTMLElement>('[data-contents-bar]')];
    expect(marked(), 'at the top, before the first section').toEqual([]);
    expect(bars(), 'no bar before the first section').toEqual([]);
    for (const [anchor, name] of [
      ['limitations', 'Limitations'],
      ['readiness', 'Readiness'],
    ] as const) {
      await jumpTo(placeOf(anchor));
      await expect.poll(marked).toEqual([`${name} (location)`]);
      // Its words in text-primary, the others' in text-secondary.
      const links = [...contents.querySelectorAll<HTMLElement>('ol a')];
      const current = links.find((link) => link.getAttribute('aria-current')) as HTMLElement;
      expect(getComputedStyle(current).color, name).toBe(tokenColor('--text-primary', contents));
      for (const link of links.filter((link) => link !== current)) {
        expect(getComputedStyle(link).color, readText(link)).toBe(tokenColor('--text-secondary', contents));
      }
      // Not by colour alone: one 2 px bar in text-primary, in the gutter 12 px left of the list, beside the row's
      // words.
      expect(bars(), name).toHaveLength(1);
      const bar = bars()[0] as HTMLElement;
      expect(bar.getAttribute('aria-hidden'), name).toBe('true');
      expect(getComputedStyle(bar).backgroundColor, name).toBe(tokenColor('--text-primary', contents));
      const box = bar.getBoundingClientRect();
      const words = current.querySelector('span:not([aria-hidden])')?.getBoundingClientRect() as DOMRect;
      const list = contents.querySelector('ol')?.getBoundingClientRect() as DOMRect;
      expect({ width: box.width, left: box.left, top: box.top, bottom: box.bottom }, name).toEqual({
        width: 2,
        left: list.left - 12,
        top: words.top,
        bottom: words.bottom,
      });
    }
    await screen.unmount();

    // On a phone the folded list marks nothing, and its words stay as they were, in text-primary.
    const phone = await renderReader('prediction', { size: PHONE });
    await userEvent.click(phone.container.querySelector('nav[aria-label="On this page"] summary') as HTMLElement);
    await jumpTo(placeOf('limitations'));
    await twoFrames();
    expect(marked(), 'at 390').toEqual([]);
    const folded = phone.container.querySelector('nav[aria-label="On this page"]') as HTMLElement;
    expect(folded.querySelectorAll('[data-contents-bar]'), 'at 390').toHaveLength(0);
    for (const link of folded.querySelectorAll('ol a')) {
      expect(getComputedStyle(link).color, `at 390: ${readText(link)}`).toBe(tokenColor('--text-primary', folded));
    }
    await phone.unmount();
  });

  it('contents_mark_follows_a_jump_past_the_band', async () => {
    const screen = await renderReader('prediction');
    const line = window.innerHeight * 0.4;
    /** The window's offset that puts `anchor`'s heading `by` above the window's top. */
    const past = (anchor: string, by: number) => placeOf(anchor) + parseFloat(getComputedStyle(headingOf(anchor)).scrollMarginTop) + by;

    // From part way through "Why it's coming" to part way through "Limitations", in one jump: the headings in
    // between go from below the line to above the window, and no heading lands above the line, so nothing comes
    // into or leaves the band the observer watches. The mark follows once the scroll rests.
    await jumpTo(past('why-its-coming', 90));
    await expect.poll(marked).toEqual(['Why it’s coming (location)']);
    expect(headingOf('characteristics').getBoundingClientRect().top, 'the next heading starts below the line').toBeGreaterThan(line);
    const to = past('limitations', 190);
    expect(headingOf('readiness').getBoundingClientRect().top - (to - window.scrollY), 'the next heading lands below the line').toBeGreaterThan(line);
    await jumpTo(to);
    await expect.poll(marked).toEqual(['Limitations (location)']);

    // From Limitations' place to Readiness' place.
    await jumpTo(placeOf('limitations'));
    await expect.poll(marked).toEqual(['Limitations (location)']);
    await jumpTo(placeOf('readiness'));
    await expect.poll(marked).toEqual(['Readiness (location)']);
    await screen.unmount();

    // In a browser without `scrollend`, the page waits for the scroll to go still instead.
    let owner: object | null = window;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'onscrollend')) owner = Object.getPrototypeOf(owner);
    const descriptor = owner ? Object.getOwnPropertyDescriptor(owner, 'onscrollend') : undefined;
    expect(descriptor?.configurable, 'onscrollend can be hidden').toBe(true);
    delete (owner as { onscrollend?: unknown }).onscrollend;
    onTestFinished(() => {
      if (owner && descriptor) Object.defineProperty(owner, 'onscrollend', descriptor);
    });
    expect(typeof window.onscrollend).toBe('undefined');
    const without = await renderReader('prediction');
    await jumpTo(past('why-its-coming', 90));
    await expect.poll(marked).toEqual(['Why it’s coming (location)']);
    await jumpTo(past('limitations', 190));
    await expect.poll(marked, { message: 'without scrollend' }).toEqual(['Limitations (location)']);
    await without.unmount();
  });

  it('contents_marks_a_short_last_section', async () => {
    // A window tall enough that, scrolled to the page's end, the proposal's last heading is still below the line.
    const screen = await renderReader('proposal');
    const last = headingOf('the-prototype');
    const belowLast = document.documentElement.scrollHeight - (last.getBoundingClientRect().top + window.scrollY);
    const height = Math.max(1400, Math.ceil(belowLast / 0.6) + 100);
    await page.viewport(DESKTOP.width, height);
    await expect.poll(() => window.innerHeight).toBe(height);
    const line = height * 0.4;

    // A little short of the end, the section before the last is the one being read.
    const end = document.documentElement.scrollHeight - height;
    const before = headingOf('business-path');
    await jumpTo(end - 150);
    await expect.poll(marked).toEqual(['Business path (location)']);

    // At the page's end, the last section is the one being read, though its heading never reaches the line. It is
    // marked as the end comes into view, before the scroll rests, as for a reader still holding a touchpad: the
    // window's scroll-rest events are held back. No heading comes into the band above the line or leaves it.
    const holdBack = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener('scrollend', holdBack, { capture: true });
    onTestFinished(() => window.removeEventListener('scrollend', holdBack, { capture: true }));
    const scrolled = new Promise((resolve) => window.addEventListener('scroll', resolve, { once: true }));
    window.scrollTo({ top: end, behavior: 'instant' });
    await scrolled;
    expect(last.getBoundingClientRect().top, 'the last heading stays below the line').toBeGreaterThan(line);
    expect(before.getBoundingClientRect().top, 'the heading before it stays above the line').toBeGreaterThan(0);
    await expect.poll(marked, { message: 'before the scroll rests' }).toEqual(['The prototype (location)']);
    window.removeEventListener('scrollend', holdBack, { capture: true });

    // A jump to a section, then a small scroll up that takes its heading back below the line: the mark is the
    // section now above it.
    await jumpTo(placeOf('how-well-know-it-works'));
    await expect.poll(marked).toEqual(['How we’ll know it works (location)']);
    await jumpTo(window.scrollY - (line - headingOf('how-well-know-it-works').getBoundingClientRect().top) - 40);
    await expect.poll(marked).toEqual(['The first release (location)']);
    await screen.unmount();
  });

  it('a_followed_section_stays_marked_where_the_rule_cant_mark_it', async () => {
    // A window tall enough that following "Business path" stops at the proposal's end, short of its place, where the
    // 40% rule would mark the last section. The section followed stays marked until the reader scrolls on.
    const screen = await renderReader('proposal');
    const belowPlace = document.documentElement.scrollHeight - placeOf('business-path');
    const height = Math.max(1400, belowPlace + 100);
    await page.viewport(DESKTOP.width, height);
    await expect.poll(() => window.innerHeight).toBe(height);
    await jumpTo(placeOf('the-first-release'));
    await expect.poll(marked).toEqual(['The first release (location)']);

    followContentsLink('business-path');
    const end = document.documentElement.scrollHeight - window.innerHeight;
    await expect.poll(() => Math.round(window.scrollY)).toBe(Math.round(end));
    expect(placeOf('business-path'), 'the jump stops short of its place').toBeGreaterThan(end + 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(marked(), 'a moment after the jump').toEqual(['Business path (location)']);

    // The reader's own next scroll marks by the rule again.
    await jumpTo(0);
    await expect.poll(marked, { message: 'back at the top' }).toEqual([]);
    await screen.unmount();
  });

  it('contents_link_moves_focus_to_its_section', async () => {
    const own = window.location.href;
    onTestFinished(() => window.history.replaceState(window.history.state, '', own));
    const screen = await renderReader('prediction');
    const heading = headingOf('limitations');
    const link = screen.container.querySelector<HTMLElement>('nav[aria-label="On this page"] a[href="#limitations"]');
    expect(link?.getAttribute('href')).toBe('#limitations');
    // Where the heading is once the page has handled the click: a listener on the document hears it after the page's.
    let atClick = Number.NaN;
    const onClick = () => {
      atClick = heading.getBoundingClientRect().top;
    };
    document.addEventListener('click', onClick);
    onTestFinished(() => document.removeEventListener('click', onClick));

    // Followed from the keyboard, as a reader tabbing through the list does.
    link?.focus();
    await userEvent.keyboard('{Enter}');
    // The jump is instant: the heading is at its place, below the pinned bar, in the frame of the click.
    expect(getComputedStyle(heading).scrollMarginTop).toBe('88px');
    expect(Math.abs(atClick - 88), `the heading's top at the click: ${atClick}`).toBeLessThanOrEqual(1);
    expect(Math.abs(heading.getBoundingClientRect().top - 88)).toBeLessThanOrEqual(1);
    // Focus moves to the section's heading, which shows no ring; the address names the section.
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(heading.matches(':focus-visible'), 'focus came from the keyboard').toBe(true);
    expect([getComputedStyle(heading).outlineStyle, getComputedStyle(heading).boxShadow]).toEqual(['none', 'none']);
    // The router draws the new address in a transition, which a busy machine may not have drawn yet.
    await expect.poll(() => at.path).toBe('/about/prediction#limitations');
    // The next Tab goes on from the section, not from the top of the page.
    await userEvent.tab();
    expect(heading.compareDocumentPosition(document.activeElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.unmount();

    // On a phone too, from the folded list.
    const phone = await renderReader('proposal', { size: PHONE });
    await userEvent.click(phone.container.querySelector('nav[aria-label="On this page"] summary') as HTMLElement);
    await userEvent.click(phone.getByRole('link', { name: 'Why Anthropic', exact: true }));
    const why = headingOf('why-anthropic');
    expect(document.activeElement).toBe(why);
    expect(Math.abs(why.getBoundingClientRect().top - parseFloat(getComputedStyle(why).scrollMarginTop))).toBeLessThanOrEqual(1);
    await expect.poll(() => at.path).toBe('/about/proposal#why-anthropic');
    expect(marked(), 'the phone list marks nothing').toEqual([]);
    await phone.unmount();
  });
});
