import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import type { Decision, SseEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectDrawsShortArmFirst } from '../../test/expectDrawsShortArmFirst.ts';
import { settled } from '../../test/settled.ts';
import { ApprovalCard } from '../ApprovalCard/ApprovalCard.tsx';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { MarginReceipt } from './MarginReceipt.tsx';
import { RulesReceipt } from './RulesReceipt.tsx';
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

/** The message of a stored conversation with this id. */
function messageIn(turns: (typeof rivera.conversations)['danaLive']['turns'], messageId: string) {
  for (const turn of turns) {
    if (turn.kind === 'event' && turn.event.type === 'message' && turn.event.message_id === messageId) return turn.event;
  }
  throw new Error(`no message ${messageId}`);
}

/** Dana's list-price quote ran on its own: its receipt reads `executed`, and its decision is `rivera.decisions.allowed`. */
const quoteRan = only(rivera.events.quoteTurn, 'receipt');
const executed = receiptFromEvent(quoteRan);
const held = receiptFromEvent(only(rivera.events.heldTurn, 'held'));
const replyChecked = receiptFromEvent(only(rivera.events.quoteTurn, 'message'));
const replyHandedOff = receiptFromEvent(only(rivera.events.heldTurn, 'message'));
const booked = receiptFromEvent(statusIn(rivera.conversations.danaLive.turns, 'dec-dana-book'));
/** Claude's reply that confirms Dana's booking, and its own check. */
const bookedReply = messageIn(rivera.conversations.danaLive.turns, 'msg-dana-booked');
const bookedReplyChecked = receiptFromEvent(bookedReply);
const refused = rivera.decisions.refused;
const expired = rivera.decisions.expired;

/** The receipt's dot: the only `.cd-status-dot` in the story. */
function dotIn(root: HTMLElement): HTMLElement {
  const dots = root.querySelectorAll<HTMLElement>('.cd-status-dot');
  if (dots.length !== 1) throw new Error(`expected one status dot, found ${dots.length}`);
  return dots[0] as HTMLElement;
}

/** `text-primary` and `text-secondary`, as the browser computes them. */
const TEXT_PRIMARY = 'rgba(250, 249, 245, 0.92)';
const TEXT_SECONDARY = 'rgba(250, 249, 245, 0.64)';

/** A decision's receipt as an owner screen passes it: the event's line, and the decision's reason. */
function ownerReceipt(decision: Decision) {
  return {
    source: { kind: 'decision', state: decision.state } as const,
    plain: decision.visitor_plain,
    ledgerSeq: decision.ledger_seq,
    reason: decision.reason_plain,
  };
}

/**
 * The four states an owner receipt gives a reason for, each with its decision's reason, the owner's
 * words and the dot it shows. The executed one is Dana's quote, which ran without a hold, as an
 * auto-allowed action's receipt does; the fixture's `decisions.executed` is the held discount after
 * it was allowed, whose later receipts keep the kernel's line.
 */
const OWNER_LINES = [
  { receipt: ownerReceipt(rivera.decisions.held), words: 'Held for you', tone: 'held' },
  { receipt: ownerReceipt(rivera.decisions.refused), words: 'Stopped', tone: 'refused' },
  { receipt: { ...executed, reason: rivera.decisions.allowed.reason_plain }, words: 'Automatic', tone: 'handled' },
  { receipt: ownerReceipt(rivera.decisions.allowed), words: 'Running', tone: 'handled' },
] as const;

/** What a receipt shows on screen: its text without the screen-reader-only trace hint. */
function visibleText(receipt: HTMLElement): string {
  const copy = receipt.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('.cd-sr-only')) hidden.remove();
  return copy.textContent ?? '';
}

/** The owner's words that lead a receipt's line. */
function leadIn(receipt: HTMLElement): HTMLElement {
  const lead = receipt.querySelector<HTMLElement>('.cd-margin-line__lead');
  if (!lead) throw new Error('no state words lead the receipt');
  return lead;
}

/**
 * The color an owner's receipt line rests at: secondary, brightening to primary only while the
 * pointer is over it. Read once the line's color transition has ended, so a hover that starts as
 * the story renders isn't caught halfway.
 */
