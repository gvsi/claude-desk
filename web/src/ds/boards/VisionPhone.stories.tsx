import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import { SPEC, expectConversationType, expectFooter, expectReceiptsUnderMessages, expectVisionBar, one } from './spec.ts';
import { PhoneApps, VISION_BACK_HREF } from './vision.tsx';

const meta = {
  title: 'Boards/Vision, phone',
  render: () => <PhoneApps />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-Phone',
    canvasNote: [
      'Signed on 2026-10-30. The owner’s Today and a visitor’s chat as phone apps, each in a PhoneFrame; the owner’s with the five-tab PhoneTabBar.',
      'The held quote is Today’s ApprovalCard: a limit hold for a visitor not on record, so its answers are the two plain buttons of the signed answer board (N-Answers-TwoButtons), and it says where and when it was held; the board draws two menu buttons and no waiting line.',
      'The visitor’s composer is the real Composer with its send button, where the board draws a plain field.',
      'The booking is confirmed only next to its card: the time and the day are in the Booked FactCard.',
      'The board is cut at the window’s foot; the page runs on to the footer under the phones.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);
    const main = canvas.getByRole('main');
    await expect(main.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);

    // The title centered over the phones.
    const title = within(main).getByRole('heading', { level: 1, name: 'Claude Desk on a phone' });
    expectComputed(title, SPEC.pageTitle);
    const titleBox = title.getBoundingClientRect();
    await expect(Math.round(titleBox.left + titleBox.width / 2)).toBe(756);
    await expect(within(main).getByText('The owner’s Today and a visitor’s chat, as phone apps.')).toBeVisible();

    // Two phones, 64 px apart, centered, each captioned.
    const owner = within(main).getByRole('figure', { name: 'Today, for the owner' });
    const visitor = within(main).getByRole('figure', { name: 'The public chat, for a visitor' });
    const [ownerScreen, visitorScreen] = [one(owner, '.cd-phone-frame__screen'), one(visitor, '.cd-phone-frame__screen')];
    await expect(Math.round(visitorScreen.getBoundingClientRect().left - ownerScreen.getBoundingClientRect().right)).toBe(64);
    await expect(Math.round(ownerScreen.getBoundingClientRect().left)).toBe(334);
    await expect(Math.round(ownerScreen.getBoundingClientRect().top - bar.getBoundingClientRect().bottom)).toBe(106);

    // The owner's phone: the greeting, the held quote and Live now, over the five tabs, Today current.
    await expect(within(owner).getByRole('heading', { level: 2, name: 'Good morning, Maria' })).toBeVisible();
    const held = within(owner).getByRole('article', { name: /^Held for you:/ });
    await expect(within(held).getByRole('button', { name: 'Allow this time' })).toBeVisible();
    await expect(within(held).getByRole('button', { name: 'Deny this time' })).toBeVisible();
    const live = within(owner).getByRole('region', { name: 'Live now' });
    await expect(within(live).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Lucía HerreraVisitor', 'Alex Kim’s assistantAgent']);
    const tabs = within(within(owner).getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    await expect(tabs.map((tab) => tab.textContent)).toEqual(['Today', 'Chats', 'Rules', 'Safety', 'More']);
    await expect(tabs[0]).toHaveAttribute('aria-current', 'page');

    // The visitor's phone: the business's header with the disclosure, the booking next to its card, the composer.
    await expect(within(visitor).getByText('Claude, an AI, answers for Maria Rivera')).toBeVisible();
    const log = within(visitor).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
    expectConversationType(log);
    await expect(await expectReceiptsUnderMessages(log)).toBe(1);
    const booked = within(log).getByRole('article', { name: 'Booked' });
    await expect(booked).toHaveTextContent('Tuesday, November 3Arriving 2:00 pm to 4:00 pmWith Maria Rivera');
    const reply = one(log, '.cd-claude-message__prose');
    await expect(reply.textContent).toBe('Maria will text you when she’s on her way.');
    await expect(reply.textContent ?? '').not.toMatch(/\d|Tuesday|November/);
    await expect(within(visitor).getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeVisible();
    await expect(within(visitor).getByText('This chat is with Claude, an AI.')).toBeVisible();

    // Nothing scrolls sideways, and the footer follows the phones.
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    await expectFooter(canvasElement);
  },
};
