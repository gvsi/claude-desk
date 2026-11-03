import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { VISION_INERT_LINE } from '../components/VisionBar/visionInert.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { FONT_TIMEOUT, withinDeadline } from '../test/fonts.ts';
import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectNoFactsInProse,
  expectReceiptsUnderMessages,
  expectTabOrder,
  expectVisionBar,
  factsInProse,
  one,
  some,
} from './spec.ts';
import { CITY_DESK, CITY_INSPECTION_TIMES, CITY_VERIFY_PROMPT, CityOfficeChat, VISION_BACK_HREF } from './vision.tsx';

const DISCLOSURE = "You're chatting with Claude, an AI answering for Meridian Bay Permits. Ask for Permit Center staff anytime.";

/** Claude's words, word for word as the board writes them, in order. */
const CLAUDE_LINES = [
  'I can look that up after you confirm it’s you.',
  'Thanks, Marcus. Here’s where your kitchen remodel stands.',
  'Here’s what comes next.',
  'These times are open on the inspection calendar. Which one works for you?',
  'Whether your garage conversion needs a permit is a plan checker’s decision. I’ve asked Permit Center staff, and the answer will show up here.',
];

/** Marcus Bell's messages, in order. */
const MARCUS_LINES = [
  'Hi, it’s Marcus Bell. What’s the status of my kitchen remodel permit?',
  'When can an inspector come out?',
  'One more thing. I’d like to turn my garage into a home office. Does that need a permit at all?',
];

const CHECKED = 'Reply checked against the City’s rules';

/** The receipts under Claude's four answers, in order, each with its dot. */
const RECEIPTS = [
  [CHECKED, 'handled'],
  ['Code sent to the email on the application', 'handled'],
  [CHECKED, 'handled'],
  ['Read from your own permit file', 'handled'],
  [CHECKED, 'handled'],
  ['Times read from the inspection calendar', 'handled'],
  [CHECKED, 'handled'],
  ['Waiting for Permit Center staff to approve', 'held'],
] as const;

/** The cards in the conversation, in order: what draws each, its label, then its words. */
const CONVERSATION_CARDS = [
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
] as const;

/** The about column's cards, under the charter templates' labels, in order. */
const ABOUT_CARDS = [
  ['Hours', ['Monday to Friday, 8:00 am to 4:30 pm', 'Inspections, Monday to Friday, 8:00 am to 4:00 pm']],
  ['Policy', ['Plan checkers decide what needs a permit and what’s exempt.']],
  ['Contact', ['(415) 555-0186', 'Permit Center, 250 Harbor Street']],
] as const;

const SUGGESTIONS = ['Book an inspection', 'Pay the fee', 'Talk to staff'];

/**
 * The page's height at the laptop's width: the board as now drawn on the canvas, the signed render's
 * 1485 px, plus 18 px for the shell's own AI disclosure, whose longer sentence takes a second line,
 * less 6 px for each of the two fact cards, 109 px where the render drew 115 px boxes in the reply
 * card's look; then 70 px for the raised type scale's taller lines.
 */
const PAGE_HEIGHT = 1485 + 18 - 2 * 6 + 70;

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

/**
 * `line` is fully inside `scroller`'s visible box, and nothing covers it: the topmost element at its
 * center is the line itself.
 */
