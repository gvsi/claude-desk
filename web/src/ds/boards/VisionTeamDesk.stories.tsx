import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectOwnerFrame,
  expectNoFactsInProse,
  expectReceiptsUnderMessages,
  expectTabOrder,
  expectVisionBar,
  one,
  some,
} from './spec.ts';
import { LUIS_ACCESS, TEAMMATES, TEAM_REPLIES, TEAM_TODAY, TeamDeskConversations, VISION_BACK_HREF } from './vision.tsx';

const meta = {
  title: 'Boards/Vision, team desk',
  render: () => <TeamDeskConversations />,
  // Drawn at a 14-inch laptop's width and the page's own height, with its job and hours cards.
  globals: { viewport: { value: 'laptop-1061', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-TeamDesk',
    canvasNote: [
      'Signed on 2026-10-30. Turner Plumbing’s team asks its own Desk, the “Team” Desk in the sidebar’s Desk picker, with “Teammates” as its people’s word and the team’s Claude acts for you line.',
      'Luis’s messages are VisitorMessage bubbles and Claude’s words ClaudeMessage prose, each fact in a vision fact card; his access is the AccessPanel.',
      'Owner’s copy ruling, 2026-10-30, for invariant 2: the board’s “The gate code is on today’s job card.” and “I can show your own logged hours for last week if that helps.” put dates in Claude’s words. They read “The gate code is on her job card.” beside a Job card with the visit’s date and time, and “Here are your own logged hours.” beside an hours card with the week’s dates; the payroll receipt says “No pay was shared.” and a second receipt says the hours are Luis’s own. The kernel scans only Claude’s words; a real receipt is its own fixed line. These receipts are free text written for the page, so the story holds them to the kernel’s prose check too: the first names no time (“assigned to her visit”, the time being on the Job card), and the warranty’s says “Document released…”, as “warranty” is a promise word to that check. The page is 1061 px tall at 1512 px, as the components measure it (the redrawn canvas board is 1022 px); the board is to be redrawn to match.',
      'Receipts sit 8 px under what they explain, the system’s spacing, where the board leaves 6 px; the transcript’s rows are 14 px apart, the Transcript’s gap, where the board leaves 12 px.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 1061]);
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);
    await expectOwnerFrame(canvasElement, 'Conversations', { fill: true });
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(within(sidebar).getByRole('button', { name: 'Switch Desk, current: Team' })).toBeVisible();
    await expect(within(sidebar).getByRole('link', { name: 'Teammates' })).toBeVisible();
    await expect(within(sidebar).getByRole('switch', { name: 'Claude acts for you' })).toHaveAccessibleDescription('Within your rules');

    // The title and its line, "Add a teammate" at the right.
    const main = canvas.getByRole('main');
    const title = within(main).getByRole('heading', { level: 1, name: 'Conversations' });
    expectComputed(title, SPEC.pageTitle);
    const lead = within(main).getByText(/^Your team asks this Desk/);
    await expect(Math.round(lead.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(8);
    const add = within(main).getByRole('button', { name: 'Add a teammate' });

    // The teammates: Everyone, then each teammate with a hidden monogram, Luis current.
    const people = within(main).getByRole('navigation', { name: 'Teammates' });
    const rows = within(people).getAllByRole('link');
    await expect(rows.map((row) => row.textContent)).toEqual([
      'Everyone12 conversations today',
      ...TEAMMATES.map((person) => `${person.name.split(' ').map((word) => word[0]).join('')}${person.name}${person.line}`),
    ]);
    await expect(rows.filter((row) => row.getAttribute('aria-current') === 'page')).toEqual([rows[1]]);
    await expect(Math.round(people.getBoundingClientRect().width)).toBe(220);
    for (const avatar of some(people, '.board-vision-team__avatar')) await expect(avatar).toHaveAttribute('aria-hidden', 'true');

    // Luis's conversation: his messages in bubbles, Claude's words in serif, each fact a card.
    const chat = within(main).getByRole('region', { name: 'Luis Ortega' });
    await expect(within(chat).getByText('Teammate')).toHaveClass('cd-pill');
    const log = within(chat).getByRole('log', { name: 'Conversation with Luis Ortega' });
    expectConversationType(log);
    // Claude's words state no date, not even a relative one ("today", "last week"), and nothing else
    // only a card may say; the cards carry the dates.
    await expect(await expectNoFactsInProse(log)).toEqual({ prose: 3, receipts: 4 });
    await expect(await expectReceiptsUnderMessages(log)).toBe(3);
    // Claude's words, as the owner ruled them: helpful, with every date in a card.
    await expect(some(log, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual(TEAM_REPLIES);
    const facts = some(log, '.cd-fact-card');
    await expect(facts.map((fact) => one(fact, '.cd-fact-card__label').textContent)).toEqual([
      'Customer history',
      'Job card',
      'Document, only for Luis',
      'Your logged hours',
    ]);
    await expect(within(log).getByText('Water heater replaced, March 2024; under warranty until 2030').closest('.cd-fact-card')).not.toBeNull();
    // The visit's date and time, and the week's dates, sit in their cards.
    const [, jobCard, , hours] = facts as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    await expect(jobCard).toHaveTextContent(/Friday, October 30, 10:30 am/);
    await expect(hours).toHaveTextContent(/Monday, October 19 to Friday, October 23/);
    // The payroll request is refused; his own hours, from his time records, are shown.
    const receipts = some(log, '.cd-margin-line');
    await expect(receipts.map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'refused',
      'handled',
    ]);

    // Luis's access beside it: 260 px, 28 px to the conversation's right.
    const access = within(main).getByRole('region', { name: 'Luis’s access' });
    await expect(Math.round(access.getBoundingClientRect().width)).toBe(260);
    await expect(Math.round(access.getBoundingClientRect().left - chat.getBoundingClientRect().right)).toBe(28);
    await expect(within(access).getAllByRole('list').map((list) => within(list).getAllByRole('listitem').map((item) => item.textContent))).toEqual([
      [...LUIS_ACCESS.canOpen],
      [...LUIS_ACCESS.cantOpen],
    ]);

    // The day's line, then the footer at the foot.
    const today = within(main).getByText(TEAM_TODAY);
    expectComputed(today, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    await expectFooter(canvasElement);
    const footer = one(canvasElement, '[data-ds="concept-footer"]');
    await expect(Math.round(footer.getBoundingClientRect().top - today.getBoundingClientRect().bottom)).toBe(16);
    // The page fits its window exactly: nothing scrolls, and the footer sits 20 px over the window's foot.
    await expect(main.scrollHeight).toBe(main.clientHeight);
    await expect(Math.round(window.innerHeight - footer.getBoundingClientRect().bottom)).toBe(20);

    // focus_order_is_logical: the bar, the sidebar, the page's action, the teammates, the conversation's controls, then access.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to Vision' }),
      within(sidebar).getByRole('button', { name: 'Switch Desk, current: Team' }),
      within(sidebar).getByRole('switch', { name: 'Claude acts for you' }),
      add,
      ...rows,
      within(chat).getByRole('button', { name: 'Whisper' }),
      within(chat).getByRole('button', { name: 'Take over' }),
      within(access).getByRole('button', { name: 'Edit access' }),
    ]);
  },
};
