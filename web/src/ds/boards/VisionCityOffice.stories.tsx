import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import { SPEC, expectFooter, expectOwnerFrame, expectTabOrder, expectVisionBar, one, some } from './spec.ts';
import { CITY_LIVE, CityOfficeToday, VISION_BACK_HREF } from './vision.tsx';

const meta = {
  title: 'Boards/Vision, city office',
  render: () => <CityOfficeToday />,
  // Drawn at a 14-inch laptop's width and the page's own 1072 px height.
  globals: { viewport: { value: 'laptop-1072', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-CityOffice',
    canvasNote: [
      'Signed on 2026-10-30. Meridian Bay Permits is a fictional city permits office; no real office is named.',
      'The vision bar is AppShell’s banner; the sidebar is the one Sidebar, with the city’s Answering line (answeringDescription), “Residents” and Nadia Price.',
      'Each fee, date and permit status is a FactCard; Claude’s words lead into it and state none of them.',
      'Ruled departure (coordinator, 2026-10-30): Marcus Bell’s reply reads “Here’s where your kitchen remodel stands.” where the board writes “Your kitchen remodel passed plan check. Here’s where it stands.”, so the permit’s status stays in its card.',
      'Ruled departure (coordinator, 2026-10-30): Live now is a list of rows split by hairlines, each fact card in its row, where the board draws each conversation as a card with its fact card inside; a card never sits inside a card (Card throws on it).',
      'The header is Today’s Greeting: the presence line in body type and the link in Greeting’s pill with its copy button, where the board draws a 13 px line and a plain 28 px chip.',
      'Receipts sit 8 px under what they explain, the system’s spacing, where the board leaves 14 px.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Money, a date or a time, a permit's number or its status: what only a card may say on a Desk.
 * The board's first reply said "Your kitchen remodel passed plan check."; by the coordinator's
 * ruling (2026-10-30) the status stays in the card and Claude's words only lead into it.
 */
const FACT_IN_PROSE = /\$\s?\d|\d{1,2}:\d{2}|\b\d{1,2} de [a-z]+|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\bStatus\b|\bB-\d{4}-\d{4}\b|\bissued\b|\bpassed\b|\bapproved\b/i;

/** Claude's words on each live conversation, as ruled: they lead into the card and state no fact. */
const REPLIES = [
  'Here’s where your kitchen remodel stands.',
  'Esta es la fecha límite del programa.',
  'Plans and applicant details go only to the applicant. Here’s what’s public.',
  'Whether your garage conversion is exempt is a plan checker’s decision. I’ve asked one to join.',
];

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 1072]);
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);
    await expectOwnerFrame(canvasElement, 'Today', { fill: true });
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(sidebar.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);

    // The city's sidebar: its business, its people's word, its Answering line and its supervisor.
    await expect(within(sidebar).getByRole('button', { name: 'Switch business, current: Meridian Bay Permits' })).toBeVisible();
    await expect(within(sidebar).getByRole('link', { name: 'Residents' })).toBeVisible();
    await expect(within(sidebar).getByRole('switch', { name: 'Answering' })).toHaveAccessibleDescription('Claude answers under the City’s rules');
    await expect(within(sidebar).getByText('Permit Center supervisor')).toBeVisible();

    // The page: padded 24 px 40 px from the sidebar's seam, the greeting at its top.
    const main = canvas.getByRole('main');
    const greeting = within(main).getByRole('heading', { level: 1, name: 'Good morning, Nadia' });
    expectComputed(greeting, SPEC.greeting);
    await expect(Math.round(greeting.getBoundingClientRect().left)).toBe(264 + 40);
    await expect(within(main).getByText('Nine residents are talking to the Desk right now.')).toBeVisible();
    await expect(within(main).getByText('desk.example/meridian-bay-permits')).toBeVisible();

    // Live now: the four conversations, each with who, their level and what it is about.
    const live = within(main).getByRole('region', { name: 'Live now' });
    await expect(within(live).getByRole('link', { name: 'See all in Conversations' })).toBeVisible();
    const items = within(within(live).getByRole('list')).getAllByRole('listitem');
    await expect(items.map((item) => one(item, '[data-copy="user"]').textContent)).toEqual(CITY_LIVE.map((row) => row.name));
    await expect(items.map((item) => one(item, '.cd-pill').textContent)).toEqual(['Verified', 'Public', 'Public', 'Verified']);
    await expect(live.querySelectorAll('.cd-card:not(.cd-fact-card .cd-card)')).toHaveLength(0);

    // vision_facts_only_in_cards: every fee, date and status sits in a fact card, and none is in Claude's words.
    const prose = some(live, '.cd-claude-message__prose');
    await expect(prose.map((line) => line.textContent)).toEqual(REPLIES);
    for (const line of prose) {
      expectComputed(line, SPEC.reply);
      await expect(line.textContent ?? '', 'Claude’s words state no fee, date or status').not.toMatch(FACT_IN_PROSE);
    }
    const facts = some(live, '.cd-fact-card');
    await expect(facts.map((fact) => fact.querySelector('.cd-fact-card__label')?.textContent)).toEqual(['Permit status', 'Fecha límite', 'Public record']);
    for (const fact of ['Fee due before issue: $1,286', 'Cierra el 15 de diciembre, 5:00 pm', 'Status: issued', 'Plan check passed']) {
      await expect(within(live).getByText(fact).closest('.cd-fact-card')).not.toBeNull();
    }
    await expect(one(live, '.cd-fact-card[lang="es"]')).toHaveTextContent('Programa de refuerzo sísmico');

    // Each receipt under its conversation in its tone: handled, handled, refused, held for a person.
    const receipts = items.map((item) => one(item, '.cd-margin-line'));
    await expect(receipts.map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'refused',
      'held',
    ]);
    for (const receipt of receipts) expectComputed(receipt, SPEC.receipt);
    const assign = within(items[3] as HTMLElement).getByRole('button', { name: 'Assign staff' });

    // The right column: what can't be switched off, and today's numbers.
    const alwaysOn = within(main).getByRole('region', { name: 'Always on' });
    await expect(alwaysOn.getBoundingClientRect().left).toBeGreaterThan(live.getBoundingClientRect().right);
    await expect(Math.round(alwaysOn.getBoundingClientRect().width)).toBe(360);
    expectComputed(alwaysOn, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    await expect(within(alwaysOn).getAllByRole('listitem').map((item) => item.querySelector('.cd-type-control')?.textContent)).toEqual([
      'No legal or financial determinations without a qualified person',
      'Files only to the applicant',
      'No promised outcomes',
    ]);
    await expect(alwaysOn.querySelectorAll('button, input, a')).toHaveLength(0);
    const today = within(main).getByRole('region', { name: 'Today so far' });
    await expect(within(today).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '214 questions answered in 6 languages',
      '38 applicants verified for their own files',
      '7 handed to staff',
      '0 determinations made without a person',
    ]);
    await expect(main.textContent).not.toMatch(/Oakland/);
    await expectFooter(canvasElement);

    // focus_order_is_logical: the bar's link, the sidebar, then the page from the top.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to your Desk' }),
      within(sidebar).getByRole('button', { name: 'Switch business, current: Meridian Bay Permits' }),
      within(sidebar).getByRole('switch', { name: 'Answering' }),
      within(main).getByRole('button', { name: 'Copy your Desk link' }),
      within(live).getByRole('link', { name: 'See all in Conversations' }),
      assign,
    ]);
  },
};