async function restingColor(receipt: HTMLElement): Promise<string> {
  await settled(receipt);
  return receipt.matches(':hover') ? TEXT_PRIMARY : TEXT_SECONDARY;
}

/** The words lead in primary ink, in the line's caption size and weight; the rest stays secondary. */
async function expectLeadLook(receipt: HTMLElement): Promise<void> {
  const rest = await restingColor(receipt);
  const line = getComputedStyle(receipt);
  expectComputed(leadIn(receipt), {
    color: TEXT_PRIMARY,
    fontFamily: line.fontFamily,
    fontSize: '12px',
    lineHeight: '17px',
    fontWeight: line.fontWeight,
  });
  const text = receipt.querySelector('.cd-margin-line__text');
  if (!text) throw new Error('no line text');
  expectComputed(receipt, { color: rest });
  expectComputed(text, { color: rest });
}

const meta = {
  title: 'Conversation/MarginReceipt',
  component: MarginReceipt,
  args: { ...executed, onOpenTrace: fn() },
  // The conversation's reading column, where receipts sit under their message.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-reading)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
    canvas: 'N-Conv-Run1',
    canvasNote:
      "The board's receipts are owner notes written for the board; these show the kernel's visitor_plain lines from the Turner fixture, as the conversation view passes them.",
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
    expectComputed(receipt, { fontFamily: /Hanken Grotesk/, fontSize: '12px', lineHeight: '17px', color: await restingColor(receipt) });

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
    canvasNote:
      "The board's booking note ends with the sage check that draws once, short arm first; here it follows the kernel's line for the executed booking. Storybook shows the motion your system asks for: under reduced motion the check is drawn from the start.",
  },
  play: async ({ canvas, canvasElement }) => {
    const receipt = canvas.getByRole('button', { name: `${booked.plain} Open the full trace.` });
    // The check is decorative, sage, and drawn once: the words already say it was done.
    const check = receipt.querySelector('svg');
    if (!check) throw new Error('no check on the booked receipt');
    await expect(check).toHaveAttribute('aria-hidden', 'true');
    expectComputed(check, { color: 'rgb(111, 168, 89)' });
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--handled');
    const stroke = check.querySelector('path');
    if (!stroke) throw new Error('no check stroke');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Under reduced motion the check doesn't move: it is drawn from the start.
      expectComputed(stroke, { animationName: 'none', strokeDashoffset: '0px' });
      return;
    }
    expectComputed(stroke, { animationName: /^(?!none$).+/, animationIterationCount: '1', animationDuration: '0.2s' });
    await expectDrawsShortArmFirst(stroke);
  },
};

