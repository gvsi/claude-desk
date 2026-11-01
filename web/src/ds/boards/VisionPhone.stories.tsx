import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { VISION_INERT_LINE } from '../components/VisionBar/visionInert.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { SPEC, expectConversationType, expectFooter, expectNoFactsInProse, expectReceiptsUnderMessages, expectTabOrder, expectVisionBar, one } from './spec.ts';
import { PHONE_REPLY, PhoneApps, VISION_BACK_HREF } from './vision.tsx';

const meta = {
  title: 'Boards/Vision, phone',
  render: () => <PhoneApps />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-Phone',
    canvasNote: [
      'Signed on 2026-10-30. The owner’s Today and a visitor’s chat as phone apps, each in a PhoneFrame; the owner’s with the five-tab PhoneTabBar.',
      'The held quote is Today’s ApprovalCard: a limit hold for a visitor not on record, so its answers are the two plain buttons of the signed answer board (N-Answers-TwoButtons), and it says where and when it was held, with the card’s own spacing between its lines; the board draws two menu buttons, no waiting line and tighter lines.',
      'The visitor’s composer is the real Composer with its send button, where the board draws a plain field. Nothing on a vision page is sent: once Send is pressed, “This is a vision page, so nothing is sent.” shows 8 px under the composer (owner’s ruling, 2026-10-30), and the held quote’s answers say the same under them when pressed.',
      'Owner’s copy ruling, 2026-10-30, for invariant 2: the board’s “Mike will text you when he’s on his way.” promised what no card backs, and its booking was drawn as a plain fact card. Claude now says “You’re all set. Here’s your visit.” beside the kernel’s booking card (booking_confirmed) in its rendered shape: “Tuesday, November 3”, “2:00 pm to 4:00 pm”, “With Mike Turner”, with no booking number; the board is to be redrawn to match.',
      'The board is cut at the window’s foot; the page runs on to the footer under the phones.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
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
    await expect(within(owner).getByRole('heading', { level: 2, name: 'Good morning, Mike' })).toBeVisible();
    const held = within(owner).getByRole('article', { name: /^Held for you:/ });
    await expect(within(held).getByRole('button', { name: 'Allow this time' })).toBeVisible();
    await expect(within(held).getByRole('button', { name: 'Deny this time' })).toBeVisible();
    const live = within(owner).getByRole('region', { name: 'Live now' });
    await expect(within(live).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Lucía HerreraVisitor', 'Alex Kim’s assistantAgent']);
    // Live now ends inside the phone's screen, above its tab bar: nothing is cut off.
    const ownerTabs = within(owner).getByRole('navigation', { name: "The owner app's tabs" });
    await expect(live.getBoundingClientRect().bottom).toBeLessThanOrEqual(ownerTabs.getBoundingClientRect().top);
    const tabs = within(within(owner).getByRole('navigation', { name: "The owner app's tabs" })).getAllByRole('link');
    await expect(tabs.map((tab) => tab.textContent)).toEqual(['Today', 'Chats', 'Rules', 'Safety', 'More']);
    await expect(tabs[0]).toHaveAttribute('aria-current', 'page');

    // The visitor's phone: the business's header with the disclosure, the booking next to its card, the composer.
    await expect(within(visitor).getByText('Claude, an AI, answers for Mike Turner')).toBeVisible();
    const log = within(visitor).getByRole('log', { name: 'Conversation with Turner Plumbing' });
    expectConversationType(log);
    // The booking is confirmed only by its card: Claude's words state no date, time or booking, and
    // promise nothing the card doesn't back.
    await expect(await expectNoFactsInProse(log)).toEqual({ prose: 1, receipts: 1 });
    await expect(await expectReceiptsUnderMessages(log)).toBe(1);
    // The booking is the kernel's booking card, in the same message as Claude's words.
    const booked = within(log).getByRole('article', { name: 'Booked' });
    // The kernel's booking card, as it renders one: the day, when Mike arrives, and who.
    await expect(booked.textContent).toBe('BookedTuesday, November 32:00 pm to 4:00 pmWith Mike Turner');
    const reply = one(log, '.cd-claude-message__prose');
    await expect(reply.textContent).toBe(PHONE_REPLY);
    await expect(booked.closest('.cd-claude-message')).toBe(reply.closest('.cd-claude-message'));
    await expect(within(visitor).getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeVisible();
    await expect(within(visitor).getByText('This chat is with Claude, an AI.')).toBeVisible();

    // focus_order_is_logical: the bar's link, the held quote's answers, the five tabs, then the
    // visitor's composer and Send. Send is disabled while the box is empty, so a message is typed first.
    const composer = within(visitor).getByRole('textbox', { name: 'Message Turner Plumbing' });
    await userEvent.type(composer, 'Thanks');
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to Vision' }),
      within(held).getByRole('button', { name: 'Allow this time' }),
      within(held).getByRole('button', { name: 'Deny this time' }),
      ...tabs,
      composer,
      within(composer.closest('.cd-composer') as HTMLElement).getByRole('button', { name: 'Send' }),
    ]);

    // A vision page sends nothing: an answer leaves the held quote as it was, and Send keeps the words.
    const allow = within(held).getByRole('button', { name: 'Allow this time' });
    const deny = within(held).getByRole('button', { name: 'Deny this time' });
    await userEvent.click(allow);
    await expect(within(held).getByRole('group', { name: 'Your answer' })).not.toHaveAttribute('aria-busy');
    // The press says why nothing was sent: the line, announced, 8 px under the answers' row.
    const answerLine = within(held).getByText(VISION_INERT_LINE);
    await expect(answerLine).toHaveAttribute('role', 'status');
    const answersRow = one(held, '.cd-approval-card__row');
    await expect(Math.round(answerLine.getBoundingClientRect().top - answersRow.getBoundingClientRect().bottom)).toBe(8);
    for (const answer of [allow, deny]) {
      await expect(answer).not.toHaveAttribute('aria-disabled');
      await expect(answer).not.toHaveAttribute('aria-busy');
    }
    await expect(within(held).getByText('Waiting for your answer')).toBeVisible();
    await userEvent.click(within(visitor).getByRole('button', { name: 'Send' }));
    await expect(composer).toHaveValue('Thanks');
    // The first press says why nothing was sent: one quiet line, announced, 8 px under the composer.
    const line = within(visitor).getByText(VISION_INERT_LINE);
    await expect(line).toHaveAttribute('role', 'status');
    expectComputed(line, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    const box = composer.closest('.cd-composer__box') as HTMLElement;
    await expect(Math.round(line.getBoundingClientRect().top - box.getBoundingClientRect().bottom)).toBe(8);
    await userEvent.click(composer);
    await userEvent.keyboard('{Enter}');
    await expect(composer).toHaveValue('Thanks');
    await expect(within(visitor).getAllByText(VISION_INERT_LINE)).toHaveLength(1);

    // Nothing scrolls sideways, and the footer follows the phones.
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    await expectFooter(canvasElement);
  },
};
