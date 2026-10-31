/**
 * The vision pages in a real browser against the mock API: a city permits office, a team Desk, a
 * returning visitor signed in with a Claude account, and the app on a phone. Each says it is vision
 * under the vision bar, with the way back to the owner's Desk; each is static, so it asks the API
 * for nothing; and each is drawn as its signed board draws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectFooterAtFoot,
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
import { expectNoHorizontalScroll, expectNoWindowScroll, expectScreenBasics } from '../test/screen.ts';

const CITY_OFFICE = '/vision/city-office';
const TEAM_DESK = '/vision/team-desk';
const CLAUDE_ACCOUNT = '/vision/claude-account';
const PHONE = '/vision/phone';
const VISION_ROUTES = [CITY_OFFICE, TEAM_DESK, CLAUDE_ACCOUNT, PHONE] as const;

/** Rivera's Today, in the copy each test starts with. */
const TODAY = `/app/${RIVERA.deskId}/today`;

/** Where "Back to your Desk" goes: the app's entry, which opens a returning owner's Today. */
const BACK_HREF = '/';

/**
 * Real places and offices the fictional city office must not name: Rivera's own service area,
 * the region around it, and a government site's domain.
 */
const REAL_PLACE = /\b(?:Oakland|Berkeley|Alameda|Emeryville|San Francisco|California|Bay Area)\b|\.gov\b/i;

/**
 * A fee, a date or a time, a permit's number or its status: what only a card may say. Claude's
 * words state none of them, nor the generic word "status" (the board story's own check).
 */
const FACT_IN_PROSE =
  /\$\s?\d|\d{1,2}:\d{2}|\b\d{1,2} de [a-z]+|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\bStatus\b|\bB-\d{4}-\d{4}\b|\bissued\b|\bpassed\b|\bapproved\b/i;

/** The same facts anywhere on the page outside a fact card, where labels may still say "status". */
const FACT_OUTSIDE_A_CARD =
  /\$\s?\d|\d{1,2}:\d{2}|\b\d{1,2} de [a-z]+|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\bB-\d{4}-\d{4}\b|\b(?:issued|passed|approved)\b/i;

/** Each fee, date and permit status the city office shows, as its cards write it. */
const CITY_FACTS = [
  'Plan check passed',
  'Kitchen remodel, permit B-2026-0412',
  'Fee due before issue: $1,286',
  'Cierra el 15 de diciembre, 5:00 pm',
  'Permit B-2026-0377',
  'Status: issued',
];

/** The public page's AI disclosure, as every public page shows it. */
const DISCLOSURE = "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.";

