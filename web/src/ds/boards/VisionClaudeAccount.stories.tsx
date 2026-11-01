import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { VISION_INERT_LINE } from '../components/VisionBar/visionInert.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectNoFactsInProse,
  expectReceiptsUnderMessages,
  expectTabOrder,
  expectVisionBar,
  one,
  some,
} from './spec.ts';
import { CLAUDE_ACCOUNT_TURNS, ClaudeAccountChat, DANA_LAST_VISIT, VISION_BACK_HREF } from './vision.tsx';

const DISCLOSURE = "You're chatting with Claude, an AI answering for Turner Plumbing. Ask for Mike Turner anytime.";

const meta = {
  title: 'Boards/Vision, Claude account',
  render: () => <ClaudeAccountChat />,
  // Drawn at a 14-inch laptop's width and the page's own height, with Dana's last visit in it.
  globals: { viewport: { value: 'laptop-994', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-ClaudeAccount',
    canvasNote: [
      'Signed on 2026-10-30. Dana returns to Turner Plumbing’s public page signed in with her Claude account.',
      'Owner decision, 2026-10-30: a vision Claude account counts as verified when its verified email matches the contact on record, and her consent is asked on each visit; the receipts say both, word for word as the board writes them.',
      'Owner’s copy ruling, 2026-10-30, for invariant 2: the board’s “Thanks, it matches. Welcome back, Dana. Last time we booked your drain clearing. How did it go?” stated a booking in Claude’s words. Her last visit is now the kernel’s booking card in its rendered shape (“Tuesday, October 20”, “10:00 am to 12:00 pm”, “With Mike Turner”) under “Welcome back, Dana. How did the drain clearing go?”, and the board is to be redrawn to match.',
      'The vision bar is PublicShell’s banner, inside the page’s height. With Dana’s last visit, the page is 994 px tall at 1512 px, as the components measure it (the redrawn canvas board is 1013 px); the story runs at that height, so the page fits its window exactly. Once Send is pressed, “This is a vision page, so nothing is sent.” shows under the composer, which grows by its 24 px while the conversation gives them up, so the page stays 994 px; the board draws it before any press.',
      'The about column’s service-area card keeps Turner’s real service area, as the board draws it: the rule that no vision page names a real city office covers only the city office page (coordinator’s ruling, 2026-10-30).',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 994]);
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);

    // The public page right under the bar, the window's height: the brand header, the chat and the about column.
    const header = canvas.getByRole('banner');
    await expect(header.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);
    expectComputed(header, { height: '76px' });
    // The bar is inside the shell: the page is the shell, exactly its window's height, nothing added outside it.
    await expect(Math.round(one(canvasElement, '.cd-public-shell').getBoundingClientRect().height)).toBe(994);
    await expect(document.documentElement.scrollHeight).toBe(994);

    // The AI disclosure under the chat's title, as on every public page.
    const main = canvas.getByRole('main');
    const disclosure = [...main.querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    await expect(disclosure).toHaveLength(1);

    // Signed in with a Claude account: the line, then Claude asks to use it for this visit.
    const log = within(main).getByRole('log', { name: 'Conversation with Turner Plumbing' });
    await expect(within(log).getByText('Signed in with your Claude account.')).toBeVisible();
    expectConversationType(log);
    // Claude's words state no booking, date or promise: a past booking would need its card beside them.
    await expect(await expectNoFactsInProse(log)).toEqual({ prose: 3, receipts: 5 });
    const prose = some(log, '.cd-claude-message__prose').map((line) => line.textContent);
    await expect(prose).toEqual([CLAUDE_ACCOUNT_TURNS.ask, CLAUDE_ACCOUNT_TURNS.matched, CLAUDE_ACCOUNT_TURNS.sent]);
    await expect(some(log, '.cd-visitor-message__bubble').map((bubble) => bubble.textContent)).toEqual([
      CLAUDE_ACCOUNT_TURNS.yes,
      CLAUDE_ACCOUNT_TURNS.invoice,
    ]);

    // claude_account_counts_with_consent: the match and the consent are in the receipts, in order.
    await expect(await expectReceiptsUnderMessages(log)).toBe(3);
    const lines = some(log, '.cd-margin-line').map((line) => line.textContent);
    await expect(lines).toEqual([
      CLAUDE_ACCOUNT_TURNS.checked,
      CLAUDE_ACCOUNT_TURNS.matchedReceipt,
      CLAUDE_ACCOUNT_TURNS.checked,
      CLAUDE_ACCOUNT_TURNS.checked,
      CLAUDE_ACCOUNT_TURNS.releasedReceipt,
    ]);
    await expect(log.querySelector('.cd-transcript-row__margin button')).toBeNull();

    // Her last visit is the kernel's booking card under the welcome, in her message: the date, the job and who.
    const lastVisit = within(log).getByRole('article', { name: 'Booked' });
    await expect(lastVisit.textContent).toBe('BookedTuesday, October 2010:00 am to 12:00 pmWith Mike Turner');
    await expect(lastVisit.closest('.cd-claude-message')?.textContent).toContain(CLAUDE_ACCOUNT_TURNS.matched);

    // The invoice is a document card, only for her, with its download.
    const invoice = within(log).getByRole('article', { name: 'Document, only for you' });
    await expect(invoice).toHaveTextContent('Invoice, drain clearing');
    // A vision page makes no requests: Download is drawn as the board draws it, a button going nowhere.
    const download = within(invoice).getByRole('button', { name: 'Download' });
    expectComputed(download, SPEC.primary);
    await expect(canvasElement.querySelectorAll('a[href*="/api/"], [href*="/api/"]')).toHaveLength(0);
    await expect(canvasElement.innerHTML).not.toContain('/api/d/');

    // The about column: hours, the service area and the phone, as the board draws them.
    const about = canvas.getByRole('complementary', { name: 'About Turner Plumbing' });
    await expect(within(about).getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Hours', 'Service area', 'Contact']);
    expectComputed(one(main, '.cd-composer__box'), SPEC.composer);
    await expectFooter(canvasElement);

    // focus_order_is_logical: the bar, Ask for Mike Turner, the download, then the composer.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to Vision' }),
      within(main).getByRole('button', { name: 'Ask for Mike Turner' }),
      download,
      within(main).getByRole('textbox', { name: 'Message Turner Plumbing' }),
    ]);

    // A vision page sends nothing: typed words stay after Send and after Enter.
    const composer = within(main).getByRole('textbox', { name: 'Message Turner Plumbing' });
    await userEvent.type(composer, 'Thanks again');
    await userEvent.click(within(main).getByRole('button', { name: 'Send' }));
    await expect(composer).toHaveValue('Thanks again');
    // The press says why nothing was sent: the line, announced, under the composer. The composer
    // grows by its 24 px and the conversation gives them up, so the page stays the window's height
    // and the line shows inside it.
    const line = within(main).getByText(VISION_INERT_LINE);
    await expect(line).toHaveAttribute('role', 'status');
    await expect(document.documentElement.scrollHeight).toBe(994);
    await expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.click(composer);
    await userEvent.keyboard('{Enter}');
    await expect(composer).toHaveValue('Thanks again');

    // Ask for Mike Turner asks for no one either: it keeps the focus, and its first press says so
    // once, in its own line in the chat's pinned head.
    const ask = within(main).getByRole('button', { name: 'Ask for Mike Turner' });
    await userEvent.click(ask);
    await expect(ask).toHaveFocus();
    const askLine = one(main, '.cd-public-shell__chat-head > .cd-vision-inert-line');
    await expect(askLine).toHaveAttribute('role', 'status');
    await expect(askLine).toHaveTextContent(VISION_INERT_LINE);
    await expect(within(main).getAllByText(VISION_INERT_LINE)).toEqual([askLine, line]);
  },
};
