/**
 * The About this prototype reading page in a real browser, inside a memory router: what it shows, that it
 * shows each document's words in full and in order, that it makes no request, and that it passes the copy
 * check and axe at the desktop and phone sizes. Expected words are written out here, never read from the
 * page's code.
 */
import axe from 'axe-core';
import { useLayoutEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { Icon } from '../ds/index.ts';
import { CONCEPT_FOOTER_TEXT, assertCleanCopy } from '../ds/test/copy.ts';
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
    summary: 'What Claude Desk is, who it’s for, what v1 enforces in code, and how we’ll know it works.',
    sections: [
      'The product',
      'Who it’s for and the problem',
      'Why Anthropic',
      'v1',
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

  it('top_bar_mark_keeps_its_white_tile', async () => {
    // The About pages' top bar is the one place the Claude Desk mark keeps its white tile, with the
    // drawing's dark ink on it (owner, 2026-10-30); everywhere else the bell has no tile.
    for (const size of [DESKTOP, PHONE]) {
      const where = `at ${size.width}`;
      const screen = await renderReader('proposal', { size });
      const mark = screen.container.querySelector('header svg.cd-mark');
      expect(mark, where).not.toBeNull();
      const tile = mark?.querySelector(':scope > rect');
      expect(tile, where).not.toBeNull();
      expect(getComputedStyle(tile as Element).fill, where).toBe('rgb(255, 255, 255)');
      expect(getComputedStyle(mark?.querySelector(':scope > g > g:last-child') as Element).fill, where).toBe('rgb(20, 20, 19)');
      await screen.unmount();
    }
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
        const documents = root.querySelector('nav[aria-label="Documents"]');
        expect(readText(documents ?? document.body), where).toBe('Capability prediction Product proposal');
        expect(readText(topBar ?? document.body), where).toMatch(phone ? /^Try Desk prototype Claude Desk Preview$/ : /Try Desk prototype$/);
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
      expect(flat(sentence?.textContent), where).toMatch(/^You’re in it\. The code is at owner: repo link\. Each visitor acts as Maria/);
      expect(sentence?.querySelector('.cd-pill')?.textContent, where).toBe('owner: repo link');
      expect(article?.textContent, where).not.toContain('enforced core, is at');
      await screen.unmount();
    }
    const prediction = await renderReader('prediction');
    expect(prediction.container.textContent).not.toContain('You’re in it');
    await prediction.unmount();
  });

  it('placeholders_show_as_pending', async () => {
    // The proposal's placeholders as the document has them, until they are filled: five in the measures table
    // and the two links in its last section.
    const PENDING = [
      'measured: tier 2 pass, with its 95% upper bound',
      'measured: held-out rate with its 95% interval',
      'measured: false-hold rate',
      'measured: …',
      'measured: …',
      'owner: repo link',
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

    // From the end of each page, "Read next" opens the other one at its top.
    for (const [next, expected] of [
      ['Product proposal', '/about/proposal'],
      ['Capability prediction', '/about/prediction'],
    ] as const) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.poll(() => window.scrollY).toBeGreaterThan(0);
      const card = screen.container.querySelector('[data-next-label]')?.closest('.cd-about-next');
      const link = card?.querySelector('a');
      expect(flat(link?.textContent)).toBe(next);
      expect(link?.getAttribute('href')).toBe(expected);
      await userEvent.click(link as HTMLElement);
      await expect.poll(title).toBe(next);
      expect(at.path).toBe(expected);
      await expect.poll(() => window.scrollY).toBe(0);
    }

    // The top bar's switch too, the page on show marked as current.
    const current = screen.container.querySelector('nav[aria-label="Documents"] [aria-current="page"]');
    expect(flat(current?.textContent)).toBe('Capability prediction');
    await userEvent.click(screen.container.querySelector('nav[aria-label="Documents"] a[href="/about/proposal"]') as HTMLElement);
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
    await userEvent.click(screen.container.querySelector('nav[aria-label="Documents"] a[href="/about/prediction"]') as HTMLElement);
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
      // Part way down, the bar is still at the top of the window, opaque.
      const box = bar.getBoundingClientRect();
      expect(box.top, where).toBe(0);
      expect(getComputedStyle(bar).backgroundColor, where).toBe(tokenColor('--bg-app'));
      if (size === DESKTOP) {
        // The contents list stays below it.
        const contents = screen.container.querySelector('nav.cd-about-contents:not(.cd-about-contents--compact)');
        expect(contents?.getBoundingClientRect().top, where).toBeGreaterThanOrEqual(box.bottom);
      } else {
        // On a phone, the document switch under the bar scrolls away with the page.
        const documents = screen.container.querySelector('nav[aria-label="Documents"]');
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
    expect(focused.closest('nav[aria-label="Documents"]')).not.toBeNull();
    await expect.poll(() => focused.getBoundingClientRect().top).toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom);
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
});