/** Dana's visit, in the board's words. */
const ACCOUNT = {
  ask: 'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Thanks, it matches. Welcome back, Dana. Last time we booked your drain clearing. How did it go?',
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

/** The page's text with every fact card taken out. */
function textOutsideFactCards(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const card of copy.querySelectorAll('.cd-fact-card')) card.remove();
  return copy.textContent ?? '';
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
      const { screen } = await renderRoute(path);
      // The vision bar, word for word, with the way back to the owner's Desk.
      const bar = screen.getByRole('note', { name: 'Vision' });
      await expect.element(bar).toBeVisible();
      await expect.element(bar).toHaveTextContent(`Vision${VISION_LINE}Back to your Desk`);
      await expect.element(bar.getByRole('link', { name: 'Back to your Desk' })).toHaveAttribute('href', BACK_HREF);
      // Static: in a while on the page, nothing was asked of the API, or of anything else.
      await wait(300);
      expect(mockStore.requests, path).toEqual([]);
      expect(fetches, path).not.toHaveBeenCalled();
    }

    // The city office names no real place or office: Meridian Bay Permits is fictional.
    const { screen } = await renderRoute(CITY_OFFICE);
    const page = screen.container;
    await expect.element(main(screen).getByRole('region', { name: 'Live now' })).toBeVisible();
    expect(page.textContent).toContain('Meridian Bay Permits');
    expect(page.textContent).not.toMatch(REAL_PLACE);

    // Every fee, date and permit status is in a card, and none is in Claude's words.
    const live = main(screen).getByRole('region', { name: 'Live now' }).element();
    for (const fact of CITY_FACTS) {
      const shown = [...page.querySelectorAll<HTMLElement>('p, span, li')].filter((el) => el.textContent === fact);
      expect(shown, fact).toHaveLength(1);
      expect(shown[0]?.closest('.cd-fact-card'), `${fact} is in a card`).not.toBeNull();
    }
    const prose = [...live.querySelectorAll<HTMLElement>('.cd-claude-message__prose')];
    expect(prose).toHaveLength(4);
    for (const line of prose) expect(line.textContent ?? '', 'Claude’s words state no fee, date or status').not.toMatch(FACT_IN_PROSE);
    expect(textOutsideFactCards(page)).not.toMatch(FACT_OUTSIDE_A_CARD);
  });

  it('things_to_try_links_where_this_is_going', async () => {
    // Today's "Things to try" leads to the vision pages, starting with the city office.
    const { screen, router } = await renderRoute(TODAY);
    const things = screen.getByRole('region', { name: 'Things to try' });
    const link = things.getByRole('link', { name: 'Where this is going: channels, a city office and a team Desk' });
    await expect.element(link).toHaveAttribute('href', CITY_OFFICE);
    // The same tab, through the router: the app stays loaded.
    expect(link.element().getAttribute('target')).toBeNull();
    await link.click();
    await expect.poll(() => router.state.location.pathname).toBe(CITY_OFFICE);
    await expect.element(screen.getByRole('note', { name: 'Vision' })).toBeVisible();
    await expect.element(main(screen).getByRole('heading', { level: 1, name: 'Good morning, Nadia' })).toBeVisible();
  });

  it('vision_pages_pass_the_screen_checks', async () => {
    // On a laptop and on a phone: one footer, clean copy, no axe violations, nothing scrolling
    // sideways, and on the owner's pages no technical words. The Claude account page is a visitor's.
    for (const viewport of ['desktop', 'phone'] as const) {
      for (const path of VISION_ROUTES) {
        const { screen } = await renderRoute(path, { viewport });
        await expect.element(screen.getByRole('note', { name: 'Vision' })).toBeVisible();
        await expect.element(screen.getByRole('main')).toBeVisible();
        await expectScreenBasics(screen.container, { owner: path !== CLAUDE_ACCOUNT });
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
  it('city_office_matches_its_board', async () => {
    // As Boards/Vision, city office draws it, measured in the window the screens run in.
    const { screen } = await renderRoute(CITY_OFFICE);
    const live = main(screen).getByRole('region', { name: 'Live now' });
    await expect.element(live).toBeVisible();
    const root = screen.container;
    const bar = await expectVisionBar(root, BACK_HREF);
    await expectOwnerFrame(root, 'Today', { fill: true });
    const sidebar = screen.getByRole('complementary', { name: 'Claude Desk' });
    expect(top(sidebar.element())).toBe(bottom(bar));

    // The city's sidebar: its business, its people's word, its Answering line and its supervisor.
    await expect.element(sidebar.getByRole('button', { name: 'Switch business, current: Meridian Bay Permits' })).toBeVisible();
    await expect.element(sidebar.getByRole('link', { name: 'Residents' })).toBeVisible();
    await expect.element(sidebar.getByRole('switch', { name: 'Answering' })).toHaveAccessibleDescription('Claude answers under the City’s rules');
    await expect.element(sidebar.getByText('Permit Center supervisor')).toBeVisible();

    // The page padded 24 px 40 px from the sidebar's seam, the greeting at its top.
    const area = main(screen).element();
    const greeting = main(screen).getByRole('heading', { level: 1, name: 'Good morning, Nadia' }).element();
    expectComputed(greeting, SPEC.greeting);
    expect(round(greeting.getBoundingClientRect().left)).toBe(264 + 40);
    expect(round(top(greeting) - top(area))).toBe(24);
    await expect.element(main(screen).getByText('Nine residents are talking to the Desk right now.')).toBeVisible();
    await expect.element(main(screen).getByText('desk.example/meridian-bay-permits')).toBeVisible();

    // Live now: the four conversations, each with who, their level and what it is about.
    await expect.element(live.getByRole('link', { name: 'See all in Conversations' })).toBeVisible();
    const items = live.getByRole('listitem').elements();
    expect(items.map((item) => one(item, '[data-copy="user"]').textContent)).toEqual(['Marcus Bell', 'Visitor in Eastshore', 'Visitor', 'Joan Park']);
    expect(items.map((item) => one(item, '.cd-pill').textContent)).toEqual(['Verified', 'Public', 'Public', 'Verified']);
    expect(items.map((item) => one(item, '.cd-vision-live__head').lastElementChild?.textContent)).toEqual([
      'Permit status, 3 min',
      'Program deadline, in Spanish',
      'Asked about a neighbor’s permit',
      'Eligibility, waiting 4 min',
    ]);
    // Rows under hairlines, not cards: the only cards in Live now are the fact cards.
    const liveRegion = live.element();
    expect(liveRegion.querySelectorAll('.cd-card:not(.cd-fact-card .cd-card)')).toHaveLength(0);
    for (const item of items.slice(1)) expectComputed(item, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });

    // Claude's words in serif, word for word as ruled, each leading into its card.
    const prose = some(liveRegion, '.cd-claude-message__prose');
    for (const line of prose) expectComputed(line, SPEC.reply);
    expect(prose.map((line) => line.textContent)).toEqual([
      'Here’s where your kitchen remodel stands.',
      'Esta es la fecha límite del programa.',
      'Plans and applicant details go only to the applicant. Here’s what’s public.',
      'Whether your garage conversion is exempt is a plan checker’s decision. I’ve asked one to join.',
    ]);
    const facts = some(liveRegion, '.cd-fact-card');
    expect(facts.map((fact) => one(fact, '.cd-fact-card__label').textContent)).toEqual(['Permit status', 'Fecha límite', 'Public record']);
    expect(one(liveRegion, '.cd-fact-card[lang="es"]').textContent).toContain('Programa de refuerzo sísmico');
    // Each card 8 px under Claude's words.
    for (const fact of facts) expect(round(top(fact) - bottom(fact.previousElementSibling as HTMLElement))).toBe(8);

    // Each receipt under its conversation in its tone: handled, handled, refused, held for a person.
    const receipts = items.map((item) => one(item, '.cd-margin-line'));
    expect(receipts.map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'refused',
      'held',
    ]);
    for (const receipt of receipts) expectComputed(receipt, SPEC.receipt);
    const assign = live.getByRole('listitem').nth(3).getByRole('button', { name: 'Assign staff' });

    // The right column: what can't be switched off, and today's numbers, 360 px wide, 32 px from Live now.
    const alwaysOn = main(screen).getByRole('region', { name: 'Always on' }).element();
    expect(round(alwaysOn.getBoundingClientRect().left - liveRegion.getBoundingClientRect().right)).toBe(32);
    expect(round(alwaysOn.getBoundingClientRect().width)).toBe(360);
    expectComputed(alwaysOn, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    expect([...alwaysOn.querySelectorAll('li')].map((item) => item.querySelector('.cd-type-control')?.textContent)).toEqual([
      'No legal or financial determinations without a qualified person',
      'Files only to the applicant',
      'No promised outcomes',
    ]);
    await expect.element(main(screen).getByText('Can’t be switched off', { exact: true })).toBeVisible();
    await expect
      .element(main(screen).getByText('Also always on: says it’s an AI, and logs every conversation for City records.', { exact: true }))
      .toBeVisible();
    expect(alwaysOn.querySelectorAll('button, input, a')).toHaveLength(0);
    const today = main(screen).getByRole('region', { name: 'Today so far' }).element();
    expect(round(top(today) - bottom(alwaysOn))).toBe(16);
    expect([...today.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '214 questions answered in 6 languages',
      '38 applicants verified for their own files',
      '7 handed to staff',
      '0 determinations made without a person',
    ]);
    await expectFooter(root);

    // focus_order_is_logical: the bar's link, the sidebar, then the page from the top.
    await expectTabOrderFromTheTop([
      bar.querySelector('a') as HTMLElement,
      sidebar.getByRole('button', { name: 'Switch business, current: Meridian Bay Permits' }).element() as HTMLElement,
      sidebar.getByRole('switch', { name: 'Answering' }).element() as HTMLElement,
      main(screen).getByRole('button', { name: 'Copy your Desk link' }).element() as HTMLElement,
      live.getByRole('link', { name: 'See all in Conversations' }).element() as HTMLElement,
      assign.element() as HTMLElement,
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
    expect(await expectReceiptsUnderMessages(log)).toBe(3);
    expect(some(log, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual([
      'Heading to Ana Ruiz in Eastshore. What’s the history there?',
      'Send me the warranty in case it’s the tank.',
      'Also, what did Ben make on the Harbor Street job last week?',
    ]);
    expect(some(log, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual([
      'Here’s Ana’s history. The gate code is on today’s job card.',
      'Here it is.',
      'I can’t share pay. Payroll is open to Maria and Grace only. I can show your own logged hours for last week if that helps.',
    ]);
    const facts = some(log, '.cd-fact-card');
    expect(facts.map((fact) => one(fact, '.cd-fact-card__label').textContent)).toEqual(['Customer history', 'Document, only for Luis']);
    // Ana's history is there, word for word, and it is in her card.
    const history = chat.getByText('Water heater replaced, March 2024; under warranty until 2030', { exact: true });
    await expect.element(history).toBeVisible();
    expect(history.element().closest('.cd-fact-card')).toBe(facts[0]);
    // The payroll answer declines with no card, and its receipt says it was refused.
    expect(some(log, '.cd-margin-line').map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'refused',
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
    await expectFooterAtFoot(root);

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

    // The public page right under the bar, in the window's height: the brand header, the chat and the about column.
    const header = screen.getByRole('banner').element();
    expect(top(header)).toBe(bottom(bar));
    expectComputed(header, { height: '76px' });
    expect(round(one(root, '.cd-public-shell').getBoundingClientRect().height)).toBe(window.innerHeight);
    expectNoWindowScroll();

    // The AI disclosure under the chat's title, as on every public page.
    const disclosure = [...main(screen).element().querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    expect(disclosure).toHaveLength(1);

    // Signed in with a Claude account: the line, then Claude asks to use it for this visit.
    const transcript = log.element() as HTMLElement;
    await expect.element(log.getByText('Signed in with your Claude account.', { exact: true })).toBeVisible();
    expectConversationType(transcript);
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

    // The invoice is a document card, only for her, with its download.
    const invoice = log.getByRole('article', { name: 'Document, only for you' });
    await expect.element(invoice).toBeVisible();
    expect(invoice.element().textContent).toContain('Invoice, drain clearing');
    const download = invoice.getByRole('link', { name: 'Download' });
    expectComputed(download.element(), SPEC.primary);

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

    // Nothing here is live: the download goes nowhere, not even to a page of the app, and nothing
    // is asked of the API.
    await download.click();
    await wait(300);
    expect(router.state.location.pathname).toBe(CLAUDE_ACCOUNT);
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
    const tabs = owner.getByRole('navigation', { name: 'Main' }).getByRole('link').elements();
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Today', 'Chats', 'Rules', 'Safety', 'More']);
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null, null, null, null]);
    // The tab bar at the foot of the owner's screen.
    const tabBar = one(owner.element(), '.cd-phone-tab-bar');
    expect(round(ownerScreen.getBoundingClientRect().bottom - tabBar.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);

    // The visitor's phone: the business's header with the disclosure, the booking next to its card, the composer.
    await expect.element(visitor.getByText('Claude, an AI, answers for Maria Rivera', { exact: true })).toBeVisible();
    const log = visitor.getByRole('log', { name: 'Conversation with Rivera Plumbing' }).element() as HTMLElement;
    expectConversationType(log);
    expect(await expectReceiptsUnderMessages(log)).toBe(1);
    expect(one(log, '.cd-margin-line').textContent).toBe('Booked on Maria Rivera’s calendar');
    const booked = visitor.getByRole('article', { name: 'Booked' });
    expect(booked.element().textContent).toBe('BookedTuesday, November 3Arriving 2:00 pm to 4:00 pmWith Maria Rivera');
    const reply = one(log, '.cd-claude-message__prose');
    expect(reply.textContent).toBe('Maria will text you when she’s on her way.');
    expect(reply.textContent ?? '').not.toMatch(/\d|Tuesday|November/);
    await expect.element(visitor.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeVisible();
    await expect.element(visitor.getByText('This chat is with Claude, an AI.', { exact: true })).toBeVisible();

    // Nothing scrolls sideways, and the footer follows the phones.
    expectNoHorizontalScroll();
    await expectFooter(root);
    expect(top(one(root, '[data-ds="concept-footer"]'))).toBeGreaterThan(bottom(visitor.element()));
  });
});

const round = Math.round;
const top = (el: Element) => el.getBoundingClientRect().top;
const bottom = (el: Element) => el.getBoundingClientRect().bottom;
