import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';

import type { DemoInboxEntry } from '../../api/contracts.ts';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import type { DemoInboxItem } from '../components/DemoInboxPanel/DemoInboxPanel.tsx';
import { DemoInboxSheet } from '../components/DemoInboxSheet/DemoInboxSheet.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { brandOf } from './parts.tsx';

/** Dana's code, sent to her number on record, as the board writes it. */
const ENTRY: DemoInboxEntry = {
  entry_id: 'inbox-code-dana',
  to: '•••• 0143',
  kind: 'verification_code',
  body: 'Your Turner Plumbing code is 482913. It works for 10 minutes.',
  created_at: '2026-10-30T10:46:00Z',
  decision_id: null,
};
const CODE: DemoInboxItem = { notice: { entry_id: ENTRY.entry_id, to: ENTRY.to, preview: 'New verification code' }, entry: ENTRY };

/** The event the play sends when the code arrives. */
const CODE_ARRIVES = 'cd-board-inbox-code';

/**
 * The public page on a phone just after Claude asked Dana to confirm it's her: the code arrives,
 * and the Demo inbox sheet opens itself over the page. Its button sits after the page, where the
 * web app places it, under the sheet.
 */
function InboxSheetPublic() {
  const [items, setItems] = useState<DemoInboxItem[]>([]);
  useEffect(() => {
    const arrive = () => setItems([CODE]);
    window.addEventListener(CODE_ARRIVES, arrive);
    return () => window.removeEventListener(CODE_ARRIVES, arrive);
  }, []);
  return (
    <>
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
            <VisitorMessage text="Hi, it’s Dana Whitfield. Can you send my last invoice?" />
          </TranscriptRow>
          <TranscriptRow
            margin={[
              <MarginReceipt key="reply" source={{ kind: 'reply', handoff: false }} plain="Reply checked against Mike Turner’s rules" ledgerSeq={41} />,
              <MarginReceipt key="verify" source={{ kind: 'decision', state: 'executed' }} plain="Verification started" ledgerSeq={42} />,
            ]}
          >
            <ClaudeMessage
              blocks={[{ kind: 'prose', text: 'I can show you that after you confirm it’s you.' }, rivera.blocks.verify_prompt.en]}
              language="en"
              ownerName={rivera.business.ownerName}
            />
          </TranscriptRow>
        </Transcript>
      </PublicShell>
      <div className="board-inbox-button">
        <DemoInboxSheet viewer="visitor" items={items} language="en" onRetry={fn()} />
      </div>
    </>
  );
}

const meta = {
  title: 'Boards/Demo inbox sheet, public',
  render: () => <InboxSheetPublic />,
  // Drawn at a phone's window, so the play measures it there.
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Inbox-Sheet-Public',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'The public page below 1280 px: the code arrives and DemoInboxSheet opens itself from the bottom over the dimmed, inert page, with DemoInboxPanel in it and Close at the right of its title.',
      'The board doesn’t draw the sheet’s “Demo inbox” button; here it sits after the page, under the sheet, where the web app (plan 04) places it.',
      'The entry is the panel’s, signed on N-Public-Verify-Run1, 2 px shorter than this board draws it, so the sheet starts 2 px lower.',
      'At the raised type scale (2026-11-02) every line is a pixel taller and the subtitle wraps to a second line at 390 px, so the sheet is 242 px tall and starts at 602 px, 22 px higher than the board draws it.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 844]);
    window.dispatchEvent(new Event(CODE_ARRIVES));
    const sheet = await canvas.findByRole('dialog', { name: 'Demo inbox' });
    // From the bottom, 242 px tall with the code, padded 16 px, Close in reach. The board draws it
    // 220 px tall at the earlier type scale (and the panel's entry 2 px shorter than that); at the
    // current one each line is a pixel taller and the subtitle takes a second line on a phone.
    const box = sheet.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.width), Math.round(box.bottom)]).toEqual([0, 390, 844]);
    await expect(Math.abs(Math.round(box.top) - 602)).toBeLessThanOrEqual(2);
    expectComputed(sheet, { backgroundColor: 'rgb(42, 41, 39)', borderTopColor: 'rgba(250, 249, 245, 0.14)', borderTopLeftRadius: '12px' });
    // Opened by itself, focus goes to the sheet's heading, not to Close under the visitor's next key.
    await waitFor(() => expect(within(sheet).getByRole('heading', { level: 2, name: 'Demo inbox' })).toHaveFocus());
    const close = within(sheet).getByRole('button', { name: 'Close' });
    await expect(Math.round(box.right - close.getBoundingClientRect().right)).toBe(16);
    await expect(within(sheet).getByText(ENTRY.body)).toBeVisible();
    await expect(within(sheet).getByText('To •••• 0143')).toBeVisible();
    // The visitor's code names no decision, so nothing builds a request link.
    await expect(ENTRY.decision_id).toBeNull();
    await expect(within(sheet).queryByRole('link')).toBeNull();
  },
};
