import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import type { EvMessage, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
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
  if (value === undefined) throw new Error(`the Dana fixture has no ${what}`);
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
const LEAD_SAVED = 'Name and phone saved to Customers as a new lead.';

/** The opening of Dana's conversation as the owner reads it: her question, then the reply and its receipts. */
function DanaOpening({ onOpenTrace }: { onOpenTrace: (ledgerSeq: number) => void }) {
  return (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptHeader
        left="Today at 12:04, web chat from the Rivera Plumbing page"
        right="Notes from the checks. Select one for the full trace."
      />
      <TranscriptRow align="bubble">
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow
        align="reply"
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
  parameters: { layout: 'padded', canvas: 'N-Conv-Live' },
} satisfies Meta<typeof TranscriptRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReplyWithReceipts: Story = {
  render: () => <DanaOpening onOpenTrace={fn()} />,
  parameters: {
    canvasNote:
      "The board's quote is in Claude's prose and its notes are written for the board; here the quote is a card and the receipts are the kernel's lines for the quote and its reply check.",
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

    // margin_aligns_with_message: the first receipt starts within 4 px of the reply's first line.
    const { inner: prose, main, margin } = rowParts(canvasElement, '.cd-claude-message__prose');
    const first = shown[0] as HTMLElement;
    const offset = first.getBoundingClientRect().top - prose.getBoundingClientRect().top;
    await expect(Math.abs(offset)).toBeLessThanOrEqual(4);

    // Side by side: the reading column, the gap and the margin column.
    const mainBox = main.getBoundingClientRect();
    const marginBox = margin.getBoundingClientRect();
    await expect(mainBox.width).toBe(640);
    await expect(marginBox.width).toBe(220);
    await expect(marginBox.left - mainBox.right).toBeGreaterThanOrEqual(24);

    // The header's two captions sit over the same columns.
    const header = canvasElement.querySelector<HTMLElement>('.cd-transcript-header');
    if (!header) throw new Error('no transcript header');
    const [left, right] = [...header.children] as HTMLElement[];
    await expect(left?.getBoundingClientRect().left).toBe(mainBox.left);
    await expect(right?.getBoundingClientRect().left).toBe(marginBox.left);
    await expect(right).toHaveTextContent('Notes from the checks. Select one for the full trace.');
  },
};

export const BubbleWithNote: Story = {
  render: () => (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow align="bubble" margin={<MarginNote text={LEAD_SAVED} onOpen={fn()} />}>
        <VisitorMessage text={followUp} />
      </TranscriptRow>
    </Transcript>
  ),
  parameters: {
    canvasNote: "Dana's second message is the fixture's; the board's message under this note also gave her name and phone.",
  },
  play: async ({ canvasElement }) => {
    // The note's line sits level with the bubble's first line of text: 8 px of padding, then the
    // 21 px message line centred on the 17 px caption line.
    const { inner: bubble } = rowParts(canvasElement, '.cd-visitor-message__bubble');
    const note = canvasElement.querySelector<HTMLElement>('.cd-margin-note');
    if (!note) throw new Error('no margin note');
    const offset = note.getBoundingClientRect().top - bubble.getBoundingClientRect().top;
    await expect(Math.abs(offset - 10)).toBeLessThanOrEqual(1);
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
    canvasNote: 'The board is wide enough for the margin; in a column under 884 px, as on a phone or the public page, it stacks under the message.',
  },
  play: async ({ canvas, canvasElement }) => {
    // stacks_when_narrow: the margin goes under the message, full width, and nothing overflows.
    const { row, main, margin } = rowParts(canvasElement, '.cd-claude-message__prose');
    const rowBox = row.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const marginBox = margin.getBoundingClientRect();
    await expect(marginBox.top).toBeGreaterThanOrEqual(mainBox.bottom);
    await expect(marginBox.left).toBe(rowBox.left);
    await expect(marginBox.width).toBe(rowBox.width);
    await expect(mainBox.width).toBe(rowBox.width);
    const log = canvas.getByRole('log');
    for (const el of [log, row, main, margin]) await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
  },
};
