/**
 * The Vision article's "On this page" list, in a real browser inside a memory router: the reading pages' own list,
 * beside the article at a laptop's width, where it stays pinned and marks the section being read, and folded into
 * one row at the top on a phone. Following a link moves to its section. Also the cover band's phone headers, one
 * colour for each business, and the top bar's Claude Desk lockup, drawn as the reading pages draw it. Expected words are written out here, never read from the page's code.
 */
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { contrastRatio } from '../../ds/contrast.ts';
import { tokenColor } from '../../test/screen.ts';
import { ReaderPage } from '../ReaderPage.tsx';
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

  it('each_business_has_its_own_header_colour', async () => {
    const screen = await renderVision();
    // The cover band's three chats, in its order: Meridian Bay Permits, Sam Patel's Desk at Lumen Labs, Turner Plumbing.
    const heads = [...document.querySelectorAll<HTMLElement>('[data-cover] [data-screen-head]')];
    expect(heads.map((head) => flat(head.querySelector('.ph-name')?.textContent))).toEqual([
      'Meridian Bay Permits',
      'Sam Patel’s Desk',
      'Turner Plumbing',
    ]);
    const colours = heads.map((head) => getComputedStyle(head).backgroundColor);
    expect(new Set(colours).size, colours.join(', ')).toBe(3);
    for (const head of heads) {
      // The header's words hold 4.5:1 on its colour.
      const name = flat(head.querySelector('.ph-name')?.textContent);
      expect(contrastRatio(getComputedStyle(head).color, getComputedStyle(head).backgroundColor), name).toBeGreaterThanOrEqual(4.5);
    }
    // The same business keeps its colour wherever its screen is drawn: in the article and on its card.
    const byName = new Map(heads.map((head) => [flat(head.querySelector('.ph-name')?.textContent), getComputedStyle(head).backgroundColor]));
    for (const head of document.querySelectorAll<HTMLElement>('article [data-screen-head]')) {
      const name = flat(head.querySelector('.ph-name')?.textContent);
      expect(getComputedStyle(head).backgroundColor, name).toBe(byName.get(name));
    }
    await screen.unmount();
  });

  it('the_top_bar_carries_the_reading_pages_lockup', async () => {
    // The bell and "Claude Desk", with the Preview badge on a laptop, in the same place and at the same size as on
    // the reading pages: at the bar's left on a laptop, at its right on a phone.
    const lockup = () => {
      const brand = document.querySelector('header .cd-about-brand');
      if (!brand) return null;
      const box = brand.getBoundingClientRect();
      return {
        words: readText(brand),
        bell: brand.querySelector('svg.cd-mark')?.getAttribute('width'),
        box: [box.left, box.top, box.width, box.height].map(Math.round),
      };
    };
    for (const size of [DESKTOP, PHONE]) {
      const where = `at ${size.width}`;
      const vision = await renderVision(size);
      const onVision = lockup();
      await vision.unmount();
      await page.viewport(size.width, size.height);
      const reader = await render(
        <MemoryRouter initialEntries={['/about/prediction']}>
          <Routes>
            <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
          </Routes>
        </MemoryRouter>,
      );
      const onReader = lockup();
      await reader.unmount();
      expect(onVision, where).not.toBeNull();
      expect(onVision?.words, where).toBe(size === DESKTOP ? 'Claude Desk Preview' : 'Claude Desk');
      expect(onVision?.bell, where).toBe(size === DESKTOP ? '36' : '32');
      expect(onVision, where).toEqual(onReader);
      if (size === DESKTOP) expect(onVision?.box[0], where).toBe(80);
      else expect((onVision?.box[0] ?? 0) + (onVision?.box[2] ?? 0), where).toBe(size.width - 16);
    }
  });
  it('the_hero_opens_with_the_reading_pages_app_icon', async () => {
    // The Claude Desk app icon the reading pages open with (owner, 2026-11-02): the same tile at the same size, first in
    // the hero, the same gap above the meta line, centred on a laptop and at the hero's left edge on a phone, where the
    // Vision article's headline block sits to the left. Decorative: the bar names the product.
    const opening = () => {
      const hero = document.querySelector<HTMLElement>('.va-hero') ?? document.querySelector<HTMLElement>('[data-hero]');
      const icon = hero?.querySelector<HTMLElement>('.cd-mark-app-icon');
      const meta = hero?.querySelector('[data-meta], .cd-about-hero__kicker');
      if (!hero || !icon || !meta) return null;
      const box = icon.getBoundingClientRect();
      const title = (hero.querySelector('h1') as Element).getBoundingClientRect();
      return {
        first: hero.firstElementChild === icon,
        hidden: icon.getAttribute('aria-hidden'),
        size: [Math.round(box.width), Math.round(box.height)],
        radius: getComputedStyle(icon).borderTopLeftRadius,
        gap: Math.round(meta.getBoundingClientRect().top - box.bottom),
        centred: Math.abs(box.left + box.width / 2 - (title.left + title.width / 2)) <= 0.5,
        left: Math.round(box.left - hero.getBoundingClientRect().left - parseFloat(getComputedStyle(hero).paddingLeft)),
      };
    };
    for (const size of [DESKTOP, PHONE]) {
      const where = `at ${size.width}`;
      const vision = await renderVision(size);
      const onVision = opening();
      await vision.unmount();
      await page.viewport(size.width, size.height);
      const reader = await render(
        <MemoryRouter initialEntries={['/about/prediction']}>
          <Routes>
            <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
          </Routes>
        </MemoryRouter>,
      );
      const onReader = opening();
      await reader.unmount();
      expect(onVision, `${where}: an app icon in the hero`).not.toBeNull();
      expect(onVision?.first, where).toBe(true);
      expect(onVision?.hidden, where).toBe('true');
      expect([onVision?.size, onVision?.radius, onVision?.gap], where).toEqual([onReader?.size, onReader?.radius, onReader?.gap]);
      if (size === DESKTOP) expect(onVision?.centred, where).toBe(true);
      else expect(onVision?.left, where).toBe(0);
    }
  });
});
