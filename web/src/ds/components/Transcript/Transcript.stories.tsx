import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn } from 'storybook/test';

import type { EvMessage, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import type { TranscriptTurn } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { AgentMessage } from '../AgentMessage/AgentMessage.tsx';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { PersonMessage } from '../PersonMessage/PersonMessage.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { Whisper } from '../Whisper/Whisper.tsx';
import { WritingIndicator } from '../WritingIndicator/WritingIndicator.tsx';
import { Transcript } from './Transcript.tsx';

const dana = rivera.conversations.danaLive;
const alex = rivera.conversations.alexAgent;
const firstName = rivera.people.dana.name.split(' ')[0] ?? '';
const ownerName = rivera.business.ownerName;

/** Mike's own message once he has taken the chat over: author `owner`, one `owner_said` block. */
const said = rivera.events.takeOver.find((event: SseEvent): event is EvMessage => event.type === 'message') as EvMessage;

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
    // The log as the visitor's own chat has it: their words on the right, Claude's on the left.
    await expect(log).not.toHaveClass('cd-transcript--owner');
    const box = log.getBoundingClientRect();
    for (const bubble of log.querySelectorAll('.cd-visitor-message__bubble, .cd-writing-indicator__bubble')) {
      await expect(Math.abs(bubble.getBoundingClientRect().right - box.right), "a visitor's bubble ends at the log's right edge").toBeLessThanOrEqual(0.5);
    }
    for (const reply of log.querySelectorAll('.cd-claude-message')) {
      await expect(Math.abs(reply.getBoundingClientRect().left - box.left), "Claude's reply starts at the log's left edge").toBeLessThanOrEqual(0.5);
      await expect(Math.abs(reply.getBoundingClientRect().width - box.width), "Claude's reply takes the log's width").toBeLessThanOrEqual(0.5);
    }
  },
};

/**
 * `turns` as rows, each message with what is attached under it: a status receipt waits for the
 * message it came before, and attaches under it with that message's own receipt.
 */
function rowsOf(turns: readonly TranscriptTurn[], agentName: string): ReactNode[] {
  const rows: ReactNode[] = [];
  let pending: StatusEvent[] = [];
  let requests = 0;
  turns.forEach((turn, index) => {
    switch (turn.kind) {
      case 'visitor':
        rows.push(
          <TranscriptRow key={index}>
            <VisitorMessage text={turn.text} />
          </TranscriptRow>,
        );
        return;
      case 'agent':
        requests += 1;
        rows.push(
          <TranscriptRow key={index}>
            <AgentMessage agentName={agentName} signed={turn.signed} title="Signed request" meta={`Request ${requests}`} text={turn.text} />
          </TranscriptRow>,
        );
        return;
      case 'whisper':
        rows.push(
          <TranscriptRow key={index}>
            <Whisper caption="Your whisper, 12:08. Only Claude sees this." text={turn.text} />
          </TranscriptRow>,
        );
        return;
      case 'event': {
        const { event } = turn;
        if (event.type === 'message') {
          const margin = [...pending, event].map((attached) => {
            const view = receiptFromEvent(attached);
            return <MarginReceipt key={view.ledgerSeq} {...view} onOpenTrace={fn()} />;
          });
          rows.push(
            <TranscriptRow key={index} margin={margin}>
              <ClaudeMessage blocks={event.blocks} language={event.language} ownerName={ownerName} />
            </TranscriptRow>,
          );
          pending = [];
        } else if (event.type === 'receipt' || event.type === 'held' || event.type === 'resolved') {
          pending.push(event);
        }
        return;
      }
      default:
        return;
    }
  });
  return rows;
}

/** Dana's chat in Mike's own conversation view: her messages, his whisper, Claude's replies, his own message and her typing. */
function DanaForTheOwner() {
  const view = receiptFromEvent(said);
  return (
    <Transcript variant="owner" label={`Conversation with ${dana.name}`}>
      {rowsOf(dana.turns, dana.name)}
      <TranscriptRow margin={<MarginReceipt {...view} onOpenTrace={fn()} />}>
        <PersonMessage name="You" initials="MT" blocks={said.blocks} language={said.language} />
      </TranscriptRow>
      <TranscriptRow>
        <WritingIndicator language="en" variant="bubble" who={firstName} />
      </TranscriptRow>
    </Transcript>
  );
}

/** Alex Kim's assistant's chat in Mike's own conversation view: its signed requests, and Claude's replies. */
function AgentForTheOwner() {
  return (
    <Transcript variant="owner" label={`Conversation with ${alex.name}`}>
      {rowsOf(alex.turns, alex.name)}
    </Transcript>
  );
}

/**
 * The owner's variant (board REV-FLIP), the sides flipped from the visitor's own chat: the other
 * side's bubbles (a visitor's, an agent's, a visitor typing) start at the log's left edge, and every
 * row from the Desk's side (Claude's reply, a whisper, the owner's own message) sits in one column
 * min(520 px, 88%) of the log wide, at its right edge, with its receipts. Inside the column each
 * message, its first part and each receipt start at its left edge, and a reply's cards fill it.
 */
