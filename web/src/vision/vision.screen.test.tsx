/**
 * The vision pages in a real browser against the mock API: a resident on a city permits office's
 * public Desk, a team Desk, a returning visitor signed in with a Claude account, and the app on a
 * phone. Each says it is vision under the vision bar, with the way back to the Vision article; each
 * is static, so it asks the API for nothing; and each is drawn as its signed board draws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page as browserPage, userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectNoFactsInProse,
  expectOwnerFrame,
  expectReceiptsUnderMessages,
  expectTabOrder,
  expectVisionBar,
  factsInProse,
  one,
  some,
} from '../ds/boards/spec.ts';
import { VISION_INERT_LINE, VISION_LINE } from '../ds/index.ts';
import { expectComputed } from '../ds/test/expectComputed.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { CITY_DESK, CITY_INSPECTION_TIMES, CITY_VERIFY_PROMPT } from './data.ts';

const CITY_OFFICE = '/vision/city-office';
const TEAM_DESK = '/vision/team-desk';
const CLAUDE_ACCOUNT = '/vision/claude-account';
const PHONE = '/vision/phone';
const VISION_ROUTES = [CITY_OFFICE, TEAM_DESK, CLAUDE_ACCOUNT, PHONE] as const;

/** The vision pages that picture a public page, a visitor's: the others are the owner's. */
const VISITOR_PAGES: readonly string[] = [CITY_OFFICE, CLAUDE_ACCOUNT];

/**
 * Real places and government offices the fictional city office must not name: the region around
 * Rivera's service area, nearby cities' permit offices, and a government site's domain.
 */
const REAL_PLACE =
  /\b(?:Oakland|Berkeley|Alameda|Emeryville|San Francisco|San Jose|California|Bay Area)\b|Department of Building Inspection|Planning and Building Department|\.gov\b/i;

/** Each fee, date, time and permit status in Marcus's conversation, as its cards write it. */
const CITY_FACTS = [
  'Plan check passed',
  'Kitchen remodel, permit B-2026-0412',
  'Fee due before issue: $1,286',
  'Permit B-2026-0412, once the fee is paid',
  'Wednesday, November 4, 8:00 am to 12:00 pm',
  'Thursday, November 5, 1:00 pm to 4:00 pm',
  'Monday, November 9, 8:00 am to 12:00 pm',
];

/** The master plan's slot id, `S-<yyyymmdd>-<hhmm>`: the slot's start in the business's time zone. */
const SLOT_ID = /^S-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/;

/**
 * The fact each kernel template reads, by the start of its `fact_id` (the kernel's render
 * registry): open times read a `slots:` fact, the about cards the charter's. A code's prompt reads none.
 */
