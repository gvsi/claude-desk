/**
 * The vision pages in a real browser against the mock API: a resident on a city permits office's
 * public Desk, a team Desk, a returning visitor signed in with a Claude account, and the app on a
 * phone. Each says it is vision under the vision bar, with the way back to the owner's Desk; each is
 * static, so it asks the API for nothing; and each is drawn as its signed board draws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import {
  FACT_IN_PROSE,
  SPEC,
  expectConversationType,
  expectFooter,
  expectNoFactsInProse,
  expectOwnerFrame,
  expectReceiptsUnderMessages,
  expectTabOrder,
  expectVisionBar,
  one,
  some,
} from '../ds/boards/spec.ts';
import { VISION_LINE } from '../ds/index.ts';
import { expectComputed } from '../ds/test/expectComputed.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

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

/** A fee, a permit's number or its recorded status: on the city office, only ever in a card. */
const CITY_FACT_ANYWHERE = /[$€£]\s?\d|\bB-\d{4}-\d{4}\b|\b(?:passed|approved|issued|denied)\b/i;

/** Where "Back to your Desk" goes: the app's entry, which opens a returning owner's Today. */
const BACK_HREF = '/';

/** The public page's AI disclosure, as every public page shows it. */
const DISCLOSURE = "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.";

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
      // The vision bar, word for word, with the way back to the owner's Desk.
      const bar = screen.getByRole('note', { name: 'Vision' });
      await expect.element(bar).toBeVisible();
      await expect.element(bar).toHaveTextContent(`Vision${VISION_LINE}Back to your Desk`);
      await expect.element(bar.getByRole('link', { name: 'Back to your Desk' })).toHaveAttribute('href', BACK_HREF);
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
    expect(await expectNoFactsInProse(transcript)).toBe(5);
    for (const line of linesOutsideCards(transcript)) expect(line, 'outside a card in the conversation').not.toMatch(FACT_IN_PROSE);
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
    // The phone's held quote: an answer leaves it as it was, waiting, with nothing locked or busy.
    const phone = await renderRoute(PHONE);
    const held = phone.screen.getByRole('article', { name: /^Held for you:/ });
    const allow = held.getByRole('button', { name: 'Allow this time' });
    const deny = held.getByRole('button', { name: 'Deny this time' });
    await allow.click();
    await wait(300);
    expect(held.getByRole('group', { name: 'Your answer' }).element().hasAttribute('aria-busy')).toBe(false);
    for (const answer of [allow, deny]) {
      expect(answer.element().hasAttribute('aria-busy')).toBe(false);
      expect(answer.element().hasAttribute('aria-disabled')).toBe(false);
      expect(answer.element().hasAttribute('disabled')).toBe(false);
    }
    await expect.element(held.getByText('Waiting for your answer', { exact: true })).toBeVisible();
    expect(mockStore.requests).toEqual([]);

    // Each composer: the words typed stay after Enter and after Send, and no message is added.
    for (const path of [PHONE, CLAUDE_ACCOUNT]) {
      const { screen } = await renderRoute(path);
      const log = screen.getByRole('log', { name: 'Conversation with Rivera Plumbing' });
      await expect.element(log).toBeVisible();
      const bubbles = some(log.element() as HTMLElement, '.cd-visitor-message__bubble').length;
      const composer = screen.getByRole('textbox', { name: 'Message Rivera Plumbing' });
      await composer.fill('Thanks again');
      await userEvent.keyboard('{Enter}');
      await expect.element(composer, { timeout: 300 }).toHaveValue('Thanks again');
      await screen.getByRole('button', { name: 'Send' }).click();
      await wait(300);
      await expect.element(composer).toHaveValue('Thanks again');
      expect(some(log.element() as HTMLElement, '.cd-visitor-message__bubble'), path).toHaveLength(bubbles);
      expect(mockStore.requests, path).toEqual([]);
    }
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

  it('back_to_your_desk_opens_today', async () => {
    // The owner was last on their Emergencies Desk, then opened a vision page.
    const desk = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/today`, { seed: 'rivera_two_desks' });
    await expect.element(desk.screen.getByRole('heading', { level: 1, name: /, Maria$/ })).toBeVisible();
    for (const path of VISION_ROUTES) {
      const { screen, router } = await renderRoute(path);
      await screen.getByRole('note', { name: 'Vision' }).getByRole('link', { name: 'Back to your Desk' }).click();
      // Back on the Desk they came from, through the app's entry, which reads the copy's Desks.
      await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
      await expect.element(screen.getByRole('heading', { level: 1, name: /, Maria$/ })).toBeVisible();
    }

    // Someone with the link and no copy of the demo lands on the intro dialog, not on an error.
    const stranger = await renderRoute(TEAM_DESK, { seed: { name: 'rivera', signedIn: false } });
    await stranger.screen.getByRole('link', { name: 'Back to your Desk' }).click();
    await expect.poll(() => stranger.router.state.location.pathname).toBe('/');
    await expect.element(stranger.screen.getByRole('dialog', { name: 'A Claude front desk for your business' })).toBeVisible();
  });
});

describe('Vision pages against their boards', () => {
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
    await expect.element(sidebar.getByRole('switch', { name: 'Answering' })).toHaveAccessibleDescription('Claude answers your team under your rules');

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
    expect(await expectNoFactsInProse(log)).toBe(3);
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
      'From job records and her customer file. Luis is assigned to her 10:30 am visit, so the address and gate code are open to him.',
      'Warranty released to the assigned plumber. Logged on Ana’s file.',
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
      sidebar.getByRole('switch', { name: 'Answering' }).element() as HTMLElement,
      add.element() as HTMLElement,
      ...rows,
      chat.getByRole('button', { name: 'Whisper' }).element() as HTMLElement,
      chat.getByRole('button', { name: 'Take over' }).element() as HTMLElement,
      access.querySelector('button') as HTMLElement,
    ]);
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
    // is inside the shell, so the page is the shell, at least the window's height, with nothing
    // added outside it.
    const header = screen.getByRole('banner').element();
    expect(top(header)).toBe(bottom(bar));
    expectComputed(header, { height: '76px' });
    const shellHeight = round(one(root, '.cd-public-shell').getBoundingClientRect().height);
    expect(shellHeight).toBeGreaterThanOrEqual(window.innerHeight);
    expect(document.documentElement.scrollHeight).toBe(shellHeight);

    // The AI disclosure under the chat's title, as on every public page.
    const disclosure = [...main(screen).element().querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    expect(disclosure).toHaveLength(1);

    // Signed in with a Claude account: the line, then Claude asks to use it for this visit.
    const transcript = log.element() as HTMLElement;
    await expect.element(log.getByText('Signed in with your Claude account.', { exact: true })).toBeVisible();
    expectConversationType(transcript);
    // Claude's words state no booking, date or promise: her past booking is its card beside them.
    expect(await expectNoFactsInProse(transcript)).toBe(3);
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

    // Her last visit is the kernel's booking card under the welcome, in the same message: the date,
    // the job, who and the booking.
    const lastVisit = log.getByRole('article', { name: 'Booked' });
    await expect.element(lastVisit).toBeVisible();
    expect(lastVisit.element().textContent).toBe('BookedTuesday, October 20, 10:00 amDrain clearingWith Maria RiveraBooking B-61');
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
    expect(about.getByRole('article').elements().map((card) => card.getAttribute('aria-label'))).toEqual(['Hours', 'Policy', 'Contact']);
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

    // Nothing here is live: the download's click goes nowhere, not even to a page of the app or a
    // place on this one, and nothing is asked of the API.
    const here = window.location.href;
    await download.click();
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
    expect(await expectNoFactsInProse(log)).toBe(1);
    expect(await expectReceiptsUnderMessages(log)).toBe(1);
    expect(one(log, '.cd-margin-line').textContent).toBe('Booked on Maria Rivera’s calendar');
    // The booking is the kernel's booking card, in the same message as Claude's words.
    const booked = visitor.getByRole('article', { name: 'Booked' });
    expect(booked.element().textContent).toBe('BookedTuesday, November 3, 2:00 pm120 minutesBooking B-77');
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
