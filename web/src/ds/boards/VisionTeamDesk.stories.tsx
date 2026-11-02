import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectOwnerFrame,
  factsInProse,
  expectReceiptsUnderMessages,
  expectTabOrder,
  expectVisionBar,
  one,
  some,
} from './spec.ts';
import { JORDAN_ACCESS, TEAMMATES, TEAM_REPLIES, TEAM_TODAY, TeamDeskConversations, VISION_BACK_HREF } from './vision.tsx';

const meta = {
  title: 'Boards/Vision, team desk',
  render: () => <TeamDeskConversations />,
  // Drawn at a 14-inch laptop's width, with the same components as the page.
  globals: { viewport: { value: 'laptop-1061', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-TeamDesk',
    canvasNote: [
      'Sam Patel’s own Desk at Lumen Labs, with “Sam Patel” in the Desk picker and “Colleagues” in the sidebar.',
      'Jordan asks for time, the launch checklist and the Q4 budget. VisitorMessage bubbles, ClaudeMessage prose, fact cards, MarginReceipt lines and the AccessPanel keep the page’s existing layout.',
      'Claude’s words state no time; the Calendar hold card carries it. The fixed green receipt names Sam’s allowed duration, “30 minutes”. The kernel scans Claude’s prose, not its fixed receipts; this story checks the prose and asserts the exact receipt words and tones separately.',
      'Receipts sit 8 px under what they explain; transcript rows are 14 px apart, using the existing components.',
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
    await expect(within(sidebar).getByRole('button', { name: 'Switch Desk, current: Sam Patel' })).toBeVisible();
    await expect(within(sidebar).getByRole('button', { name: 'Switch business, current: Lumen Labs' })).toBeVisible();
    await expect(within(sidebar).getAllByText('Sam Patel', { exact: true })).toHaveLength(2);
    await expect(within(sidebar).getByText('Available for chats')).toBeVisible();
    await expect(within(sidebar).getByRole('link', { name: 'Conversations 7 colleague conversations today' })).toBeVisible();
    await expect(within(sidebar).getByRole('link', { name: 'Colleagues' })).toBeVisible();
    await expect(canvasElement.textContent).not.toMatch(/Turner|plumb|Luis|Ben Carter|Grace Lee|Ana Ruiz|Eastshore|payroll|warrant|gate code|job records|from the van/i);
    await expect(within(sidebar).getByRole('switch', { name: 'Claude acts for you' })).toHaveAccessibleDescription('Within your rules');

    // The title and its line, "Share your Desk" at the right.
    const main = canvas.getByRole('main');
    const title = within(main).getByRole('heading', { level: 1, name: 'Conversations' });
    expectComputed(title, SPEC.pageTitle);
    const lead = within(main).getByText('Colleagues ask your Desk before they interrupt you: when you’re free, where things are, who owns what. Each person sees only what your rules open to them.');
    await expect(Math.round(lead.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(8);
    const add = within(main).getByRole('button', { name: 'Share your Desk' });

    // The colleagues: Everyone, then each colleague with a hidden monogram, Jordan current.
    const people = within(main).getByRole('navigation', { name: 'Colleagues' });
    const rows = within(people).getAllByRole('link');
    await expect(rows.map((row) => row.textContent)).toEqual([
      'Everyone7 conversations today',
      ...TEAMMATES.map((person) => `${person.name.split(' ').map((word) => word[0]).join('')}${person.name}${person.line}`),
    ]);
    await expect(rows.filter((row) => row.getAttribute('aria-current') === 'page')).toEqual([rows[1]]);
    await expect(Math.round(people.getBoundingClientRect().width)).toBe(220);
    for (const avatar of some(people, '.board-vision-team__avatar')) await expect(avatar).toHaveAttribute('aria-hidden', 'true');

    // Jordan's conversation: his messages in bubbles, Claude's words in serif, each fact a card.
    const chat = within(main).getByRole('region', { name: 'Jordan Lee' });
    await expect(within(chat).getByText('Colleague')).toHaveClass('cd-pill');
    await expect(within(chat).getByText('In Slack, 9:42 am')).toBeVisible();
    const log = within(chat).getByRole('log', { name: 'Conversation with Jordan Lee' });
    expectConversationType(log);
    // Claude's words state no date, not even a relative one ("today", "last week"), and nothing else
    // only a card may say; the cards carry the dates.
    const prose = some(log, '.cd-claude-message__prose');
    await expect(prose).toHaveLength(3);
    for (const line of prose) await expect(factsInProse(line.textContent ?? '')).toEqual([]);
    await expect(await expectReceiptsUnderMessages(log)).toBe(3);
    // Claude's words, as the owner ruled them: helpful, with every date in a card.
    await expect(some(log, '.cd-claude-message__prose').map((line) => line.textContent)).toEqual(TEAM_REPLIES);
    await expect(some(log, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual([
      'Can I grab 30 minutes with Sam this week?',
      'Where’s the launch checklist?',
      'Can you send me the Q4 budget?',
    ]);
    const facts = some(log, '.cd-fact-card');
    await expect(facts.map((fact) => fact.textContent)).toEqual([
      'Calendar holdThursday, November 5, 2:00 pm30 minutes with Sam Patel: launch review',
      'Document, open to colleaguesLaunch checklist, Q4',
    ]);
    const receipts = some(log, '.cd-margin-line');
    await expect(receipts.map((receipt) => receipt.textContent)).toEqual([
      'Open to colleagues: Sam lets them hold 30 minutes.',
      'From Sam’s docs. Everyone at Lumen Labs can open it.',
      'Held for Sam. Nothing was shared.',
    ]);
    await expect(receipts.map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'held',
    ]);

    // Jordan's access beside it: 260 px, 28 px to the conversation's right.
    const access = within(main).getByRole('region', { name: 'Jordan’s access' });
    await expect(Math.round(access.getBoundingClientRect().width)).toBe(260);
    await expect(Math.round(access.getBoundingClientRect().left - chat.getBoundingClientRect().right)).toBe(28);
    await expect(within(access).getAllByRole('list').map((list) => within(list).getAllByRole('listitem').map((item) => item.textContent))).toEqual([
      [...JORDAN_ACCESS.canOpen],
      [...JORDAN_ACCESS.cantOpen],
    ]);

    // The day's line, then the footer at the foot.
    const today = within(main).getByText(TEAM_TODAY);
    expectComputed(today, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    await expectFooter(canvasElement);
    const footer = one(canvasElement, '[data-ds="concept-footer"]');
    await expect(Math.round(footer.getBoundingClientRect().top - today.getBoundingClientRect().bottom)).toBe(16);
    // The page fits its window exactly: nothing scrolls, and the footer sits 20 px over the window's foot.
    await expect(main.scrollHeight).toBe(main.clientHeight);
    await expect(Math.round(window.innerHeight - footer.getBoundingClientRect().bottom)).toBe(20);

    // focus_order_is_logical: the bar, the sidebar, the page's action, the colleagues, the conversation's controls, then access.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to Vision' }),
      within(sidebar).getByRole('button', { name: 'Switch Desk, current: Sam Patel' }),
      within(sidebar).getByRole('switch', { name: 'Claude acts for you' }),
      add,
      ...rows,
      within(chat).getByRole('button', { name: 'Whisper' }),
      within(chat).getByRole('button', { name: 'Take over' }),
      within(access).getByRole('button', { name: 'Edit access' }),
    ]);
  },
};
