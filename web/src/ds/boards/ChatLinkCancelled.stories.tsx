import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { LinkCancelledCard } from '../components/ReplyCard/LinkCancelledCard.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { brandOf } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectReceiptsUnderMessages, one } from './spec.ts';

/** Claude's answer to the visitor, as the board writes it: Claude's own message, before the Desk's. */
const ANSWER = 'The payment link I sent earlier was cancelled. Maria changed her rules, so a new link needs her answer.';

/** The kernel's line for the cancelled link, which the Desk's own message carries in its card. */
const LINE = "This payment link was cancelled because Maria Rivera's rules changed. Ask again if you still want to pay.";

function ChatLinkCancelled() {
  return (
    <PublicShell
      brand={brandOf(rivera.publicDesk.en)}
      ownerName={rivera.business.ownerName}
      language="en"
      onAskForOwner={fn()}
      about={rivera.publicDesk.en.charter.slice(0, 2)}
      composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />}
    >
      <Transcript label="Conversation with Rivera Plumbing">
        <TranscriptRow>
          <VisitorMessage text="I clicked the payment link but it says it’s gone?" />
        </TranscriptRow>
        <TranscriptRow margin={[<MarginReceipt key="reply" source={{ kind: 'reply', handoff: false }} plain="Reply checked against Maria Rivera’s rules" ledgerSeq={61} />]}>
          <ClaudeMessage blocks={[{ kind: 'prose', text: ANSWER }]} language="en" ownerName={rivera.business.ownerName} />
        </TranscriptRow>
        <TranscriptRow
          margin={[<MarginReceipt key="link" source={{ kind: 'reply', handoff: false }} plain="Link cancelled when Maria Rivera’s rules changed" ledgerSeq={62} />]}
        >
          {/* The Desk's own message (author desk) carries only the card, as ClaudeMessage lays one
              out. The card waits for the kernel's link_cancelled template to come as a block. */}
          <div className="cd-claude-message" lang="en">
            <LinkCancelledCard line={LINE} language="en" />
          </div>
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
      'Built against the board in review; sign-off pending.',
      'A payment link a confirmed rule change cancelled, in the chat: the Desk’s own message carries only LinkCancelledCard, with the payment link’s icon, “Payment link cancelled” and the kernel’s line. A cancelled link moves no money, so the card has no test-payment note.',
      'The board draws an earlier card, with an amount, what the link was for, a reason and the test-payment note, under Claude’s words in the same message. Claude’s words are Claude’s own message here, before the Desk’s; the receipts’ lines are the board’s, and the kernel writes them.',
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

    // The card: named by its label, the kernel's line as written, no note, link or button.
    const card = within(desk).getByRole('article', { name: 'Payment link cancelled' });
    expectComputed(card, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    await expect(card.textContent).toBe(`Payment link cancelled${LINE}`);
    await expect(within(card).queryByRole('link')).toBeNull();
    await expect(within(card).queryByRole('button')).toBeNull();
    await expect(Math.round(one(desk, '.cd-reply-card').getBoundingClientRect().left)).toBe(266);
    await expectFooter(canvasElement);
  },
};