const TEMPLATE_FACT_IDS: Readonly<Record<string, RegExp>> = {
  booking_options: /^slots:/,
  hours: /^charter:hours$/,
  policy: /^charter:policy:/,
  contact: /^charter:contact$/,
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The start a slot id names, as an open time's label writes it ("Wednesday, November 4, 8:00 am"), or null for no slot id. */
function slotStart(slotId: string): string | null {
  const match = SLOT_ID.exec(slotId);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${MONTHS[month - 1]} ${day}, ${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** A fee, a permit's number or its recorded status: on the city office, only ever in a card. */
const CITY_FACT_ANYWHERE = /[$€£]\s?\d|\bB-\d{4}-\d{4}\b|\b(?:passed|approved|issued|denied)\b/i;

/** Where "Back to Vision" goes: the Vision article, under About this prototype. */
const BACK_HREF = '/about/vision';

/** The public page's AI disclosure, as every public page shows it. */
const DISCLOSURE = "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.";

/** Marcus Bell's visit to Meridian Bay Permits, in the board story's words. */
const CITY = {
  disclosure: "You're chatting with Claude, an AI answering for Meridian Bay Permits. Ask for Permit Center staff anytime.",
  /** Claude's words, in order. */
  claude: [
    'I can look that up after you confirm it’s you.',
    'Thanks, Marcus. Here’s where your kitchen remodel stands.',
    'Here’s what comes next.',
    'These times are open on the inspection calendar. Which one works for you?',
    'Whether your garage conversion needs a permit is a plan checker’s decision. I’ve asked Permit Center staff, and the answer will show up here.',
  ],
  /** Marcus's messages, in order. */
  marcus: [
    'Hi, it’s Marcus Bell. What’s the status of my kitchen remodel permit?',
    'When can an inspector come out?',
    'One more thing. I’d like to turn my garage into a home office. Does that need a permit at all?',
  ],
  verified: 'Verified with a code sent to the email on the application',
  /** The receipts under Claude's four answers, in order, each with its dot's tone. */
  receipts: [
    ['Reply checked against the City’s rules', 'handled'],
    ['Code sent to the email on the application', 'handled'],
    ['Reply checked against the City’s rules', 'handled'],
    ['Read from your own permit file', 'handled'],
    ['Reply checked against the City’s rules', 'handled'],
    ['Times read from the inspection calendar', 'handled'],
    ['Reply checked against the City’s rules', 'handled'],
    ['Waiting for Permit Center staff to approve', 'held'],
  ],
  /** The cards in the conversation, in order: what draws each, its label, then its words. */
  cards: [
    ['reply', 'Confirm it\'s you', ['I’ll send a code to the email on the application.']],
    ['fact', 'Permit status', ['Plan check passed', 'Kitchen remodel, permit B-2026-0412', 'Fee due before issue: $1,286']],
    [
      'fact',
      'Next steps',
      ['Pay the fee, then book the first inspection', 'Pay online or at the Permit Center, 250 Harbor Street', 'First inspection: rough-in for electrical, plumbing and framing'],
    ],
    [
      'reply',
      'Open times',
      [
        'Rough-in inspection',
        'Permit B-2026-0412, once the fee is paid',
        'Wednesday, November 4, 8:00 am to 12:00 pm',
        'Thursday, November 5, 1:00 pm to 4:00 pm',
        'Monday, November 9, 8:00 am to 12:00 pm',
      ],
    ],
  ],
  /** The about column's cards, the city's charter, in order. */
  about: [
    ['Hours', ['Monday to Friday, 8:00 am to 4:30 pm', 'Inspections, Monday to Friday, 8:00 am to 4:00 pm']],
    ['Policy', ['Plan checkers decide what needs a permit and what’s exempt.']],
    ['Contact', ['(415) 555-0186', 'Permit Center, 250 Harbor Street']],
  ],
  suggestions: ['Book an inspection', 'Pay the fee', 'Talk to staff'],
  /**
   * The page's height unrolled at the board's width, as the story measures it: the board's 1485 px,
   * plus 18 px for the shell's own AI disclosure's second line, less 6 px for each of the two fact
   * cards.
   */
  pageHeight: 1485 + 18 - 2 * 6,
} as const;

/** Dana's visit, in the board's words. */
const ACCOUNT = {
  ask: 'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Welcome back, Dana. How did the drain clearing go?',
  matchedReceipt: 'Matched to Dana Whitfield: the Claude account’s verified email is her contact on record, and she agreed for this visit',
  invoice: 'All fixed, thanks. Can you send me the invoice?',
  sent: 'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  releasedReceipt: 'Released to Dana Whitfield, matched by her Claude account with her consent for this visit',
  checked: 'Reply checked against Maria Rivera’s rules',
} as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * focus_order_is_logical, from the top of the page. A tab walk that ran off the end of an earlier
 * page left the browser's focus outside this document, where the first Tab only brings it back, so
 * the walk starts with the document focused.
 */
async function expectTabOrderFromTheTop(stops: HTMLElement[]): Promise<void> {
  window.focus();
  await expectTabOrder(userEvent, stops);
}

function main(screen: RenderResult) {
  return screen.getByRole('main');
}

/** A card's words, one per paragraph or list item, after its label. */
function cardWords(card: Element): string[] {
  return [...card.querySelectorAll('p, li')]
    .filter((line) => !line.matches('.cd-reply-card__label, .cd-fact-card__label'))
    .map((line) => line.textContent ?? '');
}

/** Each line of text a person reads under `root`, one text node at a time, outside any card. */
function linesOutsideCards(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    if (text !== '' && !node.parentElement?.closest('.cd-card, [aria-hidden="true"]')) lines.push(text);
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
  // The last Desk opened lives in this browser's storage, which outlives a test.
  localStorage.clear();
});

describe('Vision pages', () => {
  it('vision_pages_are_labelled_and_offline', async () => {
    const fetches = vi.spyOn(window, 'fetch');
    for (const path of VISION_ROUTES) {
      performance.clearResourceTimings();
      const { screen } = await renderRoute(path);
      // The vision bar, word for word, with the way back to the Vision article.
      const bar = screen.getByRole('note', { name: 'Vision' });
      await expect.element(bar).toBeVisible();
      await expect.element(bar).toHaveTextContent(`Vision${VISION_LINE}Back to Vision`);
      await expect.element(bar.getByRole('link', { name: 'Back to Vision', exact: true })).toHaveAttribute('href', BACK_HREF);
      expect(bar.getByRole('link').elements(), path).toHaveLength(1);
      // Static: in a while on the page, nothing was asked of the API, by fetch or any other way the
      // browser loads a resource (a request, an event stream, an image, a beacon), and nothing was
      // sent to a path the mock API doesn't serve.
      await wait(300);
      expect(mockStore.requests, path).toEqual([]);
      expect(mockStore.unhandled, path).toEqual([]);
      expect(fetches, path).not.toHaveBeenCalled();
      const toTheApi = performance
        .getEntriesByType('resource')
        .map((entry) => new URL(entry.name))
        .filter((url) => url.origin === window.location.origin && /^\/api(?:\/|$)/.test(url.pathname))
        .map((url) => url.pathname);
      expect(toTheApi, path).toEqual([]);
    }

    // The city office names no real place or government office: Meridian Bay Permits is fictional.
    const { screen } = await renderRoute(CITY_OFFICE);
    const log = main(screen).getByRole('log', { name: 'Conversation with Meridian Bay Permits' });
    await expect.element(log).toBeVisible();
    const page = screen.container;
    expect(page.textContent).toContain('Meridian Bay Permits');
    expect(page.textContent).not.toMatch(REAL_PLACE);

    // Every fee, date and permit status sits only in a card, never in Claude's words: each is shown
    // once, inside a card; Claude's words, the receipts and the system line state none of them; and
    // nowhere on the page outside a card names a fee, a permit or its status.
    for (const fact of CITY_FACTS) {
      const shown = [...page.querySelectorAll<HTMLElement>('p, li, span')].filter((el) => el.textContent === fact);
      expect(shown, fact).toHaveLength(1);
      expect(shown[0]?.closest('.cd-card'), `${fact}: in a card`).not.toBeNull();
    }
    const transcript = log.element() as HTMLElement;
    expect(await expectNoFactsInProse(transcript)).toEqual({ prose: 5, receipts: 8 });
    for (const line of linesOutsideCards(transcript)) expect(factsInProse(line), `outside a card in the conversation: "${line}"`).toEqual([]);
    for (const line of linesOutsideCards(page)) expect(line, 'outside a card on the page').not.toMatch(CITY_FACT_ANYWHERE);
  });

  it('vision_pages_carry_no_api_address', async () => {
    // Nothing on a vision page can reach the API, even through the browser's own menu ("Open link
    // in new tab"): no link, source or form on it names a path under /api/.
    for (const path of VISION_ROUTES) {
      const { screen } = await renderRoute(path);
      await expect.element(screen.getByRole('main')).toBeVisible();
      const addresses = [...screen.container.querySelectorAll<HTMLElement>('[href], [src], [action], [formaction], [poster]')].flatMap((el) =>
        ['href', 'src', 'action', 'formaction', 'poster'].map((name) => el.getAttribute(name)).filter((value): value is string => value !== null),
      );
      expect(addresses.length, path).toBeGreaterThan(0);
      const toTheApi = addresses.filter((value) => {
        const url = new URL(value, window.location.href);
        return url.origin === window.location.origin && /^\/api(?:\/|$)/.test(url.pathname);
      });
      expect(toTheApi, path).toEqual([]);
    }
  });

  it('vision_controls_send_nothing', async () => {
    // The phone's held quote: an answer leaves it as it was, waiting, with nothing locked or busy,
    // and the first one says why, once, in a line under the answers that is announced.
    const phone = await renderRoute(PHONE);
    const held = phone.screen.getByRole('article', { name: /^Held for you:/ });
    const allow = held.getByRole('button', { name: 'Allow this time' });
    const deny = held.getByRole('button', { name: 'Deny this time' });
    expect(held.getByText(VISION_INERT_LINE, { exact: true }).elements()).toHaveLength(0);
    await allow.click();
    const heldLine = held.getByText(VISION_INERT_LINE, { exact: true });
    await expect.element(heldLine).toBeVisible();
    expect(heldLine.element().getAttribute('role')).toBe('status');
    // 8 px under the answers' row, as the story measures it.
    expect(round(top(heldLine.element()) - bottom(one(held.element(), '.cd-approval-card__row')))).toBe(8);
    await deny.click();
    await wait(300);
    expect(held.getByText(VISION_INERT_LINE, { exact: true }).elements()).toHaveLength(1);
    expect(held.getByRole('group', { name: 'Your answer' }).element().hasAttribute('aria-busy')).toBe(false);
    for (const answer of [allow, deny]) {
      expect(answer.element().hasAttribute('aria-busy')).toBe(false);
      expect(answer.element().hasAttribute('aria-disabled')).toBe(false);
      expect(answer.element().hasAttribute('disabled')).toBe(false);
    }
    await expect.element(held.getByText('Waiting for your answer', { exact: true })).toBeVisible();
    expect(mockStore.requests).toEqual([]);

    // Each composer: the words typed stay after Enter and after Send, no message is added, and the
    // first press says why, once, in a line that is announced.
    for (const [path, business] of [
      [PHONE, 'Rivera Plumbing'],
      [CLAUDE_ACCOUNT, 'Rivera Plumbing'],
      [CITY_OFFICE, 'Meridian Bay Permits'],
    ] as const) {
      const { screen } = await renderRoute(path);
      const log = screen.getByRole('log', { name: `Conversation with ${business}` });
      await expect.element(log).toBeVisible();
      const bubbles = some(log.element() as HTMLElement, '.cd-visitor-message__bubble').length;
      const composer = screen.getByRole('textbox', { name: `Message ${business}` });
      expect(screen.getByText(VISION_INERT_LINE, { exact: true }).elements(), path).toHaveLength(0);
      await composer.fill('Thanks again');
      await userEvent.keyboard('{Enter}');
      await expect.element(composer, { timeout: 300 }).toHaveValue('Thanks again');
      const line = screen.getByText(VISION_INERT_LINE, { exact: true });
      await expect.element(line).toBeVisible();
      expect(line.element().getAttribute('role'), path).toBe('status');
      expect(line.element().closest('.cd-composer'), path).toBe(composer.element().closest('.cd-composer'));
      await screen.getByRole('button', { name: 'Send' }).click();
      await wait(300);
      await expect.element(composer).toHaveValue('Thanks again');
      expect(screen.getByText(VISION_INERT_LINE, { exact: true }).elements(), path).toHaveLength(1);
      if (VISITOR_PAGES.includes(path)) {
        // On a public page the composer grows by the line and the conversation gives the room up, so
        // the page stays the window's height and the line shows inside it, as the story checks.
        expect(document.documentElement.scrollHeight, path).toBe(window.innerHeight);
        expect(bottom(line.element()), path).toBeLessThanOrEqual(window.innerHeight);
      }
      if (path === PHONE) {
        // On the visitor's phone, 8 px under the composer, in a caption's type, as the story draws it.
        const box = composer.element().closest('.cd-composer__box') as HTMLElement;
        expect(round(top(line.element()) - bottom(box))).toBe(8);
        expectComputed(line.element(), { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
      }
      expect(some(log.element() as HTMLElement, '.cd-visitor-message__bubble'), path).toHaveLength(bubbles);
      expect(mockStore.requests, path).toEqual([]);
    }

    // "Ask for …" on each public page: a press asks for no one, adds no message and keeps the focus,
    // and the first says why, once, in a line that is announced, on a row of its own in the chat's
    // pinned head: 8 px under the title and Ask, above the head's hairline.
    for (const [path, business, asked] of [
      [CLAUDE_ACCOUNT, 'Rivera Plumbing', 'Maria Rivera'],
      [CITY_OFFICE, 'Meridian Bay Permits', 'Permit Center staff'],
    ] as const) {
      const { screen } = await renderRoute(path);
      const log = screen.getByRole('log', { name: `Conversation with ${business}` });
      await expect.element(log).toBeVisible();
      const bubbles = some(log.element() as HTMLElement, '.cd-visitor-message__bubble').length;
      const ask = screen.getByRole('button', { name: `Ask for ${asked}` });
      const head = one(screen.container, '.cd-public-shell__chat-head');
      expect(head.contains(ask.element()), path).toBe(true);
      expect(screen.getByText(VISION_INERT_LINE, { exact: true }).elements(), path).toHaveLength(0);
      await ask.click();
      const line = screen.getByText(VISION_INERT_LINE, { exact: true });
      await expect.element(line).toBeVisible();
      expect(line.element().getAttribute('role'), path).toBe('status');
      expect(line.element().parentElement, path).toBe(head);
      const rowBottom = Math.max(bottom(one(head, '.cd-public-shell__chat-title')), bottom(ask.element()));
      expect(round(top(line.element()) - rowBottom), path).toBe(8);
      expect(bottom(line.element()), path).toBeLessThanOrEqual(bottom(head));
      await ask.click();
      await wait(300);
      expect(screen.getByText(VISION_INERT_LINE, { exact: true }).elements(), path).toHaveLength(1);
      expect(document.activeElement, path).toBe(ask.element());
      expect(some(log.element() as HTMLElement, '.cd-visitor-message__bubble'), path).toHaveLength(bubbles);
      expect(mockStore.requests, path).toEqual([]);
      expect(mockStore.unhandled, path).toEqual([]);
    }

    // The city office's suggestions: a pick asks nothing, adds no message, fills nothing in and goes
    // nowhere, not even to a place on the page. The first says why, once, 8 px under the chips, in a
    // line that is announced.
    const city = await renderRoute(CITY_OFFICE);
    expect([window.innerWidth, window.innerHeight]).toEqual([1440, 900]);
    const log = city.screen.getByRole('log', { name: 'Conversation with Meridian Bay Permits' });
    await expect.element(log).toBeVisible();
    const bubbles = some(log.element() as HTMLElement, '.cd-visitor-message__bubble').length;
    const composer = city.screen.getByRole('textbox', { name: 'Message Meridian Bay Permits' });
    const here = window.location.href;
    const group = city.screen.getByRole('group', { name: 'Try asking' });
    const chips = group.getByRole('button');
    expect(chips.elements()).toHaveLength(3);
    expect(city.screen.getByText(VISION_INERT_LINE, { exact: true }).elements()).toHaveLength(0);
    // The chips end the conversation's scroll region, right above the pinned composer. With the
    // conversation scrolled to its end, as a visitor reading it would have it, the first pick keeps
    // the focus on its chip and brings the line into the region's view: fully inside it, clear of
    // the composer and under nothing, as the story checks.
    const scroller = one(city.screen.container, '.cd-public-shell__scroll');
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    scroller.scrollTop = scroller.scrollHeight;
    const [firstChip, ...otherChips] = chips.elements() as HTMLElement[];
    await userEvent.click(firstChip as HTMLElement);
    const chipsLine = city.screen.getByText(VISION_INERT_LINE, { exact: true });
    await expect.element(chipsLine).toBeVisible();
    await expect.element(firstChip as HTMLElement).toHaveFocus();
    expect(chipsLine.element().getAttribute('role')).toBe('status');
    expect(chipsLine.element().previousElementSibling).toBe(group.element());
    expect(round(top(chipsLine.element()) - bottom(group.element()))).toBe(8);
    const lineBox = chipsLine.element().getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    expect(lineBox.height).toBeGreaterThan(1);
    expect(lineBox.top).toBeGreaterThanOrEqual(view.top);
    expect(lineBox.bottom).toBeLessThanOrEqual(view.bottom);
    expect(lineBox.bottom).toBeLessThanOrEqual(top(one(city.screen.container, '.cd-public-shell__composer')));
    const hit = document.elementFromPoint(lineBox.left + lineBox.width / 2, lineBox.top + lineBox.height / 2);
    expect(hit !== null && chipsLine.element().contains(hit), 'nothing covers the line').toBe(true);
    for (const chip of otherChips) {
      chip.click();
      await wait(100);
    }
    await wait(200);
    expect(city.screen.getByText(VISION_INERT_LINE, { exact: true }).elements()).toHaveLength(1);
    await expect.element(composer).toHaveValue('');
    expect(some(log.element() as HTMLElement, '.cd-visitor-message__bubble')).toHaveLength(bubbles);
    expect(city.router.state.location.pathname).toBe(CITY_OFFICE);
    expect(window.location.href).toBe(here);
    expect(mockStore.requests).toEqual([]);
    expect(mockStore.unhandled).toEqual([]);
  });

  it('vision_pages_pass_the_screen_checks', async () => {
    // On a laptop and on a phone: one footer, clean copy, no axe violations, nothing scrolling
    // sideways, and on the owner's pages no technical words. The city office and Claude account
    // pages are a visitor's.
    for (const viewport of ['desktop', 'phone'] as const) {
      for (const path of VISION_ROUTES) {
        const { screen } = await renderRoute(path, { viewport });
        await expect.element(screen.getByRole('note', { name: 'Vision' })).toBeVisible();
        await expect.element(screen.getByRole('main')).toBeVisible();
        await expectScreenBasics(screen.container, { owner: !VISITOR_PAGES.includes(path) });
        expectNoHorizontalScroll();
      }
    }
  });

  it('back_to_vision_opens_the_article', async () => {
    // From each vision page, the bar's way back opens the Vision article in the same tab, through the router.
    for (const path of VISION_ROUTES) {
      const { screen, router } = await renderRoute(path);
      const back = screen.getByRole('note', { name: 'Vision' }).getByRole('link', { name: 'Back to Vision', exact: true });
      expect(back.element().getAttribute('target'), path).toBeNull();
      await back.click();
      await expect.poll(() => router.state.location.pathname, { message: path }).toBe('/about/vision');
      await expect.element(screen.getByRole('heading', { level: 1, name: 'A front desk that never closes', exact: true })).toBeVisible();
    }

    // Someone with the link and no copy of the demo reads the article too: it reads nothing of theirs.
    const stranger = await renderRoute(TEAM_DESK, { seed: { name: 'rivera', signedIn: false } });
    await stranger.screen.getByRole('link', { name: 'Back to Vision', exact: true }).click();
    await expect.poll(() => stranger.router.state.location.pathname).toBe('/about/vision');
    await expect.element(stranger.screen.getByRole('heading', { level: 1, name: 'A front desk that never closes', exact: true })).toBeVisible();
  });
});

describe('Vision pages against their boards', () => {
  it('city_office_matches_its_board', async () => {
    // As Boards/Vision, city office draws it, at the story's window: Marcus Bell on Meridian Bay
    // Permits' public page, asking about his permit.
    const { screen } = await renderRoute(CITY_OFFICE);
    await browserPage.viewport(1512, 982);
    expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    // The heights below are the page's once its two typefaces have loaded.
    await Promise.all([document.fonts.load('15px "Hanken Grotesk"'), document.fonts.load('15px "Source Serif 4"')]);
    await document.fonts.ready;
    const log = main(screen).getByRole('log', { name: 'Conversation with Meridian Bay Permits' });
    await expect.element(log).toBeVisible();
    const root = screen.container;
    const bar = await expectVisionBar(root, BACK_HREF);
    // As the public page names its tab: the business.
    expect(document.title).toBe('Meridian Bay Permits');

    // The city's public page right under the bar: its header in the city's slate with its lighter
    // rule, its name, the Permit Center and its open status.
    const header = screen.getByRole('banner').element();
    expect(top(header)).toBe(bottom(bar));
    expectComputed(header, { height: '76px', backgroundColor: 'rgb(45, 61, 76)', borderBottomColor: 'rgb(111, 139, 163)' });
    await expect.element(screen.getByRole('banner').getByRole('heading', { level: 1 })).toHaveTextContent('Meridian Bay Permits');
    expect(header.textContent).toContain('City of Meridian Bay, Permit Center');
    expect(one(header, '.cd-public-shell__open-status').textContent).toContain('Open now, until 4:30 pm');

    // The page is the window's height, as every public page is: the header, the AI disclosure and
    // the composer stay in view, and only the conversation scrolls. Unrolled, the page is the one the
    // board draws: the window's height and what the conversation's scroll region holds past it.
    // Screen tests load no web fonts, so the footer's "Powered by" line can be a pixel taller than in
    // the story, which loads them, and the region a pixel shorter. Every part above the footer
    // measures as the story's: the conversation, unrolled, ends at 1382 px in both.
    const shellHeight = round(one(root, '.cd-public-shell').getBoundingClientRect().height);
    expect([shellHeight, document.documentElement.scrollHeight]).toEqual([982, 982]);
    const scroller = one(root, '.cd-public-shell__scroll');
    expect(Math.abs(shellHeight + scroller.scrollHeight - scroller.clientHeight - CITY.pageHeight)).toBeLessThanOrEqual(1);
    expect(round(top(scroller) + scroller.scrollHeight)).toBe(1382);
    expectNoHorizontalScroll();

    // The AI disclosure under the chat's title, once, and the staff to ask for.
    const disclosure = [...main(screen).element().querySelectorAll('p')].filter((line) => line.textContent === CITY.disclosure);
    expect(disclosure).toHaveLength(1);
    const askStaff = main(screen).getByRole('button', { name: 'Ask for Permit Center staff' });
    await expect.element(askStaff).toBeVisible();

    // The conversation: Marcus's messages in bubbles, Claude's words in serif.
    const transcript = log.element() as HTMLElement;
    expectConversationType(transcript);
    expect(some(transcript, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual(CITY.claude);
    expect(some(transcript, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual(CITY.marcus);

    // Verified with a code to the email on the application, between the code's prompt and his permit.
    const verified = log.getByRole('status').element();
    expect(verified.textContent).toContain(CITY.verified);
    const cards = log.getByRole('article').elements();
    expect(cards[0]?.compareDocumentPosition(verified)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(cards[1]?.compareDocumentPosition(verified)).toBe(Node.DOCUMENT_POSITION_PRECEDING);

    // Every card in the conversation, word for word: the status and the next steps are fact cards,
    // the code's prompt and the open times the kernel's reply cards.
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(CITY.cards.map(([, label]) => label));
    for (const [index, [kind, label, words]] of CITY.cards.entries()) {
      const card = cards[index] as HTMLElement;
      expect(card.closest(kind === 'fact' ? '.cd-fact-card' : '.cd-reply-card'), `${label}: a ${kind} card`).not.toBeNull();
      expect(cardWords(card), `${label}: its words`).toEqual([...words]);
    }
    // The open times are a list to answer in the chat, not buttons.
    expect(cards[3]?.querySelectorAll('li')).toHaveLength(3);
    expect(cards[3]?.querySelector('button')).toBeNull();
    // The city's cards keep the kernel's contract: each open time is a slot id naming the time its
    // label starts at, and each card reads its template's kind of fact.
    expect(CITY_INSPECTION_TIMES.options).toHaveLength(3);
    for (const option of CITY_INSPECTION_TIMES.options ?? []) {
      expect(option.option_id, 'an open time is a slot id').toMatch(SLOT_ID);
      expect(option.label.startsWith(`${slotStart(option.option_id)} `), `${option.option_id} starts its label "${option.label}"`).toBe(true);
    }
    for (const block of [CITY_INSPECTION_TIMES, ...CITY_DESK.charter]) {
      expect(block.fact_id, `${block.template}'s fact`).toMatch(TEMPLATE_FACT_IDS[block.template ?? ''] ?? /^$/);
    }
    expect(CITY_VERIFY_PROMPT.fact_id).toBeNull();
    // Claude's words lead into each fact card, 12 px above it.
    for (const index of [1, 2]) {
      const fact = cards[index]?.closest('.cd-fact-card') as HTMLElement;
      const words = fact.previousElementSibling as HTMLElement;
      expect(words.querySelector('.cd-claude-message__prose')).not.toBeNull();
      expect(round(top(fact) - bottom(words))).toBe(12);
    }

    // The receipts under each answer, in order: the reply's check, then what ran or what waits for a person.
    expect(await expectReceiptsUnderMessages(transcript)).toBe(4);
    const receipts = some(transcript, '.cd-margin-line');
    expect(receipts.map((line) => line.textContent)).toEqual(CITY.receipts.map(([words]) => words));
    expect(receipts.map((line) => one(line, '.cd-status-dot').className)).toEqual(CITY.receipts.map(([, tone]) => `cd-status-dot cd-status-dot--${tone}`));
    expect(transcript.querySelector('.cd-transcript-row__margin button')).toBeNull();
    // The garage question goes to staff: Claude's words alone, no card under them.
    const lastAnswer = some(transcript, '.cd-transcript-row__main').at(-1) as HTMLElement;
    expect(lastAnswer.textContent).toContain(CITY.claude[4]);
    expect(lastAnswer.querySelector('.cd-card')).toBeNull();

    // What to try next, 20 px under the conversation.
    const chips = main(screen).getByRole('group', { name: 'Try asking' });
    const chipButtons = chips.getByRole('button').elements() as HTMLElement[];
    expect(chipButtons.map((chip) => chip.textContent)).toEqual(CITY.suggestions);
    expect(round(top(chips.element()) - bottom(transcript))).toBe(20);

    // The about column: the city's hours, who decides what needs a permit, and how to reach the Permit Center.
    const about = screen.getByRole('complementary', { name: 'About Meridian Bay Permits' });
    const aboutCards = about.getByRole('article').elements();
    expect(aboutCards.map((card) => card.getAttribute('aria-label'))).toEqual(CITY.about.map(([label]) => label));
    for (const [index, [label, words]] of CITY.about.entries()) {
      expect(cardWords(aboutCards[index] as HTMLElement), `${label}: its words`).toEqual([...words]);
    }

    // The composer and the footer.
    const composer = main(screen).getByRole('textbox', { name: 'Message Meridian Bay Permits' });
    expectComputed(one(main(screen).element(), '.cd-composer__box'), SPEC.composer);
    await expectFooter(root);

    // focus_order_is_logical: the bar, Ask for Permit Center staff, the suggestions, then the composer.
    await expectTabOrderFromTheTop([
      bar.querySelector('a') as HTMLElement,
      askStaff.element() as HTMLElement,
      ...chipButtons,
      composer.element() as HTMLElement,
    ]);
  });

  it('team_desk_matches_its_board', async () => {
    // As Boards/Vision, team desk draws it: Rivera Plumbing's team Desk, Luis's conversation open.
    const { screen } = await renderRoute(TEAM_DESK);
    const title = main(screen).getByRole('heading', { level: 1, name: 'Conversations' });
    await expect.element(title).toBeVisible();
    const root = screen.container;
    const bar = await expectVisionBar(root, BACK_HREF);
    await expectOwnerFrame(root, 'Conversations', { fill: true });
    const sidebar = screen.getByRole('complementary', { name: 'Claude Desk' });
    await expect.element(sidebar.getByRole('button', { name: 'Switch Desk, current: Team' })).toBeVisible();
    await expect.element(sidebar.getByRole('link', { name: 'Teammates' })).toBeVisible();
    await expect.element(sidebar.getByRole('switch', { name: 'Claude acts for you' })).toHaveAccessibleDescription('Within your rules');

    // The title and its line, "Add a teammate" at the right.
    expectComputed(title.element(), SPEC.pageTitle);
    const lead = main(screen).getByText(/^Your team asks this Desk/).element();
    expect(lead.textContent).toBe('Your team asks this Desk for job context, customer history and documents. Each person sees only what their access allows.');
    expect(round(top(lead) - bottom(title.element()))).toBe(8);
    const add = main(screen).getByRole('button', { name: 'Add a teammate' });

    // The teammates: Everyone, then each teammate with a hidden monogram, Luis current.
    const people = main(screen).getByRole('navigation', { name: 'Teammates' });
    const rows = people.getByRole('link').elements() as HTMLElement[];
    expect(rows.map((row) => row.textContent)).toEqual([
      'Everyone12 conversations today',
      'LOLuis OrtegaPlumber, 5 today',
      'BCBen CarterPlumber, 4 today',
      'GLGrace LeeOffice manager, 3 today',
    ]);
    expect(rows.filter((row) => row.getAttribute('aria-current') === 'page')).toEqual([rows[1]]);
    expect(round(people.element().getBoundingClientRect().width)).toBe(220);
    const avatars = some(people.element(), '.cd-vision-team__avatar');
    expect(avatars).toHaveLength(3);
    for (const avatar of avatars) expect(avatar.getAttribute('aria-hidden')).toBe('true');

    // Luis's conversation: his messages in bubbles, Claude's words in serif, each fact a card.
    const chat = main(screen).getByRole('region', { name: 'Luis Ortega' });
    expect(chat.getByText('Teammate', { exact: true }).element().classList.contains('cd-pill')).toBe(true);
    await expect.element(chat.getByText('In Slack, from the van, 9:42 am', { exact: true })).toBeVisible();
    const log = chat.getByRole('log', { name: 'Conversation with Luis Ortega' }).element() as HTMLElement;
    expectConversationType(log);
    // Claude's words state no date, not even a relative one ("today", "last week"), and nothing else
    // only a card may say; the cards carry the dates.
    expect(await expectNoFactsInProse(log)).toEqual({ prose: 3, receipts: 4 });
    expect(await expectReceiptsUnderMessages(log)).toBe(3);
    expect(some(log, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual([
      'Heading to Ana Ruiz in Eastshore. What’s the history there?',
      'Send me the warranty in case it’s the tank.',
      'Also, what did Ben make on the Harbor Street job last week?',
    ]);
    expect(some(log, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual([
      'Here’s Ana’s history. The gate code is on her job card.',
      'Here it is.',
      'I can’t share pay. Payroll is open to Maria and Grace only. Here are your own logged hours.',
    ]);
    const facts = some(log, '.cd-fact-card');
    expect(facts.map((fact) => fact.textContent)).toEqual([
      'Customer historyAna Ruiz, customer since 2023Water heater replaced, March 2024; under warranty until 2030Kitchen drain cleared, September 12; camera inspection declined',
      'Job cardFriday, October 30, 10:30 amAna Ruiz, Eastshore: water heater checkGate code 2580, at the side gate',
      'Document, only for LuisWater heater warranty, Ana Ruiz',
      'Your logged hoursMonday, October 19 to Friday, October 2338.5 hours over 5 days',
    ]);
    // Ana's history is there, word for word, and it is in her card.
    const history = chat.getByText('Water heater replaced, March 2024; under warranty until 2030', { exact: true });
    await expect.element(history).toBeVisible();
    expect(history.element().closest('.cd-fact-card')).toBe(facts[0]);
    // The payroll request is refused, sharing no pay; Luis's own hours, from his time records, are shown.
    const receipts = some(log, '.cd-margin-line');
    expect(receipts.map((receipt) => receipt.textContent)).toEqual([
      'From job records and her customer file. Luis is assigned to her visit, so the address and gate code are open to him.',
      'Document released to the assigned plumber. Logged on Ana’s file.',
      'Declined by team access: payroll is owner and office manager only. No pay was shared.',
      'Luis’s own hours, from his time records.',
    ]);
    expect(receipts.map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'refused',
      'handled',
    ]);

    // Luis's access beside it: 260 px, 28 px to the conversation's right.
    const access = main(screen).getByRole('region', { name: 'Luis’s access' }).element();
    expect(round(access.getBoundingClientRect().width)).toBe(260);
    expect(round(access.getBoundingClientRect().left - chat.element().getBoundingClientRect().right)).toBe(28);
    expect([...access.querySelectorAll('ul')].map((list) => [...list.querySelectorAll('li')].map((item) => item.textContent))).toEqual([
      ['Job cards', 'Customer history', 'Warranties', 'Photos'],
      ['Invoices', 'Payroll'],
    ]);

    // The day's line, then the footer at the foot.
    const today = main(screen)
      .getByText('Today: 12 team conversations, 9 answered from job records, 3 documents shared, 1 payroll request declined.', { exact: true })
      .element();
    expectComputed(today, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    await expectFooter(root);
    const footer = one(root, '[data-ds="concept-footer"]');
    expect(round(top(footer) - bottom(today))).toBe(16);
    // With the job and hours cards the page runs past the window; the footer ends it, 20 px from its foot.
    const page = main(screen).element();
    expect(round(page.scrollHeight - (bottom(footer) - top(page) + page.scrollTop))).toBe(20);

    // focus_order_is_logical: the bar, the sidebar, the page's action, the teammates, the conversation's controls, then access.
    await expectTabOrderFromTheTop([
      bar.querySelector('a') as HTMLElement,
      sidebar.getByRole('button', { name: 'Switch Desk, current: Team' }).element() as HTMLElement,
      sidebar.getByRole('switch', { name: 'Claude acts for you' }).element() as HTMLElement,
      add.element() as HTMLElement,
      ...rows,
      chat.getByRole('button', { name: 'Whisper' }).element() as HTMLElement,
      chat.getByRole('button', { name: 'Take over' }).element() as HTMLElement,
      access.querySelector('button') as HTMLElement,
    ]);

    // As the story draws it, the page fits a window as tall as itself exactly: nothing scrolls, and
    // the footer sits 20 px over the window's foot. Its height is measured in a shorter window first,
    // as the main area's scroll height under the 40 px bar, rather than pinned in pixels: lines wrap
    // with the machine's fonts, so the same page is a few pixels taller or shorter on another one.
    await browserPage.viewport(1512, 900);
    await expect.poll(() => window.innerHeight).toBe(900);
    const pageHeight = page.scrollHeight + 40;
    expect(pageHeight).toBeGreaterThan(900);
    await browserPage.viewport(1512, pageHeight);
    await expect.poll(() => window.innerHeight).toBe(pageHeight);
    expect(page.scrollHeight).toBe(page.clientHeight);
    expect(round(window.innerHeight - bottom(footer))).toBe(20);
  });

  it('claude_account_matches_its_board', async () => {
    // As Boards/Vision, Claude account draws it: Dana back on Rivera's public page, signed in.
    const { screen, router } = await renderRoute(CLAUDE_ACCOUNT);
    const log = main(screen).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
    await expect.element(log).toBeVisible();
    const root = screen.container;
    const bar = await expectVisionBar(root, BACK_HREF);
    // As the public page names its tab: the business.
    expect(document.title).toBe('Rivera Plumbing');

    // The public page right under the bar: the brand header, the chat and the about column. The bar
    // is inside the shell, so the page is the shell, the window's height, with nothing added
    // outside it.
    const header = screen.getByRole('banner').element();
    expect(top(header)).toBe(bottom(bar));
    expectComputed(header, { height: '76px' });
    const shellHeight = round(one(root, '.cd-public-shell').getBoundingClientRect().height);
    expect([shellHeight, document.documentElement.scrollHeight]).toEqual([window.innerHeight, window.innerHeight]);

    // The AI disclosure under the chat's title, as on every public page.
    const disclosure = [...main(screen).element().querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    expect(disclosure).toHaveLength(1);

    // Signed in with a Claude account: the line, then Claude asks to use it for this visit.
    const transcript = log.element() as HTMLElement;
    await expect.element(log.getByText('Signed in with your Claude account.', { exact: true })).toBeVisible();
    expectConversationType(transcript);
    // Claude's words state no booking, date or promise: her past booking is its card beside them.
    expect(await expectNoFactsInProse(transcript)).toEqual({ prose: 3, receipts: 5 });
    expect(some(transcript, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual([
      ACCOUNT.ask,
      ACCOUNT.matched,
      ACCOUNT.sent,
    ]);
    expect(some(transcript, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual([ACCOUNT.yes, ACCOUNT.invoice]);

    // The match and her consent are in the receipts, in order, each a line and never a button.
    expect(await expectReceiptsUnderMessages(transcript)).toBe(3);
    expect(some(transcript, '.cd-margin-line').map((line) => line.textContent)).toEqual([
      ACCOUNT.checked,
      ACCOUNT.matchedReceipt,
      ACCOUNT.checked,
      ACCOUNT.checked,
      ACCOUNT.releasedReceipt,
    ]);
    expect(transcript.querySelector('.cd-transcript-row__margin button')).toBeNull();

    // Her last visit is the kernel's booking card under the welcome, in the same message, as the
    // kernel renders one: the day, when Maria arrives and who, with no booking number.
    const lastVisit = log.getByRole('article', { name: 'Booked' });
    await expect.element(lastVisit).toBeVisible();
    expect(lastVisit.element().textContent).toBe('BookedTuesday, October 2010:00 am to 12:00 pmWith Maria Rivera');
    expect(lastVisit.element().closest('.cd-claude-message')?.querySelector('.cd-claude-message__prose')?.textContent).toBe(ACCOUNT.matched);

    // The invoice is a document card, only for her, with its download. A vision page makes no
    // requests: Download is drawn as the board draws it, a button going nowhere, and the page's data
    // names no download path.
    const invoice = log.getByRole('article', { name: 'Document, only for you' });
    await expect.element(invoice).toBeVisible();
    expect(invoice.element().textContent).toContain('Invoice, drain clearing');
    const download = invoice.getByRole('button', { name: 'Download' });
    expectComputed(download.element(), SPEC.primary);
    expect(download.element().getAttribute('type')).toBe('button');
    expect(invoice.element().querySelector('a')).toBeNull();
    expect(root.innerHTML).not.toContain('/api/');

    // The about column: hours, Rivera's service area and the phone, Rivera's own facts.
    const about = screen.getByRole('complementary', { name: 'About Rivera Plumbing' });
    expect(about.getByRole('article').elements().map((card) => card.getAttribute('aria-label'))).toEqual(['Hours', 'Service area', 'Contact']);
    await expect.element(about.getByText('We work in Oakland, Berkeley, Alameda and Emeryville.', { exact: true })).toBeVisible();
    expectComputed(one(main(screen).element(), '.cd-composer__box'), SPEC.composer);
    await expectFooter(root);

    // focus_order_is_logical: the bar, Ask for Maria Rivera, the download, then the composer.
    await expectTabOrderFromTheTop([
      bar.querySelector('a') as HTMLElement,
      main(screen).getByRole('button', { name: 'Ask for Maria Rivera' }).element() as HTMLElement,
      download.element() as HTMLElement,
      main(screen).getByRole('textbox', { name: 'Message Rivera Plumbing' }).element() as HTMLElement,
    ]);

    // As the story draws it, the page fits a window as tall as itself, Dana's last visit included.
    // The shell is the window's height, so the page's own height is measured unrolled in a shorter
    // window first: there the conversation scrolls by what the window lacks. It isn't pinned in
    // pixels, since lines wrap with the machine's fonts. In a window that tall, the shell is the
    // page and nothing scrolls.
    await browserPage.viewport(1512, 900);
    await expect.poll(() => window.innerHeight).toBe(900);
    const shell = one(root, '.cd-public-shell');
    const scroller = one(root, '.cd-public-shell__scroll');
    expect(round(shell.getBoundingClientRect().height)).toBe(900);
    const pageHeight = round(shell.getBoundingClientRect().height) + scroller.scrollHeight - scroller.clientHeight;
    expect(pageHeight).toBeGreaterThan(900);
    await browserPage.viewport(1512, pageHeight);
    await expect.poll(() => window.innerHeight).toBe(pageHeight);
    expect([round(shell.getBoundingClientRect().height), document.documentElement.scrollHeight]).toEqual([pageHeight, pageHeight]);
    expect(scroller.scrollHeight).toBe(scroller.clientHeight);
    // The concept footer stays in the page's flow, so the height above can't be met by moving it:
    // it sits under the composer and ends just over the window's foot (about 16 px, a pixel more or
    // less with the machine's fonts).
    const footer = one(root, '[data-ds="concept-footer"]');
    expect(round(top(footer))).toBeGreaterThanOrEqual(round(bottom(one(root, '.cd-public-shell__composer'))));
    const footerGap = round(window.innerHeight - bottom(footer));
    expect(footerGap).toBeGreaterThanOrEqual(12);
    expect(footerGap).toBeLessThanOrEqual(20);

    // Nothing here is live: the download's click goes nowhere, not even to a page of the app or a
    // place on this one, and nothing is asked of the API.
    const here = window.location.href;
    await download.click();
    // The first press says why nothing came, under the card's Download, in a line that is announced.
    const inertLine = invoice.getByText(VISION_INERT_LINE, { exact: true });
    await expect.element(inertLine).toBeVisible();
    expect(inertLine.element().getAttribute('role')).toBe('status');
    await wait(300);
    expect(router.state.location.pathname).toBe(CLAUDE_ACCOUNT);
    expect(window.location.href).toBe(here);
    await expect.element(log).toBeVisible();
    expect(mockStore.requests).toEqual([]);
    expect(mockStore.unhandled).toEqual([]);
  });

  it('phone_matches_its_board', async () => {
    // As Boards/Vision, phone draws it: the owner's Today and a visitor's chat, as phone apps.
    const { screen } = await renderRoute(PHONE);
    const title = main(screen).getByRole('heading', { level: 1, name: 'Claude Desk on a phone' });
    await expect.element(title).toBeVisible();
    const root = screen.container;
    const bar = await expectVisionBar(root, BACK_HREF);
    expect(top(main(screen).element())).toBe(bottom(bar));

    // The title centered over the phones, its line under it.
    expectComputed(title.element(), SPEC.pageTitle);
    const titleBox = title.element().getBoundingClientRect();
    expect(round(titleBox.left + titleBox.width / 2)).toBe(round(window.innerWidth / 2));
    await expect.element(main(screen).getByText('The owner’s Today and a visitor’s chat, as phone apps.', { exact: true })).toBeVisible();

    // Two phones, 64 px apart, centered under the title, each captioned.
    const owner = main(screen).getByRole('figure', { name: 'Today, for the owner' });
    const visitor = main(screen).getByRole('figure', { name: 'The public chat, for a visitor' });
    const ownerScreen = one(owner.element(), '.cd-phone-frame__screen');
    const visitorScreen = one(visitor.element(), '.cd-phone-frame__screen');
    expect(round(visitorScreen.getBoundingClientRect().left - ownerScreen.getBoundingClientRect().right)).toBe(64);
    expect(round(ownerScreen.getBoundingClientRect().left)).toBe(round((window.innerWidth - (390 + 64 + 390)) / 2));
    expect(round(top(ownerScreen) - bottom(bar))).toBe(106);

    // The owner's phone: the greeting, the held quote and Live now, over the five tabs, Today current.
    await expect.element(owner.getByRole('heading', { level: 2, name: 'Good morning, Maria' })).toBeVisible();
    await expect.element(owner.getByText('Rivera Plumbing', { exact: true })).toBeVisible();
    const held = owner.getByRole('article', { name: /^Held for you:/ });
    await expect.element(held.getByRole('button', { name: 'Allow this time' })).toBeVisible();
    await expect.element(held.getByRole('button', { name: 'Deny this time' })).toBeVisible();
    await expect.element(held.getByText('Web chat, 2 min ago', { exact: true })).toBeVisible();
    // The page sets only its own lines: the greeting 2 px under the business's name, and the held
    // quote with the card's own spacing, its reason 12 px under the status line and "Held by" 14 px
    // under the reason.
    const businessName = owner.getByText('Rivera Plumbing', { exact: true }).element();
    const greeting = owner.getByRole('heading', { level: 2, name: 'Good morning, Maria' }).element();
    expect(round(top(greeting) - bottom(businessName))).toBe(2);
    const reason = one(held.element(), '.cd-approval-card__reason');
    expect(round(top(reason) - bottom(one(held.element(), '.cd-approval-card__top')))).toBe(12);
    expect(round(top(one(held.element(), '.cd-approval-card__held-by')) - bottom(reason))).toBe(14);
    const live = owner.getByRole('region', { name: 'Live now' });
    expect(live.getByRole('listitem').elements().map((row) => row.textContent)).toEqual(['Lucía HerreraVisitor', 'Alex Kim’s assistantAgent']);
    const tabs = owner.getByRole('navigation', { name: "The owner app's tabs" }).getByRole('link').elements();
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Today', 'Chats', 'Rules', 'Safety', 'More']);
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null, null, null, null]);
    // The tab bar at the foot of the owner's screen.
    const tabBar = one(owner.element(), '.cd-phone-tab-bar');
    expect(Math.abs(ownerScreen.getBoundingClientRect().bottom - tabBar.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);

    // The visitor's phone: the business's header with the disclosure, the booking next to its card, the composer.
    await expect.element(visitor.getByText('Claude, an AI, answers for Maria Rivera', { exact: true })).toBeVisible();
    const log = visitor.getByRole('log', { name: 'Conversation with Rivera Plumbing' }).element() as HTMLElement;
    expectConversationType(log);
    // The booking is confirmed only by its card: Claude's words state no date, time or booking, and
    // promise nothing the card doesn't back.
    expect(await expectNoFactsInProse(log)).toEqual({ prose: 1, receipts: 1 });
    expect(await expectReceiptsUnderMessages(log)).toBe(1);
    expect(one(log, '.cd-margin-line').textContent).toBe('Booked on Maria Rivera’s calendar');
    // The booking is the kernel's booking card, in the same message as Claude's words, as the kernel
    // renders one: the day, when Maria arrives and who, with no booking number.
    const booked = visitor.getByRole('article', { name: 'Booked' });
    expect(booked.element().textContent).toBe('BookedTuesday, November 32:00 pm to 4:00 pmWith Maria Rivera');
    const reply = one(log, '.cd-claude-message__prose');
    expect(reply.textContent).toBe('You’re all set. Here’s your visit.');
    expect(booked.element().closest('.cd-claude-message')).toBe(reply.closest('.cd-claude-message'));
    const composer = visitor.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    await expect.element(composer).toBeVisible();
    await expect.element(visitor.getByText('This chat is with Claude, an AI.', { exact: true })).toBeVisible();

    // focus_order_is_logical: the bar's link, the held quote's answers, the five tabs, then the
    // visitor's composer and Send. Send is disabled while the box is empty, so a message is typed first.
    await composer.fill('Thanks');
    await expectTabOrderFromTheTop([
      bar.querySelector('a') as HTMLElement,
      held.getByRole('button', { name: 'Allow this time' }).element() as HTMLElement,
      held.getByRole('button', { name: 'Deny this time' }).element() as HTMLElement,
      ...(tabs as HTMLElement[]),
      composer.element() as HTMLElement,
      visitor.getByRole('button', { name: 'Send' }).element() as HTMLElement,
    ]);

    // Nothing scrolls sideways, and the footer follows the phones.
    expectNoHorizontalScroll();
    await expectFooter(root);
    expect(top(one(root, '[data-ds="concept-footer"]'))).toBeGreaterThan(bottom(visitor.element()));
  });
});

const round = Math.round;
const top = (el: Element) => el.getBoundingClientRect().top;
const bottom = (el: Element) => el.getBoundingClientRect().bottom;
