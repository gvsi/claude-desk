/**
 * The Vision article's "On this page" list, in a real browser inside a memory router: the reading pages' own list,
 * beside the article at a laptop's width, where it stays pinned and marks the section being read, and folded into
 * one row at the top on a phone. Following a link moves to its section. Also the opening trio's phone headers, one
 * colour for each business. Expected words are written out here, never read from the page's code.
 */
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { tokenColor } from '../../test/screen.ts';
import { VisionArticle } from './VisionArticle.tsx';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The article's sections in its order, each with the anchor its heading carries. */
const SECTIONS = [
  ['A city office that answers after hours', 'a-city-office-that-answers-after-hours'],
  ['A Desk for everyone at work', 'a-desk-for-everyone-at-work'],
  ['Recognized, with your permission', 'recognized-with-your-permission'],
  ['In your pocket', 'in-your-pocket'],
  ['What stays the same', 'what-stays-the-same'],
  ['See each one up close', 'vision-pages'],
] as const;

/** Where the memory router is, and a way to move it. */
const at: { path: string; navigate: NavigateFunction | null } = { path: '', navigate: null };

function LocationProbe() {
  const location = useLocation();
  at.path = `${location.pathname}${location.hash}`;
  at.navigate = useNavigate();
  return null;
}

async function renderVision(size = DESKTOP) {
  await page.viewport(size.width, size.height);
  const own = window.location.href;
  onTestFinished(() => window.history.replaceState(window.history.state, '', own));
  return render(
    <MemoryRouter initialEntries={['/about/vision']}>
      <Routes>
        <Route path="/about/vision" element={<VisionArticle />} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(async () => {
  await page.viewport(DESKTOP.width, DESKTOP.height);
});

/** Text with its whitespace collapsed, as a person reads it. */
function flat(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** What a screen reader reads of `el`: its text outside `aria-hidden` subtrees. */
function readText(el: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
    return [...node.childNodes].map(walk).join(' ');
  };
  return flat(walk(el));
}

function contents(): HTMLElement {
  const nav = document.querySelector<HTMLElement>('nav[aria-label="On this page"]');
  if (!nav) throw new Error('no "On this page" list');
  return nav;
}

/** The list's links marked as the section being read, as "name (aria-current)". */
function marked(): string[] {
  return [...contents().querySelectorAll('a[aria-current]')].map((link) => `${readText(link)} (${link.getAttribute('aria-current')})`);
}

/** The window's offset at which the section's heading sits at the top, below its scroll margin. */
function placeOf(anchor: string): number {
  const heading = document.getElementById(anchor);
  if (!heading) throw new Error(`no section #${anchor}`);
  return Math.round(heading.getBoundingClientRect().top + window.scrollY - parseFloat(getComputedStyle(heading).scrollMarginTop));
}

/** Moves the window to `y` in one jump and waits for it to rest. */
async function jumpTo(y: number): Promise<void> {
  const top = Math.min(y, document.documentElement.scrollHeight - window.innerHeight);
  if (Math.round(window.scrollY) === top) return;
  const rested = new Promise((resolve) => window.addEventListener('scrollend', resolve, { once: true }));
  window.scrollTo({ top, behavior: 'instant' });
  await rested;
}

describe('The Vision article’s contents', () => {
  it('lists_its_sections_on_this_page', async () => {
    for (const size of [DESKTOP, PHONE]) {
      const where = `at ${size.width}`;
      const screen = await renderVision(size);
      const nav = contents();
      expect(screen.container.querySelectorAll('nav[aria-label="On this page"]'), where).toHaveLength(1);
      const links = [...nav.querySelectorAll('ol a')];
      expect(
        links.map((link) => [readText(link), link.getAttribute('href')]),
        where,
      ).toEqual(SECTIONS.map(([name, anchor]) => [name, `#${anchor}`]));
      // Each link's anchor is its section's: the heading carries it, or for the cards their section, which holds it.
      for (const [name, anchor] of SECTIONS) {
        const target = document.getElementById(anchor);
        const heading = target?.matches('h2') ? target : target?.querySelector('h2');
        expect(flat(heading?.textContent), `${where}: #${anchor}`).toBe(name);
        expect(target?.closest('article'), `${where}: #${anchor} is in the article`).not.toBeNull();
      }
      await screen.unmount();
    }
  });

  it('the_side_list_is_pinned_beside_the_article_and_marks_the_section_being_read', async () => {
    const screen = await renderVision();
    const nav = contents();
    expect(nav.classList.contains('cd-about-contents--side')).toBe(true);
    expect(nav.querySelector('details')).toBeNull();
    expect(marked(), 'at the top, before the first section').toEqual([]);

    // The list starts level with the article's first words, after the cover band, and is pinned below the top bar
    // while the article scrolls.
    const band = document.querySelector('[data-cover]')?.getBoundingClientRect() as DOMRect;
    const intro = document.querySelector('.va-body--intro .va-p')?.getBoundingClientRect() as DOMRect;
    expect(nav.getBoundingClientRect().top).toBeGreaterThanOrEqual(band.bottom);
    expect(Math.abs(nav.getBoundingClientRect().top - intro.top)).toBeLessThanOrEqual(8);
    // At the reading pages' place: the left gutter, the side column's width.
    expect(nav.getBoundingClientRect().left).toBe(80);
    expect(nav.getBoundingClientRect().width).toBe(200);

    for (const [name, anchor] of [SECTIONS[1], SECTIONS[3], SECTIONS[5]]) {
      await jumpTo(placeOf(anchor));
      await expect.poll(marked, { message: name }).toEqual([`${name} (location)`]);
      expect(Math.round(nav.getBoundingClientRect().top), `${name}: pinned under the top bar`).toBe(64 + 24);
      // Its words in text-primary, the others' in text-secondary, and one bar beside the marked row.
      const links = [...nav.querySelectorAll<HTMLElement>('ol a')];
      const current = links.find((link) => link.getAttribute('aria-current')) as HTMLElement;
      expect(getComputedStyle(current).color, name).toBe(tokenColor('--text-primary', nav));
      for (const link of links.filter((link) => link !== current)) {
        expect(getComputedStyle(link).color, readText(link)).toBe(tokenColor('--text-secondary', nav));
        expect(getComputedStyle(link).textDecorationLine, readText(link)).toBe('none');
      }
      expect(nav.querySelectorAll('[data-contents-bar]'), name).toHaveLength(1);
    }

    await screen.unmount();
  });

  it('the_side_list_stays_clear_of_the_article_at_every_laptop_width', async () => {
    // Clear of everything in the article beside it, its text, its phones and their captions, and the cards, down to
    // the About set's breakpoint, with the page no wider than the window.
    for (const width of [1440, 1336, 1200, 1100]) {
      const screen = await renderVision({ width, height: 900 });
      const right = contents().getBoundingClientRect().right;
      for (const el of document.querySelectorAll('article :is(.va-p, .va-h2, .va-phone, .va-cap, .va-quote, .va-card)')) {
        if (el.closest('[data-cover]')) continue;
        expect(el.getBoundingClientRect().left, `at ${width}, ${el.className}: ${flat(el.textContent).slice(0, 40)}`).toBeGreaterThanOrEqual(right + 40);
      }
      expect(document.documentElement.scrollWidth, `at ${width}`).toBe(document.documentElement.clientWidth);
      await screen.unmount();
    }
  });

  it('the_list_folds_into_one_row_at_the_top_on_a_phone', async () => {
    const screen = await renderVision(PHONE);
    const nav = contents();
    expect(nav.classList.contains('cd-about-contents--compact')).toBe(true);
    const summary = nav.querySelector('summary') as HTMLElement;
    expect(readText(summary)).toBe('On this page 6 sections');
    expect(nav.querySelector('details')?.open, 'closed at first').toBe(false);
    // After the headline and the note, above the article's first words.
    const note = document.querySelector('.va-note')?.getBoundingClientRect() as DOMRect;
    const intro = document.querySelector('.va-body--intro .va-p')?.getBoundingClientRect() as DOMRect;
    const box = nav.getBoundingClientRect();
    expect(box.top).toBeGreaterThan(note.bottom);
    expect(box.bottom).toBeLessThan(intro.top);
    // On the article's column: its edges are the text's.
    expect(Math.round(box.left)).toBe(Math.round(intro.left));
    expect(Math.round(box.right)).toBe(Math.round(intro.right));

    expect(document.documentElement.scrollWidth, 'no wider than the window').toBe(document.documentElement.clientWidth);

    await userEvent.click(summary);
    expect(nav.querySelector('details')?.open).toBe(true);
    // The folded list marks nothing, and its words are in text-primary, not the article's link colour.
    for (const link of nav.querySelectorAll('ol a')) {
      expect(getComputedStyle(link).color, readText(link)).toBe(tokenColor('--text-primary', nav));
      expect(getComputedStyle(link).textDecorationLine, readText(link)).toBe('none');
    }

    // Following a link moves to its section and focus with it.
    await userEvent.click(screen.getByRole('link', { name: 'In your pocket', exact: true }));
    const pocket = document.getElementById('in-your-pocket') as HTMLElement;
    expect(document.activeElement).toBe(pocket);
    expect(Math.abs(pocket.getBoundingClientRect().top - parseFloat(getComputedStyle(pocket).scrollMarginTop))).toBeLessThanOrEqual(1);
    await expect.poll(() => at.path).toBe('/about/vision#in-your-pocket');
    expect(marked(), 'the phone list marks nothing').toEqual([]);
    await screen.unmount();
  });

  it('a_contents_link_moves_to_its_section_and_focus_with_it', async () => {
    const screen = await renderVision();
    for (const [name, anchor] of [SECTIONS[2], SECTIONS[5]]) {
      const link = contents().querySelector<HTMLElement>(`a[href="#${anchor}"]`) as HTMLElement;
      link.focus();
      await userEvent.keyboard('{Enter}');
      const section = document.getElementById(anchor) as HTMLElement;
      // Below the pinned bar, focus on the section, which draws no ring; the address names it; the list marks it.
      expect(getComputedStyle(section).scrollMarginTop, name).toBe('88px');
      expect(Math.abs(section.getBoundingClientRect().top - 88), name).toBeLessThanOrEqual(1);
      expect(document.activeElement, name).toBe(section);
      expect(section.getAttribute('tabindex'), name).toBe('-1');
      expect([getComputedStyle(section).outlineStyle, getComputedStyle(section).boxShadow], name).toEqual(['none', 'none']);
      await expect.poll(() => at.path, { message: name }).toBe(`/about/vision#${anchor}`);
      await expect.poll(marked, { message: name }).toEqual([`${name} (location)`]);
    }
    await screen.unmount();
  });
});
