import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { brandOf } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectReceiptsUnderMessages, one } from './spec.ts';

/** Claude's answer to the visitor, as the board writes it: Claude's own message, before the Desk's. */
const ANSWER = 'The payment link I sent earlier was cancelled. Mike changed his rules, so a new link needs his answer.';

/**
 * The Desk's own link_cancelled card for the deposit link, as the kernel renders it from the link's
 * fact: the amount, then what the link was for and the kernel's line.
 */
const CARD = { ...rivera.blocks.link_cancelled.en, lines: rivera.blocks.link_cancelled.en.lines ?? [] };

function ChatLinkCancelled() {
  return (
    <PublicShell
      brand={brandOf(rivera.publicDesk.en)}
      ownerName={rivera.business.ownerName}
      language="en"
      onAskForOwner={fn()}
      about={rivera.publicDesk.en.charter.slice(0, 2)}
      composer={<Composer variant="visitor" label="Message Turner Plumbing" placeholder="Message Turner Plumbing" maxLength={2000} onSend={fn()} />}
    >
      <Transcript label="Conversation with Turner Plumbing">
        <TranscriptRow>
          <VisitorMessage text="I clicked the payment link but it says it’s gone?" />
        </TranscriptRow>
        <TranscriptRow margin={[<MarginReceipt key="reply" source={{ kind: 'reply', handoff: false }} plain="Reply checked against Mike Turner’s rules" ledgerSeq={61} />]}>
          <ClaudeMessage blocks={[{ kind: 'prose', text: ANSWER }]} language="en" ownerName={rivera.business.ownerName} />
        </TranscriptRow>
        <TranscriptRow
          margin={[<MarginReceipt key="link" source={{ kind: 'reply', handoff: false }} plain="Link cancelled when Mike Turner’s rules changed" ledgerSeq={62} />]}
        >
          {/* The Desk's own message (author desk) carries only the card. */}
          <ClaudeMessage blocks={[CARD]} language="en" ownerName={rivera.business.ownerName} />
        </TranscriptRow>
      </Transcript>
    </PublicShell>
  );
}

const meta = {
  title: 'Boards/Chat, link cancelled',
  render: () => <ChatLinkCancelled />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Chat-Link-Cancelled',
    canvasNote: [
      'Signed on 2026-10-30.',
      'A payment link a confirmed rule change cancelled, in the chat: the Desk’s own message carries only the link_cancelled reply card, with the payment link’s icon and “Payment link cancelled”, then the kernel’s block: the amount, what the link was for and the kernel’s line.',
      'The board also draws the test-payment note; a cancelled link moves no money, so the card has none. The board draws the card under Claude’s words in the same message; Claude’s words are Claude’s own message here, before the Desk’s. The receipts’ lines are the board’s, and the kernel writes them.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const chat = canvas.getByRole('main');
    expectConversationType(chat);
    await expect(await expectReceiptsUnderMessages(chat)).toBe(2);

    // Claude's answer, then the Desk's message, which holds the card and nothing else.
    const rows = [...chat.querySelectorAll<HTMLElement>('.cd-transcript-row')].filter((row) => row.querySelector('.cd-claude-message'));
    await expect(rows).toHaveLength(2);
    const [answer, desk] = rows as [HTMLElement, HTMLElement];
    await expect(answer.querySelector('.cd-reply-card')).toBeNull();
    await expect(within(answer).getByText(ANSWER)).toBeVisible();
    await expect(desk.querySelector('.cd-claude-message__prose')).toBeNull();

    // The card: named by its label, then the kernel's block as written (the amount, what the link
    // was for and the kernel's line), with the payment link's icon and no note, link or button.
    const card = within(desk).getByRole('article', { name: 'Payment link cancelled' });
    expectComputed(card, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    await expect(card.textContent).toBe(['Payment link cancelled', CARD.title, ...CARD.lines].join(''));
    await expect(one(desk, '.cd-reply-card__headline').textContent).toBe('$20.00');
    await expect(desk.querySelectorAll('.cd-reply-card__label svg')).toHaveLength(1);
    await expect(card).not.toHaveTextContent('Test payment');
    await expect(within(card).queryByRole('link')).toBeNull();
    await expect(within(card).queryByRole('button')).toBeNull();
    // The left About column leaves the reading column centred in the chat pane to its right.
    const about = canvas.getByRole('complementary', { name: 'About Turner Plumbing' });
    const column = about.getBoundingClientRect();
    const pane = chat.getBoundingClientRect();
    const reading = one(chat, '.cd-public-shell__chat-head').getBoundingClientRect();
    await expect(column.left).toBe(0);
    await expect(column.width).toBeCloseTo(1512 * 0.22, 1);
    await expect(pane.left).toBe(column.right);
    await expect(reading.width).toBe(680);
    await expect(reading.left + reading.width / 2).toBeCloseTo(pane.left + pane.width / 2, 1);
    await expect(one(desk, '.cd-reply-card').getBoundingClientRect().left).toBe(reading.left);
    await expectFooter(canvasElement);
  },
};