export const BookedLandsLive: Story = {
  render: ({ onOpenTrace }) => (
    <Transcript label={`Conversation with ${rivera.conversations.danaLive.name}`}>
      <TranscriptRow
        live
        margin={[
          <MarginReceipt key="reply" {...bookedReplyChecked} onOpenTrace={onOpenTrace} />,
          <MarginReceipt key="booked" {...booked} drawCheck onOpenTrace={onOpenTrace} />,
        ]}
      >
        <ClaudeMessage blocks={bookedReply.blocks} language={bookedReply.language} ownerName={rivera.business.ownerName} />
      </TranscriptRow>
    </Transcript>
  ),
  parameters: {
    canvasNote:
      "Boards are still frames. Here the reply that confirms Dana's booking arrives live: its receipts land one by one, motion-stagger apart, and the booking's sage check draws as its line lands. Storybook shows the motion your system asks for; the design system's browser tests render every story under reduced motion.",
  },
  play: async ({ canvasElement }) => {
    const lines = [...canvasElement.querySelectorAll<HTMLElement>('.cd-margin-receipt')];
    await expect(lines.map(visibleText)).toEqual([bookedReplyChecked.plain, booked.plain]);
    const bookedLine = lines[1] as HTMLElement;
    const stroke = bookedLine.querySelector<SVGPathElement>('.cd-margin-line__check path');
    if (!stroke) throw new Error('no check on the booked receipt');
    const dot = dotIn(bookedLine);

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Under reduced motion the line and its dot show at once, and the check is drawn from the start.
      for (const el of [bookedLine, dot, stroke]) expectComputed(el, { animationName: 'none' });
      expectComputed(stroke, { strokeDashoffset: '0px' });
      return;
    }
    // live_check_draws_as_its_line_lands: the booked line is the second to land, two motion-stagger
    // beats in; its dot grows and its check draws on that same beat, over motion-base, once.
    const token = getComputedStyle(document.documentElement).getPropertyValue('--motion-stagger').trim();
    await expect(token).toBe('150ms');
    const beat = `${(2 * Number.parseInt(token, 10)) / 1000}s`;
    expectComputed(bookedLine, { animationName: /^(?!none$).+/, animationDelay: beat });
    expectComputed(dot, { animationName: /^(?!none$).+/, animationDelay: beat });
    expectComputed(stroke, { animationName: /^(?!none$).+/, animationDelay: beat, animationDuration: '0.2s', animationIterationCount: '1' });
    // Landing live doesn't change which way the check draws: short arm first, once its beat comes.
    await expectDrawsShortArmFirst(stroke);
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
    canvas: 'N-Public-Handoff-Run1',
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

export const OwnerReason: Story = {
  render: ({ onOpenTrace }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      {OWNER_LINES.map(({ receipt }) => (
        <MarginReceipt key={receipt.ledgerSeq} {...receipt} onOpenTrace={onOpenTrace} />
      ))}
    </div>
  ),
  parameters: {
    canvasNote:
      "The board's receipts are owner notes written for the board; here each decision's receipt leads with the owner's words for its state, then the decision's reason_plain from the Turner fixture.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(quoteRan.state).toBe('executed');
    await expect(quoteRan.decision_id).toBe(rivera.decisions.allowed.decision_id);
    const shown = [...canvasElement.querySelectorAll<HTMLElement>('.cd-margin-receipt')];
    await expect(shown).toHaveLength(OWNER_LINES.length);
    for (const [index, { receipt: { reason }, words, tone }] of OWNER_LINES.entries()) {
      // owner_receipt_names_its_state: "{words}. {reason}", and the button is named by that line.
      const line = `${words}. ${reason}`;
      const receipt = canvas.getByRole('button', { name: `${line} Open the full trace.` });
      await expect(receipt).toBe(shown[index]);
      await expect(visibleText(receipt)).toBe(line);
      // The period after the words belongs to the lead.
      await expect(leadIn(receipt).textContent).toBe(`${words}.`);
      await expectLeadLook(receipt);
      const dot = receipt.querySelector('.cd-status-dot');
      await expect(dot).toHaveClass(`cd-status-dot--${tone}`);
      await expect(dot).toHaveAttribute('aria-hidden', 'true');
    }
  },
};

/** The visitor's question the seeded hold answers: the row its receipt attaches under. */
const heldQuestion = rivera.conversations.visitor.turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []))[0];

export const HeldWithCardBelow: Story = {
  render: ({ onOpenTrace }) => (
    <Transcript label="Conversation with a visitor">
      <TranscriptRow margin={<MarginReceipt {...ownerReceipt(rivera.decisions.held)} cardBelow onOpenTrace={onOpenTrace} />}>
        <VisitorMessage text={heldQuestion ?? ''} />
      </TranscriptRow>
      <ApprovalCard
        decision={rivera.decisions.held}
        heldBy={rivera.ruleCards['rv-quote'].reason}
        waiting="Web chat, 2 min ago"
        onAnswer={fn()}
      />
    </Transcript>
  ),
  parameters: {
    canvasNote:
      "The board's receipts are owner notes written for the board; here the held quote's receipt names only its state, because its ApprovalCard sits right under the row and its headline gives the reason.",
  },
  play: async ({ canvas, canvasElement }) => {
    const hold = rivera.decisions.held;
    if (heldQuestion === undefined) throw new Error('the Turner fixture has no visitor question');

    // held_receipt_with_card_below: the words alone, with no period, and nothing of the reason.
    const receipt = canvas.getByRole('button', { name: 'Held for you Open the full trace.' });
    await expect(visibleText(receipt)).toBe('Held for you');
    await expect(leadIn(receipt).textContent).toBe('Held for you');
    await expectLeadLook(receipt);
    const dots = receipt.querySelectorAll('.cd-status-dot');
    await expect(dots).toHaveLength(1);
    await expect(dots[0]).toHaveClass('cd-status-dot--held');

    // The reason is the card's headline, shown once on the page.
    const card = canvas.getByRole('article', { name: `Held for you: ${hold.reason_plain}` });
    await expect(canvas.getAllByText(hold.reason_plain)).toHaveLength(1);
    await expect(card).toHaveTextContent(hold.reason_plain);

    // The card is drawn right under the receipt's row: the row's next element is the ApprovalCard
    // itself (its outer box, which eases its height as an answer lands, holds the card), with
    // nothing between them.
    const row = receipt.closest<HTMLElement>('.cd-transcript-row');
    if (!row) throw new Error('the receipt is not in a row');
    const approvalCard = card.closest('.cd-approval-card');
    await expect(approvalCard).not.toBeNull();
    await expect(row.nextElementSibling).toBe(approvalCard);
    await expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(receipt.getBoundingClientRect().bottom);
    await expect(canvasElement.querySelectorAll('.cd-margin-receipt')).toHaveLength(1);
  },
};

