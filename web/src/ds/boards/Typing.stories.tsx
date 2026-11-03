import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import type { TranscriptTurn } from '../fixtures/index.ts';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { WritingIndicator } from '../components/WritingIndicator/WritingIndicator.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { Panel, Sheet, TurnRows } from './parts.tsx';
import { SPEC, expectConversationType, expectReceiptsUnderMessages, some } from './spec.ts';

const DANA = rivera.people.dana.name;
/** Dana's opening, as far as her second message: her question, the checked quote, her reply. */
const opening: TranscriptTurn[] = rivera.conversations.danaLive.turns.slice(0, 4);

/** Dana's chat on Mike's screen while Dana types her next message. */
function DanaTyping() {
  return (
    <Transcript label={`Conversation with ${DANA}`}>
      <TurnRows turns={opening} />
      <TranscriptRow>
        <WritingIndicator language="en" variant="bubble" who="Dana" />
      </TranscriptRow>
    </Transcript>
  );
}

function TypingBoard() {
  return (
    <Sheet title="Typing">
      <Panel label="Owner’s conversation, 1280: Dana is typing" width={720}>
        <DanaTyping />
      </Panel>
      <Panel label="Phone, 390" width={390} phone>
        <DanaTyping />
      </Panel>
      <Panel label="Public page, unchanged: Claude writing stays a line on Claude’s side" width={520}>
        <Transcript label="Conversation with Turner Plumbing">
          <TranscriptRow>
            <VisitorMessage text="Can someone come Tuesday afternoon?" />
          </TranscriptRow>
          <TranscriptRow>
            <WritingIndicator language="en" />
          </TranscriptRow>
        </Transcript>
      </Panel>
    </Sheet>
  );
}

const meta = {
  title: 'Boards/Typing',
  render: () => <TypingBoard />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Typing-Bubble-Run1',
    canvasNote: [
      'The board’s panels from WritingIndicator and the Turner fixture’s chat with Dana: a drain clearing quote where the board has a leak repair.',
      'The board’s title, description and “How it behaves” list are sign-off notes and stay in the canvas; its dashed outline marked the bubble before it was built.',
      'The reduced-motion panel isn’t repeated: Storybook shows the motion the system asks for, and the design system’s browser tests render every story under reduced motion, where the dots stay still.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas }) => {
    for (const label of ['Owner’s conversation, 1280: Dana is typing', 'Phone, 390']) {
      const panel = canvas.getByRole('region', { name: label });
      const log = within(panel).getByRole('log', { name: `Conversation with ${DANA}` });
      expectConversationType(log);
      await expectReceiptsUnderMessages(log);

      // Dana typing: "Dana is typing" said once; the drawn bubble on her side, in her bubble's
      // fill and radius, one message line tall, ending where her messages end.
      const status = within(log).getByRole('status');
      await expect(status).toHaveTextContent('Dana is typing');
      const bubble = status.querySelector<HTMLElement>('.cd-writing-indicator__bubble') as HTMLElement;
      await expect(bubble).toHaveAttribute('aria-hidden', 'true');
      expectComputed(bubble, { backgroundColor: SPEC.bubble.backgroundColor, borderTopLeftRadius: '12px', height: '38px' });
      for (const theirs of some(log, '.cd-visitor-message__bubble')) {
        await expect(Math.round(bubble.getBoundingClientRect().right)).toBe(Math.round(theirs.getBoundingClientRect().right));
      }
    }

    // On the phone the conversation fits its 390 px panel.
    const phone = canvas.getByRole('region', { name: 'Phone, 390' });
    await expect(phone.getBoundingClientRect().width).toBeLessThanOrEqual(390);

    // The public page keeps Claude's writing line on Claude's side, never a bubble.
    const visitorView = canvas.getByRole('region', { name: 'Public page, unchanged: Claude writing stays a line on Claude’s side' });
    const line = within(visitorView).getByRole('status');
    await expect(line).toHaveTextContent('Claude is writing');
    await expect(line.querySelector('.cd-writing-indicator__bubble')).toBeNull();
    const row = line.closest('.cd-transcript-row') as HTMLElement;
    await expect(Math.round(line.getBoundingClientRect().left)).toBe(Math.round(row.getBoundingClientRect().left));
  },
};
