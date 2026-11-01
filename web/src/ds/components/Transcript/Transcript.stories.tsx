import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import type { TranscriptTurn } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { Whisper } from '../Whisper/Whisper.tsx';
import { WritingIndicator } from '../WritingIndicator/WritingIndicator.tsx';
import { Transcript } from './Transcript.tsx';

const dana = rivera.conversations.danaLive;
const firstName = rivera.people.dana.name.split(' ')[0] ?? '';

/** One stored turn as the owner reads it. Status receipts are left out here; they attach under their message in a `TranscriptRow`. */
function Turn({ turn }: { turn: TranscriptTurn }) {
  switch (turn.kind) {
    case 'visitor':
      return <VisitorMessage text={turn.text} />;
    case 'whisper':
      // The time is the owner screen's display string; the design system formats none.
      return <Whisper caption="Your whisper, 12:08. Only Claude sees this." text={turn.text} />;
    case 'event':
      return turn.event.type === 'message' ? (
        <ClaudeMessage blocks={turn.event.blocks} language={turn.event.language} ownerName={rivera.business.ownerName} />
      ) : null;
    default:
      return null;
  }
}

const meta = {
  title: 'Conversation/Transcript',
  component: Transcript,
  args: {
    label: `Conversation with ${dana.name}`,
    children: (
      <>
        {dana.turns.map((turn, index) => (
          <Turn key={index} turn={turn} />
        ))}
        {/* Dana types her next message: the typing bubble on her side, where it will appear. */}
        <TranscriptRow>
          <WritingIndicator language="en" variant="bubble" who={firstName} />
        </TranscriptRow>
      </>
    ),
  },
  // The conversation's reading column, as on the board.
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'var(--size-reading)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof Transcript>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Every message the story renders, by its component's root class. */
const MESSAGE_ROOTS = '.cd-visitor-message, .cd-claude-message, .cd-whisper, .cd-writing-indicator';

export const DanaLive: Story = {
  parameters: {
    canvasNote:
      "The board's header, margin receipts and composer are left out, and Claude's prose holds no times or prices: this is the log and its messages from the Turner fixture.",
  },
  play: async ({ canvas, canvasElement }) => {
    // transcript_is_a_live_log: a polite live log, named, holding every message.
    const log = canvas.getByRole('log', { name: `Conversation with ${dana.name}` });
    await expect(log.tagName).toBe('SECTION');
    await expect(log).toHaveAttribute('aria-live', 'polite');
    const counts = {
      visitor: dana.turns.filter((turn) => turn.kind === 'visitor').length,
      claude: dana.turns.filter((turn) => turn.kind === 'event' && turn.event.type === 'message').length,
      whisper: dana.turns.filter((turn) => turn.kind === 'whisper').length,
    };
    const messages = [...canvasElement.querySelectorAll<HTMLElement>(MESSAGE_ROOTS)];
    await expect(messages).toHaveLength(counts.visitor + counts.claude + counts.whisper + 1);
    for (const message of messages) {
      // The log is the live region each message is announced through.
      await expect(message.parentElement?.closest('[aria-live]')).toBe(log);
    }
    await expect(canvasElement.querySelectorAll('.cd-visitor-message')).toHaveLength(counts.visitor);
    await expect(canvasElement.querySelectorAll('.cd-claude-message')).toHaveLength(counts.claude);
    // An inline-size container, so rows inside can lay out by the log's width.
    expectComputed(log, { containerType: 'inline-size' });
    await expect(canvas.getByRole('status')).toHaveTextContent('Dana is typing');
  },
};