async function expectOwnerSides(canvasElement: HTMLElement, rowsOnOurSide: number) {
  const log = canvasElement.querySelector<HTMLElement>('[role="log"]');
  if (!log) throw new Error('the story draws a log');
  await expect(log).toHaveClass('cd-transcript--owner');
  const box = log.getBoundingClientRect();
  const column = Math.min(520, box.width * 0.88);
  const theirs = log.querySelectorAll('.cd-visitor-message__bubble, .cd-agent-message__who, .cd-agent-message__bubble, .cd-writing-indicator__bubble');
  await expect(theirs.length).toBeGreaterThan(0);
  for (const part of theirs) {
    await expect(Math.abs(part.getBoundingClientRect().left - box.left), `${part.className} starts at the log's left edge`).toBeLessThanOrEqual(0.5);
  }
  // The same bubble as the visitor's own chat draws, in this theme's fill-bubble.
  const probe = document.createElement('div');
  probe.style.background = 'var(--fill-bubble)';
  log.append(probe);
  const fill = getComputedStyle(probe).backgroundColor;
  probe.remove();
  for (const bubble of log.querySelectorAll<HTMLElement>('.cd-visitor-message__bubble')) {
    expectComputed(bubble, { backgroundColor: fill });
    await expect(bubble.getBoundingClientRect().width).toBeLessThanOrEqual(box.width * 0.85 + 0.5);
  }
  const ours = [...log.querySelectorAll<HTMLElement>('.cd-transcript-row')].filter(
    (row) => row.querySelector(':scope > .cd-transcript-row__main > :is(.cd-claude-message, .cd-whisper, .cd-person-message)') !== null,
  );
  await expect(ours).toHaveLength(rowsOnOurSide);
  for (const row of ours) {
    const parts = row.querySelectorAll<HTMLElement>(':scope > :is(.cd-transcript-row__main, .cd-transcript-row__margin)');
    for (const part of parts) {
      const rect = part.getBoundingClientRect();
      await expect(Math.abs(rect.width - column), `${part.className} is min(520 px, 88%) of the log`).toBeLessThanOrEqual(0.5);
      await expect(Math.abs(rect.right - box.right), `${part.className} ends at the log's right edge`).toBeLessThanOrEqual(0.5);
      for (const child of part.children) {
        await expect(Math.abs(child.getBoundingClientRect().left - rect.left), `${child.className} starts at the column's left edge`).toBeLessThanOrEqual(0.5);
      }
    }
    const message = row.querySelector(':scope > .cd-transcript-row__main > *');
    const first = message?.firstElementChild;
    if (!first) throw new Error('the message has parts');
    await expect(Math.abs(first.getBoundingClientRect().left - (box.right - column)), `${first.className} starts at the column's left edge`).toBeLessThanOrEqual(0.5);
    for (const card of row.querySelectorAll('.cd-reply-card')) {
      await expect(Math.abs(card.getBoundingClientRect().width - column), 'a reply card fills the column').toBeLessThanOrEqual(0.5);
    }
  }
}

/** Claude's replies, the whisper and Mike's own message. */
const DANA_ROWS_ON_OUR_SIDE = dana.turns.filter((turn) => turn.kind === 'whisper' || (turn.kind === 'event' && turn.event.type === 'message')).length + 1;

export const Owner: Story = {
  render: () => <DanaForTheOwner />,
  parameters: {
    canvas: 'none',
    canvasNote:
      "Board REV-FLIP (N-Live-REV-FLIP-1512, signed; nearest reference board N-Conv-Run1) draws this log in the owner's own conversation view; here it is on its own, as the Turner fixture's chat with Dana, without the board's bar, held card and controls, which are the owner app's.",
  },
  play: async ({ canvasElement }) => {
    await expectOwnerSides(canvasElement, DANA_ROWS_ON_OUR_SIDE);
  },
};

/** The same sides in the light theme: the variant moves messages, never their colors. */
export const OwnerLight: Story = { ...Owner, globals: { theme: 'light' } };

export const OwnerOnAPhone: Story = {
  render: () => <DanaForTheOwner />,
  decorators: [
    (Story) => (
      <div style={{ width: 358 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote:
      "Board REV-FLIP's phone (N-Live-REV-FLIP-390, signed; nearest reference board N-Conv-Run1): in a 390 px phone's 358 px log the column is 88% of it, about 315 px.",
  },
  play: async ({ canvasElement }) => {
    await expectOwnerSides(canvasElement, DANA_ROWS_ON_OUR_SIDE);
  },
};

export const OwnerAgentChat: Story = {
  render: () => <AgentForTheOwner />,
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote:
      "The board draws an agent's chat as the visitor's own chat has it; board REV-FLIP flips every open conversation in the owner app but draws no agent's chat, so here a visiting agent's requests take the visitor's side, the left, as the visitor's messages do.",
  },
  play: async ({ canvasElement }) => {
    await expectOwnerSides(canvasElement, alex.turns.filter((turn) => turn.kind === 'event' && turn.event.type === 'message').length);
  },
};
