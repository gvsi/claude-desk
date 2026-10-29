import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import type { SseEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { MarginReceipt } from './MarginReceipt.tsx';
import { receiptFromEvent } from './receiptTone.ts';

/** The one event of `type` in a stored SSE sequence. */
function only<T extends SseEvent['type']>(events: readonly SseEvent[], type: T): Extract<SseEvent, { type: T }> {
  const found = events.filter((event): event is Extract<SseEvent, { type: T }> => event.type === type);
  if (found.length !== 1) throw new Error(`expected one ${type} event, found ${found.length}`);
  return found[0] as Extract<SseEvent, { type: T }>;
}

/** The status event of a stored conversation with this decision id. */
function statusIn(turns: (typeof rivera.conversations)['danaLive']['turns'], decisionId: string) {
  for (const turn of turns) {
    if (turn.kind === 'event' && turn.event.type !== 'message' && 'decision_id' in turn.event && turn.event.decision_id === decisionId) {
      return turn.event;
    }
  }
  throw new Error(`no status event for ${decisionId}`);
}

const executed = receiptFromEvent(only(rivera.events.quoteTurn, 'receipt'));
const held = receiptFromEvent(only(rivera.events.heldTurn, 'held'));
const replyChecked = receiptFromEvent(only(rivera.events.quoteTurn, 'message'));
const replyHandedOff = receiptFromEvent(only(rivera.events.heldTurn, 'message'));
const booked = receiptFromEvent(statusIn(rivera.conversations.danaLive.turns, 'dec-dana-book'));
const refused = rivera.decisions.refused;
const expired = rivera.decisions.expired;

/** The receipt's dot: the only `.cd-status-dot` in the story. */
function dotIn(root: HTMLElement): HTMLElement {
  const dots = root.querySelectorAll<HTMLElement>('.cd-status-dot');
  if (dots.length !== 1) throw new Error(`expected one status dot, found ${dots.length}`);
  return dots[0] as HTMLElement;
}

const meta = {
  title: 'Conversation/MarginReceipt',
  component: MarginReceipt,
  args: { ...executed, onOpenTrace: fn() },
  // The conversation's margin column, as on the board.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-margin)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
    canvas: 'N-Conv-Live',
    canvasNote:
      "The board's receipts are owner notes written for the board; these show the kernel's visitor_plain lines from the Rivera fixture, as the conversation view passes them.",
  },
} satisfies Meta<typeof MarginReceipt>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Executed: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // An owner's receipt is a button that opens the full trace, named by its line.
    const receipt = canvas.getByRole('button', { name: `${executed.plain} Open the full trace.` });
    await expect(receipt).toHaveTextContent(executed.plain);
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--handled');
    // The line is a secondary caption.
    expectComputed(receipt, { fontFamily: /Hanken Grotesk/, fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });

    // receipt_opens_trace_by_keyboard: Tab reaches it, Enter opens the trace for its entry, once.
    await userEvent.tab();
    await expect(receipt).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onOpenTrace).toHaveBeenCalledTimes(1);
    await expect(args.onOpenTrace).toHaveBeenCalledWith(executed.ledgerSeq);
  },
};

export const Held: Story = {
  args: { ...held },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button', { name: `${held.plain} Open the full trace.` })).toBeVisible();
    // receipt_tone_follows_state: a hold's dot is the held gold.
    const dot = dotIn(canvasElement);
    await expect(dot).toHaveClass('cd-status-dot--held');
    expectComputed(dot, { backgroundColor: 'rgb(218, 190, 74)', width: '6px', height: '6px' });
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
  },
};

export const Refused: Story = {
  args: { source: { kind: 'decision', state: refused.state }, plain: refused.visitor_plain, ledgerSeq: refused.ledger_seq },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button', { name: `${refused.visitor_plain} Open the full trace.` })).toBeVisible();
    expectComputed(dotIn(canvasElement), { backgroundColor: 'rgb(220, 130, 144)' });
  },
};

export const Expired: Story = {
  args: { source: { kind: 'decision', state: expired.state }, plain: expired.visitor_plain, ledgerSeq: expired.ledger_seq },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button', { name: `${expired.visitor_plain} Open the full trace.` })).toBeVisible();
    // receipt_tone_follows_state: an expired request has the hollow info dot.
    const dot = dotIn(canvasElement);
    await expect(dot).toHaveClass('cd-status-dot--info');
    expectComputed(dot, {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopStyle: 'solid',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.64)',
    });
  },
};

export const BookedWithCheck: Story = {
  args: { ...booked, drawCheck: true },
  parameters: {
    canvasNote: "The board's booking note ends with the sage check that draws once; here it follows the kernel's line for the executed booking.",
  },
  play: async ({ canvas, canvasElement }) => {
    const receipt = canvas.getByRole('button', { name: `${booked.plain} Open the full trace.` });
    // The check is decorative, sage, and drawn once: the words already say it was done.
    const check = receipt.querySelector('svg');
    if (!check) throw new Error('no check on the booked receipt');
    await expect(check).toHaveAttribute('aria-hidden', 'true');
    expectComputed(check, { color: 'rgb(111, 168, 89)' });
    const stroke = check.querySelector('path');
    if (!stroke) throw new Error('no check stroke');
    expectComputed(stroke, { animationName: /^(?!none$).+/, animationIterationCount: '1', animationDuration: '0.2s' });
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--handled');
  },
};

export const ReplyChecked: Story = {
  args: { ...replyChecked },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button', { name: `${replyChecked.plain} Open the full trace.` })).toBeVisible();
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--handled');
  },
};

export const ReplyHandedOff: Story = {
  // A check is drawn only for a handled outcome, so asking for one on a handed-off reply adds nothing.
  args: { ...replyHandedOff, drawCheck: true },
  play: async ({ canvas, canvasElement }) => {
    const receipt = canvas.getByRole('button', { name: `${replyHandedOff.plain} Open the full trace.` });
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--held');
    await expect(receipt.querySelector('svg')).toBeNull();
  },
};

export const VisitorReadOnly: Story = {
  args: { ...held, onOpenTrace: undefined },
  parameters: {
    canvas: 'N-Public-Handoff',
    canvasNote:
      "The board draws no receipts; on visitor surfaces a receipt is the kernel's visitor_plain line as plain text, with no trace to open.",
  },
  play: async ({ canvas, canvasElement }) => {
    // visitor_receipt_is_text: no button, no trace hint, and exactly the signed line.
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByText(/full trace/)).toBeNull();
    const receipt = canvasElement.querySelector<HTMLElement>('.cd-margin-receipt');
    if (!receipt) throw new Error('no receipt');
    await expect(receipt.tagName).toBe('P');
    await expect(receipt.textContent).toBe(only(rivera.events.heldTurn, 'held').visitor_plain);
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--held');
  },
};
