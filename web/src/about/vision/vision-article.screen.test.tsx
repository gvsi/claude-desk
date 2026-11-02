/**
 * The Vision article at its own address, in the whole app against the mock API: a long-form page under About
 * this prototype with four phone screens drawn inline. Expected words are written out here, never read from the
 * page's code.
 */
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { userEvent } from 'vitest/browser';

import { contrastRatio } from '../../ds/contrast.ts';
import { FONT_SHEET_URL, loadWebFonts } from '../../ds/test/fonts.ts';
import { writeLocal } from '../../lib/storage.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const PATH = '/about/vision';
const HEADLINE = 'A front desk that never closes';
const DEK =
  'Today a Desk answers for one plumber in Oakland. The same idea fits a city permit office, a team in the field, a customer who’s already signed in and an owner who’s never at a desk. Here’s what that could look like, and the rules that wouldn’t change.';
const NOTE = 'Vision, not the prototype. Nothing on this page is live.';
const END_NOTE = 'Vision, not in the prototype. Nothing on this page is live; the businesses and people are fictional.';
const FIRST_WORDS = /^Most of the questions a business gets are the same questions/;

// The About pages' reading speed: 230 words a minute, rounded, and at least one.
const WORDS_PER_MINUTE = 230;

/**
 * The four screens in the order the article shows them: each one's label, its caption's lead, and the line in its
 * header that says Claude, an AI, is answering. The owner's phone is her own app, which no visitor sees.
 */
const FIGURES = [
  {
    label: 'A resident’s phone: the Meridian Bay Permit Center’s Desk shows his permit status in a card and hands a fee waiver to staff.',
    lead: 'Marcus checks his remodel at 11 pm.',
    ai: 'You’re chatting with Claude, an AI answering for the Permit Center.',
  },
  {
    label: 'A plumber’s phone: the team Desk shows his job card with the gate code and declines to share a colleague’s pay.',
    lead: 'Luis, between jobs.',
    ai: 'Claude, an AI, answers the team under Mike’s rules.',
  },
  {
    label: 'A returning customer’s phone: she confirms it’s her with her Claude account, for this visit only, and her invoice opens.',
    lead: 'Dana comes back for her invoice.',
    ai: 'You’re chatting with Claude, an AI answering for Turner Plumbing.',
  },
  {
    label: 'The owner’s phone: a held discount request waits for his answer, with Allow this time and Deny this time.',
    lead: 'A request waits for Mike.',
    ai: null,
  },
] as const;

/** The picture cards after "What stays the same": each idea's name and line, word for word, and its vision page. */
const CARDS_HEADING = 'See each one up close';
const CARDS_LEAD = 'Each idea has its own page, drawn as it would work.';
const CARDS = [
  { name: 'A city office that answers after hours', line: 'Meridian Bay Permits, after five', href: '/vision/city-office' },
  { name: 'A Desk for the team', line: 'Turner Plumbing’s plumbers, from the van', href: '/vision/team-desk' },
  { name: 'Recognized, with your permission', line: 'Dana, signed in with her Claude account', href: '/vision/claude-account' },
  { name: 'In your pocket', line: 'Mike’s requests on his phone', href: '/vision/phone' },
] as const;

/**
 * The words a reader reads in `root`: its text, but what is hidden from everyone (`aria-hidden`) and the
 * elements `skip` names, each text node a run of its own so that two blocks never join into one word.
 */
