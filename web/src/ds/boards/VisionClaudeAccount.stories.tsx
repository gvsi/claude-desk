import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import { SPEC, expectConversationType, expectFooter, expectReceiptsUnderMessages, expectTabOrder, expectVisionBar, one, some } from './spec.ts';
import { CLAUDE_ACCOUNT_TURNS, ClaudeAccountChat, VISION_BACK_HREF } from './vision.tsx';

const DISCLOSURE = "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.";

const meta = {
  title: 'Boards/Vision, Claude account',
  render: () => <ClaudeAccountChat />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-ClaudeAccount',
    canvasNote: [
      'Signed on 2026-10-30. Dana returns to Rivera Plumbing’s public page signed in with her Claude account.',
      'Owner decision, 2026-10-30: a vision Claude account counts as verified when its verified email matches the contact on record, and her consent is asked on each visit; the receipts say both, word for word as the board writes them.',
      'The vision bar is PublicShell’s banner, so the page keeps the window’s height under it, as the board draws it.',
      'The about column’s service-area card names real cities from Rivera’s charter, as the board draws it.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);

    // The public page right under the bar, the window's height: the brand header, the chat and the about column.
    const header = canvas.getByRole('banner');
    await expect(header.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);
    expectComputed(header, { height: '76px' });
    await expect(Math.round(one(canvasElement, '.cd-public-shell').getBoundingClientRect().height)).toBe(982);
    await expect(document.documentElement.scrollHeight).toBe(982);

    // The AI disclosure under the chat's title, as on every public page.
    const main = canvas.getByRole('main');
    const disclosure = [...main.querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    await expect(disclosure).toHaveLength(1);

    // Signed in with a Claude account: the line, then Claude asks to use it for this visit.
    const log = within(main).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
    await expect(within(log).getByText('Signed in with your Claude account.')).toBeVisible();
    expectConversationType(log);
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

    // The invoice is a document card, only for her, with its download.
    const invoice = within(log).getByRole('article', { name: 'Document, only for you' });
    await expect(invoice).toHaveTextContent('Invoice, drain clearing');
    const download = within(invoice).getByRole('link', { name: 'Download' });
    expectComputed(download, SPEC.primary);

    // The about column: hours, the service area and the phone, as the board draws them.
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expect(within(about).getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Hours', 'Policy', 'Contact']);
    expectComputed(one(main, '.cd-composer__box'), SPEC.composer);
    await expectFooter(canvasElement);

    // focus_order_is_logical: the bar, Ask for Maria Rivera, the download, then the composer.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to your Desk' }),
      within(main).getByRole('button', { name: 'Ask for Maria Rivera' }),
      download,
      within(main).getByRole('textbox', { name: 'Message Rivera Plumbing' }),
    ]);
  },
};
