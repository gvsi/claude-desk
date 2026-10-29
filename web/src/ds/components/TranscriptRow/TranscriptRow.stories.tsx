import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import type { EvMessage, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { AgentMessage } from '../AgentMessage/AgentMessage.tsx';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { MarginNote } from '../MarginNote/MarginNote.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { Transcript } from '../Transcript/Transcript.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { TranscriptHeader, TranscriptRow } from './TranscriptRow.tsx';

const dana = rivera.conversations.danaLive;
const ownerName = rivera.business.ownerName;

/** A fixture part the stories need, or a thrown error naming what the fixture lost. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the Rivera fixture has no ${what}`);
  return value;
}

/** Dana's stored turns, in order: what she typed, the quote's receipt and Claude's checked reply. */
const visitorTexts = dana.turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []));
const question = required(visitorTexts[0], 'first message');
const followUp = required(visitorTexts[1], 'second message');
const events: SseEvent[] = dana.turns.flatMap((turn) => (turn.kind === 'event' ? [turn.event] : []));
const quoteReceipt = required(
  events.find((event): event is StatusEvent => event.type === 'receipt'),
  'quote receipt',
);
const quoteReply = required(
  events.find((event): event is EvMessage => event.type === 'message'),
  'quote reply',
);

const receipts = [receiptFromEvent(quoteReceipt), receiptFromEvent(quoteReply)];

/** Alex Kim's assistant's first request, and the receipt for the quote it asked for. */
const alex = rivera.conversations.alexAgent;
const agentRequest = required(
  alex.turns.flatMap((turn) => (turn.kind === 'agent' ? [turn.text] : []))[0],
  'agent request',
);
const agentReceipt = receiptFromEvent(
  required(
    alex.turns.flatMap((turn) => (turn.kind === 'event' && turn.event.type === 'receipt' ? [turn.event] : []))[0],
    'agent quote receipt',
  ),
);
const LEAD_SAVED = 'Name and phone saved to Customers as a new lead.';

/** The opening of Dana's conversation as the owner reads it: her question, then the reply and its receipts. */
function DanaOpening({ onOpenTrace }: { onOpenTrace: (ledgerSeq: number) => void }) {
  return (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptHeader
        left="Today at 12:04, web chat from the Rivera Plumbing page"
        right="Notes from the checks. Select one for the full trace."
      />
      <TranscriptRow>
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow
        margin={receipts.map((receipt) => (
          <MarginReceipt key={receipt.ledgerSeq} {...receipt} onOpenTrace={onOpenTrace} />
        ))}
      >
        <ClaudeMessage blocks={quoteReply.blocks} language={quoteReply.language} ownerName={ownerName} />
      </TranscriptRow>
    </Transcript>
  );
}

/** The parts of the one row in the story that holds `selector`. */
function rowParts(root: HTMLElement, selector: string) {
  const inner = root.querySelector<HTMLElement>(selector);
  const row = inner?.closest<HTMLElement>('.cd-transcript-row');
  const main = row?.querySelector<HTMLElement>(':scope > .cd-transcript-row__main');
  const margin = row?.querySelector<HTMLElement>(':scope > .cd-transcript-row__margin');
  if (!inner || !row || !main || !margin) throw new Error(`no row with a margin holds ${selector}`);
  return { inner, row, main, margin };
}