function readWords(root: Element, skip: Element[] = []): number {
  const runs: string[] = [];
  const walk = (node: Node) => {
    if (node instanceof Element && (node.getAttribute('aria-hidden') === 'true' || skip.includes(node))) return;
    if (node.nodeType === Node.TEXT_NODE) runs.push(node.textContent ?? '');
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return runs.join(' ').split(/\s+/).filter(Boolean).length;
}

/** The text of `el` with its whitespace collapsed. */
function flat(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A phone as the page draws it, in the page's pixels after any scaling: the frame's and the screen's boxes, the
 * bezel's width at the left, the right and the top, and the frame's and the screen's radius at the two top corners.
 */
function measurePhone(phone: Element) {
  const screen = phone.querySelector('.va-screen');
  if (!(phone instanceof HTMLElement) || !(screen instanceof HTMLElement)) throw new Error('not a drawn phone');
  const frame = phone.getBoundingClientRect();
  const inner = screen.getBoundingClientRect();
  const scale = frame.width / phone.offsetWidth;
  const radius = (el: Element, corner: 'borderTopLeftRadius' | 'borderTopRightRadius') => parseFloat(getComputedStyle(el)[corner]) * scale;
  return {
    frame,
    screen: inner,
    bezel: { left: inner.left - frame.left, right: frame.right - inner.right, top: inner.top - frame.top },
    corners: (['borderTopLeftRadius', 'borderTopRightRadius'] as const).map((corner) => ({
      frame: radius(phone, corner),
      screen: radius(screen, corner),
    })),
  };
}

afterEach(() => {
  writeLocal('lastDesk', null);
});

describe('The Vision article', () => {
  it('the_article_renders_at_its_route', async () => {
    const { screen } = await renderRoute(PATH);
    await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
    await expect.element(screen.getByText(DEK, { exact: true })).toBeVisible();
    // The note under the dek and the end note say it's vision, not the prototype.
    await expect.element(screen.getByText(NOTE, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(END_NOTE, { exact: true })).toBeVisible();

    // The meta line's read time is the article's words at the About pages' speed: its own text and the words
    // on its screens, but not the meta line itself or the decorative cover.
    const article = screen.getByRole('article').element();
    const meta = article.querySelector('[data-meta]');
    expect(meta, 'the meta line is in the article').not.toBeNull();
    const words = readWords(article, meta ? [meta] : []);
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    expect(flat(meta)).toBe(`Vision October 30, 2026 ${minutes} min read`);
    expect(meta?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-30');
  });

  it('each_screen_is_a_labelled_picture_with_a_caption', async () => {
    const { screen } = await renderRoute(PATH);
    await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();

    // A screen reader meets four pictures, one per screen, each read by its label; the cover's copies are hidden.
    expect(screen.getByRole('img').elements().map((img) => img.getAttribute('aria-label'))).toEqual(FIGURES.map(({ label }) => label));
    const figures = [...screen.getByRole('article').element().querySelectorAll('figure')];
    expect(figures).toHaveLength(FIGURES.length);
    for (const [i, figure] of figures.entries()) {
      const { label, lead } = FIGURES[i] ?? FIGURES[0];
      // A figure holds the picture, then its caption, which names the figure.
      const [picture, caption] = [...figure.children];
      expect(picture?.getAttribute('role'), label).toBe('img');
      expect(picture?.getAttribute('aria-label'), label).toBe(label);
      expect(caption?.localName, label).toBe('figcaption');
      expect(flat(caption).startsWith(`${lead} `), label).toBe(true);
      await expect.element(screen.getByRole('figure', { name: flat(caption), exact: true })).toBeVisible();
      // What the screen shows is real text, not an image of it.
      expect(readWords(picture ?? figure), label).toBeGreaterThan(40);
    }
  });

  it('the_screens_keep_the_honesty_rules', async () => {
    const { screen } = await renderRoute(PATH);
    await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
    const pictures = FIGURES.map(({ label }) => screen.getByRole('img', { name: label, exact: true }).element());

    // Every screen a visitor or the team reads says, in its header and above the chat, that Claude, an AI, is
    // answering.
    for (const [i, { label, ai }] of FIGURES.entries()) {
      if (ai === null) continue;
      const picture = pictures[i];
      const line = [...(picture?.querySelectorAll('p, div') ?? [])].find((el) => flat(el) === ai);
      expect(line, label).toBeDefined();
      expect(line?.closest('[data-screen-head]'), label).not.toBeNull();
      const chat = picture?.querySelector('[data-part]');
      expect(line?.getBoundingClientRect().bottom ?? Infinity, label).toBeLessThanOrEqual(chat?.getBoundingClientRect().top ?? -Infinity);
    }

    // Prices, percentages, times, dates and codes sit in cards; Claude's own words state none of them.
    const FACT = new RegExp(
      [
        String.raw`\$\d`,
        String.raw`\d%`,
        String.raw`\b\d{1,2}:\d{2}\b`,
        String.raw`\d{4,}`,
        String.raw`\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b`,
        String.raw`\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b`,
      ].join('|'),
    );
    expect(['$153.00', '15%', '10:30 am', 'B-2026-0412', 'Tuesday, October 20'].every((fact) => FACT.test(fact))).toBe(true);
    let facts = 0;
    for (const picture of pictures) {
      const walker = document.createTreeWalker(picture ?? document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!FACT.test(node.textContent ?? '')) continue;
        facts += 1;
        expect(node.parentElement?.closest('[data-part="card"]'), node.textContent ?? '').not.toBeNull();
      }
      for (const words of picture?.querySelectorAll('[data-part="claude"]') ?? []) expect(flat(words)).not.toMatch(FACT);
    }
    expect(facts, 'the cards hold the facts the test looks for').toBeGreaterThanOrEqual(6);

    // Statuses too: the permit's status is the card's to state, and Claude's words in the city screen only point to it.
    const city = pictures[0];
    const inCards = [...(city?.querySelectorAll('[data-part="card"] *') ?? [])].map(flat);
    expect(inCards).toContain('Plan check passed');
    const claude = [...(city?.querySelectorAll('[data-part="claude"]') ?? [])].map(flat);
    expect(claude.length).toBeGreaterThan(0);
    for (const words of claude) expect(words).not.toMatch(/passed|plan check/i);

    // A held or declined outcome is a receipt right under Claude's message, as the app draws it.
    const outcomes = pictures.flatMap((picture) => [...(picture?.querySelectorAll('[data-part="receipt"]') ?? [])]);
    const heldOrDeclined = outcomes.filter((receipt) => ['held', 'declined'].includes(receipt.getAttribute('data-tone') ?? ''));
    expect(heldOrDeclined.map(flat)).toEqual([
      'Held for a person: waivers are decided by staff.',
      'Declined by team access. No pay was shared.',
    ]);
    for (const receipt of heldOrDeclined) {
      const message = receipt.previousElementSibling;
      expect(message?.getAttribute('data-part'), flat(receipt)).toBe('claude');
      expect(receipt.getBoundingClientRect().top).toBeGreaterThanOrEqual(message?.getBoundingClientRect().bottom ?? Infinity);
    }
  });

  it('picture_cards_link_each_vision_page', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PATH, { viewport });
      const heading = screen.getByRole('heading', { level: 2, name: CARDS_HEADING, exact: true });
      await expect.element(heading, { message: viewport }).toBeVisible();
      const section = screen.getByRole('region', { name: CARDS_HEADING, exact: true });
      await expect.element(section.getByText(CARDS_LEAD, { exact: true }), { message: viewport }).toBeVisible();

      // After "What stays the same" and its last words, inside the article, before the end note.
      const lastWords = screen.getByText(/^What changes is how much a Desk can handle before it has to ask\./).element();
      const box = section.element().getBoundingClientRect();
      expect(section.element().closest('article'), viewport).not.toBeNull();
      expect(box.top, viewport).toBeGreaterThanOrEqual(lastWords.getBoundingClientRect().bottom);
      expect(box.bottom, viewport).toBeLessThanOrEqual(screen.getByText(END_NOTE, { exact: true }).element().getBoundingClientRect().top);

      // Four cards, each one link named by its idea and line, not by the phone drawn in it, to its vision page.
      const links = section.getByRole('link').elements();
      expect(links.map((link) => link.getAttribute('href')), viewport).toEqual(CARDS.map(({ href }) => href));
      for (const [i, { name, line, href }] of CARDS.entries()) {
        const where = `${name} at ${viewport}`;
        const link = section.getByRole('link', { name: `${name} ${line}`, exact: true });
        await expect.element(link, { message: where }).toHaveAttribute('href', href);
        expect(link.element(), where).toBe(links[i]);
        expect(link.element().getAttribute('target'), where).toBeNull();
        // The top of the idea's phone, first in the card, is hidden from screen readers and labels nothing.
        const top = link.element().firstElementChild;
        expect(top?.getAttribute('aria-hidden'), where).toBe('true');
        expect(top?.querySelector('.va-phone'), where).not.toBeNull();
        expect(top?.querySelectorAll('[role], [aria-label]'), where).toHaveLength(0);
        // On a phone a visitor or the team reads, the line saying Claude, an AI, is answering shows in the card.
        const ai = FIGURES[i]?.ai;
        if (ai) {
          const aiLine = [...(top?.querySelectorAll('p') ?? [])].find((p) => flat(p) === ai);
          expect(aiLine, where).toBeDefined();
          expect(aiLine?.getBoundingClientRect().bottom ?? Infinity, where).toBeLessThanOrEqual(top?.getBoundingClientRect().bottom ?? -Infinity);
        }
      }

      // Two by two at every width, the pairs side by side and level, in the article's column.
      const [a, b, c, d] = links.map((link) => link.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect, DOMRect];
      expect([b.top, d.top], viewport).toEqual([a.top, c.top]);
      expect([c.left, d.left], viewport).toEqual([a.left, b.left]);
      expect(b.left, viewport).toBeGreaterThan(a.right);
      expect(c.top, viewport).toBeGreaterThan(Math.max(a.bottom, b.bottom));
      const column = screen.getByText(FIRST_WORDS).element().getBoundingClientRect();
      expect(a.left, viewport).toBeGreaterThanOrEqual(column.left - 0.5);
      expect(b.right, viewport).toBeLessThanOrEqual(column.right + 0.5);
      expectNoHorizontalScroll();
    }

    // Followed, a card opens its vision page in the app.
    const { screen, router } = await renderRoute(PATH);
    await screen.getByRole('link', { name: `${CARDS[0].name} ${CARDS[0].line}`, exact: true }).click();
    await expect.poll(() => router.state.location.pathname).toBe(CARDS[0].href);
    await expect.element(screen.getByRole('note', { name: 'Vision' })).toBeVisible();
  });

  it('read_next_ends_with_an_arrow_that_inks_on_hover', async () => {
    // As on the other About pages, the "Read next" card ends with the arrow at its trailing edge, centred on the
    // card and decoration only. Nothing on the article moves: pointing at the card turns it the paper's ink.
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PATH, { viewport });
      await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
      const card = document.querySelector<HTMLElement>('.va-next');
      const arrow = card?.querySelector<SVGSVGElement>('svg.va-next__arrow');
      if (!card || !arrow) throw new Error(`${viewport}: Read next draws no arrow`);
      expect(arrow.getAttribute('aria-hidden'), viewport).toBe('true');
      const box = card.getBoundingClientRect();
      const at = arrow.getBoundingClientRect();
      expect([at.width, at.height], viewport).toEqual([20, 20]);
      expect(Math.abs(box.right - 20 - at.right), viewport).toBeLessThanOrEqual(1);
      expect(Math.abs((at.top + at.bottom) / 2 - (box.top + box.bottom) / 2), viewport).toBeLessThanOrEqual(1);
      const words = card.querySelector('.va-next__summary')?.getBoundingClientRect();
      expect(words && words.right <= at.left, viewport).toBe(true);
      expect(getComputedStyle(arrow).color, viewport).toBe('rgb(92, 88, 80)');
      card.scrollIntoView({ block: 'center' });
      await userEvent.hover(card.querySelector('a') as HTMLElement);
      await expect.poll(() => getComputedStyle(arrow).color, { message: viewport }).toBe('rgb(28, 27, 25)');
      expect(getComputedStyle(arrow).transform, viewport).toBe('none');
      await userEvent.unhover(card.querySelector('a') as HTMLElement);
    }
  });

  it('keyboard_focus_rings_in_the_papers_secondary_ink', async () => {
    // No blue focus ring on the paper either: keyboard focus on a link in the bar, a picture card and the way to the
    // next page shows the 2 px ring in the paper's secondary ink, 3:1 and more against the paper.
    const { screen } = await renderRoute(PATH);
    await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
    const article = screen.getByRole('article').element();
    const paper = getComputedStyle(article.closest('.vision-article') as Element).backgroundColor;
    expect(paper).toBe('rgb(244, 242, 236)');
    const inBar = document.querySelector<HTMLElement>('.cd-about-top a');
    const card = screen.getByRole('link', { name: `${CARDS[0].name} ${CARDS[0].line}`, exact: true }).element() as HTMLElement;
    const next = document.querySelector<HTMLElement>('.va-next__link');
    for (const [name, link, ring] of [
      ['a link in the bar', inBar, (el: Element) => getComputedStyle(el)],
      ['a picture card', card, (el: Element) => getComputedStyle(el)],
      ['the next page', next, (el: Element) => getComputedStyle(el, '::after')],
    ] as const) {
      if (link === null) throw new Error(`no ${name}`);
      await userEvent.keyboard('{Shift}');
      link.focus();
      expect(link.matches(':focus-visible'), name).toBe(true);
      const style = ring(link);
      expect([style.outlineStyle, style.outlineWidth, style.outlineColor], name).toEqual(['solid', '2px', 'rgb(92, 88, 80)']);
      expect(contrastRatio(style.outlineColor, paper), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('the_picture_cards_draw_their_phones_with_an_even_bezel_and_a_clean_crop', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PATH, { viewport });
      const section = screen.getByRole('region', { name: CARDS_HEADING, exact: true });
      await expect.element(section.getByText(CARDS_LEAD, { exact: true }), { message: viewport }).toBeVisible();
      // The article's own phone, drawn full size beside its caption: each card's phone is a smaller copy of it.
      const full = measurePhone(screen.getByRole('img', { name: FIGURES[0].label, exact: true }).element());
      const tops = section.getByRole('link').elements().map((link) => link.firstElementChild);
      expect(tops, viewport).toHaveLength(CARDS.length);
      const shown: number[] = [];
      for (const [i, top] of tops.entries()) {
        const where = `${CARDS[i]?.name ?? i} at ${viewport}`;
        const phone = top?.querySelector('.va-phone');
        if (!top || !phone) throw new Error(`${where} has no phone`);
        const { frame, screen: inner, bezel, corners } = measurePhone(phone);
        // One bezel all round: as wide at the left and the right as at the top.
        expect(bezel.top, where).toBeGreaterThan(0);
        expect(Math.abs(bezel.left - bezel.top), where).toBeLessThanOrEqual(0.5);
        expect(Math.abs(bezel.right - bezel.top), where).toBeLessThanOrEqual(0.5);
        // The screen's corners follow the frame's: its radius is the frame's less the bezel.
        for (const corner of corners) expect(Math.abs(corner.screen - (corner.frame - bezel.top)), where).toBeLessThanOrEqual(0.5);
        // In the article's phone's proportions, scaled down: its bezel and its corners for its width.
        const width = frame.width;
        expect(Math.abs((bezel.top / width - full.bezel.top / full.frame.width) * width), where).toBeLessThanOrEqual(0.5);
        expect(Math.abs(((corners[0]?.frame ?? 0) / width - (full.corners[0]?.frame ?? 0) / full.frame.width) * width), where).toBeLessThanOrEqual(0.5);
        // The card's picture cuts the phone straight across its sides: the picture's foot falls below the frame's
        // top corners, and the frame, its corners and its screen go on past it, so the bezel runs straight down to
        // the cut on both sides. The phone fits inside the picture's width.
        const area = top.getBoundingClientRect();
        const curve = corners[0]?.frame ?? 0;
        expect(area.bottom, where).toBeGreaterThanOrEqual(frame.top + curve);
        expect(frame.bottom - curve, where).toBeGreaterThanOrEqual(area.bottom);
        expect(inner.bottom, where).toBeGreaterThan(area.bottom);
        expect(frame.left, where).toBeGreaterThanOrEqual(area.left);
        expect(frame.right, where).toBeLessThanOrEqual(area.right);
        shown.push(area.bottom - frame.top);
      }
      // And at the same point on every card.
      expect(Math.max(...shown) - Math.min(...shown), viewport).toBeLessThanOrEqual(0.5);
    }
  });

  it('the_cover_band_is_decoration_hidden_on_phones', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PATH, { viewport });
      const headline = screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true });
      await expect.element(headline).toBeVisible();
      // The band under the headline peeks at the four screens. It is hidden from screen readers and labels none.
      const band = document.querySelector('[data-cover]');
      expect(band?.getAttribute('aria-hidden'), viewport).toBe('true');
      expect(band?.querySelectorAll('[role], [aria-label]'), viewport).toHaveLength(0);
      if (viewport === 'desktop') {
        expect(band?.firstElementChild?.children, viewport).toHaveLength(4);
        // At a laptop's width it is drawn across the page, under the headline and above the article's first words.
        await expect.element(screen.getByText(FIRST_WORDS)).toBeVisible();
        const box = band?.getBoundingClientRect();
        expect(box?.height ?? 0).toBeGreaterThan(0);
        expect(box?.top ?? 0).toBeGreaterThanOrEqual(headline.element().getBoundingClientRect().bottom);
        expect(box?.bottom ?? Infinity).toBeLessThanOrEqual(screen.getByText(FIRST_WORDS).element().getBoundingClientRect().top);
        expect(box?.width).toBe(document.documentElement.clientWidth);
      } else {
        // On a phone, it isn't drawn at all.
        expect(band ? getComputedStyle(band).display : '', viewport).toBe('none');
      }
    }
  });

  it('the_figures_alternate_sides_and_stack_on_phones', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PATH, { viewport });
      await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
      const column = screen.getByText(FIRST_WORDS).element().getBoundingClientRect();
      const middle = (box: DOMRect) => (box.left + box.right) / 2;
      for (const [i, { label }] of FIGURES.entries()) {
        const picture = screen.getByRole('img', { name: label, exact: true }).element();
        const phone = picture.getBoundingClientRect();
        const caption = picture.parentElement?.querySelector('figcaption')?.getBoundingClientRect();
        if (!caption) throw new Error(`${label} has no caption`);
        const where = `${label} at ${viewport}`;
        if (viewport === 'desktop') {
          // Side by side, the first on the left and then alternating, the caption level with the phone's lower
          // part, the pair centered on the article's column.
          if (i % 2 === 0) expect(phone.right, where).toBeLessThan(caption.left);
          else expect(caption.right, where).toBeLessThan(phone.left);
          expect(caption.bottom, where).toBeLessThanOrEqual(phone.bottom);
          expect(caption.top, where).toBeGreaterThan((phone.top + phone.bottom) / 2);
          expect(Math.abs((Math.min(phone.left, caption.left) + Math.max(phone.right, caption.right)) / 2 - middle(column)), where).toBeLessThanOrEqual(1);
        } else {
          // Stacked: the phone centered on the screen, its caption under it and no wider.
          expect(phone.bottom, where).toBeLessThanOrEqual(caption.top);
          expect(Math.abs(middle(phone) - window.innerWidth / 2), where).toBeLessThanOrEqual(1);
          expect(caption.width, where).toBeLessThanOrEqual(phone.width);
          expect(caption.left, where).toBeGreaterThanOrEqual(phone.left);
        }
      }
    }
  });

  it('the_article_passes_screen_basics', async () => {
    for (const lastDesk of [RIVERA.deskId, null]) {
      for (const viewport of ['desktop', 'phone'] as const) {
        const where = `at ${viewport}, last Desk ${lastDesk}`;
        writeLocal('lastDesk', lastDesk);
        const { screen } = await renderRoute(PATH, { viewport });
        await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true }), { message: where }).toBeVisible();
        // One concept footer, the copy check over the whole page, the screens' words included, and axe. Not the
        // owner's jargon check: the article speaks of an owner's policies, as the reading pages name the kernel.
        await expectScreenBasics(screen.container, { owner: false });
        expectNoHorizontalScroll();
      }
    }
  });

  it('the_article_makes_no_requests', async () => {
    for (const lastDesk of [RIVERA.deskId, null]) {
      for (const viewport of ['desktop', 'phone'] as const) {
        const where = `at ${viewport}, last Desk ${lastDesk}`;
        writeLocal('lastDesk', lastDesk);
        const before = [...mockStore.requests];
        const { screen } = await renderRoute(PATH, { viewport });
        await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true }), { message: where }).toBeVisible();
        // Long enough for anything the page asked for as it opened to reach the mock API.
        await settle();
        expect(mockStore.requests, where).toEqual(before);
      }
    }
  });

  it('the_way_into_the_prototype_is_the_reading_pages_own', async () => {
    for (const [lastDesk, to] of [
      [RIVERA.deskId, `/app/${RIVERA.deskId}/today`],
      [null, '/'],
    ] as const) {
      for (const viewport of ['desktop', 'phone'] as const) {
        const where = `at ${viewport}, last Desk ${lastDesk}`;
        writeLocal('lastDesk', lastDesk);
        // A reading page's way into the prototype.
        const reader = await renderRoute('/about/prediction', { viewport });
        await expect.element(reader.screen.getByRole('link', { name: 'Try Desk prototype', exact: true })).toHaveAttribute('href', to);

        // The article's: the same words and target, once, in its top bar, in place of "Back to your Desk".
        const { screen } = await renderRoute(PATH, { viewport });
        await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true }), { message: where }).toBeVisible();
        const tryIt = screen.getByRole('banner').getByRole('link', { name: 'Try Desk prototype', exact: true });
        await expect.element(tryIt, { message: where }).toHaveAttribute('href', to);
        expect(screen.getByRole('link', { name: 'Try Desk prototype', exact: true }).elements(), where).toHaveLength(1);
        expect(document.body.textContent, where).not.toContain('Back to your Desk');
      }
    }

    // Followed, it opens the Desk.
    writeLocal('lastDesk', RIVERA.deskId);
    const { screen, router } = await renderRoute(PATH);
    await screen.getByRole('banner').getByRole('link', { name: 'Try Desk prototype', exact: true }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/today`);
  });

  it('the_bar_and_the_end_join_the_about_set', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PATH, { viewport });
      await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true }), { message: viewport }).toBeVisible();
      const bar = screen.getByRole('banner').element();
      const documents = screen.getByRole('navigation', { name: 'About this prototype' });
      const vision = documents.getByRole('link', { name: 'Vision', exact: true }).element();
      expect(vision.getAttribute('aria-current'), viewport).toBe('page');
      // The page on show is drawn as the reading pages draw it, in the article's palette: ink on the band's paper.
      expect(getComputedStyle(vision).backgroundColor, viewport).toBe('rgb(234, 230, 220)');
      expect(getComputedStyle(vision).color, viewport).toBe('rgb(28, 27, 25)');
      if (viewport === 'desktop') {
        // In the bar, between the name and the way into the prototype, on one line.
        expect(bar.contains(documents.element()), viewport).toBe(true);
        const [name, links, tryIt] = [bar.querySelector('.cd-about-brand'), documents.element(), bar.querySelector('a.cd-about-try')].map((el) =>
          (el as Element).getBoundingClientRect(),
        ) as [DOMRect, DOMRect, DOMRect];
        expect(links.left, viewport).toBeGreaterThan(name.right);
        expect(tryIt.left, viewport).toBeGreaterThan(links.right);
        expect(Math.abs(links.top + links.height / 2 - (tryIt.top + tryIt.height / 2)), viewport).toBeLessThanOrEqual(0.5);
      } else {
        // On a phone, under the bar, and it scrolls away with the page while the bar stays.
        expect(bar.contains(documents.element()), viewport).toBe(false);
        expect(documents.element().getBoundingClientRect().top, viewport).toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom);
        window.scrollTo(0, 600);
        await expect.poll(() => window.scrollY).toBe(600);
        expect(bar.getBoundingClientRect().top, viewport).toBe(0);
        expect(documents.element().getBoundingClientRect().bottom, viewport).toBeLessThan(0);
        window.scrollTo(0, 0);
      }

      // The end: its note, "Read next" back to the prediction on its own card, then the footer.
      const end = screen.getByRole('contentinfo').element();
      const note = screen.getByText(END_NOTE, { exact: true }).element();
      const label = end.querySelector('[data-next-label]');
      expect(label?.textContent, viewport).toBe('Read next');
      const card = label?.parentElement as HTMLElement;
      const next = screen.getByRole('contentinfo').getByRole('link', { name: 'Capability prediction', exact: true });
      await expect.element(next, { message: viewport }).toHaveAttribute('href', '/about/prediction');
      expect(card.contains(next.element()), viewport).toBe(true);
      expect(card.getBoundingClientRect().top, viewport).toBeGreaterThan(note.getBoundingClientRect().bottom);
      const footer = end.querySelector('[data-ds="concept-footer"]') as Element;
      expect(footer.getBoundingClientRect().top, viewport).toBeGreaterThan(card.getBoundingClientRect().bottom);
      // A paper card on the page, its corners 14 px.
      expect(getComputedStyle(card).backgroundColor, viewport).toBe('rgb(251, 250, 247)');
      expect(getComputedStyle(card).borderTopLeftRadius, viewport).toBe('14px');
    }
  });

  it('the_phone_switch_keeps_the_three_pages_on_one_row', async () => {
    // Under the phone bar, the set's three pages sit on one row at 390 and 375 px: "Vision" never drops to a line
    // of its own and pushes the page down, and nothing runs past the window's width. The laptop switch keeps its
    // 12 px either side of each name. Measured in the interface's web font, as the page ships, which the other tests
    // here don't load; the sheet goes again after, so they keep measuring as before.
    onTestFinished(() => {
      const want = new URL(FONT_SHEET_URL).href;
      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) if (link.href === want) link.remove();
    });
    await loadWebFonts();
    for (const size of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      const where = `at ${size.width}`;
      const { screen } = await renderRoute(PATH, { viewport: size });
      await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true }), { message: where }).toBeVisible();
      const documents = screen.getByRole('navigation', { name: 'About this prototype' }).element() as HTMLElement;
      const links = [...documents.querySelectorAll<HTMLElement>('a')];
      expect(links.map((link) => flat(link)), where).toEqual(['Capability prediction', 'Product proposal', 'Vision']);
      const tops = links.map((link) => link.getBoundingClientRect().top);
      expect(new Set(tops).size, `${where}: tops ${tops.join(', ')}`).toBe(1);
      // One row: the switch is as tall as its space above and one 32 px link, the reading pages' (AboutBar).
      expect(documents.getBoundingClientRect().height - parseFloat(getComputedStyle(documents).paddingTop), where).toBe(32);
      expect(Math.max(...links.map((link) => link.getBoundingClientRect().right)), where).toBeLessThanOrEqual(size.width - 16);
      expectNoHorizontalScroll();
    }
    const { screen } = await renderRoute(PATH, { viewport: 'desktop' });
    await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
    for (const link of screen.getByRole('navigation', { name: 'About this prototype' }).element().querySelectorAll('a')) {
      const style = getComputedStyle(link);
      expect([style.paddingLeft, style.paddingRight], flat(link)).toEqual(['12px', '12px']);
    }
  });

  it('the_article_names_the_tab_and_is_noindex', async () => {
    const robots = () => [...document.head.querySelectorAll('meta[name="robots"]')].map((meta) => meta.getAttribute('content'));
    const { screen, router } = await renderRoute(PATH);
    await expect.element(screen.getByRole('heading', { level: 1, name: HEADLINE, exact: true })).toBeVisible();
    // As the reading pages: the tab names the page, and search engines are asked not to list it while it is open.
    expect(document.title).toBe('Vision · Claude Desk');
    expect(robots()).toEqual(['noindex']);

    // Leaving for the rest of the app takes both back.
    await router.navigate('/no/such/page');
    await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    expect(robots()).toEqual([]);
    expect(document.title).not.toContain('Vision');
  });
});

/** Waits a quarter of a second: a request sent while the page drew has reached the mock API by then. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}