async function expectInView(line: HTMLElement, scroller: HTMLElement): Promise<void> {
  const box = line.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  await expect(box.height, 'the line has its height').toBeGreaterThan(1);
  await expect(box.top, 'the line starts inside the scroll region').toBeGreaterThanOrEqual(view.top);
  await expect(box.bottom, 'the line ends inside the scroll region').toBeLessThanOrEqual(view.bottom);
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  await expect(hit !== null && line.contains(hit), 'nothing covers the line').toBe(true);
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

/** A card's words, one per paragraph or list item, after its label. */
function cardWords(card: HTMLElement): string[] {
  return [...card.querySelectorAll('p, li')]
    .filter((line) => !line.matches('.cd-reply-card__label, .cd-fact-card__label'))
    .map((line) => line.textContent ?? '');
}

const meta = {
  title: 'Boards/Vision, city office',
  render: () => <CityOfficeChat />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-CityOffice-Resident',
    canvasNote: [
      'Signed on 2026-10-30. Marcus Bell, a resident, asks Meridian Bay Permits’ public Desk about his kitchen remodel permit; Meridian Bay is a fictional city, and no vision page names a real city office.',
      'He is verified with a code sent to the email on the application; his permit’s status with the fee due, and the next steps, are fact cards, as no reply card template covers a permit, and the open inspection times are an open-times card. The garage conversion is a plan checker’s decision, so it is held for staff. Every status, fee, date and time is in a card; Claude’s words state none.',
      'The page is PublicShell under the vision bar (its banner), with the open status, the city’s charter cards in the about column, and the suggestions under the conversation. The composer, Ask for Permit Center staff and the suggestions send nothing, and the first press of each shows the vision line under it, which the board doesn’t draw (owner’s ruling: say it once for every pictured control). The open times keep the kernel’s contract: a slots fact, and each option’s id the slot id of its start.',
      'Beyond what the kernel’s templates and lines render today, and drawn as a vision of what they could carry: the code prompt’s “to the email on the application” (the kernel writes “I’ll send a code to the contact on record.”); the open-times card’s title “Rough-in inspection”, its permit line and its time ranges (the kernel writes “Times that are open” and one start time per slot); the hours card’s “Inspections, …” line and the contact card’s second line (the kernel writes each window of the hours, unlabelled, and the contact verbatim, as one line); the system line’s “sent to the email on the application” (the app writes “Verified with a code”); and the receipts “Reply checked against the City’s rules”, “Code sent to the email on the application”, “Read from your own permit file” and “Times read from the inspection calendar” (the kernel’s visitor lines are “Reply checked against {owner}’s rules”, “Verification started” and “Times read from {owner}’s calendar”, and no tool reads a permit file). The permit answer is one reply drawn as prose, card, prose, card, where the kernel delivers a reply’s prose, then its cards.',
      'By the owner’s vision-copy ruling (2026-10-30: follow the product’s rules, keep the warmth), two lines differ from the board: Claude’s garage reply reads “Whether your garage conversion needs a permit is a plan checker’s decision. I’ve asked Permit Center staff, and the answer will show up here.” where the board writes “…, so I’ve asked one to get back to you.”, and its receipt is the kernel’s visitor line for a hold, “Waiting for Permit Center staff to approve”, where the board writes “Held for a person: whether work needs a permit is a staff decision”; the hold’s reason shows only on owner screens.',
      'The AI disclosure is the shell’s own sentence, which can’t be changed or turned off, where the board writes DisclosureLine’s shorter “Meridian Bay Permits answers with Claude, an AI.”; it takes a second line, so the page is 18 px longer.',
      'The permit status and the next steps are FactCards, at most 420 px wide, padded 12 px 14 px, with a 14 px icon and the fact in body type, where the board draws them in the reply card’s look (520 px, padded 16 px, a 16 px icon, the headline in section type); each is 109 px tall where the board’s is 115 px. With the disclosure, the page unrolled is 1491 px where the signed render drew 1485 px; the board is now drawn 1512 × 1491 on the canvas, and its render is captured at its full height. At the raised type scale (2026-11-02) the page unrolled is 1561 px. In the story the page is the window’s height, as every public page is, and the conversation scrolls between the pinned chat head and the composer.',
      'The footer’s “Powered by” mark is the bell, where the board draws the earlier counter mark.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    // The heights below are the page's once its two typefaces have loaded.
    await withinDeadline(Promise.all([document.fonts.load('15px "Hanken Grotesk"'), document.fonts.load('15px "Source Serif 4"')]), FONT_TIMEOUT, 'City office typefaces');
    await withinDeadline(document.fonts.ready, FONT_TIMEOUT, 'City office fonts');
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);

    // The city's public page right under the bar: its header, name and Permit Center, with the open status in About.
    const header = canvas.getByRole('banner');
    await expect(header.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);
    expectComputed(header, { height: '76px', backgroundColor: 'rgb(45, 61, 76)', borderBottomColor: 'rgb(111, 139, 163)' });
    await expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Meridian Bay Permits');
    await expect(header).toHaveTextContent('City of Meridian Bay, Permit Center');
    // Search the whole shell: the status is present once, in About on this wide board.
    const status = one(canvasElement, '.cd-public-shell__open-status');
    await expect(status).toHaveTextContent('Open now, until 4:30 pm');
    await expect(status).toBeVisible();
    await expect(header.querySelector('.cd-public-shell__open-status')).toBeNull();
    // A fictional office: no vision page names a real one.
    await expect(canvasElement.textContent).not.toMatch(/Oakland/);

    // The page is the window's height, as every public page is: the header, the AI disclosure and the
    // composer stay in view, and only the conversation scrolls. Unrolled, the page is the one the
    // board draws: the window's height and what the conversation's scroll region holds past it.
    const shellHeight = Math.round(one(canvasElement, '.cd-public-shell').getBoundingClientRect().height);
    await expect([shellHeight, document.documentElement.scrollHeight]).toEqual([982, 982]);
    const scroller = one(canvasElement, '.cd-public-shell__scroll');
    await expect(shellHeight + scroller.scrollHeight - scroller.clientHeight).toBe(PAGE_HEIGHT);
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);

    // The AI disclosure under the chat's title, and the staff to ask for.
    const main = canvas.getByRole('main');
    const disclosure = [...main.querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    await expect(disclosure).toHaveLength(1);
    const askStaff = within(main).getByRole('button', { name: 'Ask for Permit Center staff' });

    // The conversation: Marcus's messages, and Claude's words, which state no status, fee, date or time.
    const log = within(main).getByRole('log', { name: 'Conversation with Meridian Bay Permits' });
    expectConversationType(log);
    await expect(await expectNoFactsInProse(log)).toEqual({ prose: CLAUDE_LINES.length, receipts: RECEIPTS.length });
    await expect(some(log, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual(CLAUDE_LINES);
    await expect(some(log, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual(MARCUS_LINES);

    // Verified with a code to the email on the application, between the code's prompt and his permit.
    const verified = within(log).getByRole('status');
    await expect(verified).toHaveTextContent('Verified with a code sent to the email on the application');
    const [verifyCard, permitCard] = within(log).getAllByRole('article');
    await expect(verifyCard?.compareDocumentPosition(verified)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await expect(permitCard?.compareDocumentPosition(verified)).toBe(Node.DOCUMENT_POSITION_PRECEDING);

    // Every card in the conversation, word for word: the status and the next steps are fact cards,
    // the code's prompt and the open times reply cards under their templates' labels.
    const cards = within(log).getAllByRole('article');
    await expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(CONVERSATION_CARDS.map(([, label]) => label));
    for (const [index, [kind, label, words]] of CONVERSATION_CARDS.entries()) {
      const card = cards[index] as HTMLElement;
      await expect(card.closest(kind === 'fact' ? '.cd-fact-card' : '.cd-reply-card'), `${label}: a ${kind} card`).not.toBeNull();
      await expect(cardWords(card), `${label}: its words`).toEqual([...words]);
    }
    // The open times are a list to answer in the chat, not buttons.
    await expect(within(cards[3] as HTMLElement).getAllByRole('listitem')).toHaveLength(3);
    await expect(within(cards[3] as HTMLElement).queryByRole('button')).toBeNull();

    // The city's cards keep the kernel's contract, which the web app's vision page imports: each
    // open time is a slot id naming the time its label starts at, and each card reads its
    // template's kind of fact.
    await expect(CITY_INSPECTION_TIMES.options).toHaveLength(3);
    for (const option of CITY_INSPECTION_TIMES.options ?? []) {
      await expect(option.option_id, 'an open time is a slot id').toMatch(SLOT_ID);
      await expect(option.label.startsWith(`${slotStart(option.option_id)} `), `${option.option_id} starts its label "${option.label}"`).toBe(true);
    }
    for (const block of [CITY_INSPECTION_TIMES, ...CITY_DESK.charter]) {
      await expect(block.fact_id, `${block.template}'s fact`).toMatch(TEMPLATE_FACT_IDS[block.template ?? ''] ?? /^$/);
    }
    await expect(CITY_VERIFY_PROMPT.fact_id).toBeNull();

    // The fee is in the permit's card and nowhere else on the page.
    const money = linesWith(canvasElement, '$');
    await expect(money).toEqual(['Fee due before issue: $1,286']);
    await expect(within(cards[1] as HTMLElement).getByText('Fee due before issue: $1,286')).toBeVisible();
    // Outside the cards, nothing in the conversation says what the kernel's prose check would block.
    for (const line of linesOutsideCards(log)) {
      await expect(factsInProse(line), `outside a card: "${line}"`).toEqual([]);
    }

    // The receipts under each answer, in order: the reply's check, then what ran or what waits for a person.
    await expect(await expectReceiptsUnderMessages(log)).toBe(4);
    const receipts = some(log, '.cd-margin-line');
    await expect(receipts.map((line) => line.textContent)).toEqual(RECEIPTS.map(([words]) => words));
    await expect(receipts.map((line) => one(line, '.cd-status-dot').className)).toEqual(RECEIPTS.map(([, tone]) => `cd-status-dot cd-status-dot--${tone}`));
    await expect(log.querySelector('.cd-transcript-row__margin button')).toBeNull();
    // The garage question goes to staff: Claude's words alone, no card under them.
    const lastAnswer = some(log, '.cd-transcript-row__main').at(-1) as HTMLElement;
    await expect(lastAnswer).toHaveTextContent(CLAUDE_LINES[4] as string);
    await expect(lastAnswer.querySelector('.cd-card')).toBeNull();

    // What to try next, 20 px under the conversation.
    const chips = within(main).getByRole('group', { name: 'Try asking' });
    const chipButtons = within(chips).getAllByRole('button');
    await expect(chipButtons.map((chip) => chip.textContent)).toEqual(SUGGESTIONS);
    await expect(Math.round(chips.getBoundingClientRect().top - log.getBoundingClientRect().bottom)).toBe(20);

    // The about column: the city's hours, who decides what needs a permit, and how to reach the Permit Center.
    const about = canvas.getByRole('complementary', { name: 'About Meridian Bay Permits' });
    await expect(about.contains(status)).toBe(true);
    await expect(status.getBoundingClientRect().top).toBe(one(about, 'h2').getBoundingClientRect().bottom + 8);
    const aboutCards = within(about).getAllByRole('article');
    await expect(aboutCards.map((card) => card.getAttribute('aria-label'))).toEqual(ABOUT_CARDS.map(([label]) => label));
    for (const [index, [label, words]] of ABOUT_CARDS.entries()) {
      await expect(cardWords(aboutCards[index] as HTMLElement), `${label}: its words`).toEqual([...words]);
    }

    // The composer and the footer; a vision page makes no requests.
    const composer = within(main).getByRole('textbox', { name: 'Message Meridian Bay Permits' });
    expectComputed(one(main, '.cd-composer__box'), SPEC.composer);
    await expectFooter(canvasElement);
    await expect(canvasElement.querySelectorAll('[href*="/api/"]')).toHaveLength(0);

    // focus_order_is_logical: the bar, Ask for Permit Center staff, the suggestions, then the composer.
    await expectTabOrder(userEvent, [within(bar).getByRole('link', { name: 'Back to Vision' }), askStaff, ...chipButtons, composer]);

    // A vision page sends nothing, and each pictured control says so once, in its own line under it.
    // Send: typed words stay after Send and after Enter.
    await userEvent.type(composer, 'Thanks');
    await userEvent.click(within(main).getByRole('button', { name: 'Send' }));
    await expect(composer).toHaveValue('Thanks');
    const sendLine = one(main, '.cd-composer > .cd-vision-inert-line');
    await expect(sendLine).toHaveTextContent(VISION_INERT_LINE);
    await userEvent.click(composer);
    await userEvent.keyboard('{Enter}');
    await expect(composer).toHaveValue('Thanks');
    // Ask for Permit Center staff asks for no one, and keeps the focus.
    await userEvent.click(askStaff);
    await expect(askStaff).toHaveFocus();
    const askLine = one(main, '.cd-public-shell__chat-head > .cd-vision-inert-line');
    await expect(askLine).toHaveAttribute('role', 'status');
    await expect(askLine).toHaveTextContent(VISION_INERT_LINE);
    // A suggestion picks nothing, and keeps the focus. The chips end the conversation's scroll region,
    // so with the conversation scrolled to its end, the line their first pick shows is brought into
    // the region's view, fully inside it and under nothing (the composer is just below).
    scroller.scrollTop = scroller.scrollHeight;
    await userEvent.click(chipButtons[1] as HTMLElement);
    await expect(chipButtons[1]).toHaveFocus();
    const chipsLine = chips.nextElementSibling as HTMLElement;
    await expect(chipsLine).toHaveClass('cd-vision-inert-line');
    await expect(chipsLine).toHaveAttribute('role', 'status');
    await expect(chipsLine).toHaveTextContent(VISION_INERT_LINE);
    await expectInView(chipsLine, scroller);
    await expect(within(main).getAllByText(VISION_INERT_LINE)).toEqual([askLine, chipsLine, sendLine]);
  },
};

/** Every line of text under `root` holding `needle`, as its element reads it. */
function linesWith(root: HTMLElement, needle: string): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(needle)) lines.push(node.parentElement?.textContent ?? '');
  }
  return lines;
}