export const ReplyIgnoresReason: Story = {
  // A reply's check has no owner words: given a decision's reason and a card below, it still shows its own line.
  args: { ...replyHandedOff, reason: rivera.decisions.held.reason_plain, cardBelow: true },
  play: async ({ canvas, canvasElement }) => {
    const receipt = canvas.getByRole('button', { name: `${replyHandedOff.plain} Open the full trace.` });
    await expect(visibleText(receipt)).toBe(replyHandedOff.plain);
    await expect(receipt.querySelector('.cd-margin-line__lead')).toBeNull();
    await expect(canvas.queryByText(rivera.decisions.held.reason_plain, { exact: false })).toBeNull();
    expectComputed(receipt, { color: await restingColor(receipt) });
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--held');
  },
};

/** Claude's answer in Ask Claude, the drafted change it introduced now confirmed. */
const CONFIRMED_ANSWER = "Here's that change: quotes stay automatic on weekdays, and on weekends they wait for your answer. Nothing changes until you confirm it.";

export const RulesConfirmed: Story = {
  render: () => (
    // Ask Claude's conversation: Claude's answer, and under it the receipt that replaced the review.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', width: 352, maxWidth: '100%' }}>
      <ClaudeMessage
        blocks={[{ kind: 'prose', template: null, text: CONFIRMED_ANSWER, fact_id: null, title: null, lines: [], href: null, options: [] }]}
        language="en"
        ownerName={rivera.business.ownerName}
      />
      <RulesReceipt version={8} />
    </div>
  ),
  parameters: {
    canvas: 'N-Conn-12-Chat',
    canvasNote:
      "The signed board draws the change's review before it is confirmed; the review board UXC-P701-After draws this moment after Confirm change, with the receipt landing under Claude's message. Storybook shows the motion your system asks for: under reduced motion it is there at once.",
  },
  play: async ({ canvasElement }) => {
    const line = canvasElement.querySelector<HTMLElement>('.cd-margin-receipt');
    if (!line) throw new Error('no receipt');
    // The version from the confirm's answer, led by the owner's word in primary ink; plain text, no trace to open.
    await expect(line).toHaveTextContent('Confirmed. Version 8 of your rules, checked against the always-on rules.');
    await expect(line.tagName).toBe('P');
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--handled');
    expectComputed(line.querySelector('.cd-margin-line__lead') ?? line, { color: TEXT_PRIMARY });
    expectComputed(line, { fontSize: '12px', lineHeight: '17px', color: TEXT_SECONDARY });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const el of [line, dotIn(canvasElement)]) expectComputed(el, { animationName: 'none' });
    } else {
      expectComputed(line, { animationName: 'cd-margin-line-land', animationDuration: '0.2s' });
      expectComputed(dotIn(canvasElement), { animationName: 'cd-margin-line-dot', animationDuration: '0.2s' });
      await Promise.all(line.getAnimations({ subtree: true }).map((landing) => landing.finished));
    }
    // Landed, it sits space-8 under Claude's message, as receipts sit under their message.
    const message = canvasElement.querySelector('.cd-claude-message');
    if (!message) throw new Error('no message');
    await expect(Math.round(line.getBoundingClientRect().top - message.getBoundingClientRect().bottom)).toBe(8);
  },
};