const meta = {
  title: 'Conversation/TranscriptRow',
  component: TranscriptRow,
  args: { children: null },
  // The owner app's content column.
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'var(--size-content)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof TranscriptRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * receipts_attach_under_message: the row is the reading column, and what is attached sits
 * `space-8` under the message, on the message's side: from its left edge under Claude's and the
 * owner's words, and ending at its right edge, no wider than a bubble (85%), under a visitor's or
 * an agent's bubble on the right. `selector` is the message element it lines up with. Nothing
 * overflows.
 */
async function expectAttachedUnder(root: HTMLElement, selector: string, side: 'start' | 'end', readingWidth: number) {
  const { inner, row, main, margin } = rowParts(root, selector);
  const rowBox = row.getBoundingClientRect();
  const mainBox = main.getBoundingClientRect();
  const marginBox = margin.getBoundingClientRect();
  const message = inner.getBoundingClientRect();
  await expect(rowBox.width).toBe(readingWidth);
  await expect(mainBox.width).toBe(rowBox.width);
  await expect(marginBox.top - mainBox.bottom).toBe(8);
  if (side === 'start') {
    await expect(marginBox.left).toBe(message.left);
  } else {
    await expect(marginBox.right).toBe(message.right);
    await expect(marginBox.width).toBeLessThanOrEqual(rowBox.width * 0.85 + 0.5);
  }
  for (const el of [row, main, margin]) await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}

export const ReplyWithReceipts: Story = {
  render: () => <DanaOpening onOpenTrace={fn()} />,
  parameters: {
    canvasNote:
      "The board's quote is in Claude's prose and its notes sit in a margin column; here the quote is a card, and the kernel's lines for the quote and its reply check are attached under the reply, at every width.",
  },
  play: async ({ canvas, canvasElement }) => {
    const log = canvas.getByRole('log', { name: `Conversation with ${dana.name}` });
    const shown = [...canvasElement.querySelectorAll<HTMLElement>('.cd-margin-receipt')];
    await expect(shown).toHaveLength(receipts.length);
    for (const [index, receipt] of shown.entries()) {
      await expect(receipt).toHaveAccessibleName(`${receipts[index]?.plain} Open the full trace.`);
    }

    // receipts_are_announced: every receipt is inside the transcript's live log.
    for (const receipt of shown) await expect(receipt.parentElement?.closest('[aria-live]')).toBe(log);

    // In the owner's 960 px content column, the row is still the 640 px reading column, and the
    // receipts are under the reply, one above the other.
    await expect(log.getBoundingClientRect().width).toBe(960);
    await expectAttachedUnder(canvasElement, '.cd-claude-message__prose', 'start', 640);
    const [first, second] = shown as [HTMLElement, HTMLElement];
    await expect(second.getBoundingClientRect().top).toBeGreaterThan(first.getBoundingClientRect().bottom);
    await expect(second.getBoundingClientRect().left).toBe(first.getBoundingClientRect().left);

    // The header's two captions stack in the same column, the receipts' caption second.
    const header = canvasElement.querySelector<HTMLElement>('.cd-transcript-header');
    if (!header) throw new Error('no transcript header');
    const [left, right] = [...header.children] as HTMLElement[];
    const reply = rowParts(canvasElement, '.cd-claude-message__prose').row.getBoundingClientRect();
    await expect(left?.getBoundingClientRect().left).toBe(reply.left);
    await expect(right?.getBoundingClientRect().left).toBe(reply.left);
    await expect(right?.getBoundingClientRect().top).toBeGreaterThanOrEqual(left?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY);
    await expect(right).toHaveTextContent('Notes from the checks. Select one for the full trace.');
  },
};

export const BubbleWithNote: Story = {
  render: () => (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow margin={<MarginNote text={LEAD_SAVED} onOpen={fn()} />}>
        <VisitorMessage text={followUp} />
      </TranscriptRow>
      <TranscriptRow margin={<MarginReceipt {...agentReceipt} onOpenTrace={fn()} />}>
        <AgentMessage agentName={alex.name} signed title="Quote the service call deposit" meta="Request 1" text={agentRequest} />
      </TranscriptRow>
    </Transcript>
  ),
  parameters: {
    canvasNote:
      "Dana's second message and Alex Kim's assistant's request are the fixture's; the board's message under the note also gave her name and phone, and its notes sit in a margin column.",
  },
  play: async ({ canvasElement }) => {
    // Under a bubble on the right, what is attached sits on the right too, ending where it ends.
    await expectAttachedUnder(canvasElement, '.cd-visitor-message__bubble', 'end', 640);
    await expectAttachedUnder(canvasElement, '.cd-agent-message__bubble', 'end', 640);
    for (const line of canvasElement.querySelectorAll<HTMLElement>('.cd-margin-line')) {
      const bubble = line.closest('.cd-transcript-row')?.querySelector<HTMLElement>('.cd-visitor-message__bubble, .cd-agent-message__bubble');
      await expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(bubble?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY);
    }
  },
};

export const Stacked: Story = {
  render: () => <DanaOpening onOpenTrace={fn()} />,
  decorators: [
    (Story) => (
      <div style={{ width: 600, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvasNote: 'The board is wide; in a column narrower than the reading width, as on a phone or the public page, the same rows take the full width, with the receipts attached under each message.',
  },
  play: async ({ canvas, canvasElement }) => {
    // stacks_when_narrow: the same layout in a narrower column, where the row takes its full width.
    await expectAttachedUnder(canvasElement, '.cd-claude-message__prose', 'start', 600);
    const log = canvas.getByRole('log');
    await expect(log.scrollWidth).toBeLessThanOrEqual(log.clientWidth);
  },
};

export const NothingAttached: Story = {
  render: () => (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow margin={[]}>
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow margin={[null, false]}>
        <VisitorMessage text={followUp} />
      </TranscriptRow>
    </Transcript>
  ),
  parameters: {
    canvasNote: "The boards show receipts under most messages; these are Dana's two messages before any receipt arrives, with an empty list attached.",
  },
  play: async ({ canvasElement }) => {
    // An empty list of receipts attaches nothing: no empty block, and no gap under the message.
    await expect(canvasElement.querySelectorAll('.cd-transcript-row')).toHaveLength(2);
    await expect(canvasElement.querySelector('.cd-transcript-row__margin')).toBeNull();
    for (const row of canvasElement.querySelectorAll<HTMLElement>('.cd-transcript-row')) {
      const main = row.querySelector<HTMLElement>(':scope > .cd-transcript-row__main');
      await expect(main?.getBoundingClientRect().height).toBe(row.getBoundingClientRect().height);
    }
  },
};
